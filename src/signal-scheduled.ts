import dotenv from "dotenv";
import { runSignalRefresh, RunSignalRefreshResult } from "./signal-refresh";
import { runSpotHoldingsScan } from "./spot-holdings";
import { persistSpotHoldingsSnapshot } from "./spot-storage";
import { SpotHoldingsScanSummary } from "./spot-holdings";
import { createSignalStorage } from "./signal-storage";
import { runOpenOrderScan } from "./open-order-scan";
import { persistOpenOrderSnapshot } from "./open-order-storage";
import { TrackedTrader } from "./types";

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
  spotRunner?: (traders: TrackedTrader[]) => Promise<ScheduledSpotRefreshResult>;
  openOrderRunner?: (traders: TrackedTrader[]) => Promise<ScheduledOpenOrderRefreshResult>;
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

  const [signalOutcome, spotOutcome, openOrderOutcome] = await Promise.allSettled([
    (options.signalRunner || ((input) => runSignalRefresh({
      cwd, logger, traders: input, replaceTrackedTraders: false, requireNonemptyOutput: true,
    })))(traders),
    (options.spotRunner || ((input) => refreshSpotHoldingsInAction(cwd, logger, input)))(traders),
    (options.openOrderRunner || ((input) => refreshOpenOrdersInAction(logger, input)))(traders),
  ]);

  const signal = signalOutcome.status === "fulfilled" ? signalOutcome.value : null;
  const spot = spotOutcome.status === "fulfilled" ? spotOutcome.value : null;
  const openOrders = openOrderOutcome.status === "fulfilled" ? openOrderOutcome.value : null;
  const errors = [
    ...(signalOutcome.status === "rejected" ? [`signal: ${errorMessage(signalOutcome.reason)}`] : []),
    ...(spotOutcome.status === "rejected" ? [`spot: ${errorMessage(spotOutcome.reason)}`] : []),
    ...(openOrderOutcome.status === "rejected" ? [`open-orders: ${errorMessage(openOrderOutcome.reason)}`] : []),
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
