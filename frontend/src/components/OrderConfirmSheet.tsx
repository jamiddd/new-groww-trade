import { useMemo } from "react";
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, ScrollView, useWindowDimensions } from "react-native";

import { ColorPalette, FONT } from "@/src/theme";
import { useTheme } from "@/src/theme/ThemeProvider";
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
  protective_preview?: {
    entry_price?: number;
    sl_price?: number;
    tp_price?: number;
    sl_pct?: number;
    tp_pct?: number;
  } | null;
  /** Helper context: % of last hour the option's close traded below the current LTP. */
  below_price_pct?: { pct: number; samples: number } | null;
  /** 9-period EMA on 1-min candles for the last hour. diff_pct = (LTP - EMA)/EMA × 100. */
  ema9?: { value: number; diff_pct: number; samples: number } | null;
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
  const { Colors } = useTheme();
  const styles = useMemo(() => mkStyles(Colors), [Colors]);
  const sel = preview?.selected ?? {};
  const ord = preview?.order ?? {};
  const preset = preview?.preset ?? {};
  const ltp = Number(sel.ltp ?? 0);
  const qty = Number(preview?.quantity ?? 0);
  const lots = Number(preview?.lots ?? 0);
  const lotSize = Number(preview?.lot_size ?? 0);
  const cost = Number(preview?.estimated_cost ?? ltp * qty);
  const isLimit = (ord.order_type || "").toUpperCase() === "LIMIT";
  const { height: vh } = useWindowDimensions();
  // Total sheet content height = 80% of screen. We subtract a small
  // allowance for the BottomSheet's own padding + grabber + safe-area
  // bottom inset so the *visible* sheet ends up close to 80vh and the
  // footer never overlaps the gesture-nav indicator.
  const sheetContentHeight = Math.round(vh * 0.8) - 56;

  return (
    <BottomSheet visible={visible} onClose={onCancel} draggable={false} testID="order-confirm-sheet">
      <View style={[styles.sheetContainer, { height: sheetContentHeight }]}>
        <ScrollView
          style={styles.scrollArea}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator
          testID="order-confirm-scroll"
        >
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
                  : preview.fallback_reason === "ltp_unavailable"
                  ? "Couldn't fetch a live LTP for the picked strike — sizing skipped. Try another expiry or wait for the market to refresh quotes."
                  : preview.error
                  ? `Preview error: ${preview.error}`
                  : "Could not build a full preview — review carefully before placing."}
              </Text>
            </View>
          ) : null}

          {/* Hero entry-price block. For LIMIT we show the exact submitted
              price; for MARKET we show LTP as the "approximate" entry. */}
          {(() => {
            const limitPx = isLimit ? Number(ord.price || 0) : 0;
            const entryPx = limitPx > 0 ? limitPx : ltp;
            if (!entryPx) return null;
            const ctx = preview.below_price_pct;
            // "Cheap zone" if the price has spent ≤30% of the last hour
            // below the current LTP — i.e., we're near the recent low.
            // Anything ≥60% means we're chasing.
            const ctxColor =
              ctx && ctx.pct >= 60
                ? Colors.pnlNegative
                : ctx && ctx.pct <= 30
                ? Colors.pnlPositive
                : Colors.textSecondary;
            return (
              <View style={styles.heroPriceBlock}>
                <Text style={styles.heroPriceLabel}>
                  {isLimit ? "LIMIT BUY @" : "BUY (MARKET) ≈"}
                </Text>
                <Text style={styles.heroPriceValue} testID="entry-price">
                  {formatMoney(entryPx)}
                </Text>
                {isLimit && ltp ? (
                  <Text style={styles.heroPriceSub}>
                    LTP {formatMoney(ltp)} ·{" "}
                    <Text style={{ color: Colors.pnlNegative, fontWeight: "bold" }}>
                      {((entryPx - ltp) / ltp * 100).toFixed(2)}%
                    </Text>
                  </Text>
                ) : null}
                {ctx ? (
                  <Text style={styles.heroPriceCtx} testID="below-price-pct">
                    Below current price{" "}
                    <Text style={{ color: ctxColor, fontWeight: "bold" }}>
                      {ctx.pct}%
                    </Text>{" "}
                    of last hour
                  </Text>
                ) : null}
                {preview.ema9 ? (
                  <Text style={styles.heroPriceCtx} testID="ema9-line">
                    {preview.ema9.diff_pct >= 0 ? "Above" : "Below"} 9 EMA (
                    {formatMoney(preview.ema9.value)}) by{" "}
                    <Text
                      style={{
                        // EMA dip = potential pullback entry = green-ish
                        // (we're long-biased). EMA extension = chasing = red.
                        color:
                          preview.ema9.diff_pct >= 1.5
                            ? Colors.pnlNegative
                            : preview.ema9.diff_pct <= -1.5
                            ? Colors.pnlPositive
                            : Colors.textSecondary,
                        fontWeight: "bold",
                      }}
                    >
                      {Math.abs(preview.ema9.diff_pct).toFixed(2)}%
                    </Text>
                  </Text>
                ) : null}
              </View>
            );
          })()}

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

          {preview.protective_preview &&
          ((preview.protective_preview.sl_price ?? 0) > 0 ||
            (preview.protective_preview.tp_price ?? 0) > 0) ? (
            <View style={styles.card}>
              <Text style={styles.cardLabel}>PROTECTION (auto-armed after fill)</Text>
              {(preview.protective_preview.tp_price ?? 0) > 0 ? (
                <Row
                  label="TAKE PROFIT"
                  value={`${formatMoney(preview.protective_preview.tp_price ?? 0)}  (+${
                    preview.protective_preview.tp_pct ?? 0
                  }%)`}
                  valueColor={Colors.pnlPositive}
                />
              ) : null}
              {(preview.protective_preview.sl_price ?? 0) > 0 ? (
                <Row
                  label="STOP LOSS"
                  value={`${formatMoney(preview.protective_preview.sl_price ?? 0)}  (−${
                    preview.protective_preview.sl_pct ?? 0
                  }%)`}
                  valueColor={Colors.pnlNegative}
                />
              ) : null}
              <Text style={styles.protectHint}>
                {(preview.protective_preview.sl_price ?? 0) > 0 &&
                (preview.protective_preview.tp_price ?? 0) > 0
                  ? "OCO smart order — whichever hits first cancels the other."
                  : "Single GTT smart order — auto-exits when triggered."}
              </Text>
            </View>
          ) : null}
        </>
      )}
        </ScrollView>

        {/* Sticky footer — Cancel + Place Order always visible. */}
        <View style={styles.stickyFooter}>
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
      </View>
    </BottomSheet>
  );
}

