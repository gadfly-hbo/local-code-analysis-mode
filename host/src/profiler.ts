import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { workerPython } from "./config.ts";
import { runIsolated } from "./isolation.ts";
import { UserError, type Workspace } from "./workspace.ts";

export interface ColumnProfile {
  name: string;
  inferred_type: string;
  null_count: number;
  distinct_count: number;
  leading_zero_candidate: boolean;
  all_numeric_strings: boolean;
}

export interface LocalProfile {
  row_count: number;
  scanned: string;
  is_sampled: boolean;
  columns: ColumnProfile[];
}

export interface SchemaCard {
  dataset: string;
  grain: string;
  columns: Record<string, { type: string; semantics: string }>;
  unique_keys: string[];
  notes: string[];
}

/** Run a one-shot worker module inside the isolation backend: JSON request on stdin, one JSON line back on stdout. */
export function runWorkerModule<T>(
  ws: Workspace,
  module: string,
  request: unknown,
  allowedReads: string[],
  writableDir?: string,
): T {
  // The sandbox's writable scope MUST be the directory the worker actually
  // writes to (request.run_dir when the caller provides one).
  const runDir =
    writableDir ??
    join(
      ws.root,
      "runs",
      `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    );
  mkdirSync(runDir, { recursive: true });
  const result = runIsolated({
    command: workerPython(),
    args: ["-m", module],
    allowedReads,
    writableDir: runDir,
    input: JSON.stringify(request),
  });
  if (result.status !== 0) {
    throw new UserError(
      `worker exited with ${result.status}: ${result.stderr?.slice(0, 2500)}`,
    );
  }
  const lines = result.stdout
    .split("\n")
    .filter((line) => line.trim().length > 0);
  const last = lines.at(-1);
  if (!last) {
    throw new UserError("worker returned no output");
  }
  return JSON.parse(last) as T;
}

export function emitCardDraftYaml(card: SchemaCard): string {
  const lines: string[] = [
    `dataset: ${JSON.stringify(card.dataset)}`,
    `grain: ${JSON.stringify(card.grain)}`,
    "columns:",
  ];
  for (const [name, col] of Object.entries(card.columns)) {
    lines.push(`  ${name}:`);
    lines.push(`    type: ${col.type}`);
    lines.push(`    semantics: ${JSON.stringify(col.semantics)}`);
  }
  lines.push(`unique_keys: ${JSON.stringify(card.unique_keys)}`);
  lines.push(`notes: ${JSON.stringify(card.notes)}`);
  return `${lines.join("\n")}\n`;
}

export function profileDataset(
  ws: Workspace,
  alias: string,
): { profile: LocalProfile; card_draft: SchemaCard; card_draft_path: string } {
  const versionRow = ws.db
    .prepare(
      `SELECT dv.path FROM datasets d
       JOIN dataset_versions dv ON dv.dataset_id = d.dataset_id AND dv.version = d.current_version
       WHERE d.alias = ?`,
    )
    .get(alias) as { path: string } | undefined;
  if (!versionRow) {
    throw new UserError(`unknown dataset alias "${alias}"`);
  }

  const { profile, card_draft } = runWorkerModule<{
    profile: LocalProfile;
    card_draft: SchemaCard;
  }>(ws, "worker.profile", { alias, path: versionRow.path }, [versionRow.path]);

  mkdirSync(join(ws.root, "profiles"), { recursive: true });
  mkdirSync(join(ws.root, "datasets"), { recursive: true });
  const profilePath = join(ws.root, "profiles", `${alias}.json`);
  const draftPath = join(ws.root, "datasets", `${alias}.schema.yaml`);
  writeFileSync(profilePath, `${JSON.stringify(profile, null, 2)}\n`);
  writeFileSync(draftPath, emitCardDraftYaml(card_draft));

  return { profile, card_draft, card_draft_path: draftPath };
}
