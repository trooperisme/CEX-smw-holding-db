import dotenv from "dotenv";
import { runSignalRefresh, RunSignalRefreshResult } from "./signal-refresh";
import { runSpotHoldingsScan } from "./spot-holdings";
import { persistSpotHoldingsSnapshot } from "./spot-storage";
import { SpotHoldingsScanSummary } from "./spot-holdings";
import { createSignalStorage } from "./signal-storage";
import { runOpenOrderScan } from "./open-order-scan";
import { persistOpenOrderSnapshot } from "./open-order-storage";
import { TrackedTrader } from "./types";
import { createScanProgressReporter, findScanCompletedSince, ScanStage, StageState } from "./full-scan-progress";

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
  openOrders: ScheduledOpenOrderRefreshResult | null;
  errors: string[];
};

type ScheduledRefreshOptions = {
  cwd?: string;
  logger?: (line: string) => void;
  traderLoader?: () => Promise<TrackedTrader[]>;
  signalRunner?: (traders: TrackedTrader[]) => Promise<RunSignalRefreshResult>;
  signalRetryRunner?: (traders: TrackedTrader[], snapshotId: number) => Promise<RunSignalRefreshResult>;
  spotRunner?: (traders: TrackedTrader[]) => Promise<ScheduledSpotRefreshResult>;
  openOrderRunner?: (traders: TrackedTrader[]) => Promise<ScheduledOpenOrderRefreshResult>;
  onStage?: (stage: ScanStage, state: StageState) => Promise<void>;
};

export type ScheduledOpenOrderRefreshResult = {
  source: "github-action";
  snapshotId: number;
  capturedAt: string;
  tradersScanned: number;
  failures: number;
  totalOrders: number;
};

function errorMessage(error: unknown): string {
  return (error as Error)?.message || String(error);
}

export function validateScheduledTraders(traders: TrackedTrader[]): void {
  if (!traders.length) throw new Error("Tracked trader registry is empty; refusing scheduled scan");
  const addresses = new Set<string>();
  for (const trader of traders) {
    const address = String(trader.walletAddress || "").trim().toLowerCase();
    if (!trader.isActive || !trader.traderName || !/^0x[a-f0-9]{40}$/.test(address) || addresses.has(address)) {
      throw new Error("Tracked trader registry contains inactive, invalid, or duplicate entries");
    }
    addresses.add(address);
  }
}

export function validateScheduledSpotCoverage(summary: SpotHoldingsScanSummary, traders: TrackedTrader[]): void {
  const expected = new Set(traders.map((trader) => trader.walletAddress.toLowerCase()));
  const actual = summary.allResults.map((result) => result.walletAddress.toLowerCase());
  if (summary.tradersScanned !== expected.size || actual.length !== expected.size ||
      new Set(actual).size !== expected.size || actual.some((address) => !expected.has(address))) {
    throw new Error("Spot scan did not cover the complete tracked trader registry");
  }
  if (summary.failures !== 0 || summary.allResults.some((result) => result.error)) {
    throw new Error("Spot scan has failed trader fetches");
  }
  if (!summary.allResults.some((result) => result.holdings.length > 0)) {
    throw new Error("Spot scan produced no holdings; refusing to publish an empty snapshot");
  }
}

