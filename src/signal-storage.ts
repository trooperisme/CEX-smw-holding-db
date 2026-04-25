import { createStorage } from "./storage";
import { getSupabaseAdminClient } from "./supabase";
import {
  SignalMarketType,
  SignalSnapshotStatus,
  SignalTraderRunRecord,
  TokenDrilldownRow,
  TokenSignalMetric,
  TrackedTrader,
  TraderPosition,
} from "./types";

export type SignalSnapshotRecord = {
  id: number;
  status: SignalSnapshotStatus;
  total_traders: number;
  traders_completed: number;
  traders_failed: number;
  total_positions: number;
  error_message: string | null;
  created_at: string;
  finished_at: string | null;
};

type SignalSnapshotUpdate = {
  id: number;
  status?: SignalSnapshotStatus | null;
  totalTraders?: number | null;
  tradersCompleted?: number | null;
  tradersFailed?: number | null;
  totalPositions?: number | null;
  errorMessage?: string | null;
  finishedAt?: string | null;
};

export type SignalStorage = {
  close(): void;
  replaceTrackedTraders(traders: TrackedTrader[]): Promise<void>;
  getTrackedTraders(): Promise<TrackedTrader[]>;
  createSignalSnapshot(totalTraders: number): Promise<number>;
  updateSignalSnapshot(args: SignalSnapshotUpdate): Promise<void>;
  getSignalSnapshots(): Promise<SignalSnapshotRecord[]>;
  getLatestSignalSnapshotId(): Promise<number | null>;
  getSignalSnapshot(snapshotId: number): Promise<SignalSnapshotRecord | null>;
  insertSignalTraderRun(record: SignalTraderRunRecord): Promise<number>;
  updateSignalTraderRun(
    runId: number,
    updates: Partial<Pick<SignalTraderRunRecord, "status" | "positionsFound" | "errorMessage" | "finishedAt">>,
  ): Promise<void>;
  getSignalTraderRuns(snapshotId: number): Promise<SignalTraderRunRecord[]>;
  insertTraderPositions(snapshotId: number, positions: Omit<TraderPosition, "snapshotId">[]): Promise<void>;
  getTraderPositions(snapshotId: number): Promise<TraderPosition[]>;
  replaceTokenSignalMetrics(snapshotId: number, metrics: TokenSignalMetric[]): Promise<void>;
  getTokenSignalMetrics(snapshotId: number, marketType: SignalMarketType): Promise<TokenSignalMetric[]>;
  getTokenDrilldown(snapshotId: number, token: string): Promise<{
    token: string;
    longRows: TokenDrilldownRow[];
    shortRows: TokenDrilldownRow[];
  }>;
};

