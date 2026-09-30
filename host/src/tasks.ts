import { randomUUID } from "node:crypto";
import { UserError, type Workspace } from "./workspace.ts";

/** AnalysisTaskSpec — the validated JSON contract the model must return (§6.3/§10). */
export interface AnalysisTaskSpec {
  goal: string;
  assumptions: string[];
  code: string;
  validation_checks: string[];
}

export type TaskStatus =
  | "awaiting_confirmation"
  | "ready"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface TaskVersionBinding {
  [alias: string]: { version: string; schema_version: string };
}

export interface TaskRow {
  id: string;
  goal: string;
  datasets: string[];
  versions: TaskVersionBinding;
  spec: AnalysisTaskSpec;
  status: TaskStatus;
  rounds_used: number;
  error_summary: string | null;
  created_at: string;
  updated_at: string;
}

const TASKS_MIGRATION = `CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  goal TEXT NOT NULL,
  dataset_aliases TEXT NOT NULL,
  versions_json TEXT NOT NULL,
  spec_json TEXT NOT NULL,
  status TEXT NOT NULL,
  rounds_used INTEGER NOT NULL DEFAULT 1,
  error_summary TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`;

const ARTIFACTS_MIGRATION = `CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  path TEXT NOT NULL,
  data_versions TEXT NOT NULL,
  sensitivity TEXT NOT NULL DEFAULT 'local_only',
  created_at TEXT NOT NULL
)`;

const SPEC_KEYS = new Set(["goal", "assumptions", "code", "validation_checks"]);

export function parseTaskSpec(text: string): AnalysisTaskSpec {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Models sometimes wrap JSON in fences; try the first {...} block.
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        parsed = JSON.parse(text.slice(start, end + 1));
      } catch {
        parsed = undefined;
      }
    }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new UserError(
      `model did not return a JSON AnalysisTaskSpec: ${text.slice(0, 200)}`,
    );
  }
  const obj = parsed as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!SPEC_KEYS.has(key)) {
      throw new UserError(`AnalysisTaskSpec has unexpected key "${key}"`);
    }
  }
  for (const key of SPEC_KEYS) {
    if (!(key in obj)) {
      throw new UserError(`AnalysisTaskSpec is missing "${key}"`);
    }
  }
  if (typeof obj.goal !== "string" || obj.goal.length === 0) {
    throw new UserError('AnalysisTaskSpec "goal" must be a non-empty string');
  }
  if (typeof obj.code !== "string" || obj.code.trim().length === 0) {
    throw new UserError('AnalysisTaskSpec "code" must be non-empty');
  }
  for (const key of ["assumptions", "validation_checks"]) {
    if (
      !Array.isArray(obj[key]) ||
      (obj[key] as unknown[]).some((v) => typeof v !== "string")
    ) {
      throw new UserError(
        `AnalysisTaskSpec "${key}" must be a list of strings`,
      );
    }
  }
  return {
    goal: obj.goal as string,
    assumptions: obj.assumptions as string[],
    code: obj.code as string,
    validation_checks: obj.validation_checks as string[],
  };
}

function ensureMigrations(ws: Workspace): void {
  ws.db.exec(TASKS_MIGRATION);
  ws.db.exec(ARTIFACTS_MIGRATION);
}

export function createTask(
  ws: Workspace,
  input: {
    goal: string;
    datasets: string[];
    versions: TaskVersionBinding;
    spec: AnalysisTaskSpec;
  },
): TaskRow {
  ensureMigrations(ws);
  const id = `task_${randomUUID().slice(0, 12)}`;
  const now = new Date().toISOString();
  ws.db
    .prepare(
      "INSERT INTO tasks (id, goal, dataset_aliases, versions_json, spec_json, status, rounds_used, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)",
    )
    .run(
      id,
      input.goal,
      JSON.stringify(input.datasets),
      JSON.stringify(input.versions),
      JSON.stringify(input.spec),
      "awaiting_confirmation",
      now,
      now,
    );
  return getTask(ws, id);
}

