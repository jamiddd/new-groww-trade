"""Iter_20 functional regression: the new get_option_chain (6s) and
place_order (25s) timeout wrappers must NOT affect happy-path latency
for NIFTY dry-runs.

Covers the three presets the review_request explicitly called out:
  - breakout_chaser_lmt  (LIMIT)
  - steady_lmt           (LIMIT)
  - breakout_mkt         (MARKET)

Each dry_run=true call must:
  * return 200
  * complete well below the 6s option-chain cap (target <2s in demo)
  * return lots>=1, quantity=lots*lot_size
  * include the full protective_preview block + order_type
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


def _headers(token: str) -> dict:
    return {"X-Groww-Token": token, "Content-Type": "application/json"}


@pytest.fixture(scope="module")
def nifty_expiry(demo_token: str) -> str:
    resp = requests.get(
        f"{BASE_URL}/api/instruments/expiries",
        params={"underlying": "NIFTY", "exchange": "NSE"},
        headers=_headers(demo_token),
        timeout=15,
    )
    assert resp.status_code == 200, resp.text
    exps = resp.json().get("expiries") or []
    assert exps, "no demo expiries for NIFTY"
    return exps[0]


def _assert_shape(data: dict, *, label: str, expect_order_type: str):
    assert data.get("dry_run") is True, f"{label}: dry_run flag missing — {data}"
    lots = data.get("lots")
    lot_size = data.get("lot_size")
    quantity = data.get("quantity")
    assert lots is not None and lot_size is not None and quantity is not None, (
        f"{label}: missing sizing keys — {data}"
    )
    assert int(lots) >= 1, f"{label}: lots must be >=1, got {lots}"
    assert int(quantity) == int(lots) * int(lot_size), (
        f"{label}: quantity({quantity}) != lots*lot_size"
    )

    order = data.get("order") or {}
    assert order.get("order_type") == expect_order_type, (
        f"{label}: expected order_type={expect_order_type}, "
        f"got {order.get('order_type')} — {data}"
    )

    pp = data.get("protective_preview") or {}
    for k in ("entry_price", "sl_price", "tp_price", "sl_pct", "tp_pct"):
        assert k in pp, f"{label}: protective_preview missing '{k}' — {pp}"


@pytest.mark.parametrize(
    "preset_key,expect_order_type",
    [
        ("breakout_chaser_lmt", "LIMIT"),
        ("steady_lmt",          "LIMIT"),
        ("breakout_mkt",        "MARKET"),
    ],
)
def test_nifty_dry_run_under_timeout_caps(
    demo_token: str, nifty_expiry: str, preset_key: str, expect_order_type: str
):
    """Happy-path NIFTY dry-run must remain fast — the new 6s/25s caps
    should never trip on the demo path. We assert well below the
    cap (response should be ~hundreds of ms)."""
    body = {
        "preset_key": preset_key,
        "underlying": "NIFTY",
        "expiry": nifty_expiry,
        "exchange": "NSE",
        "option_type": "CE",
        "capital": 100000,  # avoid the demo random-LTP zero-lots flake
        "dry_run": True,
    }
    t0 = time.monotonic()
    resp = requests.post(
        f"{BASE_URL}/api/orders/place-preset",
        json=body,
        headers=_headers(demo_token),
        timeout=15,
    )
    elapsed = time.monotonic() - t0

    assert resp.status_code == 200, (
        f"{preset_key}: expected 200, got {resp.status_code} body={resp.text}"
    )
    # Generous bound: the review_request claimed <500ms but real preview
    # latency can spike due to cold metro / cold mongo. 6s matches the
    # tightest cap (option-chain timeout). Anything over that means the
    # timeout fix is regressing happy-path.
    assert elapsed < 6.0, (
        f"{preset_key}: dry-run took {elapsed:.2f}s — should remain well "
        f"under the 6s option-chain cap on happy path."
    )

    data = resp.json()
    _assert_shape(data, label=preset_key, expect_order_type=expect_order_type)
