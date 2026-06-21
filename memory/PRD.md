# ScalpX – Groww Options Scalping App (PRD)

## Goal
Mobile app for one-tap options scalping in the Indian market through the official Groww Trading API. Users connect their Groww account once, then place market / limit orders with preset risk profiles directly from the home screen.

## Stack
- **Frontend**: Expo 54, expo-router, React Native (Arial typography), `expo-secure-store` for credentials, `react-native-safe-area-context`.
- **Backend**: FastAPI + `growwapi==1.5.0` SDK, MongoDB via Motor.
- **Auth model**: Stateless. The user’s Groww access token lives in the device keychain and is sent via `X-Groww-Token` header on each request.

## Screens
1. **Login** (`/login`) – API key + TOTP base32 secret + “Save securely” switch. Posts to `/api/auth/login` (server runs `pyotp` and exchanges for an access token).
2. **Home** (`/home`) – Sticky header (underlying + expiry + kebab menu), capital/PnL/balance card with dotted-line separators, scrollable positions list, sticky footer with: Max-Loss pill, CE/PE toggle, 4 preset BUY buttons (MKT = blue, LMT = navy), and EXIT 25 / 50 / ALL buttons.
3. **Preset edit** (`/preset?key=...`) – Strike selection (`HIGH_GAMMA` / `ATM` / `OTM1` / `OTM2` / `ITM1`), IV filter (`LOW_IV` / `HIGH_IV` / `ANY`), Position sizing %, Stop-loss %, Take-profit %, Order type, Limit offset %.
4. **Order History** (`/history`) – List of past Groww orders with status pills.
5. **Settings** (`/settings`) – Confirm-before-order, daily-max-loss prompt, INR↔USD display toggle, save-last-underlying, Log out.

## Backend endpoints (all under `/api`)
- `POST /auth/login` `{api_key, api_secret}` → `{access_token}`
- `GET /auth/verify`
- `GET /account/{margin,positions,orders}`
- `GET /instruments/underlyings?q=` (cached F&O master)
- `GET /instruments/expiries`, `GET /instruments/option-chain`
- `POST /orders/place-preset` (chooses strike per preset, sizes lots, places order, logs to `db.order_logs`)
- `POST /orders/exit` `{percent: 25|50|100}` (places opposite orders for open positions)
- `GET/PUT /presets`, `GET/PUT /presets/{key}`
- `GET/PUT /settings`
- `GET /fx/inr-to-usd` (open.er-api.com, 10-min cache)

## Smart preset behaviour
- On preset tap: backend pulls option chain for `(underlying, expiry)`, picks a strike based on `strike_selection`, applies `iv_filter`, then computes quantity from `capital * position_sizing_pct` divided by `lot_size * ltp`. Confirmation bottom sheet (toggleable in settings) gates the call.
- CE / PE toggle on the home screen swaps option type for all 4 buy buttons.

## Notable behaviour
- Positive PnL is rendered in **royal blue (#1A4DFF)**, matching the user-supplied screenshot — not green.
- All credentials persist via `expo-secure-store` (iOS Keychain / Android Keystore).
- Settings + presets are seeded in MongoDB on first boot.
- Long-press on any BUY button opens the preset-edit screen for that preset.

## Smart business enhancement
On the home screen footer, the **Max-Loss pill** is intentionally placed beside the CE/PE toggle so the user is constantly reminded of their daily risk envelope — this small piece of friction is a meaningful loss-aversion guard and a differentiator vs. raw broker apps.
