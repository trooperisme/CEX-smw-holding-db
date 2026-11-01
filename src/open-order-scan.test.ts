import assert from "node:assert/strict";
import test from "node:test";
import { runOpenOrderScan } from "./open-order-scan";

test("native open-order scan records complete wallet coverage and preserves empty orders", async () => {
  const traders = [
    { traderName: "first", hypurrscanUrl: "https://hypurrscan.io/address/0x0000000000000000000000000000000000000001#perps", walletAddress: "0x0000000000000000000000000000000000000001", isActive: true },
    { traderName: "second", hypurrscanUrl: "https://hypurrscan.io/address/0x0000000000000000000000000000000000000002#perps", walletAddress: "0x0000000000000000000000000000000000000002", isActive: true },
  ];
  const calls: string[] = [];
  const result = await runOpenOrderScan({
    traders,
    concurrency: 1,
    fetcher: async (_url, init) => {
      const user = JSON.parse(String(init?.body)).user;
      calls.push(user);
      return new Response(user.endsWith("1") ? JSON.stringify([{ coin: "HYPE", side: "B", limitPx: "80", sz: "10", oid: 1 }]) : "[]", { status: 200 });
    },
  });
  assert.equal(result.totalWallets, 2);
  assert.equal(result.successfulWallets, 2);
  assert.equal(result.failedWallets, 0);
  assert.equal(result.totalIndividualOrders, 1);
  assert.deepEqual(calls, traders.map((trader) => trader.walletAddress));
  assert.equal(result.results.find((row) => row.traderName === "second")?.hypurrscanUrl.endsWith("#orders"), true);
});
