import dotenv from "dotenv";
import { runSheetSyncToSupabase } from "./sync";

dotenv.config();

async function main(): Promise<void> {
  const summary = await runSheetSyncToSupabase({ cwd: process.cwd() });
  console.log(JSON.stringify(summary, null, 2));
}

void main().catch((error) => {
  console.error("Sheet sync failed:", (error as Error)?.message || String(error));
  process.exitCode = 1;
});
