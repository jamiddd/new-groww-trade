"""Iter_18 static check: `_fetch_option_ltp` must use `_segment_for(exchange)`
and must NOT hardcode "FNO" for the segment argument passed to
api_.get_ltp / api_.get_quote.
"""
import ast
import os
import re
from pathlib import Path

SERVER = Path("/app/backend/server.py")


def _get_function_source(name: str) -> str:
    src = SERVER.read_text()
    tree = ast.parse(src)
    for node in ast.walk(tree):
        if isinstance(node, (ast.AsyncFunctionDef, ast.FunctionDef)) and node.name == name:
            return ast.get_source_segment(src, node) or ""
    raise AssertionError(f"function {name} not found")


def test_fetch_option_ltp_uses_segment_for():
    body = _get_function_source("_fetch_option_ltp")
    assert "segment = _segment_for(exchange)" in body, (
        "_fetch_option_ltp must compute segment via _segment_for(exchange); "
        "body=\n" + body
    )


def test_fetch_option_ltp_no_hardcoded_fno_literal():
    body = _get_function_source("_fetch_option_ltp")
    # No bare "FNO" string literal as a positional/keyword segment argument.
    # Comments mentioning FNO are fine; we only look at executable code lines.
    code_lines = [
        ln for ln in body.splitlines()
        if ln.strip() and not ln.strip().startswith("#")
    ]
    joined = "\n".join(code_lines)
    # Strip docstring-like triple-quoted blocks just in case.
    joined_no_docstr = re.sub(r'""".*?"""', "", joined, flags=re.S)
    assert '"FNO"' not in joined_no_docstr, (
        "_fetch_option_ltp still contains a hardcoded \"FNO\" string in code"
    )
    assert "'FNO'" not in joined_no_docstr, (
        "_fetch_option_ltp still contains a hardcoded 'FNO' string in code"
    )


def test_fetch_option_ltp_passes_segment_to_get_ltp_and_get_quote():
    body = _get_function_source("_fetch_option_ltp")
    # Both LTP and quote fallback must pass `segment` (the computed var).
    assert "api_.get_ltp" in body
    assert "api_.get_quote" in body
    # The same `segment` variable should be referenced after the api_.get_*
    # calls (it's threaded into the _call_blocking helper as the 3rd/4th arg).
    assert body.count("segment") >= 3, (
        "Expected `segment` variable to be threaded into both get_ltp and "
        "get_quote calls; body=\n" + body
    )


def test_segment_for_returns_commodity_for_mcx():
    # Sanity-import: importing server should not fail.
    import importlib
    import sys
    sys.path.insert(0, "/app/backend")
    server = importlib.import_module("server")
    GrowwAPI = server.GrowwAPI
    assert server._segment_for("MCX") == GrowwAPI.SEGMENT_COMMODITY
    assert server._segment_for("NSE") == GrowwAPI.SEGMENT_FNO
    assert server._segment_for("BSE") == GrowwAPI.SEGMENT_FNO
    assert server._segment_for("nfo") == GrowwAPI.SEGMENT_FNO
