import { randomUUID } from "node:crypto";
import { readScanProgress } from "./full-scan-progress";

const repository = "trooperisme/CEX-smw-holding-db";
const workflow = "cex-scheduled-refresh.yml";
const workflowId = 387511005;
const base = `https://api.github.com/repos/${repository}/actions`;
let dispatchFlight: Promise<unknown> | null = null;

export function fullScanConfigured(): boolean {
  return Boolean(process.env.SCAN_GITHUB_TOKEN && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

async function github(path: string, body?: unknown): Promise<any> {
  if (!fullScanConfigured()) throw new Error("Full Scan requires SCAN_GITHUB_TOKEN and durable storage on Vercel.");
  const response = await fetch(`${base}/${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      Accept: "application/vnd.github+json", Authorization: `Bearer ${process.env.SCAN_GITHUB_TOKEN}`,
      "X-GitHub-Api-Version": "2026-03-10", "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
    cache: "no-store",
  });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new Error("GitHub denied access. Check the scan token's repository access, Actions permission and expiry.");
    if (response.status === 422) throw new Error("GitHub could not start this workflow. Check that the Full Scan workflow is deployed on main.");
    throw new Error(`GitHub scan service returned HTTP ${response.status}. Try checking progress again.`);
  }
  return response.status === 204 ? null : response.json();
}

function validRun(run: any): boolean {
  return Number(run?.workflow_id) === workflowId && run?.head_branch === "main";
}
function runPayload(run: any) {
  return {
    id: Number(run.id), status: run.status, conclusion: run.conclusion || null,
    title: String(run.display_title || run.name || "Full scan"),
    url: `https://github.com/${repository}/actions/runs/${Number(run.id)}`,
    createdAt: run.created_at, startedAt: run.run_started_at || run.created_at,
    updatedAt: run.updated_at,
  };
}
async function listRuns(): Promise<any[]> {
  const payload = await github(`workflows/${workflow}/runs?branch=main&per_page=50`);
  return (payload.workflow_runs || []).filter(validRun).filter((run: any) => !/^Registry sync|^Resume scan/.test(run.display_title || ""));
}
async function describeRun(run: any) {
  if (!validRun(run)) throw new Error("This job is not a Full Scan from this project's main branch.");
  const [progress, jobs] = await Promise.all([
    readScanProgress(String(run.id)).catch(() => null),
    github(`runs/${run.id}/jobs?per_page=50`).catch(() => ({ jobs: [] })),
  ]);
  const steps = (jobs.jobs || []).flatMap((job: any) => job.steps || []);
  const activeStep = steps.find((step: any) => step.status === "in_progress");
  return { run: runPayload(run), progress, phase: activeStep?.name || (run.status === "completed" ? "Finished" : "Waiting for GitHub runner"), pending: false };
}

export async function getFullScanStatus(runId?: string, requestId?: string) {
  if (runId) {
    if (!/^\d{1,20}$/.test(runId)) throw new Error("Invalid scan job ID");
    return describeRun(await github(`runs/${runId}`));
  }
  if (requestId && !/^[a-f0-9-]{36}$/i.test(requestId)) throw new Error("Invalid scan request ID");
  const runs = await listRuns();
  const run = requestId
    ? runs.find((row) => row.display_title?.includes(requestId))
    : runs.find((row) => row.status !== "completed");
  if (run) return describeRun(run);
  return { run: null, progress: null, phase: requestId ? "Waiting for GitHub to acknowledge the request" : "Ready", pending: Boolean(requestId), requestId };
}

async function dispatch() {
  // Reuse manual or scheduled work already queued/running in the shared workflow.
  const active = (await listRuns()).find((run) => run.status !== "completed");
  if (active) return { ...await describeRun(active), alreadyRunning: true };
  const requestId = randomUUID();
  const requestedAt = new Date().toISOString();
  let response: any;
  try {
    response = await github(`workflows/${workflow}/dispatches`, {
      ref: "main", return_run_details: true,
      inputs: { scan_request_id: requestId, scan_requested_at: requestedAt },
    });
  } catch (error) {
    // A lost response can follow a successful dispatch. Preserve its identity so
    // the browser checks that request instead of silently submitting another.
    if ((error as Error)?.name === "TimeoutError" || (error as Error)?.name === "AbortError" || (error as Error)?.name === "TypeError") {
      return { run: null, progress: null, requestId, requestedAt, pending: true, phase: "Checking whether GitHub accepted the request" };
    }
    throw error;
  }
  const runId = response?.workflow_run_id;
  if (runId) {
    // A status lookup failure must not turn an accepted dispatch into a retry.
    return { run: {
      id: Number(runId), status: "queued", conclusion: null,
      title: "Full scan", url: `https://github.com/${repository}/actions/runs/${Number(runId)}`,
      createdAt: requestedAt, startedAt: requestedAt, updatedAt: requestedAt,
    }, progress: null, requestId, requestedAt, pending: false, phase: "Queued on GitHub Actions" };
  }
  return { run: null, progress: null, requestId, requestedAt, pending: true, phase: "Waiting for GitHub to acknowledge the request" };
}

export function startFullScan(): Promise<unknown> {
  // Coalesce double clicks hitting the same warm function. Cross-instance work
  // is serialized by the workflow and duplicate requests are reused by its runner.
  if (!dispatchFlight) dispatchFlight = dispatch().finally(() => { dispatchFlight = null; });
  return dispatchFlight;
}
