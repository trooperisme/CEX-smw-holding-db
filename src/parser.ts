import { ParsedHolding, RawTokenHolding, WalletInput } from "./types";

const MULTIPLIERS: Record<string, number> = {
  K: 1_000,
  M: 1_000_000,
  B: 1_000_000_000,
  T: 1_000_000_000_000,
};
const MAX_SINGLE_HOLDING_USD = Number(process.env.MAX_SINGLE_HOLDING_USD || "1000000000");

export function parseCompactNumber(input: string | undefined | null): number | null {
  if (!input) return null;
  const cleaned = input.trim().replace(/\s+/g, "");
  if (!cleaned) return null;

  const normalized = cleaned.replace(/[$,]/g, "");
  const match = normalized.match(/^(-?\d+(\.\d+)?)([KMBT])?$/i);
  if (!match) return null;

  const base = Number(match[1]);
  if (!Number.isFinite(base)) return null;
  const suffix = (match[3] || "").toUpperCase();
  const multiplier = suffix ? MULTIPLIERS[suffix] : 1;
  return base * multiplier;
}

export function normalizeHolding(
  wallet: WalletInput,
  raw: RawTokenHolding,
): ParsedHolding | null {
  const tokenSymbol = normalizeTokenSymbol(raw.symbol || raw.name || "");
  const tokenName = normalizeTokenName(raw.name || tokenSymbol || "Unknown");
  const chain = (raw.chain || "unknown").trim().toLowerCase();
  const valueUsd = parseCompactNumber(raw.value);
  if (!tokenSymbol || valueUsd === null || valueUsd <= 0) {
    return null;
  }
  if (Number.isFinite(MAX_SINGLE_HOLDING_USD) && valueUsd > MAX_SINGLE_HOLDING_USD) {
    return null;
  }

  return {
    walletLabel: wallet.label,
    walletUrl: wallet.url,
    tokenSymbol,
    tokenName,
    chain,
    balanceRaw: (raw.balance || "").trim(),
    balanceNumeric: parseCompactNumber(raw.balance),
    valueUsd,
    scrapedAt: new Date().toISOString(),
  };
}

function normalizeTokenSymbol(input: string): string {
  let symbol = input.trim();
  if (!symbol) return "";

  // Remove appended price fragments from merged text, e.g. "MON$0.0233".
  symbol = symbol.replace(/\$[0-9].*$/u, "");
  // Remove account-count suffix noise from merged rows.
  symbol = symbol.replace(/\s+\d+\s+accounts?$/i, "");
  symbol = symbol.trim();
  if (!symbol) return "";

  // Symbol should be compact; if row text leaked into the symbol, keep first token.
  const parts = symbol.split(/\s+/).filter(Boolean);
  symbol = parts[0] || "";
  if (!symbol) return "";

  // Keep common symbol chars only.
  symbol = symbol.replace(/[^A-Za-z0-9._$-]/g, "");
  return symbol.trim();
}

function normalizeTokenName(input: string): string {
  let name = input.trim();
  if (!name) return "Unknown";
  name = name.replace(/\$[0-9].*$/u, "").trim();
  name = name.replace(/\s+\d+\s+accounts?$/i, "").trim();
  return name || "Unknown";
}

export function dedupeParsedHoldings(rows: ParsedHolding[]): ParsedHolding[] {
  const grouped = new Map<string, ParsedHolding>();
  for (const row of rows) {
    const key = [
      row.walletLabel,
      row.walletUrl,
      row.tokenSymbol.toUpperCase(),
      row.chain,
      row.balanceRaw.replace(/\s+/g, ""),
    ].join("|");

    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, row);
      continue;
    }

    // Keep the conservative row when duplicate line-parsing variants disagree.
    if (row.valueUsd < existing.valueUsd) {
      grouped.set(key, row);
    }
  }
  return Array.from(grouped.values());
}
