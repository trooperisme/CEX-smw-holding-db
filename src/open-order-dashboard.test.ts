import assert from "node:assert/strict";
import test from "node:test";
import { buildOpenOrderDashboard } from "./open-order-dashboard";

test("keeps native asset IDs separate and calculates order deltas", () => {
  const previous = {
    fetchedAt: "2026-10-30T00:00:00.000Z", totalWallets: 1, successfulWallets: 1, failedWallets: 0, totalIndividualOrders: 2,
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
