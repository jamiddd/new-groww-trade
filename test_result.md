#====================================================================================================
# START - Testing Protocol - DO NOT EDIT OR REMOVE THIS SECTION
#====================================================================================================

# THIS SECTION CONTAINS CRITICAL TESTING INSTRUCTIONS FOR BOTH AGENTS
# BOTH MAIN_AGENT AND TESTING_AGENT MUST PRESERVE THIS ENTIRE BLOCK

# Communication Protocol:
# If the `testing_agent` is available, main agent should delegate all testing tasks to it.
#
# You have access to a file called `test_result.md`. This file contains the complete testing state
# and history, and is the primary means of communication between main and the testing agent.
#
# Main and testing agents must follow this exact format to maintain testing data. 
# The testing data must be entered in yaml format Below is the data structure:
# 
## user_problem_statement: {problem_statement}
## backend:
##   - task: "Task name"
##     implemented: true
##     working: true  # or false or "NA"
##     file: "file_path.py"
##     stuck_count: 0
##     priority: "high"  # or "medium" or "low"
##     needs_retesting: false
##     status_history:
##         -working: true  # or false or "NA"
##         -agent: "main"  # or "testing" or "user"
##         -comment: "Detailed comment about status"
##
## frontend:
##   - task: "Task name"
##     implemented: true
##     working: true  # or false or "NA"
##     file: "file_path.js"
##     stuck_count: 0
##     priority: "high"  # or "medium" or "low"
##     needs_retesting: false
##     status_history:
##         -working: true  # or false or "NA"
##         -agent: "main"  # or "testing" or "user"
##         -comment: "Detailed comment about status"
##
## metadata:
##   created_by: "main_agent"
##   version: "1.0"
##   test_sequence: 0
##   run_ui: false
##
## test_plan:
##   current_focus:
##     - "Task name 1"
##     - "Task name 2"
##   stuck_tasks:
##     - "Task name with persistent issues"
##   test_all: false
##   test_priority: "high_first"  # or "sequential" or "stuck_first"
##
## agent_communication:
##     -agent: "main"  # or "testing" or "user"
##     -message: "Communication message between agents"

# Protocol Guidelines for Main agent
#
# 1. Update Test Result File Before Testing:
#    - Main agent must always update the `test_result.md` file before calling the testing agent
#    - Add implementation details to the status_history
#    - Set `needs_retesting` to true for tasks that need testing
#    - Update the `test_plan` section to guide testing priorities
#    - Add a message to `agent_communication` explaining what you've done
#
# 2. Incorporate User Feedback:
#    - When a user provides feedback that something is or isn't working, add this information to the relevant task's status_history
#    - Update the working status based on user feedback
#    - If a user reports an issue with a task that was marked as working, increment the stuck_count
#    - Whenever user reports issue in the app, if we have testing agent and task_result.md file so find the appropriate task for that and append in status_history of that task to contain the user concern and problem as well 
#
# 3. Track Stuck Tasks:
#    - Monitor which tasks have high stuck_count values or where you are fixing same issue again and again, analyze that when you read task_result.md
#    - For persistent issues, use websearch tool to find solutions
#    - Pay special attention to tasks in the stuck_tasks list
#    - When you fix an issue with a stuck task, don't reset the stuck_count until the testing agent confirms it's working
#
# 4. Provide Context to Testing Agent:
#    - When calling the testing agent, provide clear instructions about:
#      - Which tasks need testing (reference the test_plan)
#      - Any authentication details or configuration needed
#      - Specific test scenarios to focus on
#      - Any known issues or edge cases to verify
#
# 5. Call the testing agent with specific instructions referring to test_result.md
#
# IMPORTANT: Main agent must ALWAYS update test_result.md BEFORE calling the testing agent, as it relies on this file to understand what to test next.

#====================================================================================================
# END - Testing Protocol - DO NOT EDIT OR REMOVE THIS SECTION
#====================================================================================================



#====================================================================================================
# Testing Data - Main Agent and testing sub agent both should log testing data below this section
#====================================================================================================

user_problem_statement: |
  Latency / 502 errors on the ScalpX backend after the Droplet redeploy. The user
  reported underlyings, order history, and strike computation loading extremely
  slowly. Root cause: serial Groww API calls + a large (50k-row) cold instrument
  master fetch on every fresh container + repeated option-chain fetches during
  dry-runs and strike previews.

