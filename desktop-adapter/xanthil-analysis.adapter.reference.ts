/**
 * REFERENCE WIRING — Xanthil Desktop ⇄ local-code-analysis-mode adapter.
 *
 * This file lives in THIS repository as a reference for the JuanerAI team.
 * It is NOT compiled into the host build and does NOT write anything into
 * ~/JuanerAI. Adopting it is a JuanerAI Change/PR (see INTEGRATION.md).
 *
 * Maps the analysis-related requests of packages/contracts/xanthil-desktop-ipc.ts
 * onto createXanthilCore(). Disclosure-gated assistance maps to mode-A
 * publication (decideAssistanceDisclosure ≙ publish approve, startAssistance ≙
 * publish send) — one boundary, no parallel egress channel.
 */

import type {
  CancelAnalysisRequest,
  DesktopProjection,
  DesktopResult,
  ReadProjectionRequest,
  StartAnalysisRequest,
} from "@juanerai/contracts/xanthil-desktop-ipc";
import {
  createXanthilCore,
  type XanthilCore,
  type XanthilCoreOptions,
} from "../host/src/adapter/xanthil-core.ts";

/** Host-owned wiring: one core instance per Desktop project workspace. */
export function createAnalysisBridge(options: XanthilCoreOptions) {
  const core: XanthilCore = createXanthilCore(options);

  return {
    /**
     * startAnalysis ≙ ask + (user-confirmed) confirm + run (mode S).
     * IMPORTANT (reference honesty): the real contract carries the goal in the
     * revision's question_text and datasets via a confirmed snapshot/column
     * mapping — map those here. confirm() must be driven by the Desktop's own
     * confirmation flow (confirmation_id), NOT auto-called as sketched below.
     * run ids are task_* strings here, NOT the contract's UUIDv7 — bridge with
     * a Desktop-side id mapping. Artifacts are LOCAL references only.
     */
    async startAnalysis(
      request: StartAnalysisRequest,
    ): Promise<DesktopResult<DesktopProjection>> {
      const task = await core.tasks.ask(request.goal_text ?? "", [
        ...request.dataset_aliases,
      ]);
      core.tasks.confirm(task.id);
      const run = await core.tasks.run(task.id);
      const artifacts = core.artifacts.list(task.id).map((a) => ({
        artifact_id: String((a as { id: string }).id),
        kind: String((a as { type: string }).type),
      }));
      return ok({
        attempts: [
          {
            run_id: task.id,
            status: run.status === "succeeded" ? "Succeeded" : "Failed",
            action_kind: "organize_question",
          },
        ],
        artifacts,
        // disclosures stay 0 unless the user approves a mode-A publication
        disclosures: 0,
      } as unknown as DesktopProjection);
    },

    cancelAnalysis(request: CancelAnalysisRequest) {
      core.tasks.cancel(request.run_id);
      return ok({} as unknown as DesktopProjection);
    },

    readProjection(_request: ReadProjectionRequest) {
      // Projections are Desktop-owned state; this bridge exposes facts:
      return ok({
        tasks: core.tasks.list(),
        publications: core.publications.list(),
        modelCalls: core.audit.modelCalls(),
      } as unknown as DesktopProjection);
    },

    /** Assistance (disclosure-gated) delegates to mode A. */
    publications: core.publications,
  };
}

function ok(projection: DesktopProjection): DesktopResult<DesktopProjection> {
  return { ok: true, value: projection } as DesktopResult<DesktopProjection>;
}
