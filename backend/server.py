"""
ScalpX backend — Groww options scalping API.

- Stateless authentication. The frontend sends the Groww access token in the
  `X-Groww-Token` header on every request; this server forwards it to Groww
  via the official `growwapi` SDK.
- The `/api/auth/login` endpoint accepts the user's Groww API key + API
  secret (TOTP base32 seed) and exchanges them for a daily access token.
- Presets are stored in MongoDB keyed by access token's client identity.
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import math
import os
import pickle
import random
import re
import threading
import time
import uuid
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional

import httpx
import pyotp
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives import hashes
import base64
import secrets
from dotenv import load_dotenv
from fastapi import APIRouter, Depends, FastAPI, Header, HTTPException
from growwapi import GrowwAPI
from motor.motor_asyncio import AsyncIOMotorClient
from pydantic import BaseModel, Field
from starlette.middleware.cors import CORSMiddleware

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger("scalpx")

# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------
mongo_url = os.environ["MONGO_URL"]
mongo_client = AsyncIOMotorClient(mongo_url)
db = mongo_client[os.environ["DB_NAME"]]

# ---------------------------------------------------------------------------
# Instrument-master cache
# ---------------------------------------------------------------------------
# Groww's get_all_instruments() returns a full CSV (~50 k rows). We cache it
# in memory for an hour, persist it to disk so warm restarts are instant,
# and serialise the cold-load behind a lock so a burst of concurrent
# requests doesn't trigger N parallel 50k-row downloads (which was a major
# source of the 502s the user reported).
_INSTRUMENTS_CACHE: Dict[str, Any] = {"loaded_at": 0.0, "df": None}
_INSTRUMENTS_TTL = 60 * 60  # 1h
_INSTRUMENTS_DISK_TTL = 6 * 60 * 60  # 6h — disk warm-start is "good enough"
# In docker, mount a volume at /var/scalpx-cache so the pickle survives
# `docker compose up --build`. Falls back to /tmp for local dev.
_SCALPX_CACHE_DIR = Path(os.environ.get("SCALPX_CACHE_DIR", "/tmp"))
try:
    _SCALPX_CACHE_DIR.mkdir(parents=True, exist_ok=True)
except Exception as exc:  # noqa: BLE001
    logger.warning("Could not create cache dir %s: %s", _SCALPX_CACHE_DIR, exc)
_INSTRUMENTS_DISK_PATH = _SCALPX_CACHE_DIR / "scalpx_instruments.pkl"
_INSTRUMENTS_LOCK = threading.Lock()


def _instruments_load_from_disk() -> bool:
    """Populate the in-memory cache from disk if a recent pickle exists.
    Returns True if a usable snapshot was loaded."""
    try:
        if not _INSTRUMENTS_DISK_PATH.exists():
            return False
        age = time.time() - _INSTRUMENTS_DISK_PATH.stat().st_mtime
        if age > _INSTRUMENTS_DISK_TTL:
            return False
        with _INSTRUMENTS_DISK_PATH.open("rb") as fh:
            df = pickle.load(fh)
        _INSTRUMENTS_CACHE["df"] = df
        # treat as fresh in-memory for a fraction of the TTL so the next
        # request still triggers a background refresh after a while.
        _INSTRUMENTS_CACHE["loaded_at"] = time.time() - max(0, _INSTRUMENTS_TTL // 2)
        logger.info("instruments: loaded %d rows from disk cache (age %ds)", len(df), int(age))
        return True
    except Exception as exc:  # noqa: BLE001
        logger.warning("instruments: disk cache load failed: %s", exc)
        return False


def _instruments_save_to_disk(df: Any) -> None:
    try:
        tmp = _INSTRUMENTS_DISK_PATH.with_suffix(".tmp")
        with tmp.open("wb") as fh:
            pickle.dump(df, fh, protocol=pickle.HIGHEST_PROTOCOL)
        tmp.replace(_INSTRUMENTS_DISK_PATH)
    except Exception as exc:  # noqa: BLE001
        logger.warning("instruments: disk cache write failed: %s", exc)


def _load_instruments(token: str):
    now = time.time()
    if _INSTRUMENTS_CACHE["df"] is not None and (now - _INSTRUMENTS_CACHE["loaded_at"]) < _INSTRUMENTS_TTL:
        return _INSTRUMENTS_CACHE["df"]
    # Single-flight: only one request triggers the cold load; concurrent
    # requests block briefly and reuse the result.
    with _INSTRUMENTS_LOCK:
        now = time.time()
        if _INSTRUMENTS_CACHE["df"] is not None and (now - _INSTRUMENTS_CACHE["loaded_at"]) < _INSTRUMENTS_TTL:
            return _INSTRUMENTS_CACHE["df"]
        try:
            api = GrowwAPI(token)
            df = api.get_all_instruments()
            _INSTRUMENTS_CACHE["df"] = df
            _INSTRUMENTS_CACHE["loaded_at"] = now
            _instruments_save_to_disk(df)
            logger.info("instruments: refreshed from Groww (%d rows)", len(df))
            return df
        except Exception as exc:  # noqa: BLE001
            logger.exception("Failed to load instruments: %s", exc)
            return _INSTRUMENTS_CACHE["df"]  # may be None


async def _load_instruments_async(token: str):
    """Async-friendly variant — runs the (potentially slow) cold load in a
    thread so the event loop stays responsive."""
    df = _INSTRUMENTS_CACHE["df"]
    if df is not None and (time.time() - _INSTRUMENTS_CACHE["loaded_at"]) < _INSTRUMENTS_TTL:
        return df
    return await asyncio.to_thread(_load_instruments, token)


# ---------------------------------------------------------------------------
# Per-token response cache for hot polling endpoints
# ---------------------------------------------------------------------------
# The frontend polls /account/margin, /account/positions and /orders/smart-orders
# every 5 s — but during navigation / quick re-mounts we routinely see 3-5
# concurrent connections fire those endpoints in the same 200 ms window.
# Without a coalescing cache, every burst translates into 9-15 simultaneous
# Groww calls and trips its server-side rate limiter (the user observed
# "Rate limit has breached for your request" with cascading 502s).
#
# A tiny per-token TTL+single-flight wrapper fixes that with no UX impact
# (1.5 s of staleness is unnoticeable for margin / positions / smart orders).
_RESPONSE_CACHE: Dict[tuple, Dict[str, Any]] = {}
_RESPONSE_LOCKS: Dict[tuple, asyncio.Lock] = {}


def _response_lock(key: tuple) -> asyncio.Lock:
    lock = _RESPONSE_LOCKS.get(key)
    if lock is None:
        lock = asyncio.Lock()
        _RESPONSE_LOCKS[key] = lock
    return lock


async def _cached_response(key: tuple, ttl: float, producer):
    """Return a cached response if fresh; otherwise call `producer()` once
    (other concurrent callers wait on the lock) and cache the result."""
    entry = _RESPONSE_CACHE.get(key)
    now = time.time()
    if entry and (now - entry["ts"]) < ttl:
        return entry["data"]
    async with _response_lock(key):
        entry = _RESPONSE_CACHE.get(key)
        now = time.time()
        if entry and (now - entry["ts"]) < ttl:
            return entry["data"]
        data = await producer()
        _RESPONSE_CACHE[key] = {"ts": time.time(), "data": data}
        if len(_RESPONSE_CACHE) > 256:
            # Drop the 64 oldest entries — cheap insurance against runaway growth.
            for k, _ in sorted(_RESPONSE_CACHE.items(), key=lambda kv: kv[1]["ts"])[:64]:
                _RESPONSE_CACHE.pop(k, None)
                _RESPONSE_LOCKS.pop(k, None)
        return data


def _invalidate_response_cache(token: str, *kinds: str) -> None:
    """Drop cached entries for this token — called after a state-mutating
    request (order placement, smart-order cancel, etc.) so the next poll
    sees fresh data."""
    for kind in kinds:
        _RESPONSE_CACHE.pop((kind, token), None)


# ---------------------------------------------------------------------------
# Auth helpers
# ---------------------------------------------------------------------------
async def require_token(x_groww_token: Optional[str] = Header(None)) -> str:
    if not x_groww_token:
        raise HTTPException(status_code=401, detail="Missing X-Groww-Token header")
    return x_groww_token


def _groww_client(token: str) -> GrowwAPI:
    """Return a cached GrowwAPI client for this access token.

    The growwapi SDK does a non-trivial amount of work on every
    `GrowwAPI(token)` construction (prints "Ready to Groww!" and primes a
    session), and the polling endpoints were instantiating a fresh client on
    every single request — ~10 req/s in production. Caching by token gives
    us a free 3-5× throughput boost and eliminates a recurring source of
    worker memory churn that was triggering gunicorn SIGKILLs on the
    Droplet.
    """
    cached = _GROWW_CLIENTS.get(token)
    if cached is not None:
        return cached
    with _GROWW_CLIENT_LOCK:
        cached = _GROWW_CLIENTS.get(token)
        if cached is not None:
            return cached
        try:
            client = GrowwAPI(token)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=401, detail=f"Invalid Groww token: {exc}") from exc
        # Cap the cache so a long-running process accumulating dozens of
        # rotated tokens doesn't leak unbounded memory.
        if len(_GROWW_CLIENTS) > 32:
            # Evict the oldest entry — token rotation is rare so this is fine.
            try:
                first_key = next(iter(_GROWW_CLIENTS))
                _GROWW_CLIENTS.pop(first_key, None)
            except StopIteration:  # noqa: PERF203
                pass
        _GROWW_CLIENTS[token] = client
        return client


_GROWW_CLIENTS: Dict[str, GrowwAPI] = {}
_GROWW_CLIENT_LOCK = threading.Lock()


async def _call_blocking(fn, *args, **kwargs):
    """Run a blocking growwapi call in a thread."""
    return await asyncio.to_thread(fn, *args, **kwargs)


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------
class LoginRequest(BaseModel):
    api_key: str
    api_secret: str  # TOTP base32 seed


class LoginResponse(BaseModel):
    access_token: str
    expires_hint: str = "Token expires daily at ~06:00 IST. Re-login if calls start failing."


class Preset(BaseModel):
    key: str  # breakout_mkt | breakout_chaser_lmt | steady_mkt | steady_lmt
    label: str
    strike_selection: str = "ATM"  # ATM | OTM1 | OTM2 | ITM1 | HIGH_GAMMA
    iv_filter: str = "ANY"  # LOW_IV | HIGH_IV | ANY
    position_sizing_pct: float = 25.0
    stop_loss_pct: float = 5.0
    take_profit_pct: float = 0.0  # 0 = no TP
    order_type: str = "MARKET"  # MARKET | LIMIT
    limit_offset_pct: float = 0.5  # for LMT presets, distance from LTP


DEFAULT_PRESETS: List[Preset] = [
    Preset(key="breakout_mkt", label="BUY BREAKOUT CALL MKT", strike_selection="HIGH_GAMMA", iv_filter="LOW_IV", position_sizing_pct=25.0, stop_loss_pct=5.0, take_profit_pct=10.0, order_type="MARKET"),
    Preset(key="breakout_chaser_lmt", label="BUY BREAKOUT CHASER CALL LMT", strike_selection="HIGH_GAMMA", iv_filter="LOW_IV", position_sizing_pct=25.0, stop_loss_pct=5.0, take_profit_pct=10.0, order_type="LIMIT", limit_offset_pct=0.5),
    Preset(key="steady_mkt", label="BUY STEADY CALL MKT", strike_selection="ATM", iv_filter="ANY", position_sizing_pct=20.0, stop_loss_pct=4.0, take_profit_pct=8.0, order_type="MARKET"),
    Preset(key="steady_lmt", label="BUY STEADY CALL LMT", strike_selection="ATM", iv_filter="ANY", position_sizing_pct=20.0, stop_loss_pct=4.0, take_profit_pct=8.0, order_type="LIMIT", limit_offset_pct=0.3),
]


class Settings(BaseModel):
    confirm_before_order: bool = True
    ask_max_loss_at_startup: bool = True
    convert_to_usd: bool = False
    save_last_underlying: bool = True
    last_underlying: Optional[str] = None
    last_underlying_expiry: Optional[str] = None  # YYYY-MM-DD
    # When True, the app ignores any sticky expiry and always selects
    # the closest (earliest future) expiry on launch and on every
    # underlying change. The user can still tap to switch within a
    # session — but the next reload/underlying-change resets to nearest.
    always_nearest_expiry: bool = False
    # Practice mode: every BUY uses exactly 1 lot regardless of the preset's
    # position-sizing %. Lets the user test the flow with minimal capital risk.
    practice_mode: bool = False


class PlacePresetOrderRequest(BaseModel):
    preset_key: str
    underlying: str  # e.g., NIFTY, BANKNIFTY, RELIANCE
    expiry: str  # YYYY-MM-DD
    option_type: str  # CE | PE
    exchange: str = "NSE"
    capital: float  # used for position sizing
    dry_run: bool = False
    # Sticky-price hook: when the confirmation dialog is up the frontend
    # polls the dry-run preview every few seconds and the user sees a
    # specific LIMIT price. To guarantee the order is placed at THAT exact
    # price (not whatever LTP × offset evaluates to milliseconds later on
    # the server), the frontend echoes the displayed price back on the
    # final confirm. Only honored for LIMIT orders.
    limit_price_override: Optional[float] = None


class ExitRequest(BaseModel):
    percent: int = 100  # 25 | 50 | 100
    trading_symbol: Optional[str] = None  # close just one position
    pnl_filter: Optional[str] = None  # "positive" | "negative"


# ---------------------------------------------------------------------------
# Encryption helpers for saved profiles
# ---------------------------------------------------------------------------
SERVER_PEPPER = os.environ.get("SCALPX_PEPPER")
if not SERVER_PEPPER:
    # Generate once and persist to a file so restarts don't invalidate stored
    # ciphertexts. This file is the equivalent of an HSM key for this demo.
    PEPPER_PATH = ROOT_DIR / ".pepper"
    if PEPPER_PATH.exists():
        SERVER_PEPPER = PEPPER_PATH.read_text().strip()
    else:
        SERVER_PEPPER = secrets.token_urlsafe(32)
        PEPPER_PATH.write_text(SERVER_PEPPER)


def _derive_key(secret: str, salt: bytes) -> bytes:
    kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt + SERVER_PEPPER.encode(), iterations=200_000)
    return kdf.derive(secret.encode())


def _encrypt(plaintext: str, secret: str) -> Dict[str, str]:
    salt = secrets.token_bytes(16)
    nonce = secrets.token_bytes(12)
    key = _derive_key(secret, salt)
    ct = AESGCM(key).encrypt(nonce, plaintext.encode(), None)
    return {
        "salt": base64.b64encode(salt).decode(),
        "nonce": base64.b64encode(nonce).decode(),
        "ciphertext": base64.b64encode(ct).decode(),
    }


def _decrypt(blob: Dict[str, str], secret: str) -> str:
    salt = base64.b64decode(blob["salt"])
    nonce = base64.b64decode(blob["nonce"])
    ct = base64.b64decode(blob["ciphertext"])
    key = _derive_key(secret, salt)
    return AESGCM(key).decrypt(nonce, ct, None).decode()


# ---------------------------------------------------------------------------
# Demo mode constants
# ---------------------------------------------------------------------------
DEMO_TOKEN = "DEMO__SCALPX__TOKEN"


def _is_demo(token: str) -> bool:
    return token == DEMO_TOKEN


def _demo_margin() -> Dict[str, Any]:
    return {
        "equity": {"available_cash": 134890.60, "net_margin_available": 134890.60},
        "used_margin": 0.0,
        "available_margin": 134890.60,
        "net_margin_available": 134890.60,
    }


_DEMO_SEED_POSITIONS = [
    {
        "trading_symbol": "NIFTY24700CE",
        "exchange": "NSE",
        "product": "NRML",
        "net_quantity": 75 * 27,
        "average_price": 145.80,
        "last_price": 155.85,
        "transaction_type": "BUY",
        "created_at": "2026-06-20 11:18:05",
    },
    {
        "trading_symbol": "NIFTY24800CE",
        "exchange": "NSE",
        "product": "NRML",
        "net_quantity": 75 * 27,
        "average_price": 150.80,
        "last_price": 158.00,
        "transaction_type": "BUY",
        "created_at": "2026-06-20 11:24:05",
    },
]


async def _demo_state_for(token: str) -> Dict[str, Any]:
    """Load (or seed) the per-user demo state from Mongo."""
    user_key = f"demo:{token}"
    doc = await db.demo_state.find_one({"_id": user_key})
    if not doc:
        doc = {
            "_id": user_key,
            "positions": [dict(p) for p in _DEMO_SEED_POSITIONS],
            "orders": [],
            "smart_orders": [],
        }
        await db.demo_state.insert_one(doc)
    # Backwards-compat: older demo docs may not have this key yet.
    doc.setdefault("smart_orders", [])
    return doc


def _recompute_position_pnl(p: Dict[str, Any]) -> Dict[str, Any]:
    """Mutate the position dict in place to refresh LTP / PnL with a small
    random walk so the home screen visibly changes on each refresh."""
    avg = float(p.get("average_price") or 0)
    qty = int(p.get("net_quantity") or 0)
    last = float(p.get("last_price") or avg or 1)
    # ±1.5% random walk, clamped > 0.1
    drift = random.uniform(-0.015, 0.015)
    last = max(0.1, round(last * (1 + drift), 2))
    p["last_price"] = last
    p["pnl"] = round((last - avg) * qty, 2)
    return p


def _demo_margin_base() -> float:
    """The opening day's balance for a demo account."""
    return 134890.60