export function getTask(ws: Workspace, id: string): TaskRow {
  ensureMigrations(ws);
  const row = ws.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as
    | {
        id: string;
        goal: string;
        dataset_aliases: string;
        versions_json: string;
        spec_json: string;
        status: string;
        rounds_used: number;
        error_summary: string | null;
        created_at: string;
        updated_at: string;
      }
    | undefined;
  if (!row) {
    throw new UserError(`unknown task "${id}"`);
  }
  return {
    id: row.id,
    goal: row.goal,
    datasets: JSON.parse(row.dataset_aliases) as string[],
    versions: JSON.parse(row.versions_json) as TaskVersionBinding,
    spec: JSON.parse(row.spec_json) as AnalysisTaskSpec,
    status: row.status as TaskStatus,
    rounds_used: row.rounds_used,
    error_summary: row.error_summary,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function listTasks(
  ws: Workspace,
): { id: string; goal: string; status: string; datasets: string[] }[] {
  ensureMigrations(ws);
  const rows = ws.db
    .prepare(
      "SELECT id, goal, status, dataset_aliases FROM tasks ORDER BY created_at",
    )
    .all() as unknown as {
    id: string;
    goal: string;
    status: string;
    dataset_aliases: string;
  }[];
  return rows.map((row) => ({
    id: row.id,
    goal: row.goal,
    status: row.status,
    datasets: JSON.parse(row.dataset_aliases) as string[],
  }));
}

export function updateTask(
  ws: Workspace,
  id: string,
  patch: Partial<
    Pick<TaskRow, "status" | "spec" | "rounds_used" | "error_summary">
  >,
): void {
  ensureMigrations(ws);
  const existing = getTask(ws, id);
  ws.db
    .prepare(
      "UPDATE tasks SET status = ?, spec_json = ?, rounds_used = ?, error_summary = ?, updated_at = ? WHERE id = ?",
    )
    .run(
      patch.status ?? existing.status,
      JSON.stringify(patch.spec ?? existing.spec),
      patch.rounds_used ?? existing.rounds_used,
      patch.error_summary ?? existing.error_summary,
      new Date().toISOString(),
      id,
    );
}

export function registerArtifacts(
  ws: Workspace,
  input: {
    taskId: string;
    runId: string;
    dataVersions: TaskVersionBinding;
    artifacts: { name: string; type: string; path: string }[];
  },
): void {
  ensureMigrations(ws);
  for (const artifact of input.artifacts) {
    ws.db
      .prepare(
        "INSERT INTO artifacts (id, task_id, run_id, name, type, path, data_versions, sensitivity, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'local_only', ?)",
      )
      .run(
        `art_${randomUUID().slice(0, 12)}`,
        input.taskId,
        input.runId,
        artifact.name,
        artifact.type,
        artifact.path,
        JSON.stringify(input.dataVersions),
        new Date().toISOString(),
      );
  }
}

export function listArtifacts(
  ws: Workspace,
  taskId?: string,
): Record<string, unknown>[] {
  ensureMigrations(ws);
  const rows = taskId
    ? ws.db
        .prepare(
          "SELECT * FROM artifacts WHERE task_id = ? ORDER BY created_at",
        )
        .all(taskId)
    : ws.db.prepare("SELECT * FROM artifacts ORDER BY created_at").all();
  return rows as unknown as Record<string, unknown>[];
}

export function getArtifact(
  ws: Workspace,
  artifactId: string,
): { id: string; path: string; name: string; type: string } {
  ensureMigrations(ws);
  const row = ws.db
    .prepare("SELECT id, path, name, type FROM artifacts WHERE id = ?")
    .get(artifactId) as
    | { id: string; path: string; name: string; type: string }
    | undefined;
  if (!row) {
    throw new UserError(`unknown artifact "${artifactId}"`);
  }
  return row;
}
