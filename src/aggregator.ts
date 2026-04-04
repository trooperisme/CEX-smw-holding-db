import { ClusterSummary, DiffChange } from "./types";

type HoldingRow = {
  wallet_label: string;
  token_symbol: string;
  token_name: string;
  chain: string;
  value_usd: number;
};

type ClusterAccumulator = {
  token: string;
  chain: string;
  totalValueUSD: number;
  holdersMap: Map<string, number>;
};

function key(token: string, chain: string): string {
  return `${token.toUpperCase()}::${chain.toLowerCase()}`;
}

export function buildClusters(rows: HoldingRow[]): ClusterSummary[] {
  const map = new Map<string, ClusterAccumulator>();
  for (const row of rows) {
    const groupKey = key(row.token_symbol, row.chain);
    const existing = map.get(groupKey) || {
      token: row.token_symbol,
      chain: row.chain,
      totalValueUSD: 0,
      holdersMap: new Map<string, number>(),
    };
    existing.totalValueUSD += Number(row.value_usd || 0);
    existing.holdersMap.set(
      row.wallet_label,
      (existing.holdersMap.get(row.wallet_label) || 0) + Number(row.value_usd || 0),
    );
    map.set(groupKey, existing);
  }

  return [...map.values()]
    .map((item) => ({
      token: item.token,
      chain: item.chain,
      totalValueUSD: item.totalValueUSD,
      holders: [...item.holdersMap.entries()].map(([label, valueUSD]) => ({
        label,
        valueUSD,
      })),
    }))
    .sort((a, b) => b.totalValueUSD - a.totalValueUSD);
}

export function diffClusters(previous: ClusterSummary[], current: ClusterSummary[], thresholdPct = 10): DiffChange[] {
  const prevMap = new Map(previous.map((row) => [key(row.token, row.chain), row]));
  const currMap = new Map(current.map((row) => [key(row.token, row.chain), row]));
  const allKeys = new Set([...prevMap.keys(), ...currMap.keys()]);
  const changes: DiffChange[] = [];

  for (const itemKey of allKeys) {
    const prev = prevMap.get(itemKey);
    const curr = currMap.get(itemKey);
    if (!prev && curr) {
      changes.push({
        type: "NEW",
        token: curr.token,
        chain: curr.chain,
        valueUSD: curr.totalValueUSD,
      });
      continue;
    }

    if (prev && !curr) {
      changes.push({
        type: "EXITED",
        token: prev.token,
        chain: prev.chain,
        valueUSD: prev.totalValueUSD,
      });
      continue;
    }

    if (!prev || !curr) continue;
    if (prev.totalValueUSD <= 0) continue;

    const delta = curr.totalValueUSD - prev.totalValueUSD;
    const changePct = (delta / prev.totalValueUSD) * 100;
    if (Math.abs(changePct) < thresholdPct) continue;

    changes.push({
      type: changePct > 0 ? "INCREASED" : "DECREASED",
      token: curr.token,
      chain: curr.chain,
      oldValue: prev.totalValueUSD,
      newValue: curr.totalValueUSD,
      changePct,
    });
  }

  return changes.sort((a, b) => {
    const aMagnitude = "changePct" in a ? Math.abs(a.changePct) : a.valueUSD;
    const bMagnitude = "changePct" in b ? Math.abs(b.changePct) : b.valueUSD;
    return bMagnitude - aMagnitude;
  });
}
