import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseSpotHoldingsFromHtml, runSpotHoldingsScan } from "./spot-holdings";

test("parseSpotHoldingsFromHtml extracts Hypurrscan spot token/value pairs", () => {
  const html = `
    <div class="font-weight-bold mb-1">HYPE</div><div class="text-medium-emphasis">12,345.67$</div>
    <div class="font-weight-bold mb-1">KNTQ</div><div class="text-medium-emphasis">88.90$</div>
  `;

  assert.deepEqual(parseSpotHoldingsFromHtml(html), [
    { token: "HYPE", valueUsd: 12345.67, valueText: "12,345.67$" },
    { token: "KNTQ", valueUsd: 88.9, valueText: "88.90$" },
  ]);
});

test("runSpotHoldingsScan writes filtered spot export through injectable scrape runner", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "spot-holdings-scan-"));
  const previousRelevant = process.env.SPOT_HOLDING_RELEVANT_TOKENS;
  const previousInclude = process.env.SPOT_HOLDING_INCLUDE_TOKENS;
  const previousMinUsd = process.env.SPOT_HOLDING_MIN_USD;
  const previousConcurrency = process.env.SPOT_HOLDING_CONCURRENCY;
  const previousForceRefetch = process.env.SPOT_HOLDING_FORCE_REFETCH;

  delete process.env.SPOT_HOLDING_RELEVANT_TOKENS;
  delete process.env.SPOT_HOLDING_INCLUDE_TOKENS;
  delete process.env.SPOT_HOLDING_MIN_USD;
  process.env.SPOT_HOLDING_CONCURRENCY = "1";
  process.env.SPOT_HOLDING_FORCE_REFETCH = "1";

  try {
    const summary = await runSpotHoldingsScan({
      cwd: tmpDir,
      traders: [
        {
          traderName: "Spot Trader",
          hypurrscanUrl: "https://hypurrscan.io/address/0x1111111111111111111111111111111111111111#perps",
          walletAddress: "0x1111111111111111111111111111111111111111",
          isActive: true,
        },
      ],
      logger: () => undefined,
      scrapeRunner: async (_url, outputPath) => {
        fs.writeFileSync(
          outputPath,
          `
            <div class="font-weight-bold mb-1">HYPE</div><div class="text-medium-emphasis">11.00$</div>
            <div class="font-weight-bold mb-1">ARB</div><div class="text-medium-emphasis">12.00$</div>
            <div class="font-weight-bold mb-1">LOW</div><div class="text-medium-emphasis">10.99$</div>
            <div class="font-weight-bold mb-1">USDC</div><div class="text-medium-emphasis">10,000.00$</div>
          `,
          "utf-8",
        );
      },
    });

    assert.equal(summary.tradersScanned, 1);
    assert.equal(summary.tradersWithFilteredHoldings, 1);
    assert.equal(summary.tokenFilter.filteredOut.stable, 1);
    assert.deepEqual(summary.results[0].holdings.map((holding) => holding.token), ["ARB", "HYPE"]);

    const outputPath = path.join(
      tmpDir,
      "data",
      "wallet-scraper",
      "processed",
      "spot-holdings",
      "spot-holdings.json",
    );
    const csvPath = path.join(
      tmpDir,
      "data",
      "wallet-scraper",
      "processed",
      "spot-holdings",
      "spot-holdings.csv",
    );
    assert.equal(fs.existsSync(outputPath), true);
    assert.equal(fs.existsSync(csvPath), true);
    const exported = JSON.parse(fs.readFileSync(outputPath, "utf-8"));
    assert.equal(exported.minUsd, 11);
    assert.deepEqual(exported.results[0].holdings.map((holding: { token: string }) => holding.token), ["ARB", "HYPE"]);
  } finally {
    if (previousRelevant === undefined) {
      delete process.env.SPOT_HOLDING_RELEVANT_TOKENS;
    } else {
      process.env.SPOT_HOLDING_RELEVANT_TOKENS = previousRelevant;
    }
    if (previousInclude === undefined) {
      delete process.env.SPOT_HOLDING_INCLUDE_TOKENS;
    } else {
      process.env.SPOT_HOLDING_INCLUDE_TOKENS = previousInclude;
    }
    if (previousMinUsd === undefined) {
      delete process.env.SPOT_HOLDING_MIN_USD;
    } else {
      process.env.SPOT_HOLDING_MIN_USD = previousMinUsd;
    }
    if (previousConcurrency === undefined) {
      delete process.env.SPOT_HOLDING_CONCURRENCY;
    } else {
      process.env.SPOT_HOLDING_CONCURRENCY = previousConcurrency;
    }
    if (previousForceRefetch === undefined) {
      delete process.env.SPOT_HOLDING_FORCE_REFETCH;
    } else {
      process.env.SPOT_HOLDING_FORCE_REFETCH = previousForceRefetch;
    }
  }
});
