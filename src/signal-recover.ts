import dotenv from "dotenv";
import { runSignalRefresh } from "./signal-refresh";
import { createSignalStorage } from "./signal-storage";

dotenv.config();

async function main(): Promise<void> {
  const snapshotId = Number(process.argv[2]);
  if (!Number.isSafeInteger(snapshotId) || snapshotId <= 0) {
    throw new Error("Pass the partial signal snapshot ID to recover");
  }

  const storage = createSignalStorage(process.cwd());
  let traders;
  try {
    traders = await storage.getTrackedTraders();
  } finally {
    storage.close();
  }

  const result = await runSignalRefresh({
    snapshotId,
    traders,
    replaceTrackedTraders: false,
    retryFailed: true,
    requireNonemptyOutput: true,
    logger: (line) => console.log(`[signal-recover] ${line}`),
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== "success") process.exitCode = 1;
}

if (require.main === module) {
  void main().catch((error) => {
    console.error("Signal snapshot recovery failed:", (error as Error)?.message || String(error));
    process.exitCode = 1;
  });
}
