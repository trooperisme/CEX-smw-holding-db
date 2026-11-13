import { NativeOrder, NativeSnapshot, NativeWalletResult } from "./open-order-dashboard";
import { TrackedTrader } from "./types";

export type OpenOrderScanResult = NativeSnapshot & {
  startedAt: string;
  finishedAt: string;
};

type OpenOrderScanOptions = {
  traders: TrackedTrader[];
  concurrency?: number;
  minIntervalMs?: number;
  fetcher?: typeof fetch;
  logger?: (line: string) => void;
};

const INFO_URL = "https://api.hyperliquid.xyz/info";
const DEFAULT_MIN_INTERVAL_MS = 1500;
let nextRequestAt = 0;
let requestTail = Promise.resolve();

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForRequestSlot(minIntervalMs: number): Promise<void> {
  if (minIntervalMs <= 0) return;
  const previous = requestTail;
  let release = () => {};
  requestTail = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    await sleep(Math.max(0, nextRequestAt - Date.now()));
    nextRequestAt = Date.now() + minIntervalMs;
  } finally {
    release();
  }
}

function retryAfterMs(response: Response): number {
  const value = response.headers.get("retry-after");
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
}

function ordersUrl(sourceUrl: string, walletAddress: string): string {
  const normalized = String(sourceUrl || "").trim();
  return normalized ? normalized.replace(/#.*/, "#orders") : `https://hypurrscan.io/address/${walletAddress}#orders`;
}

async function fetchWalletOrders(
  trader: TrackedTrader,
  fetcher: typeof fetch,
  minIntervalMs: number,
): Promise<NativeWalletResult> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await waitForRequestSlot(minIntervalMs);
      const response = await fetcher(INFO_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // Match Hypurrscan's Orders tab: include orders from every Hyperliquid DEX,
        // including HIP-3 markets such as xyz:NVDA and io:ANTH.
        body: JSON.stringify({ type: "frontendOpenOrders", user: trader.walletAddress, dex: "ALL_DEXS" }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) {
        const error = new Error(`Hyperliquid frontendOpenOrders HTTP ${response.status}`) as Error & { retryAfterMs?: number };
        error.retryAfterMs = response.status === 429 ? Math.max(5000, retryAfterMs(response)) : 0;
        throw error;
      }
      const orders = await response.json();
      if (!Array.isArray(orders)) throw new Error("Hyperliquid frontendOpenOrders returned a non-array payload");
      return {
        traderName: trader.traderName,
        hypurrscanUrl: ordersUrl(trader.hypurrscanUrl, trader.walletAddress),
        walletAddress: trader.walletAddress.toLowerCase(),
        status: "success",
        orders: orders as NativeOrder[],
      };
    } catch (error) {
      lastError = error;
      if (attempt < 3) await sleep(Math.max(350 * attempt, (error as { retryAfterMs?: number })?.retryAfterMs || 0));
    }
  }
  return {
    traderName: trader.traderName,
    hypurrscanUrl: ordersUrl(trader.hypurrscanUrl, trader.walletAddress),
    walletAddress: trader.walletAddress.toLowerCase(),
    status: "failed",
    orders: [],
    error: (lastError as Error)?.message || String(lastError),
  };
}

export async function runOpenOrderScan(options: OpenOrderScanOptions): Promise<OpenOrderScanResult> {
  const startedAt = new Date().toISOString();
  const logger = options.logger || (() => undefined);
  const fetcher = options.fetcher || fetch;
  const traders = options.traders.filter((trader) => trader.isActive);
  const concurrency = options.concurrency || positiveInteger(process.env.HYPERLIQUID_OPEN_ORDERS_CONCURRENCY, 6);
  const minIntervalMs = options.minIntervalMs ?? positiveInteger(process.env.HYPERLIQUID_OPEN_ORDERS_MIN_INTERVAL_MS, DEFAULT_MIN_INTERVAL_MS);
  const results: NativeWalletResult[] = [];
  let index = 0;

  logger(`Native open-order scan starting for ${traders.length} tracked wallets; request interval=${minIntervalMs}ms`);
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(traders.length, 1)) }, async () => {
    for (;;) {
      const trader = traders[index++];
      if (!trader) return;
      const result = await fetchWalletOrders(trader, fetcher, minIntervalMs);
      results.push(result);
      if (result.status === "failed") logger(`Open orders failed for ${trader.traderName}: ${(result as any).error || "unknown error"}`);
    }
  }));

  results.sort((left, right) => left.traderName.localeCompare(right.traderName));
  const successfulWallets = results.filter((result) => result.status === "success").length;
  const failedWallets = results.length - successfulWallets;
  const totalIndividualOrders = results.reduce((total, result) => total + result.orders.length, 0);
  const finishedAt = new Date().toISOString();
  logger(`Native open-order scan complete: ${successfulWallets}/${traders.length} wallets, ${totalIndividualOrders} orders`);
  return {
    startedAt,
    finishedAt,
    fetchedAt: finishedAt,
    source: "https://api.hyperliquid.xyz/info type=frontendOpenOrders dex=ALL_DEXS",
    registryPath: "durable tracked_traders",
    totalWallets: traders.length,
    successfulWallets,
    failedWallets,
    totalIndividualOrders,
    results,
  } as OpenOrderScanResult;
}
