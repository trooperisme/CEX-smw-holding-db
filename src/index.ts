import dotenv from "dotenv";
import { loadWallets } from "./sheets";
import { createStorage } from "./storage";
import { ScanLogger, WalletScanRecord, WalletScanStatus } from "./types";
import {
  createWalletScrapeSession,
  executeWalletScrape,
  resolveWalletScrapeSettings,
} from "./wallet-scrape-execution";

dotenv.config();

type ScanResult = {
  snapshotId: number;
  walletsTotal: number;
  holdingsTotal: number;
  totalValueUsd: number;
};

export type RunScanOptions = {
  cwd?: string;
  logger?: ScanLogger;
};

function parseNum(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return num;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function classifyError(error: unknown): WalletScanStatus {
  const message = String((error as Error)?.message || "").toLowerCase();
  if (message.includes("cloudflare")) return "FAILED_CF";
  if (message.includes("timeout")) return "FAILED_TIMEOUT";
  if (message.includes("token") || message.includes("selector")) return "FAILED_SELECTOR";
  return "FAILED_UNKNOWN";
}

export async function runFullScan(options: RunScanOptions = {}): Promise<ScanResult> {
  const cwd = options.cwd || process.cwd();
  const logger: ScanLogger = options.logger || ((line) => console.log(line));
  const delayBetweenWallets = parseNum(process.env.DELAY_BETWEEN_WALLETS_MS, 3000);
  const scrapeSettings = resolveWalletScrapeSettings({
    cwd,
    logger,
    minHoldingUsdDefault: 1000,
  });

  const storage = createStorage(cwd);

  try {
    const wallets = await loadWallets(cwd);
    logger(`Found ${wallets.length} wallets to process`);
    if (!wallets.length) {
      throw new Error("No wallets found. Configure Google Sheets env or wallets.json fallback.");
    }

    const snapshotId = storage.createSnapshot("full-scan");
    const browserSession = await createWalletScrapeSession(scrapeSettings);
    const page = await browserSession.newPage();

    let holdingsTotal = 0;
    let totalValueUsd = 0;

    try {
      for (let i = 0; i < wallets.length; i += 1) {
        const wallet = wallets[i];
        const startedAt = new Date().toISOString();
        logger(`[${i + 1}/${wallets.length}] Processing ${wallet.label}`);

        try {
          const scraped = await executeWalletScrape(page, wallet, scrapeSettings);

          storage.insertHoldings(snapshotId, scraped.holdings);
          const status: WalletScanStatus = scraped.holdings.length > 0 ? "SUCCESS" : "PARTIAL";
          const record: WalletScanRecord = {
            walletLabel: wallet.label,
            walletUrl: wallet.url,
            status,
            tokensFound: scraped.holdings.length,
            totalValueUsd: scraped.totalValueUsd,
            screenshotPath: scraped.screenshotPath,
            errorMessage: null,
            startedAt,
            finishedAt: new Date().toISOString(),
          };
          storage.insertWalletScan(snapshotId, record);

          holdingsTotal += scraped.holdings.length;
          totalValueUsd += scraped.totalValueUsd;
          logger(
            `✓ ${wallet.label} — ${scraped.holdings.length} tokens, $${scraped.totalValueUsd.toLocaleString("en-US", { maximumFractionDigits: 2 })}`,
          );
        } catch (error) {
          const status = classifyError(error);
          const record: WalletScanRecord = {
            walletLabel: wallet.label,
            walletUrl: wallet.url,
            status,
            tokensFound: 0,
            totalValueUsd: 0,
            screenshotPath: null,
            errorMessage: (error as Error)?.message || String(error),
            startedAt,
            finishedAt: new Date().toISOString(),
          };
          storage.insertWalletScan(snapshotId, record);
          logger(`✗ ${wallet.label} — ${record.errorMessage}`);
        }

        if (i < wallets.length - 1) {
          await delay(delayBetweenWallets);
        }
      }
    } finally {
      await browserSession.close();
    }

    logger(`Scan complete. Snapshot #${snapshotId}. ${holdingsTotal} holdings, $${totalValueUsd.toLocaleString("en-US", { maximumFractionDigits: 2 })} total.`);

    return {
      snapshotId,
      walletsTotal: wallets.length,
      holdingsTotal,
      totalValueUsd,
    };
  } finally {
    storage.close();
  }
}

if (require.main === module) {
  runFullScan().catch((error) => {
    console.error("Scan failed:", error);
    process.exitCode = 1;
  });
}
