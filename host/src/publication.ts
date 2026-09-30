import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { runWorkerModule } from "./profiler.ts";
import { getApprovedCard } from "./schema.ts";
import { UserError, type Workspace } from "./workspace.ts";

/** Mode-A trusted publication (proposal §4.2/§6.7/§10/§11.3). */

export interface PublicationMetric {
  name: string;
  agg: "sum" | "count" | "count_distinct" | "avg";
  field: string;
}

export interface PublicationPlan {
  purpose: string;
  datasets: string[];
  target_model: string;
  subject_field: string;
  min_subjects: number;
  max_sends: number;
  expires_hours: number;
  precision: number;
  metrics: PublicationMetric[];
  dimensions: string[];
  filters: Record<string, unknown>[];
}

export interface PublicationRow {
  id: string;
  at: string;
  purpose: string;
  plan_digest: string;
  status: string;
  payload_sha256: string | null;
  block_reason: string | null;
  datasets: string[];
  data_versions: Record<string, string>;
}

const AGGS = new Set(["sum", "count", "count_distinct", "avg"]);
const MAX_RESULT_ROWS = 200;

/** Deterministic JSON (sorted keys, recursively) — P08 guard against key-order drift. */
export function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) {
      return v.map(sort);
    }
    if (v !== null && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([k, val]) => [k, sort(val)]),
      );
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function emitPlanDraft(alias: string, columns: string[]): string {
  const columnList = columns.join(", ");
  return `# Mode-A publication plan (trusted aggregation release).
# The trusted publisher recomputes these metrics from the registered data —
# model-generated code is never involved. Dimension values WILL be visible to
# the model once you approve; review the preview before approving.
dataset: ${alias}
purpose: "interpret month-over-month net sales change"
target_model: "glm-4.x"          # must match XANTHIL_LLM_MODEL at send time
subject_field: customer_id       # independent subject for min-group suppression
min_subjects: 5                  # groups below this subject count are dropped
max_sends: 3                     # hard cap on sends per approval (1-10)
expires_hours: 24                # approval lifetime (1-168)
precision: 2                     # numeric rounding (0-6)
metrics:
  - {name: net_sales, agg: sum, field: net_amount}
  - {name: orders, agg: count_distinct, field: order_id}
dimensions:
  - category                     # plain card column, or month(<date column>)
filters: []                      # e.g. {field: category, op: in, values: [womens, mens]}
# available columns: ${columnList}
`;
}