async function refreshSpotHoldingsInAction(
  cwd: string, logger: (line: string) => void, traders: TrackedTrader[],
): Promise<ScheduledSpotRefreshResult> {
  logger("Scheduled spot refresh running directly in GitHub Actions");
  const result = await runSpotHoldingsScan({ cwd, logger, traders });
  validateScheduledSpotCoverage(result, traders);
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

async function refreshOpenOrdersInAction(
  logger: (line: string) => void, traders: TrackedTrader[],
): Promise<ScheduledOpenOrderRefreshResult> {
  logger("Scheduled native open-order refresh running directly in GitHub Actions");
  const result = await runOpenOrderScan({ traders, logger });
  if (result.totalWallets !== traders.length || result.successfulWallets !== traders.length || result.failedWallets !== 0) {
    throw new Error("Open-order scan did not cover the complete tracked trader registry");
  }
  const snapshotId = await persistOpenOrderSnapshot(result);
  return {
    source: "github-action",
    snapshotId,
    capturedAt: result.fetchedAt,
    tradersScanned: result.totalWallets,
    failures: result.failedWallets,
    totalOrders: result.totalIndividualOrders,
  };
}

export async function runScheduledRefresh(options: ScheduledRefreshOptions = {}): Promise<ScheduledRefreshResult> {
  const startedAt = new Date().toISOString();
  const cwd = options.cwd || process.cwd();
  const logger = options.logger || ((line: string) => console.log(`[scheduled-signals] ${line}`));
  logger(`Scheduled signals + spot + open-order refresh started at ${startedAt}`);

  const traders = await (options.traderLoader || (async () => {
    const storage = createSignalStorage(cwd);
    try {
      return await storage.getTrackedTraders();
    } finally {
      storage.close();
    }
  }))();
  validateScheduledTraders(traders);
  logger(`Loaded ${traders.length} active traders from durable registry`);

  async function track<T>(stage: ScanStage, runner: () => Promise<T>): Promise<T> {
    await options.onStage?.(stage, { status: "running" });
    try {
      const result = await runner();
      const counts = result as { status?: string; tradersCompleted?: number; tradersScanned?: number };
      await options.onStage?.(stage, {
        status: stage === "perps" && counts.status !== "success" ? "partial" : "completed",
        wallets: counts.tradersCompleted ?? counts.tradersScanned ?? traders.length,
      });
      return result;
    } catch (error) {
      await options.onStage?.(stage, { status: "failed", error: errorMessage(error) });
      throw error;
    }
  }
  const [signalOutcome, spotOutcome, openOrderOutcome] = await Promise.allSettled([
    track("perps", () => (options.signalRunner || ((input) => runSignalRefresh({
      cwd, logger, traders: input, replaceTrackedTraders: false, requireNonemptyOutput: true,
    })))(traders)),
    track("spot", () => (options.spotRunner || ((input) => refreshSpotHoldingsInAction(cwd, logger, input)))(traders)),
    track("orders", () => (options.openOrderRunner || ((input) => refreshOpenOrdersInAction(logger, input)))(traders)),
  ]);

  let signal = signalOutcome.status === "fulfilled" ? signalOutcome.value : null;
  const spot = spotOutcome.status === "fulfilled" ? spotOutcome.value : null;
  const openOrders = openOrderOutcome.status === "fulfilled" ? openOrderOutcome.value : null;
  let signalRetryError: unknown = null;
  if (signal?.status === "partial" && signal.tradersFailed > 0) {
    const retryRunner = options.signalRetryRunner || (options.signalRunner ? null :
      (input: TrackedTrader[], snapshotId: number) => runSignalRefresh({
        cwd, logger, snapshotId, traders: input, replaceTrackedTraders: false,
        retryFailed: true, requireNonemptyOutput: true,
      }));
    if (retryRunner) {
      logger(`Retrying ${signal.tradersFailed} failed signal trader(s) in snapshot #${signal.snapshotId}`);
      try {
        signal = await track("perps", () => retryRunner(traders, signal!.snapshotId));
      } catch (error) {
        signalRetryError = error;
      }
    }
  }
  const errors = [
    ...(signalOutcome.status === "rejected" ? [`signal: ${errorMessage(signalOutcome.reason)}`] : []),
    ...(spotOutcome.status === "rejected" ? [`spot: ${errorMessage(spotOutcome.reason)}`] : []),
    ...(openOrderOutcome.status === "rejected" ? [`open-orders: ${errorMessage(openOrderOutcome.reason)}`] : []),
    ...(signalRetryError ? [`signal retry: ${errorMessage(signalRetryError)}`] : []),
  ];
  if (signal && (signal.tradersTotal !== traders.length || signal.tradersCompleted !== traders.length ||
      signal.tradersFailed !== 0 || signal.tradersRemaining !== 0 || signal.totalPositions <= 0)) {
    errors.push("signal: incomplete registry coverage or empty output");
  }
  if (spot && (spot.tradersScanned !== traders.length || spot.failures !== 0 || spot.tradersWithFilteredHoldings <= 0)) {
    errors.push("spot: incomplete registry coverage, failed fetch, or empty output");
  }
  if (openOrders && (openOrders.tradersScanned !== traders.length || openOrders.failures !== 0)) {
    errors.push("open-orders: incomplete registry coverage or failed fetch");
  }
  const hasSignalFailure = !signal || signal.status === "failed";
  const hasSignalPartial = signal?.status !== "success";
  const hasSpotFailure = !spot || spot.failures > 0;
  const hasOpenOrderFailure = !openOrders || openOrders.failures > 0;
  const status: ScheduledRefreshResult["status"] = hasSignalFailure || !spot || hasOpenOrderFailure
    ? "failed"
    : hasSignalPartial || hasSpotFailure || errors.length > 0
      ? "partial"
      : "success";

  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    status,
    signal,
    spot,
    openOrders,
    errors,
  };
}

async function main(): Promise<void> {
  let reporter: ReturnType<typeof createScanProgressReporter> | null = null;
  if (/^\d+$/.test(process.env.GITHUB_RUN_ID || "")) {
    reporter = createScanProgressReporter(process.env.GITHUB_RUN_ID!);
    try { await reporter.start(); } catch { reporter = null; console.warn("Scan progress storage unavailable; continuing with GitHub status only."); }
  }
  // Concurrency serializes scans. If another run satisfied this manual request
  // while it waited, reuse that result rather than scraping the same data again.
  if (reporter && process.env.SCAN_REQUESTED_AT) {
    const previous = await findScanCompletedSince(process.env.SCAN_REQUESTED_AT).catch(() => null);
    if (previous) {
      await reporter.reuse(previous);
      console.log(`Reused completed scan ${previous.runId} for this queued request.`);
      return;
    }
  }
  let result: ScheduledRefreshResult;
  try {
    result = await runScheduledRefresh({ onStage: reporter ? (stage, state) => reporter!.stage(stage, state) : undefined });
    await reporter?.finish(result);
  } catch (error) {
    await reporter?.fail(errorMessage(error));
    throw error;
  }
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
