"""Iteration 24 backend tests — burst coalescing + cache invalidation.

Covers:
- Burst coalescing on /api/account/margin (8 concurrent demo requests → identical 200s)
- _cached_response single-flight semantics (producer fires once under N concurrent callers)
- _invalidate_response_cache drops entries by (kind, token)
- Endpoint smoke regression: margin, positions, smart-orders, orders, option-chain, expiries, underlyings, place-preset(dry_run)
"""

import asyncio
import os
import sys
import time
from typing import Any, Dict

import httpx
import pytest
import requests

BASE_URL = "http://localhost:8001"
DEMO_TOKEN = "DEMO__SCALPX__TOKEN"
HEADERS = {"X-Groww-Token": DEMO_TOKEN, "Content-Type": "application/json"}

# Allow importing server module for direct helper tests
sys.path.insert(0, "/app/backend")


@pytest.fixture
def api():
    s = requests.Session()
    s.headers.update(HEADERS)
    return s


# ----- Burst coalescing on /account/margin -----
class TestMarginBurstCoalescing:
    """Fire 8 concurrent GETs within ~100ms; all should return 200 with
    coherent bodies. Demo path bypasses the cache (per the design note), but
    the endpoint must remain stable under burst load."""

    @pytest.mark.asyncio
    async def test_eight_concurrent_margin_requests_all_200(self):
        async with httpx.AsyncClient(base_url=BASE_URL, headers=HEADERS, timeout=10.0) as client:
            t0 = time.time()
            results = await asyncio.gather(
                *(client.get("/api/account/margin") for _ in range(8))
            )
            dt = time.time() - t0
        codes = [r.status_code for r in results]
        assert all(c == 200 for c in codes), f"Non-200 in burst: {codes}"
        # All bodies should be JSON dicts with the canonical margin fields.
        bodies = [r.json() for r in results]
        for b in bodies:
            assert isinstance(b, dict)
            # Demo payload exposes available_margin/used_margin/opening_capital_today.
            assert "available_margin" in b or "total_balance" in b, f"Missing margin fields: {list(b)[:10]}"
        # All 8 should complete well under a wall-clock budget.
        assert dt < 5.0, f"8-way burst took {dt:.2f}s, exceeds 5s budget"

    @pytest.mark.asyncio
    async def test_burst_bodies_consistent(self):
        """Demo margin is randomized intra-day but `opening_capital_today`
        should be identical for the same token within a single burst — it's
        seeded deterministically per-token in _demo_margin_base()."""
        async with httpx.AsyncClient(base_url=BASE_URL, headers=HEADERS, timeout=10.0) as client:
            results = await asyncio.gather(
                *(client.get("/api/account/margin") for _ in range(8))
            )
        opens = [r.json().get("opening_capital_today") for r in results]
        assert len(set(opens)) == 1, f"opening_capital_today varies across burst: {opens}"


