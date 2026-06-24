"""Regression tests for the per-underlying /api/instruments/expiries demo logic.

Covers the bug-fix where SENSEX expiries used to leak NIFTY's Tuesday schedule.
All tests run against the DEMO token path (X-Groww-Token: DEMO), so no live
Groww account is required.
"""
import os
from calendar import monthrange
from datetime import datetime, date, timedelta, timezone
from typing import List, Set

import pytest
import requests

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "https://quick-trade-73.preview.emergentagent.com").rstrip("/")
DEMO_HEADERS = {"X-Groww-Token": "DEMO__SCALPX__TOKEN", "Content-Type": "application/json"}


@pytest.fixture(scope="module")
def api_client():
    s = requests.Session()
    s.headers.update(DEMO_HEADERS)
    return s


# --------------------------- helpers ----------------------------------------

def _today() -> date:
    return datetime.now(timezone.utc).date()


def _last_weekday_of_month(year: int, month: int, weekday: int) -> date:
    """Return the last date in (year, month) whose weekday() == weekday."""
    last_day = monthrange(year, month)[1]
    d = date(year, month, last_day)
    while d.weekday() != weekday:
        d -= timedelta(days=1)
    return d


def _months_ahead(n: int) -> List[tuple]:
    """Return (year, month) tuples starting from this month for the next n months."""
    t = _today()
    out = []
    for m in range(n):
        year = t.year + (t.month - 1 + m) // 12
        month = (t.month - 1 + m) % 12 + 1
        out.append((year, month))
    return out


def _fetch_expiries(api_client, underlying: str, exchange: str) -> List[str]:
    r = api_client.get(
        f"{BASE_URL}/api/instruments/expiries",
        params={"underlying": underlying, "exchange": exchange},
    )
    assert r.status_code == 200, f"{underlying}/{exchange}: HTTP {r.status_code} {r.text[:200]}"
    body = r.json()
    assert "expiries" in body, body
    exps = body["expiries"]
    assert isinstance(exps, list) and len(exps) > 0, f"empty expiries for {underlying}: {body}"
    # all ISO yyyy-mm-dd
    for d in exps:
        datetime.strptime(d, "%Y-%m-%d")
    # sorted ascending
    assert exps == sorted(exps), f"{underlying} expiries not sorted: {exps}"
    return exps


def _weekdays(dates_iso: List[str]) -> List[int]:
    return [datetime.strptime(d, "%Y-%m-%d").date().weekday() for d in dates_iso]


# --------------------------- NIFTY ------------------------------------------

class TestNiftyExpiries:
    """NIFTY → Tuesday weeklies (~8) + last-Thursday monthlies."""

    def test_nifty_has_tuesday_weeklies(self, api_client):
        exps = _fetch_expiries(api_client, "NIFTY", "NSE")
        tuesdays = [d for d in exps if datetime.strptime(d, "%Y-%m-%d").date().weekday() == 1]
        assert len(tuesdays) >= 6, f"expected ≥6 Tuesday weeklies, got {len(tuesdays)}: {exps}"

    def test_nifty_has_last_thursday_monthly(self, api_client):
        exps = _fetch_expiries(api_client, "NIFTY", "NSE")
        # at least one entry that is the last Thursday of its month
        found = False
        for iso in exps:
            d = datetime.strptime(iso, "%Y-%m-%d").date()
            if d == _last_weekday_of_month(d.year, d.month, 3):
                found = True
                break
        assert found, f"no last-Thursday monthly found in NIFTY expiries: {exps}"

    def test_nifty_no_thursday_weeklies(self, api_client):
        """Weeklies must be Tuesday; only exception is the last-Thursday monthly."""
        exps = _fetch_expiries(api_client, "NIFTY", "NSE")
        for iso in exps:
            d = datetime.strptime(iso, "%Y-%m-%d").date()
            if d.weekday() == 3:
                # must be the LAST Thursday of its month (monthly), not a random weekly
                assert d == _last_weekday_of_month(d.year, d.month, 3), (
                    f"unexpected mid-month Thursday {iso} in NIFTY expiries: {exps}"
                )


