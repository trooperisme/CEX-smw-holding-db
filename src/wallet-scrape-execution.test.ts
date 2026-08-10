import assert from "node:assert/strict";
import test from "node:test";
import { buildWalletScrapeExecutionResult } from "./wallet-scrape-execution";

test("buildWalletScrapeExecutionResult normalizes, dedupes, and totals holdings", () => {
  const result = buildWalletScrapeExecutionResult(
    {
      label: "SMW",
      url: "https://zapper.xyz/account/0x1111111111111111111111111111111111111111",
    },
    [
      {
        symbol: "HYPE",
        name: "HYPE",
        balance: "1K",
        value: "$2,500",
        chain: "HyperEVM",
      },
      {
        symbol: "HYPE",
        name: "HYPE",
        balance: "1K",
        value: "$3,000",
        chain: "hyperevm",
      },
      {
        symbol: "USDC",
        name: "USD Coin",
        balance: "50",
        value: "$50",
        chain: "Base",
      },
      {
        symbol: "",
        name: "",
        balance: "1",
        value: "$10",
        chain: "Base",
      },
    ],
    "screenshots/smw.png",
  );

  assert.equal(result.screenshotPath, "screenshots/smw.png");
  assert.equal(result.holdings.length, 2);
  assert.equal(result.totalValueUsd, 2550);
  assert.deepEqual(
    result.holdings.map((row) => ({
      walletLabel: row.walletLabel,
      tokenSymbol: row.tokenSymbol,
      chain: row.chain,
      balanceNumeric: row.balanceNumeric,
      valueUsd: row.valueUsd,
    })),
    [
      {
        walletLabel: "SMW",
        tokenSymbol: "HYPE",
        chain: "hyperevm",
        balanceNumeric: 1000,
        valueUsd: 2500,
      },
      {
        walletLabel: "SMW",
        tokenSymbol: "USDC",
        chain: "base",
        balanceNumeric: 50,
        valueUsd: 50,
      },
    ],
  );
});
