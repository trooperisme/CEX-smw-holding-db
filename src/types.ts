export type WalletInput = {
  label: string;
  url: string;
};

export type RawTokenHolding = {
  symbol?: string;
  name?: string;
  balance?: string;
  value?: string;
  chain?: string;
};

export type ParsedHolding = {
  walletLabel: string;
  walletUrl: string;
  tokenSymbol: string;
  tokenName: string;
  chain: string;
  balanceRaw: string;
  balanceNumeric: number | null;
  valueUsd: number;
  scrapedAt: string;
};

export type WalletScanStatus =
  | "SUCCESS"
  | "PARTIAL"
  | "FAILED_CF"
  | "FAILED_SELECTOR"
  | "FAILED_TIMEOUT"
  | "FAILED_UNKNOWN";

export type WalletScanRecord = {
  walletLabel: string;
  walletUrl: string;
  status: WalletScanStatus;
  tokensFound: number;
  totalValueUsd: number;
  screenshotPath: string | null;
  errorMessage: string | null;
  startedAt: string;
  finishedAt: string;
};

export type ClusterSummary = {
  token: string;
  chain: string;
  totalValueUSD: number;
  holders: Array<{
    label: string;
    valueUSD: number;
  }>;
};

export type DiffChange =
  | { type: "NEW"; token: string; chain: string; valueUSD: number }
  | { type: "EXITED"; token: string; chain: string; valueUSD: number }
  | {
      type: "INCREASED" | "DECREASED";
      token: string;
      chain: string;
      oldValue: number;
      newValue: number;
      changePct: number;
    };

export type ScanLogger = (line: string) => void;

export type SourceType = "zapper" | "debank";

export type PriorityColor = "red" | "purple" | "yellow" | "unknown";

export type TrackedEntity = {
  entityId: string;
  entityName: string;
  sourceUrl: string;
  normalizedUrl: string;
  sourceType: SourceType;
  notes: string | null;
  isActive: boolean;
  priorityColor: PriorityColor;
  sourceHash: string;
};

export type SheetSyncSummary = {
  rowsRead: number;
  rowsEligible: number;
  rowsSkipped: number;
  rowsUnsupported: number;
  rowsChanged: number;
  rowsUpserted: number;
  rowsQueued: number;
  skippedEntityIds: string[];
};

export type TrackedTrader = {
  traderName: string;
  hypurrscanUrl: string;
  walletAddress: string;
  isActive: boolean;
};

export type SignalMarketType = "crypto" | "tradfi";

export type TraderPositionSide = "long" | "short";

export type TraderPosition = {
  snapshotId: number;
  traderName: string;
  walletAddress: string;
  sourceUrl: string;
  token: string;
  side: TraderPositionSide;
  valueUsd: number;
  marketType: SignalMarketType;
  scrapedAt: string;
  parseStatus: "parsed";
};

export type SignalSnapshotStatus = "running" | "success" | "partial" | "failed";

export type SignalTraderRunStatus = "running" | "success" | "failed";

export type SignalTraderRunRecord = {
  snapshotId: number;
  traderName: string;
  walletAddress: string;
  sourceUrl: string;
  status: SignalTraderRunStatus;
  positionsFound: number;
  errorMessage: string | null;
  startedAt: string;
  finishedAt: string | null;
};

export type TokenSignalMetric = {
  snapshotId: number;
  marketType: SignalMarketType;
  token: string;
  smwFlows: number;
  holdingsUsd: number;
  longSmw: number;
  shortSmw: number;
  longValueUsd: number;
  shortValueUsd: number;
};

export type TokenDrilldownRow = {
  traderName: string;
  walletAddress: string;
  side: TraderPositionSide;
  valueUsd: number;
};
