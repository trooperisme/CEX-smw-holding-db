import { getSupabaseAdminClient } from "./supabase";
import { getSpotHoldingMinUsd } from "./spot-holdings";
import { getSpotTokenFilterConfig } from "./spot-token-filter";
import { SpotHoldingsScanSummary } from "./spot-holdings";

export type SpotDashboardRow = {
  token: string;
  holdersCount: number;
  totalValueUsd: number;
  avgValueUsd: number;
  topHolderName: string | null;
  topHolderWallet: string | null;
  topHolderValueUsd: number;
  holders: Array<{
    traderName: string;
    walletAddress: string;
    spotUrl: string;
    valueUsd: number;
  }>;
};

export type SpotDashboardPayload = {
  generatedAt: string | null;
  snapshotId: number | null;
  outputPath: string | null;
  summary: {
    tradersScanned: number;
    tradersWithFilteredHoldings: number;
    tradersWithRelevantHoldings: number;
    failures: number;
    minUsd: number;
    rawHoldings: number;
    keptHoldings: number;
    relevantHoldings: number;
    filteredOut: { stable: number; trash: number; unrelated: number };
    includeTokens: string[];
    relevantTokens: string[];
  };
  rows: SpotDashboardRow[];
};

function supabaseConfigured(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

export function hasSupabaseStorage(): boolean {
  return supabaseConfigured();
}

function emptyDashboardPayload(): SpotDashboardPayload {
  const filterConfig = getSpotTokenFilterConfig();
  return {
    generatedAt: null,
    snapshotId: null,
    outputPath: null,
    summary: {
      tradersScanned: 0,
      tradersWithFilteredHoldings: 0,
      tradersWithRelevantHoldings: 0,
      failures: 0,
      minUsd: getSpotHoldingMinUsd(),
      rawHoldings: 0,
      keptHoldings: 0,
      relevantHoldings: 0,
      filteredOut: { stable: 0, trash: 0, unrelated: 0 },
      includeTokens: Array.from(filterConfig.includeTokens),
      relevantTokens: Array.from(filterConfig.includeTokens),
    },
    rows: [],
  };
}

function assertSupabaseConfigured(): void {
  if (!supabaseConfigured()) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for durable spot storage");
  }
}

function assertNoSupabaseError(error: { message: string } | null, context: string): void {
  if (error) throw new Error(`${context}: ${error.message}`);
}

function buildRows(
  holdings: Array<{
    token: string;
    trader_name: string;
    wallet_address: string;
    source_url: string;
    value_usd: number;
  }>,
): SpotDashboardRow[] {
  const grouped = new Map<string, {
    token: string;
    holders: Map<string, { traderName: string; walletAddress: string; spotUrl: string; valueUsd: number }>;
    totalValueUsd: number;
  }>();

  for (const holding of holdings) {
    const token = String(holding.token || "").trim();
    const traderName = String(holding.trader_name || "").trim();
    const walletAddress = String(holding.wallet_address || "").trim().toLowerCase();
    const valueUsd = Number(holding.value_usd || 0);
    if (!token || !traderName || !walletAddress || !Number.isFinite(valueUsd)) continue;

    const entry = grouped.get(token) || { token, holders: new Map(), totalValueUsd: 0 };
    const existing = entry.holders.get(walletAddress);
    entry.holders.set(walletAddress, {
      traderName,
      walletAddress,
      spotUrl: String(holding.source_url || `https://hypurrscan.io/address/${walletAddress}#spot`),
      valueUsd: (existing?.valueUsd || 0) + valueUsd,
    });
    entry.totalValueUsd += valueUsd;
    grouped.set(token, entry);
  }

  return Array.from(grouped.values())
    .map((entry) => {
      const holders = Array.from(entry.holders.values()).sort((a, b) => b.valueUsd - a.valueUsd);
      const topHolder = holders[0] || null;
      return {
        token: entry.token,
        holdersCount: holders.length,
        totalValueUsd: Number(entry.totalValueUsd.toFixed(2)),
        avgValueUsd: holders.length ? Number((entry.totalValueUsd / holders.length).toFixed(2)) : 0,
        topHolderName: topHolder?.traderName || null,
        topHolderWallet: topHolder?.walletAddress || null,
        topHolderValueUsd: topHolder?.valueUsd || 0,
        holders,
      };
    })
    .sort((a, b) => {
      if (b.holdersCount !== a.holdersCount) return b.holdersCount - a.holdersCount;
      if (b.totalValueUsd !== a.totalValueUsd) return b.totalValueUsd - a.totalValueUsd;
      return a.token.localeCompare(b.token, undefined, { sensitivity: "base" });
    });
}

