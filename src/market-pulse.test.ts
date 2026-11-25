import test from "node:test";
import assert from "node:assert/strict";
import { createMarketPulseReader } from "./market-pulse";

test("Pulse distinguishes recent fallback, expired cache and recovered upstream", async () => {
  let time = Date.parse("2026-11-25T08:00:00Z");
  let offline = false;
  const read = createMarketPulseReader({ now: () => time, fetcher: (async () => {
    if (offline) throw new Error("offline");
    return Response.json({ asOf: new Date(time).toISOString(), staleAfterMs: 600_000, coins: [{ symbol: "BTCUSDT" }] });
  }) as typeof fetch });
  assert.equal((await read()).stale, false);
  offline = true;
  time += 61_000;
  const fallback = await read();
  assert.equal(fallback.stale, true);
  assert.equal(fallback.unavailable, false);
  assert.equal(fallback.coins.length, 1);
  time += 600_000;
  const expired = await read();
  assert.equal(expired.unavailable, true);
  assert.deepEqual(expired.coins, []);
  offline = false;
  assert.equal((await read()).stale, false);
});

test("fetching old upstream data does not make it fresh", async () => {
  const read = createMarketPulseReader({ now: () => Date.parse("2026-11-25T09:00:00Z"), fetcher: (async () =>
    Response.json({ asOf: "2026-11-25T08:00:00Z", generatedAt: "2026-11-25T09:00:00Z", coins: [{ symbol: "BTCUSDT" }] })) as typeof fetch });
  assert.equal((await read()).unavailable, true);
  assert.deepEqual((await read()).coins, []);
});

test("unavailable or malformed upstream with no cache yields no market numbers", async () => {
  for (const fetcher of [async () => { throw new Error("offline"); }, async () => Response.json({ coins: "invalid" })]) {
    const read = createMarketPulseReader({ fetcher: fetcher as typeof fetch });
    assert.equal((await read()).unavailable, true);
    assert.deepEqual((await read()).coins, []);
  }
});

test("Pulse propagates the source stale flag even inside proxy cache TTL", async () => {
  const time = Date.parse("2026-11-25T08:00:00Z");
  const read = createMarketPulseReader({ now: () => time, fetcher: (async () =>
    Response.json({ asOf: new Date(time).toISOString(), stale: true, coins: [] })) as typeof fetch });
  assert.equal((await read()).stale, true);
  assert.equal((await read()).stale, true);
});
