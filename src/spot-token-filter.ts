export type SpotTokenCategory = "displayable" | "stable" | "trash" | "unrelated";

export type SpotTokenFilterConfig = {
  includeTokens: Set<string>;
  stableTokens: Set<string>;
  trashTokens: Set<string>;
};

const DEFAULT_STABLE_TOKENS = [
  "USDC",
  "USDT",
  "USDH",
  "USDE",
  "DAI",
  "FDUSD",
  "TUSD",
  "USDD",
  "USDT0",
  "PYUSD",
  "FEUSD",
  "LUSD",
  "FRAX",
  "SUSDE",
  "SUSDS",
];
const DEFAULT_TRASH_TOKENS = ["UNKNOWN", "NULL", "N/A", "-"];

function parseTokenList(value: string | undefined): Set<string> {
  const raw = value && value.trim() ? value : "";
  return new Set(
    raw
      .split(",")
      .map(normalizeSpotTokenSymbol)
      .filter(Boolean),
  );
}

export function normalizeSpotTokenSymbol(input: string): string {
  return String(input || "")
    .trim()
    .replace(/\s+/g, "")
    .replace(/^\$+/, "")
    .toUpperCase();
}

export function getSpotTokenFilterConfig(env: NodeJS.ProcessEnv = process.env): SpotTokenFilterConfig {
  return {
    includeTokens: parseTokenList(env.SPOT_HOLDING_INCLUDE_TOKENS || env.SPOT_HOLDING_RELEVANT_TOKENS || env.SPOT_HOLDING_INCLUDE),
    stableTokens: parseTokenList(
      env.SPOT_HOLDING_STABLE_EXCLUDE || env.SPOT_HOLDING_EXCLUDE || DEFAULT_STABLE_TOKENS.join(","),
    ),
    trashTokens: parseTokenList(env.SPOT_HOLDING_TRASH_EXCLUDE || DEFAULT_TRASH_TOKENS.join(",")),
  };
}

export function classifySpotToken(
  token: string,
  config: SpotTokenFilterConfig = getSpotTokenFilterConfig(),
): SpotTokenCategory {
  const symbol = normalizeSpotTokenSymbol(token);
  if (!symbol) return "trash";
  if (symbol.length > 24 || /[^A-Z0-9:_.$-]/.test(symbol)) return "trash";
  if (config.trashTokens.has(symbol)) return "trash";
  if (config.stableTokens.has(symbol)) return "stable";
  if (config.includeTokens.size === 0 || config.includeTokens.has(symbol)) return "displayable";
  return "unrelated";
}

export function isSpotTokenRelevant(
  token: string,
  config: SpotTokenFilterConfig = getSpotTokenFilterConfig(),
): boolean {
  return classifySpotToken(token, config) === "displayable";
}
