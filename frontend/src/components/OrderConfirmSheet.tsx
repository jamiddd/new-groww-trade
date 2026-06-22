import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from "react-native";

import { Colors, FONT } from "@/src/theme";
import BottomSheet from "./BottomSheet";

export type OrderPreview = {
  preset?: any;
  selected?: { trading_symbol?: string; strike?: number; ltp?: number; iv?: number; gamma?: number } | null;
  quantity?: number;
  lots?: number;
  lot_size?: number;
  estimated_cost?: number;
  spot?: number;
  fallback_reason?: string | null;
  error?: string | null;
  order?: { trading_symbol?: string; transaction_type?: string; order_type?: string; price?: number };
};

type Props = {
  visible: boolean;
  preview: OrderPreview | null;
  loading: boolean;
  placing: boolean;
  presetLabel: string;
  underlying: string;
  expiry: string;
  optionType: "CE" | "PE";
  formatMoney: (n: number) => string;
  onConfirm: () => void;
  onCancel: () => void;
};

const STRIKE_LABELS: Record<string, string> = {
  HIGH_GAMMA: "High Gamma",
  ATM: "At-the-money",
  OTM1: "OTM +1",
  OTM2: "OTM +2",
  ITM1: "ITM −1",
};
const IV_LABELS: Record<string, string> = { LOW_IV: "Low IV", HIGH_IV: "High IV", ANY: "Any IV" };

