import { aggregateTokenSignalMetrics } from "./signals";
import { createSignalStorage } from "./signal-storage";
import { scrapeHypurrscanSignals } from "./hypurrscan-signals";
import { loadTrackedTraders } from "./trader-registry";
import { ScanLogger, SignalSnapshotStatus, SignalTraderRunRecord, TrackedTrader } from "./types";

type RunSignalRefreshOptions = {
  cwd?: string;
  logger?: ScanLogger;
  snapshotId?: number;
  traders?: TrackedTrader[];
  replaceTrackedTraders?: boolean;
  requireNonemptyOutput?: boolean;
  scrapeRunner?: typeof scrapeHypurrscanSignals;
  maxTraders?: number;
  retryFailed?: boolean;
};

export type RunSignalRefreshResult = {
  snapshotId: number;
  tradersTotal: number;
  tradersCompleted: number;
  tradersFailed: number;
  totalPositions: number;
  tradersRemaining: number;
  status: SignalSnapshotStatus;
};

export type SignalRefreshProgress = {
  pendingTraders: TrackedTrader[];
  completed: number;
  failed: number;
  totalPositions: number;
  interruptedRuns: number;
  completedWallets: Set<string>;
  failedWallets: Set<string>;
};

function parseNum(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeWalletAddress(value: string): string {
  return String(value || "").trim().toLowerCase();
}

export function summarizeSignalRefreshProgress(
  traders: TrackedTrader[],
  previousRuns: SignalTraderRunRecord[],
  options: { retryFailed?: boolean } = {},
): SignalRefreshProgress {
  const latestRunByWallet = new Map<string, SignalTraderRunRecord>();
  for (const run of previousRuns) {
    latestRunByWallet.set(normalizeWalletAddress(run.walletAddress), run);
  }

  const completedWallets = new Set<string>();
  const failedWallets = new Set<string>();
  let totalPositions = 0;
  for (const [walletAddress, run] of latestRunByWallet) {
    if (run.status === "success") {
      completedWallets.add(walletAddress);
      totalPositions += Number(run.positionsFound || 0);
    } else if (run.status === "failed") {
      failedWallets.add(walletAddress);
    }
  }

  const processedWallets = new Set([
    ...completedWallets,
    ...(options.retryFailed ? [] : failedWallets),
  ]);
  const pendingTraders = traders.filter(
    (trader) => !processedWallets.has(normalizeWalletAddress(trader.walletAddress)),
  );

  return {
    pendingTraders,
    completed: completedWallets.size,
    failed: failedWallets.size,
    totalPositions,
    interruptedRuns: previousRuns.filter((run) => run.status === "running").length,
    completedWallets,
    failedWallets,
  };
}

export async function runSignalRefresh(
  options: RunSignalRefreshOptions = {},
): Promise<RunSignalRefreshResult> {
  const cwd = options.cwd || process.cwd();
  const logger = options.logger || ((line: string) => console.log(line));
  const concurrency = parseNum(process.env.SIGNALS_REFRESH_CONCURRENCY, 4);
  const defaultBatchSize = process.env.VERCEL
    ? parseNum(process.env.SIGNALS_REFRESH_BATCH_SIZE, 4)
    : Number.POSITIVE_INFINITY;
  const maxTraders = options.maxTraders ?? defaultBatchSize;
  const storage = createSignalStorage(cwd);

  const isContinuingSnapshot = options.snapshotId !== undefined && options.snapshotId !== null;
  let snapshotId: number | null = options.snapshotId ?? null;

  try {
    const traders = (options.traders || loadTrackedTraders(cwd)).filter((trader) => trader.isActive);

    if (options.traders && options.replaceTrackedTraders !== false) {
      await storage.replaceTrackedTraders(traders);
    }

    if (snapshotId === null) {
      snapshotId = await storage.createSignalSnapshot(traders.length);
    }

    const previousRuns = await storage.getSignalTraderRuns(snapshotId);
    const progress = summarizeSignalRefreshProgress(traders, previousRuns, {
      retryFailed: options.retryFailed ?? isContinuingSnapshot,
    });
    const { completedWallets, failedWallets, pendingTraders, interruptedRuns } = progress;
    if (interruptedRuns > 0) {
      logger(`Signals refresh found ${interruptedRuns} interrupted trader run(s); retrying unfinished wallets.`);
    }

    const tradersToRun = pendingTraders.slice(0, maxTraders);

    let completed = progress.completed;
    let failed = progress.failed;
    let totalPositions = progress.totalPositions;

    logger(
      `Signals refresh batch started for snapshot #${snapshotId}: ${tradersToRun.length}/${pendingTraders.length} pending traders`,
    );

    const runTrader = async (trader: TrackedTrader): Promise<void> => {
      const startedAt = new Date().toISOString();
        const runId = await storage.insertSignalTraderRun({
        snapshotId: snapshotId as number,
        traderName: trader.traderName,
        walletAddress: trader.walletAddress,
        sourceUrl: trader.hypurrscanUrl,
        status: "running",
        positionsFound: 0,
        errorMessage: null,
        startedAt,
        finishedAt: null,
      });

      try {
        const positions = await (options.scrapeRunner || scrapeHypurrscanSignals)(trader, {
          cwd,
          snapshotId: snapshotId as number,
        });

        await storage.insertTraderPositions(snapshotId as number, positions);
        completedWallets.add(normalizeWalletAddress(trader.walletAddress));
        failedWallets.delete(normalizeWalletAddress(trader.walletAddress));
        completed = completedWallets.size;
        failed = failedWallets.size;
        totalPositions += positions.length;
        await storage.updateSignalTraderRun(runId, {
          status: "success",
          positionsFound: positions.length,
          errorMessage: null,
          finishedAt: new Date().toISOString(),
        });
        await storage.updateSignalSnapshot({
          id: snapshotId as number,
          tradersCompleted: completed,
          tradersFailed: failed,
          totalPositions,
        });
        logger(`Signals ${trader.traderName} — ${positions.length} open perps`);
      } catch (error) {
        failedWallets.add(normalizeWalletAddress(trader.walletAddress));
        completedWallets.delete(normalizeWalletAddress(trader.walletAddress));
        completed = completedWallets.size;
        failed = failedWallets.size;
        const message = (error as Error)?.message || String(error);
        await storage.updateSignalTraderRun(runId, {
          status: "failed",
          positionsFound: 0,
          errorMessage: message,
          finishedAt: new Date().toISOString(),
        });
        await storage.updateSignalSnapshot({
          id: snapshotId as number,
          tradersCompleted: completed,
          tradersFailed: failed,
          totalPositions,
        });
        logger(`Signals failed for ${trader.traderName}: ${message}`);
      }
    };

    let cursor = 0;
    const workers = Array.from({ length: Math.min(concurrency, Math.max(1, tradersToRun.length)) }, async () => {
      while (cursor < tradersToRun.length) {
        const currentIndex = cursor;
        cursor += 1;
        await runTrader(tradersToRun[currentIndex]);
      }
    });

    await Promise.all(workers);

    const allPositions = await storage.getTraderPositions(snapshotId);
    const metrics = aggregateTokenSignalMetrics(snapshotId, allPositions);
    await storage.replaceTokenSignalMetrics(snapshotId, metrics);

    const tradersRemaining = Math.max(0, traders.length - completed - failed);
    const status: SignalSnapshotStatus =
      tradersRemaining > 0
        ? "running"
        : completed === 0 && failed > 0
          ? "failed"
          : failed > 0 || (options.requireNonemptyOutput && totalPositions === 0)
            ? "partial"
            : "success";

    await storage.updateSignalSnapshot({
      id: snapshotId,
      status,
      tradersCompleted: completed,
      tradersFailed: failed,
      totalPositions,
      errorMessage: status === "failed"
        ? "All trader scrapes failed"
        : options.requireNonemptyOutput && totalPositions === 0
          ? "Signal scan produced no positions"
          : null,
      finishedAt: status === "running" ? null : new Date().toISOString(),
    });

    logger(
      `Signals refresh batch complete. Snapshot #${snapshotId} — ${completed} succeeded, ${failed} failed, ${totalPositions} positions, ${tradersRemaining} traders remaining.`,
    );

    return {
      snapshotId,
      tradersTotal: traders.length,
      tradersCompleted: completed,
      tradersFailed: failed,
      totalPositions,
      tradersRemaining,
      status,
    };
  } catch (error) {
    if (snapshotId !== null) {
      await storage.updateSignalSnapshot({
        id: snapshotId,
        status: "failed",
        errorMessage: (error as Error)?.message || String(error),
        finishedAt: new Date().toISOString(),
      });
    }
    throw error;
  } finally {
    storage.close();
  }
}
