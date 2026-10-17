import assert from "node:assert/strict";
import test from "node:test";
import { runScheduledRefresh, validateScheduledSpotCoverage, validateScheduledTraders } from "./signal-scheduled";
import { SpotHoldingsScanSummary } from "./spot-holdings";
import { TrackedTrader } from "./types";

const traders: TrackedTrader[] = Array.from({ length: 106 }, (_, index) => {
  const address = `0x${(index + 1).toString(16).padStart(40, "0")}`;
  return { traderName: `Trader ${index}`, hypurrscanUrl: `https://hypurrscan.io/address/${address}`, walletAddress: address, isActive: true };
});

test("scheduled refresh runs signal and spot workflows together", async () => {
  const calls: string[] = [];
  const result = await runScheduledRefresh({
    traderLoader: async () => traders,
    signalRunner: async (input) => {
      assert.strictEqual(input, traders);
      calls.push("signal");
      return {
        snapshotId: 128,
        tradersTotal: 106,
        tradersCompleted: 106,
        tradersFailed: 0,
        totalPositions: 240,
        tradersRemaining: 0,
        status: "success",
      };
    },
    spotRunner: async (input) => {
      assert.strictEqual(input, traders);
      calls.push("spot");
      return {
        source: "github-action",
        snapshotId: 128,
        generatedAt: "2026-10-08T01:05:00.000Z",
        tradersScanned: 106,
        tradersWithFilteredHoldings: 12,
        failures: 0,
      };
    },
  });

  assert.deepEqual(calls.sort(), ["signal", "spot"]);
  assert.equal(result.status, "success");
  assert.equal(result.signal?.tradersTotal, 106);
  assert.equal(result.spot?.tradersScanned, 106);
});

test("scheduled refresh reports spot scrape failures as partial", async () => {
  const result = await runScheduledRefresh({
    traderLoader: async () => traders,
    signalRunner: async () => ({
      snapshotId: 129,
      tradersTotal: 106,
      tradersCompleted: 106,
      tradersFailed: 0,
      totalPositions: 240,
      tradersRemaining: 0,
      status: "success",
    }),
    spotRunner: async () => ({
      source: "github-action",
      snapshotId: 129,
      generatedAt: "2026-10-08T01:05:00.000Z",
      tradersScanned: 106,
      tradersWithFilteredHoldings: 11,
      failures: 1,
    }),
  });

  assert.equal(result.status, "partial");
});

test("scheduler rejects empty, invalid or duplicate canonical registries before running", async () => {
  assert.throws(() => validateScheduledTraders([]), /registry is empty/);
  assert.throws(() => validateScheduledTraders([traders[0], traders[0]]), /duplicate/);
  let launched = false;
  await assert.rejects(runScheduledRefresh({
    traderLoader: async () => [],
    signalRunner: async () => { launched = true; throw new Error("unexpected"); },
    spotRunner: async () => { launched = true; throw new Error("unexpected"); },
  }), /registry is empty/);
  assert.equal(launched, false);
});

test("spot quality gate rejects missing wallets, failed fetches and empty outputs before publish", () => {
  const input = traders.slice(0, 2);
  const rows = input.map((trader, index) => ({
    traderName: trader.traderName, walletAddress: trader.walletAddress, spotUrl: trader.hypurrscanUrl,
    holdings: index ? [] : [{ token: "BTC", valueUsd: 500, valueText: "$500" }],
    totalFilteredUsd: index ? 0 : 500, error: null,
  }));
  const summary = { tradersScanned: 2, allResults: rows, failures: 0 } as SpotHoldingsScanSummary;
  assert.doesNotThrow(() => validateScheduledSpotCoverage(summary, input));
  assert.throws(() => validateScheduledSpotCoverage({ ...summary, allResults: rows.slice(0, 1) }, input), /complete/);
  assert.throws(() => validateScheduledSpotCoverage({ ...summary, failures: 1 }, input), /failed/);
  assert.throws(() => validateScheduledSpotCoverage({ ...summary, allResults: rows.map((row) => ({ ...row, holdings: [] })) }, input), /no holdings/);
});

test("scheduler reports mismatched coverage as partial even if runners claim success", async () => {
  const result = await runScheduledRefresh({
    traderLoader: async () => traders,
    signalRunner: async () => ({ snapshotId: 1, tradersTotal: 91, tradersCompleted: 91, tradersFailed: 0, totalPositions: 10, tradersRemaining: 0, status: "success" }),
    spotRunner: async () => ({ source: "github-action", snapshotId: 1, generatedAt: null, tradersScanned: 91, tradersWithFilteredHoldings: 10, failures: 0 }),
  });
  assert.equal(result.status, "partial");
  assert.equal(result.errors.length, 2);
});
