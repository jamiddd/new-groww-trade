"""
iter_17 follow-up tests for MCX segment fix.

Covers:
  1. Static code checks on /app/backend/server.py:
     - _fetch_candles_for (line ~1477): get_historical_candle_data uses
       `_segment_for(exchange)` (not hardcoded SEGMENT_FNO).
     - /api/orders/exit: positions fetched from BOTH SEGMENT_FNO and
       SEGMENT_COMMODITY.
     - /api/orders/exit: SELL place_order inside the loop uses
       `_segment_for(exchange)` (not hardcoded SEGMENT_FNO).
  2. Demo-token regression on POST /api/orders/exit
     (cancelled_smart_orders / no-positions path).
  3. Demo-token regression on POST /api/orders/place-preset for NIFTY.
"""
from __future__ import annotations

import os
import re
import requests
import pytest


BASE_URL = os.environ.get("EXPO_BACKEND_URL", "https://quick-trade-73.preview.emergentagent.com").rstrip("/")
SERVER_PY = "/app/backend/server.py"


# ----------------------------- helpers ----------------------------- #


@pytest.fixture(scope="module")
def server_source() -> str:
    with open(SERVER_PY, "r", encoding="utf-8") as fh:
        return fh.read()


@pytest.fixture(scope="module")
def demo_token() -> str:
    resp = requests.post(
        f"{BASE_URL}/api/auth/login",
        json={"api_key": "demo", "api_secret": "demo"},
        timeout=15,
    )
    assert resp.status_code == 200, f"demo login failed: {resp.status_code} {resp.text}"
    tok = resp.json().get("access_token")
    assert tok, "no access_token from demo login"
    return tok


def _auth_headers(token: str) -> dict:
    """Backend authenticates via `X-Groww-Token` header (see require_token)."""
    return {"X-Groww-Token": token}


# ----------------------- Static code checks ----------------------- #


class TestStaticIter17Fixes:
    """Validate the three iter_17 source-level fixes are present."""

    def test_fetch_candles_uses_segment_for(self, server_source: str):
        # Locate `api_.get_historical_candle_data,` call and verify the
        # very next non-empty positional arg (3rd arg per Groww SDK) is
        # `_segment_for(exchange)`.
        m = re.search(
            r"api_\.get_historical_candle_data,\s*\n"
            r"\s*\S+,\s*\n"           # trading_symbol
            r"\s*\S+,\s*\n"           # exchange
            r"\s*_segment_for\(exchange\)",
            server_source,
        )
        assert m, "_fetch_candles_for must pass _segment_for(exchange) to get_historical_candle_data"

    def test_orders_exit_iterates_both_segments(self, server_source: str):
        # Look inside the /orders/exit route block for the two-segment loop.
        idx = server_source.find('@api.post("/orders/exit")')
        assert idx != -1, "/orders/exit route not found"
        block = server_source[idx: idx + 6000]
        assert re.search(
            r"for\s+seg\s+in\s*\(\s*GrowwAPI\.SEGMENT_FNO\s*,\s*GrowwAPI\.SEGMENT_COMMODITY\s*\)",
            block,
        ), "/orders/exit must iterate over both SEGMENT_FNO and SEGMENT_COMMODITY"

    def test_orders_exit_place_order_uses_segment_for(self, server_source: str):
        idx = server_source.find('@api.post("/orders/exit")')
        block = server_source[idx: idx + 8000]
        # Ensure place_order in the SELL loop is parameterised by _segment_for
        assert "api_.place_order" in block, "place_order call missing in /orders/exit"
        assert "_segment_for(exchange)" in block, (
            "/orders/exit place_order must pass _segment_for(exchange)"
        )
        # Extract the entire place_order(...) argument list (handles nested parens).
        po_idx = block.find("api_.place_order,")
        assert po_idx != -1
        # Find matching close paren by depth walking from the opening "(" before "api_.place_order"
        open_idx = block.rfind("(", 0, po_idx)
        depth = 0
        end_idx = -1
        for i in range(open_idx, len(block)):
            ch = block[i]
            if ch == "(":
                depth += 1
            elif ch == ")":
                depth -= 1
                if depth == 0:
                    end_idx = i
                    break
        assert end_idx != -1, "could not isolate place_order(...) call"
        args = block[open_idx + 1: end_idx]
        assert "SEGMENT_FNO" not in args, (
            "place_order inside /orders/exit must not pass hardcoded SEGMENT_FNO"
        )
        assert "_segment_for(exchange)" in args, (
            "place_order inside /orders/exit must pass _segment_for(exchange)"
        )

    def test_no_segment_fno_in_candle_or_order_paths(self, server_source: str):
        """Hardcoded SEGMENT_FNO is acceptable only for explicit F&O queries
        (positions list, margin extraction, smart-order defaults).
        It must NOT appear directly as the segment arg to any place_order
        or get_historical_candle_data call."""

        def _extract_call_args(src: str, fn_marker: str):
            results = []
            cursor = 0
            while True:
                pos = src.find(fn_marker, cursor)
                if pos == -1:
                    break
                open_idx = src.rfind("(", 0, pos)
                if open_idx == -1:
                    cursor = pos + len(fn_marker)
                    continue
                depth = 0
                end = -1
                for i in range(open_idx, len(src)):
                    if src[i] == "(":
                        depth += 1
                    elif src[i] == ")":
                        depth -= 1
                        if depth == 0:
                            end = i
                            break
                if end != -1:
                    results.append(src[open_idx + 1: end])
                cursor = end + 1 if end != -1 else pos + len(fn_marker)
            return results

        for args in _extract_call_args(server_source, "get_historical_candle_data,"):
            assert "SEGMENT_FNO" not in args, (
                "get_historical_candle_data must not be called with hardcoded SEGMENT_FNO"
            )
        for args in _extract_call_args(server_source, ".place_order,"):
            assert "SEGMENT_FNO" not in args, (
                "place_order must not be called with hardcoded SEGMENT_FNO"
            )


