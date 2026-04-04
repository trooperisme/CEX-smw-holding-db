import path from "node:path";
import { BrowserContext, Page, chromium } from "playwright";
import { ensureDirExists, resolveWorkspacePaths } from "./runtime-paths";
import { ScanLogger } from "./types";

type BrowserOptions = {
  cwd: string;
  headless: boolean;
  logger: ScanLogger;
};

export type BrowserSession = {
  context: BrowserContext;
  usingCDP: boolean;
  newPage: () => Promise<Page>;
  close: () => Promise<void>;
};

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  return value.toLowerCase() === "true";
}

export async function createBrowserContext(options: BrowserOptions): Promise<BrowserSession> {
  const preferCdp = parseBool(process.env.PREFER_CDP_BROWSER, true);
  const cdpUrl = process.env.BROWSER_CDP_URL || "http://127.0.0.1:9222";

  if (preferCdp) {
    try {
      const browser = await chromium.connectOverCDP(cdpUrl);
      const context = browser.contexts()[0];
      if (context) {
        const ownedPages: Page[] = [];
        return {
          context,
          usingCDP: true,
          async newPage() {
            const page = await context.newPage();
            ownedPages.push(page);
            return page;
          },
          async close() {
            for (const page of ownedPages) {
              await page.close().catch(() => undefined);
            }
            // Keep user's existing browser session alive.
          },
        };
      }
    } catch (error) {
      options.logger(`CDP connect failed (${cdpUrl}), falling back to local profile: ${(error as Error).message}`);
    }
  }

  const profileDir = resolveWorkspacePaths(options.cwd).browserProfileDir;
  ensureDirExists(profileDir);
  const context = await chromium.launchPersistentContext(profileDir, {
    channel: "chrome",
    headless: options.headless,
    viewport: { width: 1440, height: 900 },
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    args: ["--no-sandbox"],
  });

  return {
    context,
    usingCDP: false,
    async newPage() {
      return context.pages()[0] || context.newPage();
    },
    async close() {
      await context.close();
    },
  };
}

export async function ensureCloudflareCleared(
  page: Page,
  options: { headless: boolean; logger: ScanLogger; initialUrl?: string },
): Promise<void> {
  if (options.initialUrl) {
    await page.goto(options.initialUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
  }

  const isBlocked = async (): Promise<boolean> => {
    const title = await page.title().catch(() => "");
    const hasChallengeFrame =
      (await page.locator('iframe[src*="challenges.cloudflare.com"]').count()) > 0;
    const hasVerifyingText =
      (await page
        .getByText(/verifying you are human|security verification/i)
        .count()
        .catch(() => 0)) > 0;
    return /just a moment/i.test(title) || hasChallengeFrame || hasVerifyingText;
  };

  let blocked = await isBlocked();
  if (!blocked) return;

  // Give Cloudflare a chance to clear automatically before requiring manual input.
  for (let i = 0; i < 30 && blocked; i += 1) {
    await page.waitForTimeout(1_000);
    blocked = await isBlocked();
  }
  if (!blocked) return;

  if (options.headless) {
    throw new Error("Cloudflare challenge detected in headless mode. Run with HEADLESS=false for manual solve.");
  }

  options.logger("Cloudflare challenge detected. Solve it in the opened browser window; worker will continue automatically.");

  const manualTimeoutSeconds = Number(process.env.CF_MANUAL_TIMEOUT_SECONDS || "300");
  const manualTimeoutMs =
    Number.isFinite(manualTimeoutSeconds) && manualTimeoutSeconds > 0
      ? manualTimeoutSeconds * 1000
      : 300_000;
  const startedAt = Date.now();

  while (Date.now() - startedAt < manualTimeoutMs) {
    await page.waitForTimeout(1_000);
    blocked = await isBlocked();
    if (!blocked) return;
  }

  throw new Error("Cloudflare challenge still visible after manual timeout.");
}
