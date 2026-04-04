import fs from "node:fs";
import path from "node:path";
import { ensureDirExists, resolveWorkspacePaths } from "./runtime-paths";
import { TrackedTrader } from "./types";

const DEFAULT_IMPORT_SOURCE = "/Users/nguyentrancongnguyen/Downloads/Trader-Hypurrscan.csv";

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        i += 1;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }

    if (char === "," && !inQuotes) {
      out.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  out.push(current);
  return out.map((value) => value.trim());
}

function extractWalletAddress(url: string): string | null {
  const match = String(url).trim().match(/\/address\/(0x[a-fA-F0-9]{40})(?:[/?#]|$)/);
  return match?.[1].toLowerCase() || null;
}

function shouldImportSource(repoFile: string, importSource: string): boolean {
  if (!fs.existsSync(importSource)) return false;
  if (!fs.existsSync(repoFile)) return true;

  const repoStat = fs.statSync(repoFile);
  const sourceStat = fs.statSync(importSource);
  return sourceStat.mtimeMs >= repoStat.mtimeMs;
}

export function syncTraderSignalsCsv(cwd: string): string {
  const paths = resolveWorkspacePaths(cwd);
  const repoFile = paths.traderSignalsCsvFile;
  const importSource = process.env.TRADER_SIGNALS_IMPORT_CSV || DEFAULT_IMPORT_SOURCE;

  ensureDirExists(path.dirname(repoFile));

  if (shouldImportSource(repoFile, importSource)) {
    fs.copyFileSync(importSource, repoFile);
  }

  if (!fs.existsSync(repoFile)) {
    throw new Error(
      `Trader CSV not found. Expected ${repoFile}${importSource ? ` or import source ${importSource}` : ""}`,
    );
  }

  return repoFile;
}

export function loadTrackedTraders(cwd: string): TrackedTrader[] {
  const csvPath = syncTraderSignalsCsv(cwd);
  const raw = fs.readFileSync(csvPath, "utf-8").replace(/^\uFEFF/, "");
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length <= 1) return [];

  const headers = parseCsvLine(lines[0]).map((value) => value.trim().toLowerCase());
  const traderIdx = headers.findIndex((value) => value === "trader");
  const urlIdx = headers.findIndex((value) => value === "hypurrscan");
  if (traderIdx === -1 || urlIdx === -1) {
    throw new Error(`Invalid trader CSV headers in ${csvPath}`);
  }

  const deduped = new Map<string, TrackedTrader>();

  for (const line of lines.slice(1)) {
    const values = parseCsvLine(line);
    const traderName = String(values[traderIdx] || "").trim();
    const hypurrscanUrl = String(values[urlIdx] || "").trim();
    const walletAddress = extractWalletAddress(hypurrscanUrl);
    if (!traderName || !hypurrscanUrl || !walletAddress) continue;

    deduped.set(walletAddress, {
      traderName,
      hypurrscanUrl,
      walletAddress,
      isActive: true,
    });
  }

  return Array.from(deduped.values()).sort((a, b) =>
    a.traderName.localeCompare(b.traderName, undefined, { sensitivity: "base" }),
  );
}

export function classifySignalMarketType(token: string): "crypto" | "tradfi" {
  const normalized = String(token || "").trim().toLowerCase();
  return /^(xyz|flx|vntl|hyna|km|cash):/.test(normalized) ? "tradfi" : "crypto";
}
