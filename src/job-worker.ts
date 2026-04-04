import dotenv from "dotenv";
import { createBrowserContext } from "./browser";
import { dedupeParsedHoldings, normalizeHolding } from "./parser";
import { ensureDirExists, resolveWorkspacePaths } from "./runtime-paths";
import { scrapeWallet } from "./scraper";
import { getSupabaseAdminClient } from "./supabase";
import { ScanLogger, WalletInput } from "./types";

dotenv.config();

type WorkerOptions = {
  cwd?: string;
  limit?: number;
  logger?: ScanLogger;
};

type JobRecord = {
  id: string;
  entity_pk: string;
  attempt_count: number;
};

type EntityRecord = {
  id: string;
  entity_name: string;
  normalized_url: string;
  source_type: "zapper" | "debank";
};

type RunJobsSummary = {
  snapshotId: string | null;
  jobsPicked: number;
  jobsSucceeded: number;
  jobsFailed: number;
  jobsSkipped: number;
  holdingsInserted: number;
};

function parseBool(value: string | undefined, fallback = false): boolean {
  if (!value) return fallback;
  return value.toLowerCase() === "true";
}

function parseNum(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return num;
}

export async function runQueuedScrapeJobs(options: WorkerOptions = {}): Promise<RunJobsSummary> {
  const cwd = options.cwd || process.cwd();
  const logger = options.logger || ((line: string) => console.log(line));
  const limit = options.limit ?? parseNum(process.env.SCRAPE_JOB_LIMIT, 5);
  const minHoldingUsd = parseNum(process.env.MIN_HOLDING_USD, 555);
  const headless = parseBool(process.env.HEADLESS, false);
  const screenshotsEnabled = parseBool(process.env.SCREENSHOTS_ENABLED, true);
  const includeDefi = parseBool(process.env.INCLUDE_DEFI, false);
  const paths = resolveWorkspacePaths(cwd);
  ensureDirExists(paths.screenshotsDir);

  const supabase = getSupabaseAdminClient();
  const { data: jobsData, error: jobsError } = await supabase
    .from("scrape_jobs")
    .select("id,entity_pk,attempt_count")
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(limit);
  if (jobsError) throw new Error(`Unable to fetch queued jobs: ${jobsError.message}`);

  const jobs = (jobsData || []) as JobRecord[];
  if (jobs.length === 0) {
    return {
      snapshotId: null,
      jobsPicked: 0,
      jobsSucceeded: 0,
      jobsFailed: 0,
      jobsSkipped: 0,
      holdingsInserted: 0,
    };
  }

  const entityPks = jobs.map((job) => job.entity_pk);
  const { data: entitiesData, error: entitiesError } = await supabase
    .from("entities")
    .select("id,entity_name,normalized_url,source_type")
    .in("id", entityPks);
  if (entitiesError) throw new Error(`Unable to fetch entities for jobs: ${entitiesError.message}`);

  const entitiesByPk = new Map(
    ((entitiesData || []) as EntityRecord[]).map((entity) => [entity.id, entity]),
  );

  const { data: snapshotData, error: snapshotError } = await supabase
    .from("snapshots")
    .insert({
      threshold_usd: minHoldingUsd,
      trigger_type: "manual_rescrape",
    })
    .select("id")
    .single();
  if (snapshotError || !snapshotData?.id) {
    throw new Error(`Unable to create snapshot for job run: ${snapshotError?.message || "Unknown error"}`);
  }
  const snapshotId = snapshotData.id as string;

  const browserSession = await createBrowserContext({ cwd, headless, logger });
  const page = await browserSession.newPage();

  let jobsSucceeded = 0;
  let jobsFailed = 0;
  let jobsSkipped = 0;
  let holdingsInserted = 0;

  try {
    for (const job of jobs) {
      const startedAt = new Date().toISOString();
      const entity = entitiesByPk.get(job.entity_pk);
      if (!entity) {
        await supabase
          .from("scrape_jobs")
          .update({
            status: "failed",
            error: "Missing entity record for queued job",
            attempt_count: job.attempt_count + 1,
            started_at: startedAt,
            finished_at: new Date().toISOString(),
          })
          .eq("id", job.id);
        jobsFailed += 1;
        continue;
      }

      await supabase
        .from("scrape_jobs")
        .update({
          status: "running",
          error: null,
          attempt_count: job.attempt_count + 1,
          started_at: startedAt,
        })
        .eq("id", job.id);

      if (entity.source_type !== "zapper") {
        await supabase
          .from("scrape_jobs")
          .update({
            status: "failed",
            error: `Unsupported source_type '${entity.source_type}' in job worker`,
            finished_at: new Date().toISOString(),
          })
          .eq("id", job.id);
        jobsSkipped += 1;
        continue;
      }

      const wallet: WalletInput = {
        label: entity.entity_name,
        url: entity.normalized_url,
      };

      logger(`Running scrape job ${job.id} for ${wallet.label}`);

      try {
        const scraped = await scrapeWallet(page, wallet, {
          cwd,
          minHoldingUsd,
          headless,
          screenshotsEnabled,
          screenshotsDir: paths.screenshotsDir,
          includeDefi,
          logger,
        });

        const parsed = dedupeParsedHoldings(
          scraped.tokens
            .map((token) => normalizeHolding(wallet, token))
            .filter((row): row is NonNullable<typeof row> => row !== null),
        );

        if (parsed.length > 0) {
          const insertPayload = parsed.map((row) => ({
            snapshot_id: snapshotId,
            entity_pk: entity.id,
            source_type: entity.source_type,
            raw_token_name: row.tokenName,
            raw_ticker: row.tokenSymbol,
            network: row.chain,
            balance_text: row.balanceRaw,
            balance_numeric: row.balanceNumeric,
            usd_value: row.valueUsd,
            scraped_at: row.scrapedAt,
          }));
          const { error: insertError } = await supabase
            .from("entity_token_holdings")
            .insert(insertPayload);
          if (insertError) {
            throw new Error(`Unable to insert holdings: ${insertError.message}`);
          }
          holdingsInserted += insertPayload.length;
        }

        await supabase
          .from("entities")
          .update({
            needs_rescrape: false,
            last_scraped_at: new Date().toISOString(),
          })
          .eq("id", entity.id);

        await supabase
          .from("scrape_jobs")
          .update({
            status: "success",
            error: null,
            finished_at: new Date().toISOString(),
          })
          .eq("id", job.id);

        jobsSucceeded += 1;
      } catch (error) {
        const message = (error as Error)?.message || String(error);
        await supabase
          .from("scrape_jobs")
          .update({
            status: "failed",
            error: message,
            finished_at: new Date().toISOString(),
          })
          .eq("id", job.id);
        jobsFailed += 1;
      }
    }
  } finally {
    await browserSession.close();
  }

  return {
    snapshotId,
    jobsPicked: jobs.length,
    jobsSucceeded,
    jobsFailed,
    jobsSkipped,
    holdingsInserted,
  };
}
