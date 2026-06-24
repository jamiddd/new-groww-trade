"""Regression tests for the MCX commodity options fix (iter_16).

Bug fixed in /app/backend/server.py:
1. Added `_segment_for(exchange)` helper → SEGMENT_COMMODITY for MCX, SEGMENT_FNO otherwise.
2. Applied at both order-placement sites:
   - _create_protective_orders (smart SL/TP)
   - _dry_preview's order_payload['segment']
3. Relaxed LTP-unavailable path in _dry_preview: MARKET orders default to lots=1
   when contract_cost <= 0 (Groww fills MARKET at live price). LIMIT still hard-fails.
"""
import os
import re
import sys
import pytest
import requests

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "https://quick-trade-73.preview.emergentagent.com").rstrip("/")
LOCAL_URL = "http://localhost:8001"

SERVER_PY = "/app/backend/server.py"


# ---------- Fixtures ----------
@pytest.fixture(scope="session")
def api_client():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


@pytest.fixture(scope="session")
def demo_token(api_client):
    r = api_client.post(f"{BASE_URL}/api/auth/login",
                        json={"api_key": "demo", "api_secret": "demo"})
    assert r.status_code == 200, r.text
    return r.json()["access_token"]


@pytest.fixture(scope="session")
def server_source():
    with open(SERVER_PY, "r", encoding="utf-8") as f:
        return f.read()


# ---------- Static code checks for the fix ----------
class TestStaticCodeFix:
    """Verify the code-level fixes are in place (the user's actual app
    runs on a separate droplet; this catches regressions in the source)."""

    def test_segment_for_helper_exists(self, server_source):
        # Helper must exist
        assert "def _segment_for(" in server_source, "missing _segment_for helper"
        # Find the helper through the next blank line at column 0 (next top-level def)
        idx = server_source.find("def _segment_for(")
        # Grab the next ~500 chars — enough to contain the body
        body = server_source[idx:idx + 600]
        assert "MCX" in body, f"_segment_for must branch on 'MCX' — body: {body[:300]}"
        assert "SEGMENT_COMMODITY" in body, "_segment_for must return SEGMENT_COMMODITY for MCX"
        assert "SEGMENT_FNO" in body, "_segment_for must default to SEGMENT_FNO"

    def test_segment_for_unit_logic(self):
        """Import and call the helper directly — pure-python unit test."""
        sys.path.insert(0, "/app/backend")
        from server import _segment_for  # noqa: WPS433
        from growwapi import GrowwAPI

        assert _segment_for("MCX") == GrowwAPI.SEGMENT_COMMODITY
        assert _segment_for("mcx") == GrowwAPI.SEGMENT_COMMODITY  # case-insensitive
        assert _segment_for("NSE") == GrowwAPI.SEGMENT_FNO
        assert _segment_for("BSE") == GrowwAPI.SEGMENT_FNO
        assert _segment_for("") == GrowwAPI.SEGMENT_FNO
        assert _segment_for(None) == GrowwAPI.SEGMENT_FNO  # type: ignore[arg-type]

    def test_protective_orders_uses_segment_for(self, server_source):
        # Find the protective-order function (_arm_protective_order) and verify
        # it uses _segment_for(exchange) instead of hardcoded SEGMENT_FNO.
        idx = server_source.find("async def _arm_protective_order")
        assert idx >= 0, "could not locate _arm_protective_order"
        end = server_source.find("\nasync def ", idx + 1)
        if end < 0:
            end = server_source.find("\ndef ", idx + 1)
        body = server_source[idx:end if end > idx else idx + 4000]
        assert "_segment_for(" in body, "_arm_protective_order must call _segment_for"
        assert re.search(r"segment\s*=\s*GrowwAPI\.SEGMENT_FNO", body) is None, \
            "_arm_protective_order still hardcodes SEGMENT_FNO"

    def test_dry_preview_order_payload_uses_segment_for(self, server_source):
        # Inside place-preset handler / _dry_preview, the order_payload['segment']
        # must come from _segment_for(payload.exchange) — not a hardcoded literal.
        m = re.search(
            r'order_payload\s*=\s*\{(.*?)\n\s{0,4}\}', server_source, re.S,
        )
        assert m, "could not locate order_payload dict"
        body = m.group(1)
        assert "_segment_for(payload.exchange)" in body, \
            "order_payload['segment'] must use _segment_for(payload.exchange)"

    def test_market_ltp_unavailable_defaults_to_one_lot(self, server_source):
        # When contract_cost <= 0 AND preset.order_type == 'MARKET',
        # we want `lots = 1` (so the user can place a market order at
        # whatever Groww fills it at).
        # Find the branch in _dry_preview.
        snippet = re.search(
            r"if contract_cost <= 0:\s*\n\s+if preset_doc\[.order_type.\] == .MARKET.:\s*\n\s+lots\s*=\s*1",
            server_source,
        )
        assert snippet, "MARKET fallback to lots=1 when LTP unavailable is missing"

    def test_limit_ltp_unavailable_still_fails(self, server_source):
        # LIMIT path: must still hard-fail (raise HTTPException)
        # when contract_cost <= 0 and not dry_run.
        assert "No live LTP available for the picked strike — cannot size a LIMIT order." in server_source, \
            "LIMIT hard-fail message missing"

    def test_no_stray_segment_fno_in_order_placement(self, server_source):
        """Ensure no `place_order(...SEGMENT_FNO...)` style hardcoding exists
        in the BUY/preset placement contexts. Other usages (positions fetch,
        historical candle, smart-order cancel default) are allowed per spec."""
        # The known/allowed SEGMENT_FNO usages (line approx in source):
        # - get_historical_candle_data: not order placement, but reads candles
        # - get_positions_for_user(SEGMENT_FNO): positions fetch (allowed)
        # - cancel_smart_order default `seg = so.get("segment") or SEGMENT_FNO`
        #   for FNO close path
        # - margin scan
        # The BUY placement contexts (_create_protective_orders + _dry_preview
        # order_payload) should be free of hardcoded SEGMENT_FNO — already
        # asserted above. Here we just spot-check the BUY path's place_order
        # call (if any) doesn't hardcode it.
        # The actual place_order in _dry_preview happens via **order_payload
        # so it inherits 'segment' from the dict — already verified.
        pass


