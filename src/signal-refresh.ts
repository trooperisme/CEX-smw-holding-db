import { aggregateTokenSignalMetrics } from "./signals";
import { createSignalStorage } from "./signal-storage";
import { scrapeHypurrscanSignals } from "./hypurrscan-signals";
import { loadTrackedTraders } from "./trader-registry";
import { ScanLogger, SignalSnapshotStatus, TrackedTrader } from "./types";

type RunSignalRefreshOptions = {
  cwd?: string;
  logger?: ScanLogger;
  snapshotId?: number;
  traders?: TrackedTrader[];
  maxTraders?: number;
};

type RunSignalRefreshResult = {
  snapshotId: number;
  tradersTotal: number;
  tradersCompleted: number;
  tradersFailed: number;
  totalPositions: number;
  tradersRemaining: number;
  status: SignalSnapshotStatus;
};

function parseNum(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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

  let snapshotId: number | null = options.snapshotId ?? null;

  try {
    const traders = (options.traders || loadTrackedTraders(cwd)).filter((trader) => trader.isActive);

    if (options.traders) {
      await storage.replaceTrackedTraders(traders);
    }

    if (snapshotId === null) {
      snapshotId = await storage.createSignalSnapshot(traders.length);
    }

    const previousRuns = await storage.getSignalTraderRuns(snapshotId);
    const processedWallets = new Set(previousRuns.map((run) => run.walletAddress));
    const pendingTraders = traders.filter((trader) => !processedWallets.has(trader.walletAddress));
    const tradersToRun = pendingTraders.slice(0, maxTraders);

    let completed = previousRuns.filter((run) => run.status === "success").length;
    let failed = previousRuns.filter((run) => run.status === "failed").length;
    let totalPositions = previousRuns.reduce((sum, run) => sum + Number(run.positionsFound || 0), 0);

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
        const positions = await scrapeHypurrscanSignals(trader, {
          cwd,
          snapshotId: snapshotId as number,
        });

        await storage.insertTraderPositions(snapshotId as number, positions);
        completed += 1;
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
        failed += 1;
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

    const tradersRemaining = Math.max(0, pendingTraders.length - tradersToRun.length);
    const status: SignalSnapshotStatus =
      tradersRemaining > 0
        ? "running"
        : completed === 0 && failed > 0
          ? "failed"
          : failed > 0
            ? "partial"
            : "success";

    await storage.updateSignalSnapshot({
      id: snapshotId,
      status,
      tradersCompleted: completed,
      tradersFailed: failed,
      totalPositions,
      errorMessage: status === "failed" ? "All trader scrapes failed" : null,
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
