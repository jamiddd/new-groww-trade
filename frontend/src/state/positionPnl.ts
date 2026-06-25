/**
 * Client-side P&L computation — derives the position's live P&L from the
 * cached `average_price` + the live LTP we get from /api/ltp/batch.
 *
 * NOTE: this number is INDICATIVE only. Groww's realized P&L will differ
 * by brokerage + STT + exchange charges. The exit response from Groww is
 * the source of truth for the final number.
 */

export type RawPosition = {
  trading_symbol?: string;
  exchange?: string;
  segment?: string;
  net_quantity?: number;
  quantity?: number;
  average_price?: number;
  avg_price?: number;
  last_price?: number;
  ltp?: number;
  pnl?: number;
  [k: string]: unknown;
};

export type LivePosition = RawPosition & {
  live_ltp: number;
  live_pnl: number;
  live_pnl_pct: number;
  net_quantity: number;
  average_price: number;
};

function num(x: unknown): number {
  const n = typeof x === "string" ? parseFloat(x) : (x as number);
  return Number.isFinite(n) ? n : 0;
}

export function applyLivePnl(
  positions: RawPosition[],
  ltps: Record<string, number>,
): LivePosition[] {
  return positions.map((p) => {
    const sym = (p.trading_symbol as string) || "";
    const qty = num(p.net_quantity ?? p.quantity);
    const avg = num(p.average_price ?? p.avg_price);
    const fallbackLtp = num(p.last_price ?? p.ltp);
    const live = ltps[sym] && ltps[sym] > 0 ? ltps[sym] : fallbackLtp;
    const pnl = qty !== 0 && live > 0 ? (live - avg) * qty : num(p.pnl);
    const pnlPct = avg > 0 && qty !== 0 ? ((live - avg) / avg) * 100 * Math.sign(qty) : 0;
    return {
      ...p,
      net_quantity: qty,
      average_price: avg,
      live_ltp: live,
      live_pnl: pnl,
      live_pnl_pct: pnlPct,
    };
  });
}

/** Sum of live_pnl across all open positions. */
export function totalLivePnl(positions: LivePosition[]): number {
  return positions.reduce((acc, p) => acc + (p.live_pnl || 0), 0);
}