# ----------------------- Demo runtime regression ----------------------- #


class TestDemoExitRegression:
    """POST /api/orders/exit with demo token must remain functional."""

    def test_exit_percent_100_demo_no_500(self, demo_token: str):
        resp = requests.post(
            f"{BASE_URL}/api/orders/exit",
            json={"percent": 100},
            headers=_auth_headers(demo_token),
            timeout=20,
        )
        assert resp.status_code == 200, f"exit percent=100 failed: {resp.status_code} {resp.text}"
        data = resp.json()
        # Shape contract
        assert "closed" in data and isinstance(data["closed"], list)
        assert "count" in data and isinstance(data["count"], int)
        assert "cancelled_smart_orders" in data and isinstance(data["cancelled_smart_orders"], list)
        # count must match closed length
        assert data["count"] == len(data["closed"])

    def test_exit_invalid_percent_returns_400(self, demo_token: str):
        resp = requests.post(
            f"{BASE_URL}/api/orders/exit",
            json={"percent": 33},
            headers=_auth_headers(demo_token),
            timeout=15,
        )
        assert resp.status_code == 400


class TestDemoPlacePresetNiftyRegression:
    """Confirm the NSE/NIFTY demo dry-run path is still healthy after the
    iter_17 changes (no regression from MCX-only edits)."""

    @pytest.fixture(scope="class")
    def future_expiry(self, demo_token: str) -> str:
        resp = requests.get(
            f"{BASE_URL}/api/instruments/expiries",
            params={"underlying": "NIFTY", "exchange": "NSE"},
            headers=_auth_headers(demo_token),
            timeout=15,
        )
        assert resp.status_code == 200, resp.text
        exps = resp.json().get("expiries") or []
        assert exps, "no demo expiries for NIFTY"
        return exps[0]

    def test_nifty_breakout_call_mkt_dry_run(self, demo_token: str, future_expiry: str):
        body = {
            "preset_key": "breakout_call_mkt",
            "underlying": "NIFTY",
            "expiry": future_expiry,
            "exchange": "NSE",
            "option_type": "CE",
            "capital": 50000,
            "dry_run": True,
        }
        resp = requests.post(
            f"{BASE_URL}/api/orders/place-preset",
            json=body,
            headers=_auth_headers(demo_token),
            timeout=20,
        )
        assert resp.status_code == 200, f"place-preset NIFTY dry-run failed: {resp.status_code} {resp.text}"
        data = resp.json()
        # Look for sizing block — quantity must equal lots * lot_size.
        # Be tolerant to slight schema variations: search both top-level and nested.
        flat = {}
        flat.update(data)
        if isinstance(data.get("preview"), dict):
            flat.update(data["preview"])
        if isinstance(data.get("order"), dict):
            flat.update(data["order"])

        lots = flat.get("lots")
        lot_size = flat.get("lot_size")
        quantity = flat.get("quantity")

        assert lots is not None, f"missing 'lots' in dry-run response: {data}"
        assert lot_size is not None, f"missing 'lot_size' in dry-run response: {data}"
        assert quantity is not None, f"missing 'quantity' in dry-run response: {data}"
        assert int(lots) >= 1, f"lots must be >=1 for 50k capital on NIFTY, got {lots}"
        assert int(quantity) == int(lots) * int(lot_size), (
            f"quantity ({quantity}) must equal lots*lot_size ({lots}*{lot_size})"
        )
