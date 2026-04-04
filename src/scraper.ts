import path from "node:path";
import { Page } from "playwright";
import { ensureCloudflareCleared } from "./browser";
import { toWorkspaceRelativePath } from "./runtime-paths";
import { RawTokenHolding, ScanLogger, WalletInput } from "./types";

type ScrapeOptions = {
  cwd: string;
  minHoldingUsd: number;
  headless: boolean;
  screenshotsEnabled: boolean;
  screenshotsDir: string;
  includeDefi: boolean;
  logger: ScanLogger;
};

type ScrapeResult = {
  tokens: RawTokenHolding[];
  screenshotPath: string | null;
};

const SELECTORS = {
  tokensTab: [
    { kind: "role", value: "Tokens" },
    { kind: "css", value: 'a[href*="/tokens"]' },
    { kind: "css", value: 'nav a:has-text("Tokens")' },
    { kind: "xpath", value: '//a[contains(text(), "Tokens")]' },
  ],
  tokenListContainers: [
    '[data-testid="token-list"]',
    '[data-testid*="token"]',
    '[role="table"]',
    '[role="list"]',
  ],
  filterInput: [
    { kind: "label", value: "Only Show Balances Above" },
    { kind: "css", value: 'input[placeholder*="1000"]' },
    { kind: "css", value: 'input[placeholder*="amount"]' },
  ],
  showMoreButtons: ['button:has-text("Show More")', 'button:has-text("Load More")'],
  tokenRows: ['[data-testid="token-row"]', ".token-item", ".asset-row", '[role="row"]'],
};

const MAX_SCRAPE_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = [2000, 5000];

const CHAIN_SLUG_ALIASES: Record<string, string> = {
  "binance-smart-chain": "binancesmartchain",
  bsc: "binancesmartchain",
  binance: "binancesmartchain",
  base: "base",
  ethereum: "ethereum",
  arbitrum: "arbitrum",
  solana: "solana",
  hyperevm: "hyperevm",
  worldchain: "worldchain",
  world: "worldchain",
  unichain: "unichain",
  sonic: "sonic",
  monad: "monad",
  optimism: "optimism",
  polygon: "polygon",
  zksync: "zksync",
  zora: "zora",
  blast: "blast",
  mode: "mode",
  linea: "linea",
  scroll: "scroll",
  taiko: "taiko",
  morph: "morph",
  opbnb: "opbnb",
  celo: "celo",
  flow: "flow",
  gnosis: "gnosis",
  rootstock: "rootstock",
  ronin: "ronin",
  zero: "zero",
  abstract: "abstract",
  apechain: "apechain",
  superseed: "superseed",
  lens: "lens",
  mantle: "mantle",
  ink: "ink",
};

function normalizeChainSlug(input: string): string {
  const cleaned = input.trim().toLowerCase().replace(/\s+/g, "");
  if (!cleaned) return "unknown";
  const noSuffix = cleaned.replace(/icon$/, "");
  return CHAIN_SLUG_ALIASES[noSuffix] || CHAIN_SLUG_ALIASES[cleaned] || noSuffix;
}

function extractChainFromTokenCell(row: Element): string {
  const tokenCell = row.querySelector("td");
  if (!tokenCell) return "unknown";

  const chainImg = Array.from(tokenCell.querySelectorAll("img")).find((img) => {
    const src = img.getAttribute("src") || "";
    const alt = (img.getAttribute("alt") || "").toLowerCase();
    return /\/networks\//i.test(src) || /icon$/i.test(alt);
  });

  if (!chainImg) return "unknown";

  const src = chainImg.getAttribute("src") || "";
  const fromSrc = src.match(/\/networks\/([a-z0-9-]+)-icon\.png/i)?.[1];
  if (fromSrc) return normalizeChainSlug(fromSrc);

  const alt = chainImg.getAttribute("alt") || "";
  return normalizeChainSlug(alt.replace(/\s*icon$/i, ""));
}

function sanitizeLabel(label: string): string {
  return label.replace(/[^a-zA-Z0-9-_]/g, "_").slice(0, 100);
}

