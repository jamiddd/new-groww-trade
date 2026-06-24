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
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { Gesture, GestureDetector } from "react-native-gesture-handler";

import { api, disconnect, AppSettings } from "@/src/api/client";
import { Colors, FONT } from "@/src/theme";
import { storage } from "@/src/utils/storage";
import { formatExpiry } from "@/src/utils/format";
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

export default function Home() {
  const router = useRouter();

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

  // Modals
  const [searchVisible, setSearchVisible] = useState(false);
  const [menuVisible, setMenuVisible] = useState(false);
  const [maxLossVisible, setMaxLossVisible] = useState(false);
  const [maxLossInput, setMaxLossInput] = useState("40000");
  const [expirySheetVisible, setExpirySheetVisible] = useState(false);
  const [confirmPreset, setConfirmPreset] = useState<PresetSummary | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [preview, setPreview] = useState<OrderPreview | null>(null);
  const [confirmExit, setConfirmExit] = useState<25 | 50 | 100 | null>(null);
  const [singlePos, setSinglePos] = useState<Position | null>(null);
  const [posMenuVisible, setPosMenuVisible] = useState(false);
  const [placing, setPlacing] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  // Bootstrap settings + last underlying
  useEffect(() => {
    (async () => {
      try {
        const [s, fx] = await Promise.all([api.settings(), api.fxInrUsd()]);
        setSettings(s);
        if (fx?.rate) setUsdRate(fx.rate);
        if (s.save_last_underlying && s.last_underlying) {
          // Check expiry not stale
          const expOk = !s.last_underlying_expiry || new Date(s.last_underlying_expiry) >= new Date();
          if (expOk) {
            setUnderlying(s.last_underlying);
            if (s.last_underlying_expiry) setExpiry(s.last_underlying_expiry);
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

  const loadExpiries = useCallback(async (u: string) => {
    try {
      const exch = ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY"].includes(u)
        ? "NSE"
        : u === "SENSEX" || u === "BANKEX"
        ? "BSE"
        : "NSE";
      const res = await api.expiries(u, exch);
      const raw: string[] = res?.expiries || res?.data || res?.items || [];
      const todayIso = new Date().toISOString().slice(0, 10);
      const exp = (Array.isArray(raw) ? raw : [])
        .filter((d) => typeof d === "string" && d >= todayIso)
        .sort();
      setExpiryList(exp);
      // Reset the selected expiry if the previous one is no longer valid
      // (e.g., it expired, or the schedule changed).
      setExpiry((cur) => (cur && exp.includes(cur) ? cur : exp[0] ?? null));
    } catch {
      setExpiryList([]);
    }
  }, []);

  const loadAll = useCallback(async () => {
    setError(null);
    try {
      const [m, p, so] = await Promise.all([
        api.margin(),
        api.positions(),
        api.smartOrders().catch(() => ({ items: [] })),
      ]);
      // Backend now exposes canonical fields:
      //   m.available_margin     → live total trading balance (cash + used + collateral)
      //   m.opening_capital_today → that same number snapshotted at start of day
      // So PnL today = balance - capital, no extra arithmetic needed.
      const liveTotal = Number(
        m?.available_margin ??
          m?.total_balance ??
          // Last-resort fallback for old payload shapes:
          (Number(m?.equity?.available_cash ?? m?.cash ?? 0) +
            Number(m?.used_margin ?? 0)),
      ) || 0;
      const opening = Number(m?.opening_capital_today ?? liveTotal) || 0;
      setBalance(liveTotal);
      setCapital(opening);
      const positionsList: Position[] =
        p?.positions || p?.data || p?.items || (Array.isArray(p) ? p : []);
      setPositions(positionsList.filter((x) => (x.net_quantity || x.quantity || 0) !== 0));

      // Index active smart orders by trading_symbol so each position row
      // can light up its 🛡 protection badge in O(1).
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
    } catch (e: any) {
      setError(e?.message ?? "Failed to load account data");
    }
  }, []);

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
        await loadAll();
        if (mounted) setLoading(false);
      })();

      // Auto-refresh positions + margin every 5 s while the screen is
      // focused. This is what surfaces live LTP / live P&L without the
      // user needing to pull-to-refresh.
      const poll = setInterval(() => {
        if (!mounted || placingRef.current) return;
        loadAll();
      }, 5000);

      return () => {
        mounted = false;
        clearInterval(poll);
      };
    }, [loadAll]),
  );

  useEffect(() => {
    if (underlying) loadExpiries(underlying);
  }, [underlying, loadExpiries]);

  const onRefresh = async () => {
    setRefreshing(true);
    await loadAll();
    setRefreshing(false);
  };

  const totalPnl = useMemo(
    () =>
      positions.reduce(
        (acc, p) => acc + (Number(p.pnl ?? p.unrealised_pnl ?? 0) || 0),
        0,
      ),
    [positions],
  );

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  };

  // Pixel-perfect height animation for the actions panel body. We render
  // the body once (offscreen on first paint) to measure its natural
  // height, then animate the clip-container's height between 0 ↔
  // measuredHeight whenever the collapse state changes. No opacity / fade
  // — strictly translate the layout.
  const bodyHeight = useSharedValue(0);
  const expandProgress = useSharedValue(actionsCollapsed ? 0 : 1);
  // Captured at gesture start so the user can drag the sheet smoothly
  // from wherever it currently sits (open, closed, or half-dragged).
  const dragBaseline = useSharedValue(0);

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
  // could intermittently swallow events).
  const actionsPanGesture = useMemo(() => {
    return Gesture.Pan()
      .activeOffsetY([-6, 6])
      .onStart(() => {
        "worklet";
        dragBaseline.value = expandProgress.value;
      })
      .onChange((e) => {
        "worklet";
        if (bodyHeight.value <= 0) return;
        // Dragging UP (negative translationY) should EXPAND → progress↑.
        // Dragging DOWN (positive translationY) should COLLAPSE → progress↓.
        const delta = -e.translationY / bodyHeight.value;
        const next = dragBaseline.value + delta;
        expandProgress.value = Math.max(0, Math.min(1, next));
      })
      .onEnd((e) => {
        "worklet";
        // Snap to the nearest end-stop, with velocity bias so a quick
        // flick wins over the strict midpoint check.
        const flickUp = e.velocityY < -500;
        const flickDown = e.velocityY > 500;
        let target: 0 | 1;
        if (flickUp) target = 1;
        else if (flickDown) target = 0;
        else target = expandProgress.value >= 0.5 ? 1 : 0;
        expandProgress.value = withTiming(target, { duration: 200 });
        // Mirror the resolved state into React land + AsyncStorage.
        runOnJS(setActionsCollapsedPersistent)(target === 0);
      });
  }, [setActionsCollapsedPersistent, expandProgress, bodyHeight, dragBaseline]);

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
          exchange: ["SENSEX", "BANKEX"].includes(underlying) ? "BSE" : "NSE",
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
          exchange: ["SENSEX", "BANKEX"].includes(underlying) ? "BSE" : "NSE",
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
        exchange: ["SENSEX", "BANKEX"].includes(underlying) ? "BSE" : "NSE",
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
    if (settings?.save_last_underlying) {
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
          style={styles.headerChipSecondary}
          onPress={() => setExpirySheetVisible(true)}
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
        ) : positions.length === 0 ? (
          <Text style={styles.empty}>No open positions.</Text>
        ) : (
          positions.map((p, i) => {
            const pnl = Number(p.pnl ?? p.unrealised_pnl ?? 0) || 0;
            const qty = Number(p.net_quantity ?? p.quantity ?? 0);
            const ap = Number(p.average_price ?? p.avg_price ?? 0);
            const ltp = Number(p.ltp ?? p.last_price ?? 0);
            const changePct = ap > 0 && ltp > 0 ? ((ltp - ap) / ap) * 100 : 0;
            const sym = p.trading_symbol ?? p.symbol ?? "—";
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

      {/* Expiry sheet */}
      <BottomSheet
        visible={expirySheetVisible}
        onClose={() => setExpirySheetVisible(false)}
        testID="expiry-sheet"
      >
        <Text style={styles.sheetTitle}>Select Expiry · {underlying}</Text>
        {expiryList.length === 0 ? (
          <Text style={styles.empty}>No expiries available.</Text>
        ) : (
          <ScrollView style={{ maxHeight: 360 }} contentContainerStyle={{ paddingBottom: 8 }}>
            {expiryList.map((e) => (
              <TouchableOpacity
                key={e}
                style={styles.expiryRow}
                onPress={() => onPickExpiry(e)}
                testID={`expiry-row-${e}`}
              >
                <Text style={styles.expiryText}>{formatExpiry(e)}</Text>
                {expiry === e ? <Text style={styles.expiryCheck}>✓</Text> : null}
              </TouchableOpacity>
            ))}
          </ScrollView>
        )}
      </BottomSheet>

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
        <View style={styles.toast} testID="home-toast">
          <Text style={styles.toastText}>{toast}</Text>
        </View>
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
  return (
    <TouchableOpacity style={styles.menuItem} onPress={onPress} testID={testID}>
      <Text style={[styles.menuItemText, destructive && { color: Colors.danger }]}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
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
    backgroundColor: "#FFF",
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
    backgroundColor: "#FFFFFF",
  },
  sheetSurface: {
    backgroundColor: "#FFFFFF",
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
    // Robust 2-column layout: flexBasis seeds each button at ~48% of the
    // row, flexGrow lets it stretch to consume the remaining 4 px gap.
    // No more "49.4% + 4 px > 100% → wraps to single column" surprise on
    // iPhone preview / smaller widths.
    flexBasis: "48%",
    flexGrow: 1,
    height: 70,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 8,
    borderRadius: 2,
  },
  buyText: { fontFamily: FONT, color: "#FFF", fontWeight: "bold", textAlign: "center", fontSize: 12, letterSpacing: 0.6 },
  exitRow: { flexDirection: "row", gap: 4, marginTop: 4 },
  exitBtn: {
    flex: 1,
    height: 56,
    borderRadius: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  exitPartial: { flex: 1, backgroundColor: Colors.dangerDark },
  exitAll: { backgroundColor: Colors.danger, marginTop: 4 },
  exitText: { fontFamily: FONT, color: "#FFF", fontWeight: "bold", fontSize: 12, letterSpacing: 0.6 },

  menuBackdrop: { flex: 1, backgroundColor: "transparent" },
  menuPanel: {
    marginTop: 48,
    marginRight: 12,
    marginLeft: "auto",
    backgroundColor: "#FFF",
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
    backgroundColor: "#FFF",
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

  toast: {
    position: "absolute",
    bottom: 380,
    left: 16,
    right: 16,
    backgroundColor: "#0F1F4D",
    padding: 12,
    borderRadius: 8,
    alignItems: "center",
  },
  toastText: { fontFamily: FONT, color: "#FFF", fontSize: 13, fontWeight: "bold" },
});
