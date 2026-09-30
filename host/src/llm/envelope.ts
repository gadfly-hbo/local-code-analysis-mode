import type { SchemaCard } from "../profiler.ts";

/** Whitelisted structural failure kinds that may travel back to the model (G6). */
export type StructuralDiagnosticKind =
  | "syntax"
  | "missing_lib"
  | "unknown_dataset"
  | "unknown_field";

export interface StructuralDiagnostic {
  kind: StructuralDiagnosticKind;
  detail: string;
}

export interface EnvelopeDataset {
  alias: string;
  uri: string;
  schema_card: SchemaCard;
}

export interface ModeSEnvelope {
  system: string;
  user_goal: string;
  datasets: EnvelopeDataset[];
  allowed_libraries: string[];
  structural_diagnostics?: StructuralDiagnostic[];
}

export const ALLOWED_LIBRARIES = ["pandas", "duckdb", "matplotlib"] as const;

export const MODE_S_SYSTEM = `You are Xanthil's analysis programmer operating in privacy mode S (schema-only).
You receive the user's analysis goal plus the approved table structures and business semantics.
You NEVER see row data, samples, statistics, or execution output; do not ask for them and never claim to have read real values.
Your job: reason about the method, then output a single JSON object (an AnalysisTaskSpec) with keys goal, assumptions, code, validation_checks.
The code field is Python that uses ONLY the provided ctx object (ctx.datasets["<alias>"] -> pandas DataFrame) and the allowed libraries ${ALLOWED_LIBRARIES.join(", ")}.
Output JSON only — no prose outside the JSON.`;

export function buildModeSEnvelope(input: {
  goal: string;
  datasets: EnvelopeDataset[];
  diagnostics?: StructuralDiagnostic[];
}): ModeSEnvelope {
  const envelope: ModeSEnvelope = {
    system: MODE_S_SYSTEM,
    user_goal: input.goal,
    datasets: input.datasets,
    allowed_libraries: [...ALLOWED_LIBRARIES],
  };
  if (input.diagnostics && input.diagnostics.length > 0) {
    envelope.structural_diagnostics = input.diagnostics;
  }
  return envelope;
}

const ENVELOPE_KEYS = new Set([
  "system",
  "user_goal",
  "datasets",
  "allowed_libraries",
  "structural_diagnostics",
]);
const DATASET_KEYS = new Set(["alias", "uri", "schema_card"]);
const CARD_KEYS = new Set([
  "dataset",
  "grain",
  "columns",
  "unique_keys",
  "notes",
]);
const COLUMN_KEYS = new Set(["type", "semantics"]);
const DIAGNOSTIC_KEYS = new Set(["kind", "detail"]);
const DIAGNOSTIC_KINDS = new Set([
  "syntax",
  "missing_lib",
  "unknown_dataset",
  "unknown_field",
]);
/** Anywhere in the payload, these key names mean data-derived content (proposal §4.1/§6.2). */
const BANNED_KEYS = new Set([
  "row_count",
  "null_count",
  "distinct_count",
  "distinct",
  "is_sampled",
  "samples",
  "sample",
  "profile",
  "values",
  "stdout",
  "stderr",
  "traceback",
  "mean",
  "std",
  "min",
  "max",
  "sum",
  "count",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: Set<string>,
  where: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(
        `egress envelope violation: unexpected key "${key}" in ${where}`,
      );
    }
  }
}

// Column NAMES are user-approved schema: a column legitimately called
// "count" or "min" must not trip the banned-key scan (R2). The columns
// subtree's own keys are exempt; injected statistics at the card top level
// are still rejected.
const COLUMNS_PATH_RE = /^envelope\.datasets\[\d+\]\.schema_card\.columns$/;

function scanBannedKeys(value: unknown, path: string): void {
  if (isPlainObject(value)) {
    const keyNamesAreSchema = COLUMNS_PATH_RE.test(path);
    for (const [key, child] of Object.entries(value)) {
      if (!keyNamesAreSchema && BANNED_KEYS.has(key)) {
        throw new Error(
          `egress envelope violation: data-derived key "${key}" at ${path}`,
        );
      }
      scanBannedKeys(child, `${path}.${key}`);
    }
  } else if (Array.isArray(value)) {
    value.forEach((child, index) => {
      scanBannedKeys(child, `${path}[${index}]`);
    });
  }
}

