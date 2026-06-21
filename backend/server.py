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
import logging
import math
import os
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
# Groww's get_all_instruments() returns a full CSV (~50 k rows). We cache it in
# memory for an hour and reuse it across requests.
_INSTRUMENTS_CACHE: Dict[str, Any] = {"loaded_at": 0.0, "df": None}
_INSTRUMENTS_TTL = 60 * 60  # 1h


def _load_instruments(token: str):
    now = time.time()
    if _INSTRUMENTS_CACHE["df"] is not None and (now - _INSTRUMENTS_CACHE["loaded_at"]) < _INSTRUMENTS_TTL:
        return _INSTRUMENTS_CACHE["df"]
    try:
        api = GrowwAPI(token)
        df = api.get_all_instruments()
        _INSTRUMENTS_CACHE["df"] = df
        _INSTRUMENTS_CACHE["loaded_at"] = now
        return df
    except Exception as exc:  # noqa: BLE001
        logger.exception("Failed to load instruments: %s", exc)
        return _INSTRUMENTS_CACHE["df"]  # may be None


# ---------------------------------------------------------------------------
# Auth helpers
# ---------------------------------------------------------------------------
async def require_token(x_groww_token: Optional[str] = Header(None)) -> str:
    if not x_groww_token:
        raise HTTPException(status_code=401, detail="Missing X-Groww-Token header")
    return x_groww_token


def _groww_client(token: str) -> GrowwAPI:
    try:
        return GrowwAPI(token)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=401, detail=f"Invalid Groww token: {exc}") from exc


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
    Preset(key="breakout_mkt", label="BUY BREAKOUT CALL MKT", strike_selection="HIGH_GAMMA", iv_filter="LOW_IV", position_sizing_pct=25.0, stop_loss_pct=5.0, order_type="MARKET"),
    Preset(key="breakout_chaser_lmt", label="BUY BREAKOUT CHASER CALL LMT", strike_selection="HIGH_GAMMA", iv_filter="LOW_IV", position_sizing_pct=25.0, stop_loss_pct=5.0, order_type="LIMIT", limit_offset_pct=0.5),
    Preset(key="steady_mkt", label="BUY STEADY CALL MKT", strike_selection="ATM", iv_filter="ANY", position_sizing_pct=20.0, stop_loss_pct=4.0, order_type="MARKET"),
    Preset(key="steady_lmt", label="BUY STEADY CALL LMT", strike_selection="ATM", iv_filter="ANY", position_sizing_pct=20.0, stop_loss_pct=4.0, order_type="LIMIT", limit_offset_pct=0.3),
]


class Settings(BaseModel):
    confirm_before_order: bool = True
    ask_max_loss_at_startup: bool = True
    convert_to_usd: bool = False
    save_last_underlying: bool = True
    last_underlying: Optional[str] = None
    last_underlying_expiry: Optional[str] = None  # YYYY-MM-DD


class PlacePresetOrderRequest(BaseModel):
    preset_key: str
    underlying: str  # e.g., NIFTY, BANKNIFTY, RELIANCE
    expiry: str  # YYYY-MM-DD
    option_type: str  # CE | PE
    exchange: str = "NSE"
    capital: float  # used for position sizing
    dry_run: bool = False


class ExitRequest(BaseModel):
    percent: int  # 25 | 50 | 100


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


def _demo_positions() -> Dict[str, Any]:
    return {
        "positions": [
            {
                "trading_symbol": "NIFTY24700CE",
                "exchange": "NSE",
                "product": "NRML",
                "net_quantity": 75 * 27,
                "average_price": 145.80,
                "last_price": 155.85,
                "pnl": 20334.6,
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
                "pnl": 14556.0,
                "transaction_type": "BUY",
                "created_at": "2026-06-20 11:24:05",
            },
        ]
    }


def _demo_orders() -> Dict[str, Any]:
    return {
        "orders": [
            {
                "order_id": "demo-001",
                "trading_symbol": "NIFTY24700CE",
                "transaction_type": "BUY",
                "order_status": "EXECUTED",
                "quantity": 75 * 27,
                "filled_quantity": 75 * 27,
                "average_price": 145.80,
                "order_type": "MARKET",
                "exchange_time": "2026-06-20 11:18:05",
            },
            {
                "order_id": "demo-002",
                "trading_symbol": "NIFTY24800CE",
                "transaction_type": "BUY",
                "order_status": "EXECUTED",
                "quantity": 75 * 27,
                "filled_quantity": 75 * 27,
                "average_price": 150.80,
                "order_type": "MARKET",
                "exchange_time": "2026-06-20 11:24:05",
            },
        ]
    }


