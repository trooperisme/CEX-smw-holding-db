import type { Page } from "playwright";
import { createBrowserContext } from "./browser";
import type { BrowserSession } from "./browser";
import { dedupeParsedHoldings, normalizeHolding } from "./parser";
import { ensureDirExists, resolveWorkspacePaths } from "./runtime-paths";
import { scrapeWallet } from "./scraper";
import { ParsedHolding, RawTokenHolding, ScanLogger, WalletInput } from "./types";

export type WalletScrapeSettings = {
  cwd: string;
  minHoldingUsd: number;
  headless: boolean;
  screenshotsEnabled: boolean;
  screenshotsDir: string;
  includeDefi: boolean;
  logger: ScanLogger;
};

export type WalletScrapeExecutionResult = {
  holdings: ParsedHolding[];
  totalValueUsd: number;
  screenshotPath: string | null;
};

type ResolveWalletScrapeSettingsOptions = {
  cwd?: string;
  logger?: ScanLogger;
  minHoldingUsdDefault: number;
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

export function resolveWalletScrapeSettings(
  options: ResolveWalletScrapeSettingsOptions,
): WalletScrapeSettings {
  const cwd = options.cwd || process.cwd();
  const paths = resolveWorkspacePaths(cwd);
  ensureDirExists(paths.screenshotsDir);

  return {
    cwd,
    minHoldingUsd: parseNum(process.env.MIN_HOLDING_USD, options.minHoldingUsdDefault),
    headless: parseBool(process.env.HEADLESS, false),
    screenshotsEnabled: parseBool(process.env.SCREENSHOTS_ENABLED, true),
    screenshotsDir: paths.screenshotsDir,
    includeDefi: parseBool(process.env.INCLUDE_DEFI, false),
    logger: options.logger || ((line) => console.log(line)),
  };
}

export async function createWalletScrapeSession(
  settings: WalletScrapeSettings,
): Promise<BrowserSession> {
  return createBrowserContext({
    cwd: settings.cwd,
    headless: settings.headless,
    logger: settings.logger,
  });
}

export function buildWalletScrapeExecutionResult(
  wallet: WalletInput,
  tokens: RawTokenHolding[],
  screenshotPath: string | null,
): WalletScrapeExecutionResult {
  const holdings = dedupeParsedHoldings(
    tokens
      .map((token) => normalizeHolding(wallet, token))
      .filter((row): row is ParsedHolding => row !== null),
  );

  return {
    holdings,
    totalValueUsd: holdings.reduce((sum, row) => sum + row.valueUsd, 0),
    screenshotPath,
  };
}

export async function executeWalletScrape(
  page: Page,
  wallet: WalletInput,
  settings: WalletScrapeSettings,
): Promise<WalletScrapeExecutionResult> {
  const scraped = await scrapeWallet(page, wallet, {
    cwd: settings.cwd,
    minHoldingUsd: settings.minHoldingUsd,
    headless: settings.headless,
    screenshotsEnabled: settings.screenshotsEnabled,
    screenshotsDir: settings.screenshotsDir,
    includeDefi: settings.includeDefi,
    logger: settings.logger,
  });

  return buildWalletScrapeExecutionResult(wallet, scraped.tokens, scraped.screenshotPath);
}
