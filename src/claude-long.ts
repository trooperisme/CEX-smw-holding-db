import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { ensureDirExists, resolveWorkspacePaths, toWorkspaceRelativePath } from "./runtime-paths";
import { createStorage } from "./storage";
import {
  getClearinghouseState,
  HyperliquidClearinghouseAssetPosition,
  HyperliquidClearinghousePosition,
  HyperliquidClearinghouseState,
} from "./hyperliquid";

dotenv.config();

export type ClaudeLongPositionSnapshot = {
  ticker: string;
  side: "LONG" | "SHORT";
  size: number;
  entry: number | null;
  unrealizedPnl: number | null;
};

export type ClaudeLongRunResult = {
  wallet: string;
  checkedAt: string;
  positions: ClaudeLongPositionSnapshot[];
  reportMarkdownPath: string;
  reportJsonPath: string;
  currentState: HyperliquidClearinghouseState;
};

export type RunClaudeLongOptions = {
  cwd?: string;
  logger?: (line: string) => void;
};

const WORKFLOW_KEY = "claude_long";
const DEFAULT_WALLET = "0x9b8d146ab4b61c281b993e3f85066249a6e9b0db";
const RUN_TARGET_ASSET = "ALL_POSITIONS";

function parseNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function localDateSlug(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatNumber(value: number | null, maximumFractionDigits = 4): string {
  if (value === null || !Number.isFinite(value)) return "n/a";
  return value.toLocaleString("en-US", { maximumFractionDigits });
}

function formatUsd(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "n/a";
  return `$${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

export function extractOpenPositions(assetPositions: HyperliquidClearinghouseAssetPosition[] = []): ClaudeLongPositionSnapshot[] {
  return assetPositions
    .map((item) => item.position)
    .filter((position): position is HyperliquidClearinghousePosition => Boolean(position))
    .map((position) => {
      const signedSize = parseNumber(position.szi);
      if (signedSize === null || signedSize === 0) return null;

      return {
        ticker: position.coin || "UNKNOWN",
        side: signedSize > 0 ? "LONG" : "SHORT",
        size: Math.abs(signedSize),
        entry: parseNumber(position.entryPx),
        unrealizedPnl: parseNumber(position.unrealizedPnl),
      };
    })
    .filter((position): position is ClaudeLongPositionSnapshot => Boolean(position))
    .sort((a, b) => b.size - a.size);
}

export function buildClaudeLongMarkdown(wallet: string, checkedAt: string, positions: ClaudeLongPositionSnapshot[]): string {
  const lines = [
    "# claude_long",
    "",
    `Wallet: \`${wallet}\``,
    `Checked at: ${checkedAt}`,
    "",
  ];

  if (positions.length === 0) {
    lines.push("No open perp positions.");
    return `${lines.join("\n")}\n`;
  }

  lines.push("| Ticker | Side | Size | Entry | Unrealized PnL |");
  lines.push("| --- | --- | ---: | ---: | ---: |");
  for (const position of positions) {
    lines.push(
      `| ${position.ticker} | ${position.side} | ${formatNumber(position.size)} | ${formatNumber(position.entry)} | ${formatUsd(position.unrealizedPnl)} |`,
    );
  }

  return `${lines.join("\n")}\n`;
}

export async function runClaudeLong(options: RunClaudeLongOptions = {}): Promise<ClaudeLongRunResult> {
  const cwd = options.cwd || process.cwd();
  const log = options.logger || (() => {});
  const paths = resolveWorkspacePaths(cwd);
  const storage = createStorage(cwd);
  const wallet = process.env.CLAUDE_LONG_WALLET?.trim() || DEFAULT_WALLET;
  const priorState = storage.getClaudeLongState(WORKFLOW_KEY);
  const checkedAt = new Date().toISOString();
  const currentState = await getClearinghouseState(wallet);
  const positions = extractOpenPositions(currentState.assetPositions || []);

  const runDir = path.join(paths.appRunsDir, `${localDateSlug()}-${WORKFLOW_KEY}`);
  ensureDirExists(runDir);

  const markdownPath = path.join(runDir, "report.md");
  const jsonPath = path.join(runDir, "report.json");
  const markdownRelativePath = toWorkspaceRelativePath(cwd, markdownPath);
  const jsonRelativePath = toWorkspaceRelativePath(cwd, jsonPath);

  const runId = storage.insertClaudeLongRun({
    workflowKey: WORKFLOW_KEY,
    status: "running",
    wallet,
    targetAsset: RUN_TARGET_ASSET,
    checkpointStartAt: priorState?.lastSuccessfulRunAt || null,
    checkpointEndAt: checkedAt,
    targetStatus: positions.length > 0 ? "OPEN" : "CLOSED",
    behaviorLabel: null,
    twapStatus: null,
    reportPath: markdownRelativePath,
    reportJsonPath: jsonRelativePath,
    errorMessage: null,
    startedAt: checkedAt,
    finishedAt: null,
  });

  try {
    const markdown = buildClaudeLongMarkdown(wallet, checkedAt, positions);
    const jsonPayload = {
      wallet,
      checkedAt,
      positions,
      source: "https://api.hyperliquid.xyz/info",
    };

    fs.writeFileSync(markdownPath, markdown, "utf8");
    fs.writeFileSync(jsonPath, JSON.stringify(jsonPayload, null, 2), "utf8");

    storage.upsertClaudeLongState({
      workflowKey: WORKFLOW_KEY,
      lastSuccessfulRunAt: checkedAt,
      lastTargetPositionSize: null,
      lastTargetEntryPrice: null,
      lastSeenTwapIds: [],
      lastReportPath: markdownRelativePath,
      lastReportJsonPath: jsonRelativePath,
    });

    storage.updateClaudeLongRun(runId, {
      status: "success",
      checkpointEndAt: checkedAt,
      targetStatus: positions.length > 0 ? "OPEN" : "CLOSED",
      reportPath: markdownRelativePath,
      reportJsonPath: jsonRelativePath,
      finishedAt: new Date().toISOString(),
    });

    log(`[claude_long] wrote ${markdownRelativePath}`);

    return {
      wallet,
      checkedAt,
      positions,
      reportMarkdownPath: markdownRelativePath,
      reportJsonPath: jsonRelativePath,
      currentState,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    storage.updateClaudeLongRun(runId, {
      status: "failed",
      errorMessage: message,
      finishedAt: new Date().toISOString(),
    });
    throw error;
  } finally {
    storage.close();
  }
}

async function main() {
  const result = await runClaudeLong({
    logger: (line) => console.log(line),
  });

  if (result.positions.length === 0) {
    console.log("No open perp positions.");
    return;
  }

  for (const position of result.positions) {
    console.log(
      `${position.ticker}: ${position.side} size=${formatNumber(position.size)} entry=${formatNumber(position.entry)} uPnL=${formatUsd(position.unrealizedPnl)}`,
    );
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error("[claude_long] failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
