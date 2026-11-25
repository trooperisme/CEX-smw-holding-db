import fs from "node:fs";
import path from "node:path";
import { resolveWorkspacePaths } from "./runtime-paths";
import { DEFAULT_SPOT_HOLDING_MIN_USD } from "./spot-holdings";
import { classifySpotToken, getSpotTokenFilterConfig, normalizeSpotTokenSymbol } from "./spot-token-filter";

export type SpotDashboardHolding = { token: string; traderName: string; walletAddress: string; spotUrl?: string; valueUsd: number };
type SpotFilterMetadata = { includeTokens?: string[]; relevantTokens?: string[]; stableTokens?: string[]; trashTokens?: string[]; filteredOut?: { stable?: number; trash?: number; unrelated?: number } };
export type SpotDashboardInput = {
  generatedAt?: string | null; snapshotId?: number | null; outputPath?: string | null;
  tradersScanned?: number; failures?: number; minUsd?: number;
  tokenFilter?: SpotFilterMetadata; holdings?: SpotDashboardHolding[];
};

export function buildSpotHoldingsDashboard(input: SpotDashboardInput = {}) {
  const metadata = input.tokenFilter || {};
  const defaults = getSpotTokenFilterConfig({});
  const includeTokens = metadata.includeTokens || metadata.relevantTokens || [];
  const config = {
    includeTokens: new Set(includeTokens.map(normalizeSpotTokenSymbol)),
    stableTokens: new Set((metadata.stableTokens || [...defaults.stableTokens]).map(normalizeSpotTokenSymbol)),
    trashTokens: new Set((metadata.trashTokens || [...defaults.trashTokens]).map(normalizeSpotTokenSymbol)),
  };
  const minUsd = Number(input.minUsd) > 0 ? Number(input.minUsd) : DEFAULT_SPOT_HOLDING_MIN_USD;
  const grouped = new Map<string, Map<string, Required<SpotDashboardHolding>>>();
  const uniqueWallets = new Set<string>();
  const filteredOut = { stable: 0, trash: 0, unrelated: 0 };
  let keptHoldings = 0;
  for (const holding of input.holdings || []) {
    const token = normalizeSpotTokenSymbol(holding.token);
    const walletAddress = String(holding.walletAddress || "").trim().toLowerCase();
    const traderName = String(holding.traderName || "").trim();
    const valueUsd = Number(holding.valueUsd);
    if (!token || !walletAddress || !traderName || !Number.isFinite(valueUsd) || valueUsd <= minUsd) continue;
    const category = classifySpotToken(token, config);
    if (category !== "displayable") { filteredOut[category]++; continue; }
    const holders = grouped.get(token) || new Map<string, Required<SpotDashboardHolding>>();
    const previous = holders.get(walletAddress);
    holders.set(walletAddress, { token, walletAddress, traderName,
      spotUrl: holding.spotUrl || `https://hypurrscan.io/address/${walletAddress}#spot`,
      valueUsd: (previous?.valueUsd || 0) + valueUsd });
    grouped.set(token, holders);
    uniqueWallets.add(walletAddress);
    keptHoldings++;
  }
  const rows = [...grouped].map(([token, wallets]) => {
    const holders = [...wallets.values()].sort((a, b) => b.valueUsd - a.valueUsd);
    const totalValueUsd = holders.reduce((sum, row) => sum + row.valueUsd, 0);
    const top = holders[0];
    return { token, holdersCount: holders.length, totalValueUsd: Number(totalValueUsd.toFixed(2)),
      avgValueUsd: Number((totalValueUsd / holders.length).toFixed(2)),
      topHolderName: top?.traderName || null, topHolderWallet: top?.walletAddress || null,
      topHolderValueUsd: top?.valueUsd || 0, holders };
  }).sort((a, b) => b.holdersCount - a.holdersCount || b.totalValueUsd - a.totalValueUsd || a.token.localeCompare(b.token));
  return {
    generatedAt: input.generatedAt || null, snapshotId: input.snapshotId ?? null, outputPath: input.outputPath ?? null,
    summary: { tradersScanned: Number(input.tradersScanned || 0),
      tradersWithFilteredHoldings: uniqueWallets.size, tradersWithRelevantHoldings: uniqueWallets.size,
      failures: Number(input.failures || 0), minUsd, rawHoldings: (input.holdings || []).length,
      keptHoldings, relevantHoldings: keptHoldings,
      filteredOut: { stable: Number(metadata.filteredOut?.stable ?? filteredOut.stable),
        trash: Number(metadata.filteredOut?.trash ?? filteredOut.trash), unrelated: Number(metadata.filteredOut?.unrelated ?? filteredOut.unrelated) },
      includeTokens, relevantTokens: includeTokens }, rows,
  };
}

export type SpotDashboardPayload = ReturnType<typeof buildSpotHoldingsDashboard>;
export type SpotDashboardRow = SpotDashboardPayload["rows"][number];

export function loadSpotHoldingsDashboardFromFile(cwd: string): SpotDashboardPayload {
  const dir = path.join(resolveWorkspacePaths(cwd).processedDataDir, "spot-holdings");
  const current = path.join(dir, "spot-holdings.json");
  const legacy = path.join(dir, "spot-holdings-over-50.json");
  const file = fs.existsSync(current) || !fs.existsSync(legacy) ? current : legacy;
  const outputPath = path.relative(cwd, file);
  if (!fs.existsSync(file)) return buildSpotHoldingsDashboard({ outputPath });
  const payload = JSON.parse(fs.readFileSync(file, "utf8"));
  return buildSpotHoldingsDashboard({ ...payload, snapshotId: null, outputPath,
    holdings: (payload.results || []).flatMap((trader: any) => (trader.holdings || []).map((holding: any) => ({
      token: holding.token, valueUsd: holding.valueUsd, traderName: trader.traderName,
      walletAddress: trader.walletAddress, spotUrl: trader.spotUrl,
    }))) });
}
