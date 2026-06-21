import { useCallback, useEffect, useMemo, useState } from "react";
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

import { api, clearToken, AppSettings } from "@/src/api/client";
import { Colors, FONT } from "@/src/theme";
import { storage } from "@/src/utils/storage";
import ConfirmSheet from "@/src/components/ConfirmSheet";
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

  const [optionType, setOptionType] = useState<"CE" | "PE">("CE");

  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [usdRate, setUsdRate] = useState<number>(0.012);

  const [underlying, setUnderlying] = useState<string>("NIFTY");
  const [expiry, setExpiry] = useState<string | null>(null);
  const [expiryList, setExpiryList] = useState<string[]>([]);

  const [maxLoss, setMaxLoss] = useState<number>(40000);

  // Modals
  const [searchVisible, setSearchVisible] = useState(false);
  const [menuVisible, setMenuVisible] = useState(false);
  const [maxLossVisible, setMaxLossVisible] = useState(false);
  const [maxLossInput, setMaxLossInput] = useState("40000");
  const [expirySheetVisible, setExpirySheetVisible] = useState(false);
  const [confirmPreset, setConfirmPreset] = useState<PresetSummary | null>(null);
  const [confirmExit, setConfirmExit] = useState<25 | 50 | 100 | null>(null);
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
      const exp: string[] = res?.expiries || res?.data || res?.items || [];
      setExpiryList(Array.isArray(exp) ? exp : []);
      if (Array.isArray(exp) && exp.length && !expiry) setExpiry(exp[0]);
    } catch {
      setExpiryList([]);
    }
  }, [expiry]);

  const loadAll = useCallback(async () => {
    setError(null);
    try {
      const [m, p] = await Promise.all([api.margin(), api.positions()]);
      // Try to be flexible about Groww's payload shape
      const eq =
        m?.equity?.available_cash ??
        m?.equity?.net_marginUsed ??
        m?.available_margin ??
        m?.net_margin_available ??
        m?.cash ??
        m?.net ??
        0;
      const used = m?.used_margin ?? m?.margin_used ?? 0;
      setBalance(Number(eq) || 0);
      setCapital((Number(eq) || 0) + (Number(used) || 0));
      const positionsList: Position[] =
        p?.positions || p?.data || p?.items || (Array.isArray(p) ? p : []);
      setPositions(positionsList.filter((x) => (x.net_quantity || x.quantity || 0) !== 0));
    } catch (e: any) {
      setError(e?.message ?? "Failed to load account data");
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      let mounted = true;
      (async () => {
        setLoading(true);
        await loadAll();
        if (mounted) setLoading(false);
      })();
      return () => {
        mounted = false;
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

  const onPresetPress = (preset: PresetSummary) => {
    if (!expiry) {
      showToast("Pick an expiry first");
      return;
    }
    if (settings?.confirm_before_order) {
      setConfirmPreset(preset);
    } else {
      placePreset(preset);
    }
  };

  const placePreset = async (preset: PresetSummary) => {
    setPlacing(true);
    setConfirmPreset(null);
    try {
      const res = await api.placePreset({
        preset_key: preset.key,
        underlying,
        expiry: expiry!,
        option_type: optionType,
        capital,
        exchange: ["SENSEX", "BANKEX"].includes(underlying) ? "BSE" : "NSE",
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

  const doExit = async (pct: 25 | 50 | 100) => {
    setConfirmExit(null);
    setPlacing(true);
    try {
      const res = await api.exit(pct);
      showToast(`Exited ${res?.count ?? 0} positions (${pct}%)`);
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
    await clearToken();
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
          style={styles.headerLeft}
          onPress={() => setSearchVisible(true)}
          testID="header-underlying-button"
        >
          <Text style={styles.caret}>▾</Text>
          <Text style={styles.headerTitle}>
            {underlying}
            <Text style={styles.headerExpiry}> · {expiry ?? "pick expiry"}</Text>
          </Text>
        </TouchableOpacity>
        <View style={styles.headerRight}>
          <TouchableOpacity
            style={styles.iconBtn}
            onPress={() => setSearchVisible(true)}
            testID="header-add-button"
          >
            <Text style={styles.iconText}>+</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.iconBtn}
            onPress={() => router.push("/history")}
            testID="header-history-button"
          >
            <Text style={styles.iconText}>⟳</Text>
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
          <Text style={[styles.posTotal, { color: pnlColor(totalPnl) }]}>
            {pnlSign(totalPnl)}
            {formatINR(Math.abs(totalPnl))}
          </Text>
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
            const sym = p.trading_symbol ?? p.symbol ?? "—";
            const side = qty >= 0 ? "BUY" : "SELL";
            return (
              <View key={`${sym}-${i}`} style={styles.posRow} testID={`position-row-${i}`}>
                <View style={{ flex: 1 }}>
                  <View style={styles.posRowTop}>
                    <Text style={styles.posSym}>{sym}</Text>
                    <Text style={styles.posSide}> · {side}</Text>
                  </View>
                  <Text style={styles.posMeta}>
                    Avg. Price - ₹{formatINR(ap)} × {Math.abs(qty)} Qty
                  </Text>
                  {p.created_at ? <Text style={styles.posTime}>{p.created_at}</Text> : null}
                </View>
                <Text style={[styles.posPnl, { color: pnlColor(pnl) }]}>
                  {pnlSign(pnl)}
                  {formatINR(Math.abs(pnl))}
                </Text>
              </View>
            );
          })
        )}
      </ScrollView>

      {/* Sticky footer with controls */}
      <SafeAreaView edges={["bottom"]} style={styles.footerWrap}>
        <View style={styles.footer}>
          <View style={styles.footerTop}>
            <TouchableOpacity
              style={styles.maxLossPill}
              onPress={() => {
                setMaxLossInput(String(maxLoss));
                setMaxLossVisible(true);
              }}
              testID="max-loss-pill"
            >
              <Text style={styles.maxLossText}>Set Max Loss: (₹{formatINR(maxLoss)})</Text>
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
                label="Pick Expiry"
                onPress={() => {
                  setMenuVisible(false);
                  setExpirySheetVisible(true);
                }}
                testID="menu-expiry"
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
                <Text style={styles.expiryText}>{e}</Text>
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
      <ConfirmSheet
        visible={!!confirmPreset}
        title={confirmPreset?.label ?? ""}
        message={`Underlying: ${underlying} · Expiry: ${expiry ?? "?"} · Side: ${optionType}`}
        confirmLabel={placing ? "PLACING…" : "PLACE ORDER"}
        cancelLabel="CANCEL"
        onConfirm={() => confirmPreset && placePreset(confirmPreset)}
        onCancel={() => setConfirmPreset(null)}
        testID="confirm-place"
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
    justifyContent: "space-between",
    padding: 14,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
    backgroundColor: Colors.bg,
  },
  headerLeft: { flexDirection: "row", alignItems: "center", gap: 6, flex: 1 },
  headerTitle: { fontFamily: FONT, fontSize: 16, fontWeight: "bold", color: Colors.text },
  headerExpiry: { fontFamily: FONT, fontWeight: "normal", color: Colors.textSecondary, fontSize: 13 },
  caret: { fontSize: 16, color: Colors.text },
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

  posHeader: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 8 },
  posTitle: { fontFamily: FONT, fontSize: 13, color: Colors.text, fontWeight: "bold" },
  posTotal: { fontFamily: FONT, fontSize: 13, fontWeight: "bold" },

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
  posTime: { fontFamily: FONT, fontSize: 10, color: Colors.textMuted, marginTop: 2 },
  posPnl: { fontFamily: FONT, fontSize: 14, fontWeight: "bold" },

  empty: { fontFamily: FONT, textAlign: "center", color: Colors.textMuted, marginTop: 16 },
  errorText: { fontFamily: FONT, color: Colors.dangerDark, textAlign: "center", marginTop: 16 },

  footerWrap: { backgroundColor: Colors.bg },
  footer: {
    borderTopWidth: 1,
    borderTopColor: Colors.border,
    backgroundColor: "#FFF",
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 6,
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

  menuBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)" },
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
  grabber: {
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
