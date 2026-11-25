import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { scheduledRefresh } from "./refresh-schedule";

test("displayed refresh windows match the production workflow cron in Vietnam time", () => {
  const workflow = fs.readFileSync(".github/workflows/cex-scheduled-refresh.yml", "utf8");
  const crons = [...workflow.matchAll(/- cron: "([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(crons, scheduledRefresh.utcCrons);
  const localTimes = crons.map((cron) => {
    const [minute, hour] = cron.split(" ").map(Number);
    return new Intl.DateTimeFormat("en-GB", { timeZone: scheduledRefresh.timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .format(new Date(Date.UTC(2026, 10, 25, hour, minute)));
  });
  assert.deepEqual(localTimes, [scheduledRefresh.primaryTime, scheduledRefresh.backupTime]);
});
