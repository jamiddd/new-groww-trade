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

  - task: "Short-TTL single-flight cache around get_option_chain"
    implemented: true
    working: true
    file: "/app/backend/server.py"
    stuck_count: 0
    priority: "high"
    needs_retesting: true
    status_history:
      - working: true
        agent: "main"
        comment: "Introduced _get_option_chain_cached with a 2s TTL keyed on (exchange, underlying, expiry) and an asyncio.Lock per key. Both /instruments/option-chain and place_preset_order go through this wrapper, so back-to-back strike previews + dry-runs share one Groww round-trip and the existing 6s hard timeout is preserved. Demo expiries/underlyings curl responses verified."

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