/**
 * Machine gate on the exact shape of what leaves the machine in mode S.
 * The gateway runs this on every outbound payload before the provider sees
 * it; the adversarial suite (P01/P02) re-runs it against captured traffic.
 */
export function assertEnvelopeIsModeS(envelope: unknown): void {
  if (!isPlainObject(envelope)) {
    throw new Error("egress envelope violation: envelope must be an object");
  }
  assertExactKeys(envelope, ENVELOPE_KEYS, "envelope");
  if (typeof envelope.system !== "string" || envelope.system.length === 0) {
    throw new Error(
      "egress envelope violation: system must be a non-empty string",
    );
  }
  if (
    typeof envelope.user_goal !== "string" ||
    envelope.user_goal.length === 0
  ) {
    throw new Error(
      "egress envelope violation: user_goal must be a non-empty string",
    );
  }
  if (!Array.isArray(envelope.datasets) || envelope.datasets.length === 0) {
    throw new Error(
      "egress envelope violation: datasets must be a non-empty list",
    );
  }
  for (const [index, dataset] of envelope.datasets.entries()) {
    if (!isPlainObject(dataset)) {
      throw new Error(
        `egress envelope violation: datasets[${index}] must be an object`,
      );
    }
    assertExactKeys(dataset, DATASET_KEYS, `datasets[${index}]`);
    if (typeof dataset.alias !== "string" || typeof dataset.uri !== "string") {
      throw new Error(
        `egress envelope violation: datasets[${index}].alias/uri must be strings`,
      );
    }
    if (dataset.uri !== `dataset://${dataset.alias}`) {
      throw new Error(
        `egress envelope violation: datasets[${index}].uri must be dataset://<alias>`,
      );
    }
    const card = dataset.schema_card;
    if (!isPlainObject(card)) {
      throw new Error(
        `egress envelope violation: datasets[${index}].schema_card must be an object`,
      );
    }
    assertExactKeys(card, CARD_KEYS, `datasets[${index}].schema_card`);
    if (typeof card.grain !== "string" || card.grain.length === 0) {
      throw new Error(
        `egress envelope violation: schema_card.grain must be non-empty`,
      );
    }
    if (
      !isPlainObject(card.columns) ||
      Object.keys(card.columns).length === 0
    ) {
      throw new Error(
        `egress envelope violation: schema_card.columns must be a non-empty mapping`,
      );
    }
    for (const [name, column] of Object.entries(card.columns)) {
      if (!isPlainObject(column)) {
        throw new Error(
          `egress envelope violation: column "${name}" must be an object`,
        );
      }
      assertExactKeys(column, COLUMN_KEYS, `schema_card.columns.${name}`);
      if (
        typeof column.type !== "string" ||
        typeof column.semantics !== "string"
      ) {
        throw new Error(
          `egress envelope violation: column "${name}" type/semantics must be strings`,
        );
      }
    }
  }
  if (envelope.structural_diagnostics !== undefined) {
    if (!Array.isArray(envelope.structural_diagnostics)) {
      throw new Error(
        "egress envelope violation: structural_diagnostics must be a list",
      );
    }
    for (const diagnostic of envelope.structural_diagnostics) {
      if (!isPlainObject(diagnostic)) {
        throw new Error(
          "egress envelope violation: diagnostic must be an object",
        );
      }
      assertExactKeys(diagnostic, DIAGNOSTIC_KEYS, "structural_diagnostics[]");
      if (
        typeof diagnostic.kind !== "string" ||
        !DIAGNOSTIC_KINDS.has(diagnostic.kind) ||
        typeof diagnostic.detail !== "string"
      ) {
        throw new Error(
          "egress envelope violation: diagnostic kind/detail invalid",
        );
      }
    }
  }
  scanBannedKeys(envelope, "envelope");
}
