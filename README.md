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
- Configure `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` to enable manual sheet-to-Supabase sync.
- By default browser automation prefers an existing Chrome CDP session at `http://127.0.0.1:9222` (`PREFER_CDP_BROWSER=true`).
- If Sheets is not configured, edit the local wallets file. The app will read the legacy root `wallets.json` when present, otherwise it will use `data/wallet-scraper/raw/wallets.json`.
- Optional runtime path env vars:
  - `BROWSER_PROFILE_DIR`
  - `SCREENSHOTS_DIR`
  - `DATA_DIR`
  - `EXPORTS_DIR`
  - `RUNS_DIR`

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
- Set `APP_PASSWORD` in `.env` to enable the private login gate.
- Keep the tracked trader CSV at `data/wallet-scraper/raw/trader-hypurrscan.csv`.
- Optional: point `TRADER_SIGNALS_IMPORT_CSV` at your editable local CSV and the app will copy it into the repo-owned data path before refresh.
- Open the app, log in, and use `Refresh Signals` to run a manual Hypurrscan scrape pass through Firecrawl.
- The UI stores each manual run as a snapshot and lets you switch between `Crypto` and `TradFi`.

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

## Key Paths

- `src/index.ts`: scan entry and orchestration
- `src/scraper.ts`: Zapper navigation + extraction
- `src/storage.ts`: SQLite schema and DB operations
- `src/signal-refresh.ts`: manual Hypurrscan signal refresh pipeline
- `src/hypurrscan-signals.ts`: Firecrawl-backed Hypurrscan scrape + perps parser
- `src/trader-registry.ts`: CSV-backed tracked trader registry loader
- `src/server.ts`: Express APIs + dashboard hosting
- `src/sync.ts`: manual Google Sheets -> Supabase entity sync + scrape queue
- `src/job-worker.ts`: pulls queued scrape jobs and inserts holdings into Supabase
- `src/runtime-paths.ts`: shared path resolver for legacy root paths and structured `data/` / `runs/` paths
- `supabase/migrations/`: Supabase SQL schema
- `dashboard/`: local UI and export template assets
