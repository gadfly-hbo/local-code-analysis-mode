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
  const tryParse = (candidate: string): unknown | undefined => {
    try {
      return JSON.parse(candidate);
    } catch {
      return undefined;
    }
  };
  let parsed = tryParse(text);
  if (parsed === undefined) {
    // a) fenced ```json block anywhere in the reply (models wrap prose around).
    const jsonFence = text.match(/```json\s*([\s\S]*?)```/i);
    if (jsonFence?.[1]) {
      parsed = tryParse(jsonFence[1].trim());
    }
  }
  if (parsed === undefined) {
    // b) Python-fence fallback BEFORE the brace span: models answer with a
    // code block instead of the JSON contract. Take the first block with an
    // explicit disclosure; the confirmation gate and sandbox still apply.
    const pyFences = [...text.matchAll(/```(?:python|py)\s*([\s\S]*?)```/gi)];
    if (pyFences.length === 1 && pyFences[0]?.[1]) {
      parsed = {
        goal: "(extracted from the model's code block)",
        assumptions: [
          "model did not state assumptions — review the code before confirming",
        ],
        code: (pyFences[0][1] as string).trim(),
        validation_checks: [],
      };
    } else if (pyFences.length > 1) {
      // Models often append an "equivalent DuckDB/SQL" alternative after the
      // primary solution. Take the FIRST block (the primary one, which the
      // system prompt directs at ctx) and disclose the choice.
      parsed = {
        goal: "(extracted from the model's first code block)",
        assumptions: [
          `model returned ${pyFences.length} code blocks; the first was taken — review the code before confirming`,
        ],
        code: ((pyFences[0] as RegExpMatchArray | undefined)?.[1] ?? "").trim(),
        validation_checks: [],
      };
    }
  }
  if (parsed === undefined) {
    // c) outermost {...} span — ONLY if it looks like a spec (has a "code"
    // key). Python dict literals like {"net_sales": 2} parse as valid JSON and
    // must not win over the fence fallback above.
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      const candidate = tryParse(text.slice(start, end + 1));
      if (
        typeof candidate === "object" &&
        candidate !== null &&
        !Array.isArray(candidate) &&
        "code" in (candidate as Record<string, unknown>)
      ) {
        parsed = candidate;
      }
    }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new UserError(
      `model did not return a JSON AnalysisTaskSpec: ${text.slice(0, 200)}`,
    );
  }
  const obj = { ...(parsed as Record<string, unknown>) };
  // Unknown keys are DROPPED, not fatal: models attach example-output keys;
  // the four contract keys are what matter downstream.
  for (const key of Object.keys(obj)) {
    if (!SPEC_KEYS.has(key)) {
      delete obj[key];
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

export function cancelTask(ws: Workspace, id: string): TaskRow {
  const task = getTask(ws, id);
  if (task.status !== "awaiting_confirmation" && task.status !== "ready") {
    throw new UserError(
      `task ${id} is "${task.status}" — only unstarted tasks can be cancelled`,
    );
  }
  updateTask(ws, id, { status: "cancelled" });
  return getTask(ws, id);
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
