import { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  FlatList,
  ActivityIndicator,
  RefreshControl,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";

import { api } from "@/src/api/client";
import { Colors, FONT } from "@/src/theme";

type OrderRow = {
  order_id?: string;
  groww_order_id?: string;
  trading_symbol?: string;
  symbol?: string;
  transaction_type?: string;
  order_status?: string;
  status?: string;
  quantity?: number;
  filled_quantity?: number;
  /** Limit price the user submitted (0 for MARKET) */
  price?: number;
  /** Actual executed price — Groww's canonical key for fills */
  average_fill_price?: number;
  /** Older / alt naming */
  average_price?: number;
  trigger_price?: number;
  order_type?: string;
  created_at?: string;
  exchange_time?: string;
  trade_date?: string;
  exchange?: string;
  segment?: string;
  trigger_reason?: string | null;
  realised_pnl?: number | null;
};

const STATUS_PILLS: Record<string, { bg: string; fg: string }> = {
  EXECUTED: { bg: "rgba(26,77,255,0.08)", fg: Colors.primary },
  COMPLETE: { bg: "rgba(26,77,255,0.08)", fg: Colors.primary },
  PENDING: { bg: "rgba(0,0,0,0.05)", fg: Colors.textSecondary },
  CANCELLED: { bg: "rgba(0,0,0,0.05)", fg: Colors.textSecondary },
  REJECTED: { bg: "rgba(185,28,28,0.08)", fg: Colors.dangerDark },
  FAILED: { bg: "rgba(185,28,28,0.08)", fg: Colors.dangerDark },
};

export default function History() {
  const router = useRouter();
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api.orders();
      const list: OrderRow[] = res?.orders || res?.data || res?.items || (Array.isArray(res) ? res : []);
      setOrders(list);
    } catch (e: any) {
      setError(e?.message ?? "Failed to load orders");
    }
  }, []);

  useEffect(() => {
    (async () => {
      setLoading(true);
      await load();
      setLoading(false);
    })();
  }, [load]);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]} testID="order-history-screen">
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} testID="history-back">
          <Text style={styles.headerBack}>←</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>ORDER HISTORY</Text>
        <View style={{ width: 24 }} />
      </View>

      {loading ? (
        <ActivityIndicator color={Colors.primary} style={{ marginTop: 32 }} />
      ) : error ? (
        <Text style={styles.error}>{error}</Text>
      ) : (
        <FlatList
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.primary} />}
          data={orders}
          keyExtractor={(item, i) => item.groww_order_id || item.order_id || `${item.trading_symbol}-${i}`}
          renderItem={({ item, index }) => {
            const status = (item.order_status || item.status || "").toUpperCase();
            const pill = STATUS_PILLS[status] || { bg: "rgba(0,0,0,0.05)", fg: Colors.textSecondary };
            const sym = item.trading_symbol || item.symbol || "—";
            const side = item.transaction_type || "—";
            const qty = item.filled_quantity ?? item.quantity ?? 0;
            // Groww's canonical executed-fill price field is `average_fill_price`.
            // Fall back through legacy / alternate names so this also works for
            // orders coming from older payloads or our own demo state.
            const filled = Number(item.average_fill_price ?? item.average_price ?? 0);
            const submitted = Number(item.price ?? 0);
            const px = filled > 0 ? filled : submitted;
            const reason = item.trigger_reason; // "TP_HIT" | "SL_HIT" | undefined
            const reasonLabel =
              reason === "TP_HIT" ? "🎯 TAKE PROFIT" : reason === "SL_HIT" ? "🛑 STOP LOSS" : null;
            const reasonColor =
              reason === "TP_HIT" ? Colors.pnlPositive : reason === "SL_HIT" ? Colors.pnlNegative : Colors.textSecondary;
            const realised = typeof item.realised_pnl === "number" ? item.realised_pnl : null;
            const ts = item.exchange_time || item.created_at || item.trade_date;
            return (
              <View style={styles.row} testID={`order-row-${index}`}>
                <View style={{ flex: 1 }}>
                  <View style={styles.rowTop}>
                    <Text style={styles.sym}>{sym}</Text>
                    <Text style={[styles.side, side === "SELL" && { color: Colors.danger }]}>{side}</Text>
                  </View>
                  <Text style={styles.meta}>
                    {item.order_type || "—"} · Qty {qty} · ₹{px.toFixed(2)}
                  </Text>
                  {reasonLabel ? (
                    <Text style={[styles.triggerLine, { color: reasonColor }]}>
                      {reasonLabel}
                      {realised !== null
                        ? `   ${realised >= 0 ? "+" : ""}₹${Math.abs(realised).toFixed(2)} realised`
                        : ""}
                    </Text>
                  ) : null}
                  {ts ? <Text style={styles.time}>{ts}</Text> : null}
                </View>
                <View style={[styles.pill, { backgroundColor: pill.bg }]}>
                  <Text style={[styles.pillText, { color: pill.fg }]}>{status || "—"}</Text>
                </View>
              </View>
            );
          }}
          ListEmptyComponent={<Text style={styles.empty}>No orders yet.</Text>}
          contentContainerStyle={orders.length === 0 ? { flex: 1, justifyContent: "center" } : {}}
        />
      )}
    </SafeAreaView>
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
  },
  headerBack: { fontFamily: FONT, color: Colors.text, fontSize: 20, fontWeight: "bold" },
  headerTitle: { fontFamily: FONT, color: Colors.text, fontWeight: "bold", fontSize: 14, letterSpacing: 1, flex: 1, textAlign: "center" },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: Colors.borderLight,
  },
  rowTop: { flexDirection: "row", alignItems: "center", gap: 8 },
  sym: { fontFamily: FONT, fontWeight: "bold", color: Colors.text, fontSize: 13 },
  side: { fontFamily: FONT, fontWeight: "bold", fontSize: 11, color: Colors.primary, letterSpacing: 0.6 },
  meta: { fontFamily: FONT, fontSize: 12, color: Colors.textSecondary, marginTop: 2 },
  triggerLine: { fontFamily: FONT, fontSize: 11, fontWeight: "bold", letterSpacing: 0.4, marginTop: 3 },
  time: { fontFamily: FONT, fontSize: 10, color: Colors.textMuted, marginTop: 2 },
  pill: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 4 },
  pillText: { fontFamily: FONT, fontSize: 10, fontWeight: "bold", letterSpacing: 0.6 },
  empty: { fontFamily: FONT, textAlign: "center", color: Colors.textMuted },
  error: { fontFamily: FONT, color: Colors.dangerDark, textAlign: "center", marginTop: 24 },
});
