import fs from "node:fs";
import path from "node:path";

const APP_SLUG = "wallet-scraper";

type DataMode = "legacy" | "structured";

function resolveEnvPath(cwd: string, envKey: string): string | null {
  const value = process.env[envKey]?.trim();
  if (!value) return null;
  return path.isAbsolute(value) ? value : path.resolve(cwd, value);
}

function fileExists(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function dirExists(dirPath: string): boolean {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function formatLocalDate(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function hasStructuredDataMarkers(dirPath: string): boolean {
  return ["raw", "processed", "db", "exports"].some((name) => dirExists(path.join(dirPath, name)));
}

function findLatestArtifactDir(appRunsDir: string, relativeChildPath: string): string | null {
  if (!dirExists(appRunsDir)) return null;

  const entries = fs
    .readdirSync(appRunsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => b.localeCompare(a));

  for (const entry of entries) {
    const candidate = path.join(appRunsDir, entry, relativeChildPath);
    if (dirExists(candidate)) return candidate;
  }

  return null;
}

function resolveDataRoot(cwd: string): { appDataDir: string; dataMode: DataMode } {
  const configuredDataDir = resolveEnvPath(cwd, "DATA_DIR");
  if (configuredDataDir) {
    const dataMode: DataMode =
      hasStructuredDataMarkers(configuredDataDir) || path.basename(configuredDataDir) === APP_SLUG
        ? "structured"
        : "legacy";
    return { appDataDir: configuredDataDir, dataMode };
  }

  // Production-safe default: if a mounted data volume exists, keep app data there.
  const hostedDataRoot = process.env.HOSTED_DATA_ROOT?.trim() || "/data";
  const runningHosted = Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RENDER || process.env.NODE_ENV === "production");
  if (runningHosted && dirExists(hostedDataRoot)) {
    return { appDataDir: path.join(hostedDataRoot, APP_SLUG), dataMode: "structured" };
  }

  const legacyDataDir = path.join(cwd, "data");
  const structuredDataDir = path.join(legacyDataDir, APP_SLUG);
  const legacyMarkers =
    fileExists(path.join(legacyDataDir, "portfolio.db")) ||
    fileExists(path.join(cwd, "wallets.json")) ||
    fileExists(path.join(cwd, "clean_holdings.json"));

  if (legacyMarkers) {
    return { appDataDir: legacyDataDir, dataMode: "legacy" };
  }

  return { appDataDir: structuredDataDir, dataMode: "structured" };
}

export type WorkspacePaths = ReturnType<typeof resolveWorkspacePaths>;

export function resolveWorkspacePaths(cwd: string) {
  const { appDataDir, dataMode } = resolveDataRoot(cwd);
  const dashboardDir = path.join(cwd, "dashboard");
  const runsRootDir = resolveEnvPath(cwd, "RUNS_DIR") || path.join(cwd, "runs");
  const appRunsDir = path.join(runsRootDir, APP_SLUG);
  const defaultRunDir = path.join(appRunsDir, `${formatLocalDate()}-default`);

  const legacyBrowserProfileDir = path.join(cwd, "browser-profile");
  const legacyScreenshotsDir = path.join(cwd, "screenshots");
  const latestRunBrowserProfileDir = findLatestArtifactDir(appRunsDir, "browser-profile");
  const latestRunScreenshotsDir = findLatestArtifactDir(appRunsDir, "screenshots");
  const latestRunOutputsDir = findLatestArtifactDir(appRunsDir, path.join("outputs", "playwright"));

  const browserProfileDir =
    resolveEnvPath(cwd, "BROWSER_PROFILE_DIR") ||
    (dirExists(legacyBrowserProfileDir)
      ? legacyBrowserProfileDir
      : latestRunBrowserProfileDir || path.join(defaultRunDir, "browser-profile"));

  const screenshotsDir =
    resolveEnvPath(cwd, "SCREENSHOTS_DIR") ||
    (dirExists(legacyScreenshotsDir)
      ? legacyScreenshotsDir
      : latestRunScreenshotsDir || path.join(defaultRunDir, "screenshots"));

  const exportsDir =
    resolveEnvPath(cwd, "EXPORTS_DIR") ||
    (dataMode === "structured" ? path.join(appDataDir, "exports") : dashboardDir);

  const walletsFile =
    dataMode === "structured"
      ? path.join(appDataDir, "raw", "wallets.json")
      : path.join(cwd, "wallets.json");

  const walletsCsvFile =
    dataMode === "structured"
      ? path.join(appDataDir, "raw", "wallets.csv")
      : path.join(cwd, "wallets.csv");

  const traderSignalsCsvFile = path.join(appDataDir, "raw", "trader-hypurrscan.csv");

  const cleanHoldingsFile =
    dataMode === "structured"
      ? path.join(appDataDir, "processed", "clean_holdings.json")
      : path.join(cwd, "clean_holdings.json");

  const dbFile =
    dataMode === "structured"
      ? path.join(appDataDir, "db", "portfolio.db")
      : path.join(appDataDir, "portfolio.db");

  const exportTemplatePath = fileExists(path.join(dashboardDir, "export-template.html"))
    ? path.join(dashboardDir, "export-template.html")
    : path.join(dashboardDir, "first3-entities-dashboard.html");

  return {
    cwd,
    appSlug: APP_SLUG,
    dataMode,
    dashboardDir,
    appDataDir,
    rawDataDir: path.join(appDataDir, "raw"),
    processedDataDir: path.join(appDataDir, "processed"),
    dbDir: dataMode === "structured" ? path.join(appDataDir, "db") : appDataDir,
    exportsDir,
    walletsFile,
    walletsCsvFile,
    traderSignalsCsvFile,
    cleanHoldingsFile,
    dbFile,
    exportTemplatePath,
    defaultExportFile: path.join(exportsDir, "first10-entities-dashboard.html"),
    runsRootDir,
    appRunsDir,
    defaultRunDir,
    browserProfileDir,
    screenshotsDir,
    logsDir: path.join(defaultRunDir, "logs"),
    outputsDir: path.join(defaultRunDir, "outputs"),
    playwrightOutputDir: latestRunOutputsDir || path.join(defaultRunDir, "outputs", "playwright"),
  };
}

export function ensureDirExists(dirPath: string): void {
  if (!dirExists(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

export function resolveWorkspaceFilePath(cwd: string, inputPath: string): string | null {
  const trimmed = String(inputPath || "").trim();
  if (!trimmed) return null;

  const absolutePath = path.isAbsolute(trimmed) ? path.resolve(trimmed) : path.resolve(cwd, trimmed);
  const relativeToWorkspace = path.relative(cwd, absolutePath);
  if (relativeToWorkspace.startsWith("..") || path.isAbsolute(relativeToWorkspace)) {
    return null;
  }

  return absolutePath;
}

export function toWorkspaceRelativePath(cwd: string, inputPath: string): string {
  const absolutePath = path.isAbsolute(inputPath) ? inputPath : path.resolve(cwd, inputPath);
  const relative = path.relative(cwd, absolutePath);
  return relative && !relative.startsWith("..") ? relative : absolutePath;
}
