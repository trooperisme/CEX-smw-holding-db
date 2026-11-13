type Trend = "UP" | "DOWN";

function parseBtcLeg(section: string, unit: "days" | "weeks") {
  const match = section.match(/USD:\s*(UP|DOWN)\s*(\d+)\s*(days?|weeks?)/i);
  if (!match || !match[3].toLowerCase().startsWith(unit.slice(0, -1))) throw new Error(`BTC USD ${unit} trend unavailable`);
  return { usd: { trend: match[1].toUpperCase() as Trend, streak: Number(match[2]), unit } };
}

async function scrape(url: string, format: "rawHtml" | "markdown"): Promise<string> {
  const key = process.env.FIRECRAWL_API_KEY?.trim();
  if (!key) throw new Error("FIRECRAWL_API_KEY is not configured");
  const response = await fetch("https://api.firecrawl.dev/v2/scrape", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ url, formats: [format], maxAge: 0, storeInCache: false, onlyMainContent: false }),
    signal: AbortSignal.timeout(40_000),
  });
  if (!response.ok) throw new Error(`Firecrawl HTTP ${response.status}`);
  const payload = await response.json() as { data?: Record<string, string> };
  const content = payload.data?.[format];
  if (!content) throw new Error(`Firecrawl ${format} missing`);
  return content;
}

export async function fetchFirecrawlMarketHealth() {
  const [html, btcMarkdown] = await Promise.all([
    scrape("https://coinrotator.app/market-health", "rawHtml"),
    scrape("https://coinrotator.app/coin/bitcoin?tab=analysis", "markdown"),
  ]);
  const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) throw new Error("CoinRotator market data missing");
  const seed = JSON.parse(match[1])?.props?.pageProps?.marketHealthSeed;
  if (!Array.isArray(seed?.daily) || seed.daily.length < 60) throw new Error("CoinRotator daily history incomplete");
  const updatedAt = Number(seed.lastUpdated);
  if (!Number.isFinite(updatedAt) || Date.now() - updatedAt > 36 * 60 * 60 * 1000) throw new Error("CoinRotator market reading is stale");
  const year = new Date(updatedAt).getUTCFullYear();
  const history = seed.daily.map((row: { date: string; amount: number; trend: string }) => {
    let date = Date.parse(`${row.date}, ${year} UTC`);
    if (date > updatedAt + 24 * 60 * 60 * 1000) date = Date.parse(`${row.date}, ${year - 1} UTC`);
    if (!Number.isFinite(date) || !Number.isInteger(row.amount) || row.amount < 0 || !["UP", "DOWN", "HODL"].includes(row.trend)) throw new Error("Invalid daily breadth row");
    return { date, amount: row.amount, trend: row.trend };
  });
  const latestDate = Math.max(...history.map((row: { date: number }) => row.date));
  const latest = history.filter((row: { date: number }) => row.date === latestDate);
  if (latest.length !== 3) throw new Error("Latest breadth reading incomplete");
  const counts = Object.fromEntries(latest.map((row: { trend: string; amount: number }) => [row.trend, row.amount]));
  const daily = btcMarkdown.match(/\*\*Daily Trend\*\*([\s\S]*?)\*\*Weekly Trend\*\*/i)?.[1];
  const weekly = btcMarkdown.match(/\*\*Weekly Trend\*\*([\s\S]*?)(?:## Price Data|## Analysis)/i)?.[1];
  if (!daily || !weekly) throw new Error("BTC trend sections missing");
  const capturedAt = new Date().toISOString();
  return {
    source: "CoinRotator via Firecrawl", capturedAt,
    health: { data: { trends: counts, total: latest.reduce((sum: number, row: { amount: number }) => sum + row.amount, 0), reading: { comparison: {} } } },
    history: { data: history },
    btc: { asset: "BTC", capturedAt, daily: parseBtcLeg(daily, "days"), weekly: parseBtcLeg(weekly, "weeks") },
  };
}
