/**
 * Static underlying universe — indices, MCX commodities, NSE F&O stocks.
 * Updated by shipping new app versions; ScalpX does not auto-sync this.
 */
import rawUnderlyings from "../../assets/underlyings.json";

export type Underlying = {
  symbol: string;
  name: string;
  type: "INDEX" | "STOCK" | "COMMODITY";
  exchange: "NSE" | "BSE" | "MCX";
};

type Raw = { version: string; items: Underlying[] };

const data = rawUnderlyings as Raw;

export const UNDERLYINGS_VERSION = data.version;
export const ALL_UNDERLYINGS: readonly Underlying[] = data.items;

export function searchUnderlyings(query: string, limit = 300): Underlying[] {
  const q = (query || "").trim().toUpperCase();
  if (!q) return ALL_UNDERLYINGS.slice(0, limit);
  const out: Underlying[] = [];
  for (const u of ALL_UNDERLYINGS) {
    if (u.symbol.toUpperCase().includes(q) || u.name.toUpperCase().includes(q)) {
      out.push(u);
      if (out.length >= limit) break;
    }
  }
  return out;
}

export function lookupUnderlying(symbol: string): Underlying | undefined {
  if (!symbol) return undefined;
  const u = symbol.toUpperCase();
  return ALL_UNDERLYINGS.find((x) => x.symbol.toUpperCase() === u);
}