export default function OrderConfirmSheet({
  visible,
  preview,
  loading,
  placing,
  presetLabel,
  underlying,
  expiry,
  optionType,
  formatMoney,
  onConfirm,
  onCancel,
}: Props) {
  const sel = preview?.selected ?? {};
  const ord = preview?.order ?? {};
  const preset = preview?.preset ?? {};
  const ltp = Number(sel.ltp ?? 0);
  const qty = Number(preview?.quantity ?? 0);
  const lots = Number(preview?.lots ?? 0);
  const lotSize = Number(preview?.lot_size ?? 0);
  const cost = Number(preview?.estimated_cost ?? ltp * qty);
  const isLimit = (ord.order_type || "").toUpperCase() === "LIMIT";

  return (
    <BottomSheet visible={visible} onClose={onCancel} testID="order-confirm-sheet">
      <Text style={styles.title}>{presetLabel}</Text>
      <Text style={styles.sub}>
        {underlying} · {expiry} · {optionType}
      </Text>

      {loading || !preview ? (
        <View style={styles.loadingBlock}>
          <ActivityIndicator color={Colors.primary} />
          <Text style={styles.loadingText}>Computing strike & sizing…</Text>
        </View>
      ) : (
        <>
          {preview.fallback_reason || preview.error || !preview.selected ? (
            <View style={styles.warnBox}>
              <Text style={styles.warnText}>
                {preview.fallback_reason === "option_chain_unavailable"
                  ? "Option chain unreachable. Showing best-effort pick from the instrument master — LTP & quantity will be recomputed at the moment the order is placed."
                  : preview.fallback_reason === "no_strike_matched_filters"
                  ? "No strike matched the preset's IV/strategy filters exactly. Showing closest ATM strike — adjust the preset for stricter matching."
                  : preview.fallback_reason === "no_contracts_found"
                  ? "No live option contracts found for this underlying + expiry. Pick a different expiry."
                  : preview.fallback_reason === "insufficient_capital"
                  ? "Capital × position-sizing % can't cover even one lot at the current LTP. Increase capital, sizing %, or pick a cheaper strike."
                  : preview.error
                  ? `Preview error: ${preview.error}`
                  : "Could not build a full preview — review carefully before placing."}
              </Text>
            </View>
          ) : null}
          <View style={styles.card}>
            <Row label="SYMBOL" value={sel.trading_symbol ?? "—"} bold />
            <Row label="STRIKE" value={sel.strike != null ? String(sel.strike) : "—"} />
            <Row label="LTP" value={ltp ? formatMoney(ltp) : "—"} />
            <Row label="LOTS × LOT SIZE" value={`${lots} × ${lotSize}`} />
            <Row label="QUANTITY" value={String(qty)} />
            <Row label="EST. COST" value={cost ? formatMoney(cost) : "—"} bold />
          </View>

          <View style={styles.card}>
            <Row
              label="STRIKE SELECTION"
              value={STRIKE_LABELS[preset.strike_selection] ?? preset.strike_selection ?? "—"}
            />
            <Row label="IV FILTER" value={IV_LABELS[preset.iv_filter] ?? preset.iv_filter ?? "—"} />
            <Row label="POSITION SIZING" value={preset.position_sizing_pct != null ? `${preset.position_sizing_pct}%` : "—"} />
            <Row
              label="RISK"
              value={`${preset.stop_loss_pct ?? 0}% SL${
                preset.take_profit_pct ? `, ${preset.take_profit_pct}% TP` : ", No TP"
              }`}
            />
            <Row
              label="ORDER TYPE"
              value={`${(ord.order_type || preset.order_type || "MARKET")}${isLimit && ord.price ? ` @ ${formatMoney(Number(ord.price))}` : ""}`}
            />
          </View>
        </>
      )}

      <View style={styles.row}>
        <TouchableOpacity
          style={[styles.btn, styles.cancelBtn]}
          onPress={onCancel}
          testID="order-confirm-cancel"
        >
          <Text style={styles.cancelText}>CANCEL</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[
            styles.btn,
            styles.confirmBtn,
            (placing || loading || qty < 1 || !sel.trading_symbol) && { opacity: 0.4 },
          ]}
          onPress={onConfirm}
          disabled={placing || loading || qty < 1 || !sel.trading_symbol}
          testID="order-confirm-place"
        >
          {placing ? <ActivityIndicator color="#FFF" /> : <Text style={styles.confirmText}>PLACE ORDER</Text>}
        </TouchableOpacity>
      </View>
    </BottomSheet>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <View style={styles.kvRow}>
      <Text style={styles.kvLabel}>{label}</Text>
      <Text style={[styles.kvValue, bold && { fontWeight: "bold", color: Colors.text }]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  title: { fontFamily: FONT, fontWeight: "bold", fontSize: 16, color: Colors.text, letterSpacing: 0.4 },
  sub: { fontFamily: FONT, fontSize: 12, color: Colors.textSecondary, marginTop: 4 },
  loadingBlock: { paddingVertical: 24, alignItems: "center", gap: 8 },
  loadingText: { fontFamily: FONT, color: Colors.textSecondary, fontSize: 13 },
  warnBox: {
    backgroundColor: "#FEF3C7",
    borderRadius: 8,
    padding: 10,
    marginTop: 12,
  },
  warnText: { fontFamily: FONT, color: "#92400E", fontSize: 12, lineHeight: 17 },
  card: {
    backgroundColor: "#F8FAFC",
    borderRadius: 10,
    padding: 12,
    marginTop: 12,
    gap: 6,
  },
  kvRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 4,
  },
  kvLabel: { fontFamily: FONT, fontSize: 10, color: Colors.textSecondary, fontWeight: "bold", letterSpacing: 1 },
  kvValue: { fontFamily: FONT, fontSize: 13, color: Colors.text, flexShrink: 1, textAlign: "right", marginLeft: 12 },
  row: { flexDirection: "row", gap: 12, marginTop: 16, marginBottom: 8 },
  btn: { flex: 1, paddingVertical: 14, borderRadius: 10, alignItems: "center" },
  cancelBtn: { backgroundColor: Colors.borderLight },
  cancelText: { fontFamily: FONT, fontWeight: "bold", color: Colors.text, letterSpacing: 1 },
  confirmBtn: { backgroundColor: Colors.primary },
  confirmText: { fontFamily: FONT, fontWeight: "bold", color: "#FFF", letterSpacing: 1.2 },
});
