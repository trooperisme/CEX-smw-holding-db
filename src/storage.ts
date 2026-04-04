import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { ensureDirExists, resolveWorkspacePaths } from "./runtime-paths";
import {
  ParsedHolding,
  SignalMarketType,
  SignalSnapshotStatus,
  SignalTraderRunRecord,
  TokenDrilldownRow,
  TokenSignalMetric,
  TrackedTrader,
  TraderPosition,
  WalletScanRecord,
} from "./types";

export type Storage = ReturnType<typeof createStorage>;

export type ClaudeLongStateRecord = {
  workflowKey: string;
  lastSuccessfulRunAt: string | null;
  lastTargetPositionSize: number | null;
  lastTargetEntryPrice: number | null;
  lastSeenTwapIds: number[];
  lastReportPath: string | null;
  lastReportJsonPath: string | null;
};

export type ClaudeLongRunRecord = {
  workflowKey: string;
  status: "running" | "success" | "failed";
  wallet: string;
  targetAsset: string;
  checkpointStartAt: string | null;
  checkpointEndAt: string | null;
  targetStatus: "OPEN" | "CLOSED" | null;
  behaviorLabel: "accumulating" | "holding" | "exiting" | "closed" | null;
  twapStatus: "active" | "inactive" | "not detected" | null;
  reportPath: string | null;
  reportJsonPath: string | null;
  errorMessage: string | null;
  startedAt: string;
  finishedAt: string | null;
};

