/**
 * Xanthil core adapter — the programmatic surface for host applications
 * (Xanthil Desktop). Wraps the SAME core modules the CLI uses (same-core by
 * construction, J5): catalog, schema, orchestrator, publication, isolation.
 * Adds NO new file/network/model path — every outbound model call still goes
 * through the single egress gateway (M3 exit criterion: no bypass egress).
 */

import { copyFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import {
  getDatasetByAlias,
  listDatasets,
  registerDataset,
} from "../catalog.ts";
import { runSandboxSelfCheck } from "../isolation.ts";
import { createCaller, type ModelCallerParams } from "../llm/caller.ts";
import { listModelCalls } from "../llm/egress.ts";
import { askTask, runSession, runTask } from "../orchestrator.ts";
import { profileDataset } from "../profiler.ts";
import { listSkills, runSkill } from "../skills.ts";

function skillsAlias(name: string, params: Record<string, string>): string {
  const alias = params.dataset ?? params.alias;
  if (!alias) throw new UserError("skills.run requires params.dataset");
  return alias;
}

import {
  approvePublication,
  emitPlanDraft,
  getPublication,
  getPublicationPayload,
  listPublications,
  preparePublication,
  revokeApproval,
  sendPublication,
} from "../publication.ts";
import { approveSchemaCard, getApprovedCard } from "../schema.ts";
import {
  cancelTask,
  createTask,
  getArtifact,
  getTask,
  listArtifacts,
  listTasks,
  updateTask,
} from "../tasks.ts";
import {
  initWorkspace,
  openWorkspace,
  resolveWorkspacePath,
  UserError,
  type Workspace,
} from "../workspace.ts";

export interface XanthilCoreOptions {
  /** Workspace root directory (the Desktop side decides where it lives). */
  workspaceDir: string;
  /** Model credentials: injected by the host, held in memory only. */
  model: ModelCallerParams;
}

export function createXanthilCore(options: XanthilCoreOptions) {
  const root = resolveWorkspacePath(options.workspaceDir);
  const caller = createCaller(options.model);
  // Lazy: the workspace may not exist until the host calls init().
  let opened: Workspace | null = null;
  const ws = (): Workspace => {
    opened ??= openWorkspace(root);
    return opened;
  };

  return {
    workspace: { root },

    datasets: {
      list: () => listDatasets(ws()),
      register: (filePath: string, alias: string) =>
        registerDataset(ws(), filePath, alias),
    },

    schema: {
      profile: (alias: string) => profileDataset(ws(), alias),
      approve: (alias: string, cardPath?: string) =>
        approveSchemaCard(
          ws(),
          alias,
          cardPath ?? `${root}/datasets/${alias}.schema.yaml`,
        ),
      approved: (alias: string) => getApprovedCard(ws(), alias),
    },

    tasks: {
      ask: (goal: string, datasets: string[]) =>
        askTask(ws(), caller, { goal, aliases: datasets }),
      get: (id: string) => getTask(ws(), id),
      list: () => listTasks(ws()),
      confirm: (id: string) => {
        const task = getTask(ws(), id);
        if (task.status !== "awaiting_confirmation") {
          throw new UserError(
            `task ${id} is "${task.status}", expected "awaiting_confirmation"`,
          );
        }
        updateTask(ws(), id, { status: "ready" });
        return getTask(ws(), id);
      },
      cancel: (id: string) => cancelTask(ws(), id),
      run: (id: string) => runTask(ws(), caller, id),
      runSession: (ids: string[]) => runSession(ws(), caller, ids),
    },

    publications: {
      planDraft: (alias: string) => {
        const { card } = getApprovedCard(ws(), alias);
        return emitPlanDraft(alias, Object.keys(card.columns));
      },
      prepare: (plan: string | Record<string, unknown>) => {
        // J8: accept a plan OBJECT (canonical YAML round-trip) or a file path.
        if (typeof plan === "string") {
          return preparePublication(ws(), plan);
        }
        const planPath = join(
          root,
          "publications",
          `plan-${Date.now().toString(36)}.yaml`,
        );
        writeFileSync(planPath, YAML.stringify(plan));
        return preparePublication(ws(), planPath);
      },
      approve: (publicationId: string) =>
        approvePublication(ws(), publicationId),
      send: (publicationId: string) =>
        sendPublication(ws(), publicationId, caller),
      revoke: (publicationId: string) => {
        const rows = ws()
          .db.prepare(
            "SELECT id FROM approvals WHERE publication_id = ? AND revoked_at IS NULL",
          )
          .all(publicationId) as { id: string }[];
        for (const row of rows) {
          revokeApproval(ws(), row.id);
        }
        return rows.map((r) => r.id);
      },
      list: () => listPublications(ws()),
      get: (id: string) => getPublication(ws(), id),
      payload: (id: string) => getPublicationPayload(ws(), id),
    },

    artifacts: {
      list: (taskId?: string) => listArtifacts(ws(), taskId),
      get: (id: string) => getArtifact(ws(), id),
      export: (id: string, destination: string) => {
        const artifact = getArtifact(ws(), id);
        copyFileSync(artifact.path, destination);
        return { exported: id, to: destination };
      },
    },

    audit: {
      modelCalls: () => listModelCalls(ws()),
    },

    sandbox: {
      selfCheck: () => runSandboxSelfCheck(),
    },

    skills: {
      list: () => listSkills(),
      run: (name: string, params: Record<string, string>) => {
        const alias = skillsAlias(name, params);
        const { card, schema_version } = getApprovedCard(ws(), alias);
        const spec = runSkill({ name, alias, card, params });
        const listing = getDatasetByAlias(ws(), alias);
        return createTask(ws(), {
          goal: spec.goal,
          datasets: [alias],
          versions: {
            [alias]: { version: listing.current_version, schema_version },
          },
          spec,
        });
      },
    },

    init: () => initWorkspace(root),
  };
}

export type XanthilCore = ReturnType<typeof createXanthilCore>;
