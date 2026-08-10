import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ensureDirExists, resolveWorkspacePaths } from "./runtime-paths";
import {
  SpotTokenCategory,
  classifySpotToken,
  getSpotTokenFilterConfig,
  normalizeSpotTokenSymbol,
} from "./spot-token-filter";
import { loadTrackedTraders } from "./trader-registry";
import { ScanLogger, TrackedTrader } from "./types";

const execFileAsync = promisify(execFile);

export type SpotHolding = {
  token: string;
  valueUsd: number;
  valueText: string;
  filterCategory?: SpotTokenCategory;
};

export type TraderSpotResult = {
  traderName: string;
  walletAddress: string;
  spotUrl: string;
  holdings: SpotHolding[];
  totalFilteredUsd: number;
  error: string | null;
};

type FilteredOutSummary = Record<Exclude<SpotTokenCategory, "displayable">, number>;

export type SpotHoldingsScanSummary = {
  generatedAt: string;
  tradersScanned: number;
  tradersWithFilteredHoldings: number;
  failures: number;
  minUsd: number;
  cacheTtlHours: number;
  tokenFilter: {
    includeTokens: string[];
    relevantTokens: string[];
    stableTokens: string[];
    trashTokens: string[];
    filteredOut: FilteredOutSummary;
  };
  results: TraderSpotResult[];
  failedResults: Array<{
    traderName: string;
    walletAddress: string;
    spotUrl: string;
    error: string | null;
  }>;
};

type SpotScrapeRunner = (url: string, outputPath: string) => Promise<void>;

let nextSpotFirecrawlRequestAt = 0;
let spotFirecrawlThrottleTail = Promise.resolve();

type RunSpotHoldingsScanOptions = {
  cwd?: string;
  traders?: TrackedTrader[];
  logger?: ScanLogger;
  scrapeRunner?: SpotScrapeRunner;
};

function parsePositiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

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

function isRetriableSpotScrapeError(error: unknown): boolean {
  const message = String((error as Error)?.message || error || "");
  return (
    /Firecrawl spot scrape failed \((?:408|409|425|429|5\d\d)\)/i.test(message) ||
    /SCRAPE_ALL_ENGINES_FAILED/i.test(message) ||
    /Firecrawl returned empty spot HTML/i.test(message) ||
    /fetch failed|network|timeout|temporarily unavailable|ECONNRESET|ETIMEDOUT|EAI_AGAIN|AbortError/i.test(message)
  );
}

async function waitForSpotFirecrawlSlot(): Promise<void> {
  const minIntervalMs = parsePositiveInt(process.env.SPOT_HOLDING_FIRECRAWL_MIN_INTERVAL_MS, 6500);
  if (minIntervalMs <= 0) return;

  const previousTail = spotFirecrawlThrottleTail;
  let releaseTail = () => {};
  spotFirecrawlThrottleTail = new Promise<void>((resolve) => {
    releaseTail = resolve;
  });

  await previousTail;
  const now = Date.now();
  const waitMs = Math.max(0, nextSpotFirecrawlRequestAt - now);
  if (waitMs > 0) await sleep(waitMs);
  nextSpotFirecrawlRequestAt = Date.now() + minIntervalMs;
  releaseTail();
}

function shouldFetchHtml(filePath: string, forceRefetch: boolean, cacheTtlHours: number): boolean {
  if (forceRefetch || !fs.existsSync(filePath)) return true;
  const stat = fs.statSync(filePath);
  const cacheAgeMs = Date.now() - stat.mtimeMs;
  return cacheAgeMs > cacheTtlHours * 60 * 60 * 1000;
}

