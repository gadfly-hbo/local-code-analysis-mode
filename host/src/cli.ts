#!/usr/bin/env node
import { copyFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { listDatasets, registerDataset } from "./catalog.ts";
import { runSandboxSelfCheck } from "./isolation.ts";
import { listModelCalls } from "./llm/egress.ts";
import { createCallerFromEnv } from "./llm/index.ts";
import { askTask, runSession, runTask } from "./orchestrator.ts";
import { profileDataset } from "./profiler.ts";
import { approveSchemaCard, getApprovedCard } from "./schema.ts";
import {
  getArtifact,
  getTask,
  listArtifacts,
  listTasks,
  updateTask,
} from "./tasks.ts";
import { VERSION } from "./version.ts";
import {
  initWorkspace,
  openWorkspace,
  resolveWorkspacePath,
  UserError,
} from "./workspace.ts";

function collectDataset(value: string, previous: string[]): string[] {
  return [...previous, value];
}

const program = new Command();

program
  .name("xanthil")
  .description(
    "Xanthil local data analysis tool — default privacy mode S (schema-only)",
  )
  .version(VERSION)
  .option("--workspace <path>", "workspace directory (default: ./.xanthil)");

function fail(error: unknown): never {
  if (error instanceof UserError) {
    process.stderr.write(`error: ${error.message}\n`);
  } else {
    process.stderr.write(`unexpected error: ${String(error)}\n`);
  }
  process.exit(1);
}

program
  .command("init")
  .description("create the local workspace (idempotent)")
  .action(() => {
    const wsPath = resolveWorkspacePath(program.opts().workspace);
    const { created } = initWorkspace(wsPath);
    console.log(
      created
        ? `workspace created at ${wsPath}`
        : `workspace already exists at ${wsPath}`,
    );
  });

program
  .command("register <file>")
  .description("register a local data file under a logical alias")
  .requiredOption("--alias <alias>", "logical alias, e.g. sales")
  .action((file: string, opts: { alias: string }) => {
    try {
      const wsPath = resolveWorkspacePath(program.opts().workspace);
      const ws = openWorkspace(wsPath);
      const result = registerDataset(ws, file, opts.alias);
      console.log(JSON.stringify(result));
    } catch (error) {
      fail(error);
    }
  });

program
  .command("datasets")
  .description("list registered datasets and their content versions")
  .action(() => {
    try {
      const wsPath = resolveWorkspacePath(program.opts().workspace);
      const ws = openWorkspace(wsPath);
      console.log(JSON.stringify(listDatasets(ws)));
    } catch (error) {
      fail(error);
    }
  });

program
  .command("profile <alias>")
  .description(
    "profile a registered dataset locally and write a schema card draft",
  )
  .action((alias: string) => {
    try {
      const wsPath = resolveWorkspacePath(program.opts().workspace);
      const ws = openWorkspace(wsPath);
      const { profile, card_draft_path } = profileDataset(ws, alias);
      console.log(JSON.stringify({ profile, card_draft_path }));
    } catch (error) {
      fail(error);
    }
  });

const schema = program.command("schema").description("schema card operations");

schema
  .command("approve <alias>")
  .description("approve the (edited) schema card draft for a dataset")
  .option(
    "--card <path>",
    "path to the card draft (default: <workspace>/datasets/<alias>.schema.yaml)",
  )
  .action((alias: string, opts: { card?: string }) => {
    try {
      const wsPath = resolveWorkspacePath(program.opts().workspace);
      const ws = openWorkspace(wsPath);
      const cardPath =
        opts.card ?? join(wsPath, "datasets", `${alias}.schema.yaml`);
      const result = approveSchemaCard(ws, alias, cardPath);
      console.log(JSON.stringify(result));
    } catch (error) {
      fail(error);
    }
  });

schema
  .command("show <alias>")
  .description("print the approved schema card for a dataset")
  .action((alias: string) => {
    try {
      const wsPath = resolveWorkspacePath(program.opts().workspace);
      const ws = openWorkspace(wsPath);
      console.log(JSON.stringify(getApprovedCard(ws, alias)));
    } catch (error) {
      fail(error);
    }
  });

const sandbox = program
  .command("sandbox")
  .description("isolation backend operations");

sandbox
  .command("check")
  .description("run the escape self-check against the isolation backend")
  .action(() => {
    try {
      const wsPath = resolveWorkspacePath(program.opts().workspace);
      openWorkspace(wsPath);
      const report = runSandboxSelfCheck();
      writeFileSync(
        join(wsPath, "sandbox-check.json"),
        `${JSON.stringify(report, null, 2)}\n`,
      );
      console.log(JSON.stringify(report));
      if (!report.passed) {
        process.exitCode = 1;
      }
    } catch (error) {
      fail(error);
    }
  });

program
  .command("audit")
  .description(
    "list every model call the egress gateway dispatched (what the model actually received)",
  )
  .action(() => {
    try {
      const wsPath = resolveWorkspacePath(program.opts().workspace);
      const ws = openWorkspace(wsPath);
      console.log(JSON.stringify(listModelCalls(ws)));
    } catch (error) {
      fail(error);
    }
  });

program
  .command("ask <goal>")
  .description(
    "ask the model for an analysis plan over approved schemas (mode S)",
  )
  .requiredOption(
    "--dataset <alias>",
    "dataset alias (repeatable)",
    collectDataset,
    [],
  )
  .action(async (goal: string, opts: { dataset: string[] }) => {
    try {
      const wsPath = resolveWorkspacePath(program.opts().workspace);
      const ws = openWorkspace(wsPath);
      const task = await askTask(ws, createCallerFromEnv(), {
        goal,
        aliases: opts.dataset,
      });
      console.log(
        JSON.stringify({
          id: task.id,
          status: task.status,
          goal: task.goal,
          assumptions: task.spec.assumptions,
          code: task.spec.code,
        }),
      );
    } catch (error) {
      fail(error);
    }
  });

program
  .command("confirm <taskId>")
  .description("approve an awaiting task, moving it to ready")
  .action((taskId: string) => {
    try {
      const wsPath = resolveWorkspacePath(program.opts().workspace);
      const ws = openWorkspace(wsPath);
      const task = getTask(ws, taskId);
      if (task.status !== "awaiting_confirmation") {
        throw new UserError(
          `task ${taskId} is "${task.status}", expected "awaiting_confirmation"`,
        );
      }
      updateTask(ws, taskId, { status: "ready" });
      console.log(JSON.stringify({ id: taskId, status: "ready" }));
    } catch (error) {
      fail(error);
    }
  });

program
  .command("run <taskId>")
  .description("execute a confirmed task in the sandboxed worker")
  .action(async (taskId: string) => {
    let wsRef: ReturnType<typeof openWorkspace> | undefined;
    try {
      const wsPath = resolveWorkspacePath(program.opts().workspace);
      const ws = openWorkspace(wsPath);
      wsRef = ws;
      const task = await runTask(ws, createCallerFromEnv(), taskId);
      console.log(
        JSON.stringify({
          id: task.id,
          status: task.status,
          error_summary: task.error_summary,
        }),
      );
    } catch (error) {
      // Last-resort settle: a task must never be left in "running" by a crash.
      if (wsRef) {
        try {
          const task = getTask(wsRef, taskId);
          if (task.status === "running") {
            updateTask(wsRef, taskId, {
              status: "failed",
              error_summary: `run command aborted: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`,
            });
          }
        } catch {
          // original error matters more than the settle attempt
        }
      }
      fail(error);
    }
  });

program
  .command("tasks")
  .description("list analysis tasks")
  .action(() => {
    try {
      const wsPath = resolveWorkspacePath(program.opts().workspace);
      const ws = openWorkspace(wsPath);
      console.log(JSON.stringify(listTasks(ws)));
    } catch (error) {
      fail(error);
    }
  });

program
  .command("artifacts [taskId]")
  .description("list local artifacts (all, or for one task)")
  .action((taskId?: string) => {
    try {
      const wsPath = resolveWorkspacePath(program.opts().workspace);
      const ws = openWorkspace(wsPath);
      console.log(JSON.stringify(listArtifacts(ws, taskId)));
    } catch (error) {
      fail(error);
    }
  });

program
  .command("export <artifactId>")
  .description(
    "copy a local artifact to an explicit destination (never automatic)",
  )
  .requiredOption("--out <path>", "destination file path")
  .action((artifactId: string, opts: { out: string }) => {
    try {
      const wsPath = resolveWorkspacePath(program.opts().workspace);
      const ws = openWorkspace(wsPath);
      const artifact = getArtifact(ws, artifactId);
      copyFileSync(artifact.path, opts.out);
      console.log(JSON.stringify({ exported: artifactId, to: opts.out }));
    } catch (error) {
      fail(error);
    }
  });

program
  .command("session <taskIds...>")
  .description(
    "execute confirmed tasks sequentially on one persistent kernel (dataset reuse)",
  )
  .action(async (taskIds: string[]) => {
    try {
      const wsPath = resolveWorkspacePath(program.opts().workspace);
      const ws = openWorkspace(wsPath);
      const { results } = await runSession(ws, createCallerFromEnv(), taskIds);
      console.log(JSON.stringify(results));
    } catch (error) {
      fail(error);
    }
  });

program.parse(process.argv);
