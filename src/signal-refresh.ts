import { aggregateTokenSignalMetrics } from "./signals";
import { createStorage } from "./storage";
import { scrapeHypurrscanSignals } from "./hypurrscan-signals";
import { loadTrackedTraders } from "./trader-registry";
import { ScanLogger, SignalSnapshotStatus, TrackedTrader } from "./types";

type RunSignalRefreshOptions = {
  cwd?: string;
  logger?: ScanLogger;
  snapshotId?: number;
  traders?: TrackedTrader[];
};

type RunSignalRefreshResult = {
  snapshotId: number;
  tradersTotal: number;
  tradersCompleted: number;
  tradersFailed: number;
  totalPositions: number;
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
  const storage = createStorage(cwd);

  let snapshotId: number | null = options.snapshotId ?? null;

  try {
    const traders = (options.traders || loadTrackedTraders(cwd)).filter((trader) => trader.isActive);

    if (options.traders) {
      storage.replaceTrackedTraders(traders);
    }

    if (snapshotId === null) {
      snapshotId = storage.createSignalSnapshot(traders.length);
    }

    logger(`Signals refresh started for ${traders.length} tracked traders`);

    let completed = 0;
    let failed = 0;
    let totalPositions = 0;

    const runTrader = async (trader: TrackedTrader): Promise<void> => {
      const startedAt = new Date().toISOString();
      const runId = storage.insertSignalTraderRun({
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

        storage.insertTraderPositions(snapshotId as number, positions);
        completed += 1;
        totalPositions += positions.length;
        storage.updateSignalTraderRun(runId, {
          status: "success",
          positionsFound: positions.length,
          errorMessage: null,
          finishedAt: new Date().toISOString(),
        });
        storage.updateSignalSnapshot({
          id: snapshotId as number,
          tradersCompleted: completed,
          tradersFailed: failed,
          totalPositions,
        });
        logger(`Signals ${trader.traderName} — ${positions.length} open perps`);
      } catch (error) {
        failed += 1;
        const message = (error as Error)?.message || String(error);
        storage.updateSignalTraderRun(runId, {
          status: "failed",
          positionsFound: 0,
          errorMessage: message,
          finishedAt: new Date().toISOString(),
        });
        storage.updateSignalSnapshot({
          id: snapshotId as number,
          tradersCompleted: completed,
          tradersFailed: failed,
          totalPositions,
        });
        logger(`Signals failed for ${trader.traderName}: ${message}`);
      }
    };

    let cursor = 0;
    const workers = Array.from({ length: Math.min(concurrency, Math.max(1, traders.length)) }, async () => {
      while (cursor < traders.length) {
        const currentIndex = cursor;
        cursor += 1;
        await runTrader(traders[currentIndex]);
      }
    });

    await Promise.all(workers);

    const allPositions = storage.getTraderPositions(snapshotId);
    const metrics = aggregateTokenSignalMetrics(snapshotId, allPositions);
    storage.replaceTokenSignalMetrics(snapshotId, metrics);

    const status: SignalSnapshotStatus =
      completed === 0 && failed > 0 ? "failed" : failed > 0 ? "partial" : "success";

    storage.updateSignalSnapshot({
      id: snapshotId,
      status,
      tradersCompleted: completed,
      tradersFailed: failed,
      totalPositions,
      errorMessage: status === "failed" ? "All trader scrapes failed" : null,
      finishedAt: new Date().toISOString(),
    });

    logger(
      `Signals refresh complete. Snapshot #${snapshotId} — ${completed} succeeded, ${failed} failed, ${totalPositions} positions.`,
    );

    return {
      snapshotId,
      tradersTotal: traders.length,
      tradersCompleted: completed,
      tradersFailed: failed,
      totalPositions,
      status,
    };
  } catch (error) {
    if (snapshotId !== null) {
      storage.updateSignalSnapshot({
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
