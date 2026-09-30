import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { UserError, type Workspace } from "../workspace.ts";
import {
  assertEnvelopeIsModeS,
  buildModeSEnvelope,
  type EnvelopeDataset,
  type StructuralDiagnostic,
} from "./envelope.ts";
import type { ModelCaller } from "./types.ts";

export interface EgressBudget {
  maxRounds: number;
  perCallTimeoutMs: number;
  sessionWallClockMs: number;
}

export const DEFAULT_EGRESS_BUDGET: EgressBudget = {
  maxRounds: 3,
  perCallTimeoutMs: 90_000,
  sessionWallClockMs: 600_000,
};

export interface ModelCallAuditRow {
  id: string;
  at: string;
  provider: string;
  purpose: string;
  payload_sha256: string;
  response_sha256: string | null;
  outcome: string;
}

export interface EgressGateway {
  completeModeS(input: {
    goal: string;
    datasets: EnvelopeDataset[];
    diagnostics?: StructuralDiagnostic[];
  }): Promise<{ text: string; callId: string }>;
  completeModeA(envelope: import("./envelope.ts").ModeAEnvelope): Promise<{
    text: string;
    callId: string;
  }>;
}

const MODEL_CALLS_MIGRATION = `CREATE TABLE IF NOT EXISTS model_calls (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  provider TEXT NOT NULL,
  purpose TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  response_sha256 TEXT,
  outcome TEXT NOT NULL
)`;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function createEgressGateway(
  ws: Workspace,
  caller: ModelCaller,
  budgetOverrides?: Partial<EgressBudget>,
): EgressGateway {
  const budget = { ...DEFAULT_EGRESS_BUDGET, ...budgetOverrides };
  ws.db.exec(MODEL_CALLS_MIGRATION);
  // P4 third budget line: one gateway instance is one bounded session.
  const sessionStartedAt = Date.now();

  return {
    async completeModeS(input) {
      const elapsed = Date.now() - sessionStartedAt;
      if (elapsed >= budget.sessionWallClockMs) {
        throw new UserError(
          `session wall clock exhausted: ${elapsed}ms > ${budget.sessionWallClockMs}ms (budget line 3 of 3)`,
        );
      }
      const envelope = buildModeSEnvelope(input);
      assertEnvelopeIsModeS(envelope);

      const callId = `call_${randomUUID().slice(0, 12)}`;
      const payloadJson = JSON.stringify(envelope);
      const request = {
        system: envelope.system,
        user: JSON.stringify({
          user_goal: envelope.user_goal,
          datasets: envelope.datasets,
          allowed_libraries: envelope.allowed_libraries,
          ...(envelope.structural_diagnostics
            ? { structural_diagnostics: envelope.structural_diagnostics }
            : {}),
        }),
      };

      const recordOutcome = (outcome: string, responseText: string | null) => {
        ws.db
          .prepare(
            "INSERT OR REPLACE INTO model_calls (id, at, provider, purpose, payload_sha256, response_sha256, outcome) VALUES (?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            callId,
            new Date().toISOString(),
            caller.name,
            "mode_s_analysis",
            sha256(payloadJson),
            responseText === null ? null : sha256(responseText),
            outcome,
          );
        mkdirSync(join(ws.root, "logs", "egress"), { recursive: true });
        writeFileSync(
          join(ws.root, "logs", "egress", `${callId}.jsonl`),
          `${JSON.stringify({ id: callId, at: new Date().toISOString(), provider: caller.name, outcome, request, payload_sha256: sha256(payloadJson) })}\n`,
        );
      };

      recordOutcome("dispatching", null);

      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          caller.call(request),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new UserError(
                    `model call timeout after ${budget.perCallTimeoutMs}ms`,
                  ),
                ),
              budget.perCallTimeoutMs,
            );
          }),
        ]);
        recordOutcome("sent", result.text);
        return { text: result.text, callId };
      } catch (error) {
        recordOutcome(
          error instanceof UserError && /timeout/.test(error.message)
            ? "timeout"
            : "error",
          null,
        );
        throw error;
      } finally {
        if (timer) {
          clearTimeout(timer);
        }
      }
    },

    async completeModeA(envelope) {
      const elapsed = Date.now() - sessionStartedAt;
      if (elapsed >= budget.sessionWallClockMs) {
        throw new UserError(
          `session wall clock exhausted: ${elapsed}ms > ${budget.sessionWallClockMs}ms (budget line 3 of 3)`,
        );
      }
      const { assertEnvelopeIsModeA } = await import("./envelope.ts");
      assertEnvelopeIsModeA(envelope);

      const callId = `call_${randomUUID().slice(0, 12)}`;
      const payloadJson = JSON.stringify(envelope);
      const request = {
        system: envelope.system,
        user: JSON.stringify({
          user_goal: envelope.user_goal,
          datasets: envelope.datasets,
          allowed_libraries: envelope.allowed_libraries,
          publication: envelope.publication,
          authorization: envelope.authorization,
        }),
      };

      const recordOutcome = (outcome: string, responseText: string | null) => {
        ws.db
          .prepare(
            "INSERT OR REPLACE INTO model_calls (id, at, provider, purpose, payload_sha256, response_sha256, outcome) VALUES (?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            callId,
            new Date().toISOString(),
            caller.name,
            "mode_a_publication",
            sha256(payloadJson),
            responseText === null ? null : sha256(responseText),
            outcome,
          );
        mkdirSync(join(ws.root, "logs", "egress"), { recursive: true });
        writeFileSync(
          join(ws.root, "logs", "egress", `${callId}.jsonl`),
          `${JSON.stringify({ id: callId, at: new Date().toISOString(), provider: caller.name, outcome, request, payload_sha256: sha256(payloadJson) })}\n`,
        );
      };

      recordOutcome("dispatching", null);

      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          caller.call(request),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new UserError(
                    `model call timeout after ${budget.perCallTimeoutMs}ms`,
                  ),
                ),
              budget.perCallTimeoutMs,
            );
          }),
        ]);
        recordOutcome("sent", result.text);
        return { text: result.text, callId };
      } catch (error) {
        recordOutcome(
          error instanceof UserError && /timeout/.test(error.message)
            ? "timeout"
            : "error",
          null,
        );
        throw error;
      } finally {
        if (timer) {
          clearTimeout(timer);
        }
      }
    },
  };
}

export function listModelCalls(ws: Workspace): ModelCallAuditRow[] {
  ws.db.exec(MODEL_CALLS_MIGRATION);
  return ws.db
    .prepare(
      "SELECT id, at, provider, purpose, payload_sha256, response_sha256, outcome FROM model_calls ORDER BY at",
    )
    .all() as unknown as ModelCallAuditRow[];
}
