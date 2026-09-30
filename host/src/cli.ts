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
import {
  approvePublication,
  emitPlanDraft,
  getPublication,
  getPublicationPayload,
  listPublications,
  preparePublication,
  revokeApproval,
  sendPublication,
} from "./publication.ts";
import { approveSchemaCard, getApprovedCard } from "./schema.ts";
import {
  cancelTask,
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
  .command("cancel <taskId>")
  .description("cancel an unstarted task (awaiting_confirmation or ready)")
  .action((taskId: string) => {
    try {
      const wsPath = resolveWorkspacePath(program.opts().workspace);
      const ws = openWorkspace(wsPath);
      const task = cancelTask(ws, taskId);
      console.log(JSON.stringify({ id: task.id, status: task.status }));
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
    let wsRef: ReturnType<typeof openWorkspace> | undefined;
    const onInterrupt = () => {
      // SIGINT: stop the kernel first (sandboxed children die with it), then
      // settle whatever task was running so no task is left in "running".
      if (wsRef) {
        for (const taskId of taskIds) {
          try {
            const task = getTask(wsRef, taskId);
            if (task.status === "running") {
              updateTask(wsRef, taskId, {
                status: "failed",
                error_summary: "cancelled by interrupt (kernel stopped)",
              });
            }
          } catch {
            // best-effort settle; exit matters more
          }
        }
      }
      process.exit(130);
    };
    process.on("SIGINT", onInterrupt);
    try {
      const wsPath = resolveWorkspacePath(program.opts().workspace);
      const ws = openWorkspace(wsPath);
      wsRef = ws;
      const { results } = await runSession(ws, createCallerFromEnv(), taskIds);
      console.log(JSON.stringify(results));
    } catch (error) {
      fail(error);
    } finally {
      process.off("SIGINT", onInterrupt);
    }
  });

const publish = program
  .command("publish")
  .description("mode-A trusted publication (§4.2/§6.7)");

publish
  .command("plan <alias>")
  .description(
    "write a publication plan draft for a dataset with an approved card",
  )
  .action((alias: string) => {
    try {
      const wsPath = resolveWorkspacePath(program.opts().workspace);
      const ws = openWorkspace(wsPath);
      const { card } = getApprovedCard(ws, alias);
      const planPath = join(
        wsPath,
        "publications",
        `plan-${Date.now().toString(36)}.yaml`,
      );
      writeFileSync(planPath, emitPlanDraft(alias, Object.keys(card.columns)));
      console.log(JSON.stringify({ plan_path: planPath }));
    } catch (error) {
      fail(error);
    }
  });

publish
  .command("prepare <planPath>")
  .description(
    "validate the plan and recompute it via the trusted publisher (prepare or block)",
  )
  .action((planPath: string) => {
    try {
      const wsPath = resolveWorkspacePath(program.opts().workspace);
      const ws = openWorkspace(wsPath);
      const publication = preparePublication(ws, planPath);
      console.log(JSON.stringify(publication));
    } catch (error) {
      fail(error);
    }
  });

publish
  .command("approve <publicationId>")
  .description(
    "bind the prepared payload: digest + data versions + target model + caps + expiry",
  )
  .action((publicationId: string) => {
    try {
      const wsPath = resolveWorkspacePath(program.opts().workspace);
      const ws = openWorkspace(wsPath);
      const approval = approvePublication(ws, publicationId);
      console.log(JSON.stringify(approval));
    } catch (error) {
      fail(error);
    }
  });

publish
  .command("send <publicationId>")
  .description(
    "re-verify, recompute, and send the authorized aggregates (mode A)",
  )
  .action(async (publicationId: string) => {
    try {
      const wsPath = resolveWorkspacePath(program.opts().workspace);
      const ws = openWorkspace(wsPath);
      const result = await sendPublication(ws, publicationId);
      if (result.reply !== undefined) {
        console.log(result.reply);
      }
      console.log(
        JSON.stringify({
          status: result.status,
          block_reason: result.block_reason,
        }),
      );
    } catch (error) {
      fail(error);
    }
  });

publish
  .command("revoke <publicationId>")
  .description("revoke the active approval — future sends are blocked (P10)")
  .action((publicationId: string) => {
    try {
      const wsPath = resolveWorkspacePath(program.opts().workspace);
      const ws = openWorkspace(wsPath);
      // R1: revoke ALL active approvals for this publication — a stale one
      // must never survive to authorize sends.
      const rows = ws.db
        .prepare(
          "SELECT id FROM approvals WHERE publication_id = ? AND revoked_at IS NULL",
        )
        .all(publicationId) as { id: string }[];
      if (rows.length === 0) {
        throw new UserError(`no active approval for ${publicationId}`);
      }
      for (const row of rows) {
        revokeApproval(ws, row.id);
      }
      console.log(JSON.stringify({ revoked: rows.map((r) => r.id) }));
    } catch (error) {
      fail(error);
    }
  });

program
  .command("publication <publicationId>")
  .description("show a publication's payload and status")
  .action((publicationId: string) => {
    try {
      const wsPath = resolveWorkspacePath(program.opts().workspace);
      const ws = openWorkspace(wsPath);
      const publication = getPublication(ws, publicationId);
      // R14: blocked/expired publications have no payload — show still works.
      let payload: unknown = null;
      try {
        payload = JSON.parse(getPublicationPayload(ws, publicationId));
      } catch {
        payload = null;
      }
      console.log(JSON.stringify({ ...publication, payload }, null, 2));
    } catch (error) {
      fail(error);
    }
  });

program
  .command("publications")
  .description("list publications and their status")
  .action(() => {
    try {
      const wsPath = resolveWorkspacePath(program.opts().workspace);
      const ws = openWorkspace(wsPath);
      console.log(JSON.stringify(listPublications(ws)));
    } catch (error) {
      fail(error);
    }
  });

program.parse(process.argv);
