/**
 * Client-side expiry computation.
 *
 * Following the SEBI rationalisation (Nov 2024 onwards):
 *   - One weekly per exchange: NIFTY (Tuesday) on NSE, SENSEX (Thursday) on BSE.
 *   - All other indices (BANKNIFTY, FINNIFTY, MIDCPNIFTY, BANKEX) and all F&O
 *     stocks are monthly-only.
 *   - F&O stocks + NSE monthly indices expire on the last Thursday.
 *   - BSE monthly indices (SENSEX/BANKEX) expire on the last Tuesday.
 *   - MCX commodities expire on a contract-specific calendar day.
 *
 * This used to hit /api/instruments/expiries — moved client-side so the
 * underlying-search → buy-flow is instant.
 */

const MCX_MONTH_DAY: Record<string, number> = {
  GOLD: 5, GOLDM: 5, GOLDGUINEA: 5, GOLDPETAL: 5,
  SILVER: 5, SILVERM: 28, SILVERMIC: 28,
  CRUDEOIL: 18, CRUDEOILM: 18,
  NATURALGAS: 25, NATGASMINI: 25,
  COPPER: 28, ZINC: 28, LEAD: 28,
  NICKEL: 28, ALUMINIUM: 28,
  COTTON: 28, MENTHAOIL: 28, CARDAMOM: 28,
};

function toIso(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function startOfTodayUTC(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function lastDayOfMonth(year: number, month0: number): number {
  // month0 is 0-indexed; create Date(year, month0+1, 0) → last day of month0.
  return new Date(year, month0 + 1, 0).getDate();
}

export function computeExpiries(underlying: string): string[] {
  const u = (underlying || "").toUpperCase();
  const today = startOfTodayUTC();
  const out = new Set<string>();

  // Weekly block — only NIFTY + SENSEX have weeklies.
  let weeklyWeekday: number | null = null;
  if (u === "NIFTY") weeklyWeekday = 2;       // 0=Sun ... 2=Tue
  else if (u === "SENSEX") weeklyWeekday = 4; // 4=Thu

  if (weeklyWeekday !== null) {
    const todayDow = today.getUTCDay();
    const daysAhead = (weeklyWeekday - todayDow + 7) % 7;
    for (let w = 0; w < 8; w++) {
      const d = new Date(today.getTime());
      d.setUTCDate(today.getUTCDate() + daysAhead + 7 * w);
      out.add(toIso(d));
    }
  }

  // Monthly block.
  const monthlyWeekday = u === "SENSEX" || u === "BANKEX" ? 2 : 4; // last Tue (BSE) else last Thu
  const baseY = today.getUTCFullYear();
  const baseM = today.getUTCMonth(); // 0-indexed

  for (let m = 0; m < 6; m++) {
    const year = baseY + Math.floor((baseM + m) / 12);
    const month0 = (baseM + m) % 12;
    const last = lastDayOfMonth(year, month0);

    let d: Date;
    if (u in MCX_MONTH_DAY) {
      const day = Math.min(MCX_MONTH_DAY[u], last);
      d = new Date(Date.UTC(year, month0, day));
    } else {
      d = new Date(Date.UTC(year, month0, last));
      while (d.getUTCDay() !== monthlyWeekday) {
        d.setUTCDate(d.getUTCDate() - 1);
      }
    }
    if (d.getTime() >= today.getTime()) {
      out.add(toIso(d));
    }
  }

  return Array.from(out).sort();
}

/** Return the nearest (earliest) future expiry, or undefined if none. */
export function nearestExpiry(underlying: string): string | undefined {
  const all = computeExpiries(underlying);
  return all[0];
}
