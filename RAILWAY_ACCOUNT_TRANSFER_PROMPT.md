# Railway Account Transfer Prompt

Use this prompt when moving this project from one Railway account to another with minimum back-and-forth.

```text
You are helping me migrate the Railway deployment for this repo:

Repo:
- Local path: /Users/nguyentrancongnguyen/Documents/CodexProjects/CEX-smw-holding-db
- GitHub remote: https://github.com/trooperisme/CEX-smw-holding-db.git
- App name/package: smw-dashboard
- Build command: npm run build
- Start command: npm start
- Procfile: web: npm start
- Current known production URL from prior runs: https://cex-smw-holding-db-production-25fd.up.railway.app

Verified current Railway source account/project, checked 2026-06-29:
- Railway account currently holding the project: wayrail222@koletter.com
- Workspace: My Projects
- Project: CEX-smw-holding-db
- Project ID: 2fa5d00c-dcf1-4f14-bed1-de30e2373378
- Environment: production
- Environment ID: 48658e19-83f7-48f0-8517-e065c237f978
- Service: CEX-smw-holding-db
- Service ID: 31f3dda3-ed1b-419f-86db-50e3a2cd0e5a
- Region: sfo
- Current deployment ID at time of check: f8f83ab7-b56f-488a-b1b2-715d0cbc82c0
- Current production URL: https://cex-smw-holding-db-production-25fd.up.railway.app

Important repo facts:
- Main server: src/server.ts
- Dashboard files: dashboard/
- Tracked trader CSV: data/wallet-scraper/raw/trader-hypurrscan.csv
- Supabase migrations: supabase/migrations/
- Runtime storage behavior:
  - If SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set, signal snapshots and tracked traders use Supabase.
  - If those vars are missing, the app falls back to local SQLite under data/.
  - Supabase is the preferred persistence layer when moving Railway accounts.
- Required/recommended Railway env vars:
  - FIRECRAWL_API_KEY
  - APP_USERNAME
  - APP_PASSWORD
  - APP_COOKIE_SECRET
  - SUPABASE_URL
  - SUPABASE_SERVICE_ROLE_KEY
  - Optional persistent local data only if needed: DATA_DIR=/data/wallet-scraper, HOSTED_DATA_ROOT=/data, plus a Railway volume mounted at /data
- Railway provides PORT automatically. HOST=0.0.0.0 is safe but usually unnecessary.

Verified existing Railway env var names on 2026-06-29, values intentionally not shown:
- APP_COOKIE_SECRET
- APP_PASSWORD
- APP_USERNAME
- FIRECRAWL_API_KEY
- HOST
- SUPABASE_SERVICE_ROLE_KEY
- SUPABASE_URL
- Railway injected vars also exist: RAILWAY_ENVIRONMENT, RAILWAY_ENVIRONMENT_ID, RAILWAY_ENVIRONMENT_NAME, RAILWAY_PRIVATE_DOMAIN, RAILWAY_PROJECT_ID, RAILWAY_PROJECT_NAME, RAILWAY_PUBLIC_DOMAIN, RAILWAY_SERVICE_CEX_SMW_HOLDING_DB_URL, RAILWAY_SERVICE_ID, RAILWAY_SERVICE_NAME, RAILWAY_STATIC_URL

Goal:
Move the Railway deployment from the currently logged-in/old Railway account to a new Railway account, preserving functionality and using as few tokens as possible.

Rules:
- Do not read the whole repo. Only inspect files if needed: README.md, package.json, Procfile, src/server.ts, src/signal-storage.ts.
- Do not print secret values in chat.
- Do not overwrite unrelated local changes. Check git status first.
- Prefer GitHub-backed or clean-source deployment from the intended HEAD.
- If local repo is dirty, do not upload dirty source unless I explicitly approve.
- If Railway CLI auth fails, preserve the exact error string.

Start with these checks:
1. cd /Users/nguyentrancongnguyen/Documents/CodexProjects/CEX-smw-holding-db
2. git status --short
3. git rev-parse --short HEAD
4. git remote -v
5. npx -y @railway/cli@latest --version
6. npx -y @railway/cli@latest whoami || npx -y @railway/cli@latest login

Migration plan:
1. Old account export/record
   - Confirm the current Railway project/service with:
     npx -y @railway/cli@latest status
   - Expected old account/project details:
     - account: wayrail222@koletter.com
     - project: CEX-smw-holding-db
     - project ID: 2fa5d00c-dcf1-4f14-bed1-de30e2373378
     - environment: production
     - service: CEX-smw-holding-db
     - service ID: 31f3dda3-ed1b-419f-86db-50e3a2cd0e5a
     - URL: https://cex-smw-holding-db-production-25fd.up.railway.app
   - Record latest deployment commit/source if visible.
   - Export/copy env vars from Railway without exposing secrets in chat.
   - Required vars to confirm present: FIRECRAWL_API_KEY, APP_PASSWORD, APP_COOKIE_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
   - If DATA_DIR/HOSTED_DATA_ROOT or a /data volume is used, ask me before deleting old Railway because volume data may need manual migration.

2. Switch to new Railway account
   - Log out/login as needed:
     npx -y @railway/cli@latest logout
     npx -y @railway/cli@latest login
   - Verify:
     npx -y @railway/cli@latest whoami

3. Create/link new Railway project
   - Create a new Railway project/service from this repo or link an existing empty project.
   - Link local repo to the new Railway project/service.
   - Set env vars in the new project/service. Use Railway UI if CLI secret setting is annoying.
   - Required env vars:
     FIRECRAWL_API_KEY=...
     APP_USERNAME=admin or my chosen username
     APP_PASSWORD=...
     APP_COOKIE_SECRET=...
     SUPABASE_URL=...
     SUPABASE_SERVICE_ROLE_KEY=...
   - Optional persistence vars only if we intentionally use a Railway volume:
     DATA_DIR=/data/wallet-scraper
     HOSTED_DATA_ROOT=/data

4. Deploy
   - First choice: deploy from GitHub/main or Railway GitHub integration using the current intended commit.
   - CLI fallback:
     npx -y @railway/cli@latest redeploy --from-source
   - If Railway appears to deploy stale source, use a clean HEAD archive/source upload only after confirming git status and intended commit.

5. Verify new production
   - Capture the new production URL.
   - Run these HTTP checks against the new URL:
     curl -I <NEW_URL>/
     curl -i <NEW_URL>/api/health
     curl -i <NEW_URL>/dashboard
   - Expected behavior:
     - / redirects or serves login/dashboard flow
     - protected /dashboard or protected APIs require auth when not logged in
     - /api/health returns ok/healthy if public, or auth-required if protected by current server behavior
   - If credentials are available locally, verify login in browser or with curl session cookies.
   - Confirm Supabase-backed mode by checking that SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set in Railway; do not assume local SQLite is production.

6. Cutover summary
   - Return only:
     Current Railway account/project/service
     New production URL
     Commit deployed
     Env vars present/missing by name only, no secret values
     Verification results
     Any blocker with exact error text
     Whether old Railway project can be safely paused/deleted

Known failure modes:
- Railway CLI may be missing from PATH; use npx -y @railway/cli@latest.
- After redeploy, Railway polling can fail with: Unauthorized. Please run railway login again.
- If production misses a new CSV trader, check Supabase-backed tracked_traders/signal_snapshots, not local SQLite.
- If SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing, production falls back to local SQLite under data/ and data may not survive account migration.
- If deploy source is stale, confirm commit and force deployment from clean HEAD.

Keep your response concise. Execute first, ask only if a secret/account action or destructive deletion is required.
```
