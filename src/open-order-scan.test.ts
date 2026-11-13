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
    minIntervalMs: 0,
    fetcher: async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      assert.equal(request.type, "frontendOpenOrders");
      assert.equal(request.dex, "ALL_DEXS");
      const user = request.user;
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
  assert.match(String(result.source), /frontendOpenOrders dex=ALL_DEXS/);
});

test("all-DEX order requests are paced across concurrent wallets", async () => {
  const traders = [1, 2, 3].map((index) => ({
    traderName: `trader-${index}`,
    hypurrscanUrl: `https://hypurrscan.io/address/0x${String(index).padStart(40, "0")}#orders`,
    walletAddress: `0x${String(index).padStart(40, "0")}`,
    isActive: true,
  }));
  const starts: number[] = [];
  const result = await runOpenOrderScan({
    traders,
    concurrency: 3,
    minIntervalMs: 25,
    fetcher: async () => {
      starts.push(Date.now());
      return Response.json([]);
    },
  });
  assert.equal(result.successfulWallets, 3);
  assert.equal(starts.length, 3);
  assert.ok(starts[1] - starts[0] >= 20);
  assert.ok(starts[2] - starts[1] >= 20);
});
