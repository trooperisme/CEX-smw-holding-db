import assert from "node:assert/strict";
import test from "node:test";
import { runScheduledRefresh } from "./signal-scheduled";

test("scheduled refresh runs signal and spot workflows together", async () => {
  const calls: string[] = [];
  const result = await runScheduledRefresh({
    signalRunner: async () => {
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
    spotRunner: async () => {
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