async def _save_demo_state(token: str, doc: Dict[str, Any]) -> None:
    user_key = f"demo:{token}"
    await db.demo_state.update_one(
        {"_id": user_key},
        {"$set": {
            "positions": doc["positions"],
            "orders": doc.get("orders", []),
            "smart_orders": doc.get("smart_orders", []),
            "last_walk_ts": doc.get("last_walk_ts", 0),
        }},
        upsert=True,
    )


async def _demo_refresh_state(token: str) -> Dict[str, Any]:
    """Re-run the LTP/PnL random walk at most twice per second so margin +
    positions stay consistent within the same client fetch cycle. After
    each walk we also evaluate any active SL/TP smart-orders and auto-
    close positions whose LTP has crossed the trigger — this is what
    actually makes the bracket protection visible in demo mode."""
    doc = await _demo_state_for(token)
    now = time.time()
    last = doc.get("last_walk_ts", 0)
    if (now - last) >= 0.5:
        for p in doc["positions"]:
            _recompute_position_pnl(p)
        _check_demo_smart_order_triggers(doc)
        doc["last_walk_ts"] = now
        await _save_demo_state(token, doc)
    return doc


def _check_demo_smart_order_triggers(doc: Dict[str, Any]) -> None:
    """Walk active demo smart orders and, for each one whose underlying
    position has crossed its SL or TP trigger, close the position with a
    SELL order tagged with the trigger reason. Mutates `doc` in place.

    Trigger semantics (we currently only auto-buy long, so):
      • SL_HIT  → last_price <= sl_price  (the option dropped → bail)
      • TP_HIT  → last_price >= tp_price  (the option ran up → take profit)
    """
    smart_orders = doc.get("smart_orders", [])
    if not smart_orders:
        return
    by_symbol: Dict[str, List[Dict[str, Any]]] = {}
    for so in smart_orders:
        if so.get("status") != "ACTIVE":
            continue
        sym = so.get("trading_symbol")
        if sym:
            by_symbol.setdefault(sym, []).append(so)
    if not by_symbol:
        return

    for p in doc["positions"]:
        sym = p.get("trading_symbol")
        net_qty = int(p.get("net_quantity") or 0)
        if not sym or net_qty <= 0:
            continue
        active = by_symbol.get(sym, [])
        if not active:
            continue
        last = float(p.get("last_price") or 0)
        if last <= 0:
            continue

        triggered_reason: Optional[str] = None
        triggered_price: float = 0.0
        for so in active:
            tp = float(so.get("tp_price") or 0)
            sl = float(so.get("sl_price") or 0)
            if tp > 0 and last >= tp:
                triggered_reason = "TP_HIT"
                triggered_price = tp
                break
            if sl > 0 and last <= sl:
                triggered_reason = "SL_HIT"
                triggered_price = sl
                break
        if not triggered_reason:
            continue

        # Close the long: book a SELL for the full quantity, refresh PnL
        # using the trigger price (rather than the random-walk LTP) so the
        # numbers match what the user saw on the trigger row.
        avg = float(p.get("average_price") or 0)
        realised_pnl = round((triggered_price - avg) * net_qty, 2)
        p["last_price"] = triggered_price
        p["pnl"] = realised_pnl
        p["net_quantity"] = 0  # marks for sweep below

        doc.setdefault("orders", []).append({
            "order_id": f"demo-{uuid.uuid4().hex[:8]}",
            "trading_symbol": sym,
            "transaction_type": "SELL",
            "order_status": "EXECUTED",
            "quantity": net_qty,
            "filled_quantity": net_qty,
            "average_price": triggered_price,
            "order_type": "MARKET",
            "exchange_time": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S"),
            "trigger_reason": triggered_reason,
            "realised_pnl": realised_pnl,
        })

        # Mark every active smart order on this symbol as triggered
        # (whether SL or TP — since OCO cancels the other leg anyway).
        for so in active:
            so["status"] = "TRIGGERED"
            so["triggered_reason"] = triggered_reason
            so["triggered_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")

    # Sweep positions that just got fully closed by triggers.
    doc["positions"] = [p for p in doc["positions"] if int(p.get("net_quantity") or 0) != 0]


async def _demo_positions(token: str) -> Dict[str, Any]:
    doc = await _demo_refresh_state(token)
    return {"positions": [p for p in doc["positions"] if int(p.get("net_quantity") or 0) != 0]}


async def _demo_orders(token: str) -> Dict[str, Any]:
    doc = await _demo_state_for(token)
    return {"orders": list(reversed(doc.get("orders", [])))[:200]}


async def _demo_margin_payload(token: str) -> Dict[str, Any]:
    doc = await _demo_refresh_state(token)
    total_pnl = sum(float(p.get("pnl") or 0) for p in doc["positions"])
    balance = round(_demo_margin_base() + total_pnl, 2)
    return {
        "equity": {"available_cash": balance, "net_margin_available": balance},
        "used_margin": 0.0,
        "available_margin": balance,
        "net_margin_available": balance,
    }


def _demo_option_chain(underlying: str, expiry: str, exchange: str = "NSE") -> Dict[str, Any]:
    """Synthetic option chain for the demo token so the frontend can exercise
    the option-chain endpoint without live Groww credentials. Mirrors the
    ATM/step assumptions used by the demo place_preset_order path."""
    atm_map = {
        "NIFTY": 24700, "BANKNIFTY": 51100, "FINNIFTY": 23400,
        "MIDCPNIFTY": 12100, "SENSEX": 81500, "BANKEX": 58000,
    }
    atm_step_map = {
        "NIFTY": 50, "BANKNIFTY": 100, "FINNIFTY": 50,
        "MIDCPNIFTY": 50, "SENSEX": 100, "BANKEX": 100,
    }
    u = (underlying or "NIFTY").upper()
    atm = atm_map.get(u, 1000)
    step = atm_step_map.get(u, 50)
    rows: List[Dict[str, Any]] = []
    for i in range(-6, 7):
        strike = atm + i * step
        ce_intrinsic = max(0.0, atm - strike)
        pe_intrinsic = max(0.0, strike - atm)
        # Small deterministic-ish noise based on offset
        ce_ltp = round(ce_intrinsic + max(5.0, 40.0 - abs(i) * 4) + (abs(i) * 0.1), 2)
        pe_ltp = round(pe_intrinsic + max(5.0, 40.0 - abs(i) * 4) + (abs(i) * 0.1), 2)
        rows.append({
            "strike": strike,
            "strike_price": strike,
            "ce": {
                "trading_symbol": f"{u}{strike}CE",
                "last_price": ce_ltp,
                "ltp": ce_ltp,
                "implied_volatility": 14.0 + abs(i) * 0.3,
                "gamma": round(max(0.0, 0.012 - abs(i) * 0.001), 4),
            },
            "pe": {
                "trading_symbol": f"{u}{strike}PE",
                "last_price": pe_ltp,
                "ltp": pe_ltp,
                "implied_volatility": 14.5 + abs(i) * 0.3,
                "gamma": round(max(0.0, 0.012 - abs(i) * 0.001), 4),
            },
        })
    return {
        "underlying": u,
        "exchange": exchange,
        "expiry": expiry,
        "spot": atm,
        "option_chain": rows,
    }


def _demo_expiries(underlying: str = "NIFTY") -> Dict[str, Any]:
    """Return weekly + monthly expiries appropriate to the requested underlying.

    Reflects the SEBI rationalisation (Nov 2024 onwards):
      • One weekly per exchange — NSE keeps NIFTY (Tuesday), BSE keeps
        SENSEX (Thursday). All other indices (BANKNIFTY, FINNIFTY,
        MIDCPNIFTY, BANKEX) and all F&O stocks are monthly-only.
      • F&O stocks + NSE monthly indices expire on the last Thursday of
        the month; BSE indices (SENSEX/BANKEX monthlies) on the last
        Tuesday.
      • MCX commodities are monthly-only with a contract-specific
        calendar day (e.g. GOLD on the 5th, CRUDEOIL on the 18th).
    """
    u = (underlying or "").upper()
    today = datetime.now(timezone.utc).date()
    out: List[str] = []

    # --- WEEKLY block (only NIFTY + SENSEX have weeklies) -----------------
    weekly_weekday: Optional[int] = None  # 0=Mon … 6=Sun
    if u == "NIFTY":
        weekly_weekday = 1  # Tuesday
    elif u == "SENSEX":
        weekly_weekday = 3  # Thursday
    if weekly_weekday is not None:
        days_ahead = (weekly_weekday - today.weekday()) % 7
        for w in range(8):
            d = today + timedelta(days=days_ahead + 7 * w)
            out.append(d.isoformat())

    # --- MONTHLY block ----------------------------------------------------
    from calendar import monthrange

    # MCX commodities — fixed calendar day per contract (approximate).
    MCX_MONTH_DAY = {
        "GOLD": 5, "GOLDM": 5, "GOLDGUINEA": 5, "GOLDPETAL": 5,
        "SILVER": 5, "SILVERM": 28, "SILVERMIC": 28,
        "CRUDEOIL": 18, "CRUDEOILM": 18,
        "NATURALGAS": 25, "NATGASMINI": 25,
        "COPPER": 28, "ZINC": 28, "LEAD": 28,
        "NICKEL": 28, "ALUMINIUM": 28,
        "COTTON": 28, "MENTHAOIL": 28, "CARDAMOM": 28,
    }
    # Default monthly weekday: last Thursday (NSE F&O stocks + NSE
    # monthly indices). BSE monthly indices use last Tuesday.
    monthly_weekday = 1 if u in ("SENSEX", "BANKEX") else 3

    base = today.replace(day=1)
    for m in range(0, 6):  # current + next 5 months
        year = base.year + (base.month - 1 + m) // 12
        month = (base.month - 1 + m) % 12 + 1
        last_day = monthrange(year, month)[1]
        if u in MCX_MONTH_DAY:
            day = min(MCX_MONTH_DAY[u], last_day)
            d = datetime(year, month, day).date()
        else:
            d = datetime(year, month, last_day).date()
            while d.weekday() != monthly_weekday:
                d -= timedelta(days=1)
        if d >= today:
            iso = d.isoformat()
            if iso not in out:
                out.append(iso)

    return {"expiries": sorted(set(out))}


# ---------------------------------------------------------------------------
# App setup
# ---------------------------------------------------------------------------
app = FastAPI(title="ScalpX")
api = APIRouter(prefix="/api")


@api.get("/")
async def health() -> Dict[str, str]:
    return {"status": "ok", "service": "scalpx"}


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------
@api.post("/auth/login", response_model=LoginResponse)
async def login(payload: LoginRequest):
    # Demo shortcut — exposes a fully-functional UI without any Groww account.
    if payload.api_key.strip().lower() == "demo" and payload.api_secret.strip().lower() == "demo":
        return LoginResponse(access_token=DEMO_TOKEN)

    try:
        result = await _call_blocking(
            GrowwAPI.get_access_token,
            payload.api_key,
            None,
            payload.api_secret,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("Groww login failed: %s", exc)
        raise HTTPException(status_code=401, detail=f"Groww login failed: {exc}") from exc

    token = None
    if isinstance(result, dict):
        token = result.get("access_token") or result.get("token") or result.get("accessToken")
    if not token and isinstance(result, str):
        token = result
    if not token:
        raise HTTPException(status_code=502, detail=f"Unexpected Groww response: {result}")
    return LoginResponse(access_token=token)


@api.get("/auth/verify")
async def verify(token: str = Depends(require_token)):
    if _is_demo(token):
        return {"ok": True, "profile": {"user_id": "demo", "name": "Demo User"}}
    api_ = _groww_client(token)
    try:
        profile = await _call_blocking(api_.get_user_profile)
        return {"ok": True, "profile": profile}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=401, detail=f"Token invalid: {exc}") from exc


# ---------------------------------------------------------------------------
# Saved profiles (encrypted credentials)
# ---------------------------------------------------------------------------
class SaveProfileRequest(BaseModel):
    name: str
    api_key: str
    api_secret: str
    passphrase: Optional[str] = None  # required when save_mode == "passphrase"
    device_token: Optional[str] = None  # required when save_mode == "device"


class UnlockProfileRequest(BaseModel):
    passphrase: Optional[str] = None
    device_token: Optional[str] = None


def _key_preview(k: str) -> str:
    if len(k) <= 8:
        return k
    return f"{k[:4]}…{k[-4:]}"


@api.get("/auth/profiles")
async def list_profiles():
    cursor = db.profiles.find({}, {"_id": 0, "encrypted": 0})
    items: List[Dict[str, Any]] = []
    async for doc in cursor:
        items.append(doc)
    return {"items": items}


@api.post("/auth/profiles")
async def save_profile(payload: SaveProfileRequest):
    if not payload.passphrase and not payload.device_token:
        raise HTTPException(status_code=400, detail="passphrase or device_token required")
    secret = payload.passphrase or payload.device_token  # type: ignore[assignment]
    blob = _encrypt(f"{payload.api_key}\n{payload.api_secret}", secret)
    doc = {
        "id": str(uuid.uuid4()),
        "name": payload.name,
        "key_preview": _key_preview(payload.api_key),
        "mode": "passphrase" if payload.passphrase else "device",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "encrypted": blob,
    }
    await db.profiles.insert_one(doc)
    return {
        "id": doc["id"],
        "name": doc["name"],
        "key_preview": doc["key_preview"],
        "mode": doc["mode"],
        "created_at": doc["created_at"],
    }


@api.delete("/auth/profiles/{profile_id}")
async def delete_profile(profile_id: str):
    res = await db.profiles.delete_one({"id": profile_id})
    if res.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Profile not found")
    return {"ok": True}


