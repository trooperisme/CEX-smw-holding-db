import fs from "node:fs";
import path from "node:path";
import { ensureDirExists, resolveWorkspacePaths } from "./runtime-paths";
import { TraderPosition, TraderPositionSide, TrackedTrader } from "./types";
import { classifySignalMarketType } from "./trader-registry";

type ScrapeHypurrscanOptions = {
  cwd: string;
  snapshotId: number;
  scrapeRunner?: FirecrawlScrapeRunner;
};

type FirecrawlScrapeRunner = (url: string, outputPath: string) => Promise<void>;

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

function looksLikeEmptyHypurrscanMarkdown(markdown: string): boolean {
  const normalized = String(markdown || "");
  return (
    normalized.includes("No positions found") ||
    normalized.includes("| No data available |") ||
    normalized.includes("Perps  : 0.00$") ||
    normalized.includes("Overview\n\n0.00$")
  );
}

function isRetriableScrapeError(error: unknown): boolean {
  const message = String((error as Error)?.message || error || "");
  return (
    /Firecrawl scrape failed \((?:408|409|425|429|5\d\d)\)/i.test(message) ||
    /SCRAPE_ALL_ENGINES_FAILED/i.test(message) ||
    /Firecrawl returned empty markdown/i.test(message) ||
    /fetch failed|network|timeout|temporarily unavailable|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i.test(message)
  );
}

async function runFirecrawlScrape(url: string, outputPath: string): Promise<void> {
  const apiKey = process.env.FIRECRAWL_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("FIRECRAWL_API_KEY is required for Hypurrscan scraping");
  }

  const response = await fetch("https://api.firecrawl.dev/v2/scrape", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      url,
      formats: ["markdown"],
      maxAge: 0,
      storeInCache: false,
      proxy: "auto",
      removeBase64Images: true,
      blockAds: true,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Firecrawl scrape failed (${response.status}): ${text}`);
  }

  const payload = (await response.json()) as {
    success?: boolean;
    data?: { markdown?: string };
    error?: string;
  };

  if (!payload.success) {
    throw new Error(payload.error || "Firecrawl returned an unsuccessful response");
  }

  const markdown = String(payload.data?.markdown || "").trim();
  if (!markdown) {
    throw new Error("Firecrawl returned empty markdown");
  }

  fs.writeFileSync(outputPath, markdown, "utf-8");
}

export async function scrapeHypurrscanSignals(
  trader: TrackedTrader,
  options: ScrapeHypurrscanOptions,
): Promise<Omit<TraderPosition, "snapshotId">[]> {
  const paths = resolveWorkspacePaths(options.cwd);
  const scrapeDir = path.join(paths.processedDataDir, "signal-scrapes", `snapshot-${options.snapshotId}`);
  ensureDirExists(scrapeDir);
  const outputPath = path.join(scrapeDir, `${trader.walletAddress}.md`);
  const emptyRetryCount = parsePositiveInt(process.env.HYPURRSCAN_EMPTY_RETRY_COUNT, 2);
  const scrapeRetryCount = parsePositiveInt(process.env.HYPURRSCAN_SCRAPE_RETRY_COUNT, 4);
  const retryDelayMs = parsePositiveInt(process.env.HYPURRSCAN_RETRY_DELAY_MS, 1500);
  const scrapeRunner = options.scrapeRunner || runFirecrawlScrape;

  let markdown = "";
  let positions: Array<{
    token: string;
    side: TraderPositionSide;
    valueUsd: number;
  }> = [];
  let scrapeFailures = 0;
  let emptyResponses = 0;

  for (;;) {
    try {
      await scrapeRunner(trader.hypurrscanUrl, outputPath);
      markdown = fs.readFileSync(outputPath, "utf-8");
      positions = parsePerpsTable(markdown);
    } catch (error) {
      if (scrapeFailures >= scrapeRetryCount || !isRetriableScrapeError(error)) {
        throw error;
      }
      scrapeFailures += 1;
      await sleep(retryDelayMs * scrapeFailures);
      continue;
    }

    if (positions.length > 0 || !looksLikeEmptyHypurrscanMarkdown(markdown) || emptyResponses >= emptyRetryCount) {
      break;
    }

    emptyResponses += 1;
    await sleep(retryDelayMs * emptyResponses);
  }

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
