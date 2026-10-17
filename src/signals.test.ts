import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { buildSignalSnapshotCoverageSummary } from "./signal-coverage";
import { buildSignalMarkdownExport } from "./signal-export";
import {
  parseHypurrscanMarkdown,
  parseHypurrscanVaultPositions,
  scrapeHypurrscanSignals,
} from "./hypurrscan-signals";
import { summarizeSignalRefreshProgress } from "./signal-refresh";
import { aggregateTokenSignalMetrics } from "./signals";
import { classifySignalMarketType, loadTrackedTraders } from "./trader-registry";
import { createSignalStorage } from "./signal-storage";

test("classifySignalMarketType routes prefixed tickers to tradfi", () => {
  assert.equal(classifySignalMarketType("BTC"), "crypto");
  assert.equal(classifySignalMarketType("HYPE"), "crypto");
  assert.equal(classifySignalMarketType("xyz:EWY"), "tradfi");
  assert.equal(classifySignalMarketType("hyna:HYPE"), "tradfi");
});

test("latest signal snapshot ignores a running snapshot", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "signals-latest-snapshot-"));
  const storage = createSignalStorage(tmpDir);
  try {
    const publishedId = await storage.createSignalSnapshot(1);
    await storage.updateSignalSnapshot({ id: publishedId, status: "success", finishedAt: new Date().toISOString() });
    const runningId = await storage.createSignalSnapshot(1);

    assert.ok(runningId > publishedId);
    assert.equal(await storage.getLatestSignalSnapshotId(), publishedId);
  } finally {
    storage.close();
  }
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

test("parseHypurrscanVaultPositions mirrors Hypurrscan Positions tab payload", () => {
  assert.deepEqual(
    parseHypurrscanVaultPositions({
      assetPositions: [
        { position: { coin: "BTC", szi: "48.98793", positionValue: "4128310.83696" } },
        { position: { coin: "SOL", szi: "-540.67", positionValue: "64237.0027" } },
        { position: { coin: "ZERO", szi: "0", positionValue: "0" } },
      ],
    }),
    [
      { token: "BTC", side: "long", valueUsd: 4128310.83696 },
      { token: "SOL", side: "short", valueUsd: 64237.0027 },
    ],
  );
});

test("scrapeHypurrscanSignals uses the vault Positions data path", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "signals-vault-positions-"));
  const calls: string[] = [];
  const positions = await scrapeHypurrscanSignals(
    {
      traderName: "bredo strategy",
      hypurrscanUrl: "https://hypurrscan.io/vault/0x654016a8c9fcf0c4cb7ed6078aba21f7f399f7b7",
      walletAddress: "0x654016a8c9fcf0c4cb7ed6078aba21f7f399f7b7",
      isActive: true,
    },
    {
      cwd: tmpDir,
      snapshotId: 8,
      vaultPositionRunner: async (vaultAddress, outputPath) => {
        calls.push(`${vaultAddress}:${outputPath.endsWith(".md")}`);
        return [
          { token: "BTC", side: "long", valueUsd: 4128310.83696 },
          { token: "LINK", side: "long", valueUsd: 1472839.0266 },
        ];
      },
    },
  );

  assert.deepEqual(calls, [
    "0x654016a8c9fcf0c4cb7ed6078aba21f7f399f7b7:true",
  ]);
  assert.deepEqual(positions.map(({ token, side, valueUsd, sourceUrl }) => ({
    token,
    side,
    valueUsd,
    sourceUrl,
  })), [
    {
      token: "BTC",
      side: "long",
      valueUsd: 4128310.83696,
      sourceUrl: "https://hypurrscan.io/vault/0x654016a8c9fcf0c4cb7ed6078aba21f7f399f7b7",
    },
    {
      token: "LINK",
      side: "long",
      valueUsd: 1472839.0266,
      sourceUrl: "https://hypurrscan.io/vault/0x654016a8c9fcf0c4cb7ed6078aba21f7f399f7b7",
    },
  ]);
});