def _demo_expiries() -> Dict[str, Any]:
    """Return ~8 weekly + 4 monthly expiries (Thursday rolls)."""
    today = datetime.now(timezone.utc).date()
    days_ahead = (3 - today.weekday()) % 7  # next Thursday
    out = []
    # 8 weeklies
    for w in range(8):
        d = today + timedelta(days=days_ahead + 7 * w)
        out.append(d.isoformat())
    # 4 additional monthlies — last Thursday of the next 4 months after weeklies end
    from calendar import monthrange
    base = today.replace(day=1)
    for m in range(2, 6):
        year = base.year + (base.month - 1 + m) // 12
        month = (base.month - 1 + m) % 12 + 1
        last_day = monthrange(year, month)[1]
        # walk back to last Thursday
        d = datetime(year, month, last_day).date()
        while d.weekday() != 3:
            d -= timedelta(days=1)
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
@api.get("/account/margin")
async def margin(token: str = Depends(require_token)):
    if _is_demo(token):
        return _demo_margin()
    api_ = _groww_client(token)
    try:
        data = await _call_blocking(api_.get_available_margin_details)
        return data
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@api.get("/account/positions")
async def positions(token: str = Depends(require_token)):
    if _is_demo(token):
        return _demo_positions()
    api_ = _groww_client(token)
    try:
        data = await _call_blocking(api_.get_positions_for_user, GrowwAPI.SEGMENT_FNO)
        return data
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@api.get("/account/orders")
async def orders_history(page: int = 0, page_size: int = 50, token: str = Depends(require_token)):
    if _is_demo(token):
        return _demo_orders()
    api_ = _groww_client(token)
    try:
        data = await _call_blocking(api_.get_order_list, page, page_size, GrowwAPI.SEGMENT_FNO)
        return data
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc)) from exc


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
FNO_STOCK_ITEMS = [{"symbol": s, "name": s, "type": "STOCK"} for s in FNO_STOCKS]


@api.get("/instruments/underlyings")
async def underlyings(q: str = "", token: str = Depends(require_token)):
    """Searchable list of F&O underlyings (indices + stocks)."""
    if _is_demo(token):
        results = list(INDEX_UNDERLYINGS) + list(FNO_STOCK_ITEMS)
        if q:
            qu = q.upper()
            results = [r for r in results if qu in r["symbol"].upper() or qu in r["name"].upper()]
        return {"items": results[:300]}
    df = _load_instruments(token)
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
                    results.append({"symbol": sym, "name": sym, "type": "STOCK"})
        except Exception as exc:  # noqa: BLE001
            logger.warning("Underlying search fallback: %s", exc)
    # Fallback: if the instrument-master couldn't be loaded, append the curated list.
    if len(results) <= len(INDEX_UNDERLYINGS):
        existing = {u["symbol"] for u in results}
        for item in FNO_STOCK_ITEMS:
            if item["symbol"] not in existing:
                results.append(item)

    if q:
        qu = q.upper()
        results = [r for r in results if qu in r["symbol"].upper() or qu in r["name"].upper()]
    return {"items": results[:300]}


@api.get("/instruments/expiries")
async def expiries(underlying: str, exchange: str = "NSE", token: str = Depends(require_token)):
    if _is_demo(token):
        return _demo_expiries()
    api_ = _groww_client(token)
    try:
        data = await _call_blocking(api_.get_expiries, exchange, underlying)
        return data
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@api.get("/instruments/option-chain")
async def option_chain(
    underlying: str,
    expiry: str,
    exchange: str = "NSE",
    option_type: str = "CE",
    token: str = Depends(require_token),
):
    api_ = _groww_client(token)
    try:
        data = await _call_blocking(api_.get_option_chain, exchange, underlying, expiry)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc)) from exc
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


