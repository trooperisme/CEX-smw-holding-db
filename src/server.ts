import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import dotenv from "dotenv";
import express from "express";
import { buildClusters, diffClusters } from "./aggregator";
import { runFullScan } from "./index";
import { runQueuedScrapeJobs } from "./job-worker";
import { resolveWorkspaceFilePath, resolveWorkspacePaths } from "./runtime-paths";
import { runSignalRefresh } from "./signal-refresh";
import { createSignalStorage } from "./signal-storage";
import { createStorage } from "./storage";
import { runSheetSyncToSupabase } from "./sync";
import { loadTrackedTraders } from "./trader-registry";
import { SignalMarketType } from "./types";

dotenv.config();

type ScanRuntime = {
  running: boolean;
  logs: string[];
  lastError: string | null;
  lastSnapshotId: number | null;
  syncRunning: boolean;
  syncLastError: string | null;
  syncLastResult: unknown | null;
  jobsRunning: boolean;
  jobsLastError: string | null;
  jobsLastResult: unknown | null;
  signalsRunning: boolean;
  signalsLogs: string[];
  signalsLastError: string | null;
  signalsLastResult: unknown | null;
  signalsCurrentSnapshotId: number | null;
};

const app = express();
const cwd = process.cwd();
const paths = resolveWorkspacePaths(cwd);
const runtime: ScanRuntime = {
  running: false,
  logs: [],
  lastError: null,
  lastSnapshotId: null,
  syncRunning: false,
  syncLastError: null,
  syncLastResult: null,
  jobsRunning: false,
  jobsLastError: null,
  jobsLastResult: null,
  signalsRunning: false,
  signalsLogs: [],
  signalsLastError: null,
  signalsLastResult: null,
  signalsCurrentSnapshotId: null,
};

const AUTH_COOKIE_NAME = "signals_auth";
const AUTH_COOKIE_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 14;
const AUTH_PASSWORD = process.env.APP_PASSWORD || process.env.SIGNALS_APP_PASSWORD || "";
const AUTH_SECRET =
  process.env.APP_COOKIE_SECRET ||
  process.env.SIGNALS_APP_COOKIE_SECRET ||
  process.env.APP_PASSWORD ||
  "local-signals-secret";
const RUN_SYNCHRONOUSLY = Boolean(process.env.VERCEL);

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) return {};
  return cookieHeader.split(";").reduce<Record<string, string>>((acc, chunk) => {
    const [key, ...rest] = chunk.split("=");
    const normalizedKey = String(key || "").trim();
    if (!normalizedKey) return acc;
    acc[normalizedKey] = decodeURIComponent(rest.join("=").trim());
    return acc;
  }, {});
}

function signAuthPayload(payload: string): string {
  return crypto.createHmac("sha256", AUTH_SECRET).update(payload).digest("hex");
}

function createAuthCookieValue(): string {
  const expiresAt = Date.now() + AUTH_COOKIE_MAX_AGE_MS;
  const payload = JSON.stringify({ expiresAt });
  const encoded = Buffer.from(payload, "utf-8").toString("base64url");
  const signature = signAuthPayload(encoded);
  return `${encoded}.${signature}`;
}

function isAuthenticated(req: express.Request): boolean {
  if (!AUTH_PASSWORD) return true;
  const rawCookie = parseCookies(req.headers.cookie)[AUTH_COOKIE_NAME];
  if (!rawCookie) return false;
  const [encoded, signature] = rawCookie.split(".");
  if (!encoded || !signature) return false;
  if (signAuthPayload(encoded) !== signature) return false;
  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf-8")) as {
      expiresAt?: number;
    };
    return Number(parsed.expiresAt || 0) > Date.now();
  } catch {
    return false;
  }
}

