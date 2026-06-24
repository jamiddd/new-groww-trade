"""Iteration 22 backend perf/caching tests.

Covers:
- /instruments/underlyings demo search latency + content
- /instruments/expiries demo list (sorted, future-dated)
- /account/orders demo (no 5xx, list shape)
- /orders/place-preset dry_run demo (steady_mkt)
- /instruments/option-chain burst of 5 concurrent requests in demo
- Regression: /auth/server-ip, /account/margin, /account/positions
"""

import asyncio
import os
import time
from datetime import datetime, timezone

import httpx
import pytest
import requests

BASE_URL = "http://localhost:8001"
DEMO_TOKEN = "DEMO__SCALPX__TOKEN"
HEADERS = {"X-Groww-Token": DEMO_TOKEN, "Content-Type": "application/json"}


@pytest.fixture
def api():
    s = requests.Session()
    s.headers.update(HEADERS)
    return s


# ----- /instruments/underlyings -----
class TestUnderlyings:
    def test_underlyings_demo_nif_search_fast_and_correct(self, api):
        t0 = time.time()
        r = api.get(f"{BASE_URL}/api/instruments/underlyings", params={"q": "NIF"})
        dt = time.time() - t0
        assert r.status_code == 200, r.text
        assert dt < 1.5, f"Latency {dt:.3f}s exceeds 1.5s budget"
        data = r.json()
        assert "items" in data and isinstance(data["items"], list)
        syms = {i["symbol"]: i for i in data["items"]}
        for expected in ("NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY"):
            assert expected in syms, f"missing {expected} in {list(syms)[:20]}"
            assert syms[expected]["exchange"] == "NSE"

    def test_underlyings_demo_sensex_exchange_bse(self, api):
        # SENSEX won't match q=NIF, so query empty/no-q to see full set
        r = api.get(f"{BASE_URL}/api/instruments/underlyings", params={"q": "SEN"})
        assert r.status_code == 200
        items = {i["symbol"]: i for i in r.json()["items"]}
        if "SENSEX" in items:
            assert items["SENSEX"]["exchange"] == "BSE", (
                f"SENSEX exchange should be BSE, got {items['SENSEX']}"
            )


# ----- /instruments/expiries -----
class TestExpiries:
    def test_expiries_demo_nifty_sorted_future(self, api):
        r = api.get(
            f"{BASE_URL}/api/instruments/expiries",
            params={"underlying": "NIFTY", "exchange": "NSE"},
        )
        assert r.status_code == 200, r.text
        data = r.json()
        assert "expiries" in data and isinstance(data["expiries"], list)
        expiries = data["expiries"]
        assert len(expiries) > 0, "no expiries returned in demo"
        today = datetime.now(timezone.utc).date().isoformat()
        # All future-dated
        for e in expiries:
            assert e >= today, f"expiry {e} is in the past (today={today})"
        # Sorted ascending
        assert expiries == sorted(expiries), "expiries not sorted ascending"


# ----- /account/orders -----
class TestAccountOrders:
    def test_orders_demo_200_with_orders_array(self, api):
        r = api.get(f"{BASE_URL}/api/account/orders")
        assert r.status_code == 200, f"got {r.status_code}: {r.text}"
        data = r.json()
        assert "orders" in data, f"missing orders key in {list(data)}"
        assert isinstance(data["orders"], list)


# ----- /orders/place-preset dry_run -----
class TestPlacePreset:
    def test_steady_mkt_dry_run_demo(self, api):
        payload = {
            "preset_key": "steady_mkt",
            "underlying": "NIFTY",
            "exchange": "NSE",
            "option_type": "CE",
            "expiry": "2099-01-30",  # placeholder; demo ignores it for picking
            "capital": 100000,
            "dry_run": True,
        }
        r = api.post(f"{BASE_URL}/api/orders/place-preset", json=payload)
        assert r.status_code == 200, f"got {r.status_code}: {r.text}"
        data = r.json()
        assert data.get("dry_run") is True
        assert "selected" in data and data["selected"].get("trading_symbol")
        assert data["selected"].get("strike") is not None
        assert data["selected"].get("ltp") is not None
        assert "quantity" in data
        assert "lots" in data
        assert "lot_size" in data
        assert "estimated_cost" in data
        assert "preset" in data


