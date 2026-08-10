import dotenv from "dotenv";
import { WalletInput } from "./types";
import {
  createWalletScrapeSession,
  executeWalletScrape,
  resolveWalletScrapeSettings,
} from "./wallet-scrape-execution";

dotenv.config();

async function main(): Promise<void> {
  const fullUrl = process.argv[2];
  const label = process.argv[3] || "Direct Link";
  if (!fullUrl || !/^https?:\/\//i.test(fullUrl)) {
    throw new Error("Usage: ts-node src/direct-scrape.ts <full_wallet_url> [label]");
  }

  const cwd = process.cwd();
  const logger = (line: string) => console.log(line);
  const scrapeSettings = resolveWalletScrapeSettings({
    cwd,
    logger,
    minHoldingUsdDefault: 555,
  });

  const browserSession = await createWalletScrapeSession(scrapeSettings);

  try {
    const page = await browserSession.newPage();
    const wallet: WalletInput = {
      label,
      url: fullUrl,
    };

    const scraped = await executeWalletScrape(page, wallet, scrapeSettings);

    console.log(
      JSON.stringify(
        {
          label,
          url: fullUrl,
          minHoldingUsd: scrapeSettings.minHoldingUsd,
          tokensFound: scraped.holdings.length,
          totalUsd: scraped.totalValueUsd,
          screenshotPath: scraped.screenshotPath,
          holdings: scraped.holdings
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
