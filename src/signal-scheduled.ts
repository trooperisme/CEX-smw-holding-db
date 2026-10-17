import dotenv from "dotenv";
import { runSignalRefresh, RunSignalRefreshResult } from "./signal-refresh";
import { runSpotHoldingsScan } from "./spot-holdings";
import { persistSpotHoldingsSnapshot } from "./spot-storage";

dotenv.config();

export type ScheduledSpotRefreshResult = {
  source: "github-action";
  snapshotId: number;
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

function errorMessage(error: unknown): string {
  return (error as Error)?.message || String(error);
}

async function refreshSpotHoldingsInAction(logger: (line: string) => void): Promise<ScheduledSpotRefreshResult> {
  logger("Scheduled spot refresh running directly in GitHub Actions");
  const result = await runSpotHoldingsScan({ logger });
  const snapshotId = await persistSpotHoldingsSnapshot(result);
  return {
    source: "github-action",
    snapshotId,
    generatedAt: result.generatedAt,
    tradersScanned: result.tradersScanned,
    tradersWithFilteredHoldings: result.tradersWithFilteredHoldings,
    failures: result.failures,
  };
}

export async function runScheduledRefresh(options: ScheduledRefreshOptions = {}): Promise<ScheduledRefreshResult> {
  const startedAt = new Date().toISOString();
  const cwd = options.cwd || process.cwd();
  const logger = options.logger || ((line: string) => console.log(`[scheduled-signals] ${line}`));
  logger(`Scheduled signals + spot refresh started at ${startedAt}`);

  const [signalOutcome, spotOutcome] = await Promise.allSettled([
    (options.signalRunner || (() => runSignalRefresh({ cwd, logger })))(),
    (options.spotRunner || (() => refreshSpotHoldingsInAction(logger)))(),
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
