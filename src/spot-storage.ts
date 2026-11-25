import { getSupabaseAdminClient } from "./supabase";
import { SpotHoldingsScanSummary } from "./spot-holdings";

import { buildSpotHoldingsDashboard, SpotDashboardPayload } from "./spot-dashboard";
export type { SpotDashboardRow, SpotDashboardPayload } from "./spot-dashboard";

function supabaseConfigured(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

export function hasSupabaseStorage(): boolean {
  return supabaseConfigured();
}

function assertSupabaseConfigured(): void {
  if (!supabaseConfigured()) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for durable spot storage");
  }
}

function assertNoSupabaseError(error: { message: string } | null, context: string): void {
  if (error) throw new Error(`${context}: ${error.message}`);
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
  if (!snapshot) return buildSpotHoldingsDashboard();

  // Read every captured holding; hosted PostgREST responses are paginated.
  const holdings: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from("spot_holdings")
      .select("token,trader_name,wallet_address,source_url,value_usd")
      .eq("snapshot_id", snapshot.id).order("id", { ascending: true }).range(from, from + 999);
    assertNoSupabaseError(error, "Load spot holdings");
    holdings.push(...(data || []));
    if ((data || []).length < 1000) break;
  }
  return buildSpotHoldingsDashboard({
    generatedAt: snapshot.generated_at, snapshotId: Number(snapshot.id),
    tradersScanned: snapshot.traders_scanned, failures: snapshot.failures,
    minUsd: snapshot.min_usd, tokenFilter: snapshot.token_filter || {},
    holdings: holdings.map((row) => ({ token: row.token, traderName: row.trader_name,
      walletAddress: row.wallet_address, spotUrl: row.source_url, valueUsd: row.value_usd })),
  });
}