function Row({
  label,
  value,
  bold,
  valueColor,
}: {
  label: string;
  value: string;
  bold?: boolean;
  valueColor?: string;
}) {
  const { Colors } = useTheme();
  const styles = useMemo(() => mkStyles(Colors), [Colors]);
  return (
    <View style={styles.kvRow}>
      <Text style={styles.kvLabel}>{label}</Text>
      <Text
        style={[
          styles.kvValue,
          bold && { fontWeight: "bold", color: Colors.text },
          valueColor ? { color: valueColor, fontWeight: "bold" } : null,
        ]}
      >
        {value}
      </Text>
    </View>
  );
}

const mkStyles = (Colors: ColorPalette) => StyleSheet.create({
  // Fixed-height column. The BottomSheet auto-sizes to this height,
  // ScrollView consumes the remaining flex, footer stays pinned bottom.
  sheetContainer: {
    flexDirection: "column",
  },
  scrollArea: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: 16,
  },
  stickyFooter: {
    flexDirection: "row",
    gap: 12,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: Colors.borderLight,
    backgroundColor: Colors.surface,
  },
  title: { fontFamily: FONT, fontWeight: "bold", fontSize: 16, color: Colors.text, letterSpacing: 0.4 },
  sub: { fontFamily: FONT, fontSize: 12, color: Colors.textSecondary, marginTop: 4 },
  loadingBlock: { paddingVertical: 24, alignItems: "center", gap: 8 },
  loadingText: { fontFamily: FONT, color: Colors.textSecondary, fontSize: 13 },
  warnBox: {
    // Semi-transparent amber tint — readable on both light + dark surfaces.
    backgroundColor: "rgba(245, 158, 11, 0.15)",
    borderRadius: 8,
    borderLeftWidth: 3,
    borderLeftColor: "#F59E0B",
    padding: 10,
    marginTop: 12,
  },
  warnText: { fontFamily: FONT, color: "#F59E0B", fontSize: 12, lineHeight: 17, fontWeight: "600" },
  card: {
    backgroundColor: Colors.pillBg,
    borderRadius: 10,
    padding: 12,
    marginTop: 12,
    gap: 6,
  },
  heroPriceBlock: {
    // Tinted primary block that adapts to both themes (uses the primary
    // hue at low alpha rather than a hardcoded pastel).
    backgroundColor: "rgba(26,77,255,0.10)",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "rgba(26,77,255,0.30)",
    padding: 16,
    marginTop: 14,
    alignItems: "center",
  },
  heroPriceLabel: {
    fontFamily: FONT,
    fontSize: 10,
    color: Colors.textSecondary,
    fontWeight: "bold",
    letterSpacing: 1.4,
    marginBottom: 4,
  },
  heroPriceValue: {
    fontFamily: FONT,
    fontSize: 28,
    color: Colors.primary,
    fontWeight: "900",
    letterSpacing: 0.4,
  },
  heroPriceSub: {
    fontFamily: FONT,
    fontSize: 11,
    color: Colors.textSecondary,
    marginTop: 6,
  },
  heroPriceCtx: {
    fontFamily: FONT,
    fontSize: 11,
    color: Colors.textSecondary,
    marginTop: 4,
  },
  cardLabel: {
    fontFamily: FONT,
    fontSize: 10,
    color: Colors.textSecondary,
    fontWeight: "bold",
    letterSpacing: 1,
    marginBottom: 2,
  },
  protectHint: {
    fontFamily: FONT,
    fontSize: 11,
    color: Colors.textMuted,
    fontStyle: "italic",
    marginTop: 4,
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
