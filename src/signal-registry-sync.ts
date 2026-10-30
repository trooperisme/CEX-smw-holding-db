import { loadTrackedTraders } from "./trader-registry";
import { createSignalStorage } from "./signal-storage";

async function main(): Promise<void> {
  const cwd = process.cwd();
  const traders = loadTrackedTraders(cwd).filter((trader) => trader.isActive);
  if (!traders.length) throw new Error("Tracked trader registry is empty; refusing registry sync");

  const storage = createSignalStorage(cwd);
  try {
    await storage.replaceTrackedTraders(traders);
  } finally {
    storage.close();
  }

  console.log(`Synced ${traders.length} active tracked traders to durable signal storage`);
}

if (require.main === module) {
  void main().catch((error) => {
    console.error("Tracked trader registry sync failed:", (error as Error)?.message || String(error));
    process.exitCode = 1;
  });
}
