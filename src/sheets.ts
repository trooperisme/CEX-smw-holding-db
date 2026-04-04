import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { google } from "googleapis";
import { resolveWorkspacePaths } from "./runtime-paths";
import { PriorityColor, SourceType, TrackedEntity, WalletInput } from "./types";

type AnyRow = Record<string, string>;

type CellColor = {
  red?: number | null;
  green?: number | null;
  blue?: number | null;
};

type RawSheetRow = {
  entityId: string;
  entityName: string;
  sourceUrl: string;
  notes: string | null;
  isActive: boolean;
  priorityColor: PriorityColor;
};

const DEFAULT_SPREADSHEET_ID = "1aEgrEgH3l1nkpXug3CHcUUyIkiG1WRqimfbmZydIY3w";
const DEFAULT_SHEET_NAME = "Database";
const SHORTENER_HOSTS = new Set(["tinyurl.com", "bit.ly", "t.co"]);

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "_");
}

function normalizeText(value: string | undefined): string {
  return (value || "").trim();
}

function parseSheetBool(value: string): boolean {
  const input = value.trim().toLowerCase();
  if (!input) return true;
  if (input === "false" || input === "0" || input === "no" || input === "n") return false;
  return true;
}

function toPriorityColor(color: CellColor | null | undefined): PriorityColor {
  if (!color) return "unknown";
  const r = color.red ?? 0;
  const g = color.green ?? 0;
  const b = color.blue ?? 0;

  if (r >= 0.85 && g >= 0.7 && b <= 0.45) return "yellow";
  if (r >= 0.75 && g <= 0.4 && b <= 0.4) return "red";
  if (r >= 0.6 && b >= 0.6 && g <= 0.45) return "purple";
  return "unknown";
}

function valueToString(cell: any): string {
  if (!cell) return "";
  if (typeof cell.formattedValue === "string") return cell.formattedValue;
  const entered = cell.userEnteredValue;
  if (!entered) return "";
  if (typeof entered.stringValue === "string") return entered.stringValue;
  if (typeof entered.numberValue === "number") return String(entered.numberValue);
  if (typeof entered.boolValue === "boolean") return entered.boolValue ? "TRUE" : "FALSE";
  return "";
}

function getBgColor(cell: any): CellColor | null {
  const color = cell?.effectiveFormat?.backgroundColor;
  if (!color) return null;
  return {
    red: color.red ?? null,
    green: color.green ?? null,
    blue: color.blue ?? null,
  };
}

function detectSourceType(hostname: string): SourceType | null {
  if (hostname.includes("zapper.xyz")) return "zapper";
  if (hostname.includes("debank.com")) return "debank";
  return null;
}

async function resolveShortUrl(url: string): Promise<string> {
  try {
    const parsed = new URL(url);
    if (!SHORTENER_HOSTS.has(parsed.hostname.toLowerCase())) return url;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": "Mozilla/5.0",
      },
    });
    clearTimeout(timeout);
    return response.url || url;
  } catch {
    return url;
  }
}

async function normalizeSource(sourceUrl: string): Promise<{
  normalizedUrl: string;
  sourceType: SourceType | null;
}> {
  const resolved = await resolveShortUrl(sourceUrl.trim());
  let parsed: URL;
  try {
    parsed = new URL(resolved);
  } catch {
    return { normalizedUrl: sourceUrl.trim(), sourceType: null };
  }

  const sourceType = detectSourceType(parsed.hostname.toLowerCase());
  if (!sourceType) return { normalizedUrl: parsed.toString(), sourceType: null };

  if (sourceType === "zapper") {
    parsed.searchParams.set("tab", "wallet");
  }

  return {
    normalizedUrl: parsed.toString(),
    sourceType,
  };
}

function hashEntity(input: {
  entityId: string;
  entityName: string;
  sourceUrl: string;
  normalizedUrl: string;
  sourceType: SourceType;
  notes: string | null;
  isActive: boolean;
  priorityColor: PriorityColor;
}): string {
  const payload = [
    input.entityId,
    input.entityName,
    input.sourceUrl,
    input.normalizedUrl,
    input.sourceType,
    input.notes || "",
    input.isActive ? "1" : "0",
    input.priorityColor,
  ].join("|");
  return crypto.createHash("sha256").update(payload).digest("hex");
}