test("scrapeHypurrscanSignals retries transient Firecrawl retrieval failures", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "signals-firecrawl-retry-"));
  const previousRetryDelay = process.env.HYPURRSCAN_RETRY_DELAY_MS;
  const previousRetryCount = process.env.HYPURRSCAN_SCRAPE_RETRY_COUNT;
  process.env.HYPURRSCAN_RETRY_DELAY_MS = "0";
  process.env.HYPURRSCAN_SCRAPE_RETRY_COUNT = "1";

  let calls = 0;
  const markdown = `
| Token | Side | Lev. | Value | Amount | Entry | BE | Price | PnL | Funding | Liq. |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| [![](https://hypurrscan.io/perps/HYPE.svg)HYPE](https://hypurrscan.io/market/HYPE) | **LONG** | 3X (cross) | **12,345.67$** | 10 | 1$ | 1$ | 1$ | 0$ | 0$ | - |
`;

  try {
    const positions = await scrapeHypurrscanSignals(
      {
        traderName: "Retry Trader",
        hypurrscanUrl: "https://hypurrscan.io/address/0x1111111111111111111111111111111111111111#perps",
        walletAddress: "0x1111111111111111111111111111111111111111",
        isActive: true,
      },
      {
        cwd: tmpDir,
        snapshotId: 7,
        scrapeRunner: async (_url, outputPath) => {
          calls += 1;
          if (calls === 1) {
            throw new Error('Firecrawl scrape failed (500): {"code":"SCRAPE_ALL_ENGINES_FAILED"}');
          }
          fs.writeFileSync(outputPath, markdown, "utf-8");
        },
      },
    );

    assert.equal(calls, 2);
    assert.deepEqual(positions.map((position) => ({
      traderName: position.traderName,
      walletAddress: position.walletAddress,
      token: position.token,
      side: position.side,
      valueUsd: position.valueUsd,
      marketType: position.marketType,
      parseStatus: position.parseStatus,
    })), [
      {
        traderName: "Retry Trader",
        walletAddress: "0x1111111111111111111111111111111111111111",
        token: "HYPE",
        side: "long",
        valueUsd: 12345.67,
        marketType: "crypto",
        parseStatus: "parsed",
      },
    ]);
  } finally {
    if (previousRetryDelay === undefined) {
      delete process.env.HYPURRSCAN_RETRY_DELAY_MS;
    } else {
      process.env.HYPURRSCAN_RETRY_DELAY_MS = previousRetryDelay;
    }
    if (previousRetryCount === undefined) {
      delete process.env.HYPURRSCAN_SCRAPE_RETRY_COUNT;
    } else {
      process.env.HYPURRSCAN_SCRAPE_RETRY_COUNT = previousRetryCount;
    }
  }
});

test("summarizeSignalRefreshProgress retries interrupted running trader runs", () => {
  const traders = [
    {
      traderName: "Done",
      hypurrscanUrl: "https://hypurrscan.io/address/0x1111111111111111111111111111111111111111#perps",
      walletAddress: "0x1111111111111111111111111111111111111111",
      isActive: true,
    },
    {
      traderName: "Interrupted",
      hypurrscanUrl: "https://hypurrscan.io/address/0x2222222222222222222222222222222222222222#perps",
      walletAddress: "0x2222222222222222222222222222222222222222",
      isActive: true,
    },
    {
      traderName: "Failed",
      hypurrscanUrl: "https://hypurrscan.io/address/0x3333333333333333333333333333333333333333#perps",
      walletAddress: "0x3333333333333333333333333333333333333333",
      isActive: true,
    },
  ];

  const progress = summarizeSignalRefreshProgress(traders, [
    {
      snapshotId: 80,
      traderName: "Done",
      walletAddress: "0x1111111111111111111111111111111111111111",
      sourceUrl: traders[0].hypurrscanUrl,
      status: "success",
      positionsFound: 2,
      errorMessage: null,
      startedAt: "2026-07-07T06:55:00.000Z",
      finishedAt: "2026-07-07T06:55:05.000Z",
    },
    {
      snapshotId: 80,
      traderName: "Interrupted",
      walletAddress: "0x2222222222222222222222222222222222222222",
      sourceUrl: traders[1].hypurrscanUrl,
      status: "running",
      positionsFound: 0,
      errorMessage: null,
      startedAt: "2026-07-07T06:55:06.000Z",
      finishedAt: null,
    },
    {
      snapshotId: 80,
      traderName: "Failed",
      walletAddress: "0x3333333333333333333333333333333333333333",
      sourceUrl: traders[2].hypurrscanUrl,
      status: "failed",
      positionsFound: 0,
      errorMessage: "timeout",
      startedAt: "2026-07-07T06:55:07.000Z",
      finishedAt: "2026-07-07T06:55:10.000Z",
    },
  ]);

  assert.equal(progress.completed, 1);
  assert.equal(progress.failed, 1);
  assert.equal(progress.totalPositions, 2);
  assert.equal(progress.interruptedRuns, 1);
  assert.deepEqual(
    progress.pendingTraders.map((trader) => trader.traderName),
    ["Interrupted"],
  );
});

