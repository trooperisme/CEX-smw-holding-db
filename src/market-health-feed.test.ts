import assert from "node:assert/strict";
import test from "node:test";
import { fetchCurrentMarketHealth, parseShumiHealth } from "./market-health-feed";

function fixtures() {
  const now = new Date();
  const daily = Array.from({ length: 30 }, (_, index) => {
    const date = new Date(now.getTime() - (29 - index) * 86_400_000)
      .toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
    return (["UP", "DOWN", "HODL"] as const).map((trend) => ({ date, trend, amount: trend === "DOWN" ? 50 : 25 }));
  }).flat();
  const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
    buildId: "test-build", props: { pageProps: { marketHealthSeed: { daily, lastUpdated: now.getTime() } } },
  })}</script>`;
  const btc = { pageProps: { id: "bitcoin", signals: {
    "1d": { usd: { trend: "DOWN", streak: 4 }, supersuperTrend: { trend: "HODL", streak: 19 } },
    "1w": { usd: { trend: "DOWN", streak: 2 }, supersuperTrend: { trend: "HODL", streak: 2 } },
    snapshotAt: now.toISOString(),
  } } };
  return { now, html, btc };
}

test("Shumi breadth is primary while BTC uses CoinRotator's USD legs", async () => {
  const { now, html, btc } = fixtures();
  const previousFetch = global.fetch;
  const previousKey = process.env.SHUMI_API_KEY;
  process.env.SHUMI_API_KEY = "test-key";
  let firecrawlCalls = 0;
  global.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/market-health")) return new Response(html);
    if (url.includes("/_next/data/")) return Response.json(btc);
    if (url.includes("api.shumi.ai")) return Response.json({
      schemaVersion: 1, data: { trends: { UP: 17, DOWN: 47, HODL: 36 } }, meta: { as_of: now.toISOString() },
    });
    firecrawlCalls += 1;
    throw new Error(`Unexpected request: ${url}`);
  };
  try {
    const feed = await fetchCurrentMarketHealth();
    assert.match(feed.source, /^Shumi/);
    assert.deepEqual(feed.health.data.trends, { UP: 17, DOWN: 47, HODL: 36 });
    assert.equal(feed.btc.daily.usd.trend, "DOWN");
    assert.equal(feed.btc.daily.usd.streak, 4);
    assert.equal(feed.btc.weekly.usd.streak, 2);
    assert.equal(firecrawlCalls, 0);
  } finally {
    global.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.SHUMI_API_KEY;
    else process.env.SHUMI_API_KEY = previousKey;
  }
});

test("Shumi quota exhaustion alone activates Firecrawl fallback", async () => {
  const { html, btc } = fixtures();
  const previousFetch = global.fetch;
  const previousShumiKey = process.env.SHUMI_API_KEY;
  const previousFirecrawlKey = process.env.FIRECRAWL_API_KEY;
  process.env.SHUMI_API_KEY = "test-key";
  process.env.FIRECRAWL_API_KEY = "test-key";
  let firecrawlCalls = 0;
  global.fetch = async (input, options) => {
    const url = String(input);
    if (url.endsWith("/market-health")) return new Response(html);
    if (url.includes("/_next/data/")) return Response.json(btc);
    if (url.includes("api.shumi.ai")) return Response.json({ schemaVersion: 1, error: { code: "PAYMENT_REQUIRED" } }, { status: 402 });
    if (url.includes("api.firecrawl.dev")) {
      firecrawlCalls += 1;
      const format = JSON.parse(String(options?.body)).formats[0];
      return Response.json({ data: { [format]: format === "rawHtml" ? html :
        "**Daily Trend** USD: DOWN 4 days **Weekly Trend** USD: DOWN 2 weeks ## Price Data" } });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  try {
    const feed = await fetchCurrentMarketHealth();
    assert.equal(feed.source, "CoinRotator via Firecrawl");
    assert.equal(firecrawlCalls, 2);
    assert.equal(feed.btc.daily.usd.streak, 4);
  } finally {
    global.fetch = previousFetch;
    if (previousShumiKey === undefined) delete process.env.SHUMI_API_KEY;
    else process.env.SHUMI_API_KEY = previousShumiKey;
    if (previousFirecrawlKey === undefined) delete process.env.FIRECRAWL_API_KEY;
    else process.env.FIRECRAWL_API_KEY = previousFirecrawlKey;
  }
});

test("Shumi incomplete market data is rejected without silent fallback", () => {
  assert.throws(() => parseShumiHealth({ schemaVersion: 1, data: { trends: { UP: 1, DOWN: 2 } } }), /incomplete/);
});