export function createStorage(cwd: string) {
  const paths = resolveWorkspacePaths(cwd);
  ensureDirExists(path.dirname(paths.dbFile));
  const db = new Database(paths.dbFile);

  db.exec(`
    CREATE TABLE IF NOT EXISTS snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      label TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS holdings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_id INTEGER,
      wallet_label TEXT,
      wallet_url TEXT,
      token_symbol TEXT,
      token_name TEXT,
      chain TEXT,
      balance_raw TEXT,
      balance_numeric REAL,
      value_usd REAL,
      scraped_at TEXT,
      FOREIGN KEY (snapshot_id) REFERENCES snapshots(id)
    );

    CREATE TABLE IF NOT EXISTS wallet_scans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_id INTEGER NOT NULL,
      wallet_label TEXT NOT NULL,
      wallet_url TEXT NOT NULL,
      status TEXT NOT NULL,
      tokens_found INTEGER NOT NULL DEFAULT 0,
      total_value_usd REAL NOT NULL DEFAULT 0,
      screenshot_path TEXT,
      error_message TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT NOT NULL,
      FOREIGN KEY (snapshot_id) REFERENCES snapshots(id)
    );

    CREATE TABLE IF NOT EXISTS claude_long_state (
      workflow_key TEXT PRIMARY KEY,
      last_successful_run_at TEXT,
      last_target_position_size REAL,
      last_target_entry_price REAL,
      last_seen_twap_ids TEXT NOT NULL DEFAULT '[]',
      last_report_path TEXT,
      last_report_json_path TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS claude_long_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workflow_key TEXT NOT NULL,
      status TEXT NOT NULL,
      wallet TEXT NOT NULL,
      target_asset TEXT NOT NULL,
      checkpoint_start_at TEXT,
      checkpoint_end_at TEXT,
      target_status TEXT,
      behavior_label TEXT,
      twap_status TEXT,
      report_path TEXT,
      report_json_path TEXT,
      error_message TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT
    );

    CREATE TABLE IF NOT EXISTS tracked_traders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trader_name TEXT NOT NULL,
      hypurrscan_url TEXT NOT NULL,
      wallet_address TEXT NOT NULL UNIQUE,
      is_active INTEGER NOT NULL DEFAULT 1,
      imported_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS signal_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      status TEXT NOT NULL,
      total_traders INTEGER NOT NULL DEFAULT 0,
      traders_completed INTEGER NOT NULL DEFAULT 0,
      traders_failed INTEGER NOT NULL DEFAULT 0,
      total_positions INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      created_at TEXT NOT NULL,
      finished_at TEXT
    );

    CREATE TABLE IF NOT EXISTS signal_trader_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_id INTEGER NOT NULL,
      trader_name TEXT NOT NULL,
      wallet_address TEXT NOT NULL,
      source_url TEXT NOT NULL,
      status TEXT NOT NULL,
      positions_found INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      FOREIGN KEY (snapshot_id) REFERENCES signal_snapshots(id)
    );

    CREATE TABLE IF NOT EXISTS trader_positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_id INTEGER NOT NULL,
      trader_name TEXT NOT NULL,
      wallet_address TEXT NOT NULL,
      source_url TEXT NOT NULL,
      token TEXT NOT NULL,
      side TEXT NOT NULL,
      value_usd REAL NOT NULL,
      market_type TEXT NOT NULL,
      scraped_at TEXT NOT NULL,
      parse_status TEXT NOT NULL,
      FOREIGN KEY (snapshot_id) REFERENCES signal_snapshots(id)
    );

    CREATE TABLE IF NOT EXISTS token_signal_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_id INTEGER NOT NULL,
      market_type TEXT NOT NULL,
      token TEXT NOT NULL,
      smw_flows INTEGER NOT NULL,
      holdings_usd REAL NOT NULL,
      long_smw INTEGER NOT NULL,
      short_smw INTEGER NOT NULL,
      long_value_usd REAL NOT NULL,
      short_value_usd REAL NOT NULL,
      FOREIGN KEY (snapshot_id) REFERENCES signal_snapshots(id)
    );

    CREATE INDEX IF NOT EXISTS idx_signal_snapshots_created_at
      ON signal_snapshots (created_at DESC, id DESC);

    CREATE INDEX IF NOT EXISTS idx_signal_trader_runs_snapshot
      ON signal_trader_runs (snapshot_id, id ASC);

    CREATE INDEX IF NOT EXISTS idx_trader_positions_snapshot_market_token
      ON trader_positions (snapshot_id, market_type, token);

    CREATE INDEX IF NOT EXISTS idx_token_signal_metrics_snapshot_market
      ON token_signal_metrics (snapshot_id, market_type, smw_flows DESC, holdings_usd DESC, token ASC);
  `);

  const insertSnapshotStmt = db.prepare(`
    INSERT INTO snapshots (created_at, label)
    VALUES (@createdAt, @label)
  `);

  const insertHoldingStmt = db.prepare(`
    INSERT INTO holdings (
      snapshot_id, wallet_label, wallet_url, token_symbol, token_name,
      chain, balance_raw, balance_numeric, value_usd, scraped_at
    )
    VALUES (
      @snapshotId, @walletLabel, @walletUrl, @tokenSymbol, @tokenName,
      @chain, @balanceRaw, @balanceNumeric, @valueUsd, @scrapedAt
    )
  `);

  const insertWalletScanStmt = db.prepare(`
    INSERT INTO wallet_scans (
      snapshot_id, wallet_label, wallet_url, status, tokens_found,
      total_value_usd, screenshot_path, error_message, started_at, finished_at
    )
    VALUES (
      @snapshotId, @walletLabel, @walletUrl, @status, @tokensFound,
      @totalValueUsd, @screenshotPath, @errorMessage, @startedAt, @finishedAt
    )
  `);

  const insertClaudeLongRunStmt = db.prepare(`
    INSERT INTO claude_long_runs (
      workflow_key, status, wallet, target_asset, checkpoint_start_at,
      checkpoint_end_at, target_status, behavior_label, twap_status,
      report_path, report_json_path, error_message, started_at, finished_at
    )
    VALUES (
      @workflowKey, @status, @wallet, @targetAsset, @checkpointStartAt,
      @checkpointEndAt, @targetStatus, @behaviorLabel, @twapStatus,
      @reportPath, @reportJsonPath, @errorMessage, @startedAt, @finishedAt
    )
  `);

  const updateClaudeLongRunStmt = db.prepare(`
    UPDATE claude_long_runs
    SET workflow_key = COALESCE(@workflowKey, workflow_key),
        status = COALESCE(@status, status),
        wallet = COALESCE(@wallet, wallet),
        target_asset = COALESCE(@targetAsset, target_asset),
        checkpoint_start_at = @checkpointStartAt,
        checkpoint_end_at = @checkpointEndAt,
        target_status = @targetStatus,
        behavior_label = @behaviorLabel,
        twap_status = @twapStatus,
        report_path = @reportPath,
        report_json_path = @reportJsonPath,
        error_message = @errorMessage,
        started_at = COALESCE(@startedAt, started_at),
        finished_at = @finishedAt
    WHERE id = @id
  `);

  const upsertClaudeLongStateStmt = db.prepare(`
    INSERT INTO claude_long_state (
      workflow_key, last_successful_run_at, last_target_position_size,
      last_target_entry_price, last_seen_twap_ids, last_report_path,
      last_report_json_path, created_at, updated_at
    )
    VALUES (
      @workflowKey, @lastSuccessfulRunAt, @lastTargetPositionSize,
      @lastTargetEntryPrice, @lastSeenTwapIds, @lastReportPath,
      @lastReportJsonPath, @createdAt, @updatedAt
    )
    ON CONFLICT(workflow_key) DO UPDATE SET
      last_successful_run_at = excluded.last_successful_run_at,
      last_target_position_size = excluded.last_target_position_size,
      last_target_entry_price = excluded.last_target_entry_price,
      last_seen_twap_ids = excluded.last_seen_twap_ids,
      last_report_path = excluded.last_report_path,
      last_report_json_path = excluded.last_report_json_path,
      updated_at = excluded.updated_at
  `);

  const insertTrackedTraderStmt = db.prepare(`
    INSERT INTO tracked_traders (
      trader_name, hypurrscan_url, wallet_address, is_active, imported_at
    )
    VALUES (
      @traderName, @hypurrscanUrl, @walletAddress, @isActive, @importedAt
    )
  `);

  const clearTrackedTradersStmt = db.prepare(`DELETE FROM tracked_traders`);

  const insertSignalSnapshotStmt = db.prepare(`
    INSERT INTO signal_snapshots (
      status, total_traders, traders_completed, traders_failed,
      total_positions, error_message, created_at, finished_at
    )
    VALUES (
      @status, @totalTraders, @tradersCompleted, @tradersFailed,
      @totalPositions, @errorMessage, @createdAt, @finishedAt
    )
  `);

  const updateSignalSnapshotStmt = db.prepare(`
    UPDATE signal_snapshots
    SET status = COALESCE(@status, status),
        total_traders = COALESCE(@totalTraders, total_traders),
        traders_completed = COALESCE(@tradersCompleted, traders_completed),
        traders_failed = COALESCE(@tradersFailed, traders_failed),
        total_positions = COALESCE(@totalPositions, total_positions),
        error_message = @errorMessage,
        finished_at = @finishedAt
    WHERE id = @id
  `);

  const insertSignalTraderRunStmt = db.prepare(`
    INSERT INTO signal_trader_runs (
      snapshot_id, trader_name, wallet_address, source_url, status,
      positions_found, error_message, started_at, finished_at
    )
    VALUES (
      @snapshotId, @traderName, @walletAddress, @sourceUrl, @status,
      @positionsFound, @errorMessage, @startedAt, @finishedAt
    )
  `);

  const updateSignalTraderRunStmt = db.prepare(`
    UPDATE signal_trader_runs
    SET status = COALESCE(@status, status),
        positions_found = COALESCE(@positionsFound, positions_found),
        error_message = @errorMessage,
        finished_at = @finishedAt
    WHERE id = @id
  `);

  const insertTraderPositionStmt = db.prepare(`
    INSERT INTO trader_positions (
      snapshot_id, trader_name, wallet_address, source_url, token, side,
      value_usd, market_type, scraped_at, parse_status
    )
    VALUES (
      @snapshotId, @traderName, @walletAddress, @sourceUrl, @token, @side,
      @valueUsd, @marketType, @scrapedAt, @parseStatus
    )
  `);

  const clearTokenSignalMetricsBySnapshotStmt = db.prepare(`
    DELETE FROM token_signal_metrics WHERE snapshot_id = ?
  `);

  const insertTokenSignalMetricStmt = db.prepare(`
    INSERT INTO token_signal_metrics (
      snapshot_id, market_type, token, smw_flows, holdings_usd,
      long_smw, short_smw, long_value_usd, short_value_usd
    )
    VALUES (
      @snapshotId, @marketType, @token, @smwFlows, @holdingsUsd,
      @longSmw, @shortSmw, @longValueUsd, @shortValueUsd
    )
  `);

  return {
    db,
    close() {
      db.close();
    },
    createSnapshot(label: string): number {
      const info = insertSnapshotStmt.run({
        createdAt: new Date().toISOString(),
        label,
      });
      return Number(info.lastInsertRowid);
    },
    insertHoldings(snapshotId: number, holdings: ParsedHolding[]): void {
      const tx = db.transaction((rows: ParsedHolding[]) => {
        for (const row of rows) {
          insertHoldingStmt.run({
            snapshotId,
            walletLabel: row.walletLabel,
            walletUrl: row.walletUrl,
            tokenSymbol: row.tokenSymbol,
            tokenName: row.tokenName,
            chain: row.chain,
            balanceRaw: row.balanceRaw,
            balanceNumeric: row.balanceNumeric,
            valueUsd: row.valueUsd,
            scrapedAt: row.scrapedAt,
          });
        }
      });
      tx(holdings);
    },
    insertWalletScan(snapshotId: number, record: WalletScanRecord): void {
      insertWalletScanStmt.run({
        snapshotId,
        walletLabel: record.walletLabel,
        walletUrl: record.walletUrl,
        status: record.status,
        tokensFound: record.tokensFound,
        totalValueUsd: record.totalValueUsd,
        screenshotPath: record.screenshotPath,
        errorMessage: record.errorMessage,
        startedAt: record.startedAt,
        finishedAt: record.finishedAt,
      });
    },
    getSnapshotSummaries(): Array<{
      id: number;
      created_at: string;
      label: string;
      total_value_usd: number;
      wallets_scanned: number;
    }> {
      const rows = db
        .prepare(
          `
          SELECT
            s.id,
            s.created_at,
            s.label,
            COALESCE(SUM(h.value_usd), 0) AS total_value_usd,
            COALESCE(COUNT(DISTINCT ws.wallet_label), 0) AS wallets_scanned
          FROM snapshots s
          LEFT JOIN holdings h ON h.snapshot_id = s.id
          LEFT JOIN wallet_scans ws ON ws.snapshot_id = s.id
          GROUP BY s.id
          ORDER BY s.id DESC
          `,
        )
        .all() as any[];
      return rows.map((r) => ({
        ...r,
        total_value_usd: Number(r.total_value_usd || 0),
        wallets_scanned: Number(r.wallets_scanned || 0),
      }));
    },
    getLatestSnapshotId(): number | null {
      const row = db.prepare(`SELECT id FROM snapshots ORDER BY id DESC LIMIT 1`).get() as
        | { id: number }
        | undefined;
      return row?.id ?? null;
    },
    getHoldingsBySnapshot(snapshotId: number): Array<{
      wallet_label: string;
      wallet_url: string;
      token_symbol: string;
      token_name: string;
      chain: string;
      balance_raw: string;
      balance_numeric: number | null;
      value_usd: number;
      scraped_at: string;
    }> {
      const rows = db
        .prepare(
          `
          SELECT wallet_label, wallet_url, token_symbol, token_name, chain,
                 balance_raw, balance_numeric, value_usd, scraped_at
          FROM holdings
          WHERE snapshot_id = ?
          ORDER BY value_usd DESC
          `,
        )
        .all(snapshotId) as any[];

      return rows.map((r) => ({
        ...r,
        value_usd: Number(r.value_usd || 0),
        balance_numeric: r.balance_numeric === null ? null : Number(r.balance_numeric),
      }));
    },
    getWalletNames(snapshotId: number): string[] {
      const rows = db
        .prepare(
          `SELECT DISTINCT wallet_label FROM holdings WHERE snapshot_id = ? ORDER BY wallet_label`,
        )
        .all(snapshotId) as Array<{ wallet_label: string }>;
      return rows.map((r) => r.wallet_label);
    },
    getWalletHoldings(snapshotId: number, walletLabel: string): Array<{
      token_symbol: string;
      token_name: string;
      chain: string;
      balance_raw: string;
      value_usd: number;
      wallet_url: string;
    }> {
      const rows = db
        .prepare(
          `
          SELECT token_symbol, token_name, chain, balance_raw, value_usd, wallet_url
          FROM holdings
          WHERE snapshot_id = ? AND wallet_label = ?
          ORDER BY value_usd DESC
          `,
        )
        .all(snapshotId, walletLabel) as any[];
      return rows.map((r) => ({
        ...r,
        value_usd: Number(r.value_usd || 0),
      }));
    },
    getWalletScanRecords(snapshotId: number): Array<{
      wallet_label: string;
      wallet_url: string;
      status: string;
      tokens_found: number;
      total_value_usd: number;
      screenshot_path: string | null;
      error_message: string | null;
      started_at: string;
      finished_at: string;
    }> {
      const rows = db
        .prepare(
          `
          SELECT wallet_label, wallet_url, status, tokens_found, total_value_usd,
                 screenshot_path, error_message, started_at, finished_at
          FROM wallet_scans
          WHERE snapshot_id = ?
          ORDER BY id ASC
          `,
        )
        .all(snapshotId) as any[];
      return rows.map((r) => ({
        ...r,
        tokens_found: Number(r.tokens_found || 0),
        total_value_usd: Number(r.total_value_usd || 0),
      }));
    },
    replaceTrackedTraders(traders: TrackedTrader[]): void {
      const now = new Date().toISOString();
      const tx = db.transaction((rows: TrackedTrader[]) => {
        clearTrackedTradersStmt.run();
        for (const trader of rows) {
          insertTrackedTraderStmt.run({
            traderName: trader.traderName,
            hypurrscanUrl: trader.hypurrscanUrl,
            walletAddress: trader.walletAddress,
            isActive: trader.isActive ? 1 : 0,
            importedAt: now,
          });
        }
      });
      tx(traders);
    },
    getTrackedTraders(): TrackedTrader[] {
      const rows = db
        .prepare(
          `
          SELECT trader_name, hypurrscan_url, wallet_address, is_active
          FROM tracked_traders
          WHERE is_active = 1
          ORDER BY trader_name ASC, wallet_address ASC
          `,
        )
        .all() as Array<{
          trader_name: string;
          hypurrscan_url: string;
          wallet_address: string;
          is_active: number;
        }>;
      return rows.map((row) => ({
        traderName: row.trader_name,
        hypurrscanUrl: row.hypurrscan_url,
        walletAddress: row.wallet_address,
        isActive: Boolean(row.is_active),
      }));
    },
    createSignalSnapshot(totalTraders: number): number {
      const now = new Date().toISOString();
      const info = insertSignalSnapshotStmt.run({
        status: "running",
        totalTraders,
        tradersCompleted: 0,
        tradersFailed: 0,
        totalPositions: 0,
        errorMessage: null,
        createdAt: now,
        finishedAt: null,
      });
      return Number(info.lastInsertRowid);
    },
    updateSignalSnapshot(args: {
      id: number;
      status?: SignalSnapshotStatus | null;
      totalTraders?: number | null;
      tradersCompleted?: number | null;
      tradersFailed?: number | null;
      totalPositions?: number | null;
      errorMessage?: string | null;
      finishedAt?: string | null;
    }): void {
      updateSignalSnapshotStmt.run({
        id: args.id,
        status: args.status ?? null,
        totalTraders: args.totalTraders ?? null,
        tradersCompleted: args.tradersCompleted ?? null,
        tradersFailed: args.tradersFailed ?? null,
        totalPositions: args.totalPositions ?? null,
        errorMessage: args.errorMessage ?? null,
        finishedAt: args.finishedAt ?? null,
      });
    },
    getSignalSnapshots(): Array<{
      id: number;
      status: SignalSnapshotStatus;
      total_traders: number;
      traders_completed: number;
      traders_failed: number;
      total_positions: number;
      error_message: string | null;
      created_at: string;
      finished_at: string | null;
    }> {
      const rows = db
        .prepare(
          `
          SELECT id, status, total_traders, traders_completed, traders_failed,
                 total_positions, error_message, created_at, finished_at
          FROM signal_snapshots
          ORDER BY id DESC
          `,
        )
        .all() as any[];
      return rows.map((row) => ({
        ...row,
        total_traders: Number(row.total_traders || 0),
        traders_completed: Number(row.traders_completed || 0),
        traders_failed: Number(row.traders_failed || 0),
        total_positions: Number(row.total_positions || 0),
      }));
    },
    getLatestSignalSnapshotId(): number | null {
      const row = db
        .prepare(`SELECT id FROM signal_snapshots ORDER BY id DESC LIMIT 1`)
        .get() as { id: number } | undefined;
      return row?.id ?? null;
    },
    getSignalSnapshot(snapshotId: number): {
      id: number;
      status: SignalSnapshotStatus;
      total_traders: number;
      traders_completed: number;
      traders_failed: number;
      total_positions: number;
      error_message: string | null;
      created_at: string;
      finished_at: string | null;
    } | null {
      const row = db
        .prepare(
          `
          SELECT id, status, total_traders, traders_completed, traders_failed,
                 total_positions, error_message, created_at, finished_at
          FROM signal_snapshots
          WHERE id = ?
          LIMIT 1
          `,
        )
        .get(snapshotId) as any;
      if (!row) return null;
      return {
        ...row,
        total_traders: Number(row.total_traders || 0),
        traders_completed: Number(row.traders_completed || 0),
        traders_failed: Number(row.traders_failed || 0),
        total_positions: Number(row.total_positions || 0),
      };
    },
    insertSignalTraderRun(record: SignalTraderRunRecord): number {
      const info = insertSignalTraderRunStmt.run({
        snapshotId: record.snapshotId,
        traderName: record.traderName,
        walletAddress: record.walletAddress,
        sourceUrl: record.sourceUrl,
        status: record.status,
        positionsFound: record.positionsFound,
        errorMessage: record.errorMessage,
        startedAt: record.startedAt,
        finishedAt: record.finishedAt,
      });
      return Number(info.lastInsertRowid);
    },
    updateSignalTraderRun(
      runId: number,
      updates: Partial<Pick<SignalTraderRunRecord, "status" | "positionsFound" | "errorMessage" | "finishedAt">>,
    ): void {
      updateSignalTraderRunStmt.run({
        id: runId,
        status: updates.status ?? null,
        positionsFound: updates.positionsFound ?? null,
        errorMessage: updates.errorMessage ?? null,
        finishedAt: updates.finishedAt ?? null,
      });
    },
    getSignalTraderRuns(snapshotId: number): SignalTraderRunRecord[] {
      const rows = db
        .prepare(
          `
          SELECT snapshot_id, trader_name, wallet_address, source_url, status,
                 positions_found, error_message, started_at, finished_at
          FROM signal_trader_runs
          WHERE snapshot_id = ?
          ORDER BY id ASC
          `,
        )
        .all(snapshotId) as any[];
      return rows.map((row) => ({
        snapshotId: Number(row.snapshot_id),
        traderName: row.trader_name,
        walletAddress: row.wallet_address,
        sourceUrl: row.source_url,
        status: row.status,
        positionsFound: Number(row.positions_found || 0),
        errorMessage: row.error_message,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
      }));
    },
    insertTraderPositions(snapshotId: number, positions: Omit<TraderPosition, "snapshotId">[]): void {
      const tx = db.transaction((rows: Omit<TraderPosition, "snapshotId">[]) => {
        for (const row of rows) {
          insertTraderPositionStmt.run({
            snapshotId,
            traderName: row.traderName,
            walletAddress: row.walletAddress,
            sourceUrl: row.sourceUrl,
            token: row.token,
            side: row.side,
            valueUsd: row.valueUsd,
            marketType: row.marketType,
            scrapedAt: row.scrapedAt,
            parseStatus: row.parseStatus,
          });
        }
      });
      tx(positions);
    },
    getTraderPositions(snapshotId: number): TraderPosition[] {
      const rows = db
        .prepare(
          `
          SELECT snapshot_id, trader_name, wallet_address, source_url, token, side,
                 value_usd, market_type, scraped_at, parse_status
          FROM trader_positions
          WHERE snapshot_id = ?
          ORDER BY token ASC, value_usd DESC
          `,
        )
        .all(snapshotId) as any[];
      return rows.map((row) => ({
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
      }));
    },
    replaceTokenSignalMetrics(snapshotId: number, metrics: TokenSignalMetric[]): void {
      const tx = db.transaction((rows: TokenSignalMetric[]) => {
        clearTokenSignalMetricsBySnapshotStmt.run(snapshotId);
        for (const row of rows) {
          insertTokenSignalMetricStmt.run({
            snapshotId: row.snapshotId,
            marketType: row.marketType,
            token: row.token,
            smwFlows: row.smwFlows,
            holdingsUsd: row.holdingsUsd,
            longSmw: row.longSmw,
            shortSmw: row.shortSmw,
            longValueUsd: row.longValueUsd,
            shortValueUsd: row.shortValueUsd,
          });
        }
      });
      tx(metrics);
    },
    getTokenSignalMetrics(snapshotId: number, marketType: SignalMarketType): TokenSignalMetric[] {
      const rows = db
        .prepare(
          `
          SELECT snapshot_id, market_type, token, smw_flows, holdings_usd,
                 long_smw, short_smw, long_value_usd, short_value_usd
          FROM token_signal_metrics
          WHERE snapshot_id = ? AND market_type = ?
          ORDER BY smw_flows DESC, holdings_usd DESC, token ASC
          `,
        )
        .all(snapshotId, marketType) as any[];
      return rows.map((row) => ({
        snapshotId: Number(row.snapshot_id),
        marketType: row.market_type,
        token: row.token,
        smwFlows: Number(row.smw_flows || 0),
        holdingsUsd: Number(row.holdings_usd || 0),
        longSmw: Number(row.long_smw || 0),
        shortSmw: Number(row.short_smw || 0),
        longValueUsd: Number(row.long_value_usd || 0),
        shortValueUsd: Number(row.short_value_usd || 0),
      }));
    },
    getTokenDrilldown(snapshotId: number, token: string): {
      token: string;
      longRows: TokenDrilldownRow[];
      shortRows: TokenDrilldownRow[];
    } {
      const rows = db
        .prepare(
          `
          SELECT trader_name, wallet_address, side, value_usd
          FROM trader_positions
          WHERE snapshot_id = ? AND token = ?
          ORDER BY side ASC, value_usd DESC, trader_name ASC
          `,
        )
        .all(snapshotId, token) as any[];

      const mapped: TokenDrilldownRow[] = rows.map((row) => ({
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
    getClaudeLongState(workflowKey = "claude_long"): ClaudeLongStateRecord | null {
      const row = db
        .prepare(
          `
          SELECT workflow_key, last_successful_run_at, last_target_position_size,
                 last_target_entry_price, last_seen_twap_ids, last_report_path,
                 last_report_json_path
          FROM claude_long_state
          WHERE workflow_key = ?
          LIMIT 1
          `,
        )
        .get(workflowKey) as
        | {
            workflow_key: string;
            last_successful_run_at: string | null;
            last_target_position_size: number | null;
            last_target_entry_price: number | null;
            last_seen_twap_ids: string | null;
            last_report_path: string | null;
            last_report_json_path: string | null;
          }
        | undefined;

      if (!row) return null;
      let lastSeenTwapIds: number[] = [];
      try {
        const parsed = JSON.parse(row.last_seen_twap_ids || "[]");
        if (Array.isArray(parsed)) {
          lastSeenTwapIds = parsed
            .map((value) => Number(value))
            .filter((value) => Number.isFinite(value));
        }
      } catch {
        lastSeenTwapIds = [];
      }

      return {
        workflowKey: row.workflow_key,
        lastSuccessfulRunAt: row.last_successful_run_at,
        lastTargetPositionSize:
          row.last_target_position_size === null ? null : Number(row.last_target_position_size),
        lastTargetEntryPrice:
          row.last_target_entry_price === null ? null : Number(row.last_target_entry_price),
        lastSeenTwapIds,
        lastReportPath: row.last_report_path,
        lastReportJsonPath: row.last_report_json_path,
      };
    },
    upsertClaudeLongState(state: ClaudeLongStateRecord): void {
      const now = new Date().toISOString();
      upsertClaudeLongStateStmt.run({
        workflowKey: state.workflowKey,
        lastSuccessfulRunAt: state.lastSuccessfulRunAt,
        lastTargetPositionSize: state.lastTargetPositionSize,
        lastTargetEntryPrice: state.lastTargetEntryPrice,
        lastSeenTwapIds: JSON.stringify(state.lastSeenTwapIds || []),
        lastReportPath: state.lastReportPath,
        lastReportJsonPath: state.lastReportJsonPath,
        createdAt: now,
        updatedAt: now,
      });
    },
    insertClaudeLongRun(run: ClaudeLongRunRecord): number {
      const info = insertClaudeLongRunStmt.run({
        workflowKey: run.workflowKey,
        status: run.status,
        wallet: run.wallet,
        targetAsset: run.targetAsset,
        checkpointStartAt: run.checkpointStartAt,
        checkpointEndAt: run.checkpointEndAt,
        targetStatus: run.targetStatus,
        behaviorLabel: run.behaviorLabel,
        twapStatus: run.twapStatus,
        reportPath: run.reportPath,
        reportJsonPath: run.reportJsonPath,
        errorMessage: run.errorMessage,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
      });
      return Number(info.lastInsertRowid);
    },
    updateClaudeLongRun(runId: number, updates: Partial<ClaudeLongRunRecord>): void {
      updateClaudeLongRunStmt.run({
        id: runId,
        workflowKey: updates.workflowKey ?? null,
        status: updates.status ?? null,
        wallet: updates.wallet ?? null,
        targetAsset: updates.targetAsset ?? null,
        checkpointStartAt: updates.checkpointStartAt ?? null,
        checkpointEndAt: updates.checkpointEndAt ?? null,
        targetStatus: updates.targetStatus ?? null,
        behaviorLabel: updates.behaviorLabel ?? null,
        twapStatus: updates.twapStatus ?? null,
        reportPath: updates.reportPath ?? null,
        reportJsonPath: updates.reportJsonPath ?? null,
        errorMessage: updates.errorMessage ?? null,
        startedAt: updates.startedAt ?? null,
        finishedAt: updates.finishedAt ?? null,
      });
    },
  };
}
