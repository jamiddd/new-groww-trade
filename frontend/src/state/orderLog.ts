/**
 * Local order log — persists the user's order history in AsyncStorage so the
 * Order History screen renders instantly. Bootstrap merges the server-side
 * snapshot in; subsequent buys/sells append locally so a refresh-storm
 * isn't needed.
 *
 * Retention: 30 days of orders by default.
 */
import { loadJSON, saveJSON, STORAGE_KEYS } from "@/src/utils/localStore";

export type LocalOrder = {
  order_id?: string;
  groww_order_id?: string;
  id?: string;
  trading_symbol?: string;
  transaction_type?: string;
  order_status?: string;
  order_type?: string;
  quantity?: number;
  filled_quantity?: number;
  average_price?: number;
  price?: number;
  exchange?: string;
  segment?: string;
  exchange_time?: string;
  created_at?: string;
  // Allow arbitrary extra fields from Groww — the UI doesn't rely on a tight schema.
  [k: string]: unknown;
};

const RETENTION_DAYS = 30;

function orderId(o: LocalOrder): string | undefined {
  return (o.groww_order_id as string) || (o.order_id as string) || (o.id as string);
}

function orderTimestamp(o: LocalOrder): number {
  const raw = (o.exchange_time as string) || (o.created_at as string) || "";
  if (!raw) return 0;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : 0;
}

function prune(orders: LocalOrder[]): LocalOrder[] {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  return orders.filter((o) => {
    const ts = orderTimestamp(o);
    return ts === 0 || ts >= cutoff;
  });
}

export async function loadOrders(): Promise<LocalOrder[]> {
  return loadJSON<LocalOrder[]>(STORAGE_KEYS.orders, []);
}

export async function saveOrders(orders: LocalOrder[]): Promise<void> {
  await saveJSON(STORAGE_KEYS.orders, prune(orders));
}

/**
 * Merge a fresh server batch into the local log. Dedupes by canonical id;
 * sorts newest-first.
 */
export async function mergeOrders(serverOrders: LocalOrder[]): Promise<LocalOrder[]> {
  const existing = await loadOrders();
  const byId = new Map<string, LocalOrder>();
  for (const o of existing) {
    const id = orderId(o);
    if (id) byId.set(id, o);
  }
  for (const o of serverOrders) {
    const id = orderId(o);
    if (id) byId.set(id, { ...byId.get(id), ...o });
    else byId.set(`anon-${Math.random()}`, o);
  }
  const merged = Array.from(byId.values()).sort(
    (a, b) => orderTimestamp(b) - orderTimestamp(a),
  );
  await saveOrders(merged);
  return merged.slice(0, 500);
}

export async function appendLocalOrder(order: LocalOrder): Promise<void> {
  const list = await loadOrders();
  list.unshift(order);
  await saveOrders(list);
}

export function newestOrderId(orders: LocalOrder[]): string | undefined {
  return orders.length > 0 ? orderId(orders[0]) : undefined;
}
