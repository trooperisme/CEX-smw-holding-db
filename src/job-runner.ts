import dotenv from "dotenv";
import { runQueuedScrapeJobs } from "./job-worker";

dotenv.config();

async function main(): Promise<void> {
  const summary = await runQueuedScrapeJobs({ cwd: process.cwd() });
  console.log(JSON.stringify(summary, null, 2));
}

void main().catch((error) => {
  console.error("Scrape worker failed:", (error as Error)?.message || String(error));
  process.exitCode = 1;
});
