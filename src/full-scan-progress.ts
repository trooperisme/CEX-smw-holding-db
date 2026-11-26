import { getSupabaseAdminClient } from "./supabase";
import type { ScheduledRefreshResult } from "./signal-scheduled";

const bucket = "cex-scan-control";
export type ScanStage = "perps" | "spot" | "orders";
export type StageState = { status: "queued" | "running" | "completed" | "partial" | "failed"; wallets?: number; error?: string };
export type ScanProgress = {
  runId: string;
  startedAt: string;
  updatedAt: string;
  status: "running" | "success" | "partial" | "failed";
  stages: Record<ScanStage, StageState>;
  snapshotId?: number;
  errors?: string[];
  reusedRunId?: string;
};

async function ensureBucket(): Promise<void> {
  const storage = getSupabaseAdminClient().storage;
  const existing = await storage.getBucket(bucket);
  if (existing.data) return;
  const created = await storage.createBucket(bucket, { public: false, fileSizeLimit: 1_000_000, allowedMimeTypes: ["application/json"] });
  if (created.error) {
    const retry = await storage.getBucket(bucket);
    if (!retry.data) throw new Error("Unable to initialize private scan progress storage");
  }
}

export async function readScanProgress(runId: string): Promise<ScanProgress | null> {
  if (!/^\d+$/.test(runId)) return null;
  return readProgressFile(`runs/${runId}.json`);
}

async function readProgressFile(file: string): Promise<ScanProgress | null> {
  const { data, error } = await getSupabaseAdminClient().storage.from(bucket).download(file);
  if (error || !data) return null;
  try {
    const payload = JSON.parse(await data.text());
    return /^\d+$/.test(payload?.runId) && payload?.stages ? payload : null;
  } catch { return null; }
}

export async function findScanCompletedSince(requestedAt: string): Promise<ScanProgress | null> {
  const timestamp = Date.parse(requestedAt);
  if (!Number.isFinite(timestamp)) return null;
  const progress = await readProgressFile("latest-success.json");
  return progress?.status === "success" && Date.parse(progress.updatedAt) >= timestamp ? progress : null;
}

export function createScanProgressReporter(runId: string) {
  const now = new Date().toISOString();
  const progress: ScanProgress = {
    runId, startedAt: now, updatedAt: now, status: "running",
    stages: { perps: { status: "queued" }, spot: { status: "queued" }, orders: { status: "queued" } },
  };
  let pending = Promise.resolve();
  async function upload(file: string, payload: ScanProgress) {
    const { error } = await getSupabaseAdminClient().storage.from(bucket).upload(file, JSON.stringify(payload), {
      contentType: "application/json", cacheControl: "0", upsert: true,
    });
    if (error) throw new Error("Unable to persist scan progress");
  }
  function publish() {
    progress.updatedAt = new Date().toISOString();
    const snapshot = JSON.parse(JSON.stringify(progress)) as ScanProgress;
    pending = pending.then(() => upload(`runs/${runId}.json`, snapshot)).catch(() => {
      console.warn("[scan-progress] Progress unavailable; GitHub run status remains available.");
    });
    return pending;
  }
  return {
    async start() {
      await ensureBucket();
      await publish();
    },
    async stage(stage: ScanStage, update: StageState) {
      progress.stages[stage] = update;
      await publish();
    },
    async finish(result: ScheduledRefreshResult) {
      progress.status = result.status;
      progress.snapshotId = result.signal?.snapshotId;
      progress.errors = result.errors;
      const outcomes: Array<[ScanStage, boolean, number | undefined]> = [
        ["perps", result.signal?.status === "success" && !result.errors.some((error) => error.startsWith("signal")), result.signal?.tradersCompleted],
        ["spot", Boolean(result.spot && !result.spot.failures) && !result.errors.some((error) => error.startsWith("spot")), result.spot?.tradersScanned],
        ["orders", Boolean(result.openOrders && !result.openOrders.failures) && !result.errors.some((error) => error.startsWith("open-orders")), result.openOrders?.tradersScanned],
      ];
      for (const [stage, success, wallets] of outcomes) {
        progress.stages[stage] = { ...progress.stages[stage], status: success ? "completed" : "failed", wallets };
      }
      await publish();
      if (result.status === "success") {
        try { await upload("latest-success.json", progress); } catch { /* Only affects duplicate dispatch suppression. */ }
      }
    },
    async reuse(previous: ScanProgress) {
      Object.assign(progress, previous, { runId, reusedRunId: previous.runId });
      await publish();
    },
    async fail(message: string) {
      progress.status = "failed";
      progress.errors = [message];
      for (const stage of Object.keys(progress.stages) as ScanStage[]) {
        if (progress.stages[stage].status === "running") progress.stages[stage] = { status: "failed" };
      }
      await publish();
    },
  };
}
