import assert from "node:assert/strict";
import test from "node:test";
import { buildOpenOrderDashboard } from "./open-order-dashboard";

test("keeps native asset IDs separate and calculates order deltas", () => {
  const previous = {
    fetchedAt: "2026-10-30T00:00:00.000Z", source: "https://api.hyperliquid.xyz/info type=frontendOpenOrders dex=ALL_DEXS", totalWallets: 1, successfulWallets: 1, failedWallets: 0, totalIndividualOrders: 2,
    results: [{ traderName: "A", hypurrscanUrl: "https://hypurrscan.io/address/0x1#perps", walletAddress: "0x1", status: "success" as const, orders: [
      { coin: "HYPE", side: "B" as const, limitPx: "80", sz: "10", oid: 1 }, { coin: "@107", side: "B" as const, limitPx: "81", sz: "10", oid: 2 },
    ] }],
  };
  const current = {
    ...previous, fetchedAt: "2026-11-01T00:00:00.000Z", totalIndividualOrders: 2,
    results: [{ ...previous.results[0], orders: [
      { coin: "HYPE", side: "B" as const, limitPx: "80", sz: "10", oid: 1 }, { coin: "@107", side: "A" as const, limitPx: "90", sz: "10", oid: 3 },
    ] }],
  };
  const dashboard = buildOpenOrderDashboard(current, previous);
  assert.equal(dashboard.assets.length, 2);
  assert.equal(dashboard.assets.find((row) => row.asset === "HYPE")?.bidNotional, 800);
  assert.equal(dashboard.assets.find((row) => row.asset === "@107")?.askNotional, 900);
  assert.equal(dashboard.overview.addedOrders, 1);
  assert.equal(dashboard.overview.cancelledOrders, 1);
});

test("does not report legacy default-DEX orders as new all-DEX signals", () => {
  const wallet = { traderName: "Wanyewest", hypurrscanUrl: "https://hypurrscan.io/address/0x1#orders", walletAddress: "0x1", status: "success" as const };
  const previous = {
    fetchedAt: "2026-11-12T00:00:00.000Z", source: "https://api.hyperliquid.xyz/info type=openOrders",
    totalWallets: 1, successfulWallets: 1, failedWallets: 0, totalIndividualOrders: 0,
    results: [{ ...wallet, orders: [] }],
  };
  const current = {
    ...previous, fetchedAt: "2026-11-13T00:00:00.000Z",
    source: "https://api.hyperliquid.xyz/info type=frontendOpenOrders dex=ALL_DEXS",
    totalIndividualOrders: 1,
    results: [{ ...wallet, orders: [{ coin: "xyz:NVDA", side: "B" as const, limitPx: "100", sz: "5", oid: 42 }] }],
  };
  const dashboard = buildOpenOrderDashboard(current, previous);
  assert.equal(dashboard.snapshot.baselineReset, true);
  assert.equal(dashboard.snapshot.previousFetchedAt, null);
  assert.equal(dashboard.overview.addedOrders, 0);
  assert.equal(dashboard.assets[0]?.bidNotional, 500);
});
