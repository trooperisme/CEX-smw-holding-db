import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildSpotHoldingsDashboard, loadSpotHoldingsDashboardFromFile } from "./spot-dashboard";

const wallet = "0x1111111111111111111111111111111111111111";

test("file and durable-shaped Spot captures agree and count distinct wallets", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "spot-dashboard-"));
  const dir = path.join(cwd, "data/wallet-scraper/processed/spot-holdings");
  fs.mkdirSync(dir, { recursive: true });
  const capture = { generatedAt: "2026-11-25T02:00:00Z", minUsd: 333, tradersScanned: 1, failures: 0,
    tokenFilter: { includeTokens: [], filteredOut: { stable: 2, trash: 0, unrelated: 0 } },
    results: [{ traderName: "Trader", walletAddress: wallet, holdings: [
      { token: "HYPE", valueUsd: 1000 }, { token: "ARB", valueUsd: 500 },
    ] }] };
  fs.writeFileSync(path.join(dir, "spot-holdings.json"), JSON.stringify(capture));
  const old = process.env.SPOT_HOLDING_MIN_USD;
  process.env.SPOT_HOLDING_MIN_USD = "2000";
  try {
    const local = loadSpotHoldingsDashboardFromFile(cwd);
    const durable = buildSpotHoldingsDashboard({ ...capture, snapshotId: 123,
      holdings: capture.results.flatMap((trader) => trader.holdings.map((row) => ({ ...row, traderName: trader.traderName, walletAddress: trader.walletAddress }))) });
    assert.deepEqual(local.rows, durable.rows);
    assert.deepEqual(local.summary, durable.summary);
    assert.equal(local.summary.tradersWithRelevantHoldings, 1);
    assert.equal(local.summary.keptHoldings, 2);
    assert.equal(local.summary.minUsd, 333);
    assert.equal(local.summary.filteredOut.stable, 2);
    assert.equal(local.snapshotId, null);
    assert.equal(durable.snapshotId, 123);
  } finally {
    if (old === undefined) delete process.env.SPOT_HOLDING_MIN_USD; else process.env.SPOT_HOLDING_MIN_USD = old;
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("Spot normalizes wallet identity, combines duplicate token rows and applies capture filter", () => {
  const result = buildSpotHoldingsDashboard({ minUsd: 333, holdings: [
    { token: " hype ", traderName: "Trader", walletAddress: wallet.toUpperCase(), valueUsd: 500 },
    { token: "HYPE", traderName: "Trader", walletAddress: wallet, valueUsd: 700 },
    { token: "USDC", traderName: "Trader", walletAddress: wallet, valueUsd: 10000 },
    { token: "ARB", traderName: "Trader", walletAddress: wallet, valueUsd: 333 },
  ] });
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].holdersCount, 1);
  assert.equal(result.rows[0].totalValueUsd, 1200);
  assert.equal(result.summary.tradersWithFilteredHoldings, 1);
});

test("missing local Spot snapshot remains missing with the shared payload shape", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "spot-dashboard-missing-"));
  try {
    const result = loadSpotHoldingsDashboardFromFile(cwd);
    assert.equal(result.generatedAt, null);
    assert.equal(result.snapshotId, null);
    assert.equal(result.summary.tradersWithRelevantHoldings, 0);
    assert.deepEqual(result.rows, []);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});