function getAccountIdFromUrl(url: string): string | null {
  const match = url.match(/\/account\/([^/?#]+)/i);
  return match?.[1] || null;
}

async function openWalletFromZapperSearch(
  page: Page,
  walletUrl: string,
  options: Pick<ScrapeOptions, "headless" | "logger">,
): Promise<void> {
  const accountId = getAccountIdFromUrl(walletUrl);
  if (!accountId) {
    await page.goto(walletUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    return;
  }

  await page.goto("https://zapper.xyz", { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(1_200);
  await ensureCloudflareCleared(page, {
    headless: options.headless,
    logger: options.logger,
  });

  const searchCandidates = [
    page.getByPlaceholder(/search accounts, nfts, tokens/i).first(),
    page.locator('input[placeholder*="Search accounts"]').first(),
    page.locator('input[aria-label*="Search"]').first(),
  ];

  let searched = false;
  for (const input of searchCandidates) {
    const visible = await input.isVisible().catch(() => false);
    if (!visible) continue;
    await input.click({ timeout: 5_000 }).catch(() => undefined);
    await input.fill(accountId).catch(() => undefined);
    await page.keyboard.press("Enter").catch(() => undefined);
    searched = true;
    break;
  }

  if (!searched) {
    throw new Error("Unable to find Zapper search box on homepage");
  }

  await page.waitForURL(new RegExp(`/account/${accountId}`, "i"), { timeout: 25_000 }).catch(() => {
    throw new Error(`Search did not navigate to account page for ${accountId}`);
  });
}

async function clickTokensTab(page: Page): Promise<boolean> {
  try {
    const byRoleTab = page.getByRole("tab", { name: "Tokens", exact: false }).first();
    if ((await byRoleTab.count()) > 0) {
      await byRoleTab.click({ timeout: 10_000 });
      return true;
    }
  } catch {
    // noop
  }

  try {
    const byRoleButton = page.getByRole("button", { name: "Tokens", exact: false }).first();
    if ((await byRoleButton.count()) > 0) {
      await byRoleButton.click({ timeout: 10_000 });
      return true;
    }
  } catch {
    // noop
  }

  try {
    const byRole = page.getByRole("link", { name: "Tokens", exact: false }).first();
    if ((await byRole.count()) > 0) {
      await byRole.click({ timeout: 10_000 });
      return true;
    }
  } catch {
    // noop
  }

  for (const selector of SELECTORS.tokensTab) {
    try {
      if (selector.kind === "css") {
        const node = page.locator(selector.value).first();
        if ((await node.count()) > 0) {
          await node.click({ timeout: 10_000 });
          return true;
        }
      } else if (selector.kind === "xpath") {
        const node = page.locator(`xpath=${selector.value}`).first();
        if ((await node.count()) > 0) {
          await node.click({ timeout: 10_000 });
          return true;
        }
      }
    } catch {
      // try next selector
    }
  }

  try {
    const byText = page.locator('text=/^Tokens$/i').first();
    if ((await byText.count()) > 0) {
      await byText.click({ timeout: 10_000 });
      return true;
    }
  } catch {
    // noop
  }

  return false;
}

async function waitForTokensList(page: Page): Promise<void> {
  for (const selector of SELECTORS.tokenListContainers) {
    try {
      await page.waitForSelector(selector, { timeout: 8_000 });
      return;
    } catch {
      // try next
    }
  }
  await page.waitForTimeout(2_000);
}

async function applyMinFilter(page: Page, minHoldingUsd: number): Promise<void> {
  try {
    const byLabel = page.getByLabel("Only Show Balances Above").first();
    if ((await byLabel.count()) > 0) {
      await byLabel.click({ timeout: 5_000 });
      await byLabel.fill(String(minHoldingUsd));
      await page.keyboard.press("Enter");
      await page.waitForTimeout(1_500);
      return;
    }
  } catch {
    // continue fallback
  }

  for (const selector of SELECTORS.filterInput) {
    if (selector.kind !== "css") continue;
    try {
      const node = page.locator(selector.value).first();
      if ((await node.count()) === 0) continue;
      await node.click({ timeout: 5_000 });
      await node.fill(String(minHoldingUsd));
      await page.keyboard.press("Enter");
      await page.waitForTimeout(1_500);
      return;
    } catch {
      // try next
    }
  }
}

async function expandAllRows(page: Page): Promise<void> {
  for (let i = 0; i < 30; i += 1) {
    let clicked = false;
    for (const selector of SELECTORS.showMoreButtons) {
      const button = page.locator(selector).first();
      const visible = await button.isVisible().catch(() => false);
      if (!visible) continue;
      await button.click({ timeout: 5_000 }).catch(() => undefined);
      clicked = true;
      await page.waitForTimeout(1_200);
    }

    if (!clicked) {
      // Virtualized list fallback: scroll to trigger lazy rows.
      await page.mouse.wheel(0, 2500);
      await page.waitForTimeout(600);
      const anyButtonLeft = await Promise.all(
        SELECTORS.showMoreButtons.map((selector) =>
          page.locator(selector).first().isVisible().catch(() => false),
        ),
      );
      if (!anyButtonLeft.some(Boolean)) {
        break;
      }
    }
  }
}

async function extractTokensFromDom(page: Page, includeDefi: boolean): Promise<RawTokenHolding[]> {
  return page.evaluate(
    ({ rowSelectors, includeDefiFlag }) => {
      const getText = (element: Element | null): string => element?.textContent?.trim() || "";
      const CHAIN_SLUG_ALIASES: Record<string, string> = {
        "binance-smart-chain": "binancesmartchain",
        bsc: "binancesmartchain",
        binance: "binancesmartchain",
        base: "base",
        ethereum: "ethereum",
        arbitrum: "arbitrum",
        solana: "solana",
        hyperevm: "hyperevm",
        worldchain: "worldchain",
        world: "worldchain",
        unichain: "unichain",
        sonic: "sonic",
        monad: "monad",
        optimism: "optimism",
        polygon: "polygon",
        zksync: "zksync",
        zora: "zora",
        blast: "blast",
        mode: "mode",
        linea: "linea",
        scroll: "scroll",
        taiko: "taiko",
        morph: "morph",
        opbnb: "opbnb",
        celo: "celo",
        flow: "flow",
        gnosis: "gnosis",
        rootstock: "rootstock",
        ronin: "ronin",
        zero: "zero",
        abstract: "abstract",
        apechain: "apechain",
        superseed: "superseed",
        lens: "lens",
        mantle: "mantle",
        ink: "ink",
      };
      const normalizeChainSlug = (input: string): string => {
        const cleaned = input.trim().toLowerCase().replace(/\s+/g, "");
        if (!cleaned) return "unknown";
        const noSuffix = cleaned.replace(/icon$/, "");
        return CHAIN_SLUG_ALIASES[noSuffix] || CHAIN_SLUG_ALIASES[cleaned] || noSuffix;
      };
      const extractChainFromTokenCell = (row: Element): string => {
        const tokenCell = row.querySelector("td");
        if (!tokenCell) return "unknown";
        const chainImg = Array.from(tokenCell.querySelectorAll("img")).find((img) => {
          const src = img.getAttribute("src") || "";
          const alt = (img.getAttribute("alt") || "").toLowerCase();
          return /\/networks\//i.test(src) || /icon$/i.test(alt);
        });
        if (!chainImg) return "unknown";
        const src = chainImg.getAttribute("src") || "";
        const fromSrc = src.match(/\/networks\/([a-z0-9-]+)-icon\.png/i)?.[1];
        if (fromSrc) return normalizeChainSlug(fromSrc);
        const alt = chainImg.getAttribute("alt") || "";
        return normalizeChainSlug(alt.replace(/\s*icon$/i, ""));
      };
      const rows = rowSelectors.flatMap((selector) =>
        Array.from(document.querySelectorAll(selector)),
      );
      rows.push(...Array.from(document.querySelectorAll("tr")));

      const uniqueRows = Array.from(new Set(rows));
      const result: RawTokenHolding[] = [];
      const dedupe = new Set<string>();

      for (const row of uniqueRows) {
        const sectionText = row.closest("section,div,article")?.textContent?.toLowerCase() || "";
        if (!includeDefiFlag && sectionText.includes("defi")) {
          continue;
        }

        const cells = Array.from(row.querySelectorAll("td"));
        if (cells.length >= 4) {
          const tokenCellText = getText(cells[0]);
          const tokenCellLines = tokenCellText
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean);
          const symbolFromCell =
            getText(cells[0].querySelector('[data-testid="token-symbol"]')) || tokenCellLines[0] || "";
          const nameFromCell =
            getText(cells[0].querySelector('[data-testid="token-name"]')) || tokenCellLines[0] || "";
          const balanceFromCell = getText(cells[2]);
          const valueFromCell = getText(cells[3]);
          const chainFromCell = getText(cells[0].querySelector('[data-testid="token-chain"]')) || extractChainFromTokenCell(row) || "unknown";

          if (symbolFromCell && valueFromCell && /\$\s?\d/.test(valueFromCell)) {
            const key = `${symbolFromCell}|${balanceFromCell}|${valueFromCell}|${chainFromCell}`;
            if (!dedupe.has(key)) {
              dedupe.add(key);
              result.push({
                symbol: symbolFromCell,
                name: nameFromCell,
                balance: balanceFromCell,
                value: valueFromCell,
                chain: chainFromCell,
              });
            }
            continue;
          }
        }

        const symbol =
          getText(row.querySelector('[data-testid="token-symbol"]')) ||
          getText(row.querySelector('[aria-label*="symbol" i]')) ||
          getText(row.querySelector("td:nth-child(1), div:nth-child(1)"));

        const name =
          getText(row.querySelector('[data-testid="token-name"]')) ||
          getText(row.querySelector('[aria-label*="name" i]'));

        const balance =
          getText(row.querySelector('[data-testid="token-balance"]')) ||
          getText(row.querySelector('[aria-label*="balance" i]')) ||
          getText(row.querySelector("td:nth-child(2), div:nth-child(2)"));

        const value =
          getText(row.querySelector('[data-testid="token-value"]')) ||
          getText(row.querySelector('[aria-label*="value" i]')) ||
          getText(row.querySelector("td:last-child, div:last-child"));

        const chain =
          getText(row.querySelector('[data-testid="token-chain"]')) ||
          getText(row.querySelector('[aria-label*="chain" i]')) ||
          extractChainFromTokenCell(row) ||
          "unknown";

        if (symbol && value && /\$?\d/.test(value)) {
          const key = `${symbol}|${balance}|${value}|${chain}`;
          if (!dedupe.has(key)) {
            dedupe.add(key);
            result.push({ symbol, name, balance, value, chain });
          }
        }
      }

      // Fallback parser for Zapper layouts that render rows as plain stacked text.
      const bodyText = document.body?.innerText || "";
      const lines = bodyText
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      for (let i = 0; i < lines.length - 3; i += 1) {
        const token = lines[i];
        const price = lines[i + 1];
        const balance = lines[i + 2];
        const value = lines[i + 3];
        const tokenLike = /^[A-Za-z0-9._-]{2,24}$/.test(token);
        const priceLike = /^\$[\d.,]+/.test(price);
        const balanceLike = /^[\d.,]+([KMBT])?$/.test(balance);
        const valueLike = /^\$[\d.,]+/.test(value);
        if (!tokenLike || !priceLike || !balanceLike || !valueLike) continue;

        const key = `${token}|${balance}|${value}|unknown`;
        if (dedupe.has(key)) continue;
        dedupe.add(key);
        result.push({
          symbol: token,
          name: token,
          balance,
          value,
          chain: "unknown",
        });
      }

      return result;
    },
    { rowSelectors: SELECTORS.tokenRows, includeDefiFlag: includeDefi },
  );
}

export async function scrapeWallet(page: Page, wallet: WalletInput, options: ScrapeOptions): Promise<ScrapeResult> {
  const filenameBase = `${sanitizeLabel(wallet.label)}-${Date.now()}`;
  let screenshotPath: string | null = null;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_SCRAPE_ATTEMPTS; attempt += 1) {
    try {
      options.logger(
        `Attempt ${attempt}/${MAX_SCRAPE_ATTEMPTS} for ${wallet.label} (zapper-home-search)`,
      );

      await openWalletFromZapperSearch(
        page,
        wallet.url,
        {
          headless: options.headless,
          logger: options.logger,
        },
      );
      await page.waitForTimeout(1_500);
      await ensureCloudflareCleared(page, {
        headless: options.headless,
        logger: options.logger,
      });

      const tokensTabClicked = await clickTokensTab(page);
      if (!tokensTabClicked) {
        throw new Error('Unable to find/click "Tokens" tab');
      }

      await waitForTokensList(page);
      await applyMinFilter(page, options.minHoldingUsd);
      await expandAllRows(page);
      const tokens = await extractTokensFromDom(page, options.includeDefi);

      if (options.screenshotsEnabled || tokens.length === 0) {
        const absoluteScreenshotPath = path.join(options.screenshotsDir, `${filenameBase}.png`);
        await page.screenshot({ path: absoluteScreenshotPath, fullPage: true });
        screenshotPath = toWorkspaceRelativePath(options.cwd, absoluteScreenshotPath);
      }

      if (tokens.length === 0) {
        options.logger(`Warning: No tokens extracted for ${wallet.label}.`);
      }

      return { tokens, screenshotPath };
    } catch (error) {
      lastError = error as Error;
      options.logger(`Attempt ${attempt} failed for ${wallet.label}: ${lastError.message}`);
      if (attempt < MAX_SCRAPE_ATTEMPTS) {
        const backoff = RETRY_BACKOFF_MS[Math.min(attempt - 1, RETRY_BACKOFF_MS.length - 1)];
        options.logger(`Retrying in ${Math.round(backoff / 1000)}s...`);
        await page.waitForTimeout(backoff);
      }
    }
  }

  throw new Error(`Retry exhausted: ${lastError?.message || "Unknown scrape failure"}`);
}
