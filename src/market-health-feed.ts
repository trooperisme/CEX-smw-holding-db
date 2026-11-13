import { fetchFirecrawlMarketHealth } from "./market-health-firecrawl";
import { getSupabaseAdminClient } from "./supabase";

const bucket = "cex-market-regime";
const object = "latest.json";
const maxAgeMs = 36 * 60 * 60 * 1000;
type Trend = "UP" | "DOWN" | "HODL";
type HistoryRow = { date: number; amount: number; trend: Trend };
type Counts = Record<Trend, number>;

class ShumiQuotaError extends Error {}

function freshTimestamp(input: unknown, source: string): number {
  const value = typeof input === "number" ? input : Date.parse(String(input || ""));
  if (!Number.isFinite(value) || value > Date.now() + 5 * 60_000 || Date.now() - value > maxAgeMs) {
    throw new Error(`${source} reading is missing or stale`);
  }
  return value;
}

export function parseShumiHealth(payload: unknown): { counts: Counts; asOf: number } {
  const response = payload as { schemaVersion?: number; data?: { trends?: Record<string, unknown>; timestamp?: string }; meta?: { as_of?: string } };
  const trends = response?.data?.trends;
  if (response?.schemaVersion !== 1 || !trends || !(["UP", "DOWN", "HODL"] as const).every(
    (trend) => Number.isInteger(trends[trend]) && Number(trends[trend]) >= 0,
  )) throw new Error("Shumi market health counts are incomplete");
  const counts = { UP: Number(trends.UP), DOWN: Number(trends.DOWN), HODL: Number(trends.HODL) };
  if (counts.UP + counts.DOWN + counts.HODL === 0) throw new Error("Shumi market health counts are empty");
  return { counts, asOf: freshTimestamp(response.meta?.as_of || response.data?.timestamp, "Shumi market health") };
}

async function fetchShumiHealth() {
  const key = (process.env.SHUMI_API_KEY || process.env.SHUMI_TOKEN)?.trim();
  if (!key) throw new Error("SHUMI_API_KEY is not configured");
  const response = await fetch("https://api.shumi.ai/api/cli/market/health", {
    headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 402 || response.status === 429) throw new ShumiQuotaError(`Shumi quota exhausted (${response.status})`);
  if (!response.ok) throw new Error(`Shumi market health failed (${response.status})`);
  return parseShumiHealth(await response.json());
}

async function fetchDirect(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`CoinRotator direct request failed (${response.status})`);
  return response.text();
}

function parseNextData(html: string) {
  const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) throw new Error("CoinRotator market data missing");
  return JSON.parse(match[1]) as {
    buildId?: string;
    props?: { pageProps?: { marketHealthSeed?: { daily?: Array<{ date: string; amount: number; trend: Trend }>; lastUpdated?: number } } };
  };
}

export function parseCoinRotatorHistory(seed: { daily?: Array<{ date: string; amount: number; trend: Trend }>; lastUpdated?: number } | undefined): HistoryRow[] {
  if (!Array.isArray(seed?.daily) || seed.daily.length < 60) throw new Error("CoinRotator daily history incomplete");
  const updatedAt = freshTimestamp(seed.lastUpdated, "CoinRotator history");
  const year = new Date(updatedAt).getUTCFullYear();
  return seed.daily.map((row) => {
    let date = Date.parse(`${row.date}, ${year} UTC`);
    if (date > updatedAt + 24 * 60 * 60 * 1000) date = Date.parse(`${row.date}, ${year - 1} UTC`);
    if (!Number.isFinite(date) || !Number.isInteger(row.amount) || row.amount < 0 || !["UP", "DOWN", "HODL"].includes(row.trend)) {
      throw new Error("Invalid CoinRotator history row");
    }
    return { date, amount: row.amount, trend: row.trend };
  });
}

function parseBtcLeg(value: unknown, unit: "days" | "weeks") {
  const leg = value as { trend?: string; streak?: number } | undefined;
  if (!leg || !["UP", "DOWN"].includes(String(leg.trend)) || !Number.isInteger(leg.streak) || Number(leg.streak) < 1) {
    throw new Error(`CoinRotator BTC USD ${unit} trend unavailable`);
  }
  return { usd: { trend: leg.trend as "UP" | "DOWN", streak: Number(leg.streak), unit } };
}

