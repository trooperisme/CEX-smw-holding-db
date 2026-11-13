# Playground

This workspace keeps Codex-facing instructions at the root and separates runtime clutter into `data/` and `runs/` without changing the root command flow.

## Workspace Layout

- `AGENTS.md`, `CODEX_CHEATSHEET.md`, `.codex/`, `.agency-agents/`, `.firecrawl/`: stable Codex workflow anchors
- `MACRO_WORKFLOW.md`, `MACRO_WORKFLOW_PROMPTS.md`: macro research operating spec and copy-paste workflow sheet
- `src/`, `scripts/`, `dashboard/`, `supabase/`: app source and source-adjacent assets
- `data/wallet-scraper/`: durable wallet inputs, processed outputs, DB, and exported dashboards
- `data/macro-workflow/`: macro eval set, scratchpad schema, and workflow assets
- `runs/wallet-scraper/<run-name>/`: browser profiles, screenshots, logs, and run-specific outputs
- `tmp/`: disposable local experiments and imported scratch material

## Macro Research Workflow

This workspace also contains a prompt-and-process macro workflow built on top of Agency roles, without turning the repo into a standalone autonomous finance agent.

Use:
- [MACRO_WORKFLOW.md](/Users/nguyentrancongnguyen/Documents/Playground/MACRO_WORKFLOW.md) for the control-layer rules: planner, source router, validator, handoff schema, scratchpad, and synthesis gate
- [MACRO_WORKFLOW_PROMPTS.md](/Users/nguyentrancongnguyen/Documents/Playground/MACRO_WORKFLOW_PROMPTS.md) for the copy-paste workflow prompts
- [data/macro-workflow/README.md](/Users/nguyentrancongnguyen/Documents/Playground/data/macro-workflow/README.md) for eval and logging assets

## Main App

The main app is still the crypto wallet portfolio tracker. Root npm commands stay unchanged.

## Setup

```bash
npm install
cp .env.example .env
```

Optional:
- Configure `GOOGLE_SHEETS_API_KEY` + `SPREADSHEET_ID` to load wallets from Google Sheets.
- Configure `SHEET_NAME`/`SHEET_GID` for the tracked entity tab (default is `Database` / `919437919`).
- Configure `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` to enable Supabase-backed storage for signals and manual sheet-to-Supabase sync.
- By default browser automation prefers an existing Chrome CDP session at `http://127.0.0.1:9222` (`PREFER_CDP_BROWSER=true`).
- If Sheets is not configured, edit the local wallets file. The app will read the legacy root `wallets.json` when present, otherwise it will use `data/wallet-scraper/raw/wallets.json`.
- Optional runtime path env vars:
  - `BROWSER_PROFILE_DIR`
  - `SCREENSHOTS_DIR`
  - `DATA_DIR`
  - `EXPORTS_DIR`
  - `RUNS_DIR`

## Vercel Variables

Vercel hosts the dashboard and API. Configure these production variables there:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `APP_USERNAME` (defaults to `admin`)
- `APP_PASSWORD`
- `APP_COOKIE_SECRET`

Optional Vercel variables for sheet-backed wallet loading or manual sync:

  - `GOOGLE_SHEETS_API_KEY`
  - `SPREADSHEET_ID`
  - `SHEET_NAME`
  - `SHEET_GID`

Do not configure `DATA_DIR=/data` or `HOSTED_DATA_ROOT=/data` on Vercel. The
filesystem is ephemeral; production snapshots are stored in Supabase.

Usually not appropriate on Vercel:

- Local browser / Cloudflare flow:
  - `HEADLESS`
  - `BROWSER_CDP_URL`
  - `PREFER_CDP_BROWSER`
  - `CF_MANUAL_TIMEOUT_SECONDS`
  - `SCREENSHOTS_ENABLED`
