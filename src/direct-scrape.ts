import dotenv from "dotenv";
import { createBrowserContext } from "./browser";
import { dedupeParsedHoldings, normalizeHolding } from "./parser";
import { ensureDirExists, resolveWorkspacePaths } from "./runtime-paths";
import { scrapeWallet } from "./scraper";
import { WalletInput } from "./types";

dotenv.config();

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

async function main(): Promise<void> {
  const fullUrl = process.argv[2];
  const label = process.argv[3] || "Direct Link";
  if (!fullUrl || !/^https?:\/\//i.test(fullUrl)) {
    throw new Error("Usage: ts-node src/direct-scrape.ts <full_wallet_url> [label]");
  }

  const cwd = process.cwd();
  const headless = parseBool(process.env.HEADLESS, false);
  const minHoldingUsd = parseNum(process.env.MIN_HOLDING_USD, 555);
  const screenshotsEnabled = parseBool(process.env.SCREENSHOTS_ENABLED, true);
  const includeDefi = parseBool(process.env.INCLUDE_DEFI, false);
  const paths = resolveWorkspacePaths(cwd);
  ensureDirExists(paths.screenshotsDir);

  const browserSession = await createBrowserContext({
    cwd,
    headless,
    logger: (line) => console.log(line),
  });

  try {
    const page = await browserSession.newPage();
    const wallet: WalletInput = {
      label,
      url: fullUrl,
    };

    const scraped = await scrapeWallet(page, wallet, {
      cwd,
      minHoldingUsd,
      headless,
      screenshotsEnabled,
      screenshotsDir: paths.screenshotsDir,
      includeDefi,
      logger: (line) => console.log(line),
    });

    const parsed = dedupeParsedHoldings(
      scraped.tokens
        .map((token) => normalizeHolding(wallet, token))
        .filter((row): row is NonNullable<typeof row> => row !== null),
    );

    const totalUsd = parsed.reduce((sum, row) => sum + row.valueUsd, 0);

    console.log(
      JSON.stringify(
        {
          label,
          url: fullUrl,
          minHoldingUsd,
          tokensFound: parsed.length,
          totalUsd,
          screenshotPath: scraped.screenshotPath,
          holdings: parsed
            .sort((a, b) => b.valueUsd - a.valueUsd)
            .map((row) => ({
              tokenSymbol: row.tokenSymbol,
              tokenName: row.tokenName,
              chain: row.chain,
              balanceRaw: row.balanceRaw,
              valueUsd: row.valueUsd,
            })),
        },
        null,
        2,
      ),
    );
  } finally {
    await browserSession.close();
  }
}

void main().catch((error) => {
  console.error("Direct scrape failed:", (error as Error)?.message || String(error));
  process.exitCode = 1;
});