export function parsePublicationPlan(
  ws: Workspace,
  rawYaml: string,
): PublicationPlan {
  let parsed: unknown;
  try {
    parsed = YAML.parse(rawYaml);
  } catch (error) {
    throw new UserError(`publication plan is not valid YAML: ${String(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new UserError("publication plan must be a YAML mapping");
  }
  const plan = parsed as Record<string, unknown>;

  const requireString = (key: string): string => {
    const value = plan[key];
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new UserError(
        `publication plan "${key}" must be a non-empty string`,
      );
    }
    return value;
  };
  const requireInt = (
    key: string,
    min: number,
    max: number,
    fallback?: number,
  ): number => {
    if (!(key in plan)) {
      if (fallback === undefined) {
        throw new UserError(`publication plan is missing "${key}"`);
      }
      return fallback;
    }
    const value = plan[key];
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < min ||
      value > max
    ) {
      throw new UserError(
        `publication plan "${key}" must be an integer ${min}-${max}`,
      );
    }
    return value;
  };

  const purpose = requireString("purpose");
  const dataset = requireString("dataset");
  const targetModel = requireString("target_model");
  const subjectField = requireString("subject_field");

  const { card } = getApprovedCard(ws, dataset); // throws if no approved card
  const columns = Object.keys(card.columns);
  const inCard = (field: string): boolean => columns.includes(field);

  if (!inCard(subjectField)) {
    throw new UserError(
      `subject_field "${subjectField}" is not a column of "${dataset}"`,
    );
  }

  const metricsRaw = plan.metrics;
  if (!Array.isArray(metricsRaw) || metricsRaw.length === 0) {
    throw new UserError('publication plan "metrics" must be a non-empty list');
  }
  const metrics: PublicationMetric[] = metricsRaw.map((m, i) => {
    const metric = m as Record<string, unknown>;
    if (
      typeof metric.name !== "string" ||
      typeof metric.field !== "string" ||
      typeof metric.agg !== "string" ||
      !AGGS.has(metric.agg)
    ) {
      throw new UserError(
        `metrics[${i}] must be {name, agg: sum|count|count_distinct|avg, field}`,
      );
    }
    if (!inCard(metric.field)) {
      throw new UserError(
        `metrics[${i}].field "${metric.field}" is not a column of "${dataset}"`,
      );
    }
    return {
      name: metric.name,
      agg: metric.agg as PublicationMetric["agg"],
      field: metric.field,
    };
  });

  const dimsRaw = plan.dimensions;
  if (
    !Array.isArray(dimsRaw) ||
    dimsRaw.length === 0 ||
    dimsRaw.some((d) => typeof d !== "string")
  ) {
    throw new UserError(
      'publication plan "dimensions" must be a non-empty list of strings',
    );
  }
  for (const dim of dimsRaw as string[]) {
    const plain = dim.includes("(") ? dim.slice(dim.indexOf("(") + 1, -1) : dim;
    if (!inCard(plain)) {
      throw new UserError(
        `dimension "${dim}" references unknown column "${plain}"`,
      );
    }
  }

  const filters = Array.isArray(plan.filters)
    ? (plan.filters as Record<string, unknown>[])
    : [];
  for (const filter of filters) {
    if (typeof filter.field !== "string" || !inCard(filter.field)) {
      throw new UserError(
        `filter references unknown column "${String(filter.field)}"`,
      );
    }
  }

  const precisionFallback = card.checks?.precision ?? 2;
  return {
    purpose,
    datasets: [dataset],
    target_model: targetModel,
    subject_field: subjectField,
    min_subjects: requireInt("min_subjects", 1, 1_000_000, 5),
    max_sends: requireInt("max_sends", 1, 10, 3),
    expires_hours: requireInt("expires_hours", 1, 168, 24),
    precision: requireInt("precision", 0, 6, precisionFallback),
    metrics,
    dimensions: dimsRaw as string[],
    filters,
  };
}

interface WorkerReply {
  ok: boolean;
  result?: Record<string, unknown>;
  error?: { kind: string; detail?: string };
}

/** Validate + recompute via the trusted publisher; persist the publication. */
export function preparePublication(
  ws: Workspace,
  planPath: string,
): PublicationRow {
  let raw: string;
  try {
    raw = readFileSync(planPath, "utf8");
  } catch {
    throw new UserError(`cannot read publication plan: ${planPath}`);
  }
  const plan = parsePublicationPlan(ws, raw);
  const alias = plan.datasets[0] as string;
  const planJson = canonicalJson(plan);
  const planDigest = sha256Hex(planJson);
  const id = `pub_${randomUUID().slice(0, 12)}`;
  const at = new Date().toISOString();

  const versionRow = ws.db
    .prepare(
      `SELECT dv.path, dv.version FROM datasets d
       JOIN dataset_versions dv ON dv.dataset_id = d.dataset_id AND dv.version = d.current_version
       WHERE d.alias = ?`,
    )
    .get(alias) as { path: string; version: string } | undefined;
  if (!versionRow) {
    throw new UserError(`unknown dataset alias "${alias}"`);
  }
  const dataVersions: Record<string, string> = { [alias]: versionRow.version };

  const insertPublication = (
    status: string,
    payload: string | null,
    blockReason: string | null,
  ): PublicationRow => {
    // payload is ALREADY the canonical JSON string — digest it directly so
    // sha256(canonical(parsed preview)) reproduces it exactly (P08 binding).
    const payloadSha = payload === null ? null : sha256Hex(payload);
    ws.db
      .prepare(
        "INSERT INTO publications (id, at, purpose, plan_digest, plan_json, status, payload_json, payload_sha256, block_reason, data_versions, datasets) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        at,
        plan.purpose,
        planDigest,
        planJson,
        status,
        payload,
        payloadSha,
        blockReason,
        JSON.stringify(dataVersions),
        JSON.stringify(plan.datasets),
      );
    return {
      id,
      at,
      purpose: plan.purpose,
      plan_digest: planDigest,
      status,
      payload_sha256: payloadSha,
      block_reason: blockReason,
      datasets: plan.datasets,
      data_versions: dataVersions,
    };
  };

  let reply: WorkerReply;
  const runDir = join(ws.root, "publications", id);
  mkdirSync(runDir, { recursive: true });
  try {
    reply = runWorkerModule<WorkerReply>(
      ws,
      "worker.publish",
      {
        datasets: {
          [alias]: { path: versionRow.path, version: versionRow.version },
        },
        plan,
      },
      [versionRow.path],
      runDir,
    );
  } catch (error) {
    // §11.4: a blocked publication never fails the local analysis.
    return insertPublication(
      "blocked",
      null,
      `trusted publisher failed: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`,
    );
  }

  if (!reply.ok || !reply.result) {
    const detail = reply.error?.detail ?? reply.error?.kind ?? "unknown";
    return insertPublication(
      "blocked",
      null,
      `${reply.error?.kind ?? "invalid_plan"}: ${detail}`,
    );
  }

  // R2: prepare-stage policy checks (PRD: BEFORE the preview is trusted).
  // N2: bound the free-text-ish fields the envelope will carry, so an
  // over-long metric name can never waste an approval on an unsendable payload.
  const bounded = (value: unknown, max: number): boolean =>
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= max &&
    !value.includes("\n");
  if (!bounded(reply.result.subject_field, 64) || !bounded(plan.purpose, 500)) {
    return insertPublication(
      "blocked",
      null,
      "subject_field/purpose violates publish bounds",
    );
  }
  const metrics =
    (reply.result.metrics as {
      name?: unknown;
      rows: { dimensions: Record<string, string> }[];
    }[]) ?? [];
  for (const metric of metrics) {
    if (!bounded(metric.name, 64)) {
      return insertPublication(
        "blocked",
        null,
        "metric name violates publish bounds (<=64 chars, no newlines)",
      );
    }
  }
  const totalRows = metrics.reduce((sum, m) => sum + m.rows.length, 0);
  if (totalRows > MAX_RESULT_ROWS) {
    return insertPublication(
      "blocked",
      null,
      `result has ${totalRows} rows across metrics (max ${MAX_RESULT_ROWS})`,
    );
  }
  for (const metric of metrics) {
    for (const row of metric.rows) {
      for (const [dimKey, dimValue] of Object.entries(row.dimensions)) {
        const value = String(dimValue);
        if (
          dimKey.length > 128 ||
          value.length === 0 ||
          value.length > 64 ||
          value.includes("\n")
        ) {
          return insertPublication(
            "blocked",
            null,
            `dimension "${dimKey}" has a value violating the publish bounds (<=64 chars, no newlines)`,
          );
        }
      }
    }
  }

  const payloadJson = canonicalJson(reply.result);
  writeFileSync(
    join(runDir, "preview.json"),
    `${JSON.stringify(reply.result, null, 2)}\n`,
  );
  return insertPublication("prepared", payloadJson, null);
}

function decodePublicationRow(
  row: PublicationRow & {
    data_versions?: string | Record<string, string>;
    datasets?: string | string[];
  },
): PublicationRow {
  const raw = row.data_versions;
  return {
    ...row,
    data_versions:
      typeof raw === "string"
        ? (JSON.parse(raw) as Record<string, string>)
        : (raw ?? {}),
    // N5: keep the CLI output shape consistent (array, not a JSON string).
    datasets:
      typeof row.datasets === "string"
        ? (JSON.parse(row.datasets) as string[])
        : (row.datasets ?? []),
  };
}

export function listPublications(ws: Workspace): PublicationRow[] {
  const rows = ws.db
    .prepare(
      "SELECT id, at, purpose, plan_digest, status, payload_sha256, block_reason, data_versions, datasets FROM publications ORDER BY at",
    )
    .all() as unknown as (PublicationRow & { data_versions: string })[];
  return rows.map((row) => decodePublicationRow(row));
}

export function getPublication(ws: Workspace, id: string): PublicationRow {
  const row = ws.db
    .prepare(
      "SELECT id, at, purpose, plan_digest, status, payload_sha256, block_reason, data_versions, datasets FROM publications WHERE id = ?",
    )
    .get(id) as (PublicationRow & { data_versions: string }) | undefined;
  if (!row) {
    throw new UserError(`unknown publication "${id}"`);
  }
  return decodePublicationRow(row);
}

export function getPublicationPayload(ws: Workspace, id: string): string {
  const row = ws.db
    .prepare("SELECT payload_json FROM publications WHERE id = ?")
    .get(id) as { payload_json: string } | undefined;
  if (!row?.payload_json) {
    throw new UserError(
      `publication "${id}" has no payload (status not prepared)`,
    );
  }
  return row.payload_json;
}

export function getPublicationPlan(ws: Workspace, id: string): PublicationPlan {
  const row = ws.db
    .prepare("SELECT plan_json FROM publications WHERE id = ?")
    .get(id) as { plan_json: string } | undefined;
  if (!row) {
    throw new UserError(`unknown publication "${id}"`);
  }
  return JSON.parse(row.plan_json) as PublicationPlan;
}

// ---------------------------------------------------------------------------
// Approval lifecycle (§10.4/§11.3): bind, verify-at-send, revoke, cap.
// ---------------------------------------------------------------------------

export interface ApprovalRow {
  id: string;
  publication_id: string;
  approved_at: string;
  payload_sha256: string;
  plan_digest: string;
  data_versions: Record<string, string>;
  target_model: string;
  max_sends: number;
  sent_count: number;
  expires_at: string;
  revoked_at: string | null;
}

export function approvePublication(
  ws: Workspace,
  publicationId: string,
): ApprovalRow {
  const pub = getPublication(ws, publicationId);
  if (
    (pub.status !== "prepared" && pub.status !== "awaiting_approval") ||
    !pub.payload_sha256
  ) {
    throw new UserError(
      `publication ${publicationId} is "${pub.status}" — only prepared (or awaiting_approval, for re-approval) publications can be approved`,
    );
  }
  const plan = getPublicationPlan(ws, publicationId);
  // R1 (P10): single-active-approval invariant — a new approval implicitly
  // revokes every still-active approval for this publication, so no stale
  // approval can ever survive to authorize sends (defense beyond the CLI's
  // revoke-all and send's latest-approval selection).
  ws.db
    .prepare(
      "UPDATE approvals SET revoked_at = ? WHERE publication_id = ? AND revoked_at IS NULL",
    )
    .run(new Date().toISOString(), publicationId);
  const id = `appr_${randomUUID().slice(0, 12)}`;
  const approvedAt = new Date();
  const expiresAt = new Date(
    approvedAt.getTime() + plan.expires_hours * 3600_000,
  );
  ws.db
    .prepare(
      "INSERT INTO approvals (id, publication_id, approved_at, payload_sha256, plan_digest, data_versions, target_model, max_sends, sent_count, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL)",
    )
    .run(
      id,
      publicationId,
      approvedAt.toISOString(),
      pub.payload_sha256,
      pub.plan_digest,
      JSON.stringify(pub.data_versions), // pub.data_versions is a parsed object here
      plan.target_model,
      plan.max_sends,
      expiresAt.toISOString(),
    );
  ws.db
    .prepare(
      "UPDATE publications SET status = 'awaiting_approval' WHERE id = ?",
    )
    .run(publicationId);
  return getApproval(ws, id);
}

export function getApproval(ws: Workspace, id: string): ApprovalRow {
  const row = ws.db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as
    | (Omit<ApprovalRow, "data_versions"> & { data_versions: string })
    | undefined;
  if (!row) {
    throw new UserError(`unknown approval "${id}"`);
  }
  return { ...row, data_versions: JSON.parse(row.data_versions) };
}

export function revokeApproval(ws: Workspace, id: string): void {
  const approval = getApproval(ws, id);
  ws.db
    .prepare("UPDATE approvals SET revoked_at = ? WHERE id = ?")
    .run(new Date().toISOString(), approval.id);
}

function markPublicationBlocked(
  ws: Workspace,
  id: string,
  reason: string,
  status = "blocked",
): void {
  ws.db
    .prepare(
      "UPDATE publications SET status = ?, block_reason = ? WHERE id = ?",
    )
    .run(status, reason, id);
}

/** Recompute via the trusted publisher; returns the canonical payload JSON. */
function recomputePayload(
  ws: Workspace,
  publicationId: string,
): { canonical: string; result: Record<string, unknown> } {
  const plan = getPublicationPlan(ws, publicationId);
  const alias = plan.datasets[0] as string;
  const versionRow = ws.db
    .prepare(
      `SELECT dv.path, dv.version FROM datasets d
       JOIN dataset_versions dv ON dv.dataset_id = d.dataset_id AND dv.version = d.current_version
       WHERE d.alias = ?`,
    )
    .get(alias) as { path: string; version: string } | undefined;
  if (!versionRow) {
    throw new UserError(`dataset "${alias}" no longer registered`);
  }
  const runDir = join(ws.root, "publications", `${publicationId}.resend`);
  mkdirSync(runDir, { recursive: true });
  const reply = runWorkerModule<{
    ok: boolean;
    result?: Record<string, unknown>;
    error?: { kind: string; detail?: string };
  }>(
    ws,
    "worker.publish",
    {
      datasets: {
        [alias]: { path: versionRow.path, version: versionRow.version },
      },
      plan,
    },
    [versionRow.path],
    runDir,
  );
  if (!reply.ok || !reply.result) {
    throw new UserError(
      `recompute failed: ${reply.error?.kind ?? "unknown"}: ${reply.error?.detail ?? ""}`,
    );
  }
  return { canonical: canonicalJson(reply.result), result: reply.result };
}

/** Model identity for authorization binding: fixture | <model id>. */
function modelIdentityOf(caller: import("./llm/types.ts").ModelCaller): string {
  return caller.name === "fixture"
    ? "fixture"
    : caller.name.replace(/^pi:/, "");
}

function currentTargetModel(): string {
  if (process.env.XANTHIL_LLM_FIXTURE) {
    return "fixture";
  }
  return process.env.XANTHIL_LLM_MODEL ?? "";
}

/** Send an approved publication through the mode-A egress path (P06/P08/P10). */
export async function sendPublication(
  ws: Workspace,
  publicationId: string,
  injectedCaller?: import("./llm/types.ts").ModelCaller,
): Promise<{ status: string; reply?: string; block_reason?: string }> {
  const pub = getPublication(ws, publicationId);
  if (
    pub.status !== "prepared" &&
    pub.status !== "awaiting_approval" &&
    pub.status !== "sent"
  ) {
    throw new UserError(`publication ${publicationId} is "${pub.status}"`);
  }
  const approval = ws.db
    .prepare(
      "SELECT * FROM approvals WHERE publication_id = ? AND revoked_at IS NULL ORDER BY approved_at DESC",
    )
    .get(publicationId) as
    | (Omit<ApprovalRow, "data_versions"> & { data_versions: string })
    | undefined;
  if (!approval) {
    throw new UserError(
      `no active approval for ${publicationId} — run "xanthil publish approve ${publicationId}"`,
    );
  }
  const appr = {
    ...approval,
    data_versions: JSON.parse(approval.data_versions),
  };

  const block = (reason: string, status = "blocked") => {
    markPublicationBlocked(ws, publicationId, reason, status);
    return { status, block_reason: reason };
  };

  // P08: authorization binding — every vector re-checked at send time.
  if (new Date() >= new Date(appr.expires_at)) {
    return block("approval expired", "expired");
  }
  if (appr.sent_count >= appr.max_sends) {
    return block(`max_sends (${appr.max_sends}) reached`);
  }
  const currentModel = injectedCaller
    ? modelIdentityOf(injectedCaller)
    : currentTargetModel();
  if (!currentModel || currentModel !== appr.target_model) {
    return block(
      `target model mismatch: approval binds "${appr.target_model}", current endpoint is "${currentModel || "unset"}"`,
    );
  }
  for (const [alias, version] of Object.entries(appr.data_versions)) {
    const row = ws.db
      .prepare(
        `SELECT dv.path, dv.version FROM datasets d
         JOIN dataset_versions dv ON dv.dataset_id = d.dataset_id AND dv.version = d.current_version
         WHERE d.alias = ?`,
      )
      .get(alias) as { path: string; version: string } | undefined;
    if (!row || row.version !== version) {
      return block(`data version drift for "${alias}" since approval`);
    }
    // R12: hash the FILE itself — silent edits that preserve the catalog row
    // must still invalidate the approval. A missing/unreadable file is an
    // elegant block (§11.4), never a bare crash (N1).
    let actual: string;
    try {
      actual = createHash("sha256")
        .update(readFileSync(row.path))
        .digest("hex");
    } catch {
      return block(
        `data file for "${alias}" is unreadable (moved or deleted since approval)`,
      );
    }
    if (actual !== version) {
      return block(
        `data file for "${alias}" no longer matches the bound version`,
      );
    }
  }

  // P06/P08 core: recompute NOW and compare digests before anything leaves.
  // R13: a recompute crash is a graceful block (§11.4), never a bare throw.
  let recomputed: { canonical: string; result: Record<string, unknown> };
  try {
    recomputed = recomputePayload(ws, publicationId);
  } catch (error) {
    return block(
      `recompute at send time failed: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`,
    );
  }
  const recomputedSha = sha256Hex(recomputed.canonical);
  if (recomputedSha !== appr.payload_sha256) {
    return block(
      "recomputed payload does not match the approved digest (data or template drifted)",
    );
  }
  const pubResult = recomputed.result as {
    subject_field: string;
    min_subjects: number;
    precision: number;
    group_count: number;
    suppressed_group_count: number;
    metrics: {
      name: string;
      rows: { dimensions: Record<string, string>; value: number }[];
    }[];
  };

  const plan = getPublicationPlan(ws, publicationId);
  const alias = plan.datasets[0] as string;
  const { card } = getApprovedCard(ws, alias);
  const { createEgressGateway } = await import("./llm/egress.ts");
  const { MODE_A_SYSTEM } = await import("./llm/envelope.ts");
  // Caller is constructed only AFTER every authorization check passed: a
  // blocked send must never depend on provider availability (§11.4).
  const { createCallerFromEnv } = await import("./llm/index.ts");
  const gateway = createEgressGateway(
    ws,
    injectedCaller ?? createCallerFromEnv(),
  );

  const envelope = {
    system: MODE_A_SYSTEM,
    user_goal: plan.purpose,
    datasets: [{ alias, uri: `dataset://${alias}`, schema_card: card }],
    allowed_libraries: ["pandas", "duckdb", "matplotlib"],
    publication: {
      plan_digest: pub.plan_digest,
      subject_field: pubResult.subject_field,
      min_subjects: pubResult.min_subjects,
      precision: pubResult.precision,
      group_count: pubResult.group_count,
      suppressed_group_count: pubResult.suppressed_group_count,
      data_versions: pub.data_versions,
      generated_at: new Date().toISOString(),
      metrics: pubResult.metrics,
    },
    authorization: {
      approval_id: appr.id,
      payload_sha256: appr.payload_sha256,
    },
  };

  const { text } = await gateway.completeModeA(envelope);
  ws.db
    .prepare("UPDATE approvals SET sent_count = sent_count + 1 WHERE id = ?")
    .run(appr.id);
  ws.db
    .prepare(
      "UPDATE publications SET status = 'sent', block_reason = NULL WHERE id = ?",
    )
    .run(publicationId);
  return { status: "sent", reply: text };
}