# ----- /instruments/option-chain content (iter23 regression fix) -----
class TestOptionChainDemoContent:
    def test_option_chain_demo_nifty_returns_synthetic_chain(self, api):
        r = api.get(
            f"{BASE_URL}/api/instruments/option-chain",
            params={
                "underlying": "NIFTY",
                "expiry": "2026-06-25",
                "exchange": "NSE",
                "option_type": "CE",
            },
        )
        assert r.status_code == 200, f"got {r.status_code}: {r.text[:300]}"
        data = r.json()
        # Top-level shape
        assert data.get("underlying") == "NIFTY"
        assert data.get("exchange") == "NSE"
        assert data.get("expiry") == "2026-06-25"
        # ATM should be 24700 per iter23 fix
        assert data.get("spot") == 24700, f"expected spot=24700, got {data.get('spot')}"
        chain = data.get("option_chain")
        assert isinstance(chain, list), f"option_chain not a list: {type(chain)}"
        # ≥10 strikes around ATM
        assert len(chain) >= 10, f"expected ≥10 strikes, got {len(chain)}"
        strikes = [row.get("strike") for row in chain]
        # Strikes should bracket ATM 24700 with step=50
        assert min(strikes) <= 24700 <= max(strikes), (
            f"ATM 24700 not within strike range [{min(strikes)}, {max(strikes)}]"
        )
        assert 24700 in strikes, f"ATM strike 24700 missing from {strikes}"
        # Each row has CE+PE legs with required fields
        required = ("trading_symbol", "ltp", "implied_volatility", "gamma")
        for row in chain:
            for side in ("ce", "pe"):
                leg = row.get(side)
                assert leg is not None, f"missing {side} on strike {row.get('strike')}"
                for f in required:
                    assert f in leg, (
                        f"strike {row.get('strike')} {side} missing field '{f}'; got {list(leg)}"
                    )
                assert isinstance(leg["ltp"], (int, float))
                assert isinstance(leg["gamma"], (int, float))
                assert isinstance(leg["implied_volatility"], (int, float))
                # trading_symbol should reference the strike
                assert str(row.get("strike")) in leg["trading_symbol"], (
                    f"trading_symbol {leg['trading_symbol']} does not contain strike {row.get('strike')}"
                )

    def test_option_chain_demo_banknifty_atm_51100(self, api):
        r = api.get(
            f"{BASE_URL}/api/instruments/option-chain",
            params={
                "underlying": "BANKNIFTY",
                "expiry": "2026-06-25",
                "exchange": "NSE",
                "option_type": "CE",
            },
        )
        assert r.status_code == 200, r.text[:300]
        data = r.json()
        assert data.get("spot") == 51100
        strikes = [row["strike"] for row in data["option_chain"]]
        assert 51100 in strikes
        # step=100 for banknifty
        assert sorted(strikes)[1] - sorted(strikes)[0] == 100


# ----- /instruments/option-chain burst -----
class TestOptionChainBurst:
    @pytest.mark.asyncio
    async def test_burst_5_concurrent_demo(self):
        # First fetch a demo expiry to use
        with requests.Session() as s:
            s.headers.update(HEADERS)
            er = s.get(
                f"{BASE_URL}/api/instruments/expiries",
                params={"underlying": "NIFTY", "exchange": "NSE"},
            )
            assert er.status_code == 200
            expiries = er.json()["expiries"]
            assert expiries
            expiry = expiries[0]

        async with httpx.AsyncClient(base_url=BASE_URL, timeout=15.0, headers=HEADERS) as c:
            async def _one():
                t0 = time.time()
                resp = await c.get(
                    "/api/instruments/option-chain",
                    params={
                        "underlying": "NIFTY",
                        "expiry": expiry,
                        "exchange": "NSE",
                        "option_type": "CE",
                    },
                )
                return resp.status_code, resp.text, time.time() - t0

            t0 = time.time()
            results = await asyncio.gather(*[_one() for _ in range(5)])
            wall = time.time() - t0

        statuses = [r[0] for r in results]
        # No 5xx allowed
        five_xx = [s for s in statuses if 500 <= s < 600]
        assert not five_xx, (
            f"got 5xx in burst: statuses={statuses}, sample_body={results[0][1][:300]}"
        )
        # Wall time should be reasonable (single-flight + ~6s cap)
        assert wall < 15.0, f"burst took {wall:.2f}s — possible event-loop blocking"
        # Consistent payloads (all the same status code at least)
        assert len(set(statuses)) <= 2, f"inconsistent statuses: {statuses}"


# ----- Regression -----
class TestRegression:
    def test_server_ip_returns_json_object(self, api):
        r = api.get(f"{BASE_URL}/api/auth/server-ip")
        assert r.status_code == 200, r.text
        data = r.json()
        assert isinstance(data, dict), f"expected dict got {type(data)}"

    def test_margin_demo_fields(self, api):
        r = api.get(f"{BASE_URL}/api/account/margin")
        assert r.status_code == 200, r.text
        data = r.json()
        # Demo margin should have at least one numeric balance field
        assert isinstance(data, dict)
        keys_lower = {k.lower() for k in data}
        # Common expected keys for a margin payload
        assert any(
            k in keys_lower
            for k in ("available_margin", "net", "available", "cash", "equity_margin_details")
        ), f"margin response missing balance-like field: {list(data)[:20]}"

    def test_positions_demo_200(self, api):
        r = api.get(f"{BASE_URL}/api/account/positions")
        assert r.status_code == 200, r.text
        data = r.json()
        assert "positions" in data or isinstance(data, list), (
            f"positions response shape unexpected: {list(data)[:10] if isinstance(data, dict) else type(data)}"
        )
