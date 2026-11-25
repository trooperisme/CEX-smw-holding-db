# Project Context for AI

## What this project does

This repository builds a crypto trader and wallet tracking dashboard. It collects position and holdings data for a configured set of traders, aggregates it into timestamped snapshots, and provides dashboard views and Markdown exports for analysis. The product includes:

- **Hypurrscan Signals:** tracked traders' crypto and TradFi long/short positions, summarized by token.
- **Spot holdings:** selected wallet-token balances from Hypurrscan `#spot` pages.
- **Hyperliquid open orders:** native open-order snapshots for tracked wallets.
- **Wallet portfolio tracking:** a broader, earlier Zapper-based scan and Google Sheets registry/sync workflow.

## Data flow and storage

The tracked trader registry is CSV-backed. Signal refreshes use Firecrawl to collect Hypurrscan data; scheduled refreshes run through GitHub Actions. Supabase stores production snapshots, and the Vercel-hosted app serves the dashboard and API. Local development can use SQLite when Supabase credentials are absent. A snapshot is a point-in-time collection, not a live position feed. The dashboard is intended to keep showing the newest successful snapshot while a newer refresh is running or has failed.

## Reading signal exports

Markdown exports identify the snapshot, market (`crypto` or `tradfi`), status, capture time, trader coverage, position count, token summary, and trader-level long/short breakdown. Wallet addresses in the breakdown are shortened for display.

- **Long SMW / Short SMW:** counts of distinct tracked wallets with a long or short position for that token.
- **Netflow:** `Long SMW - Short SMW`; this is a wallet-count balance, not transaction flow or dollar flow.
- **Long Value USD / Short Value USD:** summed reported position values on each side.
- **Holdings USD:** absolute difference between long and short position values, not total gross exposure.
- **Coverage:** completed and failed trader scans matter when judging how representative a snapshot is. Zero-position traders are completed scans that returned no positions.

Do not treat a snapshot as complete market-wide positioning: it only represents the configured tracked-trader registry and the source data successfully collected for that run. When analyzing trends, compare snapshots with their timestamps, coverage, and status.

## Spot holdings

Spot holdings are collected separately from perps signal positions, from each tracked wallet's Hypurrscan `#spot` page. The default view keeps non-stable, non-trash tokens with a reported value above **$333**. The minimum value is configurable with `SPOT_HOLDING_MIN_USD`; token inclusion and stable/trash exclusions can also be configured. Treat these rows as wallet spot balances at the snapshot time. They are not perps positions or open orders, and should not be combined with those datasets without an explicit analysis rule. The spot snapshot includes scan coverage, failures, and filter metadata; account for these when comparing results or interpreting missing rows.

## Useful source files

- `src/signal-refresh.ts`, `src/hypurrscan-signals.ts`: signal collection and parsing.
- `src/signals.ts`, `src/signal-export.ts`: aggregation and Markdown export semantics.
- `src/trader-registry.ts`: tracked trader registry loading.
- `src/spot-holdings.ts`, `src/spot-token-filter.ts`, `src/spot-storage.ts`: spot collection, filters, and snapshot persistence.
- `src/open-order-scan.ts`: open-order collection.
- `src/server.ts`, `dashboard/`: API and dashboard.
- `supabase/migrations/`: persistent production schema.
- `README.md`: setup, runtime configuration, and operational details.

## Analysis guidance

Describe what the snapshot measures and its coverage before drawing conclusions. Separate observed positions from interpretation. Do not infer trader identity, missing positions, trade timing, realized PnL, or a buy/sell event from an aggregate snapshot unless another source supports it. Historical snapshots and current production state can differ; use the snapshot timestamp and verify live state when freshness matters.
