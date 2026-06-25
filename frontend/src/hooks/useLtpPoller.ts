/**
 * Real-time LTP poller.
 *
 * Polls /api/ltp/batch every `intervalMs` (default 1000) for the supplied
 * trading symbols and exposes the current ltp map + simple per-symbol
 * derived helpers.
 *
 * Usage:
 *   const { ltps, isPolling } = useLtpPoller(symbols, { intervalMs: 1000 });
 *
 * Stops cleanly when `symbols` becomes empty or the component unmounts.
 * Auto-throttles to 2 s if there are >5 symbols, to stay under Groww's ~3 req/s.
 */
import { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";

import { api } from "@/src/api/client";

export type LtpQuery = {
  trading_symbol: string;
  exchange: string;
  segment?: string;
};

export type UseLtpPollerOptions = {
  /** Base polling interval in ms (default 1000). */
  intervalMs?: number;
  /** Disable polling without unmounting (default false). */
  paused?: boolean;
};

export function useLtpPoller(symbols: LtpQuery[], opts: UseLtpPollerOptions = {}) {
  const intervalMs = opts.intervalMs ?? 1000;
  const paused = opts.paused ?? false;

  const [ltps, setLtps] = useState<Record<string, number>>({});
  const [isPolling, setIsPolling] = useState(false);

  // Hold the latest symbols in a ref so the poller picks up changes without
  // tearing down the interval.
  const symbolsRef = useRef(symbols);
  symbolsRef.current = symbols;

  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  useEffect(() => {
    let cancelled = false;
    let inflight = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let appStateSub: { remove: () => void } | null = null;
    let appActive = AppState.currentState === "active";

    const tick = async () => {
      if (cancelled) return;
      const list = symbolsRef.current;
      if (!list || list.length === 0 || pausedRef.current || !appActive) {
        setIsPolling(false);
        timer = setTimeout(tick, intervalMs);
        return;
      }
      if (inflight) {
        timer = setTimeout(tick, intervalMs);
        return;
      }
      inflight = true;
      setIsPolling(true);
      // Auto-throttle when fetching many symbols.
      const effectiveInterval = list.length > 5 ? Math.max(intervalMs, 2000) : intervalMs;
      try {
        const resp = await api.ltpBatch(list);
        if (!cancelled && resp?.ltps) {
          setLtps((prev) => {
            // Merge so old prices stay visible until the next tick replaces them.
            const next = { ...prev };
            for (const [k, v] of Object.entries(resp.ltps)) {
              if (typeof v === "number" && v > 0) next[k] = v;
            }
            return next;
          });
        }
      } catch {
        // swallow — next tick retries.
      } finally {
        inflight = false;
        if (!cancelled) timer = setTimeout(tick, effectiveInterval);
      }
    };

    appStateSub = AppState.addEventListener("change", (state) => {
      appActive = state === "active";
    });

    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      if (appStateSub) appStateSub.remove();
      setIsPolling(false);
    };
  }, [intervalMs]);

  return { ltps, isPolling };
}

/**
 * Convenience hook for a single symbol — used by the order confirm dialog
 * to keep the displayed LTP live.
 */
export function useSingleLtp(symbol: LtpQuery | null, intervalMs = 1000) {
  const list = symbol ? [symbol] : [];
  const { ltps, isPolling } = useLtpPoller(list, { intervalMs });
  const ltp = symbol ? ltps[symbol.trading_symbol] ?? 0 : 0;
  return { ltp, isPolling };
}
