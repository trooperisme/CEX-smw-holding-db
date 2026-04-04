import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { parseHypurrscanMarkdown } from "./hypurrscan-signals";
import { aggregateTokenSignalMetrics } from "./signals";
import { classifySignalMarketType, loadTrackedTraders } from "./trader-registry";

test("classifySignalMarketType routes prefixed tickers to tradfi", () => {
  assert.equal(classifySignalMarketType("BTC"), "crypto");
  assert.equal(classifySignalMarketType("HYPE"), "crypto");
  assert.equal(classifySignalMarketType("xyz:EWY"), "tradfi");
  assert.equal(classifySignalMarketType("hyna:HYPE"), "tradfi");
});

test("parseHypurrscanMarkdown extracts open perp positions", () => {
  const markdown = `
| Token | Side | Lev. | Value | Amount | Entry | BE | Price | PnL | Funding | Liq. |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| [![](https://hypurrscan.io/perps/BTC.svg)BTC](https://hypurrscan.io/market/BTC) | **LONG** | 29X (cross) | **8,058,669.07$** | 120.37 | 109,632.30$ | 112,260.3$ | 66,950.00$ | -5,137,612.46$ | -307,917.18$ | 1,177.50$ |
| [![](https://hypurrscan.io/perps/CL.svg)![](https://hypurrscan.io/XYZ.svg)xyz:CL](https://hypurrscan.io/market/xyz:CL) | **LONG** | 20X (isolated) | **576,852.72$** | 5.18K | 107.09$ | 107.00687$ | 111.43$ | 22,449.90$ | 795.03$ | 80.41$ |
| [![](https://hypurrscan.io/perps/XRP.svg)XRP](https://hypurrscan.io/market/XRP) | **SHORT** | 20X (cross) | **77,108.48$** | -58.72K | 2.4848$ | 2.93781$ | 1.3132$ | 68,794.41$ | 26,699.76$ | 131.21$ |
`;

  assert.deepEqual(parseHypurrscanMarkdown(markdown), [
    { token: "BTC", side: "long", valueUsd: 8058669.07 },
    { token: "xyz:CL", side: "long", valueUsd: 576852.72 },
    { token: "XRP", side: "short", valueUsd: 77108.48 },
  ]);
});

test("aggregateTokenSignalMetrics computes token-level signal rows", () => {
  const metrics = aggregateTokenSignalMetrics(12, [
    {
      traderName: "WayneKest",
      walletAddress: "0x1",
      sourceUrl: "https://hypurrscan.io/address/0x1#perps",
      token: "BTC",
      side: "long",
      valueUsd: 8058669.07,
      marketType: "crypto",
      scrapedAt: "2026-04-04T00:00:00.000Z",
      parseStatus: "parsed",
    },
    {
      traderName: "UnRektCapital",
      walletAddress: "0x2",
      sourceUrl: "https://hypurrscan.io/address/0x2#perps",
      token: "BTC",
      side: "short",
      valueUsd: 44805990.24,
      marketType: "crypto",
      scrapedAt: "2026-04-04T00:00:00.000Z",
      parseStatus: "parsed",
    },
    {
      traderName: "High Risk Short bias",
      walletAddress: "0x3",
      sourceUrl: "https://hypurrscan.io/address/0x3#perps",
      token: "xyz:CL",
      side: "long",
      valueUsd: 584327.44,
      marketType: "tradfi",
      scrapedAt: "2026-04-04T00:00:00.000Z",
      parseStatus: "parsed",
    },
  ]);

  assert.deepEqual(metrics, [
    {
      snapshotId: 12,
      marketType: "tradfi",
      token: "xyz:CL",
      smwFlows: 1,
      holdingsUsd: 584327.44,
      longSmw: 1,
      shortSmw: 0,
      longValueUsd: 584327.44,
      shortValueUsd: 0,
    },
    {
      snapshotId: 12,
      marketType: "crypto",
      token: "BTC",
      smwFlows: 0,
      holdingsUsd: 36747321.17,
      longSmw: 1,
      shortSmw: 1,
      longValueUsd: 8058669.07,
      shortValueUsd: 44805990.24,
    },
  ]);
});

test("loadTrackedTraders imports the CSV and preserves distinct addresses", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "signals-registry-"));
  const sourceFile = path.join(tmpDir, "Trader-Hypurrscan.csv");
  fs.writeFileSync(
    sourceFile,
    [
      "Trader,Hypurrscan",
      "FalconX,https://hypurrscan.io/address/0x1111111111111111111111111111111111111111#perps",
      "FalconX,https://hypurrscan.io/address/0x2222222222222222222222222222222222222222#perps",
    ].join("\n"),
  );

  const previousSource = process.env.TRADER_SIGNALS_IMPORT_CSV;
  process.env.TRADER_SIGNALS_IMPORT_CSV = sourceFile;

  try {
    const traders = loadTrackedTraders(tmpDir);
    assert.equal(traders.length, 2);
    assert.deepEqual(
      traders.map((row) => row.walletAddress),
      [
        "0x1111111111111111111111111111111111111111",
        "0x2222222222222222222222222222222222222222",
      ],
    );
  } finally {
    process.env.TRADER_SIGNALS_IMPORT_CSV = previousSource;
  }
});
