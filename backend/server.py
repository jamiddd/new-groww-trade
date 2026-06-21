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
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

import httpx
import pyotp
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
    api_ = _groww_client(token)
    try:
        profile = await _call_blocking(api_.get_user_profile)
        return {"ok": True, "profile": profile}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=401, detail=f"Token invalid: {exc}") from exc


# ---------------------------------------------------------------------------
# Account
# ---------------------------------------------------------------------------
@api.get("/account/margin")
async def margin(token: str = Depends(require_token)):
    api_ = _groww_client(token)
    try:
        data = await _call_blocking(api_.get_available_margin_details)
        return data
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@api.get("/account/positions")
async def positions(token: str = Depends(require_token)):
    api_ = _groww_client(token)
    try:
        data = await _call_blocking(api_.get_positions_for_user, GrowwAPI.SEGMENT_FNO)
        return data
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@api.get("/account/orders")
async def orders_history(page: int = 0, page_size: int = 50, token: str = Depends(require_token)):
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


@api.get("/instruments/underlyings")
async def underlyings(q: str = "", token: str = Depends(require_token)):
    """Searchable list of F&O underlyings (indices + stocks)."""
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

    if q:
        qu = q.upper()
        results = [r for r in results if qu in r["symbol"].upper() or qu in r["name"].upper()]
    return {"items": results[:200]}


@api.get("/instruments/expiries")
async def expiries(underlying: str, exchange: str = "NSE", token: str = Depends(require_token)):
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
