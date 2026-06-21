"""Backend regression tests for ScalpX Groww options scalping app."""
import os
import uuid
import pytest
import requests

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "https://quick-trade-73.preview.emergentagent.com").rstrip("/")
# Cloudflare ingress rewrites upstream 502s into HTML pages. To validate that the
# *backend* returns clean JSON for upstream/Groww failures, hit the in-cluster URL.
LOCAL_URL = "http://localhost:8001"


@pytest.fixture(scope="session")
def api_client():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


# --- Health ---
class TestHealth:
    def test_health(self, api_client):
        r = api_client.get(f"{BASE_URL}/api/")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body.get("status") == "ok"


# --- Presets ---
EXPECTED_KEYS = {"breakout_mkt", "breakout_chaser_lmt", "steady_mkt", "steady_lmt"}
REQUIRED_FIELDS = {"key", "label", "strike_selection", "iv_filter", "position_sizing_pct",
                   "stop_loss_pct", "take_profit_pct", "order_type", "limit_offset_pct"}


class TestPresets:
    def test_list_presets(self, api_client):
        r = api_client.get(f"{BASE_URL}/api/presets")
        assert r.status_code == 200, r.text
        data = r.json()
        items = data.get("items")
        assert isinstance(items, list)
        keys = {it["key"] for it in items}
        assert EXPECTED_KEYS.issubset(keys), f"missing keys: {EXPECTED_KEYS - keys}"
        for it in items:
            assert REQUIRED_FIELDS.issubset(it.keys()), f"missing fields in {it.get('key')}: {REQUIRED_FIELDS - set(it.keys())}"

    def test_get_single_preset(self, api_client):
        for k in EXPECTED_KEYS:
            r = api_client.get(f"{BASE_URL}/api/presets/{k}")
            assert r.status_code == 200, f"{k}: {r.text}"
            body = r.json()
            assert body["key"] == k
            assert REQUIRED_FIELDS.issubset(body.keys())

    def test_get_unknown_preset_404(self, api_client):
        r = api_client.get(f"{BASE_URL}/api/presets/this_does_not_exist_xyz")
        assert r.status_code == 404

    def test_update_preset_persists(self, api_client):
        key = "steady_mkt"
        # read current
        cur = api_client.get(f"{BASE_URL}/api/presets/{key}").json()
        new_sl = round(((cur.get("stop_loss_pct") or 4.0) + 1.5), 2)
        new_label = f"TEST_{uuid.uuid4().hex[:6]}"
        payload = {**cur, "stop_loss_pct": new_sl, "label": new_label}
        # PUT
        r = api_client.put(f"{BASE_URL}/api/presets/{key}", json=payload)
        assert r.status_code == 200, r.text
        # Re-read and assert persistence
        after = api_client.get(f"{BASE_URL}/api/presets/{key}").json()
        assert after["stop_loss_pct"] == new_sl
        assert after["label"] == new_label
        # restore
        api_client.put(f"{BASE_URL}/api/presets/{key}", json=cur)


# --- Settings ---
class TestSettings:
    def test_get_settings_defaults(self, api_client):
        r = api_client.get(f"{BASE_URL}/api/settings")
        assert r.status_code == 200, r.text
        body = r.json()
        # Defaults from PRD
        assert body.get("confirm_before_order") is True
        assert body.get("ask_max_loss_at_startup") is True
        assert body.get("convert_to_usd") is False
        assert body.get("save_last_underlying") is True

    def test_update_settings_persists(self, api_client):
        cur = api_client.get(f"{BASE_URL}/api/settings").json()
        new_settings = {**cur, "convert_to_usd": not cur.get("convert_to_usd", False),
                        "last_underlying": "NIFTY", "last_underlying_expiry": "2026-01-30"}
        r = api_client.put(f"{BASE_URL}/api/settings", json=new_settings)
        assert r.status_code == 200, r.text
        after = api_client.get(f"{BASE_URL}/api/settings").json()
        assert after["convert_to_usd"] == new_settings["convert_to_usd"]
        assert after["last_underlying"] == "NIFTY"
        assert after["last_underlying_expiry"] == "2026-01-30"
        # restore defaults
        api_client.put(f"{BASE_URL}/api/settings", json={
            "confirm_before_order": True, "ask_max_loss_at_startup": True,
            "convert_to_usd": False, "save_last_underlying": True,
            "last_underlying": None, "last_underlying_expiry": None,
        })