# ----- Direct unit tests against _cached_response / _invalidate_response_cache -----
class TestCachedResponseHelper:
    """Drive the helpers directly without going through the HTTP layer so we
    can exercise the live-mode coalescing path (which is otherwise unreachable
    from this pod — Groww live calls are mocked/unavailable)."""

    @pytest.mark.asyncio
    async def test_single_flight_under_five_concurrent_callers(self):
        import server  # type: ignore

        # Use a unique key so we don't collide with live caches.
        key = ("test_kind", "TEST_TOKEN_singleflight")
        server._RESPONSE_CACHE.pop(key, None)
        server._RESPONSE_LOCKS.pop(key, None)

        call_count = {"n": 0}

        async def producer():
            call_count["n"] += 1
            # Simulate a slow upstream call so concurrent callers actually race.
            await asyncio.sleep(0.2)
            return {"value": call_count["n"], "ts": time.time()}

        results = await asyncio.gather(
            *(server._cached_response(key, 1.5, producer) for _ in range(5))
        )
        assert call_count["n"] == 1, f"Producer fired {call_count['n']} times under 5 concurrent callers; expected 1"
        # All callers must receive the SAME object (same value field).
        values = {r["value"] for r in results}
        assert values == {1}, f"Inconsistent results across coalesced callers: {values}"

        # Cleanup
        server._RESPONSE_CACHE.pop(key, None)
        server._RESPONSE_LOCKS.pop(key, None)

    @pytest.mark.asyncio
    async def test_ttl_expiry_triggers_new_producer_call(self):
        import server  # type: ignore

        key = ("test_kind", "TEST_TOKEN_ttl")
        server._RESPONSE_CACHE.pop(key, None)
        server._RESPONSE_LOCKS.pop(key, None)

        n = {"v": 0}

        async def producer():
            n["v"] += 1
            return {"v": n["v"]}

        r1 = await server._cached_response(key, 0.1, producer)
        # Within TTL → cached
        r2 = await server._cached_response(key, 0.1, producer)
        assert r1 == r2
        assert n["v"] == 1
        await asyncio.sleep(0.15)
        # After TTL → producer re-fires
        r3 = await server._cached_response(key, 0.1, producer)
        assert n["v"] == 2
        assert r3["v"] == 2

        server._RESPONSE_CACHE.pop(key, None)
        server._RESPONSE_LOCKS.pop(key, None)

    def test_invalidate_drops_keyed_entries(self):
        import server  # type: ignore

        tok = "TEST_TOKEN_invalidate"
        server._RESPONSE_CACHE[("margin", tok)] = {"ts": time.time(), "data": {"x": 1}}
        server._RESPONSE_CACHE[("positions", tok)] = {"ts": time.time(), "data": {"y": 2}}
        server._RESPONSE_CACHE[("smart_orders", tok)] = {"ts": time.time(), "data": {"z": 3}}
        # Different token must not be affected
        server._RESPONSE_CACHE[("margin", "OTHER_TOKEN")] = {"ts": time.time(), "data": {"x": 99}}

        server._invalidate_response_cache(tok, "margin")
        assert ("margin", tok) not in server._RESPONSE_CACHE
        assert ("positions", tok) in server._RESPONSE_CACHE
        assert ("smart_orders", tok) in server._RESPONSE_CACHE
        assert ("margin", "OTHER_TOKEN") in server._RESPONSE_CACHE

        # Drop multiple kinds in one call
        server._invalidate_response_cache(tok, "positions", "smart_orders")
        assert ("positions", tok) not in server._RESPONSE_CACHE
        assert ("smart_orders", tok) not in server._RESPONSE_CACHE
        assert ("margin", "OTHER_TOKEN") in server._RESPONSE_CACHE

        # Cleanup
        server._RESPONSE_CACHE.pop(("margin", "OTHER_TOKEN"), None)

    def test_invalidate_missing_key_is_noop(self):
        """No KeyError when a token has nothing cached."""
        import server  # type: ignore

        # Should not raise
        server._invalidate_response_cache("TEST_TOKEN_never_cached", "margin", "positions")


# ----- Cache invalidation through the HTTP layer (demo) -----
class TestRefreshCapitalDemo:
    def test_refresh_capital_demo_returns_ok(self, api):
        r = api.post(f"{BASE_URL}/api/account/refresh-capital")
        # Demo short-circuits before invalidation but endpoint must return 200/2xx.
        assert r.status_code in (200, 202), r.text
        body = r.json()
        # Demo response shape: {ok: True, demo: True} per request spec.
        assert body.get("ok") is True or body.get("demo") is True or "demo" in body, body


# ----- Endpoint smoke regression -----
class TestEndpointSmoke:
    def test_margin(self, api):
        r = api.get(f"{BASE_URL}/api/account/margin")
        assert r.status_code == 200
        b = r.json()
        assert isinstance(b, dict)
        assert "available_margin" in b or "total_balance" in b

    def test_positions(self, api):
        r = api.get(f"{BASE_URL}/api/account/positions")
        assert r.status_code == 200
        b = r.json()
        # Demo positions: list or dict with `items`
        assert isinstance(b, (list, dict))

    def test_smart_orders(self, api):
        r = api.get(f"{BASE_URL}/api/orders/smart-orders")
        assert r.status_code == 200

    def test_orders(self, api):
        r = api.get(f"{BASE_URL}/api/account/orders")
        assert r.status_code == 200

    def test_option_chain(self, api):
        r = api.get(
            f"{BASE_URL}/api/instruments/option-chain",
            params={"underlying": "NIFTY", "expiry": "2026-06-25", "exchange": "NSE", "option_type": "CE"},
        )
        assert r.status_code == 200, r.text
        b = r.json()
        # Chain should be a dict containing rows/strikes
        assert isinstance(b, dict)

    def test_expiries(self, api):
        r = api.get(
            f"{BASE_URL}/api/instruments/expiries",
            params={"underlying": "NIFTY", "exchange": "NSE"},
        )
        assert r.status_code == 200

    def test_underlyings(self, api):
        r = api.get(f"{BASE_URL}/api/instruments/underlyings", params={"q": "NIF"})
        assert r.status_code == 200
        b = r.json()
        assert "items" in b

    def test_place_preset_dry_run(self, api):
        r = api.post(
            f"{BASE_URL}/api/orders/place-preset",
            json={
                "preset_key": "steady_mkt",
                "underlying": "NIFTY",
                "exchange": "NSE",
                "option_type": "CE",
                "expiry": "2099-01-30",
                "capital": 100000,
                "dry_run": True,
            },
        )
        assert r.status_code == 200, r.text
        b = r.json()
        assert isinstance(b, dict)
        assert b.get("dry_run") is True
