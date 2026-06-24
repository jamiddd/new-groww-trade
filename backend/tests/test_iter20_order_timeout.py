"""Iter_20 static checks for the dual hard timeouts in
/app/backend/server.py:

  (A) `get_option_chain` must be wrapped in
      `asyncio.wait_for(..., timeout=6.0)` with a dedicated
      `except asyncio.TimeoutError` handler that:
        * raises HTTPException(504, ...) on real orders, AND
        * sets `chain_error = "option_chain_timeout"` so the
          dry-run can fall through to the master-scan fallback.

  (B) The LIVE `api_.place_order` call must be wrapped in
      `asyncio.wait_for(..., timeout=25.0)` with an
      `except asyncio.TimeoutError` handler that raises
      HTTPException(504, ...) containing the phrase
      "check your Groww order book".

Rationale: a hanging Groww call on either path can blow past
Cloudflare's ~100s edge deadline and surface a 520 to the user.
Both timeouts cap the worst case + return a clean 504.
"""
from __future__ import annotations

import ast
import re
from pathlib import Path

SERVER = Path("/app/backend/server.py")


def _src() -> str:
    return SERVER.read_text()


def _place_preset_body() -> str:
    src = _src()
    tree = ast.parse(src)
    for node in ast.walk(tree):
        if isinstance(node, ast.AsyncFunctionDef) and node.name == "place_preset_order":
            seg = ast.get_source_segment(src, node) or ""
            assert seg, "could not extract place_preset_order source"
            return seg
    raise AssertionError("place_preset_order coroutine not found in server.py")


# ---------------------------------------------------------------- (A)
def test_get_option_chain_wrapped_in_wait_for_6s():
    body = _place_preset_body()
    pat = re.compile(
        r"asyncio\.wait_for\(\s*_call_blocking\(\s*api_\.get_option_chain\b.*?\)\s*,\s*timeout\s*=\s*6\.0\s*,?\s*\)",
        re.DOTALL,
    )
    assert pat.search(body), (
        "get_option_chain must be wrapped in "
        "asyncio.wait_for(_call_blocking(api_.get_option_chain, ...), timeout=6.0)"
    )


def test_get_option_chain_timeout_handler_sets_chain_error_and_raises_for_real_orders():
    body = _place_preset_body()
    # The TimeoutError handler should:
    #  - assign chain_error = "option_chain_timeout"
    #  - guard `if not payload.dry_run:` and raise HTTPException(504, ...)
    # Validate via substring + structured checks (regex covers reasonable
    # formatting variation).
    assign_pat = re.compile(
        r"except\s+asyncio\.TimeoutError[^:]*:\s*(?:[^\n]*\n\s*)*?chain_error\s*=\s*[\"']option_chain_timeout[\"']",
        re.DOTALL,
    )
    assert assign_pat.search(body), (
        "Missing `chain_error = \"option_chain_timeout\"` inside the "
        "asyncio.TimeoutError handler around get_option_chain."
    )
    # 504 for real orders must be raised somewhere inside the same handler
    # — easiest robust check: there is a `raise HTTPException(status_code=504`
    # following the chain_error assignment and gated by `not payload.dry_run`.
    raise_pat = re.compile(
        r"chain_error\s*=\s*[\"']option_chain_timeout[\"'].*?if\s+not\s+payload\.dry_run\s*:\s*(?:[^\n]*\n\s*)*?raise\s+HTTPException\(\s*status_code\s*=\s*504",
        re.DOTALL,
    )
    assert raise_pat.search(body), (
        "Missing `if not payload.dry_run: raise HTTPException(status_code=504, ...)` "
        "after `chain_error = 'option_chain_timeout'`."
    )


def test_get_option_chain_timeout_logs_warning():
    body = _place_preset_body()
    # logger.warning call inside the option-chain TimeoutError handler.
    warn_pat = re.compile(
        r"except\s+asyncio\.TimeoutError[^:]*:\s*(?:[^\n]*\n\s*)*?logger\.warning\(",
        re.DOTALL,
    )
    assert warn_pat.search(body), (
        "Missing logger.warning inside the get_option_chain TimeoutError handler."
    )


# ---------------------------------------------------------------- (B)
def test_place_order_wrapped_in_wait_for_25s():
    body = _place_preset_body()
    pat = re.compile(
        r"asyncio\.wait_for\(\s*_call_blocking\(\s*api_\.place_order\b.*?\)\s*,\s*timeout\s*=\s*25\.0\s*,?\s*\)",
        re.DOTALL,
    )
    assert pat.search(body), (
        "Live api_.place_order must be wrapped in "
        "asyncio.wait_for(_call_blocking(api_.place_order, **order_payload), timeout=25.0)"
    )


def test_place_order_timeout_raises_504_with_order_book_hint():
    body = _place_preset_body()
    # Capture the asyncio.TimeoutError handler that immediately follows
    # the place_order wait_for. Detect via proximity: handler must
    # raise HTTPException(504, ...) and mention "check your Groww order book".
    timeout_block = re.compile(
        r"api_\.place_order.*?except\s+asyncio\.TimeoutError[^:]*:\s*((?:[^\n]*\n\s*)+?)(?:except|raise\s+HTTPException\(status_code=502)",
        re.DOTALL,
    )
    m = timeout_block.search(body)
    assert m, "Missing `except asyncio.TimeoutError:` after place_order wait_for"
    handler_src = m.group(1)
    assert "504" in handler_src, (
        "place_order TimeoutError handler must raise HTTPException(status_code=504, ...). "
        f"handler=\n{handler_src}"
    )
    assert re.search(r"check\s+your\s+Groww\s+order\s+book", handler_src, re.IGNORECASE), (
        "place_order TimeoutError 504 message must mention 'check your Groww order book' so "
        "the user understands the order may or may not have been placed.\n"
        f"handler=\n{handler_src}"
    )


def test_place_order_timeout_logs_error():
    body = _place_preset_body()
    # logger.error (or .warning) inside the place_order TimeoutError handler
    timeout_block = re.compile(
        r"api_\.place_order.*?except\s+asyncio\.TimeoutError[^:]*:\s*((?:[^\n]*\n\s*)+?)(?:except|raise\s+HTTPException\(status_code=502)",
        re.DOTALL,
    )
    m = timeout_block.search(body)
    assert m, "Missing `except asyncio.TimeoutError:` after place_order wait_for"
    handler_src = m.group(1)
    assert re.search(r"logger\.(error|warning)\(", handler_src), (
        "place_order TimeoutError handler should log via logger.error/warning so we can "
        "trace persistent Groww-side hangs in production."
    )
