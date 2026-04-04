const HYPERLIQUID_INFO_URL = "https://api.hyperliquid.xyz/info";

export type HyperliquidInfoPayload = {
  type: string;
  [key: string]: unknown;
};

export type HyperliquidClearinghousePosition = {
  coin?: string;
  szi?: string;
  entryPx?: string;
  breakEvenPx?: string;
  unrealizedPnl?: string;
  leverage?: string | number;
  markPx?: string;
  px?: string;
  currentPrice?: string;
  [key: string]: unknown;
};

export type HyperliquidClearinghouseAssetPosition = {
  position?: HyperliquidClearinghousePosition;
  [key: string]: unknown;
};

export type HyperliquidClearinghouseState = {
  marginSummary?: {
    accountValue?: string;
    totalNtlPos?: string;
    totalRawUsd?: string;
    totalMarginUsed?: string;
    [key: string]: unknown;
  };
  crossMarginSummary?: {
    accountValue?: string;
    totalNtlPos?: string;
    totalRawUsd?: string;
    totalMarginUsed?: string;
    [key: string]: unknown;
  };
  crossMaintenanceMarginUsed?: string;
  withdrawable?: string;
  assetPositions?: HyperliquidClearinghouseAssetPosition[];
  time?: number;
  [key: string]: unknown;
};

export type HyperliquidFill = {
  coin?: string;
  px?: string;
  sz?: string;
  side?: string;
  time?: number;
  startPosition?: string;
  dir?: string;
  closedPnl?: string;
  hash?: string;
  oid?: number;
  crossed?: boolean;
  fee?: string;
  feeToken?: string;
  twapId?: number | null;
  [key: string]: unknown;
};

export type HyperliquidTwapSliceFill = {
  fill?: HyperliquidFill;
  twapId?: number;
  [key: string]: unknown;
};

export type HyperliquidMetaAndAssetCtxs = [
  {
    universe?: Array<{
      name?: string;
      szDecimals?: number;
      maxLeverage?: number;
      marginTableId?: number;
      isDelisted?: boolean;
      onlyIsolated?: boolean;
      marginMode?: string;
      [key: string]: unknown;
    }>;
    [key: string]: unknown;
  },
  Array<Record<string, unknown>>,
];

async function postInfo<T>(payload: HyperliquidInfoPayload): Promise<T> {
  const response = await fetch(HYPERLIQUID_INFO_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Hyperliquid info request failed (${response.status}): ${body}`);
  }

  return (await response.json()) as T;
}

export async function getClearinghouseState(user: string): Promise<HyperliquidClearinghouseState> {
  return postInfo<HyperliquidClearinghouseState>({ type: "clearinghouseState", user });
}

export async function getUserFillsByTime(
  user: string,
  startTime: number,
  endTime?: number | null,
): Promise<HyperliquidFill[]> {
  return postInfo<HyperliquidFill[]>({
    type: "userFillsByTime",
    user,
    startTime,
    ...(typeof endTime === "number" ? { endTime } : {}),
  });
}

export async function getUserTwapSliceFills(user: string): Promise<HyperliquidTwapSliceFill[]> {
  return postInfo<HyperliquidTwapSliceFill[]>({ type: "userTwapSliceFills", user });
}

export async function getAllMids(): Promise<Record<string, string>> {
  return postInfo<Record<string, string>>({ type: "allMids" });
}

export async function getMetaAndAssetCtxs(): Promise<HyperliquidMetaAndAssetCtxs> {
  return postInfo<HyperliquidMetaAndAssetCtxs>({ type: "metaAndAssetCtxs" });
}
