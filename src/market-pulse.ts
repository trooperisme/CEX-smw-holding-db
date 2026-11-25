type PulsePayload = { asOf: string; coins: unknown[]; generatedAt?: string; staleAfterMs?: number; stale?: boolean; [key: string]: unknown };
type PulseResult = PulsePayload & { stale: boolean; unavailable: boolean; fetchedAt: string | null };

// The source currently declares a ten-minute stale interval. Never extend it
// just because the proxy successfully fetched an old upstream response.
const MAX_AGE_MS = 10 * 60_000;

export function createMarketPulseReader(options: { fetcher?: typeof fetch; now?: () => number } = {}) {
  const fetcher = options.fetcher || fetch;
  const now = options.now || Date.now;
  let cache: { fetchedAt: number; payload: PulsePayload } | null = null;
  let pending: Promise<PulseResult> | null = null;

  function result(fallback: boolean): PulseResult {
    if (!cache) return { asOf: "", coins: [], stale: true, unavailable: true, fetchedAt: null };
    const payload = cache.payload;
    const limit = Math.min(MAX_AGE_MS, Number(payload.staleAfterMs) > 0 ? Number(payload.staleAfterMs) : MAX_AGE_MS);
    const sourceTimes = [Date.parse(payload.asOf), Date.parse(payload.generatedAt || payload.asOf)];
    const expired = sourceTimes.some((time) => !Number.isFinite(time) || now() - time > limit || time > now() + 60_000);
    return { ...payload, coins: expired ? [] : payload.coins, stale: expired || fallback || payload.stale === true,
      unavailable: expired, fetchedAt: new Date(cache.fetchedAt).toISOString() };
  }

  return async function readMarketPulse(): Promise<PulseResult> {
    if (cache && now() - cache.fetchedAt < 60_000) return result(false);
    if (pending) return pending;
    pending = (async () => {
      try {
        const response = await fetcher("https://koalabot.io/api/market-pulse", { signal: AbortSignal.timeout(8_000) });
        if (!response.ok) throw new Error(`Market Pulse returned ${response.status}`);
        const payload = await response.json() as PulsePayload;
        if (!payload || !Number.isFinite(Date.parse(payload.asOf)) || !Array.isArray(payload.coins)) {
          throw new Error("Market Pulse returned an invalid payload");
        }
        cache = { fetchedAt: now(), payload };
        return result(false);
      } catch {
        return result(true);
      } finally {
        pending = null;
      }
    })();
    return pending;
  };
}