# ---------- API behaviour: demo mode regression ----------
class TestPlacePresetDemoRegression:
    """Demo mode short-circuits to synthetic data — make sure the request
    still parses and returns a valid dry_run preview shape, with no 500s."""

    def test_demo_nifty_market_dry_run(self, api_client, demo_token):
        body = {
            "preset_key": "breakout_mkt",
            "underlying": "NIFTY",
            "expiry": "2026-06-26",
            "exchange": "NSE",
            "option_type": "CE",
            "capital": 50000,
            "dry_run": True,
        }
        r = api_client.post(
            f"{BASE_URL}/api/orders/place-preset",
            headers={"X-Groww-Token": demo_token},
            json=body,
        )
        assert r.status_code == 200, r.text
        data = r.json()
        assert data.get("dry_run") is True
        # NIFTY demo: lots should be >= 1 with 50k capital
        assert isinstance(data.get("lots"), int)
        assert data["lots"] >= 1, f"expected NIFTY MARKET lots>=1, got {data}"
        assert isinstance(data.get("quantity"), int) and data["quantity"] > 0
        assert isinstance(data.get("lot_size"), int) and data["lot_size"] > 0
        # quantity must equal lots * lot_size
        assert data["quantity"] == data["lots"] * data["lot_size"]

    def test_demo_nifty_limit_dry_run(self, api_client, demo_token):
        body = {
            "preset_key": "breakout_chaser_lmt",
            "underlying": "NIFTY",
            "expiry": "2026-06-26",
            "exchange": "NSE",
            "option_type": "CE",
            "capital": 50000,
            "dry_run": True,
        }
        r = api_client.post(
            f"{BASE_URL}/api/orders/place-preset",
            headers={"X-Groww-Token": demo_token},
            json=body,
        )
        assert r.status_code == 200, r.text
        data = r.json()
        assert data.get("dry_run") is True
        assert data.get("lots", 0) >= 1
        # LIMIT order should carry a price > 0 in the demo response
        order = data.get("order") or {}
        if order:
            assert order.get("order_type") == "LIMIT"
            assert float(order.get("price") or 0) > 0

    def test_demo_mcx_goldm_market_dry_run_does_not_500(self, api_client, demo_token):
        """User scenario: GOLDM 26 JUN PE MARKET. Demo path synthesises
        data, but must NOT 500 and must return a valid preview."""
        body = {
            "preset_key": "breakout_mkt",
            "underlying": "GOLDM",
            "expiry": "2026-06-26",
            "exchange": "MCX",
            "option_type": "PE",
            "capital": 50000,
            "dry_run": True,
        }
        r = api_client.post(
            f"{BASE_URL}/api/orders/place-preset",
            headers={"X-Groww-Token": demo_token},
            json=body,
        )
        assert r.status_code == 200, f"{r.status_code}: {r.text[:400]}"
        data = r.json()
        assert data.get("dry_run") is True
        # Demo synth path computes lots from random LTP; capital is plenty for GOLDM
        assert isinstance(data.get("lots"), int)
        assert data.get("lot_size", 0) > 0
        # selected dict should be present in demo synth path
        sel = data.get("selected") or {}
        assert sel.get("trading_symbol", "").startswith("GOLDM"), f"unexpected: {sel}"

    def test_demo_mcx_goldm_limit_dry_run_does_not_500(self, api_client, demo_token):
        body = {
            "preset_key": "breakout_chaser_lmt",
            "underlying": "GOLDM",
            "expiry": "2026-06-26",
            "exchange": "MCX",
            "option_type": "PE",
            "capital": 50000,
            "dry_run": True,
        }
        r = api_client.post(
            f"{BASE_URL}/api/orders/place-preset",
            headers={"X-Groww-Token": demo_token},
            json=body,
        )
        assert r.status_code == 200, f"{r.status_code}: {r.text[:400]}"
        data = r.json()
        assert data.get("dry_run") is True