backend:
  - task: "Parallelise /api/account/orders fan-out with asyncio.gather"
    implemented: true
    working: true
    file: "/app/backend/server.py"
    stuck_count: 0
    priority: "high"
    needs_retesting: true
    status_history:
      - working: true
        agent: "main"
        comment: "Verified previous-session edit landed: orders_history now fires no-segment + FNO + CASH + COMMODITY in parallel via asyncio.gather (lines ~925). Demo path responds in <100 ms."

  - task: "Single-flight + disk-persisted instrument-master cache"
    implemented: true
    working: true
    file: "/app/backend/server.py"
    stuck_count: 0
    priority: "high"
    needs_retesting: true
    status_history:
      - working: true
        agent: "main"
        comment: "Wrapped _load_instruments in a threading.Lock so concurrent cold requests no longer trigger N parallel 50k-row downloads. Successful loads are pickled to /tmp/scalpx_instruments.pkl (6h TTL) and the FastAPI startup hook now warms the in-memory cache from that pickle. Added _load_instruments_async helper and switched the three async call sites (/instruments/underlyings, /instruments/master-debug, place_preset_order) to use it so the event loop never blocks on a cold CSV download."

  - task: "Parallelise /api/instruments/expiries 2-year historical fallback"
    implemented: true
    working: true
    file: "/app/backend/server.py"
    stuck_count: 0
    priority: "medium"
    needs_retesting: true
    status_history:
      - working: true
        agent: "main"
        comment: "When the live instrument-master scan returns no expiries we now hit Groww's historical /get_expiries for (current_year, current_year+1) in parallel via asyncio.gather instead of serially."

  - task: "Client-driven architecture (Phase 1+2+3)"
    implemented: true
    working: "NA"
    file: "/app/backend/server.py, /app/frontend/**"
    stuck_count: 0
    priority: "high"
    needs_retesting: true
    status_history:
      - working: "NA"
        agent: "main"
        comment: |
          Major architecture shift to eliminate latency:
          BACKEND:
            * NEW /api/bootstrap — single parallel fetch (margin + positions + orders + smart_orders). Called once at app open.
            * NEW POST /api/ltp/batch — fan-out LTP fetch (semaphore=6, 4s timeout/item). Only endpoint polled in steady state (1s for live positions, 1s for confirm dialog strike).
            * NEW /api/orders/since?after_id= — incremental delta sync for the order log.
          FRONTEND:
            * /app/frontend/assets/underlyings.json — bundled 212 underlyings (indices + MCX + 190 F&O stocks). Search is now instant.
            * src/utils/expiries.ts — SEBI-rule-based expiry computation in JS. NIFTY (Tue weekly), SENSEX (Thu weekly), monthly last-Thu (NSE) / last-Tue (BSE) / MCX-specific. Zero API calls.
            * src/data/underlyings.ts — bundled-data lookup + search.
            * src/utils/localStore.ts — AsyncStorage JSON wrapper.
            * src/state/orderLog.ts — local order history with 30-day retention, dedupe by groww_order_id, newest-first sort.
            * src/state/positionPnl.ts — client-side live P&L = (ltp - avg_price) * net_qty.
            * src/hooks/useLtpPoller.ts — 1s LTP poller with auto-throttle to 2s on >5 symbols, AppState-aware (pauses in background).
            * home.tsx — replaces 5s margin/positions/smart-orders polling with one bootstrap call + LTP poller. Hydrates from AsyncStorage for instant paint.
            * history.tsx — renders from AsyncStorage instantly, delta-syncs via /orders/since.
            * UnderlyingSearchSheet.tsx — now uses bundled JSON, no API.
          Net result: steady-state API hit goes from ~3 reqs/5s (15+ Groww calls under burst) to ~1 batch req/s only when positions/dialog exist. Underlying search, expiry list, order history first paint = 0 ms (local).
    implemented: true
    working: "NA"
    file: "/app/backend/server.py"
    stuck_count: 0
    priority: "high"
    needs_retesting: true
    status_history:
      - working: "NA"
        agent: "main"
        comment: "Added a 1.5s per-token TTL + asyncio.Lock single-flight wrapper (_cached_response) around the three hot polling endpoints. The user's Droplet logs showed 5 concurrent client connections × 3 polling endpoints firing in the same 200ms window, triggering Groww's rate limiter ('Rate limit has breached for your request'). The cache coalesces those bursts into one upstream call per 1.5s window. State-mutating endpoints (place-preset, exit, refresh-capital) explicitly invalidate the relevant cache keys via _invalidate_response_cache(token, ...) so the next poll never serves stale data after a buy/sell."

  - task: "Disk cache persisted to docker volume so it survives `docker compose up --build`"
    implemented: true
    working: "NA"
    file: "/app/backend/server.py, /app/deploy/docker-compose.yml"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
      - working: "NA"
        agent: "main"
        comment: "Root cause of the 60s WORKER TIMEOUT after redeploy: /tmp/scalpx_instruments.pkl was inside the container and got wiped on `--build`, so the first request triggered a cold 162k-row download which hit gunicorn's 60s --timeout. Added SCALPX_CACHE_DIR env var (defaults to /tmp for dev), pointed it at a docker volume `scalpx_cache` mounted at /var/scalpx-cache, and added the named volume in docker-compose.yml. Now the pickle survives rebuilds."

  - task: "Per-token GrowwAPI client cache"
    implemented: true
    working: "NA"
    file: "/app/backend/server.py"
    stuck_count: 0
    priority: "high"
    needs_retesting: true
    status_history:
      - working: "NA"
        agent: "main"
        comment: "_groww_client(token) was instantiating a fresh GrowwAPI per request (every 'Ready to Groww!' log line). Now caches per-token behind threading.Lock with FIFO eviction at 32 entries."

  - task: "Hard asyncio.wait_for timeouts on hot Groww endpoints"
    implemented: true
    working: "NA"
    file: "/app/backend/server.py"
    stuck_count: 0
    priority: "high"
    needs_retesting: true
    status_history:
      - working: "NA"
        agent: "main"
        comment: "Wrapped /account/margin, /account/positions (per segment), /orders/smart-orders, and /account/orders (per segment) with 8s asyncio.wait_for caps. Previously, a hanging Groww call could block a gunicorn worker until the 60s --timeout fired and SIGKILL killed it. Now the request returns 504 / [] gracefully and the worker stays alive."
    implemented: true
    working: true
    file: "/app/backend/server.py"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
      - working: true
        agent: "main"
        comment: "Introduced _get_option_chain_cached with a 2s TTL keyed on (exchange, underlying, expiry) and an asyncio.Lock per key. Both /instruments/option-chain and place_preset_order go through this wrapper, so back-to-back strike previews + dry-runs share one Groww round-trip and the existing 6s hard timeout is preserved."
      - working: false
        agent: "testing"
        comment: "iter22: /instruments/option-chain had no _is_demo short-circuit so demo callers got 502."
      - working: true
        agent: "main"
        comment: "iter23: Added _demo_option_chain() helper and a demo branch at the top of the endpoint. Synthetic chain returns 13 strikes around the underlying-specific ATM with full CE+PE legs (trading_symbol/ltp/IV/gamma)."
      - working: true
        agent: "testing"
        comment: "iter23: 11/11 backend tests pass. Demo option-chain returns 200, content validated for NIFTY (spot=24700) and BANKNIFTY (spot=51100). Burst of 5 concurrent demo GETs completes in ~13ms with no 5xx. All regression endpoints green."

