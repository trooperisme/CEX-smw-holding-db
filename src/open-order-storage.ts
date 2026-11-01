import { getSupabaseAdminClient } from "./supabase";
import {
  buildOpenOrderDashboard,
  loadOpenOrderDashboard,
  NativeSnapshot,
  NativeWalletResult,
  OpenOrderDashboardPayload,
} from "./open-order-dashboard";
import { OpenOrderScanResult } from "./open-order-scan";

function configured(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

function assertConfigured(): void {
  if (!configured()) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for durable open-order storage");
}

function assertNoError(error: { message: string } | null, context: string): void {
  if (error) throw new Error(`${context}: ${error.message}`);
}

function asNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function snapshotFromRows(snapshot: any, runs: any[], orders: any[]): NativeSnapshot {
  const byWallet = new Map<string, NativeWalletResult>();
  for (const run of runs) {
    const address = String(run.wallet_address || "").toLowerCase();
    byWallet.set(address, {
      traderName: run.trader_name,
      hypurrscanUrl: run.source_url,
      walletAddress: address,
      status: run.status === "success" ? "success" : "failed",
      orders: [],
      error: run.error_message || undefined,
    });
  }
  for (const row of orders) {
    const wallet = byWallet.get(String(row.wallet_address || "").toLowerCase());
    if (!wallet) continue;
    wallet.orders.push({
      coin: row.asset_id,
      side: row.side === "bid" ? "B" : "A",
      limitPx: String(row.limit_price),
      sz: String(row.size),
      oid: row.oid,
      timestamp: row.placed_at ? new Date(row.placed_at).getTime() : undefined,
    });
  }
  return {
    fetchedAt: snapshot.captured_at,
    totalWallets: Number(snapshot.total_wallets || 0),
    successfulWallets: Number(snapshot.successful_wallets || 0),
    failedWallets: Number(snapshot.failed_wallets || 0),
    totalIndividualOrders: Number(snapshot.total_orders || 0),
    results: Array.from(byWallet.values()),
  };
}

export async function persistOpenOrderSnapshot(result: OpenOrderScanResult): Promise<number> {
  assertConfigured();
  const supabase = getSupabaseAdminClient();
  const status = result.failedWallets > 0 ? "partial" : "success";
  const { data: snapshot, error: snapshotError } = await supabase
    .from("open_order_snapshots")
    .insert({
      status: "running",
      source: result.source,
      total_wallets: result.totalWallets,
      successful_wallets: result.successfulWallets,
      failed_wallets: result.failedWallets,
      total_orders: result.totalIndividualOrders,
      captured_at: result.fetchedAt,
    })
    .select("id")
    .single();
  assertNoError(snapshotError, "Create open-order snapshot");
  if (!snapshot?.id) throw new Error("Create open-order snapshot: missing id");
  const snapshotId = Number(snapshot.id);

  try {
    const runs = result.results.map((wallet) => ({
      snapshot_id: snapshotId,
      trader_name: wallet.traderName,
      wallet_address: wallet.walletAddress.toLowerCase(),
      source_url: wallet.hypurrscanUrl,
      status: wallet.status,
      orders_found: wallet.orders.length,
      error_message: wallet.error || null,
    }));
    if (runs.length) {
      const { error } = await supabase.from("open_order_wallet_runs").insert(runs);
      assertNoError(error, "Insert open-order wallet runs");
    }
    const orders = result.results.flatMap((wallet) => wallet.orders.map((order) => ({
      snapshot_id: snapshotId,
      trader_name: wallet.traderName,
      wallet_address: wallet.walletAddress.toLowerCase(),
      source_url: wallet.hypurrscanUrl,
      asset_id: order.coin,
      side: order.side === "B" ? "bid" : "ask",
      limit_price: asNumber(order.limitPx),
      size: asNumber(order.sz),
      notional_usd: asNumber(order.limitPx) * asNumber(order.sz),
      oid: String(order.oid),
      placed_at: order.timestamp ? new Date(order.timestamp).toISOString() : null,
    })));
    if (orders.length) {
      const { error } = await supabase.from("open_orders").insert(orders);
      assertNoError(error, "Insert open orders");
    }
    const { error: finalError } = await supabase
      .from("open_order_snapshots")
      .update({ status, finished_at: new Date().toISOString() })
      .eq("id", snapshotId);
    assertNoError(finalError, "Finalize open-order snapshot");
    return snapshotId;
  } catch (error) {
    await supabase
      .from("open_order_snapshots")
      .update({ status: "failed", error_message: (error as Error)?.message || String(error), finished_at: new Date().toISOString() })
      .eq("id", snapshotId);
    throw error;
  }
}

export async function loadDurableOpenOrderDashboard(cwd: string): Promise<OpenOrderDashboardPayload | null> {
  if (!configured()) return loadOpenOrderDashboard(cwd);
  const supabase = getSupabaseAdminClient();
  const { data: snapshots, error } = await supabase
    .from("open_order_snapshots")
    .select("id,status,source,total_wallets,successful_wallets,failed_wallets,total_orders,captured_at")
    .eq("status", "success")
    .order("id", { ascending: false })
    .limit(2);
  assertNoError(error, "Load open-order snapshots");
  if (!snapshots?.length) return null;
  const ids = snapshots.map((snapshot: any) => snapshot.id);
  const [{ data: runs, error: runsError }, { data: orders, error: ordersError }] = await Promise.all([
    supabase.from("open_order_wallet_runs").select("snapshot_id,trader_name,wallet_address,source_url,status,orders_found,error_message").in("snapshot_id", ids),
    supabase.from("open_orders").select("snapshot_id,trader_name,wallet_address,source_url,asset_id,side,limit_price,size,oid,placed_at").in("snapshot_id", ids),
  ]);
  assertNoError(runsError, "Load open-order wallet runs");
  assertNoError(ordersError, "Load open orders");
  const current = snapshotFromRows(
    snapshots[0],
    (runs || []).filter((row: any) => Number(row.snapshot_id) === Number(snapshots[0].id)),
    (orders || []).filter((row: any) => Number(row.snapshot_id) === Number(snapshots[0].id)),
  );
  const previous = snapshots[1]
    ? snapshotFromRows(
      snapshots[1],
      (runs || []).filter((row: any) => Number(row.snapshot_id) === Number(snapshots[1].id)),
      (orders || []).filter((row: any) => Number(row.snapshot_id) === Number(snapshots[1].id)),
    )
    : null;
  return buildOpenOrderDashboard(current, previous);
}