test("summarizeSignalRefreshProgress can retry failed trader runs when continuing a snapshot", () => {
  const traders = [
    {
      traderName: "Done",
      hypurrscanUrl: "https://hypurrscan.io/address/0x1111111111111111111111111111111111111111#perps",
      walletAddress: "0x1111111111111111111111111111111111111111",
      isActive: true,
    },
    {
      traderName: "Rate Limited",
      hypurrscanUrl: "https://hypurrscan.io/address/0x2222222222222222222222222222222222222222#perps",
      walletAddress: "0x2222222222222222222222222222222222222222",
      isActive: true,
    },
  ];

  const progress = summarizeSignalRefreshProgress(
    traders,
    [
      {
        snapshotId: 95,
        traderName: "Done",
        walletAddress: "0x1111111111111111111111111111111111111111",
        sourceUrl: traders[0].hypurrscanUrl,
        status: "success",
        positionsFound: 2,
        errorMessage: null,
        startedAt: "2026-08-03T08:49:00.000Z",
        finishedAt: "2026-08-03T08:49:05.000Z",
      },
      {
        snapshotId: 95,
        traderName: "Rate Limited",
        walletAddress: "0x2222222222222222222222222222222222222222",
        sourceUrl: traders[1].hypurrscanUrl,
        status: "failed",
        positionsFound: 0,
        errorMessage: "Firecrawl scrape failed (429): retry after 25s",
        startedAt: "2026-08-03T08:49:06.000Z",
        finishedAt: "2026-08-03T08:49:10.000Z",
      },
    ],
    { retryFailed: true },
  );

  assert.equal(progress.completed, 1);
  assert.equal(progress.failed, 1);
  assert.deepEqual(
    progress.pendingTraders.map((trader) => trader.traderName),
    ["Rate Limited"],
  );
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

test("buildSignalMarkdownExport formats current-market GPT copy payload", () => {
  const text = buildSignalMarkdownExport({
    snapshot: {
      id: 46,
      status: "success",
      total_traders: 3,
      traders_completed: 3,
      traders_failed: 0,
      total_positions: 4,
      error_message: null,
      created_at: "2026-06-13T07:49:00.000Z",
      finished_at: "2026-06-13T07:50:00.000Z",
    },
    market: "crypto",
    metrics: [
      {
        snapshotId: 46,
        marketType: "crypto",
        token: "BTC",
        smwFlows: -1,
        holdingsUsd: 1200,
        longSmw: 1,
        shortSmw: 2,
        longValueUsd: 500,
        shortValueUsd: 1700,
      },
      {
        snapshotId: 46,
        marketType: "tradfi",
        token: "xyz:CL",
        smwFlows: 1,
        holdingsUsd: 900,
        longSmw: 1,
        shortSmw: 0,
        longValueUsd: 900,
        shortValueUsd: 0,
      },
    ],
    positions: [
      {
        snapshotId: 46,
        traderName: "Long Trader",
        walletAddress: "0x1111111111111111111111111111111111111111",
        sourceUrl: "https://hypurrscan.io/address/0x1111111111111111111111111111111111111111#perps",
        token: "BTC",
        side: "long",
        valueUsd: 500,
        marketType: "crypto",
        scrapedAt: "2026-06-13T07:50:00.000Z",
        parseStatus: "parsed",
      },
      {
        snapshotId: 46,
        traderName: "Short Trader",
        walletAddress: "0x2222222222222222222222222222222222222222",
        sourceUrl: "https://hypurrscan.io/address/0x2222222222222222222222222222222222222222#perps",
        token: "BTC",
        side: "short",
        valueUsd: 1700,
        marketType: "crypto",
        scrapedAt: "2026-06-13T07:50:00.000Z",
        parseStatus: "parsed",
      },
      {
        snapshotId: 46,
        traderName: "Oil Trader",
        walletAddress: "0x3333333333333333333333333333333333333333",
        sourceUrl: "https://hypurrscan.io/address/0x3333333333333333333333333333333333333333#perps",
        token: "xyz:CL",
        side: "long",
        valueUsd: 900,
        marketType: "tradfi",
        scrapedAt: "2026-06-13T07:50:00.000Z",
        parseStatus: "parsed",
      },
    ],
    runs: [
      {
        snapshotId: 46,
        traderName: "Long Trader",
        walletAddress: "0x1111111111111111111111111111111111111111",
        sourceUrl: "https://hypurrscan.io/address/0x1111111111111111111111111111111111111111#perps",
        status: "success",
        positionsFound: 1,
        errorMessage: null,
        startedAt: "2026-06-13T07:49:00.000Z",
        finishedAt: "2026-06-13T07:50:00.000Z",
      },
      {
        snapshotId: 46,
        traderName: "Flat Trader",
        walletAddress: "0x4444444444444444444444444444444444444444",
        sourceUrl: "https://hypurrscan.io/address/0x4444444444444444444444444444444444444444#perps",
        status: "success",
        positionsFound: 0,
        errorMessage: null,
        startedAt: "2026-06-13T07:49:00.000Z",
        finishedAt: "2026-06-13T07:50:00.000Z",
      },
      {
        snapshotId: 46,
        traderName: "Failed Trader",
        walletAddress: "0x5555555555555555555555555555555555555555",
        sourceUrl: "https://hypurrscan.io/address/0x5555555555555555555555555555555555555555#perps",
        status: "failed",
        positionsFound: 0,
        errorMessage: "Timeout",
        startedAt: "2026-06-13T07:49:00.000Z",
        finishedAt: "2026-06-13T07:50:00.000Z",
      },
    ],
  });

  assert.match(text, /Snapshot: #46/);
  assert.match(text, /Market: crypto/);
  assert.match(text, /\| BTC \| \$1,200\.00 \| -1 \| 1 \| 2 \| \$500\.00 \| \$1,700\.00 \|/);
  assert.match(text, /Long:\n- Long Trader \(0x1111\.\.\.1111\): \$500\.00/);
  assert.match(text, /Short:\n- Short Trader \(0x2222\.\.\.2222\): \$1,700\.00/);
  assert.match(text, /1 successful trader scrapes had 0 open perps/);
  assert.match(text, /1 trader scrapes failed/);
  assert.doesNotMatch(text, /xyz:CL/);
  assert.doesNotMatch(text, /Oil Trader/);
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

test("buildSignalSnapshotCoverageSummary flags tracked traders missing from a snapshot", () => {
  const coverage = buildSignalSnapshotCoverageSummary(
    [
      {
        traderName: "tommy 🌙",
        hypurrscanUrl: "https://hypurrscan.io/address/0xe635dfc74904e3ec71b95fd3b8b2a7dc5a9870a6#perps",
        walletAddress: "0xe635dfc74904e3ec71b95fd3b8b2a7dc5a9870a6",
        isActive: true,
      },
      {
        traderName: "tommy 🌙",
        hypurrscanUrl: "https://hypurrscan.io/address/0x83b1385d8126ecf64bfb3b4254d67eb9db753bcc#perps",
        walletAddress: "0x83b1385d8126ecf64bfb3b4254d67eb9db753bcc",
        isActive: true,
      },
    ],
    [
      {
        snapshotId: 44,
        traderName: "tommy 🌙",
        walletAddress: "0xe635dfc74904e3ec71b95fd3b8b2a7dc5a9870a6",
        sourceUrl: "https://hypurrscan.io/address/0xe635dfc74904e3ec71b95fd3b8b2a7dc5a9870a6#perps",
        status: "success",
        positionsFound: 1,
        errorMessage: null,
        startedAt: "2026-05-06T00:00:00.000Z",
        finishedAt: "2026-05-06T00:00:01.000Z",
      },
    ],
  );

  assert.deepEqual(coverage, {
    trackedTotal: 2,
    coveredCount: 1,
    missingTrackedCount: 1,
    missingTrackedTraders: [
      {
        traderName: "tommy 🌙",
        walletAddress: "0x83b1385d8126ecf64bfb3b4254d67eb9db753bcc",
        sourceUrl: "https://hypurrscan.io/address/0x83b1385d8126ecf64bfb3b4254d67eb9db753bcc#perps",
      },
    ],
  });
});