function buildAuthCookie(req: express.Request, value: string): string {
  const secure = req.secure || req.headers["x-forwarded-proto"] === "https";
  const parts = [
    `${AUTH_COOKIE_NAME}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(AUTH_COOKIE_MAX_AGE_MS / 1000)}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

function buildExpiredAuthCookie(req: express.Request): string {
  const secure = req.secure || req.headers["x-forwarded-proto"] === "https";
  const parts = [
    `${AUTH_COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

function requireSignalsAuth(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (isAuthenticated(req)) {
    next();
    return;
  }

  const wantsHtml = String(req.headers.accept || "").includes("text/html");
  if (wantsHtml) {
    res.redirect("/login");
    return;
  }

  res.status(401).json({ error: "Authentication required" });
}

function parseMarketType(input: unknown): SignalMarketType {
  return String(input || "").toLowerCase() === "tradfi" ? "tradfi" : "crypto";
}

app.use(express.json());
app.use(
  "/dashboard",
  (req, res, next) => {
    if (
      (req.path === "/" || req.path === "/index.html" || req.path === "/admin.html") &&
      !isAuthenticated(req)
    ) {
      res.redirect("/login");
      return;
    }
    next();
  },
  express.static(paths.dashboardDir, { index: false }),
);
app.use("/screenshots", express.static(paths.screenshotsDir));
app.use("/api/signals", requireSignalsAuth);

app.get("/", (req, res) => {
  res.redirect(isAuthenticated(req) ? "/dashboard" : "/login");
});

app.get("/login", (_req, res) => {
  res.sendFile(path.join(paths.dashboardDir, "login.html"));
});

app.post("/api/auth/login", (req, res) => {
  const password = String(req.body?.password || "");
  if (AUTH_PASSWORD && password !== AUTH_PASSWORD) {
    res.status(401).json({ ok: false, error: "Invalid password" });
    return;
  }

  res.setHeader("Set-Cookie", buildAuthCookie(req, createAuthCookieValue()));
  res.json({ ok: true });
});

app.post("/api/auth/logout", (req, res) => {
  res.setHeader("Set-Cookie", buildExpiredAuthCookie(req));
  res.json({ ok: true });
});

app.get("/api/auth/session", (req, res) => {
  res.json({ authenticated: isAuthenticated(req) });
});

app.get("/dashboard", requireSignalsAuth, (_req, res) => {
  res.sendFile(path.join(paths.dashboardDir, "index.html"));
});

app.get("/dashboard/", requireSignalsAuth, (_req, res) => {
  res.sendFile(path.join(paths.dashboardDir, "index.html"));
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    running: runtime.running,
    syncRunning: runtime.syncRunning,
    jobsRunning: runtime.jobsRunning,
    signalsRunning: runtime.signalsRunning,
  });
});

app.get("/api/artifacts/file", (req, res) => {
  const requestedPath = typeof req.query.path === "string" ? req.query.path : "";
  const resolvedPath = resolveWorkspaceFilePath(cwd, requestedPath);
  if (!resolvedPath || !fs.existsSync(resolvedPath)) {
    res.status(404).json({ error: "Artifact not found" });
    return;
  }

  res.sendFile(resolvedPath);
});

app.get("/api/scans", (_req, res) => {
  const storage = createStorage(cwd);
  try {
    res.json({ scans: storage.getSnapshotSummaries() });
  } finally {
    storage.close();
  }
});

app.get("/api/scan/status", (_req, res) => {
  res.json({
    running: runtime.running,
    lastError: runtime.lastError,
    lastSnapshotId: runtime.lastSnapshotId,
    logs: runtime.logs.slice(-500),
  });
});

app.get("/api/sync/status", (_req, res) => {
  res.json({
    running: runtime.syncRunning,
    lastError: runtime.syncLastError,
    lastResult: runtime.syncLastResult,
  });
});

app.get("/api/jobs/status", (_req, res) => {
  res.json({
    running: runtime.jobsRunning,
    lastError: runtime.jobsLastError,
    lastResult: runtime.jobsLastResult,
  });
});

app.post("/api/signals/refresh", async (_req, res) => {
  if (!RUN_SYNCHRONOUSLY && runtime.signalsRunning) {
    res.status(409).json({
      error: "Signals refresh already running",
      snapshotId: runtime.signalsCurrentSnapshotId,
    });
    return;
  }

  const storage = createSignalStorage(cwd);
  let traders = [] as ReturnType<typeof loadTrackedTraders>;
  let snapshotId = 0;

  try {
    traders = loadTrackedTraders(cwd).filter((trader) => trader.isActive);
    await storage.replaceTrackedTraders(traders);
    snapshotId = await storage.createSignalSnapshot(traders.length);
  } catch (error) {
    storage.close();
    res.status(500).json({ ok: false, error: (error as Error)?.message || String(error) });
    return;
  }
  storage.close();

  runtime.signalsRunning = true;
  runtime.signalsLogs = [];
  runtime.signalsLastError = null;
  runtime.signalsLastResult = null;
  runtime.signalsCurrentSnapshotId = snapshotId;

  const logger = (line: string) => {
    const formatted = `${new Date().toISOString()} ${line}`;
    runtime.signalsLogs.push(formatted);
    if (runtime.signalsLogs.length > 2000) runtime.signalsLogs.shift();
    console.log(formatted);
  };

  const refreshPromise = runSignalRefresh({ cwd, logger, snapshotId, traders })
    .then((result) => {
      runtime.signalsLastResult = result;
    })
    .catch((error) => {
      runtime.signalsLastError = (error as Error)?.message || String(error);
      logger(`Signals fatal error: ${runtime.signalsLastError}`);
    })
    .finally(() => {
      runtime.signalsRunning = false;
    });

  if (RUN_SYNCHRONOUSLY) {
    await refreshPromise;
    if (runtime.signalsLastError) {
      res.status(500).json({ ok: false, error: runtime.signalsLastError, snapshotId });
      return;
    }
    res.json({
      ok: true,
      started: true,
      completed: true,
      snapshotId,
      tradersTotal: traders.length,
      result: runtime.signalsLastResult,
    });
    return;
  }

  res.json({ ok: true, started: true, snapshotId, tradersTotal: traders.length });
});

app.get("/api/signals/refresh/:snapshotId/status", async (req, res) => {
  const snapshotId = Number(req.params.snapshotId);
  if (!Number.isFinite(snapshotId)) {
    res.status(400).json({ error: "Invalid snapshotId" });
    return;
  }

  const storage = createSignalStorage(cwd);
  try {
    const snapshot = await storage.getSignalSnapshot(snapshotId);
    if (!snapshot) {
      res.status(404).json({ error: "Signal snapshot not found" });
      return;
    }

    res.json({
      snapshot,
      runs: await storage.getSignalTraderRuns(snapshotId),
      runtime: {
        running: runtime.signalsRunning && runtime.signalsCurrentSnapshotId === snapshotId,
        snapshotRunning: snapshot.status === "running",
        canContinue:
          RUN_SYNCHRONOUSLY &&
          snapshot.status === "running" &&
          !(runtime.signalsRunning && runtime.signalsCurrentSnapshotId === snapshotId),
        logs:
          runtime.signalsCurrentSnapshotId === snapshotId
            ? runtime.signalsLogs.slice(-500)
            : [],
        lastError:
          runtime.signalsCurrentSnapshotId === snapshotId ? runtime.signalsLastError : null,
      },
    });
  } finally {
    storage.close();
  }
});

app.post("/api/signals/refresh/:snapshotId/continue", async (req, res) => {
  const snapshotId = Number(req.params.snapshotId);
  if (!Number.isFinite(snapshotId)) {
    res.status(400).json({ error: "Invalid snapshotId" });
    return;
  }

  if (!RUN_SYNCHRONOUSLY && runtime.signalsRunning) {
    res.status(409).json({
      error: "Signals refresh already running",
      snapshotId: runtime.signalsCurrentSnapshotId,
    });
    return;
  }

  runtime.signalsRunning = true;
  runtime.signalsLastError = null;
  runtime.signalsLastResult = null;
  runtime.signalsCurrentSnapshotId = snapshotId;

  const logger = (line: string) => {
    const formatted = `${new Date().toISOString()} ${line}`;
    runtime.signalsLogs.push(formatted);
    if (runtime.signalsLogs.length > 2000) runtime.signalsLogs.shift();
    console.log(formatted);
  };

  try {
    const result = await runSignalRefresh({ cwd, logger, snapshotId });
    runtime.signalsLastResult = result;
    res.json({ ok: true, continued: true, snapshotId, result });
  } catch (error) {
    const message = (error as Error)?.message || String(error);
    runtime.signalsLastError = message;
    logger(`Signals continuation error: ${message}`);
    res.status(500).json({ ok: false, error: message, snapshotId });
  } finally {
    runtime.signalsRunning = false;
  }
});

app.get("/api/signals/snapshots", async (_req, res) => {
  const storage = createSignalStorage(cwd);
  try {
    res.json({ snapshots: await storage.getSignalSnapshots() });
  } finally {
    storage.close();
  }
});

app.get("/api/signals/latest", async (req, res) => {
  const market = parseMarketType(req.query.market);
  const storage = createSignalStorage(cwd);
  try {
    const snapshotId = await storage.getLatestSignalSnapshotId();
    if (!snapshotId) {
      res.json({ snapshot: null, market, rows: [] });
      return;
    }

    res.json({
      snapshot: await storage.getSignalSnapshot(snapshotId),
      market,
      rows: await storage.getTokenSignalMetrics(snapshotId, market),
    });
  } finally {
    storage.close();
  }
});

app.get("/api/signals/:snapshotId", async (req, res) => {
  const snapshotId = Number(req.params.snapshotId);
  const market = parseMarketType(req.query.market);
  if (!Number.isFinite(snapshotId)) {
    res.status(400).json({ error: "Invalid snapshotId" });
    return;
  }

  const storage = createSignalStorage(cwd);
  try {
    const snapshot = await storage.getSignalSnapshot(snapshotId);
    if (!snapshot) {
      res.status(404).json({ error: "Signal snapshot not found" });
      return;
    }

    res.json({
      snapshot,
      market,
      rows: await storage.getTokenSignalMetrics(snapshotId, market),
    });
  } finally {
    storage.close();
  }
});

app.get("/api/signals/:snapshotId/token/:token", async (req, res) => {
  const snapshotId = Number(req.params.snapshotId);
  const token = decodeURIComponent(req.params.token);
  if (!Number.isFinite(snapshotId)) {
    res.status(400).json({ error: "Invalid snapshotId" });
    return;
  }

  const storage = createSignalStorage(cwd);
  try {
    const snapshot = await storage.getSignalSnapshot(snapshotId);
    if (!snapshot) {
      res.status(404).json({ error: "Signal snapshot not found" });
      return;
    }

    const cryptoMetrics = await storage.getTokenSignalMetrics(snapshotId, "crypto");
    const tradfiMetrics = await storage.getTokenSignalMetrics(snapshotId, "tradfi");
    const metric = cryptoMetrics
      .concat(tradfiMetrics)
      .find((row) => row.token === token);

    res.json({
      snapshot,
      metric: metric || null,
      ...(await storage.getTokenDrilldown(snapshotId, token)),
    });
  } finally {
    storage.close();
  }
});

app.post("/api/admin/sync-sheet", async (_req, res) => {
  if (runtime.syncRunning) {
    res.status(409).json({ error: "Sync already running" });
    return;
  }

  runtime.syncRunning = true;
  runtime.syncLastError = null;
  runtime.syncLastResult = null;

  try {
    const result = await runSheetSyncToSupabase({ cwd });
    runtime.syncLastResult = result;
    res.json({ ok: true, result });
  } catch (error) {
    const message = (error as Error)?.message || String(error);
    runtime.syncLastError = message;
    res.status(500).json({ ok: false, error: message });
  } finally {
    runtime.syncRunning = false;
  }
});

app.post("/api/admin/run-scrape-jobs", async (req, res) => {
  if (runtime.jobsRunning) {
    res.status(409).json({ error: "Scrape jobs already running" });
    return;
  }

  runtime.jobsRunning = true;
  runtime.jobsLastError = null;
  runtime.jobsLastResult = null;

  try {
    const limitRaw = Number(req.body?.limit);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : undefined;
    const result = await runQueuedScrapeJobs({ cwd, limit });
    runtime.jobsLastResult = result;
    res.json({ ok: true, result });
  } catch (error) {
    const message = (error as Error)?.message || String(error);
    runtime.jobsLastError = message;
    res.status(500).json({ ok: false, error: message });
  } finally {
    runtime.jobsRunning = false;
  }
});

app.post("/api/scan", async (_req, res) => {
  if (runtime.running) {
    res.status(409).json({ error: "Scan already running" });
    return;
  }

  runtime.running = true;
  runtime.logs = [];
  runtime.lastError = null;
  runtime.lastSnapshotId = null;

  const logger = (line: string) => {
    const formatted = `${new Date().toISOString()} ${line}`;
    runtime.logs.push(formatted);
    if (runtime.logs.length > 2000) runtime.logs.shift();
    console.log(formatted);
  };

  const scanPromise = runFullScan({ cwd, logger })
    .then((result) => {
      runtime.lastSnapshotId = result.snapshotId;
    })
    .catch((error) => {
      runtime.lastError = (error as Error)?.message || String(error);
      logger(`Fatal scan error: ${runtime.lastError}`);
    })
    .finally(() => {
      runtime.running = false;
    });

  if (RUN_SYNCHRONOUSLY) {
    await scanPromise;
    if (runtime.lastError) {
      res.status(500).json({ ok: false, error: runtime.lastError });
      return;
    }
    res.json({ started: true, completed: true, snapshotId: runtime.lastSnapshotId });
    return;
  }

  res.json({ started: true });
});

app.get("/api/wallets", (req, res) => {
  const snapshotId = Number(req.query.snapshotId);
  const storage = createStorage(cwd);
  try {
    const selectedSnapshotId = Number.isFinite(snapshotId) ? snapshotId : storage.getLatestSnapshotId();
    if (!selectedSnapshotId) {
      res.json({ snapshotId: null, wallets: [] });
      return;
    }
    res.json({
      snapshotId: selectedSnapshotId,
      wallets: storage.getWalletNames(selectedSnapshotId),
      scanRecords: storage.getWalletScanRecords(selectedSnapshotId),
    });
  } finally {
    storage.close();
  }
});

app.get("/api/wallet/:label", (req, res) => {
  const storage = createStorage(cwd);
  const snapshotIdInput = Number(req.query.snapshotId);
  const walletLabel = decodeURIComponent(req.params.label);

  try {
    const snapshotId = Number.isFinite(snapshotIdInput)
      ? snapshotIdInput
      : storage.getLatestSnapshotId();
    if (!snapshotId) {
      res.status(404).json({ error: "No snapshots found" });
      return;
    }

    const holdings = storage.getWalletHoldings(snapshotId, walletLabel);
    const scanRecord = storage
      .getWalletScanRecords(snapshotId)
      .find((row) => row.wallet_label === walletLabel);
    res.json({ snapshotId, walletLabel, holdings, scanRecord });
  } finally {
    storage.close();
  }
});

app.get("/api/clusters", (req, res) => {
  const storage = createStorage(cwd);
  const snapshotIdInput = Number(req.query.snapshotId);
  try {
    const snapshotId = Number.isFinite(snapshotIdInput)
      ? snapshotIdInput
      : storage.getLatestSnapshotId();
    if (!snapshotId) {
      res.json({ snapshotId: null, clusters: [] });
      return;
    }
    const rows = storage.getHoldingsBySnapshot(snapshotId);
    const clusters = buildClusters(rows);
    res.json({ snapshotId, clusters });
  } finally {
    storage.close();
  }
});

app.get("/api/diff", (req, res) => {
  const a = Number(req.query.snapshotA);
  const b = Number(req.query.snapshotB);
  const storage = createStorage(cwd);

  try {
    if (!Number.isFinite(a) || !Number.isFinite(b)) {
      res.status(400).json({ error: "snapshotA and snapshotB are required numbers" });
      return;
    }
    const clusterA = buildClusters(storage.getHoldingsBySnapshot(a));
    const clusterB = buildClusters(storage.getHoldingsBySnapshot(b));
    const changes = diffClusters(clusterA, clusterB, 10);
    res.json({ snapshotA: a, snapshotB: b, changes });
  } finally {
    storage.close();
  }
});

export function startServer(): void {
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || "0.0.0.0";
  app.listen(port, host, () => {
    console.log(`Dashboard running at http://${host}:${port}`);
  });
}

if (require.main === module) {
  startServer();
}

export { app };
export default app;