frontend:
  - task: "Frontend latency UX (untouched in this pass)"
    implemented: true
    working: "NA"
    file: "/app/frontend/app/home.tsx"
    stuck_count: 0
    priority: "low"
    needs_retesting: false
    status_history:
      - working: "NA"
        agent: "main"
        comment: "No frontend code changed this pass. Frontend continues to point at the Droplet IP via EXPO_PUBLIC_BACKEND_URL; speed-up is delivered server-side."

metadata:
  created_by: "main_agent"
  version: "1.1"
  test_sequence: 22
  run_ui: false

test_plan:
  current_focus:
    - "Single-flight + disk-persisted instrument-master cache"
    - "Short-TTL single-flight cache around get_option_chain"
    - "Parallelise /api/instruments/expiries 2-year historical fallback"
    - "Parallelise /api/account/orders fan-out with asyncio.gather"
  stuck_tasks: []
  test_all: false
  test_priority: "high_first"

agent_communication:
  - agent: "main"
    message: |
      Performance pass on the Groww-facing FastAPI backend. Please test the
      following in DEMO mode (token `DEMO__SCALPX__TOKEN` via `X-Groww-Token`
      header) since the Droplet's live Groww auth can't be exercised from this
      pod:

      1. GET /api/instruments/underlyings?q=NIF — should return <500ms and
         include NIFTY/BANKNIFTY/FINNIFTY/MIDCPNIFTY.
      2. GET /api/instruments/expiries?underlying=NIFTY&exchange=NSE — should
         return a sorted future-dated `expiries` array quickly.
      3. GET /api/account/orders — demo order history must not 5xx and should
         return within ~1s.
      4. POST /api/orders/place-preset with `dry_run: true` against the demo
         token (any preset key from DEFAULT_PRESETS) — confirm the dry-run
         response includes a `pick` and basic sizing fields.
      5. Burst-fire 5 concurrent GET /api/instruments/option-chain requests for
         the same (NIFTY, nearest expiry, NSE) tuple — verify they all succeed
         and (via logs) only one fan-out to Groww happens within the 2s TTL.

      No real Groww credentials are needed — exercise demo mode only. Use
      MONGO_URL from /app/backend/.env. Report any non-2xx responses, regressions
      vs the existing behaviour, or sub-second→multi-second slowdowns.
