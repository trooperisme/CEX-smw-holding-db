import assert from "node:assert/strict";
import test from "node:test";
import { buildClaudeLongMarkdown, extractOpenPositions } from "./claude-long";
import { HyperliquidClearinghouseAssetPosition } from "./hyperliquid";

test("extractOpenPositions keeps only non-zero positions and normalizes values", () => {
  const assetPositions: HyperliquidClearinghouseAssetPosition[] = [
    {
      position: {
        coin: "vntl:ANTHROPIC",
        szi: "12.5",
        entryPx: "102.45",
        unrealizedPnl: "88.1",
      },
    },
    {
      position: {
        coin: "BTC",
        szi: "-0.75",
        entryPx: "70000",
        unrealizedPnl: "-120.25",
      },
    },
    {
      position: {
        coin: "ETH",
        szi: "0",
        entryPx: "3000",
        unrealizedPnl: "0",
      },
    },
  ];

  const positions = extractOpenPositions(assetPositions);
  assert.equal(positions.length, 2);
  assert.deepEqual(positions[0], {
    ticker: "vntl:ANTHROPIC",
    side: "LONG",
    size: 12.5,
    entry: 102.45,
    unrealizedPnl: 88.1,
  });
  assert.deepEqual(positions[1], {
    ticker: "BTC",
    side: "SHORT",
    size: 0.75,
    entry: 70000,
    unrealizedPnl: -120.25,
  });
});

test("extractOpenPositions returns empty when there are no open positions", () => {
  const positions = extractOpenPositions([{ position: { coin: "ETH", szi: "0" } }]);
  assert.deepEqual(positions, []);
});

test("buildClaudeLongMarkdown renders a compact table", () => {
  const markdown = buildClaudeLongMarkdown("0xabc", "2026-04-02T00:00:00.000Z", [
    {
      ticker: "vntl:ANTHROPIC",
      side: "LONG",
      size: 10,
      entry: 100,
      unrealizedPnl: 25.5,
    },
  ]);

  assert.match(markdown, /\| Ticker \| Side \| Size \| Entry \| Unrealized PnL \|/);
  assert.match(markdown, /\| vntl:ANTHROPIC \| LONG \| 10 \| 100 \| \$25.5 \|/);
});

test("buildClaudeLongMarkdown reports no open positions clearly", () => {
  const markdown = buildClaudeLongMarkdown("0xabc", "2026-04-02T00:00:00.000Z", []);
  assert.match(markdown, /No open perp positions\./);
});
