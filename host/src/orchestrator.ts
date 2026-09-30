import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDatasetByAlias, listDatasets } from "./catalog.ts";
import {
  createEgressGateway,
  DEFAULT_EGRESS_BUDGET,
  type EgressBudget,
} from "./llm/egress.ts";
import type { StructuralDiagnostic } from "./llm/envelope.ts";
import type { ModelCaller } from "./llm/types.ts";
import { runWorkerModule } from "./profiler.ts";
import { getApprovedCard } from "./schema.ts";
import {
  type AnalysisTaskSpec,
  createTask,
  getTask,
  registerArtifacts,
  type TaskRow,
  updateTask,
} from "./tasks.ts";
import { UserError, type Workspace } from "./workspace.ts";

interface ExecutionReport {
  status: "succeeded" | "failed";
  artifacts: { name: string; type: string; path: string }[];
  loaded_datasets: string[];
  error: { kind: string; detail?: string } | null;
}

/** Ask the model for an AnalysisTaskSpec over the approved schemas; task lands awaiting_confirmation. */
export async function askTask(
  ws: Workspace,
  caller: ModelCaller,
  input: { goal: string; aliases: string[] },
): Promise<TaskRow> {
  if (input.aliases.length === 0) {
    throw new UserError("ask requires at least one --dataset <alias>");
  }
  const versions: Record<string, { version: string; schema_version: string }> =
    {};
  const envelopeDatasets = input.aliases.map((alias) => {
    const listing = getDatasetByAlias(ws, alias);
    const { schema_version, card } = getApprovedCard(ws, alias);
    versions[alias] = { version: listing.current_version, schema_version };
    return { alias, uri: `dataset://${alias}`, schema_card: card };
  });

  const gateway = createEgressGateway(ws, caller);
  const { text } = await gateway.completeModeS({
    goal: input.goal,
    datasets: envelopeDatasets,
  });

  const { parseTaskSpec } = await import("./tasks.ts");
  const spec = parseTaskSpec(text);
  return createTask(ws, {
    goal: input.goal,
    datasets: input.aliases,
    versions,
    spec,
  });
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function classifyIntoDiagnostic(
  ws: Workspace,
  task: TaskRow,
  error: { kind: string; detail?: string },
): StructuralDiagnostic | null {
  // A diagnostic may only echo tokens the model itself produced (its code) or
  // registered schema names — a KeyError whose key is a CELL VALUE must be
  // treated as an opaque runtime failure (P02 adversarial guarantee).
  const echoable = (token: string): boolean =>
    token.length > 0 && token.length <= 64 && task.spec.code.includes(token);

  if (error.kind === "syntax") {
    return { kind: "syntax", detail: error.detail ?? "syntax error" };
  }
  if (error.kind === "missing_lib") {
    return { kind: "missing_lib", detail: error.detail ?? "unknown module" };
  }
  if (error.kind === "keyerror" && typeof error.detail === "string") {
    if (task.datasets.includes(error.detail)) {
      const known = listDatasets(ws)
        .map((d) => d.alias)
        .join(", ");
      return {
        kind: "unknown_dataset",
        detail: `dataset "${error.detail}" not registered (registered: ${known})`,
      };
    }
    for (const alias of task.datasets) {
      const { card } = getApprovedCard(ws, alias);
      if (Object.keys(card.columns).includes(error.detail)) {
        return null; // the column exists — the failure is not a simple unknown-field case
      }
    }
    if (!echoable(error.detail)) {
      return null; // key does not come from the model's own code: opaque runtime failure
    }
    const allColumns = task.datasets
      .map((alias) =>
        Object.keys(getApprovedCard(ws, alias).card.columns).join(", "),
      )
      .join(", ");
    return {
      kind: "unknown_field",
      detail: `column "${error.detail}" not found (schema columns: ${allColumns})`,
    };
  }
  return null;
}

export type TaskExecutor = (input: {
  code: string;
  datasetSpecs: Record<string, { path: string; version: string }>;
  runDir: string;
}) => Promise<ExecutionReport>;

function oneShotExecutor(ws: Workspace): TaskExecutor {
  return async (input) =>
    runWorkerModule<ExecutionReport>(
      ws,
      "worker.execute",
      {
        code: input.code,
        datasets: Object.fromEntries(
          Object.entries(input.datasetSpecs).map(([alias, spec]) => [
            alias,
            spec.path,
          ]),
        ),
        run_dir: input.runDir,
      },
      Object.values(input.datasetSpecs).map((spec) => spec.path),
      input.runDir,
    );
}

/** Execute confirmed tasks sequentially on ONE persistent kernel (F05 reuse). */
export async function runSession(
  ws: Workspace,
  caller: ModelCaller,
  taskIds: string[],
): Promise<{
  results: { id: string; status: string; error_summary: string | null }[];
}> {
  const aliases = new Set<string>();
  for (const taskId of taskIds) {
    for (const alias of getTask(ws, taskId).datasets) {
      aliases.add(alias);
    }
  }
  const { KernelManager } = await import("./kernel.ts");
  const kernel = new KernelManager(ws, [...aliases], taskIds);
  kernel.start();
  const kernelExecutor: TaskExecutor = async (input) => {
    const report = await kernel.execute({
      code: input.code,
      datasets: input.datasetSpecs,
      runDir: input.runDir,
    });
    return {
      status: report.status,
      artifacts: report.artifacts,
      loaded_datasets: Object.keys(report.dataset_loads),
      error: report.error,
    };
  };
  const results: {
    id: string;
    status: string;
    error_summary: string | null;
  }[] = [];
  try {
    for (const taskId of taskIds) {
      const task = await runTaskWith(ws, caller, taskId, kernelExecutor);
      results.push({
        id: task.id,
        status: task.status,
        error_summary: task.error_summary,
      });
    }
  } finally {
    await kernel.stop();
  }
  return { results };
}

/** Execute a confirmed task: sandboxed run, artifact registration, bounded structural fix rounds. */
export async function runTask(
  ws: Workspace,
  caller: ModelCaller,
  taskId: string,
  budgetOverrides?: Partial<EgressBudget>,
): Promise<TaskRow> {
  return runTaskWith(ws, caller, taskId, undefined, budgetOverrides);
}

async function runTaskWith(
  ws: Workspace,
  caller: ModelCaller,
  taskId: string,
  executor?: TaskExecutor,
  budgetOverrides?: Partial<EgressBudget>,
): Promise<TaskRow> {
  const executeWith: TaskExecutor = executor ?? oneShotExecutor(ws);
  let task = getTask(ws, taskId);
  if (task.status !== "ready") {
    throw new UserError(
      `task ${taskId} is "${task.status}" — run "xanthil confirm ${taskId}" first`,
    );
  }

  // F06 pre-check: inputs must still hash to the versions the task was planned against.
  for (const alias of task.datasets) {
    const row = ws.db
      .prepare(
        `SELECT dv.path, dv.version FROM datasets d
         JOIN dataset_versions dv ON dv.dataset_id = d.dataset_id AND dv.version = d.current_version
         WHERE d.alias = ?`,
      )
      .get(alias) as { path: string; version: string } | undefined;
    if (!row || sha256File(row.path) !== task.versions[alias]?.version) {
      updateTask(ws, taskId, {
        status: "failed",
        error_summary: `input version drift for "${alias}": re-register the dataset and ask again`,
      });
      return getTask(ws, taskId);
    }
  }

  const budget = { ...DEFAULT_EGRESS_BUDGET, ...budgetOverrides };
  const gateway = createEgressGateway(ws, caller, budgetOverrides);
  let diagnostics: StructuralDiagnostic[] | undefined;

  while (true) {
    task = getTask(ws, taskId);
    const runId = `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const runDir = join(ws.root, "runs", taskId, runId);
    mkdirSync(runDir, { recursive: true });

    const datasetSpecs: Record<string, { path: string; version: string }> = {};
    for (const alias of task.datasets) {
      const row = ws.db
        .prepare(
          `SELECT dv.path, dv.version FROM datasets d
           JOIN dataset_versions dv ON dv.dataset_id = d.dataset_id AND dv.version = d.current_version
           WHERE d.alias = ?`,
        )
        .get(alias) as { path: string; version: string } | undefined;
      if (row) {
        datasetSpecs[alias] = {
          path: row.path,
          version: task.versions[alias]?.version ?? row.version,
        };
      }
    }

    updateTask(ws, taskId, { status: "running" });
    let report: ExecutionReport;
    try {
      report = await executeWith({
        code: task.spec.code,
        datasetSpecs,
        runDir,
      });
    } catch (error) {
      // Worker crash / timeout / sandbox kill: settle the task honestly (no fake success).
      writeFileSync(
        join(runDir, "worker-stderr.log"),
        error instanceof UserError ? error.message : String(error),
      );
      updateTask(ws, taskId, {
        status: "failed",
        error_summary: `execution environment failure: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`,
      });
      return getTask(ws, taskId);
    }

    if (report.status === "succeeded") {
      registerArtifacts(ws, {
        taskId,
        runId,
        dataVersions: task.versions,
        artifacts: report.artifacts,
      });
      updateTask(ws, taskId, { status: "succeeded", error_summary: null });
      writeFileSync(
        join(runDir, "execution-record.json"),
        `${JSON.stringify(
          {
            task_id: taskId,
            run_id: runId,
            at: new Date().toISOString(),
            versions: task.versions,
            code_sha256: createHash("sha256")
              .update(task.spec.code)
              .digest("hex"),
            outcome: "succeeded",
            artifacts: report.artifacts,
          },
          null,
          2,
        )}\n`,
      );
      return getTask(ws, taskId);
    }

    const diagnostic = report.error
      ? classifyIntoDiagnostic(ws, task, report.error)
      : null;
    if (diagnostic === null || task.rounds_used >= budget.maxRounds) {
      const summary =
        diagnostic === null
          ? `execution failed: ${report.error?.kind ?? "unknown"} (details in local run log)`
          : `max fix rounds (${budget.maxRounds}) reached`;
      updateTask(ws, taskId, { status: "failed", error_summary: summary });
      writeFileSync(
        join(runDir, "execution-record.json"),
        `${JSON.stringify(
          {
            task_id: taskId,
            run_id: runId,
            at: new Date().toISOString(),
            versions: task.versions,
            code_sha256: createHash("sha256")
              .update(task.spec.code)
              .digest("hex"),
            outcome: "failed",
            error: report.error,
          },
          null,
          2,
        )}\n`,
      );
      return getTask(ws, taskId);
    }

    // Structural failure within budget: one more model round with the diagnostic only.
    diagnostics = [diagnostic];
    const envelopeDatasets = task.datasets.map((alias) => {
      const { card } = getApprovedCard(ws, alias);
      return { alias, uri: `dataset://${alias}`, schema_card: card };
    });
    let nextSpec: AnalysisTaskSpec;
    try {
      const reply = await gateway.completeModeS({
        goal: task.goal,
        datasets: envelopeDatasets,
        diagnostics,
      });
      const { parseTaskSpec } = await import("./tasks.ts");
      nextSpec = parseTaskSpec(reply.text);
    } catch (error) {
      updateTask(ws, taskId, {
        status: "failed",
        error_summary: `fix round ${task.rounds_used + 1} model call failed: ${
          error instanceof Error ? error.message.slice(0, 200) : String(error)
        }`,
      });
      return getTask(ws, taskId);
    }
    updateTask(ws, taskId, {
      status: "ready",
      spec: nextSpec,
      rounds_used: task.rounds_used + 1,
    });
  }
}
