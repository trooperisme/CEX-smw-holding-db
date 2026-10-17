import dotenv from "dotenv";
import { runSignalRefresh, RunSignalRefreshResult } from "./signal-refresh";

dotenv.config();

export type ScheduledSpotRefreshResult = {
  source: "main-app";
  generatedAt: string | null;
  tradersScanned: number;
  tradersWithFilteredHoldings: number;
  failures: number;
};

export type ScheduledRefreshResult = {
  startedAt: string;
  finishedAt: string;
  status: "success" | "partial" | "failed";
  signal: RunSignalRefreshResult | null;
  spot: ScheduledSpotRefreshResult | null;
  errors: string[];
};

type ScheduledRefreshOptions = {
  cwd?: string;
  logger?: (line: string) => void;
  signalRunner?: () => Promise<RunSignalRefreshResult>;
  spotRunner?: () => Promise<ScheduledSpotRefreshResult>;
};

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function errorMessage(error: unknown): string {
  return (error as Error)?.message || String(error);
}

function resolveMainAppUrl(): string {
  const configured = String(process.env.MAIN_APP_URL || "").trim();
  if (configured) return configured.replace(/\/$/, "");

  const serviceUrl = String(process.env.RAILWAY_SERVICE_CEX_SMW_HOLDING_DB_URL || "").trim();
  if (!serviceUrl) {
    throw new Error("MAIN_APP_URL or RAILWAY_SERVICE_CEX_SMW_HOLDING_DB_URL is required for scheduled spot refresh");
  }
  return `https://${serviceUrl.replace(/^https?:\/\//, "").replace(/\/$/, "")}`;
}

async function refreshSpotHoldingsOnMainApp(logger: (line: string) => void): Promise<ScheduledSpotRefreshResult> {
  const username = String(process.env.APP_USERNAME || "");
  const password = String(process.env.APP_PASSWORD || "");
  if (!username || !password) {
    throw new Error("APP_USERNAME and APP_PASSWORD are required for scheduled spot refresh");
  }

  const baseUrl = resolveMainAppUrl();
  const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const loginBody = await loginResponse.text();
  const setCookie = loginResponse.headers.get("set-cookie") || "";
  if (!loginResponse.ok || !setCookie) {
    throw new Error(`Main app authentication failed (${loginResponse.status}): ${loginBody.slice(0, 300)}`);
  }

  const cookie = setCookie.split(";")[0];
  const refreshResponse = await fetch(`${baseUrl}/api/spot-holdings/refresh`, {
    method: "POST",
    headers: { Cookie: cookie },
  });
  const refreshBody = await refreshResponse.text();
  if (!refreshResponse.ok) {
    throw new Error(`Main app spot refresh failed (${refreshResponse.status}): ${refreshBody.slice(0, 300)}`);
  }

  const timeoutMs = parsePositiveInt(process.env.SCHEDULED_SPOT_TIMEOUT_MS, 30 * 60 * 1000);
  const pollMs = parsePositiveInt(process.env.SCHEDULED_SPOT_POLL_MS, 10000);
  const startedAt = Date.now();
  logger(`Scheduled spot refresh started on main app: ${baseUrl}`);

  while (Date.now() - startedAt <= timeoutMs) {
    const statusResponse = await fetch(`${baseUrl}/api/spot-holdings/refresh/status`, { headers: { Cookie: cookie } });
    const statusBody = await statusResponse.text();
    if (!statusResponse.ok) {
      throw new Error(`Main app spot status failed (${statusResponse.status}): ${statusBody.slice(0, 300)}`);
    }

    const status = JSON.parse(statusBody) as {
      running?: boolean;
      lastError?: string | null;
      lastResult?: {
        generatedAt?: string | null;
        tradersScanned?: number;
        tradersWithFilteredHoldings?: number;
        failures?: number;
      } | null;
    };

    if (!status.running) {
      if (status.lastError) throw new Error(`Main app spot refresh failed: ${status.lastError}`);
      if (!status.lastResult) throw new Error("Main app spot refresh completed without a result");

      return {
        source: "main-app",
        generatedAt: status.lastResult.generatedAt || null,
        tradersScanned: Number(status.lastResult.tradersScanned || 0),
        tradersWithFilteredHoldings: Number(status.lastResult.tradersWithFilteredHoldings || 0),
        failures: Number(status.lastResult.failures || 0),
      };
    }

    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  throw new Error(`Main app spot refresh timed out after ${timeoutMs}ms`);
}

export async function runScheduledRefresh(options: ScheduledRefreshOptions = {}): Promise<ScheduledRefreshResult> {
  const startedAt = new Date().toISOString();
  const cwd = options.cwd || process.cwd();
  const logger = options.logger || ((line: string) => console.log(`[scheduled-signals] ${line}`));
  logger(`Scheduled signals + spot refresh started at ${startedAt}`);

  const [signalOutcome, spotOutcome] = await Promise.allSettled([
    (options.signalRunner || (() => runSignalRefresh({ cwd, logger })))(),
    (options.spotRunner || (() => refreshSpotHoldingsOnMainApp(logger)))(),
  ]);

  const signal = signalOutcome.status === "fulfilled" ? signalOutcome.value : null;
  const spot = spotOutcome.status === "fulfilled" ? spotOutcome.value : null;
  const errors = [
    ...(signalOutcome.status === "rejected" ? [`signal: ${errorMessage(signalOutcome.reason)}`] : []),
    ...(spotOutcome.status === "rejected" ? [`spot: ${errorMessage(spotOutcome.reason)}`] : []),
  ];
  const hasSignalFailure = !signal || signal.status === "failed";
  const hasSignalPartial = signal?.status !== "success";
  const hasSpotFailure = !spot || spot.failures > 0;
  const status: ScheduledRefreshResult["status"] = hasSignalFailure || !spot
    ? "failed"
    : hasSignalPartial || hasSpotFailure
      ? "partial"
      : "success";

  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    status,
    signal,
    spot,
    errors,
  };
}

async function main(): Promise<void> {
  const result = await runScheduledRefresh();
  console.log(JSON.stringify(result, null, 2));

  if (result.status !== "success") {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  void main().catch((error) => {
    console.error("Scheduled signals + spot refresh failed:", (error as Error)?.message || String(error));
    process.exitCode = 1;
  });
}
