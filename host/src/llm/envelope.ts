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
Reply with EXACTLY ONE JSON object and NOTHING else — no markdown, no reasoning text, no code fences, no extra keys, no alternative solutions.
The object must have EXACTLY these four keys and this shape (example):
{"goal": "net sales by category", "assumptions": ["net = gross - refund"], "code": "import pandas as pd\ndf = ctx.datasets['sales']\nout = df.groupby('category')['net'].sum().reset_index()\nctx.save_result('result', out)", "validation_checks": ["parts sum equals total"]}
The code field is Python that uses ONLY the provided ctx object (ctx.datasets["<alias>"] -> pandas DataFrame of strings) and the allowed libraries ${ALLOWED_LIBRARIES.join(", ")}.
Save any result table with ctx.save_result("<name>", df). Numeric columns arrive as strings — cast with .astype(float) before arithmetic.`;

export const MODE_A_SYSTEM = `You are Xanthil's analysis interpreter operating in privacy mode A (authorized aggregate interpretation).
Along with approved table structures you receive ONE publication: aggregate metrics the user explicitly authorized for release, recomputed from a verified data version. Groups below the subject threshold were suppressed.
Interpret ONLY the published numbers. Do not claim to have read rows, samples, or anything not in the publication. Distinguish arithmetic decomposition from causal claims, and state what further evidence would be needed for causal conclusions.
Output plain text interpretation grounded in the published values.`;

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
  "checks", // F02 machine-check block: column names + integer only (H10)
]);
const CHECKS_KEYS = new Set(["date_fields", "amount_fields", "precision"]);
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
    if (card.checks !== undefined) {
      if (!isPlainObject(card.checks)) {
        throw new Error(
          "egress envelope violation: schema_card.checks must be an object",
        );
      }
      assertExactKeys(card.checks, CHECKS_KEYS, "schema_card.checks");
      for (const listKey of ["date_fields", "amount_fields"]) {
        const list = (card.checks as Record<string, unknown>)[listKey];
        if (!Array.isArray(list) || list.some((f) => typeof f !== "string")) {
          throw new Error(
            `egress envelope violation: checks.${listKey} must be column-name strings`,
          );
        }
      }
      const precision = (card.checks as Record<string, unknown>).precision;
      if (
        typeof precision !== "number" ||
        !Number.isInteger(precision) ||
        precision < 0 ||
        precision > 6
      ) {
        throw new Error(
          "egress envelope violation: checks.precision must be an integer 0-6",
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

// ---------------------------------------------------------------------------
// Mode A envelope (§4.2/§6.7/§10.4): mode S content + ONE authorized
// publication block + the approval reference. Structurally free of any
// free-text slot beyond the approved schema cards and purpose (P06).
// ---------------------------------------------------------------------------

export interface ModeAEnvelope {
  system: string;
  user_goal: string;
  datasets: EnvelopeDataset[];
  allowed_libraries: string[];
  publication: {
    plan_digest: string;
    subject_field: string;
    min_subjects: number;
    precision: number;
    group_count: number;
    suppressed_group_count: number;
    data_versions: Record<string, string>;
    generated_at: string;
    metrics: {
      name: string;
      rows: { dimensions: Record<string, string>; value: number }[];
    }[];
  };
  authorization: { approval_id: string; payload_sha256: string };
}

export const MODE_A_KEYS = new Set([
  "system",
  "user_goal",
  "datasets",
  "allowed_libraries",
  "publication",
  "authorization",
]);
const PUBLICATION_KEYS = new Set([
  "plan_digest",
  "subject_field",
  "min_subjects",
  "precision",
  "group_count",
  "suppressed_group_count",
  "data_versions",
  "generated_at",
  "metrics",
]);
const METRIC_KEYS = new Set(["name", "rows"]);
const ROW_KEYS = new Set(["dimensions", "value"]);
const AUTH_KEYS = new Set(["approval_id", "payload_sha256"]);

function assertHex64(value: unknown, where: string): void {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(
      `egress envelope violation: ${where} must be a sha256 hex string`,
    );
  }
}

function assertBoundedString(value: unknown, where: string, max: number): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > max ||
    value.includes("\n")
  ) {
    throw new Error(
      `egress envelope violation: ${where} must be a non-empty string <= ${max} chars without newlines`,
    );
  }
}

export function assertEnvelopeIsModeA(envelope: unknown): void {
  if (!isPlainObject(envelope)) {
    throw new Error("mode-A envelope violation: envelope must be an object");
  }
  assertExactKeys(envelope, MODE_A_KEYS, "mode-A envelope");
  // R9: the mode-S subtree (system/goal/datasets/libraries) gets the FULL
  // mode-S validation — an empty dataset list no longer passes.
  assertEnvelopeIsModeS({
    system: envelope.system,
    user_goal: envelope.user_goal,
    datasets: envelope.datasets,
    allowed_libraries: envelope.allowed_libraries,
  });
  const publication = envelope.publication;
  if (!isPlainObject(publication)) {
    throw new Error("mode-A envelope violation: publication must be an object");
  }
  assertExactKeys(publication, PUBLICATION_KEYS, "publication");
  assertHex64(publication.plan_digest, "publication.plan_digest");
  assertBoundedString(
    publication.subject_field,
    "publication.subject_field",
    64,
  );
  for (const key of [
    "min_subjects",
    "precision",
    "group_count",
    "suppressed_group_count",
  ]) {
    if (typeof publication[key] !== "number") {
      throw new Error(
        `mode-A envelope violation: publication.${key} must be a number`,
      );
    }
  }
  if (
    !isPlainObject(publication.data_versions) ||
    Object.entries(publication.data_versions).some(
      ([k, v]) => typeof k !== "string" || !/^[0-9a-f]{64}$/.test(String(v)),
    )
  ) {
    throw new Error(
      "mode-A envelope violation: publication.data_versions must map alias -> sha256",
    );
  }
  assertBoundedString(publication.generated_at, "publication.generated_at", 40);
  if (!Array.isArray(publication.metrics) || publication.metrics.length === 0) {
    throw new Error(
      "mode-A envelope violation: publication.metrics must be a non-empty list",
    );
  }
  for (const [i, metric] of publication.metrics.entries()) {
    if (!isPlainObject(metric)) {
      throw new Error(
        `mode-A envelope violation: metrics[${i}] must be an object`,
      );
    }
    assertExactKeys(metric, METRIC_KEYS, `metrics[${i}]`);
    assertBoundedString(metric.name, `metrics[${i}].name`, 64);
    if (!Array.isArray(metric.rows)) {
      throw new Error(
        `mode-A envelope violation: metrics[${i}].rows must be a list`,
      );
    }
    for (const [j, row] of metric.rows.entries()) {
      if (!isPlainObject(row)) {
        throw new Error(
          `mode-A envelope violation: metrics[${i}].rows[${j}] must be an object`,
        );
      }
      assertExactKeys(row, ROW_KEYS, `metrics[${i}].rows[${j}]`);
      if (!isPlainObject(row.dimensions)) {
        throw new Error(
          `mode-A envelope violation: rows[${j}].dimensions must be an object`,
        );
      }
      for (const [dimKey, dimValue] of Object.entries(row.dimensions)) {
        assertBoundedString(dimKey, `rows[${j}].dimensions key`, 128);
        assertBoundedString(dimValue, `rows[${j}].dimensions["${dimKey}"]`, 64);
      }
      if (typeof row.value !== "number" || !Number.isFinite(row.value)) {
        throw new Error(
          `mode-A envelope violation: rows[${j}].value must be a finite number`,
        );
      }
    }
  }
  const auth = envelope.authorization;
  if (!isPlainObject(auth)) {
    throw new Error(
      "mode-A envelope violation: authorization must be an object",
    );
  }
  assertExactKeys(auth, AUTH_KEYS, "authorization");
  assertBoundedString(auth.approval_id, "authorization.approval_id", 64);
  assertHex64(auth.payload_sha256, "authorization.payload_sha256");
}