@api.post("/auth/profiles/{profile_id}/unlock", response_model=LoginResponse)
async def unlock_profile(profile_id: str, payload: UnlockProfileRequest):
    doc = await db.profiles.find_one({"id": profile_id})
    if not doc:
        raise HTTPException(status_code=404, detail="Profile not found")
    secret = payload.passphrase or payload.device_token
    if not secret:
        raise HTTPException(status_code=400, detail="passphrase or device_token required")
    try:
        plaintext = _decrypt(doc["encrypted"], secret)
    except Exception:  # noqa: BLE001
        raise HTTPException(status_code=403, detail="Wrong passphrase or device token")
    parts = plaintext.split("\n", 1)
    if len(parts) != 2:
        raise HTTPException(status_code=500, detail="Corrupt profile payload")
    api_key, api_secret = parts
    # Demo profile shortcut
    if api_key.strip().lower() == "demo" and api_secret.strip().lower() == "demo":
        return LoginResponse(access_token=DEMO_TOKEN)
    try:
        result = await _call_blocking(GrowwAPI.get_access_token, api_key, None, api_secret)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=401, detail=f"Groww login failed: {exc}") from exc
    token = None
    if isinstance(result, dict):
        token = result.get("access_token") or result.get("token") or result.get("accessToken")
    if not token and isinstance(result, str):
        token = result
    if not token:
        raise HTTPException(status_code=502, detail=f"Unexpected Groww response: {result}")
    return LoginResponse(access_token=token)


# ---------------------------------------------------------------------------
# Server outbound IP (for Groww IP-whitelist UI)
# ---------------------------------------------------------------------------
_IP_CACHE: Dict[str, Any] = {"ts": 0.0, "ip": None}


@api.get("/auth/server-ip")
async def server_ip():
    now = time.time()
    if _IP_CACHE["ip"] and (now - _IP_CACHE["ts"]) < 3600:
        return {"ip": _IP_CACHE["ip"], "cached": True}
    for url in ("https://api.ipify.org?format=json", "https://ifconfig.me/ip"):
        try:
            async with httpx.AsyncClient(timeout=5) as cli:
                resp = await cli.get(url)
                if resp.status_code == 200:
                    ip = resp.json().get("ip") if "ipify" in url else resp.text.strip()
                    if ip:
                        _IP_CACHE["ip"] = ip
                        _IP_CACHE["ts"] = now
                        return {"ip": ip, "cached": False}
        except Exception:  # noqa: BLE001
            continue
    return {"ip": "unknown", "cached": False}


