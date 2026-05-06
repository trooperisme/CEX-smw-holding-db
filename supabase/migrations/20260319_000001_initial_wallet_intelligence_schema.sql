create extension if not exists pgcrypto;

create table if not exists public.entities (
  id uuid primary key default gen_random_uuid(),
  entity_id text not null unique,
  entity_name text not null,
  source_url text not null,
  normalized_url text not null,
  source_type text not null check (source_type in ('zapper', 'debank')),
  notes text,
  is_active boolean not null default true,
  priority_color text not null default 'unknown'
    check (priority_color in ('red', 'purple', 'yellow', 'unknown')),
  source_hash text not null,
  needs_rescrape boolean not null default true,
  last_synced_at timestamptz,
  last_scraped_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_entities_active_priority
  on public.entities (is_active, priority_color);

create index if not exists idx_entities_needs_rescrape
  on public.entities (needs_rescrape)
  where needs_rescrape = true;

create table if not exists public.sync_runs (
  id uuid primary key default gen_random_uuid(),
  status text not null check (status in ('running', 'success', 'failed')),
  rows_seen integer not null default 0,
  rows_upserted integer not null default 0,
  rows_changed integer not null default 0,
  rows_queued integer not null default 0,
  error text,
  started_at timestamptz not null default timezone('utc', now()),
  finished_at timestamptz
);

create table if not exists public.scrape_jobs (
  id uuid primary key default gen_random_uuid(),
  entity_pk uuid not null references public.entities(id) on delete cascade,
  job_type text not null default 'scrape_holdings'
    check (job_type in ('scrape_holdings')),
  status text not null default 'queued'
    check (status in ('queued', 'running', 'success', 'failed', 'cancelled')),
  attempt_count integer not null default 0,
  error text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_scrape_jobs_status_created
  on public.scrape_jobs (status, created_at);

create table if not exists public.snapshots (
  id uuid primary key default gen_random_uuid(),
  threshold_usd numeric(20, 2) not null default 555.00,
  trigger_type text not null default 'manual_sync'
    check (trigger_type in ('manual_sync', 'manual_rescrape')),
  sync_run_id uuid references public.sync_runs(id) on delete set null,
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.tokens (
  id uuid primary key default gen_random_uuid(),
  canonical_name text not null,
  canonical_ticker text not null,
  created_at timestamptz not null default timezone('utc', now()),
  unique (canonical_name, canonical_ticker)
);

create table if not exists public.token_aliases (
  id uuid primary key default gen_random_uuid(),
  token_id uuid not null references public.tokens(id) on delete cascade,
  raw_token_name text,
  raw_ticker text,
  network text,
  contract_address text,
  match_key text not null unique,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_token_aliases_token_id
  on public.token_aliases (token_id);

create table if not exists public.entity_token_holdings (
  id uuid primary key default gen_random_uuid(),
  snapshot_id uuid not null references public.snapshots(id) on delete cascade,
  entity_pk uuid not null references public.entities(id) on delete cascade,
  source_type text not null check (source_type in ('zapper', 'debank')),
  raw_token_name text not null,
  raw_ticker text,
  network text not null,
  contract_address text,
  balance_text text,
  balance_numeric numeric(38, 18),
  usd_value numeric(20, 2) not null,
  canonical_token_id uuid references public.tokens(id) on delete set null,
  scraped_at timestamptz not null default timezone('utc', now()),
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_entity_token_holdings_snapshot
  on public.entity_token_holdings (snapshot_id);

create index if not exists idx_entity_token_holdings_entity
  on public.entity_token_holdings (entity_pk);

create index if not exists idx_entity_token_holdings_token
  on public.entity_token_holdings (canonical_token_id);

create index if not exists idx_entity_token_holdings_value
  on public.entity_token_holdings (usd_value desc);

create table if not exists public.dashboard_token_metrics (
  snapshot_id uuid not null references public.snapshots(id) on delete cascade,
  token_id uuid not null references public.tokens(id) on delete cascade,
  token text not null,
  ticker text not null,
  entities_holding_count integer not null default 0,
  entities_holding_preview text[] not null default '{}',
  total_held_usd numeric(20, 2) not null default 0,
  chains text[] not null default '{}',
  watchlist_percent numeric(8, 4) not null default 0,
  smw_in integer not null default 0,
  created_at timestamptz not null default timezone('utc', now()),
  primary key (snapshot_id, token_id)
);

create index if not exists idx_dashboard_token_metrics_rank
  on public.dashboard_token_metrics (snapshot_id, smw_in desc, total_held_usd desc);

create or replace view public.latest_dashboard_token_metrics as
select dtm.*
from public.dashboard_token_metrics dtm
where dtm.snapshot_id = (
  select s.id
  from public.snapshots s
  order by s.created_at desc, s.id desc
  limit 1
);

create or replace view public.active_red_entities as
select *
from public.entities
where is_active = true
  and priority_color = 'red';
