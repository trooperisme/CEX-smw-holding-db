import { NativeOrder, NativeSnapshot, NativeWalletResult } from "./open-order-dashboard";
import { TrackedTrader } from "./types";

export type OpenOrderScanResult = NativeSnapshot & {
  startedAt: string;
  finishedAt: string;
};

type OpenOrderScanOptions = {
  traders: TrackedTrader[];
  concurrency?: number;
  fetcher?: typeof fetch;
  logger?: (line: string) => void;
};

const INFO_URL = "https://api.hyperliquid.xyz/info";

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function ordersUrl(sourceUrl: string, walletAddress: string): string {
  const normalized = String(sourceUrl || "").trim();
  return normalized ? normalized.replace(/#.*/, "#orders") : `https://hypurrscan.io/address/${walletAddress}#orders`;
}

async function fetchWalletOrders(
  trader: TrackedTrader,
  fetcher: typeof fetch,
): Promise<NativeWalletResult> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetcher(INFO_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "openOrders", user: trader.walletAddress }),
      });
      if (!response.ok) throw new Error(`Hyperliquid openOrders HTTP ${response.status}`);
      const orders = await response.json();
      if (!Array.isArray(orders)) throw new Error("Hyperliquid openOrders returned a non-array payload");
      return {
        traderName: trader.traderName,
        hypurrscanUrl: ordersUrl(trader.hypurrscanUrl, trader.walletAddress),
        walletAddress: trader.walletAddress.toLowerCase(),
        status: "success",
        orders: orders as NativeOrder[],
      };
    } catch (error) {
      lastError = error;
      if (attempt < 3) await sleep(350 * attempt);
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
  const results: NativeWalletResult[] = [];
  let index = 0;

  logger(`Native open-order scan starting for ${traders.length} tracked wallets`);
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(traders.length, 1)) }, async () => {
    for (;;) {
      const trader = traders[index++];
      if (!trader) return;
      const result = await fetchWalletOrders(trader, fetcher);
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
    source: "https://api.hyperliquid.xyz/info type=openOrders",
    registryPath: "durable tracked_traders",
    totalWallets: traders.length,
    successfulWallets,
    failedWallets,
    totalIndividualOrders,
    results,
  } as OpenOrderScanResult;
}