@api.post("/orders/place-preset")
async def place_preset_order(payload: PlacePresetOrderRequest, token: str = Depends(require_token)):
    # Demo mode: fake an order success and append to demo log
    if _is_demo(token):
        fake_symbol = f"{payload.underlying}24800{payload.option_type}"
        return {
            "selected": {"trading_symbol": fake_symbol, "strike": 24800, "ltp": 152.5},
            "quantity": 75,
            "lots": 1,
            "lot_size": 75,
            "order": {"trading_symbol": fake_symbol, "transaction_type": "BUY", "order_type": "MARKET"},
            "response": {"order_id": f"demo-{uuid.uuid4().hex[:8]}", "status": "EXECUTED"},
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
    try:
        chain_raw = await _call_blocking(api_.get_option_chain, payload.exchange, payload.underlying, payload.expiry)
    except Exception as exc:  # noqa: BLE001
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
    rows = _normalize_chain(chain_raw)
    pick = _pick_strike(rows, spot, payload.option_type, preset_doc["strike_selection"], preset_doc["iv_filter"])
    if not pick:
        raise HTTPException(status_code=404, detail="No strike matched the preset criteria")

    # 3. Compute quantity from capital * sizing
    sizing = float(preset_doc["position_sizing_pct"]) / 100.0
    risk_capital = max(0.0, payload.capital) * sizing
    lot_size = 1
    df = _load_instruments(token)
    if df is not None:
        try:
            row = df[df["trading_symbol"].astype(str) == pick["trading_symbol"]]
            if not row.empty and "lot_size" in row.columns:
                lot_size = int(row.iloc[0]["lot_size"]) or 1
        except Exception:  # noqa: BLE001
            pass
    contract_cost = max(0.01, pick["ltp"]) * lot_size
    lots = max(1, math.floor(risk_capital / contract_cost)) if contract_cost > 0 else 1
    quantity = lots * lot_size

    order_type = preset_doc["order_type"]
    price = 0.0
    if order_type == "LIMIT":
        offset = float(preset_doc.get("limit_offset_pct", 0.5)) / 100.0
        price = round(pick["ltp"] * (1 + offset), 1)

    order_payload = {
        "validity": GrowwAPI.VALIDITY_DAY,
        "exchange": payload.exchange,
        "order_type": GrowwAPI.ORDER_TYPE_LIMIT if order_type == "LIMIT" else GrowwAPI.ORDER_TYPE_MARKET,
        "product": GrowwAPI.PRODUCT_NRML,
        "quantity": quantity,
        "segment": GrowwAPI.SEGMENT_FNO,
        "trading_symbol": pick["trading_symbol"],
        "transaction_type": GrowwAPI.TRANSACTION_TYPE_BUY,
        "order_reference_id": uuid.uuid4().hex[:18],
        "price": price,
    }

    if payload.dry_run:
        return {
            "dry_run": True,
            "selected": pick,
            "quantity": quantity,
            "lot_size": lot_size,
            "lots": lots,
            "order": order_payload,
            "spot": spot,
        }

    try:
        resp = await _call_blocking(api_.place_order, **order_payload)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"Order placement failed: {exc}") from exc

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
        "created_at": datetime.now(timezone.utc).isoformat(),
    })

    return {"selected": pick, "quantity": quantity, "lots": lots, "lot_size": lot_size, "order": order_payload, "response": resp}


@api.post("/orders/exit")
async def exit_positions(payload: ExitRequest, token: str = Depends(require_token)):
    if payload.percent not in (25, 50, 100):
        raise HTTPException(status_code=400, detail="percent must be 25, 50, or 100")
    if _is_demo(token):
        return {"closed": [{"trading_symbol": "DEMO", "quantity": payload.percent, "response": {"status": "DEMO"}}], "count": 1}
    api_ = _groww_client(token)
    try:
        pos_resp = await _call_blocking(api_.get_positions_for_user, GrowwAPI.SEGMENT_FNO)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    positions_list: List[Dict[str, Any]] = []
    if isinstance(pos_resp, dict):
        positions_list = pos_resp.get("positions") or pos_resp.get("data") or []
    elif isinstance(pos_resp, list):
        positions_list = pos_resp

    results: List[Dict[str, Any]] = []
    for p in positions_list:
        net_qty = int(p.get("net_quantity") or p.get("quantity") or 0)
        if net_qty == 0:
            continue
        trading_symbol = p.get("trading_symbol") or p.get("symbol")
        if not trading_symbol:
            continue
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
                GrowwAPI.SEGMENT_FNO,
                trading_symbol,
                txn,
                uuid.uuid4().hex[:18],
                0.0,
            )
            results.append({"trading_symbol": trading_symbol, "quantity": qty_to_close, "response": resp})
        except Exception as exc:  # noqa: BLE001
            results.append({"trading_symbol": trading_symbol, "error": str(exc)})

    return {"closed": results, "count": len(results)}


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


@app.on_event("shutdown")
async def shutdown_db_client():
    mongo_client.close()
