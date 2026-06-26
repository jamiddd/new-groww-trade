/**
 * Local underlying + expiry catalog.
 *
 * Hydrated ONCE right after login from /api/instruments/catalog and
 * persisted to AsyncStorage. Every browse flow (underlying picker, expiry
 * sheet) reads from this cache thereafter — no Groww round-trips.
 *
 * Refresh policy:
 *   • First login (no cache)        → full-screen blocking hydrate.
 *   • Same-day re-launch           → use cache, no network.
 *   • Calendar day change          → background re-hydrate, inline banner.
 *   • Manual Settings "Refresh"    → force re-hydrate, full-screen.
 *
 * Schema mirrors the backend response exactly (see /instruments/catalog).
 */
import { api } from "@/src/api/client";
import { loadJSON, saveJSON } from "@/src/utils/localStore";

export type UnderlyingObject = {
  id: string;
  displayName: string;
  shortName: string;
  ticker: string;
  exchange: "NSE" | "BSE" | "MCX";
  type: "INDEX" | "STOCK" | "COMMODITY";
  lotSize: number | null;
  tickSize: number | null;
};

export type ExpiryObject = {
  underlyingObjectId: string;
  date: string;
  lotSize: number | null;
  tickSize: number | null;
};

export type Catalog = {
  version: string;
  underlyings: UnderlyingObject[];
  expiries: ExpiryObject[];
  syncedAt: number; // epoch ms
};

const KEY = "scalpx.catalog.v1";

// In-memory mirror so selectors don't hit AsyncStorage on every keystroke.
let _mem: Catalog | null = null;
let _expiriesByUnderlying = new Map<string, ExpiryObject[]>();
let _underlyingById = new Map<string, UnderlyingObject>();

function rebuildIndexes(cat: Catalog) {
  _expiriesByUnderlying = new Map();
  for (const e of cat.expiries) {
    const arr = _expiriesByUnderlying.get(e.underlyingObjectId) ?? [];
    arr.push(e);
    _expiriesByUnderlying.set(e.underlyingObjectId, arr);
  }
  // Sort by date ascending so selectExpiries returns nearest first.
  for (const arr of _expiriesByUnderlying.values()) {
    arr.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }
  _underlyingById = new Map(cat.underlyings.map((u) => [u.id, u]));
}

/** True if the in-memory catalog is loaded. */
export function isLoaded(): boolean {
  return _mem !== null;
}

/** Snapshot getter (for diagnostics / settings display). */
export function getCatalog(): Catalog | null {
  return _mem;
}

export async function loadFromDisk(): Promise<Catalog | null> {
  const cached = await loadJSON<Catalog | null>(KEY, null);
  if (cached && cached.underlyings && cached.expiries) {
    _mem = cached;
    rebuildIndexes(cached);
    return cached;
  }
  return null;
}

export async function hydrateFromServer(): Promise<Catalog> {
  const resp = await api.catalog();
  const cat: Catalog = {
    version: resp.version,
    underlyings: resp.underlyings as UnderlyingObject[],
    expiries: resp.expiries as ExpiryObject[],
    syncedAt: Date.now(),
  };
  _mem = cat;
  rebuildIndexes(cat);
  await saveJSON(KEY, cat);
  return cat;
}

/** Returns true if cache exists and was synced within the same calendar
 * day (local time). Used to decide whether to re-hydrate. */
export function isFreshToday(): boolean {
  if (!_mem) return false;
  const d = new Date(_mem.syncedAt);
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

// Selectors -----------------------------------------------------------

export function selectUnderlyings(query: string, limit = 300): UnderlyingObject[] {
  if (!_mem) return [];
  const q = (query || "").trim().toUpperCase();
  if (!q) return _mem.underlyings.slice(0, limit);
  const out: UnderlyingObject[] = [];
  for (const u of _mem.underlyings) {
    if (
      u.ticker.toUpperCase().includes(q) ||
      u.displayName.toUpperCase().includes(q)
    ) {
      out.push(u);
      if (out.length >= limit) break;
    }
  }
  return out;
}

export function selectExpiries(underlyingId: string): ExpiryObject[] {
  return _expiriesByUnderlying.get(underlyingId) ?? [];
}

export function lookupUnderlyingById(id: string): UnderlyingObject | undefined {
  return _underlyingById.get(id);
}

/** Find by raw ticker (case-insensitive). Useful when migrating legacy
 * state that only carries the ticker string. */
export function lookupUnderlyingByTicker(ticker: string): UnderlyingObject | undefined {
  if (!_mem || !ticker) return undefined;
  const t = ticker.toUpperCase();
  return _mem.underlyings.find((u) => u.ticker.toUpperCase() === t);
}

/** Lot size for a given underlying ticker (falls back to fallback). */
export function lotSizeFor(ticker: string, fallback = 1): number {
  const u = lookupUnderlyingByTicker(ticker);
  return u?.lotSize && u.lotSize > 0 ? u.lotSize : fallback;
}

/** Tick size for a given underlying ticker (falls back to 0.05). */
export function tickSizeFor(ticker: string, fallback = 0.05): number {
  const u = lookupUnderlyingByTicker(ticker);
  return u?.tickSize && u.tickSize > 0 ? u.tickSize : fallback;
}