# --------------------------- SENSEX -----------------------------------------

class TestSensexExpiries:
    """SENSEX → Thursday weeklies (~8) + last-Tuesday monthlies."""

    def test_sensex_has_thursday_weeklies(self, api_client):
        exps = _fetch_expiries(api_client, "SENSEX", "BSE")
        thursdays = [d for d in exps if datetime.strptime(d, "%Y-%m-%d").date().weekday() == 3]
        assert len(thursdays) >= 6, f"expected ≥6 Thursday weeklies, got {len(thursdays)}: {exps}"

    def test_sensex_has_last_tuesday_monthly(self, api_client):
        exps = _fetch_expiries(api_client, "SENSEX", "BSE")
        found = False
        for iso in exps:
            d = datetime.strptime(iso, "%Y-%m-%d").date()
            if d == _last_weekday_of_month(d.year, d.month, 1):
                found = True
                break
        assert found, f"no last-Tuesday monthly found in SENSEX expiries: {exps}"

    def test_sensex_no_tuesday_weeklies(self, api_client):
        exps = _fetch_expiries(api_client, "SENSEX", "BSE")
        for iso in exps:
            d = datetime.strptime(iso, "%Y-%m-%d").date()
            if d.weekday() == 1:
                assert d == _last_weekday_of_month(d.year, d.month, 1), (
                    f"unexpected mid-month Tuesday {iso} in SENSEX expiries: {exps}"
                )


# --------------------------- THE BUG: NIFTY != SENSEX -----------------------

class TestBugFix_NiftyVsSensexDiffer:
    """The core bug — SENSEX must NOT echo NIFTY's Tuesday expiries."""

    def test_nifty_sensex_sets_not_equal(self, api_client):
        nifty: Set[str] = set(_fetch_expiries(api_client, "NIFTY", "NSE"))
        sensex: Set[str] = set(_fetch_expiries(api_client, "SENSEX", "BSE"))
        assert nifty != sensex, f"NIFTY and SENSEX expiry sets are equal — bug present!\n  nifty={sorted(nifty)}\n  sensex={sorted(sensex)}"

    def test_sensex_does_not_contain_nifty_weeklies(self, api_client):
        """Strong assertion: SENSEX must not echo NIFTY's Tuesday weekly schedule.

        SENSEX legitimately uses last-Tuesday monthlies, so a small number of
        Tuesdays may coincide with NIFTY's Tuesday weeklies (at most one per
        month). What we forbid is the full weekly cadence leaking — i.e. 5+
        Tuesdays in a row.
        """
        nifty = set(_fetch_expiries(api_client, "NIFTY", "NSE"))
        sensex = set(_fetch_expiries(api_client, "SENSEX", "BSE"))
        nifty_tuesdays = {
            d for d in nifty
            if datetime.strptime(d, "%Y-%m-%d").date().weekday() == 1
        }
        overlap = nifty_tuesdays & sensex
        # Each forward month contributes ≤1 last-Tuesday → allow up to 6.
        assert len(overlap) <= 6, (
            f"SENSEX leaked NIFTY Tuesday weeklies (overlap={sorted(overlap)})"
        )
        # And every overlapping date MUST be a last-Tuesday-of-month
        for iso in overlap:
            d = datetime.strptime(iso, "%Y-%m-%d").date()
            assert d == _last_weekday_of_month(d.year, d.month, 1), (
                f"unexpected mid-month Tuesday {iso} in SENSEX expiries"
            )


# --------------------------- Monthly-only underlyings -----------------------