# ---------------------------------------------------------------------------
# Account
# ---------------------------------------------------------------------------
def _find_numeric_by_keys(obj: Any, key_subs: List[str]) -> Optional[float]:
    """Recursively search a dict/list for a numeric value whose key (any
    parent in the path is fine) contains any of the given substrings."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            if isinstance(v, (int, float)) and any(s in k.lower() for s in key_subs):
                try:
                    return float(v)
                except Exception:  # noqa: BLE001
                    pass
        for v in obj.values():
            r = _find_numeric_by_keys(v, key_subs)
            if r is not None:
                return r
    elif isinstance(obj, list):
        for v in obj:
            r = _find_numeric_by_keys(v, key_subs)
            if r is not None:
                return r
    return None


def _sum_numeric_by_keys(obj: Any, key_subs: List[str]) -> float:
    """Recursively sum every numeric value whose key contains any of the
    given substrings. Used to roll up cash/used/collateral across the
    multiple per-segment buckets Groww's `/margins/detail/user` returns
    (`equity_margin_details`, `commodity_margin_details`, ...)."""
    total = 0.0
    if isinstance(obj, dict):
        for k, v in obj.items():
            if isinstance(v, (int, float)) and any(s in k.lower() for s in key_subs):
                try:
                    total += float(v)
                except Exception:  # noqa: BLE001
                    pass
            else:
                total += _sum_numeric_by_keys(v, key_subs)
    elif isinstance(obj, list):
        for v in obj:
            total += _sum_numeric_by_keys(v, key_subs)
    return total


def _compute_total_trading_balance(margin_data: Any) -> Dict[str, float]:
    """Resolve the user's full trading capital from a `get_available_margin
    _details` response. We need to add together every bucket — free cash +
    blocked margin + pledged/collateral — across every segment, because
    that's the number Groww's mobile app shows as 'Total trading balance'.

    Returns {available, used, collateral, total}.
    """
    if not isinstance(margin_data, (dict, list)):
        return {"available": 0.0, "used": 0.0, "collateral": 0.0, "total": 0.0}

    # Sum ALL leaf numeric values whose key suggests cash / used / collateral.
    # These substrings cover every Groww field name observed so far:
    available = _sum_numeric_by_keys(
        margin_data,
        ["clear_cash", "available_cash", "cash_available"],
    )
    used = _sum_numeric_by_keys(
        margin_data, ["net_margin_used", "margin_used", "utilised"],
    )
    collateral = _sum_numeric_by_keys(
        margin_data, ["collateral_value", "collateral_available"],
    )
    total = available + used + collateral
    return {
        "available": round(available, 2),
        "used": round(used, 2),
        "collateral": round(collateral, 2),
        "total": round(total, 2),
    }


def _user_key(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()[:24]


@api.get("/account/margin")
async def margin(token: str = Depends(require_token)):
    if _is_demo(token):
        data = await _demo_margin_payload(token)
        data["opening_capital_today"] = _demo_margin_base()
        return data

    async def _produce():
        api_ = _groww_client(token)
        try:
            # Hard 8 s cap so a slow/hanging Groww call can never block a gunicorn
            # worker into the 30 s default kill timeout — that was the root cause
            # of the periodic SIGKILL "Perhaps out of memory?" lines on the
            # Droplet under polling load.
            data = await asyncio.wait_for(
                _call_blocking(api_.get_available_margin_details),
                timeout=8.0,
            )
        except asyncio.TimeoutError:
            raise HTTPException(status_code=504, detail="Groww margin fetch timed out") from None
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=502, detail=str(exc)) from exc

        # Defensive: roll up every cash/used/collateral bucket across every
        # segment Groww returns. Single-bucket extraction was missing parts of
        # the user's actual capital, which is what caused the visible mismatch.
        summary = _compute_total_trading_balance(data)
        total_now = summary["total"]
        logger.info(
            "margin extract: avail=%s used=%s collateral=%s total=%s",
            summary["available"], summary["used"], summary["collateral"], total_now,
        )

        today_iso = datetime.now(timezone.utc).date().isoformat()
        user_key = _user_key(token)
        snap = await db.opening_capital.find_one({"user": user_key, "date": today_iso}, {"_id": 0})
        if not snap and total_now > 0:
            snap = {"user": user_key, "date": today_iso, "capital": total_now}
            await db.opening_capital.insert_one(snap)
        opening = float(snap["capital"]) if snap else total_now

        if isinstance(data, dict):
            data["opening_capital_today"] = opening
            # Canonical fields the frontend reads:
            # `available_margin` is the LIVE total balance (sum of all buckets);
            # `used_margin` is what's currently blocked. PnL today = total - opening.
            data["available_margin"] = total_now
            data["used_margin"] = summary["used"]
            data["collateral"] = summary["collateral"]
            data["available_cash"] = summary["available"]
            data["total_balance"] = total_now
        return data

    # 1.5 s response cache — absorbs concurrent polling bursts (5 tabs ×
    # /account/margin in the same 200 ms window → 1 Groww call instead of 5)
    # without making the UI feel stale.
    return await _cached_response(("margin", token), 1.5, _produce)


@api.post("/account/refresh-capital")
async def refresh_capital(token: str = Depends(require_token)):
    """Clear today's opening-capital snapshot so the next margin call
    re-snapshots from Groww. Useful when the user notices the displayed
    Capital value is wrong (e.g. they topped up their account, or the very
    first call of the day caught a partial response)."""
    if _is_demo(token):
        return {"ok": True, "demo": True}
    today_iso = datetime.now(timezone.utc).date().isoformat()
    await db.opening_capital.delete_many({"user": _user_key(token), "date": today_iso})
    # Drop the cached margin payload so the next poll re-snapshots immediately.
    _invalidate_response_cache(token, "margin")
    return {"ok": True}


# ---------------------------------------------------------------------------
# Bootstrap — single parallel fetch for app startup
# ---------------------------------------------------------------------------
@api.get("/bootstrap")
async def bootstrap(token: str = Depends(require_token)):
    """Single endpoint the frontend calls ONCE at app open. Returns
    margin + positions + first page of orders + active smart orders, all
    fetched in parallel. Frontend then runs in a "client-driven" mode:
      • client polls only /api/ltp/batch every second for live LTPs
      • client computes positions P&L locally from {entry, ltp, qty}
      • client appends to its local order book on each successful place
    Net effect: ~1 Groww round-trip every 5 s (the LTP batch) instead of
    ~3 round-trips every 5 s (margin+positions+smart-orders) — and ZERO
    round-trips during steady-state navigation.
    """
    # Call the existing handlers in parallel — they each have their own
    # short response cache so the bootstrap is cheap if the user
    # bounces between login/home.
    async def _safe_margin():
        try:
            return await margin(token=token)
        except HTTPException as exc:
            return {"error": exc.detail, "status_code": exc.status_code}

    async def _safe_positions():
        try:
            return await positions(token=token)
        except HTTPException as exc:
            return {"positions": [], "error": exc.detail}

    async def _safe_orders():
        try:
            return await orders_history(page=0, page_size=50, token=token)
        except HTTPException as exc:
            return {"orders": [], "error": exc.detail}

    async def _safe_smart_orders():
        try:
            return await list_smart_orders(token=token)
        except HTTPException as exc:
            return {"items": [], "error": exc.detail}

    m, p, o, so = await asyncio.gather(
        _safe_margin(), _safe_positions(), _safe_orders(), _safe_smart_orders(),
    )
    return {
        "margin": m,
        "positions": p,
        "orders": o,
        "smart_orders": so,
        "server_time": datetime.now(timezone.utc).isoformat(),
    }


# ---------------------------------------------------------------------------
# Batch LTP — the only endpoint polled in steady state
# ---------------------------------------------------------------------------
class LtpQuery(BaseModel):
    trading_symbol: str
    exchange: str = "NSE"
    # Optional override; defaults to FNO for indices/stocks, COMMODITY for MCX.
    segment: Optional[str] = None


class LtpBatchRequest(BaseModel):
    items: List[LtpQuery]


@api.post("/ltp/batch")
async def ltp_batch(payload: LtpBatchRequest, token: str = Depends(require_token)):
    """Fan-out LTP fetch for a list of trading symbols. Returns
    `{trading_symbol: ltp}` keyed by the input symbol. Designed to be hit
    every 1 s by the frontend while positions are open or the confirm
    dialog is visible.
    """
    if not payload.items:
        return {"ltps": {}}

    # Demo mode: synthesize prices deterministically with a tiny random walk
    # so the user can see P&L move in the UI even without live creds.
    if _is_demo(token):
        out: Dict[str, float] = {}
        for q in payload.items:
            # Seed the price by symbol hash so it's stable-ish across polls.
            seed = sum(ord(c) for c in q.trading_symbol)
            base = 50 + (seed % 250)
            jitter = random.uniform(-1.5, 1.5)
            out[q.trading_symbol] = round(base + jitter, 2)
        return {"ltps": out}

    api_ = _groww_client(token)

    async def _one(q: LtpQuery) -> tuple:
        sym = f"{q.exchange}_{q.trading_symbol}"
        seg = q.segment or _segment_for(q.exchange)
        try:
            data = await asyncio.wait_for(
                _call_blocking(api_.get_ltp, (sym,), seg),
                timeout=4.0,
            )
            ltp = (
                _find_numeric_by_keys(data, ["ltp", "last_price", "last_traded_price", "price"])
                or _first_positive_numeric(data)
            )
            return (q.trading_symbol, float(ltp) if ltp else 0.0)
        except asyncio.TimeoutError:
            logger.warning("ltp batch timeout for %s", q.trading_symbol)
            return (q.trading_symbol, 0.0)
        except Exception as exc:  # noqa: BLE001
            logger.debug("ltp batch failed %s: %s", q.trading_symbol, exc)
            return (q.trading_symbol, 0.0)

    # Fan out — Groww allows ~3 req/s, so cap concurrency at 6 to absorb
    # bursts without tripping their rate limiter. semaphore is local.
    semaphore = asyncio.Semaphore(6)

    async def _bounded(q: LtpQuery):
        async with semaphore:
            return await _one(q)

    pairs = await asyncio.gather(*(_bounded(q) for q in payload.items))
    return {"ltps": dict(pairs)}


# ---------------------------------------------------------------------------
# Incremental orders — delta sync since a known order id
# ---------------------------------------------------------------------------
@api.get("/orders/since")
async def orders_since(after_id: Optional[str] = None, token: str = Depends(require_token)):
    """Return only the orders newer than `after_id`. Used by the frontend
    to keep its local AsyncStorage order log in sync without re-downloading
    the entire history on every pull-to-refresh."""
    full = await orders_history(page=0, page_size=50, token=token)
    orders_list: List[Dict[str, Any]] = full.get("orders", [])
    if not after_id:
        return {"orders": orders_list, "delta": False}
    delta: List[Dict[str, Any]] = []
    for o in orders_list:
        oid = o.get("groww_order_id") or o.get("order_id") or o.get("id")
        if oid == after_id:
            break
        delta.append(o)
    return {"orders": delta, "delta": True}


def _merge_position_lists(*sources: Any) -> Dict[str, Any]:
    """Concatenate position arrays from multiple Groww segment responses
    (FNO + CASH) into a single normalised payload."""
    merged: List[Dict[str, Any]] = []
    for s in sources:
        items: List[Dict[str, Any]] = []
        if isinstance(s, dict):
            items = (
                s.get("positions")
                or s.get("position_list")
                or s.get("data")
                or s.get("items")
                or []
            )
            if isinstance(items, dict):
                items = items.get("positions") or items.get("position_list") or []
        elif isinstance(s, list):
            items = s
        for item in items:
            if isinstance(item, dict):
                merged.append(item)
    return {"positions": merged}


def _merge_order_lists(*sources: Any) -> Dict[str, Any]:
    """Concatenate order arrays from multiple Groww segment responses,
    sorted by exchange_time / created_at descending so the newest order
    is on top — regardless of which segment it came from."""
    merged: List[Dict[str, Any]] = []
    for s in sources:
        items: List[Dict[str, Any]] = []
        if isinstance(s, dict):
            # Groww has used several different envelope keys over time —
            # be liberal about which one carries the order array so we
            # don't silently render an empty list.
            items = (
                s.get("orders")
                or s.get("order_list")
                or s.get("data")
                or s.get("items")
                or s.get("result")
                or []
            )
            # Some responses wrap the array one level deeper.
            if isinstance(items, dict):
                items = (
                    items.get("orders")
                    or items.get("order_list")
                    or items.get("items")
                    or items.get("data")
                    or []
                )
        elif isinstance(s, list):
            items = s
        for item in items:
            if isinstance(item, dict):
                merged.append(item)
    def _ts(o: Dict[str, Any]) -> str:
        return str(
            o.get("exchange_time")
            or o.get("order_creation_time")
            or o.get("created_at")
            or o.get("created_on")
            or o.get("order_time")
            or ""
        )
    merged.sort(key=_ts, reverse=True)
    return {"orders": merged}


@api.get("/account/positions")
async def positions(token: str = Depends(require_token)):
    if _is_demo(token):
        return await _demo_positions(token)

    async def _produce():
        api_ = _groww_client(token)
        # Fetch open positions from every segment so a position the user
        # opened via the regular Groww app (e.g. an equity buy in CASH segment)
        # also shows up here. Each call is independent — a 502 from one
        # shouldn't black-hole the others.
        async def _safe(segment: str) -> Any:
            try:
                return await asyncio.wait_for(
                    _call_blocking(api_.get_positions_for_user, segment),
                    timeout=8.0,
                )
            except asyncio.TimeoutError:
                logger.warning("positions fetch (%s) timed out", segment)
                return None
            except Exception as exc:  # noqa: BLE001
                logger.warning("positions fetch (%s) failed: %s", segment, exc)
                return None

        # Fan out across segments in parallel so the worst-case latency is one
        # 8 s timeout instead of N×8 s if Groww hangs on a single segment.
        fno, cash = await asyncio.gather(
            _safe(GrowwAPI.SEGMENT_FNO),
            _safe(GrowwAPI.SEGMENT_CASH),
        )
        return _merge_position_lists(fno, cash)

    return await _cached_response(("positions", token), 1.5, _produce)


@api.get("/account/orders")
async def orders_history(page: int = 0, page_size: int = 50, token: str = Depends(require_token)):
    if _is_demo(token):
        return await _demo_orders(token)
    api_ = _groww_client(token)
    async def _safe(segment: Optional[str]) -> Any:
        try:
            # The SDK only forwards `segment` and `page` to Groww's API
            # — page_size is ignored — but we keep the kwarg so the
            # signature stays explicit. 8 s cap so one slow segment can't
            # block the worker into a gunicorn SIGKILL.
            return await asyncio.wait_for(
                _call_blocking(api_.get_order_list, page, page_size, segment),
                timeout=8.0,
            )
        except asyncio.TimeoutError:
            logger.warning("order_list fetch (%s) timed out", segment)
            return None
        except Exception as exc:  # noqa: BLE001
            logger.warning("order_list fetch (%s) failed: %s", segment, exc)
            return None

    # Try every relevant source. Groww's /order/list returns the user's
    # full order book when called WITHOUT a segment param — but some
    # accounts only get the active page filtered by segment. So we
    # combine: ALL + FNO + CASH + COMMODITY and dedupe by groww_order_id
    # below. Run them in PARALLEL via asyncio.gather — otherwise we'd
    # serialize 4 round-trips and the /account/orders page would feel
    # painfully slow on every refresh (was ~6-12s, now ~2-3s).
    no_segment, fno, cash, comm = await asyncio.gather(
        _safe(None),
        _safe(GrowwAPI.SEGMENT_FNO),
        _safe(GrowwAPI.SEGMENT_CASH),
        _safe(GrowwAPI.SEGMENT_COMMODITY),
    )

    merged = _merge_order_lists(no_segment, fno, cash, comm)
    # Dedupe — when both a no-segment and per-segment fetch return the
    # same order, keep the first occurrence. Groww's canonical id is
    # `groww_order_id`; older payloads / our demo layer use `order_id`.
    seen: set = set()
    unique: List[Dict[str, Any]] = []
    for o in merged.get("orders", []):
        oid = o.get("groww_order_id") or o.get("order_id") or o.get("id")
        if oid and oid in seen:
            continue
        if oid:
            seen.add(oid)
        unique.append(o)
    return {"orders": unique}


# ---------------------------------------------------------------------------
# Instruments
# ---------------------------------------------------------------------------
INDEX_UNDERLYINGS = [
    {"symbol": "NIFTY", "name": "NIFTY 50", "type": "INDEX"},
    {"symbol": "BANKNIFTY", "name": "BANK NIFTY", "type": "INDEX"},
    {"symbol": "FINNIFTY", "name": "FIN NIFTY", "type": "INDEX"},
    {"symbol": "MIDCPNIFTY", "name": "MIDCAP NIFTY", "type": "INDEX"},
    {"symbol": "SENSEX", "name": "SENSEX", "type": "INDEX"},
    {"symbol": "BANKEX", "name": "BANKEX", "type": "INDEX"},
]

# F&O stock universe (NSE) — used as a fallback when the Groww instrument
# master CSV is unavailable, and as the canonical demo list. Curated from the
# NSE F&O-eligible securities list (Jan 2026).
FNO_STOCKS = [
    "ABB", "ABBOTINDIA", "ABCAPITAL", "ABFRL", "ACC", "ADANIENT", "ADANIPORTS",
    "ALKEM", "AMBUJACEM", "APOLLOHOSP", "APOLLOTYRE", "ASHOKLEY", "ASIANPAINT",
    "ASTRAL", "ATUL", "AUBANK", "AUROPHARMA", "AXISBANK", "BAJAJ-AUTO",
    "BAJAJFINSV", "BAJFINANCE", "BALKRISIND", "BANDHANBNK", "BANKBARODA",
    "BATAINDIA", "BEL", "BERGEPAINT", "BHARATFORG", "BHARTIARTL", "BHEL",
    "BIOCON", "BOSCHLTD", "BPCL", "BRITANNIA", "BSE", "BSOFT", "CANBK",
    "CANFINHOME", "CDSL", "CHAMBLFERT", "CHOLAFIN", "CIPLA", "COALINDIA",
    "COFORGE", "COLPAL", "CONCOR", "COROMANDEL", "CROMPTON", "CUB", "CUMMINSIND",
    "DABUR", "DALBHARAT", "DEEPAKNTR", "DELHIVERY", "DIVISLAB", "DIXON",
    "DLF", "DRREDDY", "EICHERMOT", "ESCORTS", "EXIDEIND", "FEDERALBNK",
    "GAIL", "GLENMARK", "GMRINFRA", "GNFC", "GODREJCP", "GODREJPROP",
    "GRANULES", "GRASIM", "HAL", "HAVELLS", "HCLTECH", "HDFCAMC", "HDFCBANK",
    "HDFCLIFE", "HEROMOTOCO", "HFCL", "HINDALCO", "HINDCOPPER", "HINDPETRO",
    "HINDUNILVR", "ICICIBANK", "ICICIGI", "ICICIPRULI", "IDEA", "IDFCFIRSTB",
    "IEX", "IGL", "INDHOTEL", "INDIAMART", "INDIGO", "INDUSINDBK", "INDUSTOWER",
    "INFY", "IOC", "IPCALAB", "IRCTC", "IRFC", "ITC", "JINDALSTEL",
    "JIOFIN", "JKCEMENT", "JSL", "JSWSTEEL", "JUBLFOOD", "KOTAKBANK",
    "L&TFH", "LALPATHLAB", "LAURUSLABS", "LICHSGFIN", "LICI", "LT", "LTIM",
    "LTTS", "LUPIN", "M&M", "M&MFIN", "MANAPPURAM", "MARICO", "MARUTI",
    "MAXHEALTH", "MCX", "METROPOLIS", "MFSL", "MGL", "MOTHERSON", "MPHASIS",
    "MRF", "MUTHOOTFIN", "NATIONALUM", "NAUKRI", "NAVINFLUOR", "NESTLEIND",
    "NMDC", "NTPC", "OBEROIRLTY", "OFSS", "ONGC", "PAGEIND", "PAYTM",
    "PEL", "PERSISTENT", "PETRONET", "PFC", "PIDILITIND", "PIIND",
    "PNB", "POLICYBZR", "POLYCAB", "POWERGRID", "PVRINOX", "RAMCOCEM",
    "RBLBANK", "RECLTD", "RELIANCE", "SAIL", "SBICARD", "SBILIFE", "SBIN",
    "SHREECEM", "SHRIRAMFIN", "SIEMENS", "SRF", "SUNPHARMA", "SUNTV",
    "SYNGENE", "TATACHEM", "TATACOMM", "TATACONSUM", "TATAMOTORS", "TATAPOWER",
    "TATASTEEL", "TCS", "TECHM", "TIINDIA", "TITAN", "TORNTPHARM", "TORNTPOWER",
    "TRENT", "TVSMOTOR", "UBL", "ULTRACEMCO", "UNITDSPR", "UPL", "VEDL",
    "VOLTAS", "WIPRO", "ZEEL", "ZYDUSLIFE",
]
FNO_STOCK_ITEMS = [{"symbol": s, "name": s, "type": "STOCK", "exchange": "NSE"} for s in FNO_STOCKS]


def _segment_for(exchange: str) -> str:
    """Return the Groww segment constant matching a target exchange.

    MCX commodity options live under SEGMENT_COMMODITY — NOT SEGMENT_FNO.
    Hardcoding FNO everywhere caused option-chain lookups + order placement
    to silently fail for every commodity (GOLD, SILVER, CRUDEOIL, etc.).
    """
    ex = (exchange or "").upper()
    if ex == "MCX":
        return GrowwAPI.SEGMENT_COMMODITY
    return GrowwAPI.SEGMENT_FNO

# MCX commodities universe — used for commodity option trading (Indian
# Multi Commodity Exchange). Curated from the actively-traded list (Jun 2026).
MCX_COMMODITIES = [
    {"symbol": "GOLD", "name": "GOLD", "type": "COMMODITY"},
    {"symbol": "GOLDM", "name": "GOLD MINI", "type": "COMMODITY"},
    {"symbol": "SILVER", "name": "SILVER", "type": "COMMODITY"},
    {"symbol": "SILVERM", "name": "SILVER MINI", "type": "COMMODITY"},
    {"symbol": "CRUDEOIL", "name": "CRUDE OIL", "type": "COMMODITY"},
    {"symbol": "CRUDEOILM", "name": "CRUDE OIL MINI", "type": "COMMODITY"},
    {"symbol": "NATURALGAS", "name": "NATURAL GAS", "type": "COMMODITY"},
    {"symbol": "NATGASMINI", "name": "NATURAL GAS MINI", "type": "COMMODITY"},
    {"symbol": "COPPER", "name": "COPPER", "type": "COMMODITY"},
    {"symbol": "ZINC", "name": "ZINC", "type": "COMMODITY"},
    {"symbol": "LEAD", "name": "LEAD", "type": "COMMODITY"},
    {"symbol": "NICKEL", "name": "NICKEL", "type": "COMMODITY"},
    {"symbol": "ALUMINIUM", "name": "ALUMINIUM", "type": "COMMODITY"},
    {"symbol": "COTTON", "name": "COTTON", "type": "COMMODITY"},
    {"symbol": "MENTHAOIL", "name": "MENTHA OIL", "type": "COMMODITY"},
    {"symbol": "CARDAMOM", "name": "CARDAMOM", "type": "COMMODITY"},
]
MCX_COMMODITY_ITEMS = [{**c, "exchange": "MCX"} for c in MCX_COMMODITIES]

# Decorate index list with exchange (BSE for SENSEX/BANKEX, else NSE).
INDEX_UNDERLYINGS = [
    {**i, "exchange": "BSE" if i["symbol"] in ("SENSEX", "BANKEX") else "NSE"}
    for i in INDEX_UNDERLYINGS
]


@api.get("/instruments/underlyings")
async def underlyings(q: str = "", token: str = Depends(require_token)):
    """Searchable list of F&O underlyings (indices + stocks + MCX commodities)."""
    if _is_demo(token):
        results = list(INDEX_UNDERLYINGS) + list(FNO_STOCK_ITEMS) + list(MCX_COMMODITY_ITEMS)
        if q:
            qu = q.upper()
            results = [r for r in results if qu in r["symbol"].upper() or qu in r["name"].upper()]
        return {"items": results[:300]}
    df = await _load_instruments_async(token)
    results: List[Dict[str, Any]] = list(INDEX_UNDERLYINGS)
    if df is not None:
        try:
            mask = (
                df["segment"].astype(str).str.upper().isin(["FNO", "F&O"])
                & df["instrument_type"].astype(str).str.upper().isin(["OPTSTK", "OPTIDX", "FUTSTK", "FUTIDX"])
            )
            sub = df[mask]
            underlying_col = "underlying_symbol" if "underlying_symbol" in sub.columns else "name"
            unique = sorted(set(sub[underlying_col].dropna().astype(str).tolist()))
            existing = {u["symbol"] for u in results}
            for sym in unique:
                if sym and sym not in existing:
                    results.append({"symbol": sym, "name": sym, "type": "STOCK", "exchange": "NSE"})
        except Exception as exc:  # noqa: BLE001
            logger.warning("Underlying search fallback: %s", exc)
    # Fallback: if the instrument-master couldn't be loaded, append the curated list.
    if len(results) <= len(INDEX_UNDERLYINGS):
        existing = {u["symbol"] for u in results}
        for item in FNO_STOCK_ITEMS:
            if item["symbol"] not in existing:
                results.append(item)

    # Always append MCX commodities — they are a separate exchange the
    # instrument-master usually doesn't surface in the F&O segment.
    existing = {u["symbol"] for u in results}
    for item in MCX_COMMODITY_ITEMS:
        if item["symbol"] not in existing:
            results.append(item)

    if q:
        qu = q.upper()
        results = [r for r in results if qu in r["symbol"].upper() or qu in r["name"].upper()]
    return {"items": results[:300]}


def _extract_iso_dates(obj: Any) -> List[str]:
    """Walk any nested dict/list and collect strings that look like ISO dates."""
    out: List[str] = []
    iso_re = re.compile(r"^\d{4}-\d{2}-\d{2}")
    if isinstance(obj, str):
        if iso_re.match(obj):
            out.append(obj[:10])
    elif isinstance(obj, list):
        for x in obj:
            out.extend(_extract_iso_dates(x))
    elif isinstance(obj, dict):
        for v in obj.values():
            out.extend(_extract_iso_dates(v))
    return out


def _live_expiries_from_master(token: str, underlying: str, exchange: str) -> List[str]:
    """Scan the Groww instrument master for the upcoming option expiries of an
    underlying. `get_expiries` is historical-only, so this is the only way to
    surface the live weekly + monthly calendar (e.g., the next NIFTY Tuesday
    weekly).
    """
    df = _load_instruments(token)
    if df is None:
        logger.warning("instrument master not loaded; cannot scan expiries")
        return []
    try:
        u = underlying.upper()
        ex = exchange.upper()
        # Groww's master historically uses `NSE`/`BSE` directly, but some
        # vintages use the segment-tagged variants. Accept all of them so
        # SENSEX (BSE) and GOLD (MCX) don't accidentally collide with NIFTY.
        ex_aliases = {
            "NSE": {"NSE", "NFO", "NSEFO", "NSE_FO", "NSE-FNO"},
            "BSE": {"BSE", "BFO", "BSEFO", "BSE_FO", "BSE-FNO"},
            "MCX": {"MCX", "MCXFO", "MCX_FO", "MCX-COMM", "COMM", "COMMODITY"},
        }.get(ex, {ex})

        cols_lower = {c.lower(): c for c in df.columns}
        underlying_col = (
            cols_lower.get("underlying_symbol")
            or cols_lower.get("underlying")
            or cols_lower.get("trading_symbol")
            or cols_lower.get("symbol")
            or cols_lower.get("name")
        )
        type_col = (
            cols_lower.get("instrument_type")
            or cols_lower.get("type")
            or cols_lower.get("segment")
        )
        exch_col = cols_lower.get("exchange")
        expiry_col = (
            cols_lower.get("expiry_date")
            or cols_lower.get("expiry")
            or cols_lower.get("expiry_dt")
        )
        if not underlying_col or not expiry_col:
            logger.warning(
                "instrument master missing keys: underlying_col=%s expiry_col=%s columns=%s",
                underlying_col, expiry_col, list(df.columns),
            )
            return []

        # ── Exchange filter first ─────────────────────────────────────────
        # Doing this BEFORE the underlying filter prevents an NSE row whose
        # trading-symbol happens to start with "SENSEX" from polluting a
        # BSE query (and vice-versa for MCX).
        scope = df
        if exch_col is not None:
            scope_filtered = df[df[exch_col].astype(str).str.upper().isin(ex_aliases)]
            if not scope_filtered.empty:
                scope = scope_filtered
            else:
                logger.warning(
                    "no rows for exchange=%s (aliases=%s) in column=%s; sample: %s",
                    ex, ex_aliases, exch_col,
                    df[exch_col].dropna().astype(str).unique()[:10].tolist(),
                )

        # ── Underlying filter ─────────────────────────────────────────────
        # Strategy:
        #   1. Exact match on the chosen underlying_col (cheap).
        #   2. If that's empty AND the col is a name/symbol col, fall back
        #      to a startswith() match — Groww's per-contract `name` is
        #      "SENSEX25JUL76000CE" so startswith("SENSEX") catches it.
        col_lower = underlying_col.lower()
        upper_series = scope[underlying_col].astype(str).str.upper()
        sub = scope[upper_series.eq(u)]
        if sub.empty and col_lower in ("name", "symbol", "trading_symbol"):
            sub = scope[upper_series.str.startswith(u)]
        if sub.empty:
            logger.warning(
                "no rows for underlying=%s in column=%s (exchange-scope=%d); sample: %s",
                u, underlying_col, len(scope),
                scope[underlying_col].dropna().astype(str).unique()[:10].tolist(),
            )

        # Apply option-only filter best-effort.
        if not sub.empty and type_col is not None:
            type_upper = sub[type_col].astype(str).str.upper()
            # Groww stores option type as `CE`/`PE` per leg; some vintages
            # tag instruments as OPTIDX/OPTSTK/OPTFUT instead.
            opt_mask = type_upper.isin(["CE", "PE", "OPTIDX", "OPTSTK", "OPTFUT", "OPT"])
            sub_opt = sub[opt_mask]
            if not sub_opt.empty:
                sub = sub_opt

        raw = sub[expiry_col].dropna().astype(str).tolist()
        out: List[str] = []
        for s in raw:
            m = re.match(r"(\d{4}-\d{2}-\d{2})", s)
            if m:
                out.append(m.group(1))
                continue
            # Fallback: try common alt formats like 12-Jun-2026 or 12-06-2026
            for fmt in ("%d-%b-%Y", "%d-%m-%Y", "%Y%m%d", "%d/%m/%Y"):
                try:
                    d = datetime.strptime(s.split("T")[0], fmt).date()
                    out.append(d.isoformat())
                    break
                except Exception:  # noqa: BLE001
                    pass
        logger.info(
            "master-scan underlying=%s exchange=%s (aliases=%s) underlying_col=%s expiry_col=%s type_col=%s rows=%d unique_expiries=%d",
            u, ex, ex_aliases, underlying_col, expiry_col, type_col, len(sub), len(set(out)),
        )
        return sorted(set(out))
    except Exception as exc:  # noqa: BLE001
        logger.exception("instrument-master expiry scan failed: %s", exc)
        return []


@api.get("/instruments/master-debug")
async def instrument_master_debug(token: str = Depends(require_token)):
    """One-off dev introspection: returns the column list and the first row
    of the cached instrument master so we can see Groww's actual schema."""
    if _is_demo(token):
        return {"demo": True}
    df = await _load_instruments_async(token)
    if df is None:
        return {"error": "master not loaded"}
    sample = df.head(2).to_dict(orient="records")
    return {
        "columns": list(df.columns),
        "row_count": int(len(df)),
        "sample": sample,
    }


@api.get("/instruments/expiries")
async def expiries(underlying: str, exchange: str = "NSE", token: str = Depends(require_token)):
    if _is_demo(token):
        return _demo_expiries(underlying)
    today_iso = datetime.now(timezone.utc).date().isoformat()

    # PRIMARY: scan the live instrument master (returns *future* expiries).
    live = await _call_blocking(_live_expiries_from_master, token, underlying, exchange)
    future = sorted({d for d in live if d >= today_iso})

    # FALLBACK: ask the historical endpoint (rare, but useful for FUTIDX-only
    # underlyings or if the master CSV failed to load). Parallelize the
    # current+next-year lookup so we don't wait on two serial round-trips.
    historical_errors: List[str] = []
    if not future:
        api_ = _groww_client(token)
        now = datetime.now(timezone.utc)
        years = (now.year, now.year + 1)

        async def _hist_for_year(year: int):
            try:
                data = await _call_blocking(api_.get_expiries, exchange, underlying, year)
                return year, _extract_iso_dates(data), None
            except Exception as exc:  # noqa: BLE001
                return year, [], str(exc)

        results = await asyncio.gather(*(_hist_for_year(y) for y in years))
        all_dates: List[str] = []
        for year, dates, err in results:
            all_dates.extend(dates)
            if err:
                historical_errors.append(f"{year}: {err}")
        future = sorted({d for d in all_dates if d >= today_iso})

    logger.info(
        "expiries underlying=%s exchange=%s live=%d future=%d historical_errors=%s",
        underlying, exchange, len(live), len(future), historical_errors,
    )
    return {"expiries": future}


@api.get("/instruments/option-chain")
async def option_chain(
    underlying: str,
    expiry: str,
    exchange: str = "NSE",
    option_type: str = "CE",
    token: str = Depends(require_token),
):
    if _is_demo(token):
        return _demo_option_chain(underlying, expiry, exchange)
    api_ = _groww_client(token)
    try:
        data = await _get_option_chain_cached(api_, exchange, underlying, expiry)
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="Option chain fetch timed out — try again.") from None
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return data


# ---------------------------------------------------------------------------
# Option-chain TTL cache + single-flight
# ---------------------------------------------------------------------------
# Strike previews, dry-runs, and the actual order placement often hit the
# option chain back-to-back for the same (underlying, expiry, exchange).
# We cache the raw response for a few seconds (still "live enough" for
# scalping) AND single-flight concurrent fetches behind an asyncio.Lock
# so a burst of clicks doesn't fan out into 4 Groww round-trips.
_OPTION_CHAIN_CACHE: Dict[tuple, Dict[str, Any]] = {}
_OPTION_CHAIN_LOCKS: Dict[tuple, asyncio.Lock] = {}
_OPTION_CHAIN_TTL_SECONDS = 2.0
_OPTION_CHAIN_TIMEOUT = 6.0


def _option_chain_lock(key: tuple) -> asyncio.Lock:
    lock = _OPTION_CHAIN_LOCKS.get(key)
    if lock is None:
        lock = asyncio.Lock()
        _OPTION_CHAIN_LOCKS[key] = lock
    return lock


async def _get_option_chain_cached(api_: GrowwAPI, exchange: str, underlying: str, expiry: str) -> Any:
    """Hard-timeout, single-flight, short-TTL wrapper around get_option_chain."""
    key = (exchange.upper(), underlying.upper(), expiry[:10])
    entry = _OPTION_CHAIN_CACHE.get(key)
    now = time.time()
    if entry and (now - entry["ts"]) < _OPTION_CHAIN_TTL_SECONDS:
        return entry["data"]
    async with _option_chain_lock(key):
        entry = _OPTION_CHAIN_CACHE.get(key)
        now = time.time()
        if entry and (now - entry["ts"]) < _OPTION_CHAIN_TTL_SECONDS:
            return entry["data"]
        data = await asyncio.wait_for(
            _call_blocking(api_.get_option_chain, exchange, underlying, expiry),
            timeout=_OPTION_CHAIN_TIMEOUT,
        )
        _OPTION_CHAIN_CACHE[key] = {"ts": time.time(), "data": data}
        # Trim cache to avoid unbounded growth (~unlikely but cheap insurance)
        if len(_OPTION_CHAIN_CACHE) > 64:
            oldest = sorted(_OPTION_CHAIN_CACHE.items(), key=lambda kv: kv[1]["ts"])[: len(_OPTION_CHAIN_CACHE) - 64]
            for k, _ in oldest:
                _OPTION_CHAIN_CACHE.pop(k, None)
                _OPTION_CHAIN_LOCKS.pop(k, None)
        return data


# ---------------------------------------------------------------------------
# Strike selection logic
# ---------------------------------------------------------------------------
def _normalize_chain(raw: Any) -> List[Dict[str, Any]]:
    """Flatten a Groww option-chain response to a list of strike rows."""
    if isinstance(raw, dict):
        for key in ("option_chain", "chain", "data", "options"):
            if key in raw and isinstance(raw[key], list):
                return raw[key]
        if "payload" in raw and isinstance(raw["payload"], dict):
            return _normalize_chain(raw["payload"])
    if isinstance(raw, list):
        return raw
    return []


def _pick_strike(rows: List[Dict[str, Any]], spot: float, opt_type: str, strategy: str, iv_filter: str):
    """Return a single chain row that matches the strategy."""
    if not rows:
        return None
    # keep only rows that include this option type
    filtered: List[Dict[str, Any]] = []
    for r in rows:
        strike = r.get("strike") or r.get("strike_price")
        if strike is None:
            continue
        # Some payloads nest CE/PE within the row
        leg = r.get(opt_type.lower()) or r.get(opt_type) or r
        ltp = leg.get("ltp") or leg.get("last_price") or leg.get("price") or 0
        iv = leg.get("implied_volatility") or leg.get("iv") or 0
        gamma = leg.get("gamma") or 0
        ts = leg.get("trading_symbol") or leg.get("symbol") or r.get(f"{opt_type.lower()}_symbol")
        if not ts:
            continue
        filtered.append({
            "strike": float(strike),
            "ltp": float(ltp or 0),
            "iv": float(iv or 0),
            "gamma": float(gamma or 0),
            "trading_symbol": ts,
        })
    if not filtered:
        return None
    filtered.sort(key=lambda x: x["strike"])

    # IV filter
    if iv_filter in ("LOW_IV", "HIGH_IV"):
        ivs = [r["iv"] for r in filtered if r["iv"] > 0]
        if ivs:
            median = sorted(ivs)[len(ivs) // 2]
            if iv_filter == "LOW_IV":
                filtered = [r for r in filtered if r["iv"] <= median or r["iv"] == 0]
            else:
                filtered = [r for r in filtered if r["iv"] >= median]
            if not filtered:
                return None

    # Strategy
    if strategy == "HIGH_GAMMA":
        best = max(filtered, key=lambda x: x["gamma"])
        return best

    # Find ATM index
    atm_idx = min(range(len(filtered)), key=lambda i: abs(filtered[i]["strike"] - spot))
    step = 1
    if opt_type.upper() == "CE":
        step = 1  # OTM = higher strikes; ITM = lower
    else:
        step = -1  # OTM PE = lower strikes; ITM PE = higher

    offset = {"ATM": 0, "OTM1": 1 * step, "OTM2": 2 * step, "ITM1": -1 * step}.get(strategy, 0)
    idx = max(0, min(len(filtered) - 1, atm_idx + offset))
    return filtered[idx]


def _first_positive_numeric(obj: Any) -> Optional[float]:
    """Return the first positive numeric value found in a dict/list — used
    when the API returns `{trading_symbol: price}` (the key IS the symbol so
    key-substring probing doesn't match)."""
    if isinstance(obj, (int, float)):
        try:
            v = float(obj)
            return v if v > 0 else None
        except Exception:  # noqa: BLE001
            return None
    if isinstance(obj, dict):
        for v in obj.values():
            r = _first_positive_numeric(v)
            if r is not None:
                return r
    elif isinstance(obj, list):
        for v in obj:
            r = _first_positive_numeric(v)
            if r is not None:
                return r
    return None


async def _fetch_spot_ltp(api_: GrowwAPI, underlying: str, exchange: str) -> float:
    """Best-effort fetch of the underlying index/stock spot LTP. Tries
    multiple symbol/segment variants; returns 0.0 on total failure."""
    candidates = [
        (f"{exchange}_{underlying}", "CASH"),
        (f"{exchange}_{underlying} 50", "CASH"),
        (f"{exchange}_{underlying}", "FNO"),
    ]
    for symbol, segment in candidates:
        try:
            data = await _call_blocking(api_.get_ltp, (symbol,), segment)
            # `get_ltp` returns `{symbol: ltp}` — the trading symbol IS the
            # key, so look for any positive numeric value.
            ltp = (
                _find_numeric_by_keys(data, ["ltp", "last_price", "last_traded_price", "price"])
                or _first_positive_numeric(data)
            )
            if ltp and ltp > 0:
                logger.info("spot ltp %s via %s/%s = %s", underlying, symbol, segment, ltp)
                return float(ltp)
        except Exception as exc:  # noqa: BLE001
            logger.debug("spot ltp %s/%s failed: %s", symbol, segment, exc)
            continue
    # Final fallback: ask get_quote (richer payload).
    try:
        data = await _call_blocking(api_.get_quote, underlying, exchange, "CASH")
        ltp = (
            _find_numeric_by_keys(data, ["last_price", "ltp", "last_traded_price"])
            or _first_positive_numeric(data)
        )
        if ltp and ltp > 0:
            return float(ltp)
    except Exception:  # noqa: BLE001
        pass
    return 0.0


async def _fetch_option_ltp(api_: GrowwAPI, exchange: str, trading_symbol: str) -> float:
    sym = f"{exchange}_{trading_symbol}"
    # MCX commodity options route through SEGMENT_COMMODITY in the live-data
    # endpoints. Hardcoding "FNO" caused every commodity LTP fetch to 404.
    segment = _segment_for(exchange)
    try:
        data = await _call_blocking(api_.get_ltp, (sym,), segment)
        ltp = (
            _find_numeric_by_keys(data, ["ltp", "last_price", "last_traded_price", "price"])
            or _first_positive_numeric(data)
        )
        if ltp and ltp > 0:
            logger.info("option ltp %s = %s (segment=%s)", trading_symbol, ltp, segment)
            return float(ltp)
    except Exception as exc:  # noqa: BLE001
        logger.debug("option ltp %s failed (segment=%s): %s", trading_symbol, segment, exc)
    # Fallback: get_quote
    try:
        data = await _call_blocking(api_.get_quote, trading_symbol, exchange, segment)
        ltp = (
            _find_numeric_by_keys(data, ["last_price", "ltp", "last_traded_price"])
            or _first_positive_numeric(data)
        )
        if ltp and ltp > 0:
            return float(ltp)
    except Exception as exc:  # noqa: BLE001
        logger.debug("option quote %s failed (segment=%s): %s", trading_symbol, segment, exc)
    return 0.0


async def _candle_context_last_hour(
    api_: GrowwAPI,
    *,
    trading_symbol: str,
    exchange: str,
    current_price: float,
) -> Dict[str, Optional[Any]]:
    """Fetch the last hour of 1-minute candles ONCE and derive two helper
    signals for the confirmation dialog:

      1. below_pct  — what % of those candles closed BELOW the current
                      price. Tells the user where they are in the recent
                      range (low = near recent low → likely better entry).

      2. ema9       — 9-period exponential moving average of the closes,
                      plus the % difference between the current price and
                      EMA(9). Positive % means we're trading ABOVE the EMA
                      (bullish), negative means BELOW (bearish/oversold).

    Returns {"below_pct": {...} | None, "ema9": {...} | None}. Returns
    `None` for any leg that can't be computed (history fetch failed, too
    few candles, etc.) so callers can selectively render.
    """
    out: Dict[str, Optional[Any]] = {"below_pct": None, "ema9": None}
    if current_price <= 0 or not trading_symbol:
        return out
    try:
        from zoneinfo import ZoneInfo
        now_ist = datetime.now(ZoneInfo("Asia/Kolkata"))
    except Exception:  # noqa: BLE001
        now_ist = datetime.now(timezone.utc)
    start_str = (now_ist - timedelta(minutes=60)).strftime("%Y-%m-%d %H:%M:%S")
    end_str = now_ist.strftime("%Y-%m-%d %H:%M:%S")
    try:
        resp = await _call_blocking(
            api_.get_historical_candle_data,
            trading_symbol,
            exchange,
            _segment_for(exchange),
            start_str,
            end_str,
            1,  # interval_in_minutes = 1
        )
    except Exception as exc:  # noqa: BLE001
        logger.info("historical candle fetch failed (%s): %s", trading_symbol, exc)
        return out

    candles: List[Any] = []
    if isinstance(resp, dict):
        candles = resp.get("candles") or resp.get("data") or []
    elif isinstance(resp, list):
        candles = resp
    if not candles:
        return out

    # Extract closes in chronological order. Each row is [ts, o, h, l, c, v].
    closes: List[float] = []
    below = 0
    for row in candles:
        if not isinstance(row, (list, tuple)) or len(row) < 5:
            continue
        try:
            close = float(row[4])
        except (TypeError, ValueError):
            continue
        closes.append(close)
        if close < current_price:
            below += 1

    total = len(closes)
    if total == 0:
        return out

    out["below_pct"] = {"pct": round(below * 100 / total), "samples": total}

    # 9-period EMA. Need at least 9 samples for the seed SMA. Standard
    # formula: α = 2/(N+1); EMA[i] = close[i]*α + EMA[i-1]*(1-α). Seeded
    # with the simple mean of the first 9 closes — same convention every
    # charting library uses (TradingView, Stockcharts, etc.).
    if total >= 9:
        alpha = 2.0 / (9 + 1)
        ema = sum(closes[:9]) / 9.0
        for c in closes[9:]:
            ema = c * alpha + ema * (1 - alpha)
        diff_pct = ((current_price - ema) / ema) * 100 if ema > 0 else 0.0
        out["ema9"] = {
            "value": round(ema, 2),
            "diff_pct": round(diff_pct, 2),
            "samples": total,
        }
    return out


def _round_tick(price: float) -> float:
    """Round a price to the nearest 0.05 — the standard Groww options tick."""
    if price <= 0:
        return 0.0
    return round(round(price * 20.0) / 20.0, 2)


# ──────────────────────────────────────────────────────────────────────
# Index option lot sizes (effective January 2026 per NSE Circular
# NSE/FAOP/70616 and corresponding BSE updates). Used as a fallback
# when Groww's instrument-master CSV lookup misses or returns 0, and
# as the canonical source in demo mode.
# Keys are uppercase underlying tickers.
# ──────────────────────────────────────────────────────────────────────
INDEX_LOT_SIZES_2026: Dict[str, int] = {
    "NIFTY": 65,         # was 75 in 2025
    "BANKNIFTY": 30,     # was 35
    "FINNIFTY": 60,      # was 65
    "MIDCPNIFTY": 120,   # was 140
    "NIFTYNXT50": 25,    # unchanged
    "SENSEX": 20,        # BSE
    "BANKEX": 30,        # BSE
}


def _lot_size_for(underlying: str, fallback: int = 1) -> int:
    """Look up the post-Jan-2026 lot size by underlying ticker. Strips
    whitespace + uppercases so 'sensex' or 'Sensex' resolves the same."""
    if not underlying:
        return fallback
    return INDEX_LOT_SIZES_2026.get(underlying.strip().upper(), fallback)


def _is_zero_dte(expiry_str: str) -> bool:
    """True if `expiry_str` (YYYY-MM-DD) is TODAY in Indian Standard Time.
    Falls back to UTC date if zoneinfo isn't available."""
    if not expiry_str:
        return False
    try:
        from zoneinfo import ZoneInfo  # py3.9+
        today_ist = datetime.now(ZoneInfo("Asia/Kolkata")).date().isoformat()
    except Exception:  # noqa: BLE001
        today_ist = datetime.now(timezone.utc).date().isoformat()
    return expiry_str[:10] == today_ist


def _limit_offset_pct_for_expiry(expiry_str: str) -> float:
    """Dynamic LIMIT-buy discount based on time-to-expiry:
      • 0 DTE (expiry == today)  → 7% — option premium decays faster intraday,
        so we want to bid more aggressively below LTP to catch wicks.
      • non-0 DTE                → 3% — gentler bid for longer-dated options.
    The preset's saved `limit_offset_pct` is ignored in favour of this rule."""
    return 7.0 if _is_zero_dte(expiry_str) else 3.0


def _compute_sl_tp(entry_price: float, sl_pct: float, tp_pct: float) -> Dict[str, float]:
    """Returns a {sl, tp} dict of rounded trigger prices. 0 means "not set"."""
    sl = _round_tick(entry_price * (1 - sl_pct / 100.0)) if sl_pct > 0 and entry_price > 0 else 0.0
    tp = _round_tick(entry_price * (1 + tp_pct / 100.0)) if tp_pct > 0 and entry_price > 0 else 0.0
    return {"sl": sl, "tp": tp}


async def _arm_protective_order(
    api_: GrowwAPI,
    *,
    trading_symbol: str,
    exchange: str,
    quantity: int,
    entry_price: float,
    sl_pct: float,
    tp_pct: float,
) -> Optional[Dict[str, Any]]:
    """
    After a successful BUY, arm a protective Groww smart order so the position
    auto-exits at SL or TP without the trader watching the screen.

    Groww has no traditional bracket order — instead it exposes "smart orders":
      - OCO (One-Cancels-Other): pair of legs (target + stop_loss). When one
        triggers, the other is auto-cancelled. Perfect for SL+TP together.
      - GTT (Good Till Triggered): single trigger price + direction.

    We pick OCO when both SL & TP are set, otherwise a single GTT.
    Returns the smart-order metadata (or `{"error": ...}` on failure) so the
    frontend can surface the protection alongside the BUY response.
    """
    if quantity <= 0 or entry_price <= 0:
        return None
    if sl_pct <= 0 and tp_pct <= 0:
        return None

    levels = _compute_sl_tp(entry_price, sl_pct, tp_pct)
    sl_price, tp_price = levels["sl"], levels["tp"]

    common = dict(
        segment=_segment_for(exchange),
        trading_symbol=trading_symbol,
        exchange=exchange,
        quantity=int(quantity),
        product_type=GrowwAPI.PRODUCT_NRML,
        duration=GrowwAPI.VALIDITY_DAY,
    )

    try:
        if sl_price > 0 and tp_price > 0:
            resp = await _call_blocking(
                api_.create_smart_order,
                smart_order_type=GrowwAPI.SMART_ORDER_TYPE_OCO,
                **common,
                net_position_quantity=int(quantity),
                target={
                    "trigger_price": f"{tp_price:.2f}",
                    "order_type": GrowwAPI.ORDER_TYPE_MARKET,
                },
                stop_loss={
                    "trigger_price": f"{sl_price:.2f}",
                    "order_type": GrowwAPI.ORDER_TYPE_MARKET,
                },
                transaction_type=GrowwAPI.TRANSACTION_TYPE_SELL,
            )
            return {
                "type": "OCO",
                "entry_price": entry_price,
                "tp_price": tp_price,
                "sl_price": sl_price,
                "tp_pct": tp_pct,
                "sl_pct": sl_pct,
                "response": resp,
            }
        if sl_price > 0:
            resp = await _call_blocking(
                api_.create_smart_order,
                smart_order_type=GrowwAPI.SMART_ORDER_TYPE_GTT,
                **common,
                trigger_price=f"{sl_price:.2f}",
                trigger_direction=GrowwAPI.TRIGGER_DIRECTION_DOWN,
                order={
                    "order_type": GrowwAPI.ORDER_TYPE_MARKET,
                    "transaction_type": GrowwAPI.TRANSACTION_TYPE_SELL,
                },
            )
            return {
                "type": "GTT_SL",
                "entry_price": entry_price,
                "sl_price": sl_price,
                "sl_pct": sl_pct,
                "response": resp,
            }
        # tp_price > 0 path
        resp = await _call_blocking(
            api_.create_smart_order,
            smart_order_type=GrowwAPI.SMART_ORDER_TYPE_GTT,
            **common,
            trigger_price=f"{tp_price:.2f}",
            trigger_direction=GrowwAPI.TRIGGER_DIRECTION_UP,
            order={
                "order_type": GrowwAPI.ORDER_TYPE_MARKET,
                "transaction_type": GrowwAPI.TRANSACTION_TYPE_SELL,
            },
        )
        return {
            "type": "GTT_TP",
            "entry_price": entry_price,
            "tp_price": tp_price,
            "tp_pct": tp_pct,
            "response": resp,
        }
    except Exception as exc:  # noqa: BLE001
        logger.exception("Failed to arm protective order for %s: %s", trading_symbol, exc)
        return {
            "error": str(exc),
            "entry_price": entry_price,
            "sl_price": sl_price,
            "tp_price": tp_price,
            "sl_pct": sl_pct,
            "tp_pct": tp_pct,
        }


async def _list_active_smart_orders(api_: GrowwAPI) -> List[Dict[str, Any]]:
    """Fetch all currently-ACTIVE smart orders from Groww. Returns [] on any
    failure so callers can degrade gracefully."""
    try:
        listing = await asyncio.wait_for(
            _call_blocking(
                api_.get_smart_order_list, status=GrowwAPI.SMART_ORDER_STATUS_ACTIVE,
            ),
            timeout=8.0,
        )
    except asyncio.TimeoutError:
        logger.warning("get_smart_order_list timed out — returning empty list")
        return []
    except Exception as exc:  # noqa: BLE001
        logger.warning("get_smart_order_list failed: %s", exc)
        return []
    items: List[Dict[str, Any]] = []
    if isinstance(listing, dict):
        items = (
            listing.get("smart_orders")
            or listing.get("smart_order_list")
            or listing.get("data")
            or listing.get("items")
            or []
        )
    elif isinstance(listing, list):
        items = listing
    return items


async def _cancel_smart_orders_for_symbols(
    api_: GrowwAPI, symbols: List[str]
) -> List[Dict[str, Any]]:
    """Cancel any ACTIVE smart orders that target the given trading symbols.
    Best-effort — failures are logged and skipped so a single bad ID can't
    block the user's exit flow."""
    if not symbols:
        return []
    targeted = {s for s in symbols if s}
    items = await _list_active_smart_orders(api_)
    cancelled: List[Dict[str, Any]] = []
    for so in items:
        sym = so.get("trading_symbol") or so.get("symbol")
        if sym not in targeted:
            continue
        sid = so.get("smart_order_id") or so.get("id")
        sotype = so.get("smart_order_type") or so.get("type") or GrowwAPI.SMART_ORDER_TYPE_OCO
        seg = so.get("segment") or GrowwAPI.SEGMENT_FNO
        if not sid:
            continue
        try:
            await _call_blocking(
                api_.cancel_smart_order,
                segment=seg,
                smart_order_type=sotype,
                smart_order_id=sid,
            )
            cancelled.append({"smart_order_id": sid, "trading_symbol": sym, "type": sotype})
        except Exception as exc:  # noqa: BLE001
            logger.warning("cancel_smart_order %s (%s) failed: %s", sid, sym, exc)
    return cancelled



def _fallback_pick_from_master(
    token: str,
    underlying: str,
    expiry: str,
    option_type: str,
    strategy: str,
    spot_hint: float = 0.0,
) -> Optional[Dict[str, Any]]:
    """Build a best-effort strike pick from the instrument-master CSV when
    Groww's option-chain endpoint fails or returns nothing matching the
    preset criteria. Doesn't know the live LTP — uses the strike as a
    placeholder so the user still sees what *would* have been picked."""
    df = _load_instruments(token)
    if df is None:
        return None
    try:
        u = underlying.upper()
        opt = option_type.upper()
        cols = {c.lower(): c for c in df.columns}
        sym_col = cols.get("trading_symbol") or cols.get("symbol")
        underlying_col = cols.get("underlying_symbol") or cols.get("underlying")
        type_col = cols.get("instrument_type") or cols.get("type")
        expiry_col = cols.get("expiry_date") or cols.get("expiry")
        strike_col = cols.get("strike_price") or cols.get("strike")
        if not all([sym_col, underlying_col, type_col, expiry_col, strike_col]):
            return None
        sub = df[
            df[underlying_col].astype(str).str.upper().eq(u)
            & df[type_col].astype(str).str.upper().eq(opt)
            & df[expiry_col].astype(str).str.startswith(expiry[:10])
        ]
        if sub.empty:
            return None
        rows: List[Dict[str, Any]] = []
        for _, r in sub.iterrows():
            try:
                rows.append({
                    "strike": float(r[strike_col]),
                    "trading_symbol": str(r[sym_col]),
                    "ltp": 0.0, "iv": 0.0, "gamma": 0.0,
                })
            except Exception:  # noqa: BLE001
                continue
        if not rows:
            return None
        rows.sort(key=lambda x: x["strike"])
        # Use the hint (live spot LTP) if provided; otherwise fall back to
        # the centre of available strikes (a poor man's ATM).
        spot = float(spot_hint) if spot_hint and spot_hint > 0 else rows[len(rows) // 2]["strike"]
        atm_idx = min(range(len(rows)), key=lambda i: abs(rows[i]["strike"] - spot))
        step = 1 if opt == "CE" else -1
        off = {"ATM": 0, "OTM1": step, "OTM2": 2 * step, "ITM1": -step, "HIGH_GAMMA": 0}.get(strategy, 0)
        idx = max(0, min(len(rows) - 1, atm_idx + off))
        return rows[idx]
    except Exception as exc:  # noqa: BLE001
        logger.warning("master fallback pick failed: %s", exc)
        return None


@api.post("/orders/place-preset")
async def place_preset_order(payload: PlacePresetOrderRequest, token: str = Depends(require_token)):
    # Pull the user-level settings once up front. We need `practice_mode`
    # which, when true, overrides whatever position-sizing % the preset
    # carries and clamps the order to exactly 1 lot — a safety hatch for
    # users who want to dry-run the full flow with minimum capital risk.
    settings_doc = await db.settings.find_one({"_id": "user"}, {"_id": 0}) or {}
    practice_mode = bool(settings_doc.get("practice_mode"))

    # Demo mode: stateful — actually mutate db.demo_state
    if _is_demo(token):
        # Compute deterministic-ish demo strike + lot info before deciding
        # whether to actually mutate state.
        atm_map = {
            "NIFTY": 24700,
            "BANKNIFTY": 51100,
            "FINNIFTY": 23400,
            "MIDCPNIFTY": 12100,
            "SENSEX": 81500,
            "BANKEX": 58000,
        }
        atm_step_map = {
            "NIFTY": 50, "BANKNIFTY": 100, "FINNIFTY": 50,
            "MIDCPNIFTY": 50, "SENSEX": 100, "BANKEX": 100,
        }
        u = (payload.underlying or "NIFTY").upper()
        atm = atm_map.get(u, 1000)
        step = atm_step_map.get(u, 50)
        offsets = {"ATM": 0, "OTM1": step, "OTM2": 2 * step, "ITM1": -step, "HIGH_GAMMA": 0}
        preset_doc = await db.presets.find_one({"key": payload.preset_key}, {"_id": 0})
        if not preset_doc:
            preset = next((p for p in DEFAULT_PRESETS if p.key == payload.preset_key), None)
            if preset:
                preset_doc = preset.model_dump()
            else:
                preset_doc = {}
        sizing = float(preset_doc.get("position_sizing_pct") or 25) / 100.0
        strike_off = offsets.get(preset_doc.get("strike_selection", "ATM"), 0)
        strike = atm + strike_off if payload.option_type == "CE" else atm - strike_off
        fake_symbol = f"{u}{strike}{payload.option_type}"
        ltp = round(random.uniform(80, 200), 2)
        lot = _lot_size_for(u, fallback=50)
        contract_cost = ltp * lot
        lots = math.floor((payload.capital * sizing) / contract_cost) if contract_cost > 0 else 0
        if practice_mode:
            lots = 1
        qty = lots * lot
        order_type_str = preset_doc.get("order_type", "MARKET")

        # Refuse to oversize.
        if lots < 1:
            if payload.dry_run:
                return {
                    "dry_run": True,
                    "preset": preset_doc,
                    "selected": {"trading_symbol": fake_symbol, "strike": strike, "ltp": ltp},
                    "quantity": 0,
                    "lots": 0,
                    "lot_size": lot,
                    "estimated_cost": round(contract_cost, 2),
                    "spot": atm,
                    "fallback_reason": "insufficient_capital",
                }
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Capital ₹{payload.capital:.0f} × sizing {preset_doc.get('position_sizing_pct')}%"
                    f" can't cover 1 lot of {fake_symbol} (≈ ₹{contract_cost:.0f}). Increase capital or sizing."
                ),
            )

        if payload.dry_run:
            limit_off_demo = _limit_offset_pct_for_expiry(payload.expiry) / 100.0
            entry_demo = (
                ltp
                if order_type_str == "MARKET"
                else _round_tick(ltp * (1 - limit_off_demo))
            )
            demo_levels = _compute_sl_tp(
                entry_demo,
                float(preset_doc.get("stop_loss_pct") or 0),
                float(preset_doc.get("take_profit_pct") or 0),
            )
            return {
                "dry_run": True,
                "preset": preset_doc,
                "selected": {"trading_symbol": fake_symbol, "strike": strike, "ltp": ltp},
                "quantity": qty,
                "lots": lots,
                "lot_size": lot,
                "estimated_cost": round(qty * ltp, 2),
                "spot": atm,
                "order": {
                    "trading_symbol": fake_symbol,
                    "transaction_type": "BUY",
                    "order_type": order_type_str,
                    "price": 0 if order_type_str == "MARKET" else entry_demo,
                },
                "protective_preview": {
                    "entry_price": entry_demo,
                    "sl_price": demo_levels["sl"],
                    "tp_price": demo_levels["tp"],
                    "sl_pct": float(preset_doc.get("stop_loss_pct") or 0),
                    "tp_pct": float(preset_doc.get("take_profit_pct") or 0),
                },
                # Demo helper — deterministic-ish but varies enough that
                # the UI shows the indicator working without needing a
                # live Groww historical-candle call.
                "below_price_pct": {
                    "pct": random.randint(30, 75),
                    "samples": 60,
                },
                "ema9": {
                    "value": round(ltp * random.uniform(0.97, 1.03), 2),
                    "diff_pct": round(random.uniform(-3.5, 3.5), 2),
                    "samples": 60,
                },
            }

        doc = await _demo_state_for(token)
        suffix_count = sum(
            1 for p in doc["positions"] if (p.get("trading_symbol") or "").startswith(fake_symbol)
        )
        unique_symbol = fake_symbol if suffix_count == 0 else f"{fake_symbol}#{suffix_count + 1}"
        doc["positions"].append({
            "trading_symbol": unique_symbol,
            "exchange": "NSE",
            "product": "NRML",
            "net_quantity": qty,
            "average_price": ltp,
            "last_price": ltp,
            "transaction_type": "BUY",
            "created_at": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S"),
        })
        order_id = f"demo-{uuid.uuid4().hex[:8]}"
        doc.setdefault("orders", []).append({
            "order_id": order_id,
            "trading_symbol": unique_symbol,
            "transaction_type": "BUY",
            "order_status": "EXECUTED",
            "quantity": qty,
            "filled_quantity": qty,
            "average_price": ltp,
            "order_type": order_type_str,
            "exchange_time": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S"),
        })
        await _save_demo_state(token, doc)
        demo_protect_levels = _compute_sl_tp(
            ltp,
            float(preset_doc.get("stop_loss_pct") or 0),
            float(preset_doc.get("take_profit_pct") or 0),
        )
        demo_protective: Optional[Dict[str, Any]] = None
        smart_id = f"demo-so-{uuid.uuid4().hex[:8]}"
        if demo_protect_levels["sl"] > 0 and demo_protect_levels["tp"] > 0:
            demo_protective = {
                "type": "OCO",
                "entry_price": ltp,
                "sl_price": demo_protect_levels["sl"],
                "tp_price": demo_protect_levels["tp"],
                "sl_pct": float(preset_doc.get("stop_loss_pct") or 0),
                "tp_pct": float(preset_doc.get("take_profit_pct") or 0),
                "response": {"smart_order_id": smart_id, "status": "ACTIVE"},
            }
        elif demo_protect_levels["sl"] > 0:
            demo_protective = {
                "type": "GTT_SL",
                "entry_price": ltp,
                "sl_price": demo_protect_levels["sl"],
                "sl_pct": float(preset_doc.get("stop_loss_pct") or 0),
                "response": {"smart_order_id": smart_id, "status": "ACTIVE"},
            }
        elif demo_protect_levels["tp"] > 0:
            demo_protective = {
                "type": "GTT_TP",
                "entry_price": ltp,
                "tp_price": demo_protect_levels["tp"],
                "tp_pct": float(preset_doc.get("take_profit_pct") or 0),
                "response": {"smart_order_id": smart_id, "status": "ACTIVE"},
            }
        if demo_protective:
            # Persist so the home screen can render the 🛡 badge and the
            # exit endpoint can clean it up when the position is manually
            # closed.
            doc.setdefault("smart_orders", []).append({
                "smart_order_id": smart_id,
                "trading_symbol": unique_symbol,
                "smart_order_type": demo_protective["type"].split("_", 1)[0],  # OCO or GTT
                "status": "ACTIVE",
                "tp_price": demo_protective.get("tp_price"),
                "sl_price": demo_protective.get("sl_price"),
                "tp_pct": demo_protective.get("tp_pct"),
                "sl_pct": demo_protective.get("sl_pct"),
            })
            await _save_demo_state(token, doc)
        # Compute the LIMIT price the same way as for live orders so the
        # demo response shape matches and the confirmation dialog can
        # honor sticky-pricing. Always BELOW LTP, with the DTE-aware
        # offset (7% on 0 DTE, 3% otherwise).
        if payload.limit_price_override and payload.limit_price_override > 0 and order_type_str == "LIMIT":
            demo_price = _round_tick(float(payload.limit_price_override))
        elif order_type_str == "LIMIT":
            demo_off = _limit_offset_pct_for_expiry(payload.expiry) / 100.0
            demo_price = _round_tick(ltp * (1 - demo_off))
        else:
            demo_price = 0.0
        return {
            "preset": preset_doc,
            "selected": {"trading_symbol": unique_symbol, "strike": strike, "ltp": ltp},
            "quantity": qty,
            "lots": lots,
            "lot_size": lot,
            "estimated_cost": round(qty * ltp, 2),
            "order": {
                "trading_symbol": unique_symbol,
                "transaction_type": "BUY",
                "order_type": order_type_str,
                "price": demo_price,
            },
            "response": {"order_id": order_id, "status": "EXECUTED"},
            "protective_order": demo_protective,
            "demo": True,
        }

    # 1. Fetch the preset config
    preset_doc = await db.presets.find_one({"key": payload.preset_key}, {"_id": 0})
    if not preset_doc:
        preset = next((p for p in DEFAULT_PRESETS if p.key == payload.preset_key), None)
        if not preset:
            raise HTTPException(status_code=404, detail="Unknown preset")
        preset_doc = preset.model_dump()

    api_ = _groww_client(token)

    # 2. Get option chain & underlying LTP
    chain_raw: Any = None
    chain_error: Optional[str] = None
    try:
        # Hard 6-second timeout on get_option_chain — for MCX commodities
        # Groww's server frequently hangs before returning the "Underlying
        # not found" error. Without this cap the whole dry-run can exceed
        # the Cloudflare edge timeout (100s) and the user sees a 520.
        # The cached wrapper also single-flights bursts of dry-runs.
        chain_raw = await _get_option_chain_cached(
            api_, payload.exchange, payload.underlying, payload.expiry
        )
    except asyncio.TimeoutError:
        chain_error = "option_chain_timeout"
        logger.warning(
            "Option chain fetch timed out (>6s) for %s/%s/%s — falling through to master-scan fallback",
            payload.exchange, payload.underlying, payload.expiry,
        )
        if not payload.dry_run:
            raise HTTPException(status_code=504, detail="Option chain fetch timed out — try again or use the MARKET preset.") from None
    except Exception as exc:  # noqa: BLE001
        chain_error = str(exc)
        logger.warning("Option chain fetch failed: %s", exc)
        if not payload.dry_run:
            # For real orders, we still need a live LTP — bubble up.
            raise HTTPException(status_code=502, detail=f"Option chain fetch failed: {exc}") from exc

    # Pull spot from chain payload (Groww returns it as `underlying_value` etc.)
    spot = 0.0
    if isinstance(chain_raw, dict):
        for k in ("underlying_value", "spot", "underlying_price", "underlying_ltp"):
            if k in chain_raw and chain_raw[k]:
                try:
                    spot = float(chain_raw[k])
                    break
                except Exception:  # noqa: BLE001
                    pass
    # If chain didn't give us a spot, fetch the index/stock LTP directly so
    # the strike picker chooses an ATM near the *real* market price.
    if spot <= 0:
        spot = await _fetch_spot_ltp(api_, payload.underlying, payload.exchange)
    rows = _normalize_chain(chain_raw)
    # IV filter is currently disabled (UI shows it greyed out). We always
    # pass "ANY" so the strike picker doesn't filter by IV, regardless of
    # what's stored on the preset.
    pick = _pick_strike(rows, spot, payload.option_type, preset_doc["strike_selection"], "ANY")
    fallback_reason: Optional[str] = None
    if not pick:
        # Best-effort fallback so the user always sees what *would* have
        # been chosen, even when Groww's option chain is empty / unreachable.
        pick = await _call_blocking(
            _fallback_pick_from_master, token, payload.underlying, payload.expiry,
            payload.option_type, preset_doc["strike_selection"], spot,
        )
        if pick:
            fallback_reason = (
                "option_chain_unavailable" if chain_error else "no_strike_matched_filters"
            )
        else:
            if payload.dry_run:
                return {
                    "dry_run": True,
                    "preset": preset_doc,
                    "selected": None,
                    "quantity": 0,
                    "lots": 0,
                    "lot_size": 0,
                    "estimated_cost": 0,
                    "spot": spot,
                    "fallback_reason": "no_contracts_found",
                    "error": chain_error,
                }
            raise HTTPException(status_code=404, detail="No strike matched the preset criteria")

    # Master-fallback picks come without LTP — try the live quote endpoint.
    if pick and float(pick.get("ltp") or 0) <= 0:
        live_ltp = await _fetch_option_ltp(api_, payload.exchange, pick["trading_symbol"])
        if live_ltp > 0:
            pick["ltp"] = live_ltp

    # 3. Compute quantity from capital * sizing
    sizing = float(preset_doc["position_sizing_pct"]) / 100.0
    risk_capital = max(0.0, payload.capital) * sizing
    # Prime lot_size with the post-Jan-2026 fallback so a CSV miss (or a
    # stale row from Groww's instrument master) still gives the right
    # exchange-mandated quantity. SENSEX in particular was getting 75
    # (NIFTY's old size) when the master lookup didn't hit cleanly.
    lot_size = _lot_size_for(payload.underlying, fallback=1)
    df = await _load_instruments_async(token)
    if df is not None:
        try:
            row = df[df["trading_symbol"].astype(str) == pick["trading_symbol"]]
            if not row.empty and "lot_size" in row.columns:
                csv_lot = int(row.iloc[0]["lot_size"]) or 0
                if csv_lot > 0:
                    lot_size = csv_lot
        except Exception:  # noqa: BLE001
            pass
    contract_cost = float(pick.get("ltp") or 0) * lot_size
    # If we don't have a live LTP (e.g. master fallback and live quote also
    # failed — common on MCX where Groww's option-chain endpoint frequently
    # returns "Underlying not found"), we can't size based on capital. For
    # MARKET orders the user has already accepted the dry-run warning that
    # quantity will be recomputed at placement time, so we default to a
    # single lot (minimum exposure). For LIMIT we still hard-fail because
    # the limit price calculation requires a known LTP.
    if contract_cost <= 0:
        if preset_doc["order_type"] == "MARKET":
            lots = 1
            quantity = lots * lot_size
            if payload.dry_run:
                return {
                    "dry_run": True,
                    "preset": preset_doc,
                    "selected": pick,
                    "quantity": quantity,
                    "lots": lots,
                    "lot_size": lot_size,
                    "estimated_cost": 0,
                    "spot": spot,
                    "fallback_reason": fallback_reason or "ltp_unavailable",
                }
            # Real MARKET order: fall through with lots=1. Groww will
            # fill at whatever the live price is.
        else:
            if payload.dry_run:
                return {
                    "dry_run": True,
                    "preset": preset_doc,
                    "selected": pick,
                    "quantity": 0,
                    "lots": 0,
                    "lot_size": lot_size,
                    "estimated_cost": 0,
                    "spot": spot,
                    "fallback_reason": fallback_reason or "ltp_unavailable",
                }
            raise HTTPException(status_code=400, detail="No live LTP available for the picked strike — cannot size a LIMIT order.")
    else:
        lots = math.floor(risk_capital / contract_cost)
        if practice_mode:
            lots = 1
        quantity = lots * lot_size

    # Refuse to size beyond capital. For dry-run we still render the preview
    # with qty=0 + a warning; for a real order we hard-fail.
    if lots < 1:
        if payload.dry_run:
            return {
                "dry_run": True,
                "preset": preset_doc,
                "selected": pick,
                "quantity": 0,
                "lots": 0,
                "lot_size": lot_size,
                "estimated_cost": round(contract_cost, 2),
                "spot": spot,
                "fallback_reason": "insufficient_capital",
            }
        raise HTTPException(
            status_code=400,
            detail=(
                f"Capital ₹{payload.capital:.0f} × sizing {preset_doc['position_sizing_pct']}%"
                f" = ₹{risk_capital:.0f} cannot cover 1 lot of {pick['trading_symbol']}"
                f" (lot cost ≈ ₹{contract_cost:.0f}). Increase capital or sizing."
            ),
        )

    order_type = preset_doc["order_type"]
    price = 0.0
    if order_type == "LIMIT":
        # Sticky-price: when the frontend confirms the user pressed BUY on
        # a specific displayed price, honor that exact value so the order
        # executes at what the user actually saw (and not whatever LTP ×
        # offset evaluates to seconds later on the server side).
        if payload.limit_price_override and payload.limit_price_override > 0:
            price = _round_tick(payload.limit_price_override)
        else:
            # LIMIT BUY is always placed BELOW LTP (we want a discount on
            # the entry). Offset is DTE-aware:
            #   0 DTE  → 7%  (faster decay, bid more aggressively)
            #   else   → 3%
            offset_pct = _limit_offset_pct_for_expiry(payload.expiry) / 100.0
            price = _round_tick(pick["ltp"] * (1 - offset_pct))

    order_payload = {
        "validity": GrowwAPI.VALIDITY_DAY,
        "exchange": payload.exchange,
        "order_type": GrowwAPI.ORDER_TYPE_LIMIT if order_type == "LIMIT" else GrowwAPI.ORDER_TYPE_MARKET,
        "product": GrowwAPI.PRODUCT_NRML,
        "quantity": quantity,
        "segment": _segment_for(payload.exchange),
        "trading_symbol": pick["trading_symbol"],
        "transaction_type": GrowwAPI.TRANSACTION_TYPE_BUY,
        "order_reference_id": uuid.uuid4().hex[:18],
        "price": price,
    }

    if payload.dry_run:
        # Preview the protective SL/TP that will be armed automatically
        # after the BUY fills. Helps the user double-check before tapping
        # CONFIRM.
        entry_preview = price if order_type == "LIMIT" and price > 0 else float(pick.get("ltp") or 0)
        protect_levels = _compute_sl_tp(
            entry_preview,
            float(preset_doc.get("stop_loss_pct") or 0),
            float(preset_doc.get("take_profit_pct") or 0),
        )
        # Time-in-range + 9 EMA context — only fetched on dry-run (the
        # user is idling on the confirmation dialog, latency is fine here).
        # WRAPPED in a hard timeout: if Groww's historical-candle API hangs
        # the whole dry-run would exceed Cloudflare's 100s edge timeout
        # and the user would see a 520. The context is purely advisory
        # (EMA/below-price%) so degrading to None is acceptable.
        try:
            ctx = await asyncio.wait_for(
                _candle_context_last_hour(
                    api_,
                    trading_symbol=pick["trading_symbol"],
                    exchange=payload.exchange,
                    current_price=float(pick.get("ltp") or 0),
                ),
                timeout=8.0,
            )
        except asyncio.TimeoutError:
            logger.warning(
                "candle context timed out (>8s) for %s/%s — skipping",
                payload.exchange, pick.get("trading_symbol"),
            )
            ctx = {"below_pct": None, "ema9": None}
        except Exception as exc:  # noqa: BLE001
            logger.warning("candle context errored: %s — skipping", exc)
            ctx = {"below_pct": None, "ema9": None}
        return {
            "dry_run": True,
            "preset": preset_doc,
            "selected": pick,
            "quantity": quantity,
            "lot_size": lot_size,
            "lots": lots,
            "estimated_cost": round(quantity * float(pick.get("ltp") or 0), 2),
            "order": order_payload,
            "spot": spot,
            "fallback_reason": fallback_reason,
            "protective_preview": {
                "entry_price": entry_preview,
                "sl_price": protect_levels["sl"],
                "tp_price": protect_levels["tp"],
                "sl_pct": float(preset_doc.get("stop_loss_pct") or 0),
                "tp_pct": float(preset_doc.get("take_profit_pct") or 0),
            },
            "below_price_pct": ctx.get("below_pct"),
            "ema9": ctx.get("ema9"),
        }

    logger.info("placing order: %s", order_payload)
    try:
        # Hard 25-second timeout on the live order placement. If Groww
        # hangs (we've seen rare cases on MCX LIMIT trades), we return
        # a clean 504 so the user sees a friendly toast instead of a
        # Cloudflare 520. NOTE: a TimeoutError here doesn't mean the
        # order didn't go through — it just means we didn't get the
        # confirmation in time. The user should check their order book.
        resp = await asyncio.wait_for(
            _call_blocking(api_.place_order, **order_payload),
            timeout=25.0,
        )
    except asyncio.TimeoutError:
        logger.error(
            "Order placement TIMED OUT (>25s) for %s. User should verify order book.",
            order_payload.get("trading_symbol"),
        )
        raise HTTPException(
            status_code=504,
            detail=(
                "Order placement timed out after 25s. Check your Groww order book — "
                "the order MAY have been placed. If not, please retry."
            ),
        ) from None
    except Exception as exc:  # noqa: BLE001
        msg = str(exc)
        logger.exception("Order placement failed for %s: %s", order_payload.get("trading_symbol"), exc)
        if "unregistered ip" in msg.lower():
            ip = _IP_CACHE.get("ip") or "unknown"
            raise HTTPException(
                status_code=403,
                detail=(
                    f"Groww rejected the order: server IP {ip} is not whitelisted. "
                    "Add it under groww.in → Profile → Trading API → IP Restrictions, "
                    "then try again."
                ),
            ) from exc
        raise HTTPException(status_code=502, detail=f"Order placement failed: {exc}") from exc
    logger.info("groww place_order resp: %s", resp)

    # Arm an OCO/GTT smart order so the position auto-exits at SL/TP
    # without the trader having to babysit it. Best-effort — never fails
    # the parent BUY response. Frontend gets the metadata in
    # `protective_order` for display.
    entry_for_protect = (
        order_payload["price"]
        if order_type == "LIMIT" and order_payload["price"] > 0
        else float(pick.get("ltp") or 0)
    )
    protective = await _arm_protective_order(
        api_,
        trading_symbol=pick["trading_symbol"],
        exchange=payload.exchange,
        quantity=quantity,
        entry_price=entry_for_protect,
        sl_pct=float(preset_doc.get("stop_loss_pct") or 0),
        tp_pct=float(preset_doc.get("take_profit_pct") or 0),
    )

    # Log to mongo
    await db.order_logs.insert_one({
        "id": str(uuid.uuid4()),
        "preset_key": payload.preset_key,
        "underlying": payload.underlying,
        "expiry": payload.expiry,
        "option_type": payload.option_type,
        "selected": pick,
        "order_payload": order_payload,
        "groww_response": resp,
        "protective_order": protective,
        "created_at": datetime.now(timezone.utc).isoformat(),
    })

    # State just changed — invalidate the polling caches so the next
    # refresh on the home screen shows the new position / smart order
    # immediately instead of waiting up to 1.5 s for the stale entry to
    # expire.
    _invalidate_response_cache(token, "positions", "smart_orders", "margin")

    return {
        "selected": pick,
        "quantity": quantity,
        "lots": lots,
        "lot_size": lot_size,
        "order": order_payload,
        "response": resp,
        "protective_order": protective,
    }


@api.post("/orders/exit")
async def exit_positions(payload: ExitRequest, token: str = Depends(require_token)):
    if payload.percent not in (25, 50, 100):
        raise HTTPException(status_code=400, detail="percent must be 25, 50, or 100")

    if _is_demo(token):
        doc = await _demo_state_for(token)
        results: List[Dict[str, Any]] = []
        cancelled_smart: List[Dict[str, Any]] = []
        # Decide which positions are eligible.
        for p in doc["positions"]:
            net_qty = int(p.get("net_quantity") or 0)
            if net_qty == 0:
                continue
            if payload.trading_symbol and p.get("trading_symbol") != payload.trading_symbol:
                continue
            if payload.pnl_filter:
                pnl = float(p.get("pnl") or 0)
                if payload.pnl_filter == "positive" and pnl <= 0:
                    continue
                if payload.pnl_filter == "negative" and pnl >= 0:
                    continue
            qty_to_close = max(1, math.floor(abs(net_qty) * payload.percent / 100))
            # Sign matters: if BUY net_qty>0 closing means -qty; SELL net_qty<0 means +qty.
            sign = -1 if net_qty > 0 else 1
            p["net_quantity"] = net_qty + sign * qty_to_close
            results.append({
                "trading_symbol": p.get("trading_symbol"),
                "quantity": qty_to_close,
                "response": {"status": "EXECUTED"},
            })
            # Log demo exit order
            doc.setdefault("orders", []).append({
                "order_id": f"demo-{uuid.uuid4().hex[:8]}",
                "trading_symbol": p.get("trading_symbol"),
                "transaction_type": "SELL" if net_qty > 0 else "BUY",
                "order_status": "EXECUTED",
                "quantity": qty_to_close,
                "filled_quantity": qty_to_close,
                "average_price": float(p.get("last_price") or 0),
                "order_type": "MARKET",
                "exchange_time": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S"),
            })
        # Cancel any smart orders for symbols we just touched, so the
        # demo-state stays internally consistent (no orphan OCO/GTT after
        # the position is gone).
        touched = {r["trading_symbol"] for r in results if r.get("trading_symbol")}
        if touched:
            kept: List[Dict[str, Any]] = []
            for so in doc.get("smart_orders", []):
                if so.get("trading_symbol") in touched and so.get("status") == "ACTIVE":
                    cancelled_smart.append({
                        "smart_order_id": so.get("smart_order_id"),
                        "trading_symbol": so.get("trading_symbol"),
                        "type": so.get("smart_order_type"),
                    })
                else:
                    kept.append(so)
            doc["smart_orders"] = kept
        # Drop closed rows
        doc["positions"] = [p for p in doc["positions"] if int(p.get("net_quantity") or 0) != 0]
        await _save_demo_state(token, doc)
        return {
            "closed": results,
            "count": len(results),
            "cancelled_smart_orders": cancelled_smart,
        }

    api_ = _groww_client(token)
    # Fetch positions across BOTH F&O and COMMODITY segments so MCX
    # (GOLD/SILVER/CRUDEOIL/...) positions are also enumerable for exit.
    positions_list: List[Dict[str, Any]] = []
    seg_errors: List[str] = []
    for seg in (GrowwAPI.SEGMENT_FNO, GrowwAPI.SEGMENT_COMMODITY):
        try:
            pos_resp = await _call_blocking(api_.get_positions_for_user, seg)
        except Exception as exc:  # noqa: BLE001
            seg_errors.append(f"{seg}: {exc}")
            continue
        if isinstance(pos_resp, dict):
            positions_list += pos_resp.get("positions") or pos_resp.get("data") or []
        elif isinstance(pos_resp, list):
            positions_list += pos_resp
    if not positions_list and seg_errors:
        raise HTTPException(status_code=502, detail="; ".join(seg_errors))

    # First pass: figure out which positions match the filters, so we can
    # cancel their smart orders BEFORE we send the SELL — otherwise the
    # OCO/GTT could fire on the same symbol while we're closing it and
    # cause duplicate fills (or rejections from Groww for "insufficient
    # holding" once the position is flat).
    eligible: List[Dict[str, Any]] = []
    for p in positions_list:
        net_qty = int(p.get("net_quantity") or p.get("quantity") or 0)
        if net_qty == 0:
            continue
        trading_symbol = p.get("trading_symbol") or p.get("symbol")
        if not trading_symbol:
            continue
        if payload.trading_symbol and trading_symbol != payload.trading_symbol:
            continue
        if payload.pnl_filter:
            pnl = float(p.get("pnl") or p.get("unrealised_pnl") or 0)
            if payload.pnl_filter == "positive" and pnl <= 0:
                continue
            if payload.pnl_filter == "negative" and pnl >= 0:
                continue
        eligible.append(p)

    cancelled_smart = await _cancel_smart_orders_for_symbols(
        api_, [p.get("trading_symbol") or p.get("symbol") for p in eligible]
    )

    results = []
    for p in eligible:
        net_qty = int(p.get("net_quantity") or p.get("quantity") or 0)
        trading_symbol = p.get("trading_symbol") or p.get("symbol")
        exchange = p.get("exchange") or "NSE"
        side_qty = abs(net_qty)
        qty_to_close = max(1, math.floor(side_qty * payload.percent / 100))
        txn = GrowwAPI.TRANSACTION_TYPE_SELL if net_qty > 0 else GrowwAPI.TRANSACTION_TYPE_BUY
        try:
            resp = await _call_blocking(
                api_.place_order,
                GrowwAPI.VALIDITY_DAY,
                exchange,
                GrowwAPI.ORDER_TYPE_MARKET,
                GrowwAPI.PRODUCT_NRML,
                qty_to_close,
                _segment_for(exchange),
                trading_symbol,
                txn,
                uuid.uuid4().hex[:18],
                0.0,
            )
            results.append({"trading_symbol": trading_symbol, "quantity": qty_to_close, "response": resp})
        except Exception as exc:  # noqa: BLE001
            results.append({"trading_symbol": trading_symbol, "error": str(exc)})

    # Positions / smart orders / margin just changed — drop caches so the
    # next poll shows the updated state.
    _invalidate_response_cache(token, "positions", "smart_orders", "margin")

    return {
        "closed": results,
        "count": len(results),
        "cancelled_smart_orders": cancelled_smart,
    }


@api.get("/orders/smart-orders")
async def list_smart_orders(token: str = Depends(require_token)):
    """Return all currently-ACTIVE smart orders so the frontend can render
    a 🛡 protection badge on the matching position rows."""
    if _is_demo(token):
        doc = await _demo_state_for(token)
        items = [so for so in doc.get("smart_orders", []) if so.get("status") == "ACTIVE"]
        return {"items": items}

    async def _produce():
        api_ = _groww_client(token)
        items = await _list_active_smart_orders(api_)
        # Normalise to a small subset of fields the frontend actually uses, so
        # downstream rendering doesn't depend on Groww's exact key names.
        out: List[Dict[str, Any]] = []
        for so in items:
            out.append({
                "smart_order_id": so.get("smart_order_id") or so.get("id"),
                "trading_symbol": so.get("trading_symbol") or so.get("symbol"),
                "smart_order_type": so.get("smart_order_type") or so.get("type"),
                "status": so.get("status") or "ACTIVE",
                "tp_price": so.get("target", {}).get("trigger_price") if isinstance(so.get("target"), dict) else so.get("tp_price"),
                "sl_price": so.get("stop_loss", {}).get("trigger_price") if isinstance(so.get("stop_loss"), dict) else so.get("sl_price"),
                "trigger_price": so.get("trigger_price"),
                "trigger_direction": so.get("trigger_direction"),
                "quantity": so.get("quantity"),
            })
        return {"items": out}

    return await _cached_response(("smart_orders", token), 1.5, _produce)


# ---------------------------------------------------------------------------
# Presets CRUD
# ---------------------------------------------------------------------------
@api.get("/presets")
async def list_presets():
    out: List[Dict[str, Any]] = []
    for default in DEFAULT_PRESETS:
        stored = await db.presets.find_one({"key": default.key}, {"_id": 0})
        out.append(stored or default.model_dump())
    return {"items": out}


@api.get("/presets/{key}")
async def get_preset(key: str):
    stored = await db.presets.find_one({"key": key}, {"_id": 0})
    if stored:
        return stored
    default = next((p for p in DEFAULT_PRESETS if p.key == key), None)
    if not default:
        raise HTTPException(status_code=404, detail="Preset not found")
    return default.model_dump()


@api.put("/presets/{key}")
async def update_preset(key: str, preset: Preset):
    preset.key = key
    await db.presets.update_one({"key": key}, {"$set": preset.model_dump()}, upsert=True)
    return preset.model_dump()


# ---------------------------------------------------------------------------
# Settings (global, per-device — single-user app)
# ---------------------------------------------------------------------------
@api.get("/settings", response_model=Settings)
async def get_settings():
    doc = await db.settings.find_one({"_id": "user"}, {"_id": 0})
    return Settings(**(doc or {}))


@api.put("/settings", response_model=Settings)
async def update_settings(settings: Settings):
    await db.settings.update_one({"_id": "user"}, {"$set": settings.model_dump()}, upsert=True)
    return settings


# ---------------------------------------------------------------------------
# FX
# ---------------------------------------------------------------------------
_FX_CACHE: Dict[str, Any] = {"ts": 0.0, "rate": None}


@api.get("/fx/inr-to-usd")
async def inr_to_usd():
    now = time.time()
    if _FX_CACHE["rate"] is not None and (now - _FX_CACHE["ts"]) < 600:
        return {"rate": _FX_CACHE["rate"], "cached": True}
    try:
        async with httpx.AsyncClient(timeout=10) as cli:
            resp = await cli.get("https://open.er-api.com/v6/latest/INR")
            j = resp.json()
            rate = float(j.get("rates", {}).get("USD") or 0)
            if rate <= 0:
                raise ValueError("Bad rate")
            _FX_CACHE["rate"] = rate
            _FX_CACHE["ts"] = now
            return {"rate": rate, "cached": False}
    except Exception as exc:  # noqa: BLE001
        # graceful default
        fallback = 0.012
        return {"rate": fallback, "cached": False, "fallback": True, "error": str(exc)}


# ---------------------------------------------------------------------------
# Bootstrap
# ---------------------------------------------------------------------------
app.include_router(api)
app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def seed_defaults():
    for p in DEFAULT_PRESETS:
        existing = await db.presets.find_one({"key": p.key})
        if not existing:
            await db.presets.insert_one(p.model_dump())
    existing_settings = await db.settings.find_one({"_id": "user"})
    if not existing_settings:
        await db.settings.insert_one({"_id": "user", **Settings().model_dump()})

    # Pre-warm the instrument-master cache from disk so the very first
    # /instruments/* request doesn't pay the cold-load tax (~5-10s on the
    # Droplet's slow link to Groww). The disk snapshot is refreshed
    # on-demand inside _load_instruments when stale.
    try:
        await asyncio.to_thread(_instruments_load_from_disk)
    except Exception as exc:  # noqa: BLE001
        logger.warning("instruments: disk pre-warm failed: %s", exc)


@app.on_event("shutdown")
async def shutdown_db_client():
    mongo_client.close()
