import fs from "node:fs";
import path from "node:path";
import { ensureDirExists, resolveWorkspacePaths } from "./runtime-paths";
import { TraderPosition, TraderPositionSide, TrackedTrader } from "./types";
import { classifySignalMarketType } from "./trader-registry";

type ScrapeHypurrscanOptions = {
  cwd: string;
  snapshotId: number;
  scrapeRunner?: FirecrawlScrapeRunner;
  vaultPositionRunner?: HypurrscanVaultPositionRunner;
};

type FirecrawlScrapeRunner = (url: string, outputPath: string) => Promise<void>;

type ParsedSignalPosition = {
  token: string;
  side: TraderPositionSide;
  valueUsd: number;
};

type HypurrscanVaultPositionRunner = (
  vaultAddress: string,
  outputPath: string,
) => Promise<ParsedSignalPosition[]>;

type HypurrscanClearinghouseState = {
  assetPositions?: Array<{
    position?: {
      coin?: string;
      szi?: string | number;
      positionValue?: string | number;
    };
  }>;
};

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createTimeoutSignal(timeoutMs: number): AbortSignal | undefined {
  if (timeoutMs <= 0) return undefined;
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(timeoutMs);
  }

  const controller = new AbortController();
  setTimeout(() => controller.abort(), timeoutMs).unref?.();
  return controller.signal;
}

let nextFirecrawlRequestAt = 0;
let firecrawlThrottleTail = Promise.resolve();

async function waitForFirecrawlSlot(): Promise<void> {
  const minIntervalMs = parsePositiveInt(process.env.HYPURRSCAN_FIRECRAWL_MIN_INTERVAL_MS, 6500);
  if (minIntervalMs <= 0) return;

  const previousTail = firecrawlThrottleTail;
  let releaseTail = () => {};
  firecrawlThrottleTail = new Promise<void>((resolve) => {
    releaseTail = resolve;
  });

  await previousTail;
  const now = Date.now();
  const waitMs = Math.max(0, nextFirecrawlRequestAt - now);
  if (waitMs > 0) await sleep(waitMs);
  nextFirecrawlRequestAt = Date.now() + minIntervalMs;
  releaseTail();
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

function parsePerpsTable(markdown: string): ParsedSignalPosition[] {
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

export function parseHypurrscanVaultPositions(payload: unknown): ParsedSignalPosition[] {
  const assetPositions = (payload as HypurrscanClearinghouseState | null)?.assetPositions;
  if (!Array.isArray(assetPositions)) return [];

  return assetPositions.flatMap((assetPosition) => {
    const position = assetPosition?.position;
    const token = cleanMarkdownCell(String(position?.coin || "")).replace(/-USD$/i, "").trim();
    const signedSize = Number(position?.szi);
    const valueUsd = parseCurrencyToNumber(String(position?.positionValue || ""));
    if (!token || !Number.isFinite(signedSize) || signedSize === 0 || valueUsd === null || valueUsd <= 0) {
      return [];
    }

    return [{
      token,
      side: signedSize < 0 ? "short" : "long",
      valueUsd,
    } satisfies ParsedSignalPosition];
  });
}

function isHypurrscanVaultUrl(url: string): boolean {
  return /https?:\/\/[^/]*hypurrscan\.io\/vault\/0x[a-fA-F0-9]{40}(?:[/?#]|$)/i.test(String(url || ""));
}

function extractHypurrscanVaultAddress(url: string): string | null {
  const match = String(url || "").match(/\/vault\/(0x[a-fA-F0-9]{40})(?:[/?#]|$)/i);
  return match?.[1].toLowerCase() || null;
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
    /Hypurrscan vault scrape failed \((?:408|409|425|429|5\d\d)\)/i.test(message) ||
    /SCRAPE_ALL_ENGINES_FAILED/i.test(message) ||
    /Firecrawl returned empty markdown/i.test(message) ||
    /fetch failed|network|timeout|temporarily unavailable|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i.test(message)
  );
}

function getRetryAfterMs(error: unknown): number | null {
  const message = String((error as Error)?.message || error || "");
  const retryAfterMatch = message.match(/retry after\s+(\d+)s/i);
  if (retryAfterMatch) {
    return (Number(retryAfterMatch[1]) + 2) * 1000;
  }

  const resetMatch = message.match(/resets at ([^"}]+)/i);
  if (resetMatch) {
    const resetAt = Date.parse(resetMatch[1]);
    if (Number.isFinite(resetAt)) {
      return Math.max(0, resetAt - Date.now() + 2000);
    }
  }

  return null;
}

async function runFirecrawlScrape(url: string, outputPath: string): Promise<void> {
  const apiKey = process.env.FIRECRAWL_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("FIRECRAWL_API_KEY is required for Hypurrscan scraping");
  }

  await waitForFirecrawlSlot();

  const timeoutMs = parsePositiveInt(process.env.HYPURRSCAN_FIRECRAWL_TIMEOUT_MS, 60000);
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
    signal: createTimeoutSignal(timeoutMs),
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

async function runHypurrscanVaultPositions(
  vaultAddress: string,
  outputPath: string,
): Promise<ParsedSignalPosition[]> {
  // Hypurrscan's Vault > Positions tab uses this public Hyperliquid payload;
  // call the same source directly because Firecrawl only sees the overview tab.
  const timeoutMs = parsePositiveInt(process.env.HYPURRSCAN_VAULT_TIMEOUT_MS, 30000);
  const response = await fetch("https://api.hyperliquid.xyz/info", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "clearinghouseState", user: vaultAddress }),
    signal: createTimeoutSignal(timeoutMs),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Hypurrscan vault scrape failed (${response.status}): ${text}`);
  }

  const payload = (await response.json()) as HypurrscanClearinghouseState;
  const positions = parseHypurrscanVaultPositions(payload);
  fs.writeFileSync(outputPath.replace(/\.md$/i, ".json"), JSON.stringify(payload, null, 2), "utf-8");
  return positions;
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
  const scrapeRetryCount = parsePositiveInt(process.env.HYPURRSCAN_SCRAPE_RETRY_COUNT, 6);
  const retryDelayMs = parsePositiveInt(process.env.HYPURRSCAN_RETRY_DELAY_MS, 1500);
  const scrapeRunner = options.scrapeRunner || runFirecrawlScrape;
  const vaultPositionRunner = options.vaultPositionRunner || runHypurrscanVaultPositions;
  const vaultAddress = extractHypurrscanVaultAddress(trader.hypurrscanUrl);

  let markdown = "";
  let positions: ParsedSignalPosition[] = [];
  let scrapeFailures = 0;
  let emptyResponses = 0;

  if (isHypurrscanVaultUrl(trader.hypurrscanUrl) && vaultAddress) {
    for (;;) {
      try {
        positions = await vaultPositionRunner(vaultAddress, outputPath);
        break;
      } catch (error) {
        if (scrapeFailures >= scrapeRetryCount || !isRetriableScrapeError(error)) {
          throw error;
        }
        scrapeFailures += 1;
        const retryAfterMs = getRetryAfterMs(error);
        await sleep(Math.max(retryDelayMs * scrapeFailures, retryAfterMs || 0));
      }
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
      const retryAfterMs = getRetryAfterMs(error);
      await sleep(Math.max(retryDelayMs * scrapeFailures, retryAfterMs || 0));
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

export function parseHypurrscanMarkdown(markdown: string): ParsedSignalPosition[] {
  return parsePerpsTable(markdown);
}