function requireSupabaseSignals(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

function assertNoSupabaseError(error: { message: string } | null, context: string): void {
  if (error) {
    throw new Error(`${context}: ${error.message}`);
  }
}

function mapSnapshot(row: any): SignalSnapshotRecord {
  return {
    id: Number(row.id),
    status: row.status,
    total_traders: Number(row.total_traders || 0),
    traders_completed: Number(row.traders_completed || 0),
    traders_failed: Number(row.traders_failed || 0),
    total_positions: Number(row.total_positions || 0),
    error_message: row.error_message ?? null,
    created_at: row.created_at,
    finished_at: row.finished_at ?? null,
  };
}

function mapTraderRun(row: any): SignalTraderRunRecord {
  return {
    snapshotId: Number(row.snapshot_id),
    traderName: row.trader_name,
    walletAddress: row.wallet_address,
    sourceUrl: row.source_url,
    status: row.status,
    positionsFound: Number(row.positions_found || 0),
    errorMessage: row.error_message ?? null,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? null,
  };
}

function mapTraderPosition(row: any): TraderPosition {
  return {
    snapshotId: Number(row.snapshot_id),
    traderName: row.trader_name,
    walletAddress: row.wallet_address,
    sourceUrl: row.source_url,
    token: row.token,
    side: row.side,
    valueUsd: Number(row.value_usd || 0),
    marketType: row.market_type,
    scrapedAt: row.scraped_at,
    parseStatus: row.parse_status,
  };
}

function mapMetric(row: any): TokenSignalMetric {
  return {
    snapshotId: Number(row.snapshot_id),
    marketType: row.market_type,
    token: row.token,
    smwFlows: Number(row.smw_flows || 0),
    holdingsUsd: Number(row.holdings_usd || 0),
    longSmw: Number(row.long_smw || 0),
    shortSmw: Number(row.short_smw || 0),
    longValueUsd: Number(row.long_value_usd || 0),
    shortValueUsd: Number(row.short_value_usd || 0),
  };
}

function createSqliteSignalStorage(cwd: string): SignalStorage {
  const storage = createStorage(cwd);
  return {
    close: () => storage.close(),
    replaceTrackedTraders: async (traders) => storage.replaceTrackedTraders(traders),
    getTrackedTraders: async () => storage.getTrackedTraders(),
    createSignalSnapshot: async (totalTraders) => storage.createSignalSnapshot(totalTraders),
    updateSignalSnapshot: async (args) => storage.updateSignalSnapshot(args),
    getSignalSnapshots: async () => storage.getSignalSnapshots(),
    getLatestSignalSnapshotId: async () => storage.getLatestSignalSnapshotId(),
    getSignalSnapshot: async (snapshotId) => storage.getSignalSnapshot(snapshotId),
    insertSignalTraderRun: async (record) => storage.insertSignalTraderRun(record),
    updateSignalTraderRun: async (runId, updates) => storage.updateSignalTraderRun(runId, updates),
    getSignalTraderRuns: async (snapshotId) => storage.getSignalTraderRuns(snapshotId),
    insertTraderPositions: async (snapshotId, positions) => storage.insertTraderPositions(snapshotId, positions),
    getTraderPositions: async (snapshotId) => storage.getTraderPositions(snapshotId),
    replaceTokenSignalMetrics: async (snapshotId, metrics) =>
      storage.replaceTokenSignalMetrics(snapshotId, metrics),
    getTokenSignalMetrics: async (snapshotId, marketType) =>
      storage.getTokenSignalMetrics(snapshotId, marketType),
    getTokenDrilldown: async (snapshotId, token) => storage.getTokenDrilldown(snapshotId, token),
  };
}

function createSupabaseSignalStorage(): SignalStorage {
  const supabase = getSupabaseAdminClient();
  return {
    close: () => undefined,
    async replaceTrackedTraders(traders) {
      const deleteResult = await supabase.from("tracked_traders").delete().neq("wallet_address", "");
      assertNoSupabaseError(deleteResult.error, "Delete tracked traders");

      if (!traders.length) return;
      const insertResult = await supabase.from("tracked_traders").insert(
        traders.map((trader) => ({
          trader_name: trader.traderName,
          hypurrscan_url: trader.hypurrscanUrl,
          wallet_address: trader.walletAddress,
          is_active: trader.isActive,
          imported_at: new Date().toISOString(),
        })),
      );
      assertNoSupabaseError(insertResult.error, "Insert tracked traders");
    },
    async getTrackedTraders() {
      const { data, error } = await supabase
        .from("tracked_traders")
        .select("trader_name,hypurrscan_url,wallet_address,is_active")
        .eq("is_active", true)
        .order("trader_name", { ascending: true })
        .order("wallet_address", { ascending: true });
      assertNoSupabaseError(error, "Load tracked traders");
      return (data || []).map((row: any) => ({
        traderName: row.trader_name,
        hypurrscanUrl: row.hypurrscan_url,
        walletAddress: row.wallet_address,
        isActive: Boolean(row.is_active),
      }));
    },
    async createSignalSnapshot(totalTraders) {
      const { data, error } = await supabase
        .from("signal_snapshots")
        .insert({
          status: "running",
          total_traders: totalTraders,
          traders_completed: 0,
          traders_failed: 0,
          total_positions: 0,
          error_message: null,
          created_at: new Date().toISOString(),
          finished_at: null,
        })
        .select("id")
        .single();
      assertNoSupabaseError(error, "Create signal snapshot");
      if (!data?.id) throw new Error("Create signal snapshot: missing id");
      return Number(data.id);
    },
    async updateSignalSnapshot(args) {
      const values: Record<string, unknown> = {};
      if (args.status !== undefined) values.status = args.status;
      if (args.totalTraders !== undefined) values.total_traders = args.totalTraders;
      if (args.tradersCompleted !== undefined) values.traders_completed = args.tradersCompleted;
      if (args.tradersFailed !== undefined) values.traders_failed = args.tradersFailed;
      if (args.totalPositions !== undefined) values.total_positions = args.totalPositions;
      if (args.errorMessage !== undefined) values.error_message = args.errorMessage;
      if (args.finishedAt !== undefined) values.finished_at = args.finishedAt;
      if (!Object.keys(values).length) return;

      const { error } = await supabase.from("signal_snapshots").update(values).eq("id", args.id);
      assertNoSupabaseError(error, "Update signal snapshot");
    },
    async getSignalSnapshots() {
      const { data, error } = await supabase
        .from("signal_snapshots")
        .select("id,status,total_traders,traders_completed,traders_failed,total_positions,error_message,created_at,finished_at")
        .order("id", { ascending: false });
      assertNoSupabaseError(error, "Load signal snapshots");
      return (data || []).map(mapSnapshot);
    },
    async getLatestSignalSnapshotId() {
      const { data, error } = await supabase
        .from("signal_snapshots")
        .select("id")
        .order("id", { ascending: false })
        .limit(1)
        .maybeSingle();
      assertNoSupabaseError(error, "Load latest signal snapshot");
      return data?.id ? Number(data.id) : null;
    },
    async getSignalSnapshot(snapshotId) {
      const { data, error } = await supabase
        .from("signal_snapshots")
        .select("id,status,total_traders,traders_completed,traders_failed,total_positions,error_message,created_at,finished_at")
        .eq("id", snapshotId)
        .maybeSingle();
      assertNoSupabaseError(error, "Load signal snapshot");
      return data ? mapSnapshot(data) : null;
    },
    async insertSignalTraderRun(record) {
      const { data, error } = await supabase
        .from("signal_trader_runs")
        .insert({
          snapshot_id: record.snapshotId,
          trader_name: record.traderName,
          wallet_address: record.walletAddress,
          source_url: record.sourceUrl,
          status: record.status,
          positions_found: record.positionsFound,
          error_message: record.errorMessage,
          started_at: record.startedAt,
          finished_at: record.finishedAt,
        })
        .select("id")
        .single();
      assertNoSupabaseError(error, "Insert signal trader run");
      if (!data?.id) throw new Error("Insert signal trader run: missing id");
      return Number(data.id);
    },
    async updateSignalTraderRun(runId, updates) {
      const values: Record<string, unknown> = {};
      if (updates.status !== undefined) values.status = updates.status;
      if (updates.positionsFound !== undefined) values.positions_found = updates.positionsFound;
      if (updates.errorMessage !== undefined) values.error_message = updates.errorMessage;
      if (updates.finishedAt !== undefined) values.finished_at = updates.finishedAt;
      if (!Object.keys(values).length) return;

      const { error } = await supabase.from("signal_trader_runs").update(values).eq("id", runId);
      assertNoSupabaseError(error, "Update signal trader run");
    },
    async getSignalTraderRuns(snapshotId) {
      const { data, error } = await supabase
        .from("signal_trader_runs")
        .select("snapshot_id,trader_name,wallet_address,source_url,status,positions_found,error_message,started_at,finished_at")
        .eq("snapshot_id", snapshotId)
        .order("id", { ascending: true });
      assertNoSupabaseError(error, "Load signal trader runs");
      return (data || []).map(mapTraderRun);
    },
    async insertTraderPositions(snapshotId, positions) {
      if (!positions.length) return;
      const { error } = await supabase.from("trader_positions").insert(
        positions.map((row) => ({
          snapshot_id: snapshotId,
          trader_name: row.traderName,
          wallet_address: row.walletAddress,
          source_url: row.sourceUrl,
          token: row.token,
          side: row.side,
          value_usd: row.valueUsd,
          market_type: row.marketType,
          scraped_at: row.scrapedAt,
          parse_status: row.parseStatus,
        })),
      );
      assertNoSupabaseError(error, "Insert trader positions");
    },
    async getTraderPositions(snapshotId) {
      const { data, error } = await supabase
        .from("trader_positions")
        .select("snapshot_id,trader_name,wallet_address,source_url,token,side,value_usd,market_type,scraped_at,parse_status")
        .eq("snapshot_id", snapshotId)
        .order("token", { ascending: true })
        .order("value_usd", { ascending: false });
      assertNoSupabaseError(error, "Load trader positions");
      return (data || []).map(mapTraderPosition);
    },
    async replaceTokenSignalMetrics(snapshotId, metrics) {
      const deleteResult = await supabase.from("token_signal_metrics").delete().eq("snapshot_id", snapshotId);
      assertNoSupabaseError(deleteResult.error, "Delete token signal metrics");

      if (!metrics.length) return;
      const { error } = await supabase.from("token_signal_metrics").insert(
        metrics.map((row) => ({
          snapshot_id: row.snapshotId,
          market_type: row.marketType,
          token: row.token,
          smw_flows: row.smwFlows,
          holdings_usd: row.holdingsUsd,
          long_smw: row.longSmw,
          short_smw: row.shortSmw,
          long_value_usd: row.longValueUsd,
          short_value_usd: row.shortValueUsd,
        })),
      );
      assertNoSupabaseError(error, "Insert token signal metrics");
    },
    async getTokenSignalMetrics(snapshotId, marketType) {
      const { data, error } = await supabase
        .from("token_signal_metrics")
        .select("snapshot_id,market_type,token,smw_flows,holdings_usd,long_smw,short_smw,long_value_usd,short_value_usd")
        .eq("snapshot_id", snapshotId)
        .eq("market_type", marketType)
        .order("smw_flows", { ascending: false })
        .order("holdings_usd", { ascending: false })
        .order("token", { ascending: true });
      assertNoSupabaseError(error, "Load token signal metrics");
      return (data || []).map(mapMetric);
    },
    async getTokenDrilldown(snapshotId, token) {
      const { data, error } = await supabase
        .from("trader_positions")
        .select("trader_name,wallet_address,side,value_usd")
        .eq("snapshot_id", snapshotId)
        .eq("token", token)
        .order("side", { ascending: true })
        .order("value_usd", { ascending: false })
        .order("trader_name", { ascending: true });
      assertNoSupabaseError(error, "Load token drilldown");

      const mapped: TokenDrilldownRow[] = (data || []).map((row: any) => ({
        traderName: row.trader_name,
        walletAddress: row.wallet_address,
        side: row.side,
        valueUsd: Number(row.value_usd || 0),
      }));

      return {
        token,
        longRows: mapped.filter((row) => row.side === "long"),
        shortRows: mapped.filter((row) => row.side === "short"),
      };
    },
  };
}

export function createSignalStorage(cwd: string): SignalStorage {
  return requireSupabaseSignals() ? createSupabaseSignalStorage() : createSqliteSignalStorage(cwd);
}
