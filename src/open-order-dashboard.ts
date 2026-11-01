import fs from "node:fs";
import path from "node:path";

export type NativeOrder = {
  coin: string;
  side: "A" | "B";
  limitPx: string;
  sz: string;
  oid: number | string;
  timestamp?: number;
};

export type NativeWalletResult = {
  traderName: string;
  hypurrscanUrl: string;
  walletAddress: string;
  status: "success" | "failed";
  orders: NativeOrder[];
  error?: string;
};

export type NativeSnapshot = {
  fetchedAt: string;
  source?: string;
  registryPath?: string;
  totalWallets: number;
  successfulWallets: number;
  failedWallets: number;
  totalIndividualOrders: number;
  results: NativeWalletResult[];
};

export type FlatOrder = {
  asset: string;
  side: "bid" | "ask";
  price: number;
  size: number;
  notional: number;
  oid: string;
  traderName: string;
  walletAddress: string;
  sourceUrl: string;
};

const DISPLAY_NAMES: Record<string, string> = {
  "@107": "HYPE Spot",
  "@334": "KNTQ",
  "@700": "DRV",
};

function finite(value: unknown): number {
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function toOrderUrl(url: string): string {
  return String(url || "").replace(/#.*/, "#orders");
}

function flatten(snapshot: NativeSnapshot): FlatOrder[] {
  return (snapshot.results || []).flatMap((wallet) =>
    (wallet.orders || []).map((order) => {
      const price = finite(order.limitPx);
      const size = finite(order.sz);
      return {
        asset: String(order.coin || "unknown"),
        side: order.side === "B" ? "bid" : "ask",
        price,
        size,
        notional: price * size,
        oid: String(order.oid),
        traderName: wallet.traderName,
        walletAddress: wallet.walletAddress,
        sourceUrl: toOrderUrl(wallet.hypurrscanUrl),
      };
    }),
  );
}

function orderKey(order: FlatOrder): string {
  return [order.walletAddress.toLowerCase(), order.asset, order.side, order.oid].join("|");
}

function listSnapshotFiles(dataDir: string): string[] {
  if (!fs.existsSync(dataDir)) return [];
  return fs
    .readdirSync(dataDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(dataDir, entry.name, "native-open-orders.json"))
    .filter((file) => fs.existsSync(file))
    .sort();
}

function readSnapshot(file: string): NativeSnapshot {
  return JSON.parse(fs.readFileSync(file, "utf-8")) as NativeSnapshot;
}

function summarizeWallets(orders: FlatOrder[]) {
  const grouped = new Map<string, { traderName: string; walletAddress: string; sourceUrl: string; side: string; orders: number; notional: number; minPrice: number; maxPrice: number }>();
  for (const order of orders) {
    const key = `${order.walletAddress}|${order.side}`;
    const value = grouped.get(key) || {
      traderName: order.traderName,
      walletAddress: order.walletAddress,
      sourceUrl: order.sourceUrl,
      side: order.side,
      orders: 0,
      notional: 0,
      minPrice: order.price,
      maxPrice: order.price,
    };
    value.orders += 1;
    value.notional += order.notional;
    value.minPrice = Math.min(value.minPrice, order.price);
    value.maxPrice = Math.max(value.maxPrice, order.price);
    grouped.set(key, value);
  }
  return Array.from(grouped.values())
    .map((row) => ({ ...row, notional: round(row.notional) }))
    .sort((left, right) => right.notional - left.notional);
}

export type OpenOrderDashboardPayload = ReturnType<typeof buildOpenOrderDashboard>;

export function buildOpenOrderDashboard(current: NativeSnapshot, previous: NativeSnapshot | null) {
  const orders = flatten(current);
  const previousOrders = previous ? flatten(previous) : [];
  const previousByKey = new Map(previousOrders.map((order) => [orderKey(order), order]));
  const currentByKey = new Map(orders.map((order) => [orderKey(order), order]));
  const assets = new Map<string, FlatOrder[]>();
  for (const order of orders) assets.set(order.asset, [...(assets.get(order.asset) || []), order]);

  const assetRows = Array.from(assets.entries()).map(([asset, assetOrders]) => {
    const previousAssetOrders = previousOrders.filter((order) => order.asset === asset);
    const bids = assetOrders.filter((order) => order.side === "bid");
    const asks = assetOrders.filter((order) => order.side === "ask");
    const previousBids = previousAssetOrders.filter((order) => order.side === "bid");
    const previousAsks = previousAssetOrders.filter((order) => order.side === "ask");
    const bidNotional = bids.reduce((sum, order) => sum + order.notional, 0);
    const askNotional = asks.reduce((sum, order) => sum + order.notional, 0);
    const previousBidNotional = previousBids.reduce((sum, order) => sum + order.notional, 0);
    const previousAskNotional = previousAsks.reduce((sum, order) => sum + order.notional, 0);
    const assetCurrentKeys = new Set(assetOrders.map(orderKey));
    const assetPreviousKeys = new Set(previousAssetOrders.map(orderKey));
    const added = assetOrders.filter((order) => !previousByKey.has(orderKey(order)));
    const cancelled = previousAssetOrders.filter((order) => !currentByKey.has(orderKey(order)));
    return {
      asset,
      displayName: DISPLAY_NAMES[asset] || asset,
      orders: assetOrders.length,
      wallets: new Set(assetOrders.map((order) => order.walletAddress.toLowerCase())).size,
      bidNotional: round(bidNotional),
      askNotional: round(askNotional),
      bidMin: bids.length ? Math.min(...bids.map((order) => order.price)) : null,
      bidMax: bids.length ? Math.max(...bids.map((order) => order.price)) : null,
      askMin: asks.length ? Math.min(...asks.map((order) => order.price)) : null,
      askMax: asks.length ? Math.max(...asks.map((order) => order.price)) : null,
      deltaBid: round(bidNotional - previousBidNotional),
      deltaAsk: round(askNotional - previousAskNotional),
      addedNotional: round(added.reduce((sum, order) => sum + order.notional, 0)),
      cancelledNotional: round(cancelled.reduce((sum, order) => sum + order.notional, 0)),
      addedOrders: added.length,
      cancelledOrders: cancelled.length,
      changeScore: Math.abs(bidNotional - previousBidNotional) + Math.abs(askNotional - previousAskNotional),
      _currentKeys: assetCurrentKeys,
      _previousKeys: assetPreviousKeys,
    };
  });

  const totalBid = orders.filter((order) => order.side === "bid").reduce((sum, order) => sum + order.notional, 0);
  const totalAsk = orders.filter((order) => order.side === "ask").reduce((sum, order) => sum + order.notional, 0);
  const added = orders.filter((order) => !previousByKey.has(orderKey(order)));
  const cancelled = previousOrders.filter((order) => !currentByKey.has(orderKey(order)));

  return {
    snapshot: {
      fetchedAt: current.fetchedAt,
      status: current.failedWallets ? "partial" : "available",
      totalWallets: current.totalWallets,
      successfulWallets: current.successfulWallets,
      failedWallets: current.failedWallets,
      totalOrders: current.totalIndividualOrders,
      previousFetchedAt: previous?.fetchedAt || null,
      source: "Hyperliquid native openOrders",
    },
    overview: {
      bidNotional: round(totalBid),
      askNotional: round(totalAsk),
      addedOrders: added.length,
      cancelledOrders: cancelled.length,
      addedNotional: round(added.reduce((sum, order) => sum + order.notional, 0)),
      cancelledNotional: round(cancelled.reduce((sum, order) => sum + order.notional, 0)),
    },
    assets: assetRows
      .map(({ _currentKeys, _previousKeys, ...row }) => row)
      .sort((left, right) => right.changeScore - left.changeScore),
    details: Object.fromEntries(
      Array.from(assets.entries()).map(([asset, assetOrders]) => {
        const asks = assetOrders.filter((order) => order.side === "ask");
        const bids = assetOrders.filter((order) => order.side === "bid");
        return [asset, {
          asset,
          displayName: DISPLAY_NAMES[asset] || asset,
          bids: bids.sort((left, right) => right.price - left.price),
          asks: asks.sort((left, right) => left.price - right.price),
          wallets: summarizeWallets(assetOrders),
        }];
      }),
    ),
  };
}

export function loadOpenOrderDashboard(cwd: string) {
  const dataDir = path.join(cwd, "data", "wallet-scraper", "processed", "native-open-orders");
  const files = listSnapshotFiles(dataDir);
  if (!files.length) return null;
  const current = readSnapshot(files[files.length - 1]);
  const previous = files.length > 1 ? readSnapshot(files[files.length - 2]) : null;
  return buildOpenOrderDashboard(current, previous);
}