# --- FX ---
class TestFx:
    def test_inr_to_usd(self, api_client):
        r = api_client.get(f"{BASE_URL}/api/fx/inr-to-usd")
        assert r.status_code == 200, r.text
        body = r.json()
        rate = body.get("rate")
        assert isinstance(rate, (int, float))
        assert rate > 0


# --- Auth ---
class TestAuth:
    def test_login_with_garbage_returns_401(self, api_client):
        r = api_client.post(f"{BASE_URL}/api/auth/login",
                            json={"api_key": "TEST_garbage_key", "api_secret": "JBSWY3DPEHPK3PXP"})
        assert r.status_code == 401, f"expected 401, got {r.status_code}: {r.text}"
        try:
            body = r.json()
        except Exception:
            pytest.fail(f"non-JSON response: {r.text}")
        detail = body.get("detail", "")
        assert "Groww login failed" in detail, f"detail missing expected prefix: {detail}"

    def test_login_with_invalid_secret_format(self, api_client):
        r = api_client.post(f"{BASE_URL}/api/auth/login",
                            json={"api_key": "TEST_key", "api_secret": "not_base32!!!"})
        assert r.status_code in (401, 422, 502)
        # should be clean JSON
        body = r.json()
        assert "detail" in body


# --- Protected endpoints without token ---
PROTECTED_GET = [
    "/api/auth/verify",
    "/api/account/margin",
    "/api/account/positions",
    "/api/account/orders",
    "/api/instruments/underlyings",
    "/api/instruments/expiries?underlying=NIFTY",
    "/api/instruments/option-chain?underlying=NIFTY&expiry=2026-01-30",
]


class TestAuthRequired:
    @pytest.mark.parametrize("path", PROTECTED_GET)
    def test_get_requires_token(self, api_client, path):
        r = api_client.get(f"{BASE_URL}{path}")
        assert r.status_code == 401, f"{path}: {r.status_code} {r.text}"
        body = r.json()
        assert body.get("detail") == "Missing X-Groww-Token header", f"{path}: {body}"

    def test_place_preset_requires_token(self, api_client):
        r = api_client.post(f"{BASE_URL}/api/orders/place-preset", json={
            "preset_key": "steady_mkt", "underlying": "NIFTY",
            "expiry": "2026-01-30", "option_type": "CE", "capital": 10000, "dry_run": True,
        })
        assert r.status_code == 401
        assert r.json().get("detail") == "Missing X-Groww-Token header"

    def test_exit_requires_token(self, api_client):
        r = api_client.post(f"{BASE_URL}/api/orders/exit", json={"percent": 25})
        assert r.status_code == 401
        assert r.json().get("detail") == "Missing X-Groww-Token header"


# --- Fake token behaviour ---
FAKE_TOKEN_HEADERS = {"X-Groww-Token": "fake_invalid_token_for_test_only", "Content-Type": "application/json"}


class TestFakeToken:
    @pytest.mark.parametrize("path", [
        "/api/auth/verify",
        "/api/account/margin",
        "/api/account/positions",
        "/api/account/orders",
        "/api/instruments/expiries?underlying=NIFTY",
        "/api/instruments/option-chain?underlying=NIFTY&expiry=2026-01-30",
    ])
    def test_fake_token_clean_error(self, api_client, path):
        r = api_client.get(f"{LOCAL_URL}{path}", headers=FAKE_TOKEN_HEADERS)
        assert r.status_code in (401, 502), f"{path}: {r.status_code} {r.text[:200]}"
        # Must be JSON, not a 500 stack trace
        try:
            body = r.json()
        except Exception:
            pytest.fail(f"{path}: non-JSON response: {r.text[:200]}")
        assert "detail" in body, f"{path}: {body}"

    def test_underlyings_fake_token_returns_indices(self, api_client):
        # underlyings has a fallback (indices) even if df load fails
        r = api_client.get(f"{BASE_URL}/api/instruments/underlyings", headers=FAKE_TOKEN_HEADERS)
        # should be 200 with at least the static indices (NIFTY etc.)
        assert r.status_code == 200, r.text
        body = r.json()
        syms = {it["symbol"] for it in body.get("items", [])}
        assert "NIFTY" in syms

    def test_place_preset_fake_token_clean_error(self, api_client):
        r = api_client.post(f"{LOCAL_URL}/api/orders/place-preset", headers=FAKE_TOKEN_HEADERS, json={
            "preset_key": "steady_mkt", "underlying": "NIFTY", "expiry": "2026-01-30",
            "option_type": "CE", "capital": 10000, "dry_run": True,
        })
        assert r.status_code in (401, 502, 404), f"{r.status_code} {r.text[:200]}"
        body = r.json()
        assert "detail" in body
