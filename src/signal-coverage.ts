import { SignalTraderRunRecord, TrackedTrader } from "./types";

export type SignalSnapshotCoverageSummary = {
  trackedTotal: number;
  coveredCount: number;
  missingTrackedCount: number;
  missingTrackedTraders: Array<{
    traderName: string;
    walletAddress: string;
    sourceUrl: string;
  }>;
};

function normalizeWalletAddress(value: string): string {
  return String(value || "").trim().toLowerCase();
}

export function buildSignalSnapshotCoverageSummary(
  trackedTraders: TrackedTrader[],
  runs: SignalTraderRunRecord[],
): SignalSnapshotCoverageSummary {
  const coveredWallets = new Set(runs.map((run) => normalizeWalletAddress(run.walletAddress)));
  const missingTrackedTraders = trackedTraders
    .filter((trader) => !coveredWallets.has(normalizeWalletAddress(trader.walletAddress)))
    .map((trader) => ({
      traderName: trader.traderName,
      walletAddress: trader.walletAddress,
      sourceUrl: trader.hypurrscanUrl,
    }));

  return {
    trackedTotal: trackedTraders.length,
    coveredCount: trackedTraders.length - missingTrackedTraders.length,
    missingTrackedCount: missingTrackedTraders.length,
    missingTrackedTraders,
  };
}

export async function loadSignalSnapshotCoverageSummary(
  storage: {
    getTrackedTraders(): Promise<TrackedTrader[]>;
    getSignalTraderRuns(snapshotId: number): Promise<SignalTraderRunRecord[]>;
  },
  snapshotId: number,
): Promise<SignalSnapshotCoverageSummary> {
  const [traders, runs] = await Promise.all([
    storage.getTrackedTraders(),
    storage.getSignalTraderRuns(snapshotId),
  ]);
  return buildSignalSnapshotCoverageSummary(traders.filter((trader) => trader.isActive), runs);
}