function readLocalWalletsFile(cwd: string): WalletInput[] {
  const file = resolveWorkspacePaths(cwd).walletsFile;
  if (!fs.existsSync(file)) return [];
  const json = JSON.parse(fs.readFileSync(file, "utf-8")) as AnyRow[] | WalletInput[];
  if (!Array.isArray(json)) return [];

  return json
    .map((entry: any) => ({
      label: String(entry.label || "").trim(),
      url: String(entry.url || entry.link || "").trim(),
    }))
    .filter((wallet) => wallet.label && /^https?:\/\//.test(wallet.url));
}

async function fetchSheetRows(spreadsheetId: string, apiKey: string): Promise<any[]> {
  const sheets = google.sheets({ version: "v4", auth: apiKey });
  const response = await sheets.spreadsheets.get({
    spreadsheetId,
    includeGridData: true,
  });

  const targetName = process.env.SHEET_NAME || DEFAULT_SHEET_NAME;
  const targetGid = Number(process.env.SHEET_GID || "");
  const sheet = (response.data.sheets || []).find((candidate) => {
    const idMatch =
      Number.isFinite(targetGid) && targetGid > 0 && candidate.properties?.sheetId === targetGid;
    const nameMatch =
      (candidate.properties?.title || "").trim().toLowerCase() === targetName.toLowerCase();
    if (Number.isFinite(targetGid) && targetGid > 0) return idMatch;
    return nameMatch;
  });

  const rowData = sheet?.data?.[0]?.rowData;
  return Array.isArray(rowData) ? rowData : [];
}

function parseEntityRows(rowData: any[]): RawSheetRow[] {
  if (!rowData.length) return [];

  const headerCells = rowData[0]?.values || [];
  const headers = headerCells.map((cell: any) => normalizeHeader(valueToString(cell)));

  const entityIdIdx = headers.findIndex((h: string) => h === "entity_id");
  const entityNameIdx = headers.findIndex(
    (h: string) => h === "entity_name" || h === "label" || h === "entity",
  );
  const sourceUrlIdx = headers.findIndex(
    (h: string) => h === "zapper_url" || h === "source_url" || h === "link" || h === "url",
  );
  const notesIdx = headers.findIndex((h: string) => h === "notes" || h === "comment");
  const isActiveIdx = headers.findIndex((h: string) => h === "is_active" || h === "active");

  if (entityNameIdx === -1 || sourceUrlIdx === -1 || entityIdIdx === -1) return [];

  const parsed: RawSheetRow[] = [];
  for (let i = 1; i < rowData.length; i += 1) {
    const values = rowData[i]?.values || [];
    const entityId = normalizeText(valueToString(values[entityIdIdx]));
    const entityName = normalizeText(valueToString(values[entityNameIdx]));
    const sourceUrl = normalizeText(valueToString(values[sourceUrlIdx]));
    if (!entityId || !entityName || !/^https?:\/\//i.test(sourceUrl)) continue;

    const notesRaw = notesIdx === -1 ? "" : normalizeText(valueToString(values[notesIdx]));
    const activeRaw = isActiveIdx === -1 ? "TRUE" : valueToString(values[isActiveIdx]);
    const priorityColor = toPriorityColor(getBgColor(values[entityNameIdx] || values[0]));

    parsed.push({
      entityId,
      entityName,
      sourceUrl,
      notes: notesRaw ? notesRaw : null,
      isActive: parseSheetBool(activeRaw),
      priorityColor,
    });
  }

  return parsed;
}

async function fetchLegacyWallets(spreadsheetId: string, apiKey: string): Promise<WalletInput[]> {
  const sheets = google.sheets({ version: "v4", auth: apiKey });
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "Sheet1!A:Z",
  });
  const rows = (response.data.values || []).map((row) => row.map((v) => String(v)));
  if (!rows.length) return [];

  const headers = rows[0].map(normalizeHeader);
  const labelIndex = headers.findIndex((h) => h === "label");
  const linkIndex = headers.findIndex((h) => h === "link");
  if (labelIndex === -1 || linkIndex === -1) return [];

  return rows
    .slice(1)
    .map((row) => ({
      label: normalizeText(row[labelIndex]),
      url: normalizeText(row[linkIndex]),
    }))
    .filter((wallet) => wallet.label && /^https?:\/\//.test(wallet.url));
}

export async function loadTrackedEntities(_cwd: string): Promise<TrackedEntity[]> {
  const spreadsheetId = process.env.SPREADSHEET_ID || DEFAULT_SPREADSHEET_ID;
  const apiKey = process.env.GOOGLE_SHEETS_API_KEY;
  if (!spreadsheetId || !apiKey) return [];

  const rowData = await fetchSheetRows(spreadsheetId, apiKey);
  const rawRows = parseEntityRows(rowData);

  const normalized = await Promise.all(
    rawRows.map(async (row): Promise<TrackedEntity | null> => {
      const normalizedSource = await normalizeSource(row.sourceUrl);
      if (!normalizedSource.sourceType) return null;

      return {
        entityId: row.entityId,
        entityName: row.entityName,
        sourceUrl: row.sourceUrl,
        normalizedUrl: normalizedSource.normalizedUrl,
        sourceType: normalizedSource.sourceType,
        notes: row.notes,
        isActive: row.isActive,
        priorityColor: row.priorityColor,
        sourceHash: hashEntity({
          entityId: row.entityId,
          entityName: row.entityName,
          sourceUrl: row.sourceUrl,
          normalizedUrl: normalizedSource.normalizedUrl,
          sourceType: normalizedSource.sourceType,
          notes: row.notes,
          isActive: row.isActive,
          priorityColor: row.priorityColor,
        }),
      };
    }),
  );

  return normalized.filter((item): item is TrackedEntity => item !== null);
}

export async function loadWallets(cwd: string): Promise<WalletInput[]> {
  const spreadsheetId = process.env.SPREADSHEET_ID || DEFAULT_SPREADSHEET_ID;
  const apiKey = process.env.GOOGLE_SHEETS_API_KEY;

  if (!spreadsheetId || !apiKey) {
    return readLocalWalletsFile(cwd);
  }

  try {
    const entities = await loadTrackedEntities(cwd);
    const wallets = entities
      .filter((entity) => entity.isActive && entity.priorityColor === "red")
      .map((entity) => ({
        label: entity.entityName,
        url: entity.normalizedUrl,
      }));
    if (wallets.length > 0) return wallets;

    const legacyWallets = await fetchLegacyWallets(spreadsheetId, apiKey);
    if (legacyWallets.length > 0) return legacyWallets;
    return readLocalWalletsFile(cwd);
  } catch {
    return readLocalWalletsFile(cwd);
  }
}