- Scan tuning:
  - `MIN_HOLDING_USD`
  - `DELAY_BETWEEN_WALLETS_MS`
  - `INCLUDE_DEFI`
  - `SCRAPE_JOB_LIMIT`
  - `MAX_SINGLE_HOLDING_USD`
  - `SIGNALS_REFRESH_CONCURRENCY`
  - `SIGNALS_REFRESH_BATCH_SIZE`
  - `CLAUDE_LONG_INITIAL_LOOKBACK_DAYS`
  - `CLAUDE_LONG_WALLET`
- Local import / path overrides:
  - `TRADER_SIGNALS_IMPORT_CSV`
  - `BROWSER_PROFILE_DIR`
  - `SCREENSHOTS_DIR`
  - `EXPORTS_DIR`
  - `RUNS_DIR`

Vercel provides the function runtime and public URL. `HOST` and `PORT` are only
needed for local `npm run dashboard` execution.

## Run

```bash
npm run scan
```

First run can prompt for Cloudflare manual solve in the visible browser. Browser state and screenshots can stay in their legacy root folders or move under `runs/wallet-scraper/...` with no command changes.

Dashboard:

```bash
npm run dashboard
```

Open [http://localhost:3000/dashboard](http://localhost:3000/dashboard)

New on-demand signals dashboard:
- Set `APP_USERNAME` and `APP_PASSWORD` in `.env` to enable the private login gate. `APP_USERNAME` defaults to `admin`.
- Keep the tracked trader CSV at `data/wallet-scraper/raw/trader-hypurrscan.csv`.
- Optional: point `TRADER_SIGNALS_IMPORT_CSV` at your editable local CSV and the app will copy it into the repo-owned data path before refresh.
- Open the app, log in, and use `Refresh Signals` to run a manual Hypurrscan scrape pass through Firecrawl.
- The UI stores each manual run as a snapshot and lets you switch between `Crypto` and `TradFi`.

Scheduled refresh:
- The preferred scheduler is GitHub Actions via `.github/workflows/cex-scheduled-refresh.yml`.
- It has a primary window at `19:17 UTC` (02:17 GMT+7 the next day) and a backup at `23:47 UTC` (06:47 GMT+7 the next day). The backup skips a full scan when all three snapshot types have succeeded for the Vietnam calendar day. GitHub may delay scheduled jobs; use `workflow_dispatch` when an additional intraday refresh is needed.
- The worker writes a new snapshot through the same Firecrawl pipeline as the dashboard.
- The dashboard keeps the newest successful snapshot published while a new snapshot is running or fails, and labels it with its capture time. It is a scheduled snapshot, not a live position feed.
- GitHub Actions is the only production scheduler; do not add a second scheduler.

Market regime dashboard:
- The first dashboard request of each UTC day reads current UP/HODL/DOWN breadth from the Shumi `market/health` API using `SHUMI_API_KEY` and stores the result in Supabase for reuse that day.
- The 30-day chart history and BTC USD daily/weekly trend come directly from CoinRotator's public pages. The latest chart point uses the Shumi breadth counts so the chart and regime answer agree.
- Only a Shumi quota response (`402` or `429`) activates the existing CoinRotator Firecrawl fallback. Missing/invalid Shumi credentials or malformed data are reported as unavailable.
- `FIRECRAWL_API_KEY` remains necessary for the fallback and for trader signal/spot scans. The regime endpoint is separate from the GitHub Actions trader scan.

### GitHub Actions scheduler

The scheduled refresh runs from GitHub Actions using
`.github/workflows/cex-scheduled-refresh.yml`. It schedules a primary run at
`19:17 UTC` (02:17 GMT+7 the next day) and a backup at `23:47 UTC` (06:47
GMT+7 the next day). The daily guard checks successful signal, spot, and
open-order snapshots before either scheduled run starts a full scan. Use
`workflow_dispatch` for an additional intraday refresh or to retry failed
signal traders in an existing snapshot.

Configure these GitHub Actions Secrets before enabling the workflow:

- `FIRECRAWL_API_KEY`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Optional GitHub Actions Variables include `FIRECRAWL_MIN_INTERVAL_MS`
(default `10000`, shared by signal and spot Firecrawl requests in one run),
`SIGNALS_REFRESH_CONCURRENCY`, `SPOT_HOLDING_CONCURRENCY`,
`SPOT_HOLDING_MIN_USD`, and `SPOT_HOLDING_CACHE_TTL_HOURS`. The workflow builds the checked-out commit and
sets `REQUIRE_SUPABASE_STORAGE=1`, so it fails instead of silently writing to
ephemeral SQLite. It fails unless the combined signal and spot refresh returns
`success`.

Manual sheet sync to Supabase:

```bash
npm run sync:sheet
```

Queued scrape jobs from Supabase:

```bash
npm run jobs:run
```

claude_long daily tracker:

```bash
npm run claude-long:run
npm run claude-long:test
```

From the running server you can also trigger:

```bash
POST /api/admin/sync-sheet
GET  /api/sync/status
POST /api/admin/run-scrape-jobs
GET  /api/jobs/status
```

## Attach Supabase

This repo already supports Supabase. The switch is runtime-based:

- If `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are both set, signal snapshots and tracked traders use Supabase.
- If those vars are missing, the app falls back to local SQLite under `data/`.

Supabase is the production source of truth for signal and spot snapshots. Vercel
does not need a persistent local volume.

Apply the SQL migrations to your Supabase project in this order:

```sql
supabase/migrations/20260319_000001_initial_wallet_intelligence_schema.sql
supabase/migrations/20260319_000002_service_role_grants.sql
supabase/migrations/20260420_000001_signal_dashboard_schema.sql
supabase/migrations/20260506_000001_entities_updated_at_trigger.sql
supabase/migrations/20261017_000001_spot_dashboard_schema.sql
supabase/migrations/20261101_000001_open_order_snapshot_schema.sql
```

Set these variables in both Vercel and GitHub Actions as appropriate:

```bash
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
```

Notes:
- Use the Supabase project URL, not the Studio URL.
- Use the `service_role` key, not the anon key, because the server writes snapshots, trader runs, and positions.
- `FIRECRAWL_API_KEY` is still required for live Hypurrscan refreshes.
- Spot holdings use Hypurrscan `#spot` pages. By default the Spot view keeps all non-stable/non-trash wallet-token holdings with value `> $333`; set `SPOT_HOLDING_INCLUDE_TOKENS` only if you want to narrow the displayed token set.

After the migration is applied, GitHub Actions writes signal, spot, and native
Hyperliquid open-order snapshots to Supabase. Vercel reads only the latest
successful snapshots. `HYPERLIQUID_OPEN_ORDERS_CONCURRENCY` is an optional
GitHub Actions variable (default `6`).

## Key Paths

- `src/index.ts`: scan entry and orchestration
- `src/scraper.ts`: Zapper navigation + extraction
- `src/storage.ts`: SQLite schema and DB operations
- `src/signal-refresh.ts`: manual Hypurrscan signal refresh pipeline
- `src/hypurrscan-signals.ts`: Firecrawl-backed Hypurrscan scrape + perps parser
- `src/spot-holdings.ts`: Firecrawl-backed Hypurrscan `#spot` scrape + non-stable holdings export
- `src/spot-storage.ts`: Supabase spot snapshot persistence and dashboard reads
- `src/open-order-scan.ts`: native Hyperliquid `openOrders` collector for the tracked registry
- `src/open-order-storage.ts`: durable open-order snapshot persistence and dashboard reads
- `src/spot-token-filter.ts`: Spot token threshold/exclusion config
- `src/trader-registry.ts`: CSV-backed tracked trader registry loader
- `src/server.ts`: Express APIs + dashboard hosting
- `src/sync.ts`: manual Google Sheets -> Supabase entity sync + scrape queue
- `src/job-worker.ts`: pulls queued scrape jobs and inserts holdings into Supabase
- `src/runtime-paths.ts`: shared path resolver for legacy root paths and structured `data/` / `runs/` paths
- `supabase/migrations/`: Supabase SQL schema
- `dashboard/`: local UI and export template assets
