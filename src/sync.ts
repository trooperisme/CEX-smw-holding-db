import { loadTrackedEntities } from "./sheets";
import { getSupabaseAdminClient } from "./supabase";
import { SheetSyncSummary, TrackedEntity } from "./types";

type SyncOptions = {
  cwd?: string;
};

type ExistingEntityRow = {
  id: string;
  entity_id: string;
  source_hash: string;
};

type JobRow = {
  entity_pk: string;
  status: string;
};

function chunk<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

export async function runSheetSyncToSupabase(options: SyncOptions = {}): Promise<SheetSyncSummary> {
  const cwd = options.cwd || process.cwd();
  const supabase = getSupabaseAdminClient();
  const nowIso = new Date().toISOString();

  const { data: syncRun, error: syncRunError } = await supabase
    .from("sync_runs")
    .insert({
      status: "running",
      started_at: nowIso,
    })
    .select("id")
    .single();
  if (syncRunError || !syncRun?.id) {
    throw new Error(`Unable to create sync run: ${syncRunError?.message || "Unknown error"}`);
  }

  const finishSyncRun = async (status: "success" | "failed", summary: Partial<SheetSyncSummary>, error?: string) => {
    await supabase
      .from("sync_runs")
      .update({
        status,
        rows_seen: summary.rowsRead ?? 0,
        rows_upserted: summary.rowsUpserted ?? 0,
        rows_changed: summary.rowsChanged ?? 0,
        rows_queued: summary.rowsQueued ?? 0,
        error: error || null,
        finished_at: new Date().toISOString(),
      })
      .eq("id", syncRun.id);
  };

  try {
    const entities = await loadTrackedEntities(cwd);
    const eligible = entities.filter((entity) => entity.isActive && entity.priorityColor === "red");
    const skippedEntityIds = entities
      .filter((entity) => !entity.isActive || entity.priorityColor !== "red")
      .map((entity) => entity.entityId);

    if (eligible.length === 0) {
      const emptySummary: SheetSyncSummary = {
        rowsRead: entities.length,
        rowsEligible: 0,
        rowsSkipped: skippedEntityIds.length,
        rowsUnsupported: 0,
        rowsChanged: 0,
        rowsUpserted: 0,
        rowsQueued: 0,
        skippedEntityIds,
      };
      await finishSyncRun("success", emptySummary);
      return emptySummary;
    }

    const entityIds = eligible.map((entity) => entity.entityId);
    const existingRows: ExistingEntityRow[] = [];
    for (const ids of chunk(entityIds, 200)) {
      const { data, error } = await supabase
        .from("entities")
        .select("id,entity_id,source_hash")
        .in("entity_id", ids);
      if (error) throw new Error(`Failed reading existing entities: ${error.message}`);
      existingRows.push(...((data || []) as ExistingEntityRow[]));
    }

    const existingByEntityId = new Map(existingRows.map((row) => [row.entity_id, row]));

    const changedEntities = eligible.filter((entity) => {
      const existing = existingByEntityId.get(entity.entityId);
      return !existing || existing.source_hash !== entity.sourceHash;
    });
    const changedEntityIdSet = new Set(changedEntities.map((entity) => entity.entityId));
    const unchangedEntityIds = eligible
      .filter((entity) => !changedEntityIdSet.has(entity.entityId))
      .map((entity) => entity.entityId);

    let upsertedRows: Array<{ id: string; entity_id: string }> = [];
    if (changedEntities.length > 0) {
      const payload = changedEntities.map((entity) => ({
        entity_id: entity.entityId,
        entity_name: entity.entityName,
        source_url: entity.sourceUrl,
        normalized_url: entity.normalizedUrl,
        source_type: entity.sourceType,
        notes: entity.notes,
        is_active: entity.isActive,
        priority_color: entity.priorityColor,
        source_hash: entity.sourceHash,
        needs_rescrape: true,
        last_synced_at: nowIso,
      }));

      const { data, error } = await supabase
        .from("entities")
        .upsert(payload, { onConflict: "entity_id" })
        .select("id,entity_id");
      if (error) throw new Error(`Failed upserting entities: ${error.message}`);
      upsertedRows = (data || []) as Array<{ id: string; entity_id: string }>;
    }

    for (const ids of chunk(unchangedEntityIds, 200)) {
      if (ids.length === 0) continue;
      const { error } = await supabase
        .from("entities")
        .update({ last_synced_at: nowIso })
        .in("entity_id", ids);
      if (error) throw new Error(`Failed updating sync timestamp: ${error.message}`);
    }

    const changedEntityPks = upsertedRows.map((row) => row.id);
    let queued = 0;
    if (changedEntityPks.length > 0) {
      const { data: existingJobs, error: existingJobsError } = await supabase
        .from("scrape_jobs")
        .select("entity_pk,status")
        .in("entity_pk", changedEntityPks)
        .in("status", ["queued", "running"]);
      if (existingJobsError) {
        throw new Error(`Failed checking existing jobs: ${existingJobsError.message}`);
      }

      const busySet = new Set(((existingJobs || []) as JobRow[]).map((row) => row.entity_pk));
      const jobsPayload = changedEntityPks
        .filter((entityPk) => !busySet.has(entityPk))
        .map((entityPk) => ({
          entity_pk: entityPk,
          job_type: "scrape_holdings",
          status: "queued",
        }));

      if (jobsPayload.length > 0) {
        const { error } = await supabase.from("scrape_jobs").insert(jobsPayload);
        if (error) throw new Error(`Failed queueing jobs: ${error.message}`);
        queued = jobsPayload.length;
      }
    }

    const summary: SheetSyncSummary = {
      rowsRead: entities.length,
      rowsEligible: eligible.length,
      rowsSkipped: skippedEntityIds.length,
      rowsUnsupported: 0,
      rowsChanged: changedEntities.length,
      rowsUpserted: changedEntities.length,
      rowsQueued: queued,
      skippedEntityIds,
    };

    await finishSyncRun("success", summary);
    return summary;
  } catch (error) {
    const message = (error as Error)?.message || String(error);
    await finishSyncRun("failed", {}, message);
    throw error;
  }
}
