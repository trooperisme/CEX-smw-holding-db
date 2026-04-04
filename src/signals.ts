import { TokenSignalMetric, TraderPosition } from "./types";

export function aggregateTokenSignalMetrics(
  snapshotId: number,
  positions: Array<Omit<TraderPosition, "snapshotId"> | TraderPosition>,
): TokenSignalMetric[] {
  const grouped = new Map<
    string,
    {
      snapshotId: number;
      marketType: "crypto" | "tradfi";
      token: string;
      longWallets: Set<string>;
      shortWallets: Set<string>;
      longValueUsd: number;
      shortValueUsd: number;
    }
  >();

  for (const position of positions) {
    const key = `${position.marketType}|${position.token}`;
    const entry =
      grouped.get(key) ||
      {
        snapshotId,
        marketType: position.marketType,
        token: position.token,
        longWallets: new Set<string>(),
        shortWallets: new Set<string>(),
        longValueUsd: 0,
        shortValueUsd: 0,
      };

    if (position.side === "long") {
      entry.longWallets.add(position.walletAddress);
      entry.longValueUsd += Number(position.valueUsd || 0);
    } else {
      entry.shortWallets.add(position.walletAddress);
      entry.shortValueUsd += Number(position.valueUsd || 0);
    }

    grouped.set(key, entry);
  }

  return Array.from(grouped.values())
    .map((entry) => {
      const longSmw = entry.longWallets.size;
      const shortSmw = entry.shortWallets.size;
      return {
        snapshotId: entry.snapshotId,
        marketType: entry.marketType,
        token: entry.token,
        smwFlows: longSmw - shortSmw,
        holdingsUsd: Math.abs(entry.longValueUsd - entry.shortValueUsd),
        longSmw,
        shortSmw,
        longValueUsd: Number(entry.longValueUsd.toFixed(2)),
        shortValueUsd: Number(entry.shortValueUsd.toFixed(2)),
      };
    })
    .sort((a, b) => {
      if (b.smwFlows !== a.smwFlows) return b.smwFlows - a.smwFlows;
      if (b.holdingsUsd !== a.holdingsUsd) return b.holdingsUsd - a.holdingsUsd;
      return a.token.localeCompare(b.token, undefined, { sensitivity: "base" });
    });
}
