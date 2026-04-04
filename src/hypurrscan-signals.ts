import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { ensureDirExists, resolveWorkspacePaths } from "./runtime-paths";
import { TraderPosition, TraderPositionSide, TrackedTrader } from "./types";
import { classifySignalMarketType } from "./trader-registry";

const execFileAsync = promisify(execFile);

type ScrapeHypurrscanOptions = {
  cwd: string;
  snapshotId: number;
};

function cleanMarkdownCell(input: string): string {
  return String(input || "")
    .replace(/!\[[^\]]*]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseCurrencyToNumber(input: string): number | null {
  const normalized = String(input || "")
    .replace(/\$/g, "")
    .replace(/,/g, "")
    .trim();
  const match = normalized.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const value = Number(match[0]);
  return Number.isFinite(value) ? Math.abs(value) : null;
}

function toSide(input: string): TraderPositionSide | null {
  const normalized = cleanMarkdownCell(input).toLowerCase();
  if (normalized === "long") return "long";
  if (normalized === "short") return "short";
  return null;
}

function parsePerpsTable(markdown: string): Array<{
  token: string;
  side: TraderPositionSide;
  valueUsd: number;
}> {
  const lines = markdown.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => line.includes("| Token | Side | Lev. | Value |"));
  if (headerIndex === -1) return [];

  const positions: Array<{ token: string; side: TraderPositionSide; valueUsd: number }> = [];

  for (let i = headerIndex + 2; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line.startsWith("|")) break;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length < 4) continue;

    const token = cleanMarkdownCell(cells[0]).replace(/-USD$/i, "").trim();
    const side = toSide(cells[1]);
    const valueUsd = parseCurrencyToNumber(cells[3]);
    if (!token || !side || valueUsd === null || valueUsd <= 0) continue;

    positions.push({ token, side, valueUsd });
  }

  return positions;
}

async function runFirecrawlScrape(url: string, outputPath: string, cwd: string): Promise<void> {
  await execFileAsync(
    "firecrawl",
    ["scrape", url, "--only-main-content", "--wait-for", "3000", "-o", outputPath],
    { cwd, maxBuffer: 20 * 1024 * 1024 },
  );
}

export async function scrapeHypurrscanSignals(
  trader: TrackedTrader,
  options: ScrapeHypurrscanOptions,
): Promise<Omit<TraderPosition, "snapshotId">[]> {
  const paths = resolveWorkspacePaths(options.cwd);
  const scrapeDir = path.join(paths.processedDataDir, "signal-scrapes", `snapshot-${options.snapshotId}`);
  ensureDirExists(scrapeDir);
  const outputPath = path.join(scrapeDir, `${trader.walletAddress}.md`);

  await runFirecrawlScrape(trader.hypurrscanUrl, outputPath, options.cwd);
  const markdown = fs.readFileSync(outputPath, "utf-8");
  const positions = parsePerpsTable(markdown);

  return positions.map((position) => ({
    traderName: trader.traderName,
    walletAddress: trader.walletAddress,
    sourceUrl: trader.hypurrscanUrl,
    token: position.token,
    side: position.side,
    valueUsd: position.valueUsd,
    marketType: classifySignalMarketType(position.token),
    scrapedAt: new Date().toISOString(),
    parseStatus: "parsed",
  }));
}

export function parseHypurrscanMarkdown(markdown: string): Array<{
  token: string;
  side: TraderPositionSide;
  valueUsd: number;
}> {
  return parsePerpsTable(markdown);
}