class TestMonthlyOnlyIndices:
    """BANKNIFTY / FINNIFTY / MIDCPNIFTY → last-Thursday only.
    BANKEX → last-Tuesday only."""

    @pytest.mark.parametrize("underlying,exchange,weekday", [
        ("BANKNIFTY", "NSE", 3),    # last Thursday
        ("FINNIFTY", "NSE", 3),
        ("MIDCPNIFTY", "NSE", 3),
        ("BANKEX", "BSE", 1),       # last Tuesday
    ])
    def test_monthly_only_schedule(self, api_client, underlying, exchange, weekday):
        exps = _fetch_expiries(api_client, underlying, exchange)
        # every date must be the last <weekday> of its month
        for iso in exps:
            d = datetime.strptime(iso, "%Y-%m-%d").date()
            assert d == _last_weekday_of_month(d.year, d.month, weekday), (
                f"{underlying}: {iso} is not the last weekday={weekday} of its month"
            )
        # one date per future month (≤6) — no weeklies → ≤6 entries
        assert len(exps) <= 6, f"{underlying}: too many entries (weeklies leaked?): {exps}"


class TestStockMonthlyOnly:
    """F&O stocks (e.g. RELIANCE) → last-Thursday only."""

    def test_reliance_last_thursday_only(self, api_client):
        exps = _fetch_expiries(api_client, "RELIANCE", "NSE")
        for iso in exps:
            d = datetime.strptime(iso, "%Y-%m-%d").date()
            assert d.weekday() == 3, f"RELIANCE entry {iso} weekday={d.weekday()} (expected Thursday)"
            assert d == _last_weekday_of_month(d.year, d.month, 3), (
                f"RELIANCE entry {iso} is not the last Thursday of its month"
            )
        assert len(exps) <= 6, f"RELIANCE has weeklies leaked? {exps}"


# --------------------------- MCX commodities --------------------------------

class TestMcxExpiries:
    """MCX → monthly on contract-specific calendar day."""

    @pytest.mark.parametrize("underlying,day", [
        ("GOLD", 5),
        ("CRUDEOIL", 18),
        ("NATURALGAS", 25),
    ])
    def test_mcx_calendar_day(self, api_client, underlying, day):
        exps = _fetch_expiries(api_client, underlying, "MCX")
        assert len(exps) >= 1, f"{underlying}: no expiries returned"
        for iso in exps:
            d = datetime.strptime(iso, "%Y-%m-%d").date()
            last_day_of_month = monthrange(d.year, d.month)[1]
            expected_day = min(day, last_day_of_month)
            assert d.day == expected_day, (
                f"{underlying}: {iso} day={d.day}, expected day={expected_day}"
            )

    def test_mcx_distinct_from_nifty(self, api_client):
        gold = set(_fetch_expiries(api_client, "GOLD", "MCX"))
        nifty = set(_fetch_expiries(api_client, "NIFTY", "NSE"))
        assert gold != nifty
        # GOLD must not echo NIFTY Tuesday weeklies
        assert not (gold & {d for d in nifty if datetime.strptime(d, "%Y-%m-%d").date().weekday() == 1}), \
            f"GOLD leaked NIFTY weeklies: {gold}"


# --------------------------- Missing underlying ------------------------------

class TestMissingUnderlyingRejected:
    """Sanity: `underlying` is a required query param — must 422."""

    def test_missing_underlying_returns_422(self, api_client):
        r = api_client.get(f"{BASE_URL}/api/instruments/expiries")
        # FastAPI raises 422 for missing required query params before auth dep.
        # But our dep order may surface 401 first if header missing — we send DEMO.
        assert r.status_code == 422, f"expected 422, got {r.status_code}: {r.text[:200]}"

    def test_blank_underlying_handled(self, api_client):
        # Empty string is still accepted by FastAPI (str type); demo handler
        # should not crash — falls through to the default NIFTY-style path.
        r = api_client.get(
            f"{BASE_URL}/api/instruments/expiries",
            params={"underlying": "", "exchange": "NSE"},
        )
        assert r.status_code == 200, r.text[:200]
        body = r.json()
        assert isinstance(body.get("expiries"), list)