export function parseCoinRotatorBtc(payload: unknown) {
  const page = (payload as { pageProps?: { id?: string; signals?: { "1d"?: { usd?: unknown }; "1w"?: { usd?: unknown }; snapshotAt?: string } } }).pageProps;
  if (page?.id !== "bitcoin" || !page.signals) throw new Error("CoinRotator BTC signals missing");
  const capturedAt = new Date(freshTimestamp(page.signals.snapshotAt, "CoinRotator BTC")).toISOString();
  return { asset: "BTC", capturedAt, daily: parseBtcLeg(page.signals["1d"]?.usd, "days"), weekly: parseBtcLeg(page.signals["1w"]?.usd, "weeks") };
}

function withShumiLatest(history: HistoryRow[], counts: Counts, asOf: number): HistoryRow[] {
  const day = Date.UTC(new Date(asOf).getUTCFullYear(), new Date(asOf).getUTCMonth(), new Date(asOf).getUTCDate());
  if (day < Math.max(...history.map((row) => row.date))) throw new Error("Shumi reading predates CoinRotator history");
  return [
    ...history.filter((row) => row.date !== day),
    ...(["UP", "DOWN", "HODL"] as const).map((trend) => ({ date: day, amount: counts[trend], trend })),
  ];
}

async function fetchDirectContext() {
  const html = await fetchDirect("https://coinrotator.app/market-health");
  const nextData = parseNextData(html);
  const history = parseCoinRotatorHistory(nextData.props?.pageProps?.marketHealthSeed);
  if (!nextData.buildId) throw new Error("CoinRotator build ID missing");
  const btcJson = await fetchDirect(`https://coinrotator.app/_next/data/${encodeURIComponent(nextData.buildId)}/coin/bitcoin.json?tab=analysis`);
  return { history, btc: parseCoinRotatorBtc(JSON.parse(btcJson)) };
}

export async function fetchCurrentMarketHealth() {
  let shumi;
  try {
    shumi = await fetchShumiHealth();
  } catch (error) {
    if (!(error instanceof ShumiQuotaError)) throw error;
    const fallback = await fetchFirecrawlMarketHealth();
    return { ...fallback, shumiAttemptedAt: new Date().toISOString() };
  }
  const context = await fetchDirectContext();
  const capturedAt = new Date().toISOString();
  const trends = shumi.counts;
  return {
    source: "Shumi market health; CoinRotator chart/BTC", capturedAt, shumiAttemptedAt: capturedAt,
    health: { data: { trends, total: trends.UP + trends.DOWN + trends.HODL, reading: { comparison: {} } } },
    history: { data: withShumiLatest(context.history, trends, shumi.asOf) },
    btc: context.btc,
  };
}

let inFlight: Promise<Awaited<ReturnType<typeof fetchCurrentMarketHealth>>> | null = null;

async function getOrRefreshMarketHealthFeed() {
  const supabase = getSupabaseAdminClient();
  const existing = await supabase.storage.from(bucket).download(object);
  if (existing.data) {
    const cached = JSON.parse(await existing.data.text());
    if (cached.shumiAttemptedAt && new Date(cached.shumiAttemptedAt).toISOString().slice(0, 10) === new Date().toISOString().slice(0, 10)) return cached;
  }
  const fresh = await fetchCurrentMarketHealth();
  await supabase.storage.createBucket(bucket, { public: false });
  const saved = await supabase.storage.from(bucket).upload(object, Buffer.from(JSON.stringify(fresh)), { contentType: "application/json", upsert: true });
  if (saved.error) throw new Error(`Market feed storage failed: ${saved.error.message}`);
  return fresh;
}

export async function getMarketHealthFeed() {
  if (!inFlight) {
    inFlight = getOrRefreshMarketHealthFeed().finally(() => { inFlight = null; });
  }
  return inFlight;
}
