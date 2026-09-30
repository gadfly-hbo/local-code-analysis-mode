import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import YAML from "yaml";
import type { SchemaCard } from "./profiler.ts";
import { UserError, type Workspace } from "./workspace.ts";

const ALLOWED_TYPES = new Set([
  "string",
  "integer",
  "number",
  "boolean",
  "date",
]);
const CARD_KEYS = ["dataset", "grain", "columns", "unique_keys", "notes"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseAndValidateCard(
  rawYaml: string,
  expectedAlias: string,
): SchemaCard {
  let parsed: unknown;
  try {
    parsed = YAML.parse(rawYaml);
  } catch (error) {
    throw new UserError(`schema card is not valid YAML: ${String(error)}`);
  }
  if (!isRecord(parsed)) {
    throw new UserError("schema card must be a YAML mapping");
  }
  for (const key of Object.keys(parsed)) {
    if (!CARD_KEYS.includes(key)) {
      throw new UserError(`schema card has unknown key "${key}"`);
    }
  }
  for (const key of CARD_KEYS) {
    if (!(key in parsed)) {
      throw new UserError(`schema card is missing required key "${key}"`);
    }
  }
  if (parsed.dataset !== expectedAlias) {
    throw new UserError(
      `schema card dataset "${String(parsed.dataset)}" does not match alias "${expectedAlias}"`,
    );
  }
  if (typeof parsed.grain !== "string" || parsed.grain.trim().length === 0) {
    throw new UserError(
      'schema card "grain" must be a non-empty string (what one row represents)',
    );
  }
  if (!isRecord(parsed.columns) || Object.keys(parsed.columns).length === 0) {
    throw new UserError(
      'schema card "columns" must be a non-empty mapping of column -> {type, semantics}',
    );
  }
  for (const [name, col] of Object.entries(parsed.columns)) {
    if (!isRecord(col)) {
      throw new UserError(
        `column "${name}" must be a mapping with type/semantics`,
      );
    }
    if (typeof col.type !== "string" || !ALLOWED_TYPES.has(col.type)) {
      throw new UserError(
        `column "${name}" has invalid type "${String(col.type)}" (allowed: ${[...ALLOWED_TYPES].join(", ")})`,
      );
    }
    if (col.semantics !== undefined && typeof col.semantics !== "string") {
      throw new UserError(`column "${name}" semantics must be a string`);
    }
  }
  if (
    !Array.isArray(parsed.unique_keys) ||
    parsed.unique_keys.some((k) => typeof k !== "string")
  ) {
    throw new UserError(
      'schema card "unique_keys" must be a list of column names',
    );
  }
  if (
    !Array.isArray(parsed.notes) ||
    parsed.notes.some((n) => typeof n !== "string")
  ) {
    throw new UserError('schema card "notes" must be a list of strings');
  }
  return parsed as unknown as SchemaCard;
}

function canonicalCardJson(card: SchemaCard): string {
  const columns: Record<string, { type: string; semantics: string }> = {};
  for (const name of Object.keys(card.columns).sort()) {
    const col = card.columns[name];
    if (!col) {
      continue;
    }
    columns[name] = { type: col.type, semantics: col.semantics ?? "" };
  }
  return JSON.stringify({
    dataset: card.dataset,
    grain: card.grain,
    columns,
    unique_keys: [...card.unique_keys].sort(),
    notes: [...card.notes],
  });
}

export function approveSchemaCard(
  ws: Workspace,
  alias: string,
  cardPath: string,
): { schema_version: string } {
  let raw: string;
  try {
    raw = readFileSync(cardPath, "utf8");
  } catch {
    throw new UserError(`cannot read schema card draft: ${cardPath}`);
  }
  const card = parseAndValidateCard(raw, alias);

  const dataset = ws.db
    .prepare("SELECT dataset_id, current_version FROM datasets WHERE alias = ?")
    .get(alias) as { dataset_id: string; current_version: string } | undefined;
  if (!dataset) {
    throw new UserError(`unknown dataset alias "${alias}"`);
  }

  const cardJson = canonicalCardJson(card);
  const schemaVersion = `sch_${createHash("sha256").update(cardJson).digest("hex").slice(0, 8)}`;

  ws.db
    .prepare(
      "INSERT OR REPLACE INTO schema_cards (dataset_id, schema_version, card_json, approved_at) VALUES (?, ?, ?, ?)",
    )
    .run(dataset.dataset_id, schemaVersion, cardJson, new Date().toISOString());
  ws.db
    .prepare(
      "UPDATE dataset_versions SET schema_version = ? WHERE dataset_id = ? AND version = ?",
    )
    .run(schemaVersion, dataset.dataset_id, dataset.current_version);

  return { schema_version: schemaVersion };
}

export function getApprovedCard(
  ws: Workspace,
  alias: string,
): { schema_version: string; card: SchemaCard } {
  const row = ws.db
    .prepare(
      `SELECT sc.schema_version, sc.card_json FROM datasets d
       JOIN schema_cards sc ON sc.dataset_id = d.dataset_id
       JOIN dataset_versions dv ON dv.dataset_id = d.dataset_id AND dv.version = d.current_version
        AND dv.schema_version = sc.schema_version
       WHERE d.alias = ?`,
    )
    .get(alias) as { schema_version: string; card_json: string } | undefined;
  if (!row) {
    throw new UserError(
      `no approved schema card for "${alias}" — run "xanthil profile ${alias}" then "xanthil schema approve ${alias}"`,
    );
  }
  return {
    schema_version: row.schema_version,
    card: JSON.parse(row.card_json) as SchemaCard,
  };
}
