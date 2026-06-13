import {
  SignalMarketType,
  SignalTraderRunRecord,
  TokenSignalMetric,
  TraderPosition,
} from "./types";

type SignalSnapshotExportRecord = {
  id: number;
  status: string;
  total_traders: number;
  traders_completed: number;
  traders_failed: number;
  total_positions: number;
  error_message?: string | null;
  created_at: string;
  finished_at?: string | null;
};

export type SignalMarkdownExportInput = {
  snapshot: SignalSnapshotExportRecord;
  market: SignalMarketType;
  metrics: TokenSignalMetric[];
  positions: TraderPosition[];
  runs: SignalTraderRunRecord[];
};

function fmtUsd(value: number): string {
  return Number(value || 0).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  });
}

function shortWallet(value: string): string {
  const normalized = String(value || "").trim();
  if (!normalized) return "";
  if (normalized.length <= 12) return normalized;
  return `${normalized.slice(0, 6)}...${normalized.slice(-4)}`;
}

function markdownCell(value: unknown): string {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\n/g, " ")
    .trim();
}

function sortMetrics(metrics: TokenSignalMetric[]): TokenSignalMetric[] {
  return [...metrics].sort((left, right) => {
    if (right.smwFlows !== left.smwFlows) return right.smwFlows - left.smwFlows;
    if (right.holdingsUsd !== left.holdingsUsd) return right.holdingsUsd - left.holdingsUsd;
    return left.token.localeCompare(right.token, undefined, { sensitivity: "base" });
  });
}

function sortPositions(positions: TraderPosition[]): TraderPosition[] {
  return [...positions].sort((left, right) => {
    if (right.valueUsd !== left.valueUsd) return right.valueUsd - left.valueUsd;
    return left.traderName.localeCompare(right.traderName, undefined, { sensitivity: "base" });
  });
}

export function buildSignalMarkdownExport(input: SignalMarkdownExportInput): string {
  const metrics = sortMetrics(input.metrics.filter((row) => row.marketType === input.market));
  const tokenSet = new Set(metrics.map((row) => row.token));
  const marketPositions = input.positions.filter(
    (row) => row.marketType === input.market && tokenSet.has(row.token),
  );
  const failedCount = input.runs.filter((run) => run.status === "failed").length;
  const zeroPositionCount = input.runs.filter(
    (run) => run.status === "success" && Number(run.positionsFound || 0) === 0,
  ).length;
  const timestamp = input.snapshot.finished_at || input.snapshot.created_at;

  const lines = [
    "# Hypurrscan Signals Export",
    "",
    `Snapshot: #${input.snapshot.id}`,
    `Market: ${input.market}`,
    `Status: ${input.snapshot.status}`,
    `Timestamp: ${timestamp}`,
    `Trader coverage: ${Number(input.snapshot.traders_completed || 0)}/${Number(input.snapshot.total_traders || 0)} completed, ${failedCount} failed, ${zeroPositionCount} zero-position traders`,
    `Total positions: ${Number(input.snapshot.total_positions || 0)}`,
  ];

  if (input.snapshot.error_message) {
    lines.push(`Snapshot error: ${input.snapshot.error_message}`);
  }

  lines.push(
    "",
    "## Token Summary",
    "",
    "| Token | Holdings USD | Netflow | Long SMW | Short SMW | Long Value USD | Short Value USD |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
  );

  if (!metrics.length) {
    lines.push("| No token signals | $0.00 | 0 | 0 | 0 | $0.00 | $0.00 |");
  } else {
    for (const row of metrics) {
      lines.push(
        `| ${markdownCell(row.token)} | ${fmtUsd(row.holdingsUsd)} | ${row.smwFlows} | ${row.longSmw} | ${row.shortSmw} | ${fmtUsd(row.longValueUsd)} | ${fmtUsd(row.shortValueUsd)} |`,
      );
    }
  }

  lines.push("", "## Trader Breakdown");

  if (!metrics.length) {
    lines.push("", "No trader breakdown for this market and snapshot.");
  }

  for (const row of metrics) {
    const tokenPositions = marketPositions.filter((position) => position.token === row.token);
    const longRows = sortPositions(tokenPositions.filter((position) => position.side === "long"));
    const shortRows = sortPositions(tokenPositions.filter((position) => position.side === "short"));

    lines.push(
      "",
      `### ${row.token}`,
      `Holdings: ${fmtUsd(row.holdingsUsd)} | Netflow: ${row.smwFlows} | Long SMW: ${row.longSmw} | Short SMW: ${row.shortSmw}`,
      "",
      "Long:",
    );

    if (longRows.length) {
      for (const position of longRows) {
        lines.push(
          `- ${position.traderName} (${shortWallet(position.walletAddress)}): ${fmtUsd(position.valueUsd)}`,
        );
      }
    } else {
      lines.push("- None");
    }

    lines.push("", "Short:");
    if (shortRows.length) {
      for (const position of shortRows) {
        lines.push(
          `- ${position.traderName} (${shortWallet(position.walletAddress)}): ${fmtUsd(position.valueUsd)}`,
        );
      }
    } else {
      lines.push("- None");
    }
  }

  if (failedCount > 0 || zeroPositionCount > 0) {
    lines.push("", "## Notes");
    if (zeroPositionCount > 0) {
      lines.push(`- ${zeroPositionCount} successful trader scrapes had 0 open perps.`);
    }
    if (failedCount > 0) {
      lines.push(`- ${failedCount} trader scrapes failed in this snapshot.`);
    }
  }

  return `${lines.join("\n")}\n`;
}
