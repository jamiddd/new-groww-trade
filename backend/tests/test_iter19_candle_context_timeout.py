"""Iter_19 static check: the dry-run branch of place-preset MUST wrap
`_candle_context_last_hour(...)` in `asyncio.wait_for(..., timeout=8.0)`
inside a try/except that catches both asyncio.TimeoutError and generic
Exception, falling back to `ctx = {"below_pct": None, "ema9": None}`.

Rationale: candle-context is purely advisory (EMA9 + below-price % chips
on the confirmation dialog). If Groww's historical-candle API hangs,
the entire /api/orders/place-preset dry-run would exceed Cloudflare's
~100s edge timeout and the user would see a 520. The defensive timeout
caps the worst case at 8s while leaving the dry-run + order placement
intact.
"""
import ast
import re
from pathlib import Path

SERVER = Path("/app/backend/server.py")


def _server_src() -> str:
    return SERVER.read_text()


def test_asyncio_is_imported():
    src = _server_src()
    # Must be a real top-level import, not inside a function
    tree = ast.parse(src)
    has_asyncio = False
    for node in tree.body:
        if isinstance(node, ast.Import):
            for n in node.names:
                if n.name == "asyncio":
                    has_asyncio = True
        elif isinstance(node, ast.ImportFrom) and node.module == "asyncio":
            has_asyncio = True
    assert has_asyncio, "top-level `import asyncio` missing from server.py"


def _find_place_preset_dry_run_block() -> str:
    """Return the source of the dry_run branch within the place-preset
    endpoint function so we can assert the timeout wrapper is present.
    """
    src = _server_src()
    tree = ast.parse(src)
    # The function is `place_preset` (async). Find it and locate the
    # `if payload.dry_run:` block.
    for node in ast.walk(tree):
        if isinstance(node, ast.AsyncFunctionDef) and node.name == "place_preset_order":
            seg = ast.get_source_segment(src, node) or ""
            assert seg, "place_preset_order source could not be extracted"
            return seg
    raise AssertionError("place_preset_order coroutine not found in server.py")


def test_candle_context_wrapped_in_wait_for():
    body = _find_place_preset_dry_run_block()
    # Must use asyncio.wait_for around _candle_context_last_hour with
    # timeout=8.0. Allow flexible whitespace/newlines between args.
    pat = re.compile(
        r"asyncio\.wait_for\(\s*_candle_context_last_hour\(.*?\),\s*timeout\s*=\s*8\.0\s*,?\s*\)",
        re.DOTALL,
    )
    assert pat.search(body), (
        "place_preset dry-run branch must wrap _candle_context_last_hour() "
        "in asyncio.wait_for(..., timeout=8.0).\nbody=\n" + body
    )


def test_candle_context_catches_timeout_and_exception():
    body = _find_place_preset_dry_run_block()
    assert "asyncio.TimeoutError" in body, (
        "place_preset dry-run must catch asyncio.TimeoutError"
    )
    # Find the try-block containing the wait_for call and assert it has
    # both TimeoutError + generic Exception handlers that fall back to
    # ctx = {"below_pct": None, "ema9": None}.
    # Cheap regex (the actual code uses two except clauses).
    timeout_pat = re.compile(
        r"except\s+asyncio\.TimeoutError[^:]*:\s*(?:[^\n]*\n\s*)*?ctx\s*=\s*\{\s*[\"']below_pct[\"']\s*:\s*None\s*,\s*[\"']ema9[\"']\s*:\s*None\s*\}",
        re.DOTALL,
    )
    generic_pat = re.compile(
        r"except\s+Exception[^:]*:\s*(?:[^\n]*\n\s*)*?ctx\s*=\s*\{\s*[\"']below_pct[\"']\s*:\s*None\s*,\s*[\"']ema9[\"']\s*:\s*None\s*\}",
        re.DOTALL,
    )
    assert timeout_pat.search(body), (
        "Missing `except asyncio.TimeoutError:` that falls back to "
        "ctx = {below_pct: None, ema9: None}"
    )
    assert generic_pat.search(body), (
        "Missing `except Exception:` that falls back to "
        "ctx = {below_pct: None, ema9: None}"
    )


def test_candle_context_logger_warning_on_timeout():
    """Timeout + generic exception paths should both log a warning so
    operators can spot persistent Groww-historical-API slowness."""
    body = _find_place_preset_dry_run_block()
    # Look for logger.warning calls near asyncio.TimeoutError / Exception
    # handlers. Cheap check: both 'timed out' and a generic warn.
    assert "logger.warning" in body, "logger.warning missing in dry-run block"
    assert re.search(r"candle context.*timed out", body), (
        "expected a logger.warning mentioning 'candle context ... timed out'"
    )
