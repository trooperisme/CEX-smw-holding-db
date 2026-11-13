import { appendFileSync } from "fs";
import { getSupabaseAdminClient } from "./supabase";

const HOUR_MS = 60 * 60 * 1000;
const VIETNAM_UTC_OFFSET_HOURS = 7;

export function vietnamDayWindow(now: Date): { start: string; end: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const startMs = Date.UTC(value("year"), value("month") - 1, value("day"))
    - VIETNAM_UTC_OFFSET_HOURS * HOUR_MS;
  return {
    start: new Date(startMs).toISOString(),
    end: new Date(startMs + 24 * HOUR_MS).toISOString(),
  };
}

async function hasSuccessfulSnapshot(table: string, start: string, end: string): Promise<boolean> {
  const { data, error } = await getSupabaseAdminClient()
    .from(table)
    .select("id")
    .eq("status", "success")
    .gte("created_at", start)
    .lt("created_at", end)
    .limit(1);
  if (error) throw new Error(`Check ${table}: ${error.message}`);
  return Boolean(data?.length);
}

async function main(): Promise<void> {
  const { start, end } = vietnamDayWindow(new Date());
  const tables = ["signal_snapshots", "spot_snapshots", "open_order_snapshots"];
  const completed = await Promise.all(tables.map((table) => hasSuccessfulSnapshot(table, start, end)));
  const shouldRun = !completed.every(Boolean);
  console.log(`Vietnam day ${start}–${end}: ${tables.map((table, index) => `${table}=${completed[index]}`).join(", ")}; scan=${shouldRun}`);
  const outputPath = process.env.GITHUB_OUTPUT;
  if (outputPath) appendFileSync(outputPath, `should_run=${shouldRun}\n`);
}

if (require.main === module) {
  void main().catch((error) => {
    console.error("Daily snapshot guard failed:", (error as Error)?.message || String(error));
    process.exitCode = 1;
  });
}
