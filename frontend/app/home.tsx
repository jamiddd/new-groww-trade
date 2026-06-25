import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  RefreshControl,
  ActivityIndicator,
  Modal,
  Pressable,
  Switch,
  TextInput,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import { Feather } from "@expo/vector-icons";
import Animated, {
  FadeInDown,
  FadeOutUp,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { Gesture, GestureDetector } from "react-native-gesture-handler";

import { api, disconnect, AppSettings } from "@/src/api/client";
import { ColorPalette, FONT } from "@/src/theme";
import { useTheme } from "@/src/theme/ThemeProvider";
import { storage } from "@/src/utils/storage";
import { formatExpiry } from "@/src/utils/format";
import { loadJSON, saveJSON, STORAGE_KEYS } from "@/src/utils/localStore";
import { mergeOrders } from "@/src/state/orderLog";
import { applyLivePnl } from "@/src/state/positionPnl";
import { useLtpPoller, type LtpQuery } from "@/src/hooks/useLtpPoller";
import { computeExpiries } from "@/src/utils/expiries";
import ConfirmSheet from "@/src/components/ConfirmSheet";
import OrderConfirmSheet, { OrderPreview } from "@/src/components/OrderConfirmSheet";
import UnderlyingSearchSheet from "@/src/components/UnderlyingSearchSheet";
import BottomSheet from "@/src/components/BottomSheet";

type Position = {
  trading_symbol?: string;
  symbol?: string;
  net_quantity?: number;
  quantity?: number;
  average_price?: number;
  avg_price?: number;
  ltp?: number;
  last_price?: number;
  pnl?: number;
  unrealised_pnl?: number;
  transaction_type?: string;
  created_at?: string;
  exchange?: string;
  product?: string;
};

type PresetSummary = {
  key: string;
  label: string;
  order_type: string;
};

const PRESET_KEYS: PresetSummary[] = [
  { key: "breakout_mkt", label: "BUY BREAKOUT CALL MKT", order_type: "MKT" },
  { key: "breakout_chaser_lmt", label: "BUY BREAKOUT CHASER CALL LMT", order_type: "LMT" },
  { key: "steady_mkt", label: "BUY STEADY CALL MKT", order_type: "MKT" },
  { key: "steady_lmt", label: "BUY STEADY CALL LMT", order_type: "LMT" },
];

const formatINR = (n: number) =>
  new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);

const formatUSD = (n: number, rate: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 }).format(n * rate);

// MCX commodities (Indian Multi Commodity Exchange). When the user picks
// one of these as the underlying, orders + expiry calls must go to the
// "MCX" exchange instead of NSE/BSE.
const MCX_COMMODITIES = new Set([
  "GOLD", "GOLDM", "GOLDGUINEA", "GOLDPETAL",
  "SILVER", "SILVERM", "SILVERMIC",
  "CRUDEOIL", "CRUDEOILM",
  "NATURALGAS", "NATGASMINI",
  "COPPER", "ZINC", "LEAD", "NICKEL", "ALUMINIUM",
  "COTTON", "MENTHAOIL", "CARDAMOM",
]);

const exchangeFor = (u: string): string => {
  if (u === "SENSEX" || u === "BANKEX") return "BSE";
  if (MCX_COMMODITIES.has(u)) return "MCX";
  return "NSE";
};

// Toast palette — modern, web-like, color-coded by severity.
type ToastType = "success" | "error" | "info" | "warning";
const TOAST_PALETTE: Record<ToastType, { bg: string; border: string; text: string; emoji: string }> = {
  success: { bg: "#ECFDF5", border: "#10B981", text: "#065F46", emoji: "✅" },
  error:   { bg: "#FEF2F2", border: "#EF4444", text: "#991B1B", emoji: "❌" },
  info:    { bg: "#EFF6FF", border: "#3B82F6", text: "#1E3A8A", emoji: "ℹ️" },
  warning: { bg: "#FFFBEB", border: "#F59E0B", text: "#92400E", emoji: "⚠️" },
};