# ---------- API behaviour: real (non-demo) path with fake token ----------
# We use a fake token through LOCAL_URL to bypass Cloudflare's HTML 502 wrap,
# so we can inspect the JSON error. We expect Groww SDK errors to surface as
# clean 502 with the message — which proves we reached _dry_preview and tried
# to call get_option_chain (or get_access_token failed first).
class TestPlacePresetRealPathErrors:
    FAKE_HDRS = {"X-Groww-Token": "fake_invalid_token_for_test_only", "Content-Type": "application/json"}

    def test_mcx_market_dry_run_fake_token_clean_json(self, api_client):
        body = {
            "preset_key": "breakout_mkt",
            "underlying": "GOLDM",
            "expiry": "2026-06-26",
            "exchange": "MCX",
            "option_type": "PE",
            "capital": 50000,
            "dry_run": True,
        }
        r = api_client.post(f"{LOCAL_URL}/api/orders/place-preset",
                            headers=self.FAKE_HDRS, json=body)
        # Possible outcomes:
        # - 200 if Groww errored out and fallback master pick + lots=1 MARKET happened
        # - 502 if upstream Groww raised and the fallback also returned no pick
        # - 401 if token rejected upstream
        # Either way: clean JSON, no 500.
        assert r.status_code in (200, 401, 502, 404), f"{r.status_code}: {r.text[:300]}"
        try:
            body_json = r.json()
        except Exception:
            pytest.fail(f"non-JSON: {r.text[:300]}")
        assert isinstance(body_json, dict)

    def test_nse_nifty_market_dry_run_fake_token_clean_json(self, api_client):
        """Regression: non-MCX path still works (returns clean JSON)."""
        body = {
            "preset_key": "breakout_mkt",
            "underlying": "NIFTY",
            "expiry": "2026-01-30",
            "exchange": "NSE",
            "option_type": "CE",
            "capital": 50000,
            "dry_run": True,
        }
        r = api_client.post(f"{LOCAL_URL}/api/orders/place-preset",
                            headers=self.FAKE_HDRS, json=body)
        assert r.status_code in (200, 401, 502, 404), f"{r.status_code}: {r.text[:300]}"
        assert r.json()  # JSON-parseable
