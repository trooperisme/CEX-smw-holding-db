import assert from "node:assert/strict";
import test from "node:test";
import { vietnamDayWindow } from "./signal-daily-guard";

test("Vietnam day window spans the local date across UTC midnight", () => {
  assert.deepEqual(vietnamDayWindow(new Date("2026-11-12T19:17:00Z")), {
    start: "2026-11-12T17:00:00.000Z",
    end: "2026-11-13T17:00:00.000Z",
  });
  assert.deepEqual(vietnamDayWindow(new Date("2026-11-13T00:00:00Z")), {
    start: "2026-11-12T17:00:00.000Z",
    end: "2026-11-13T17:00:00.000Z",
  });
});
