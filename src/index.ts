import fs from "node:fs";
import dotenv from "dotenv";
import { createBrowserContext } from "./browser";
import { dedupeParsedHoldings, normalizeHolding } from "./parser";
import { ensureDirExists, resolveWorkspacePaths } from "./runtime-paths";
import { scrapeWallet } from "./scraper";
import { loadWallets } from "./sheets";
import { createStorage } from "./storage";
import { ScanLogger, WalletScanRecord, WalletScanStatus } from "./types";

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

function parseBool(value: string | undefined, fallback = false): boolean {
  if (!value) return fallback;
  return value.toLowerCase() === "true";
}

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
  const headless = parseBool(process.env.HEADLESS, false);
  const minHoldingUsd = parseNum(process.env.MIN_HOLDING_USD, 1000);
  const delayBetweenWallets = parseNum(process.env.DELAY_BETWEEN_WALLETS_MS, 3000);
  const screenshotsEnabled = parseBool(process.env.SCREENSHOTS_ENABLED, true);
  const includeDefi = parseBool(process.env.INCLUDE_DEFI, false);
  const paths = resolveWorkspacePaths(cwd);

  ensureDirExists(paths.screenshotsDir);
  const storage = createStorage(cwd);

  try {
    const wallets = await loadWallets(cwd);
    logger(`Found ${wallets.length} wallets to process`);
    if (!wallets.length) {
      throw new Error("No wallets found. Configure Google Sheets env or wallets.json fallback.");
    }

    const snapshotId = storage.createSnapshot("full-scan");
    const browserSession = await createBrowserContext({ cwd, headless, logger });
    const page = await browserSession.newPage();

    let holdingsTotal = 0;
    let totalValueUsd = 0;

    for (let i = 0; i < wallets.length; i += 1) {
      const wallet = wallets[i];
      const startedAt = new Date().toISOString();
      logger(`[${i + 1}/${wallets.length}] Processing ${wallet.label}`);

      try {
        const scraped = await scrapeWallet(page, wallet, {
          cwd,
          minHoldingUsd,
          headless,
          screenshotsEnabled,
          screenshotsDir: paths.screenshotsDir,
          includeDefi,
          logger,
        });

        const parsed = dedupeParsedHoldings(
          scraped.tokens
          .map((token) => normalizeHolding(wallet, token))
          .filter((row): row is NonNullable<typeof row> => row !== null),
        );

        storage.insertHoldings(snapshotId, parsed);
        const walletTotal = parsed.reduce((sum, row) => sum + row.valueUsd, 0);
        const status: WalletScanStatus = parsed.length > 0 ? "SUCCESS" : "PARTIAL";
        const record: WalletScanRecord = {
          walletLabel: wallet.label,
          walletUrl: wallet.url,
          status,
          tokensFound: parsed.length,
          totalValueUsd: walletTotal,
          screenshotPath: scraped.screenshotPath,
          errorMessage: null,
          startedAt,
          finishedAt: new Date().toISOString(),
        };
        storage.insertWalletScan(snapshotId, record);

        holdingsTotal += parsed.length;
        totalValueUsd += walletTotal;
        logger(`✓ ${wallet.label} — ${parsed.length} tokens, $${walletTotal.toLocaleString("en-US", { maximumFractionDigits: 2 })}`);
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

    await browserSession.close();
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
