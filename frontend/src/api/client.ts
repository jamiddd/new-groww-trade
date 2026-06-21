/**
 * Shared API client and types.
 */
import { storage } from "@/src/utils/storage";

const BASE = process.env.EXPO_PUBLIC_BACKEND_URL ?? "";

export type Preset = {
  key: string;
  label: string;
  strike_selection: "ATM" | "OTM1" | "OTM2" | "ITM1" | "HIGH_GAMMA" | string;
  iv_filter: "LOW_IV" | "HIGH_IV" | "ANY" | string;
  position_sizing_pct: number;
  stop_loss_pct: number;
  take_profit_pct: number;
  order_type: "MARKET" | "LIMIT" | string;
  limit_offset_pct: number;
};

export type AppSettings = {
  confirm_before_order: boolean;
  ask_max_loss_at_startup: boolean;
  convert_to_usd: boolean;
  save_last_underlying: boolean;
  last_underlying?: string | null;
  last_underlying_expiry?: string | null;
};

const TOKEN_KEY = "groww_access_token";

export async function getToken(): Promise<string | null> {
  return storage.secureGet<string>(TOKEN_KEY, "" as string).then((v) => v || null);
}

export async function setToken(token: string): Promise<void> {
  await storage.secureSet(TOKEN_KEY, token);
}

export async function clearToken(): Promise<void> {
  await storage.secureRemove(TOKEN_KEY);
}

async function req<T = any>(path: string, opts: RequestInit & { auth?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    ...(opts.headers as Record<string, string> | undefined),
  };
  if (opts.auth !== false) {
    const tok = await getToken();
    if (tok) headers["X-Groww-Token"] = tok;
  }
  const res = await fetch(`${BASE}/api${path}`, { ...opts, headers });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    // Some ingress layers (Cloudflare) rewrite upstream 502 bodies into HTML.
    let detail: string;
    if (body && typeof body === "object") {
      detail = body.detail || body.message || JSON.stringify(body);
    } else if (typeof body === "string" && /^\s*</.test(body)) {
      detail = res.status === 502 ? "Upstream Groww request failed. Please re-login." : `HTTP ${res.status}`;
    } else {
      detail = (body as string) || `HTTP ${res.status}`;
    }
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  return body as T;
}

export const api = {
  health: () => req("/", { method: "GET", auth: false }),
  login: (api_key: string, api_secret: string) =>
    req<{ access_token: string }>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ api_key, api_secret }),
      auth: false,
    }),
  verify: () => req("/auth/verify"),
  margin: () => req<any>("/account/margin"),
  positions: () => req<any>("/account/positions"),
  orders: () => req<any>("/account/orders"),
  underlyings: (q: string = "") => req<{ items: { symbol: string; name: string; type: string }[] }>(`/instruments/underlyings?q=${encodeURIComponent(q)}`),
  expiries: (underlying: string, exchange: string = "NSE") =>
    req<any>(`/instruments/expiries?underlying=${encodeURIComponent(underlying)}&exchange=${exchange}`),
  optionChain: (underlying: string, expiry: string, option_type: "CE" | "PE", exchange: string = "NSE") =>
    req<any>(`/instruments/option-chain?underlying=${encodeURIComponent(underlying)}&expiry=${expiry}&option_type=${option_type}&exchange=${exchange}`),
  placePreset: (payload: { preset_key: string; underlying: string; expiry: string; option_type: "CE" | "PE"; capital: number; exchange?: string; dry_run?: boolean }) =>
    req<any>("/orders/place-preset", { method: "POST", body: JSON.stringify({ exchange: "NSE", ...payload }) }),
  exit: (percent: 25 | 50 | 100) =>
    req<any>("/orders/exit", { method: "POST", body: JSON.stringify({ percent }) }),
  presets: () => req<{ items: Preset[] }>("/presets"),
  getPreset: (key: string) => req<Preset>(`/presets/${key}`),
  updatePreset: (key: string, body: Preset) =>
    req<Preset>(`/presets/${key}`, { method: "PUT", body: JSON.stringify(body) }),
  settings: () => req<AppSettings>("/settings"),
  updateSettings: (body: AppSettings) =>
    req<AppSettings>("/settings", { method: "PUT", body: JSON.stringify(body) }),
  fxInrUsd: () => req<{ rate: number }>("/fx/inr-to-usd", { auth: false }),
};
