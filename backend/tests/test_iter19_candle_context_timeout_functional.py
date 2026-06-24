"""iter_19 functional regression for the candle-context timeout fix.

The defensive timeout wraps `_candle_context_last_hour` in
asyncio.wait_for(timeout=8.0). The dry-run must STILL return 200 with:
  - lots >= 1
  - quantity > 0
  - order.order_type == "LIMIT"
  - protective_preview intact (entry_price, sl_price, tp_price)
  - response received in < 12s (timeout cap is 8s; allow http overhead)

Optional fields below_price_pct / ema9 may be None (demo path has no
historical-candle data) but the request MUST NOT 5xx or hang.

Tested against NIFTY for both `breakout_call_lmt` and `steady_call_lmt`.
"""
from __future__ import annotations

import os
import time
import requests
import pytest


BASE_URL = os.environ.get(
    "EXPO_BACKEND_URL",
    "https://quick-trade-73.preview.emergentagent.com",
).rstrip("/")


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
    return {"X-Groww-Token": token, "Content-Type": "application/json"}


@pytest.fixture(scope="module")
def nifty_expiry(demo_token: str) -> str:
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


def _assert_dry_run_shape(data: dict, *, label: str):
    # The candle-context timeout fix must not change the response shape.
    assert data.get("dry_run") is True, f"{label}: dry_run flag missing — {data}"

    lots = data.get("lots")
    lot_size = data.get("lot_size")
    quantity = data.get("quantity")
    assert lots is not None, f"{label}: missing lots — {data}"
    assert lot_size is not None, f"{label}: missing lot_size — {data}"
    assert quantity is not None, f"{label}: missing quantity — {data}"
    assert int(lots) >= 1, f"{label}: lots must be >=1, got {lots}"
    assert int(quantity) > 0, f"{label}: quantity must be >0, got {quantity}"
    assert int(quantity) == int(lots) * int(lot_size), (
        f"{label}: quantity({quantity}) != lots({lots})*lot_size({lot_size})"
    )

    order = data.get("order") or {}
    assert order.get("order_type") == "LIMIT", (
        f"{label}: expected order_type=LIMIT for *_lmt preset, got {order.get('order_type')} — {data}"
    )

    pp = data.get("protective_preview") or {}
    for k in ("entry_price", "sl_price", "tp_price", "sl_pct", "tp_pct"):
        assert k in pp, f"{label}: protective_preview missing '{k}' — {pp}"

    # Optional advisory fields — may be None (degraded due to timeout fix)
    # but the keys themselves MUST be present so the frontend never KeyErrors.
    assert "below_price_pct" in data, f"{label}: 'below_price_pct' key missing"
    assert "ema9" in data, f"{label}: 'ema9' key missing"


@pytest.mark.parametrize(
    "preset_key",
    ["breakout_chaser_lmt", "steady_lmt"],
)
def test_dry_run_limit_preset_under_timeout_cap(
    demo_token: str, nifty_expiry: str, preset_key: str
):
    """The 8s timeout cap on the candle-context fetch must not block the
    NIFTY *_lmt dry-run path. Verify status=200 and the response arrives
    well under 12s wall-clock (well below CF's 100s edge timeout)."""
    body = {
        "preset_key": preset_key,
        "underlying": "NIFTY",
        "expiry": nifty_expiry,
        "exchange": "NSE",
        "option_type": "CE",
        # Bump capital to 100k to avoid the pre-existing random-LTP demo
        # flake (NIFTY 50k can land at lots=0 when synth LTP > ~₹166).
        "capital": 100000,
        "dry_run": True,
    }
    t0 = time.monotonic()
    resp = requests.post(
        f"{BASE_URL}/api/orders/place-preset",
        json=body,
        headers=_auth_headers(demo_token),
        timeout=12,  # client-side proxy for the 8s server cap
    )
    elapsed = time.monotonic() - t0

    assert resp.status_code == 200, (
        f"{preset_key}: expected 200, got {resp.status_code} body={resp.text}"
    )
    assert elapsed < 12.0, (
        f"{preset_key}: response took {elapsed:.2f}s — timeout cap should bound to <12s"
    )

    data = resp.json()
    _assert_dry_run_shape(data, label=preset_key)
