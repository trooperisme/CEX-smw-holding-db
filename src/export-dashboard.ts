import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { ensureDirExists, resolveWorkspacePaths } from "./runtime-paths";
import { getSupabaseAdminClient } from "./supabase";

dotenv.config();

type SnapshotRow = {
  id: string;
  threshold_usd: number;
  created_at: string;
};

type EntityRow = {
  id: string;
  entity_id: string;
  entity_name: string;
};

type HoldingRow = {
  entity_pk: string;
  raw_token_name: string;
  raw_ticker: string | null;
  network: string;
  usd_value: number;
};

type ExportEntity = {
  entity_id: string;
  entity_name: string;
  total_usd: number;
  holdings: Array<{ token: string; value_usd: number; chain: string }>;
};

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    if (!current.startsWith("--")) continue;
    const key = current.replace(/^--/, "");
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      out[key] = "true";
      continue;
    }
    out[key] = next;
    i += 1;
  }
  return out;
}

function ensureDir(filePath: string): void {
  const dir = path.dirname(filePath);
  ensureDirExists(dir);
}

function readTemplate(cwd: string): string {
  const templatePath = resolveWorkspacePaths(cwd).exportTemplatePath;
  return fs.readFileSync(templatePath, "utf-8");
}

function serializeData(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

async function loadLatestSnapshot(cwd: string, snapshotIdArg?: string): Promise<{
  snapshot: SnapshotRow;
  entities: ExportEntity[];
}> {
  const supabase = getSupabaseAdminClient();

  let snapshotQuery = supabase
    .from("snapshots")
    .select("id,threshold_usd,created_at")
    .order("created_at", { ascending: false })
    .limit(1);

  if (snapshotIdArg && snapshotIdArg !== "latest") {
    snapshotQuery = supabase.from("snapshots").select("id,threshold_usd,created_at").eq("id", snapshotIdArg).limit(1);
  }

  const { data: snapshotRows, error: snapshotError } = await snapshotQuery;
  if (snapshotError) throw new Error(`Failed loading snapshot: ${snapshotError.message}`);
  const snapshot = (snapshotRows || [])[0] as SnapshotRow | undefined;
  if (!snapshot) throw new Error("No snapshot found");

  const { data: holdingsRows, error: holdingsError } = await supabase
    .from("entity_token_holdings")
    .select("entity_pk, raw_token_name, raw_ticker, network, usd_value")
    .eq("snapshot_id", snapshot.id);
  if (holdingsError) throw new Error(`Failed loading holdings: ${holdingsError.message}`);

  const entityIds = Array.from(new Set(((holdingsRows || []) as HoldingRow[]).map((row) => row.entity_pk)));
  const { data: entityRows, error: entityError } = await supabase
    .from("entities")
    .select("id,entity_id,entity_name")
    .in("id", entityIds);
  if (entityError) throw new Error(`Failed loading entities: ${entityError.message}`);

  const entityByPk = new Map<string, EntityRow>(
    ((entityRows || []) as EntityRow[]).map((row) => [row.id, row]),
  );

  const byEntity = new Map<string, ExportEntity>();
  for (const row of (holdingsRows || []) as HoldingRow[]) {
    const entity = entityByPk.get(row.entity_pk);
    if (!entity) continue;
    const entry = byEntity.get(entity.id) || {
      entity_id: entity.entity_id,
      entity_name: entity.entity_name,
      total_usd: 0,
      holdings: [],
    };
    entry.total_usd += Number(row.usd_value || 0);
    entry.holdings.push({
      token: String(row.raw_ticker || row.raw_token_name || "").trim(),
      value_usd: Number(row.usd_value || 0),
      chain: String(row.network || "unknown").trim().toLowerCase() || "unknown",
    });
    byEntity.set(entity.id, entry);
  }

  const entities = Array.from(byEntity.values()).sort((a, b) => b.total_usd - a.total_usd);
  return { snapshot, entities };
}

function renderHtml(template: string, data: unknown, title: string): string {
  const json = serializeData(data);
  return template
    .replace(/<title>.*?<\/title>/s, `<title>${title}</title>`)
    .replace(/<h1>.*?<\/h1>/s, `<h1>${title}</h1>`)
    .replace(
      /<script id="snapshot-data" type="application\/json">[\s\S]*?<\/script>/s,
      `<script id="snapshot-data" type="application/json">\n${json}\n    </script>`,
    );
}

async function main(): Promise<void> {
  const cwd = process.cwd();
  const args = parseArgs(process.argv.slice(2));
  const paths = resolveWorkspacePaths(cwd);
  const output = path.resolve(cwd, args.output || paths.defaultExportFile);
  const title = args.title || "Top Holdings from First 10 Entities";
  const snapshotId = args.snapshot || "latest";

  const { snapshot, entities } = await loadLatestSnapshot(cwd, snapshotId);
  const template = readTemplate(cwd);
  const html = renderHtml(
    template,
    {
      generated_at: snapshot.created_at,
      min_holding_usd: Number(snapshot.threshold_usd || 0),
      entities,
    },
    title,
  );

  ensureDir(output);
  fs.writeFileSync(output, html, "utf-8");
  console.log(JSON.stringify({ output, snapshotId: snapshot.id, entities: entities.length }, null, 2));
}

void main().catch((error) => {
  console.error("Dashboard export failed:", (error as Error)?.message || String(error));
  process.exitCode = 1;
});