export default function Home() {
  const router = useRouter();
  const { Colors } = useTheme();
  const styles = useMemo(() => mkStyles(Colors), [Colors]);

  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [capital, setCapital] = useState(0);
  const [balance, setBalance] = useState(0);
  const [positions, setPositions] = useState<Position[]>([]);
  const [smartOrdersBySymbol, setSmartOrdersBySymbol] = useState<Record<string, {
    smart_order_id: string;
    smart_order_type: string;
    tp_price?: number | string | null;
    sl_price?: number | string | null;
  }>>({});

  const [optionType, setOptionType] = useState<"CE" | "PE">("CE");

  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [usdRate, setUsdRate] = useState<number>(0.012);

  const [underlying, setUnderlying] = useState<string>("NIFTY");
  const [expiry, setExpiry] = useState<string | null>(null);
  const [expiryList, setExpiryList] = useState<string[]>([]);

  const [maxLoss, setMaxLoss] = useState<number>(40000);
  const [actionsCollapsed, setActionsCollapsed] = useState<boolean>(false);
  // Local (device-only) preference. When True the home screen ignores
  // any sticky `last_underlying_expiry` and always auto-selects the
  // first item in the (ascending-sorted) future-expiries list — i.e.
  // the next closest expiry — on launch and on every underlying switch.
  const [alwaysNearestExpiry, setAlwaysNearestExpiry] = useState<boolean>(false);

  // Modals
  const [searchVisible, setSearchVisible] = useState(false);
  const [menuVisible, setMenuVisible] = useState(false);
  const [maxLossVisible, setMaxLossVisible] = useState(false);
  const [maxLossInput, setMaxLossInput] = useState("40000");
  const [expirySheetVisible, setExpirySheetVisible] = useState(false);
  const expiryChipRef = useRef<View>(null);
  const [expiryAnchor, setExpiryAnchor] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [confirmPreset, setConfirmPreset] = useState<PresetSummary | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [preview, setPreview] = useState<OrderPreview | null>(null);
  const [confirmExit, setConfirmExit] = useState<25 | 50 | 100 | null>(null);
  const [singlePos, setSinglePos] = useState<Position | null>(null);
  const [posMenuVisible, setPosMenuVisible] = useState(false);
  const [placing, setPlacing] = useState(false);
  const [toast, setToast] = useState<{ msg: string; type: ToastType } | null>(null);

  // Bootstrap settings + last underlying
  useEffect(() => {
    (async () => {
      try {
        const [s, fx, nearestStored] = await Promise.all([
          api.settings(),
          api.fxInrUsd(),
          storage.getItem<boolean>("always_nearest_expiry", false as boolean),
        ]);
        setSettings(s);
        const wantNearest = !!nearestStored;
        setAlwaysNearestExpiry(wantNearest);
        if (fx?.rate) setUsdRate(fx.rate);
        if (s.save_last_underlying && s.last_underlying) {
          // Check expiry not stale
          const expOk = !s.last_underlying_expiry || new Date(s.last_underlying_expiry) >= new Date();
          if (expOk) {
            setUnderlying(s.last_underlying);
            // When "Always next closest expiry" is on we deliberately
            // SKIP restoring the sticky expiry — loadExpiries() will
            // pick exp[0] (the nearest) once the list arrives.
            if (!wantNearest && s.last_underlying_expiry) setExpiry(s.last_underlying_expiry);
          }
        }
        if (s.ask_max_loss_at_startup) {
          const stored = await storage.getItem<number>("max_loss_today", 0 as number);
          const today = new Date().toDateString();
          const lastDate = await storage.getItem<string>("max_loss_date", "" as string);
          if (!stored || lastDate !== today) {
            setMaxLossVisible(true);
          } else if (stored) {
            setMaxLoss(stored);
          }
        }
        const collapsed = await storage.getItem<boolean>("actions_collapsed", false as boolean);
        if (collapsed) setActionsCollapsed(true);
      } catch (e: any) {
        setError(e?.message ?? "Unable to load settings");
      }
    })();
  }, []);

  const loadExpiries = useCallback((u: string) => {
    // Expiries computed deterministically from SEBI rules — no API call.
    try {
      const exp = computeExpiries(u);
      setExpiryList(exp);
      if (alwaysNearestExpiry) {
        setExpiry(exp[0] ?? null);
      } else {
        setExpiry((cur) => (cur && exp.includes(cur) ? cur : exp[0] ?? null));
      }
    } catch {
      setExpiryList([]);
    }
  }, [alwaysNearestExpiry]);

  const applyMargin = useCallback((m: any) => {
    const liveTotal = Number(
      m?.available_margin ??
        m?.total_balance ??
        (Number(m?.equity?.available_cash ?? m?.cash ?? 0) +
          Number(m?.used_margin ?? 0)),
    ) || 0;
    const opening = Number(m?.opening_capital_today ?? liveTotal) || 0;
    setBalance(liveTotal);
    setCapital(opening);
  }, []);

  const applyPositions = useCallback((p: any) => {
    const list: Position[] =
      p?.positions || p?.data || p?.items || (Array.isArray(p) ? p : []);
    setPositions(list.filter((x) => (x.net_quantity || x.quantity || 0) !== 0));
  }, []);

  const applySmartOrders = useCallback((so: any) => {
    const indexed: Record<string, {
      smart_order_id: string;
      smart_order_type: string;
      tp_price?: number | string | null;
      sl_price?: number | string | null;
    }> = {};
    for (const item of (so as any)?.items ?? []) {
      if (item?.trading_symbol) {
        indexed[item.trading_symbol] = {
          smart_order_id: item.smart_order_id,
          smart_order_type: item.smart_order_type,
          tp_price: item.tp_price ?? null,
          sl_price: item.sl_price ?? null,
        };
      }
    }
    setSmartOrdersBySymbol(indexed);
  }, []);

  const loadAll = useCallback(async (opts?: { fromCache?: boolean }) => {
    setError(null);
    const useCache = opts?.fromCache;

    // 1. Hydrate from local cache instantly so the UI never shows a blank
    //    state, even when the network is slow. Bootstrap then overlays
    //    fresh server data on top.
    if (useCache) {
      try {
        const cached = await loadJSON<{
          margin?: any;
          positions?: any;
          smart_orders?: any;
        } | null>(STORAGE_KEYS.bootstrap, null);
        if (cached) {
          if (cached.margin) applyMargin(cached.margin);
          if (cached.positions) applyPositions(cached.positions);
          if (cached.smart_orders) applySmartOrders(cached.smart_orders);
        }
      } catch {
        // ignore — cache is best-effort
      }
    }

    try {
      // Single round-trip: margin + positions + orders + smart_orders.
      const boot = await api.bootstrap();
      applyMargin(boot.margin);
      applyPositions(boot.positions);
      applySmartOrders(boot.smart_orders);
      // Persist for next launch so the UI is instant.
      await saveJSON(STORAGE_KEYS.bootstrap, {
        margin: boot.margin,
        positions: boot.positions,
        smart_orders: boot.smart_orders,
        savedAt: Date.now(),
      });
      // Merge server order page into local order log (used by /history).
      const serverOrders = (boot.orders?.orders ?? []) as any[];
      if (Array.isArray(serverOrders) && serverOrders.length) {
        await mergeOrders(serverOrders);
      }
    } catch (e: any) {
      setError(e?.message ?? "Failed to load account data");
    }
  }, [applyMargin, applyPositions, applySmartOrders]);

  // Hold a stable ref to the in-flight `placing` flag so the polling
  // interval can skip refreshes during order placement without being torn
  // down and recreated on every state change.
  const placingRef = useRef(false);
  useEffect(() => {
    placingRef.current = placing;
  }, [placing]);

  useFocusEffect(
    useCallback(() => {
      let mounted = true;
      (async () => {
        setLoading(true);
        try {
          // Refresh settings every time we focus the screen so toggles like
          // "Convert to USD" or "Save last underlying" take effect immediately
          // when the user returns from the Settings screen.
          const s = await api.settings();
          if (mounted) setSettings(s);
        } catch {
          // ignore — keep prior settings
        }
        // Hydrate from cache first (instant paint), then fetch bootstrap.
        await loadAll({ fromCache: true });
        if (mounted) setLoading(false);
      })();

      // No more polling of margin/positions/smart-orders here — the LTP
      // poller below drives live P&L by computing it client-side from the
      // cached positions + the latest LTPs. The full bootstrap re-runs
      // only on pull-to-refresh or after a state-mutating action (buy/exit).

      return () => {
        mounted = false;
      };
    }, [loadAll]),
  );

  useEffect(() => {
    if (underlying) loadExpiries(underlying);
  }, [underlying, loadExpiries]);

  // Build the list of trading symbols whose LTP we need live.
  // Currently: every open position's option. The order confirm dialog also
  // adds its selected strike via `confirmLtpSymbol` below.
  const positionLtpSymbols = useMemo<LtpQuery[]>(() => {
    const out: LtpQuery[] = [];
    for (const p of positions) {
      const sym = p.trading_symbol || p.symbol;
      if (!sym) continue;
      out.push({
        trading_symbol: sym,
        exchange: (p as any).exchange || "NSE",
        segment: (p as any).segment,
      });
    }
    return out;
  }, [positions]);

  // Live LTP poll — only fires while there are open positions. Stops the
  // second the list goes empty. This is the ONLY recurring API hit in
  // steady state.
  const { ltps: positionLtps } = useLtpPoller(positionLtpSymbols, { intervalMs: 1000 });

  // Re-derive positions with live P&L every time LTPs tick.
  const livePositions = useMemo(
    () => applyLivePnl(positions as any, positionLtps),
    [positions, positionLtps],
  );

  const onRefresh = async () => {
    setRefreshing(true);
    await loadAll();
    setRefreshing(false);
  };

  const totalPnl = useMemo(
    () => livePositions.reduce((acc, p) => acc + (p.live_pnl || 0), 0),
    [livePositions],
  );

  const showToast = (msg: string, type?: ToastType) => {
    // Auto-detect severity from message if not explicitly provided.
    let t: ToastType = type ?? "info";
    if (!type) {
      const low = msg.toLowerCase();
      if (/(\bfail|error|denied|invalid)/.test(low)) t = "error";
      else if (low.startsWith("pick ") || low.includes("no open") || low.includes("missing")) t = "warning";
      else if (/(order sent|exited \d|saved|connected|done|success)/.test(low)) t = "success";
    }
    setToast({ msg, type: t });
    setTimeout(() => setToast(null), 2800);
  };

  // Pixel-perfect height animation for the actions panel body. We render
  // the body once (offscreen on first paint) to measure its natural
  // height, then animate the clip-container's height between 0 ↔
  // measuredHeight whenever the collapse state changes. No opacity / fade
  // — strictly translate the layout.
  const bodyHeight = useSharedValue(0);
  const expandProgress = useSharedValue(actionsCollapsed ? 0 : 1);

  useEffect(() => {
    expandProgress.value = withTiming(actionsCollapsed ? 0 : 1, { duration: 240 });
  }, [actionsCollapsed, expandProgress]);

  const animatedBodyClipStyle = useAnimatedStyle(() => ({
    height: bodyHeight.value > 0 ? bodyHeight.value * expandProgress.value : undefined,
    overflow: "hidden",
  }));

  // Single source of truth for collapse-toggling — used by both the
  // tap-on-header path AND the swipe-pan path. Centralising it means
  // `runOnJS` only ever sees a stable JS-callable function reference,
  // which is required to avoid a native crash on Android when the
  // worklet finishes.
  const setActionsCollapsedPersistent = useCallback((next: boolean) => {
    setActionsCollapsed(next);
    storage.setItem("actions_collapsed", next);
  }, []);

  // Memoise the gesture so a new instance isn't constructed on every
  // render (which would invalidate the native handler registration and
  // could intermittently swallow events). Snap-only: a swipe up opens,
  // a swipe down closes — no live drag tracking.
  const actionsPanGesture = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetY([-12, 12])
        .onEnd((e) => {
          "worklet";
          if (e.translationY < -20 || e.velocityY < -500) {
            runOnJS(setActionsCollapsedPersistent)(false);
          } else if (e.translationY > 20 || e.velocityY > 500) {
            runOnJS(setActionsCollapsedPersistent)(true);
          }
        }),
    [setActionsCollapsedPersistent],
  );

  // Live LTP refresh inside the open confirmation dialog: every 3 s, while
  // a preset is queued for confirmation and we're not actively placing the
  // order, re-run the dry-run so the displayed LTP / LIMIT-price / SL / TP
  // levels stay current. Otherwise the user would be looking at a frozen
  // snapshot from when they tapped the button.
  useEffect(() => {
    if (!confirmPreset) return;
    if (!expiry) return;
    const id = setInterval(() => {
      if (placing) return;
      api
        .placePreset({
          preset_key: confirmPreset.key,
          underlying,
          expiry,
          option_type: optionType,
          capital,
          exchange: exchangeFor(underlying),
          dry_run: true,
        })
        .then((res) => setPreview(res as OrderPreview))
        .catch(() => {
          /* leave the previous preview on screen, don't toast every 3s */
        });
    }, 3000);
    return () => clearInterval(id);
  }, [confirmPreset, expiry, underlying, optionType, capital, placing]);

  const onPresetPress = (preset: PresetSummary) => {
    if (!expiry) {
      showToast("Pick an expiry first");
      return;
    }
    if (settings?.confirm_before_order) {
      setConfirmPreset(preset);
      setPreview(null);
      setPreviewLoading(true);
      api
        .placePreset({
          preset_key: preset.key,
          underlying,
          expiry,
          option_type: optionType,
          capital,
          exchange: exchangeFor(underlying),
          dry_run: true,
        })
        .then((res) => setPreview(res as OrderPreview))
        .catch((e: any) => showToast(`Preview failed: ${e?.message ?? "error"}`))
        .finally(() => setPreviewLoading(false));
    } else {
      placePreset(preset);
    }
  };

  const placePreset = async (preset: PresetSummary) => {
    // Capture the LIMIT price the user actually saw on the confirmation
    // dialog BEFORE we tear down the preview state — otherwise the order
    // would be placed at whatever LTP × offset evaluates to on the server
    // at that exact millisecond (which could differ from the displayed
    // price by a few ticks during fast moves).
    const stickyLimitPrice =
      preview?.order?.order_type === "LIMIT" && preview?.order?.price
        ? Number(preview.order.price)
        : undefined;
    setPlacing(true);
    setConfirmPreset(null);
    setPreview(null);
    try {
      const res = await api.placePreset({
        preset_key: preset.key,
        underlying,
        expiry: expiry!,
        option_type: optionType,
        capital,
        exchange: exchangeFor(underlying),
        limit_price_override: stickyLimitPrice,
      });
      const sym = res?.selected?.trading_symbol ?? "order";
      showToast(`Order sent: ${sym} × ${res?.quantity ?? "?"}`);
      await loadAll();
    } catch (e: any) {
      showToast(`Failed: ${e?.message ?? "error"}`);
    } finally {
      setPlacing(false);
    }
  };

  const onExitPress = (pct: 25 | 50 | 100) => {
    if (positions.length === 0) {
      showToast("No open positions");
      return;
    }
    if (settings?.confirm_before_order) {
      setConfirmExit(pct);
    } else {
      doExit(pct);
    }
  };

  const doExit = async (
    pct: 25 | 50 | 100,
    opts: { trading_symbol?: string; pnl_filter?: "positive" | "negative" } = {},
  ) => {
    setConfirmExit(null);
    setPlacing(true);
    try {
      const res = await api.exit({ percent: pct, ...opts });
      const label = opts.trading_symbol
        ? opts.trading_symbol
        : opts.pnl_filter
        ? `${opts.pnl_filter} positions`
        : `${pct}%`;
      showToast(`Exited ${res?.count ?? 0} (${label})`);
      await loadAll();
    } catch (e: any) {
      showToast(`Exit failed: ${e?.message ?? "error"}`);
    } finally {
      setPlacing(false);
    }
  };

  const saveMaxLoss = async () => {
    const val = Number(maxLossInput.replace(/[^0-9]/g, "")) || 0;
    setMaxLoss(val);
    await storage.setItem("max_loss_today", val);
    await storage.setItem("max_loss_date", new Date().toDateString());
    setMaxLossVisible(false);
  };

  const onUnderlyingPick = async (item: { symbol: string; name: string; type: string }) => {
    setUnderlying(item.symbol);
    setExpiry(null);
    setExpiryList([]);
    setSearchVisible(false);
    if (settings?.save_last_underlying) {
      const newSettings = { ...settings, last_underlying: item.symbol, last_underlying_expiry: null } as AppSettings;
      setSettings(newSettings);
      try {
        await api.updateSettings(newSettings);
      } catch {}
    }
  };

  const onPickExpiry = async (exp: string) => {
    setExpiry(exp);
    setExpirySheetVisible(false);
    // Only persist when "Save last underlying" is on AND
    // "Always next closest expiry" is off — otherwise the sticky
    // would silently override the auto-pick on next launch.
    if (settings?.save_last_underlying && !alwaysNearestExpiry) {
      const newSettings = { ...settings, last_underlying: underlying, last_underlying_expiry: exp } as AppSettings;
      setSettings(newSettings);
      try {
        await api.updateSettings(newSettings);
      } catch {}
    }
  };

  const onDisconnect = async () => {
    await disconnect();
    router.replace("/login");
  };

  const pnlColor = (v: number) => (v >= 0 ? Colors.pnlPositive : Colors.pnlNegative);
  const pnlSign = (v: number) => (v >= 0 ? "+" : "");

  const formatMoney = (v: number) =>
    settings?.convert_to_usd ? formatUSD(v, usdRate) : formatINR(v);

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      {/* Sticky header */}
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.headerChip}
          onPress={() => setSearchVisible(true)}
          testID="header-underlying-button"
        >
          <Text style={styles.caret}>▾</Text>
          <Text style={styles.chipText}>{underlying}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          ref={expiryChipRef as any}
          style={styles.headerChipSecondary}
          onPress={() => {
            const open = () => setExpirySheetVisible(true);
            if (expiryChipRef.current && (expiryChipRef.current as any).measureInWindow) {
              (expiryChipRef.current as any).measureInWindow((x: number, y: number, w: number, h: number) => {
                setExpiryAnchor({ x, y, w, h });
                open();
              });
            } else {
              setExpiryAnchor(null);
              open();
            }
          }}
          testID="header-expiry-button"
        >
          <Feather name="calendar" size={13} color={Colors.text} />
          <Text style={styles.chipText}>{expiry ? formatExpiry(expiry) : "pick expiry"}</Text>
        </TouchableOpacity>
        <View style={styles.headerRight}>
          <TouchableOpacity
            style={styles.iconBtn}
            onPress={() => router.push("/history")}
            testID="header-history-button"
          >
            <Feather name="clock" size={18} color={Colors.text} />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.iconBtn}
            onPress={() => setMenuVisible(true)}
            testID="header-menu-button"
          >
            <Text style={[styles.iconText, { fontSize: 24 }]}>⋮</Text>
          </TouchableOpacity>
        </View>
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={styles.scrollContent}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.primary} />}
        testID="home-scroll-area"
      >
        {/* Account card */}
        <View style={styles.card}>
          <View style={styles.dotRow}>
            <Text style={styles.dotLabel}>Capital</Text>
            <TouchableOpacity
              onPress={async () => {
                try {
                  await api.refreshCapital();
                  await loadAll();
                } catch {
                  /* ignore */
                }
              }}
              testID="capital-refresh"
              style={styles.capitalRefreshBtn}
              hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
            >
              <Feather name="refresh-cw" size={11} color={Colors.textMuted} />
            </TouchableOpacity>
            <View style={styles.dotFill} />
            <Text style={styles.dotValue}>{formatMoney(capital)}</Text>
          </View>
          <View style={styles.dotRow}>
            <Text style={styles.dotLabel}>Profit & Loss:</Text>
            <View style={styles.dotFill} />
            <Text style={[styles.dotValue, { color: pnlColor(totalPnl) }]}>
              {pnlSign(totalPnl)}
              {formatMoney(Math.abs(totalPnl))}
            </Text>
          </View>
          <View style={styles.dotRow}>
            <Text style={styles.dotLabel}>Balance:</Text>
            <View style={styles.dotFill} />
            <Text style={styles.dotValue}>{formatMoney(balance)}</Text>
          </View>
          <Text style={styles.disclaimer}>Balance may differ at the end of the day because of charges incurred</Text>
        </View>

        {/* Positions */}
        <View style={styles.posHeader}>
          <Text style={styles.posTitle}>Positions ({positions.length}):</Text>
          <View style={styles.posHeaderRight}>
            <Text style={[styles.posTotal, { color: pnlColor(totalPnl) }]}>
              {pnlSign(totalPnl)}
              {formatMoney(Math.abs(totalPnl))}
            </Text>
            <TouchableOpacity
              style={styles.posMenuBtn}
              onPress={() => setPosMenuVisible(true)}
              testID="positions-menu-button"
            >
              <Feather name="more-vertical" size={16} color={Colors.textSecondary} />
            </TouchableOpacity>
          </View>
        </View>

        {loading ? (
          <ActivityIndicator color={Colors.primary} style={{ marginTop: 24 }} />
        ) : error ? (
          <Text style={styles.errorText} testID="home-error">
            {error}
          </Text>
        ) : livePositions.length === 0 ? (
          <Text style={styles.empty}>No open positions.</Text>
        ) : (
          livePositions.map((p, i) => {
            const pnl = p.live_pnl;
            const qty = p.net_quantity;
            const ap = p.average_price;
            const ltp = p.live_ltp;
            const changePct = p.live_pnl_pct;
            const sym = p.trading_symbol ?? (p as any).symbol ?? "—";
            const side = qty >= 0 ? "BUY" : "SELL";
            const protection = sym ? smartOrdersBySymbol[sym] : undefined;
            return (
              <TouchableOpacity
                key={`${sym}-${i}`}
                style={styles.posRow}
                onPress={() => setSinglePos(p)}
                testID={`position-row-${i}`}
                activeOpacity={0.7}
              >
                <View style={{ flex: 1 }}>
                  <View style={styles.posRowTop}>
                    <Text style={styles.posSym}>{sym}</Text>
                    <Text style={styles.posSide}> · {side}</Text>
                    {protection ? (
                      <View style={styles.protectBadge} testID={`protection-badge-${i}`}>
                        <Feather name="shield" size={9} color="#FFF" />
                        <Text style={styles.protectBadgeText}>{protection.smart_order_type}</Text>
                      </View>
                    ) : null}
                  </View>
                  <Text style={styles.posMeta}>
                    Avg. Price - {formatMoney(ap)} × {Math.abs(qty)} Qty
                  </Text>
                  {ltp > 0 ? (
                    <View style={styles.posLtpRow}>
                      <Text style={styles.posLtpLabel}>LTP </Text>
                      <Text style={styles.posLtpValue}>{formatMoney(ltp)}</Text>
                      {ap > 0 ? (
                        <Text
                          style={[styles.posLtpChange, { color: pnlColor(changePct) }]}
                        >
                          {"  "}
                          {pnlSign(changePct)}
                          {changePct.toFixed(2)}%
                        </Text>
                      ) : null}
                    </View>
                  ) : null}
                  {protection &&
                  ((protection.tp_price && Number(protection.tp_price) > 0) ||
                    (protection.sl_price && Number(protection.sl_price) > 0)) ? (
                    <Text style={styles.posProtectMeta}>
                      {protection.tp_price && Number(protection.tp_price) > 0
                        ? `TP ${formatMoney(Number(protection.tp_price))}`
                        : ""}
                      {protection.tp_price &&
                      Number(protection.tp_price) > 0 &&
                      protection.sl_price &&
                      Number(protection.sl_price) > 0
                        ? "  ·  "
                        : ""}
                      {protection.sl_price && Number(protection.sl_price) > 0
                        ? `SL ${formatMoney(Number(protection.sl_price))}`
                        : ""}
                    </Text>
                  ) : null}
                  {p.created_at ? <Text style={styles.posTime}>{p.created_at}</Text> : null}
                </View>
                <Text style={[styles.posPnl, { color: pnlColor(pnl) }]}>
                  {pnlSign(pnl)}
                  {formatMoney(Math.abs(pnl))}
                </Text>
              </TouchableOpacity>
            );
          })
        )}
      </ScrollView>

      {/* Persistent bottom sheet — always docked at the bottom, looks
          and feels like @gorhom/bottom-sheet with a grab handle, rounded
          top corners, and an upward elevation shadow. Stays in layout
          so the ScrollView above naturally insets around it. */}
      <SafeAreaView edges={["bottom"]} style={styles.sheetSafeBg}>
        <View style={styles.sheetSurface}>
          <GestureDetector gesture={actionsPanGesture}>
            <View>
              <TouchableOpacity
                style={styles.sheetHeader}
                onPress={() => setActionsCollapsedPersistent(!actionsCollapsed)}
                testID="actions-toggle"
                activeOpacity={0.9}
              >
                <View style={styles.grabber} />
                <View style={styles.sheetHeaderRow}>
                  <Text style={styles.sheetHeaderLabel}>ACTIONS</Text>
                  {settings?.practice_mode ? (
                    <View style={styles.practiceBadge} testID="practice-mode-badge">
                      <Feather name="shield" size={9} color="#FFFFFF" />
                      <Text style={styles.practiceBadgeText}>PRACTICE · 1 LOT</Text>
                    </View>
                  ) : null}
                </View>
              </TouchableOpacity>
            </View>
          </GestureDetector>

          {/* Body container is ALWAYS mounted (so we can measure its
              natural height once via onLayout) and clipped to an
              animated height. Animating just the clip height gives a
              pure pixel-by-pixel slide with zero opacity / fade. */}
          <Animated.View style={animatedBodyClipStyle} testID="actions-body">
            <View
              onLayout={(e) => {
                const h = e.nativeEvent.layout.height;
                if (h > 0 && Math.abs(bodyHeight.value - h) > 1) {
                  bodyHeight.value = h;
                }
              }}
              style={styles.sheetBody}
            >
              <View style={styles.footerTop}>
                <TouchableOpacity
                  style={styles.maxLossPill}
                  onPress={() => {
                    setMaxLossInput(String(maxLoss));
                    setMaxLossVisible(true);
                  }}
                  testID="max-loss-pill"
                >
                  <Text style={styles.maxLossText}>Set Max Loss: ({formatMoney(maxLoss)})</Text>
                </TouchableOpacity>
                <View style={styles.toggleWrap}>
                  <Text style={[styles.toggleLabel, optionType === "CE" && styles.toggleLabelActive]}>CE</Text>
                  <Switch
                    testID="ce-pe-toggle"
                    value={optionType === "PE"}
                    onValueChange={(v) => setOptionType(v ? "PE" : "CE")}
                    trackColor={{ true: Colors.primary, false: Colors.primary }}
                    thumbColor="#FFFFFF"
                  />
                  <Text style={[styles.toggleLabel, optionType === "PE" && styles.toggleLabelActive]}>PE</Text>
                </View>
              </View>

              {/* Buy grid */}
              <View style={styles.grid}>
                {PRESET_KEYS.map((p) => {
                  const isLmt = p.order_type === "LMT";
                  const dynamicLabel = p.label.replace("CALL", optionType === "CE" ? "CALL" : "PUT");
                  return (
                    <TouchableOpacity
                      key={p.key}
                      style={[styles.buyBtn, { backgroundColor: isLmt ? Colors.primaryDark : Colors.primary }]}
                      onPress={() => onPresetPress(p)}
                      onLongPress={() => router.push(`/preset?key=${p.key}`)}
                      delayLongPress={400}
                      testID={`buy-button-${p.key}`}
                    >
                      <Text style={styles.buyText}>{dynamicLabel}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              <View style={styles.exitRow}>
                <TouchableOpacity
                  style={[styles.exitBtn, styles.exitPartial]}
                  onPress={() => onExitPress(25)}
                  testID="exit-25-button"
                >
                  <Text style={styles.exitText}>EXIT 25% POSITIONS</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.exitBtn, styles.exitPartial]}
                  onPress={() => onExitPress(50)}
                  testID="exit-50-button"
                >
                  <Text style={styles.exitText}>EXIT 50% POSITIONS</Text>
                </TouchableOpacity>
              </View>
              <TouchableOpacity
                style={[styles.exitBtn, styles.exitAll]}
                onPress={() => onExitPress(100)}
                testID="exit-all-button"
              >
                <Text style={styles.exitText}>EXIT ALL POSITIONS</Text>
              </TouchableOpacity>
            </View>
          </Animated.View>
        </View>
      </SafeAreaView>

      {/* Underlying search */}
      <UnderlyingSearchSheet
        visible={searchVisible}
        onClose={() => setSearchVisible(false)}
        onPick={onUnderlyingPick}
      />

      {/* Kebab menu */}
      <Modal visible={menuVisible} transparent animationType="fade" onRequestClose={() => setMenuVisible(false)}>
        <Pressable style={styles.menuBackdrop} onPress={() => setMenuVisible(false)}>
          <SafeAreaView edges={["top"]}>
            <View style={styles.menuPanel} testID="kebab-menu">
              <MenuItem
                label="Order History"
                onPress={() => {
                  setMenuVisible(false);
                  router.push("/history");
                }}
                testID="menu-history"
              />
              <MenuItem
                label="Settings"
                onPress={() => {
                  setMenuVisible(false);
                  router.push("/settings");
                }}
                testID="menu-settings"
              />
              <MenuItem
                label="Refresh"
                onPress={() => {
                  setMenuVisible(false);
                  onRefresh();
                }}
                testID="menu-refresh"
              />
              <MenuItem
                label="Disconnect"
                destructive
                onPress={() => {
                  setMenuVisible(false);
                  onDisconnect();
                }}
                testID="menu-disconnect"
              />
            </View>
          </SafeAreaView>
        </Pressable>
      </Modal>

      {/* Expiry popover */}
      <Modal
        visible={expirySheetVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setExpirySheetVisible(false)}
      >
        <Pressable
          style={styles.expiryBackdrop}
          onPress={() => setExpirySheetVisible(false)}
          testID="expiry-sheet"
        >
          <View
            style={[
              styles.expiryPopover,
              {
                top: (expiryAnchor ? expiryAnchor.y + expiryAnchor.h : 64) + 8,
              },
            ]}
            // stop the press from bubbling to backdrop
            onStartShouldSetResponder={() => true}
          >
            {expiryAnchor ? (
              <View
                style={[
                  styles.expiryCaret,
                  {
                    left: Math.max(
                      18,
                      Math.min(
                        expiryAnchor.x + expiryAnchor.w / 2 - 12 - 6,
                        9999,
                      ),
                    ),
                  },
                ]}
              />
            ) : null}
            {expiryList.length === 0 ? (
              <Text style={[styles.empty, { paddingHorizontal: 12, paddingVertical: 8 }]}>
                No expiries available.
              </Text>
            ) : (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.expiryPillsRow}
              >
                {expiryList.map((e) => {
                  const selected = expiry === e;
                  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(e);
                  const day = m ? m[3] : e.slice(0, 2);
                  return (
                    <TouchableOpacity
                      key={e}
                      onPress={() => onPickExpiry(e)}
                      style={[styles.expiryPill, selected && styles.expiryPillActive]}
                      testID={`expiry-row-${e}`}
                      activeOpacity={0.8}
                    >
                      <Text
                        style={[
                          styles.expiryPillText,
                          selected && styles.expiryPillTextActive,
                        ]}
                      >
                        {day}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            )}
          </View>
        </Pressable>
      </Modal>

      {/* Max Loss prompt */}
      <BottomSheet
        visible={maxLossVisible}
        onClose={() => setMaxLossVisible(false)}
        avoidKeyboard
        testID="max-loss-sheet"
      >
        <Text style={styles.sheetTitle}>Daily Max Loss</Text>
        <Text style={styles.sheetSub}>Set the maximum loss for today (₹)</Text>
        <TextInput
          style={styles.sheetInput}
          value={maxLossInput}
          onChangeText={setMaxLossInput}
          keyboardType="number-pad"
          placeholder="40000"
          placeholderTextColor={Colors.textMuted}
          testID="max-loss-input"
        />
        <TouchableOpacity style={styles.sheetCta} onPress={saveMaxLoss} testID="max-loss-save">
          <Text style={styles.sheetCtaText}>SAVE</Text>
        </TouchableOpacity>
      </BottomSheet>

      {/* Order confirm */}
      <OrderConfirmSheet
        visible={!!confirmPreset}
        preview={preview}
        loading={previewLoading}
        placing={placing}
        presetLabel={(confirmPreset?.label ?? "").replace("CALL", optionType === "CE" ? "CALL" : "PUT")}
        underlying={underlying}
        expiry={expiry ? formatExpiry(expiry) : "?"}
        optionType={optionType}
        formatMoney={formatMoney}
        onConfirm={() => confirmPreset && placePreset(confirmPreset)}
        onCancel={() => {
          setConfirmPreset(null);
          setPreview(null);
        }}
      />

      {/* Exit confirm */}
      <ConfirmSheet
        visible={confirmExit !== null}
        title={`Exit ${confirmExit}% of positions?`}
        message={`This will close ${confirmExit === 100 ? "all" : confirmExit + "% of"} open positions at market price.`}
        confirmLabel={placing ? "EXITING…" : `EXIT ${confirmExit}%`}
        destructive
        onConfirm={() => confirmExit && doExit(confirmExit)}
        onCancel={() => setConfirmExit(null)}
        testID="confirm-exit"
      />

      {/* Single-position close sheet */}
      <BottomSheet
        visible={!!singlePos}
        onClose={() => setSinglePos(null)}
        testID="single-position-sheet"
      >
        <Text style={styles.sheetTitle}>{singlePos?.trading_symbol ?? "Position"}</Text>
        <Text style={styles.sheetSub}>Close this position</Text>
        <View style={{ gap: 8, marginTop: 8 }}>
          {[25, 50, 100].map((pct) => (
            <TouchableOpacity
              key={pct}
              style={[styles.closeRow, pct === 100 ? { backgroundColor: Colors.danger } : { backgroundColor: Colors.dangerDark }]}
              onPress={() => {
                const sym = singlePos?.trading_symbol;
                setSinglePos(null);
                if (sym) doExit(pct as 25 | 50 | 100, { trading_symbol: sym });
              }}
              testID={`single-close-${pct}`}
            >
              <Text style={styles.closeRowText}>{pct === 100 ? "CLOSE ENTIRE POSITION" : `CLOSE ${pct}%`}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </BottomSheet>

      {/* Positions header kebab menu */}
      <BottomSheet
        visible={posMenuVisible}
        onClose={() => setPosMenuVisible(false)}
        testID="positions-menu-sheet"
      >
        <Text style={styles.sheetTitle}>Positions actions</Text>
        <View style={{ marginTop: 8 }}>
          <TouchableOpacity
            style={styles.menuActionRow}
            onPress={() => {
              setPosMenuVisible(false);
              doExit(100, { pnl_filter: "positive" });
            }}
            testID="close-positive-positions"
          >
            <Feather name="trending-up" size={16} color={Colors.primary} />
            <View style={{ flex: 1 }}>
              <Text style={styles.menuActionTitle}>Close positive positions</Text>
              <Text style={styles.menuActionDesc}>Lock in profit on every position currently in the green.</Text>
            </View>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.menuActionRow}
            onPress={() => {
              setPosMenuVisible(false);
              doExit(100, { pnl_filter: "negative" });
            }}
            testID="close-negative-positions"
          >
            <Feather name="trending-down" size={16} color={Colors.danger} />
            <View style={{ flex: 1 }}>
              <Text style={styles.menuActionTitle}>Close negative positions</Text>
              <Text style={styles.menuActionDesc}>Cut every position currently in the red.</Text>
            </View>
          </TouchableOpacity>
        </View>
      </BottomSheet>

      {toast ? (
        <Animated.View
          entering={FadeInDown.duration(220)}
          exiting={FadeOutUp.duration(180)}
          style={[
            styles.toast,
            {
              backgroundColor: TOAST_PALETTE[toast.type].bg,
              borderLeftColor: TOAST_PALETTE[toast.type].border,
            },
          ]}
          pointerEvents="none"
          testID="home-toast"
        >
          <Text style={styles.toastEmoji}>{TOAST_PALETTE[toast.type].emoji}</Text>
          <Text style={[styles.toastText, { color: TOAST_PALETTE[toast.type].text }]} numberOfLines={2}>
            {toast.msg}
          </Text>
        </Animated.View>
      ) : null}
    </SafeAreaView>
  );
}

function MenuItem({
  label,
  onPress,
  destructive,
  testID,
}: {
  label: string;
  onPress: () => void;
  destructive?: boolean;
  testID?: string;
}) {
  const { Colors } = useTheme();
  const styles = useMemo(() => mkStyles(Colors), [Colors]);
  return (
    <TouchableOpacity style={styles.menuItem} onPress={onPress} testID={testID}>
      <Text style={[styles.menuItemText, destructive && { color: Colors.danger }]}>{label}</Text>
    </TouchableOpacity>
  );
}

const mkStyles = (Colors: ColorPalette) => StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.bg },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 10,
    paddingVertical: 10,
    gap: 8,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
    backgroundColor: Colors.bg,
  },
  headerChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: Colors.borderLight,
    borderRadius: 8,
  },
  headerChipSecondary: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: Colors.borderLight,
    borderRadius: 8,
    flex: 1,
  },
  chipText: { fontFamily: FONT, fontSize: 14, fontWeight: "bold", color: Colors.text },
  caret: { fontSize: 14, color: Colors.text },
  headerRight: { flexDirection: "row", gap: 4 },
  iconBtn: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
  iconText: { fontFamily: FONT, color: Colors.text, fontSize: 20, fontWeight: "bold" },

  scrollContent: { padding: 16, paddingBottom: 24 },

  card: {
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 10,
    padding: 14,
    marginBottom: 14,
    backgroundColor: Colors.surface,
  },
  dotRow: { flexDirection: "row", alignItems: "flex-end", marginVertical: 4 },
  dotLabel: { fontFamily: FONT, fontSize: 13, color: Colors.text },
  capitalRefreshBtn: {
    marginLeft: 6,
    paddingVertical: 2,
    paddingHorizontal: 4,
  },
  dotFill: {
    flex: 1,
    borderBottomWidth: 1,
    borderStyle: "dashed",
    borderColor: Colors.border,
    marginHorizontal: 6,
    height: 1,
    marginBottom: 5,
  },
  dotValue: { fontFamily: FONT, fontSize: 13, fontWeight: "bold", color: Colors.text },
  disclaimer: {
    fontFamily: FONT,
    fontSize: 11,
    fontStyle: "italic",
    color: Colors.textMuted,
    marginTop: 8,
    textAlign: "center",
  },

  posHeader: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 8, alignItems: "center" },
  posHeaderRight: { flexDirection: "row", alignItems: "center", gap: 6 },
  posMenuBtn: { padding: 4 },
  posTitle: { fontFamily: FONT, fontSize: 13, color: Colors.text, fontWeight: "bold" },
  posTotal: { fontFamily: FONT, fontSize: 13, fontWeight: "bold" },

  closeRow: { paddingVertical: 14, borderRadius: 8, alignItems: "center" },
  closeRowText: { fontFamily: FONT, color: "#FFF", fontWeight: "bold", letterSpacing: 0.6 },
  menuActionRow: {
    flexDirection: "row",
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 8,
    borderRadius: 8,
    alignItems: "center",
  },
  menuActionTitle: { fontFamily: FONT, fontSize: 14, fontWeight: "bold", color: Colors.text },
  menuActionDesc: { fontFamily: FONT, fontSize: 12, color: Colors.textSecondary, marginTop: 2 },

  posRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: Colors.borderLight,
  },
  posRowTop: { flexDirection: "row", alignItems: "center" },
  posSym: { fontFamily: FONT, fontWeight: "bold", color: Colors.text, fontSize: 13 },
  posSide: { fontFamily: FONT, fontWeight: "bold", color: Colors.primary, fontSize: 13 },
  posMeta: { fontFamily: FONT, fontSize: 12, color: Colors.textSecondary, marginTop: 2 },
  posLtpRow: { flexDirection: "row", alignItems: "center", marginTop: 2 },
  posLtpLabel: { fontFamily: FONT, fontSize: 11, color: Colors.textMuted, fontWeight: "bold", letterSpacing: 0.6 },
  posLtpValue: { fontFamily: FONT, fontSize: 12, color: Colors.text, fontWeight: "bold" },
  posLtpChange: { fontFamily: FONT, fontSize: 11, fontWeight: "bold" },
  posProtectMeta: {
    fontFamily: FONT,
    fontSize: 10.5,
    color: Colors.textMuted,
    marginTop: 2,
    fontWeight: "bold",
    letterSpacing: 0.4,
  },
  protectBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    backgroundColor: Colors.primary,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    marginLeft: 8,
  },
  protectBadgeText: {
    fontFamily: FONT,
    fontSize: 9,
    color: "#FFFFFF",
    fontWeight: "bold",
    letterSpacing: 0.6,
  },
  posTime: { fontFamily: FONT, fontSize: 10, color: Colors.textMuted, marginTop: 2 },
  posPnl: { fontFamily: FONT, fontSize: 14, fontWeight: "bold" },

  empty: { fontFamily: FONT, textAlign: "center", color: Colors.textMuted, marginTop: 16 },
  errorText: { fontFamily: FONT, color: Colors.dangerDark, textAlign: "center", marginTop: 16 },

  // Persistent bottom-sheet styling — gives the docked actions panel
  // the same visual language as our floating BottomSheet modals: rounded
  // top corners, grab handle, hairline divider, and an upward elevation
  // shadow so the sheet "lifts" off the scroll content above.
  sheetSafeBg: {
    backgroundColor: Colors.surface,
  },
  sheetSurface: {
    backgroundColor: Colors.surface,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderTopWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: 18,
    paddingBottom: 8,
    // iOS shadow (above)
    shadowColor: "#000",
    shadowOpacity: 0.08,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: -3 },
    // Android elevation
    elevation: 12,
  },
  grabber: {
    width: 40,
    height: 5,
    borderRadius: 3,
    backgroundColor: "#D6DDEA",
    alignSelf: "center",
    marginTop: 8,
    marginBottom: 10,
  },
  sheetHeader: {
    paddingBottom: 6,
  },
  sheetHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    paddingBottom: 6,
  },
  sheetHeaderLabel: {
    fontFamily: FONT,
    fontSize: 11,
    fontWeight: "bold",
    color: Colors.textSecondary,
    letterSpacing: 1.6,
  },
  sheetBody: {
    paddingTop: 6,
  },
  practiceBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: Colors.primary,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
  },
  practiceBadgeText: {
    fontFamily: FONT,
    fontSize: 9,
    color: "#FFFFFF",
    fontWeight: "bold",
    letterSpacing: 0.6,
  },
  footerTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8,
  },
  maxLossPill: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: Colors.pillBg,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  maxLossText: { fontFamily: FONT, fontSize: 11, fontWeight: "bold", color: Colors.text },
  toggleWrap: { flexDirection: "row", alignItems: "center", gap: 8 },
  toggleLabel: { fontFamily: FONT, fontSize: 13, color: Colors.textSecondary, fontWeight: "bold" },
  toggleLabelActive: { color: Colors.primary },

  grid: { flexDirection: "row", flexWrap: "wrap", gap: 4 },
  buyBtn: {
    width: "49.4%",
    height: 70,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 8,
    borderRadius: 2,
  },
  buyText: { fontFamily: FONT, color: "#FFF", fontWeight: "bold", textAlign: "center", fontSize: 12, letterSpacing: 0.6 },
  exitRow: { flexDirection: "row", gap: 4, marginTop: 4 },
  exitBtn: { height: 56, borderRadius: 2, alignItems: "center", justifyContent: "center" },
  exitPartial: { flex: 1, backgroundColor: Colors.dangerDark },
  exitAll: { backgroundColor: Colors.danger, marginTop: 4 },
  exitText: { fontFamily: FONT, color: "#FFF", fontWeight: "bold", fontSize: 12, letterSpacing: 0.6 },

  menuBackdrop: { flex: 1, backgroundColor: "transparent" },
  menuPanel: {
    marginTop: 48,
    marginRight: 12,
    marginLeft: "auto",
    backgroundColor: Colors.surface,
    borderRadius: 8,
    paddingVertical: 6,
    shadowColor: "#000",
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 6,
    width: 200,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  menuItem: { paddingVertical: 12, paddingHorizontal: 16 },
  menuItemText: { fontFamily: FONT, fontSize: 14, color: Colors.text, fontWeight: "bold" },

  bottomSheetWrap: { position: "absolute", left: 0, right: 0, bottom: 0 },
  bottomSheet: {
    backgroundColor: Colors.surface,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: 20,
    paddingBottom: 24,
    maxHeight: "70%",
  },
  // Older grabber used inside the underlying-search modal sheet — kept
  // distinct from the persistent ACTIONS sheet grabber so they can be
  // restyled independently.
  modalGrabber: {
    width: 40, height: 4, borderRadius: 2, backgroundColor: Colors.border, alignSelf: "center", marginBottom: 16,
  },
  sheetTitle: { fontFamily: FONT, fontWeight: "bold", fontSize: 16, color: Colors.text },
  sheetSub: { fontFamily: FONT, color: Colors.textSecondary, marginTop: 6, fontSize: 13 },
  sheetInput: {
    fontFamily: FONT,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 14,
    marginTop: 12,
    fontSize: 16,
    color: Colors.text,
  },
  sheetCta: { backgroundColor: Colors.primary, padding: 14, borderRadius: 10, alignItems: "center", marginTop: 16 },
  sheetCtaText: { fontFamily: FONT, color: "#FFF", fontWeight: "bold", letterSpacing: 1.2 },

  expiryRow: {
    flexDirection: "row",
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: Colors.borderLight,
    alignItems: "center",
  },
  expiryText: { fontFamily: FONT, fontSize: 14, color: Colors.text, flex: 1 },
  expiryCheck: { fontFamily: FONT, color: Colors.primary, fontWeight: "bold" },

  // Popover-style expiry selector (anchored under the header chip)
  expiryBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.08)",
  },
  expiryPopover: {
    position: "absolute",
    left: 12,
    right: 12,
    backgroundColor: Colors.surface,
    borderRadius: 16,
    paddingVertical: 12,
    paddingHorizontal: 6,
    shadowColor: "#000",
    shadowOpacity: 0.12,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
  },
  expiryCaret: {
    position: "absolute",
    top: -6,
    width: 12,
    height: 12,
    backgroundColor: Colors.surface,
    transform: [{ rotate: "45deg" }],
  },
  expiryPillsRow: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    gap: 10,
    alignItems: "center",
  },
  expiryPill: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Colors.pillBg,
  },
  expiryPillActive: {
    backgroundColor: Colors.primary,
  },
  expiryPillText: {
    fontFamily: FONT,
    fontSize: 17,
    fontWeight: "700",
    color: Colors.text,
  },
  expiryPillTextActive: {
    color: "#FFFFFF",
  },

  toast: {
    position: "absolute",
    top: 64,
    left: 12,
    right: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 12,
    borderLeftWidth: 4,
    // iOS shadow
    shadowColor: "#000",
    shadowOpacity: 0.10,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    // Android elevation
    elevation: 6,
    zIndex: 1000,
  },
  toastEmoji: { fontSize: 18, lineHeight: 22 },
  toastText: { fontFamily: FONT, fontSize: 13, fontWeight: "600", flex: 1, lineHeight: 18 },
});