function decodeHtmlEntities(input: string): string {
  return String(input || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function parseUsdValue(input: string): number | null {
  const match = String(input || "")
    .replace(/,/g, "")
    .match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const value = Number(match[0]);
  return Number.isFinite(value) ? Math.abs(value) : null;
}

export function parseSpotHoldingsFromHtml(html: string): SpotHolding[] {
  const pattern = /font-weight-bold mb-1">([^<]+)<\/div><div[^>]*>([^<]+)<\/div>/g;
  const holdings: SpotHolding[] = [];
  const seen = new Set<string>();

  for (const match of html.matchAll(pattern)) {
    const token = decodeHtmlEntities(match[1]).trim();
    const valueText = decodeHtmlEntities(match[2]).trim();
    const valueUsd = parseUsdValue(valueText);
    if (!token || valueUsd === null) continue;

    const dedupeKey = `${token}::${valueText}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    holdings.push({ token, valueUsd, valueText });
  }

  return holdings;
}

async function runFirecrawlHttpSpotScrape(url: string, outputPath: string): Promise<void> {
  const apiKey = process.env.FIRECRAWL_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("FIRECRAWL_API_KEY is required for server-side spot scraping");
  }

  await waitForSpotFirecrawlSlot();

  const timeoutMs = parsePositiveInt(process.env.SPOT_HOLDING_FIRECRAWL_TIMEOUT_MS, 60000);
  const response = await fetch("https://api.firecrawl.dev/v2/scrape", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      url,
      formats: ["html"],
      waitFor: 5000,
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
    throw new Error(`Firecrawl spot scrape failed (${response.status}): ${text}`);
  }

  const payload = (await response.json()) as {
    success?: boolean;
    data?: { html?: string; markdown?: string };
    error?: string;
  };
  if (!payload.success) {
    throw new Error(payload.error || "Firecrawl returned an unsuccessful spot response");
  }

  const html = String(payload.data?.html || payload.data?.markdown || "").trim();
  if (!html) {
    throw new Error("Firecrawl returned empty spot HTML");
  }

  fs.writeFileSync(outputPath, html, "utf-8");
}

async function scrapeSpotHtml(url: string, outputPath: string): Promise<void> {
  if (process.env.FIRECRAWL_API_KEY?.trim()) {
    await runFirecrawlHttpSpotScrape(url, outputPath);
    return;
  }

  await execFileAsync("firecrawl", [
    "scrape",
    url,
    "--wait-for",
    "5000",
    "--format",
    "html",
    "-o",
    outputPath,
  ]);
}

async function scrapeSpotHtmlWithRetries(scrapeRunner: SpotScrapeRunner, url: string, outputPath: string): Promise<void> {
  const retryCount = parsePositiveInt(process.env.SPOT_HOLDING_SCRAPE_RETRY_COUNT, 4);
  const retryDelayMs = parsePositiveInt(process.env.SPOT_HOLDING_RETRY_DELAY_MS, 1500);

  let failures = 0;
  for (;;) {
    try {
      await scrapeRunner(url, outputPath);
      return;
    } catch (error) {
      if (failures >= retryCount || !isRetriableSpotScrapeError(error)) {
        throw error;
      }
      failures += 1;
      const retryAfterMs = getRetryAfterMs(error);
      await sleep(Math.max(retryDelayMs * failures, retryAfterMs || 0));
    }
  }
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function runWorker(): Promise<void> {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => runWorker());
  await Promise.all(workers);
  return results;
}

function toSpotUrl(walletAddress: string): string {
  return `https://hypurrscan.io/address/${walletAddress}#spot`;
}

function toCsv(rows: TraderSpotResult[]): string {
  const lines = ["trader_name,wallet_address,spot_url,token,value_usd,value_text"];

  for (const row of rows) {
    for (const holding of row.holdings) {
      const values = [
        row.traderName,
        row.walletAddress,
        row.spotUrl,
        holding.token,
        holding.valueUsd.toFixed(6),
        holding.valueText,
      ].map((value) => `"${String(value).replace(/"/g, '""')}"`);
      lines.push(values.join(","));
    }
  }

  return lines.join("\n");
}

export async function runSpotHoldingsScan(
  options: RunSpotHoldingsScanOptions = {},
): Promise<SpotHoldingsScanSummary> {
  const cwd = options.cwd || process.cwd();
  const logger = options.logger || ((line: string) => console.log(line));
  const paths = resolveWorkspacePaths(cwd);
  const traders = options.traders || loadTrackedTraders(cwd);
  const concurrency = Math.max(1, Math.floor(parsePositiveNumber(process.env.SPOT_HOLDING_CONCURRENCY, 4)));
  const minUsd = parsePositiveNumber(process.env.SPOT_HOLDING_MIN_USD, 11);
  const forceRefetch = String(process.env.SPOT_HOLDING_FORCE_REFETCH || "").trim() === "1";
  const cacheTtlHours = parsePositiveNumber(process.env.SPOT_HOLDING_CACHE_TTL_HOURS, 6);
  const filterConfig = getSpotTokenFilterConfig();
  const scrapeRunner = options.scrapeRunner || scrapeSpotHtml;

  const batchDir = path.join(paths.processedDataDir, "spot-holdings");
  const rawHtmlDir = path.join(batchDir, "raw-html");
  ensureDirExists(batchDir);
  ensureDirExists(rawHtmlDir);

  logger(
    `Scanning ${traders.length} traders with concurrency=${concurrency}, minUsd=${minUsd}, cacheTtlHours=${cacheTtlHours}, include=${Array.from(filterConfig.includeTokens).join("|") || "all non-stable"}`,
  );

  const filteredOut: FilteredOutSummary = {
    stable: 0,
    trash: 0,
    unrelated: 0,
  };

  const results = await mapLimit(traders, concurrency, async (trader, index) => {
    const spotUrl = toSpotUrl(trader.walletAddress);
    const htmlPath = path.join(rawHtmlDir, `${trader.walletAddress}.html`);

    try {
      logger(`[${index + 1}/${traders.length}] ${trader.traderName} -> ${spotUrl}`);
      if (shouldFetchHtml(htmlPath, forceRefetch, cacheTtlHours)) {
        await scrapeSpotHtmlWithRetries(scrapeRunner, spotUrl, htmlPath);
      }
      const html = fs.readFileSync(htmlPath, "utf-8");
      const holdings = parseSpotHoldingsFromHtml(html)
        .filter((holding) => holding.valueUsd >= minUsd)
        .map((holding) => ({
          ...holding,
          token: normalizeSpotTokenSymbol(holding.token),
          filterCategory: classifySpotToken(holding.token, filterConfig),
        }))
        .filter((holding) => {
          if (holding.filterCategory === "displayable") return true;
          filteredOut[holding.filterCategory] += 1;
          return false;
        })
        .sort((a, b) => b.valueUsd - a.valueUsd);

      const totalFilteredUsd = holdings.reduce((sum, holding) => sum + holding.valueUsd, 0);
      logger(
        `  -> ${holdings.length} filtered holdings, ${totalFilteredUsd.toLocaleString("en-US", { maximumFractionDigits: 2 })} USD`,
      );

      return {
        traderName: trader.traderName,
        walletAddress: trader.walletAddress,
        spotUrl,
        holdings,
        totalFilteredUsd,
        error: null,
      } satisfies TraderSpotResult;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger(`  -> failed: ${message}`);
      return {
        traderName: trader.traderName,
        walletAddress: trader.walletAddress,
        spotUrl,
        holdings: [],
        totalFilteredUsd: 0,
        error: message,
      } satisfies TraderSpotResult;
    }
  });

  const filteredResults = results
    .filter((row) => row.holdings.length > 0)
    .sort((a, b) => b.totalFilteredUsd - a.totalFilteredUsd);

  const failedResults = results
    .filter((row) => row.error)
    .map((row) => ({
      traderName: row.traderName,
      walletAddress: row.walletAddress,
      spotUrl: row.spotUrl,
      error: row.error,
    }));

  const summary: SpotHoldingsScanSummary = {
    generatedAt: new Date().toISOString(),
    tradersScanned: traders.length,
    tradersWithFilteredHoldings: filteredResults.length,
    failures: failedResults.length,
    minUsd,
    cacheTtlHours,
    tokenFilter: {
      includeTokens: Array.from(filterConfig.includeTokens),
      relevantTokens: Array.from(filterConfig.includeTokens),
      stableTokens: Array.from(filterConfig.stableTokens),
      trashTokens: Array.from(filterConfig.trashTokens),
      filteredOut,
    },
    results: filteredResults,
    failedResults,
  };

  const outputJson = path.join(batchDir, "spot-holdings.json");
  const outputCsv = path.join(batchDir, "spot-holdings.csv");
  fs.writeFileSync(outputJson, JSON.stringify(summary, null, 2));
  fs.writeFileSync(outputCsv, toCsv(filteredResults));

  logger(
    JSON.stringify(
      {
        outputJson,
        outputCsv,
        tradersScanned: traders.length,
        tradersWithFilteredHoldings: filteredResults.length,
        filteredOut,
        failures: failedResults.length,
      },
      null,
      2,
    ),
  );

  return summary;
}

if (require.main === module) {
  runSpotHoldingsScan().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
}