export async function persistSpotHoldingsSnapshot(summary: SpotHoldingsScanSummary): Promise<number> {
  assertSupabaseConfigured();
  const supabase = getSupabaseAdminClient();
  const { data: snapshot, error: snapshotError } = await supabase
    .from("spot_snapshots")
    .insert({
      status: "running",
      traders_scanned: summary.tradersScanned,
      traders_with_filtered_holdings: summary.tradersWithFilteredHoldings,
      failures: summary.failures,
      min_usd: summary.minUsd,
      cache_ttl_hours: summary.cacheTtlHours,
      token_filter: summary.tokenFilter,
      generated_at: summary.generatedAt,
    })
    .select("id")
    .single();
  assertNoSupabaseError(snapshotError, "Create spot snapshot");
  if (!snapshot?.id) throw new Error("Create spot snapshot: missing id");
  const snapshotId = Number(snapshot.id);

  try {
    const allResults = summary.allResults || summary.results;
    const runs = allResults.map((result) => ({
      snapshot_id: snapshotId,
      trader_name: result.traderName,
      wallet_address: result.walletAddress,
      source_url: result.spotUrl,
      status: result.error ? "failed" : "success",
      holdings_found: result.holdings.length,
      total_value_usd: result.totalFilteredUsd,
      error_message: result.error,
    }));
    if (runs.length) {
      const { error } = await supabase.from("spot_trader_runs").insert(runs);
      assertNoSupabaseError(error, "Insert spot trader runs");
    }

    const holdings = allResults.flatMap((result) =>
      result.holdings.map((holding) => ({
        snapshot_id: snapshotId,
        trader_name: result.traderName,
        wallet_address: result.walletAddress,
        source_url: result.spotUrl,
        token: holding.token,
        value_usd: holding.valueUsd,
        filter_category: holding.filterCategory || "displayable",
        scraped_at: summary.generatedAt,
      })),
    );
    if (holdings.length) {
      const { error } = await supabase.from("spot_holdings").insert(holdings);
      assertNoSupabaseError(error, "Insert spot holdings");
    }

    const status = summary.failures > 0 ? "partial" : "success";
    const { error: updateError } = await supabase
      .from("spot_snapshots")
      .update({ status, finished_at: new Date().toISOString() })
      .eq("id", snapshotId);
    assertNoSupabaseError(updateError, "Finalize spot snapshot");
    return snapshotId;
  } catch (error) {
    await supabase
      .from("spot_snapshots")
      .update({ status: "failed", error_message: (error as Error)?.message || String(error), finished_at: new Date().toISOString() })
      .eq("id", snapshotId);
    throw error;
  }
}

export async function loadLatestSpotHoldingsDashboard(): Promise<SpotDashboardPayload> {
  assertSupabaseConfigured();
  const supabase = getSupabaseAdminClient();
  const { data: snapshot, error: snapshotError } = await supabase
    .from("spot_snapshots")
    .select("id,generated_at,traders_scanned,traders_with_filtered_holdings,failures,min_usd,token_filter")
    .eq("status", "success")
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();
  assertNoSupabaseError(snapshotError, "Load latest spot snapshot");
  if (!snapshot) return emptyDashboardPayload();

  const { data: holdings, error: holdingsError } = await supabase
    .from("spot_holdings")
    .select("token,trader_name,wallet_address,source_url,value_usd")
    .eq("snapshot_id", snapshot.id)
    .order("value_usd", { ascending: false });
  assertNoSupabaseError(holdingsError, "Load spot holdings");

  const rows = buildRows((holdings || []) as any);
  const tokenFilter = snapshot.token_filter || {};
  const filteredOut = tokenFilter.filteredOut || { stable: 0, trash: 0, unrelated: 0 };
  const keptHoldings = (holdings || []).length;
  return {
    generatedAt: snapshot.generated_at || null,
    snapshotId: Number(snapshot.id),
    outputPath: null,
    summary: {
      tradersScanned: Number(snapshot.traders_scanned || 0),
      tradersWithFilteredHoldings: Number(snapshot.traders_with_filtered_holdings || 0),
      tradersWithRelevantHoldings: Number(snapshot.traders_with_filtered_holdings || 0),
      failures: Number(snapshot.failures || 0),
      minUsd: Number(snapshot.min_usd || getSpotHoldingMinUsd()),
      rawHoldings: keptHoldings,
      keptHoldings,
      relevantHoldings: keptHoldings,
      filteredOut,
      includeTokens: tokenFilter.includeTokens || [],
      relevantTokens: tokenFilter.relevantTokens || tokenFilter.includeTokens || [],
    },
    rows,
  };
}
