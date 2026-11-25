import fs from "node:fs";
import path from "node:path";
import { ensureDirExists, resolveWorkspacePaths } from "./runtime-paths";

type TrackedWallet = {
  traderName: string;
  hypurrscanUrl: string;
  walletAddress: string;
};

type FirecrawlOrderGroup = {
  token: string;
  side: string;
  priceRaw: string;
  valueRaw: string;
  sizeRaw: string;
  reportedOrderCount: number;
  valueUsdApprox: number | null;
  rawRow: string;
};

type ScrapeResult = {
  traderName: string;
  walletAddress: string;
  hypurrscanUrl: string;
  status: "success" | "failed";
  scrapeId?: string;
  statusCode?: number;
  creditsUsed?: number;
  markdown: string;
  orderGroups: FirecrawlOrderGroup[];
  error?: string;
};

const FIRECRAWL_URL = "https://api.firecrawl.dev/v2/scrape";
let firecrawlRequestTail = Promise.resolve();
let nextFirecrawlRequestAt = 0;

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = "";
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];
    if (char === '"') {
      if (quoted && next === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      values.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }

  values.push(current.trim());
  return values;
}

function loadTrackedWallets(filePath: string): TrackedWallet[] {
  const lines = fs
    .readFileSync(filePath, "utf-8")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter((line) => line.trim());
  if (lines.length <= 1) return [];

  const headers = parseCsvLine(lines[0]).map((value) => value.toLowerCase());
  const traderIndex = headers.indexOf("trader");
  const urlIndex = headers.indexOf("hypurrscan");
  if (traderIndex < 0 || urlIndex < 0) {
    throw new Error(`Invalid trader CSV headers in ${filePath}`);
  }

  const wallets = new Map<string, TrackedWallet>();
  for (const line of lines.slice(1)) {
    const values = parseCsvLine(line);
    const traderName = values[traderIndex] || "";
    const originalUrl = values[urlIndex] || "";
    const match = originalUrl.match(/\/address\/(0x[a-fA-F0-9]{40})(?:[/?#]|$)/);
    if (!traderName || !originalUrl || !match) continue;

    const walletAddress = match[1].toLowerCase();
    wallets.set(walletAddress, {
      traderName,
      walletAddress,
      hypurrscanUrl: originalUrl.replace(/#.*$/, "#orders"),
    });
  }

  return Array.from(wallets.values()).sort((a, b) =>
    a.traderName.localeCompare(b.traderName, undefined, { sensitivity: "base" }),
  );
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForFirecrawlRequestSlot(): Promise<void> {
  const minimumIntervalMs = parsePositiveInt(process.env.FIRECRAWL_OPEN_ORDERS_MIN_INTERVAL_MS, 1100);
  const previous = firecrawlRequestTail;
  let release!: () => void;
  firecrawlRequestTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  const waitMs = Math.max(0, nextFirecrawlRequestAt - Date.now());
  if (waitMs > 0) await sleep(waitMs);
  nextFirecrawlRequestAt = Date.now() + minimumIntervalMs;
  release();
}

function cleanMarkdownCell(value: string): string {
  return String(value || "")
    .replace(/!\[[^\]]*]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseApproxUsd(value: string): number | null {
  const match = cleanMarkdownCell(value).match(/([\d,.]+)\s*([KMB])?\s*\$/i);
  if (!match) return null;
  const base = Number(match[1].replace(/,/g, ""));
  if (!Number.isFinite(base)) return null;
  const multiplier = { K: 1e3, M: 1e6, B: 1e9 }[String(match[2] || "").toUpperCase() as "K" | "M" | "B"] || 1;
  return base * multiplier;
}

function parseOrderCount(tokenCell: string): { token: string; count: number } {
  const countMatch = tokenCell.match(/\((\d+)\s+orders?\)/i);
  const count = countMatch ? Number(countMatch[1]) : 1;
  const token = cleanMarkdownCell(tokenCell)
    .replace(/\s*\(\d+\s+orders?\)\s*/i, "")
    .replace(/-USD$/i, "")
    .trim();
  return { token, count: Number.isFinite(count) && count > 0 ? count : 1 };
}

function parseOrderGroups(markdown: string): FirecrawlOrderGroup[] {
  const lines = markdown.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => {
    const normalized = line.toLowerCase();
    return normalized.includes("| token |") && normalized.includes("| side |") && normalized.includes("| price |") && normalized.includes("| value |") && normalized.includes("| size |");
  });
  if (headerIndex < 0) return [];

  const groups: FirecrawlOrderGroup[] = [];
  for (const rawLine of lines.slice(headerIndex + 2)) {
    const line = rawLine.trim();
    if (!line.startsWith("|")) break;
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 5) continue;
    const parsedToken = parseOrderCount(cells[0]);
    if (!parsedToken.token) continue;
    groups.push({
      token: parsedToken.token,
      side: cleanMarkdownCell(cells[1]).toUpperCase(),
      priceRaw: cleanMarkdownCell(cells[2]),
      valueRaw: cleanMarkdownCell(cells[3]),
      sizeRaw: cleanMarkdownCell(cells[4]),
      reportedOrderCount: parsedToken.count,
      valueUsdApprox: parseApproxUsd(cells[3]),
      rawRow: line,
    });
  }
  return groups;
}

function isRetriable(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

async function scrapeWallet(wallet: TrackedWallet, retries: number, timeoutMs: number): Promise<ScrapeResult> {
  const apiKey = process.env.FIRECRAWL_API_KEY?.trim();
  if (!apiKey) throw new Error("FIRECRAWL_API_KEY is required");

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      await waitForFirecrawlRequestSlot();
      const response = await fetch(FIRECRAWL_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          url: wallet.hypurrscanUrl,
          formats: ["markdown"],
          maxAge: 0,
          storeInCache: false,
          proxy: "auto",
          removeBase64Images: true,
          blockAds: true,
        }),
        signal: controller.signal,
      });
      const body = await response.text();
      if (!response.ok) {
        if (attempt < retries && isRetriable(response.status)) {
          await sleep(1000 * (attempt + 1));
          continue;
        }
        throw new Error(`Firecrawl HTTP ${response.status}: ${body.slice(0, 500)}`);
      }

      const payload = JSON.parse(body) as {
        success?: boolean;
        data?: { markdown?: string; metadata?: { scrapeId?: string; statusCode?: number; creditsUsed?: number } };
        error?: string;
      };
      const markdown = String(payload.data?.markdown || "").trim();
      if (!payload.success || !markdown) {
        if (attempt < retries) {
          await sleep(1000 * (attempt + 1));
          continue;
        }
        throw new Error(payload.error || "Firecrawl returned empty markdown");
      }

      return {
        traderName: wallet.traderName,
        walletAddress: wallet.walletAddress,
        hypurrscanUrl: wallet.hypurrscanUrl,
        status: "success",
        scrapeId: payload.data?.metadata?.scrapeId,
        statusCode: payload.data?.metadata?.statusCode,
        creditsUsed: payload.data?.metadata?.creditsUsed,
        markdown,
        orderGroups: parseOrderGroups(markdown),
      };
    } catch (error) {
      if (attempt >= retries) {
        return {
          traderName: wallet.traderName,
          walletAddress: wallet.walletAddress,
          hypurrscanUrl: wallet.hypurrscanUrl,
          status: "failed",
          markdown: "",
          orderGroups: [],
          error: (error as Error)?.message || String(error),
        };
      }
      await sleep(1000 * (attempt + 1));
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error(`Unreachable scrape state for ${wallet.walletAddress}`);
}

function formatUsd(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `$${value.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

function escapeMarkdownTableCell(value: unknown): string {
  return String(value ?? "").replace(/\|/g, "\\|");
}

function formatAge(timestamp: string): string {
  const date = new Date(timestamp);
  return Number.isFinite(date.getTime()) ? date.toISOString() : timestamp;
}

function buildReport(args: {
  fetchedAt: string;
  registryPath: string;
  wallets: TrackedWallet[];
  results: ScrapeResult[];
}): string {
  const successful = args.results.filter((result) => result.status === "success");
  const failed = args.results.filter((result) => result.status === "failed");
  const groups = successful.flatMap((result) => result.orderGroups.map((group) => ({ ...group, traderName: result.traderName, walletAddress: result.walletAddress })));
  const walletsWithOrders = successful.filter((result) => result.orderGroups.length > 0);
  const reportedOrders = groups.reduce((sum, group) => sum + group.reportedOrderCount, 0);
  const approximateValue = groups.reduce((sum, group) => sum + (group.valueUsdApprox || 0), 0);

  const byWallet = new Map<string, typeof groups>();
  for (const group of groups) byWallet.set(group.walletAddress, [...(byWallet.get(group.walletAddress) || []), group]);
  const walletRows = Array.from(byWallet.values())
    .map((walletGroups) => ({
      traderName: walletGroups[0].traderName,
      walletAddress: walletGroups[0].walletAddress,
      groups: walletGroups.length,
      reportedOrders: walletGroups.reduce((sum, group) => sum + group.reportedOrderCount, 0),
      approximateValue: walletGroups.reduce((sum, group) => sum + (group.valueUsdApprox || 0), 0),
      buy: walletGroups.filter((group) => group.side === "BUY" || group.side === "BID").reduce((sum, group) => sum + group.reportedOrderCount, 0),
      sell: walletGroups.filter((group) => group.side === "SELL" || group.side === "ASK").reduce((sum, group) => sum + group.reportedOrderCount, 0),
    }))
    .sort((a, b) => b.reportedOrders - a.reportedOrders);

  const byToken = new Map<string, typeof groups>();
  for (const group of groups) byToken.set(group.token, [...(byToken.get(group.token) || []), group]);
  const tokenRows = Array.from(byToken.values())
    .map((tokenGroups) => ({
      token: tokenGroups[0].token,
      wallets: new Set(tokenGroups.map((group) => group.walletAddress)).size,
      reportedOrders: tokenGroups.reduce((sum, group) => sum + group.reportedOrderCount, 0),
      approximateValue: tokenGroups.reduce((sum, group) => sum + (group.valueUsdApprox || 0), 0),
      buy: tokenGroups.filter((group) => group.side === "BUY" || group.side === "BID").reduce((sum, group) => sum + group.reportedOrderCount, 0),
      sell: tokenGroups.filter((group) => group.side === "SELL" || group.side === "ASK").reduce((sum, group) => sum + group.reportedOrderCount, 0),
    }))
    .sort((a, b) => b.reportedOrders - a.reportedOrders);

  const lines = [
    "# Firecrawl Hypurrscan Open Orders",
    "",
    `- Fetched at: ${formatAge(args.fetchedAt)}`,
    `- Registry: \`${args.registryPath}\``,
    "- Source: Firecrawl v2 scrape of each Hypurrscan `#orders` URL",
    `- Coverage: ${successful.length}/${args.wallets.length} wallets scraped successfully; ${failed.length} failed`,
    `- Wallets with visible order groups: ${walletsWithOrders.length}/${successful.length}`,
    `- Reported orders represented by Firecrawl groups: ${reportedOrders.toLocaleString()}`,
    `- Approximate displayed value across groups: ${formatUsd(approximateValue)}`,
    "",
    "> Important: Hypurrscan’s Firecrawl Markdown aggregates ladder orders into rows such as `100 orders`, so this report preserves grouped visible orders. It is not an order-ID/event-lifecycle dataset.",
    "",
    "## Initial insight",
    "",
    walletRows.length === 0
      ? "No open-order groups were visible in the successful Firecrawl responses."
      : `Open-order activity is highly concentrated: the top wallet contributes ${walletRows[0].reportedOrders.toLocaleString()} of ${reportedOrders.toLocaleString()} reported orders (${reportedOrders ? ((walletRows[0].reportedOrders / reportedOrders) * 100).toFixed(1) : "0.0"}%). Treat this as an order-placement style signal, not a directional conclusion.`,
    "",
    "## Wallet summary",
    "",
    "| Trader | Wallet | Groups | Reported orders | Approx. value | Buy groups/orders | Sell groups/orders |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: |",
    ...walletRows.map((row) => `| ${escapeMarkdownTableCell(row.traderName)} | \`${row.walletAddress}\` | ${row.groups} | ${row.reportedOrders.toLocaleString()} | ${formatUsd(row.approximateValue)} | ${row.buy.toLocaleString()} | ${row.sell.toLocaleString()} |`),
    "",
    "## Asset summary",
    "",
    "| Asset | Wallets | Reported orders | Approx. value | Buy orders | Sell orders |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    ...tokenRows.map((row) => `| ${row.token} | ${row.wallets} | ${row.reportedOrders.toLocaleString()} | ${formatUsd(row.approximateValue)} | ${row.buy.toLocaleString()} | ${row.sell.toLocaleString()} |`),
    "",
    "## Failed wallets",
    "",
    failed.length === 0 ? "None." : failed.map((result) => `- ${result.traderName} — ${result.walletAddress}: ${result.error}`).join("\n"),
    "",
    "## Provenance",
    "",
    "The companion JSON retains each Firecrawl Markdown response and its scrape metadata. The CSV contains one row per visible aggregated order group.",
    "",
  ];
  return lines.join("\n");
}

function buildCsv(results: ScrapeResult[]): string {
  const headers = ["trader", "wallet_address", "hypurrscan_url", "token", "side", "price", "value", "size", "reported_order_count", "value_usd_approx", "raw_row"];
  const quote = (value: unknown): string => `"${String(value ?? "").replace(/"/g, '""')}"`;
  const rows = results.flatMap((result) => result.orderGroups.map((group) => [
    result.traderName,
    result.walletAddress,
    result.hypurrscanUrl,
    group.token,
    group.side,
    group.priceRaw,
    group.valueRaw,
    group.sizeRaw,
    group.reportedOrderCount,
    group.valueUsdApprox,
    group.rawRow,
  ].map(quote).join(",")));
  return `${headers.map(quote).join(",")}\n${rows.join("\n")}\n`;
}

async function main(): Promise<void> {
  const cwd = process.cwd();
  const paths = resolveWorkspacePaths(cwd);
  const wallets = loadTrackedWallets(paths.traderSignalsCsvFile);
  const resumePath = process.env.FIRECRAWL_OPEN_ORDERS_RESUME_JSON?.trim();
  let resumedResults: ScrapeResult[] = [];
  if (resumePath && fs.existsSync(resumePath)) {
    const previous = JSON.parse(fs.readFileSync(resumePath, "utf-8")) as { results?: ScrapeResult[] };
    resumedResults = (previous.results || []).filter((result) => result.status === "success");
  }
  const resumedAddresses = new Set(resumedResults.map((result) => result.walletAddress));
  const walletsToFetch = wallets.filter((wallet) => !resumedAddresses.has(wallet.walletAddress));
  const concurrency = parsePositiveInt(process.env.FIRECRAWL_OPEN_ORDERS_CONCURRENCY, 4);
  const retries = parsePositiveInt(process.env.FIRECRAWL_OPEN_ORDERS_RETRIES, 3);
  const timeoutMs = parsePositiveInt(process.env.FIRECRAWL_OPEN_ORDERS_TIMEOUT_MS, 90000);
  const results: ScrapeResult[] = [...resumedResults];
  let cursor = 0;

  const workers = Array.from({ length: Math.min(concurrency, Math.max(1, walletsToFetch.length)) }, async () => {
    while (cursor < walletsToFetch.length) {
      const wallet = walletsToFetch[cursor++];
      console.log(`Firecrawl open orders: ${wallet.traderName} ${wallet.walletAddress}`);
      results.push(await scrapeWallet(wallet, retries, timeoutMs));
    }
  });
  await Promise.all(workers);
  results.sort((a, b) => a.traderName.localeCompare(b.traderName, undefined, { sensitivity: "base" }));

  const fetchedAt = new Date().toISOString();
  const runId = fetchedAt.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const outputDir = path.join(paths.processedDataDir, "open-orders", runId);
  ensureDirExists(outputDir);
  const report = buildReport({ fetchedAt, registryPath: paths.traderSignalsCsvFile, wallets, results });
  const payload = {
    fetchedAt,
    source: FIRECRAWL_URL,
    registryPath: paths.traderSignalsCsvFile,
    totalRegistryRows: wallets.length,
    successfulWallets: results.filter((result) => result.status === "success").length,
    failedWallets: results.filter((result) => result.status === "failed").length,
    walletsWithVisibleOrderGroups: results.filter((result) => result.orderGroups.length > 0).length,
    visibleOrderGroups: results.reduce((sum, result) => sum + result.orderGroups.length, 0),
    reportedOrders: results.reduce((sum, result) => sum + result.orderGroups.reduce((inner, group) => inner + group.reportedOrderCount, 0), 0),
    results,
  };
  fs.writeFileSync(path.join(outputDir, "open-orders.json"), JSON.stringify(payload, null, 2));
  fs.writeFileSync(path.join(outputDir, "open-orders.csv"), buildCsv(results));
  fs.writeFileSync(path.join(outputDir, "report.md"), report);
  console.log(JSON.stringify({ outputDir, fetchedAt, wallets: wallets.length, successful: payload.successfulWallets, failed: payload.failedWallets, visibleOrderGroups: payload.visibleOrderGroups, reportedOrders: payload.reportedOrders }, null, 2));
}

void main().catch((error) => {
  console.error("Firecrawl open-orders scan failed:", (error as Error)?.message || String(error));
  process.exitCode = 1;
});
