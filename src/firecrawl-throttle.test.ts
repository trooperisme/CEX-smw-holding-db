import assert from "node:assert/strict";
import test from "node:test";
import { waitForFirecrawlSlot } from "./firecrawl-throttle";

test("concurrent Firecrawl callers reserve request starts through one limiter", async () => {
  const previous = process.env.FIRECRAWL_MIN_INTERVAL_MS;
  process.env.FIRECRAWL_MIN_INTERVAL_MS = "25";
  try {
    const starts: number[] = [];
    await Promise.all(Array.from({ length: 3 }, async () => {
      await waitForFirecrawlSlot();
      starts.push(Date.now());
    }));
    assert.equal(starts.length, 3);
    assert.ok(starts[1] - starts[0] >= 20);
    assert.ok(starts[2] - starts[1] >= 20);
  } finally {
    if (previous === undefined) delete process.env.FIRECRAWL_MIN_INTERVAL_MS;
    else process.env.FIRECRAWL_MIN_INTERVAL_MS = previous;
  }
});
