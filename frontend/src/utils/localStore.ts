/**
 * JSON-object persistence wrapper around AsyncStorage.
 *
 * The default `storage` helper only supports primitives (string|number|boolean)
 * — use this for arrays/dicts (orders, positions, bootstrap snapshot).
 */
import AsyncStorage from "@react-native-async-storage/async-storage";

export async function loadJSON<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = await AsyncStorage.getItem(key);
    if (raw == null) return fallback;
    return JSON.parse(raw) as T;
  } catch (e) {
    console.warn(`[localStore] loadJSON(${key}) failed`, e);
    return fallback;
  }
}

export async function saveJSON<T>(key: string, value: T): Promise<void> {
  try {
    await AsyncStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    console.warn(`[localStore] saveJSON(${key}) failed`, e);
  }
}

export async function removeJSON(key: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(key);
  } catch (e) {
    console.warn(`[localStore] removeJSON(${key}) failed`, e);
  }
}

// Storage keys — keep all of them here so we can sweep on logout / version bumps.
export const STORAGE_KEYS = {
  bootstrap: "scalpx.bootstrap.v1",
  orders: "scalpx.orders.v1",
  positions: "scalpx.positions.v1",
  margin: "scalpx.margin.v1",
  smartOrders: "scalpx.smart_orders.v1",
} as const;

/** Wipe all client-side cached trading data — called on logout. */
export async function clearLocalCache(): Promise<void> {
  await Promise.all(Object.values(STORAGE_KEYS).map((k) => removeJSON(k)));
}
