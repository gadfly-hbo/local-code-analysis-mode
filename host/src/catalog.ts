import { createHash, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { UserError, type Workspace } from "./workspace.ts";

export interface RegisteredDataset {
  dataset_id: string;
  alias: string;
  version: string;
  uri: string;
  changed: boolean;
}

export interface DatasetListing {
  dataset_id: string;
  alias: string;
  uri: string;
  current_version: string;
  versions: number;
  schema_version: string | null;
}

const ALIAS_PATTERN = /^[a-z][a-z0-9_-]*$/;

export function registerDataset(
  ws: Workspace,
  filePath: string,
  alias: string,
): RegisteredDataset {
  if (!ALIAS_PATTERN.test(alias)) {
    throw new UserError(
      `invalid alias "${alias}" — must match ${ALIAS_PATTERN.source} (lowercase, digits, - and _)`,
    );
  }
  const absPath = resolve(filePath);
  let content: Buffer;
  try {
    content = readFileSync(absPath);
  } catch {
    throw new UserError(`cannot read data file: ${filePath}`);
  }
  const version = createHash("sha256").update(content).digest("hex");
  const bytes = statSync(absPath).size;

  const existing = ws.db
    .prepare("SELECT dataset_id, current_version FROM datasets WHERE alias = ?")
    .get(alias) as { dataset_id: string; current_version: string } | undefined;

  let datasetId: string;
  if (existing) {
    datasetId = existing.dataset_id;
    const alreadyRegistered = ws.db
      .prepare(
        "SELECT 1 FROM dataset_versions WHERE dataset_id = ? AND version = ?",
      )
      .get(datasetId, version);
    if (alreadyRegistered) {
      return {
        dataset_id: datasetId,
        alias,
        version,
        uri: `dataset://${alias}`,
        changed: false,
      };
    }
  } else {
    datasetId = `ds_${randomUUID().slice(0, 8)}`;
    ws.db
      .prepare(
        "INSERT INTO datasets (dataset_id, alias, current_version, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(datasetId, alias, version, new Date().toISOString());
  }

  ws.db
    .prepare(
      "INSERT INTO dataset_versions (dataset_id, version, path, bytes, registered_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(datasetId, version, absPath, bytes, new Date().toISOString());
  ws.db
    .prepare("UPDATE datasets SET current_version = ? WHERE dataset_id = ?")
    .run(version, datasetId);

  return {
    dataset_id: datasetId,
    alias,
    version,
    uri: `dataset://${alias}`,
    changed: true,
  };
}

export function listDatasets(ws: Workspace): DatasetListing[] {
  const datasets = ws.db
    .prepare(
      "SELECT dataset_id, alias, current_version FROM datasets ORDER BY alias",
    )
    .all() as { dataset_id: string; alias: string; current_version: string }[];

  return datasets.map((row) => {
    const versions = ws.db
      .prepare(
        "SELECT COUNT(*) AS n FROM dataset_versions WHERE dataset_id = ?",
      )
      .get(row.dataset_id) as { n: number };
    const current = ws.db
      .prepare(
        "SELECT schema_version FROM dataset_versions WHERE dataset_id = ? AND version = ?",
      )
      .get(row.dataset_id, row.current_version) as
      | { schema_version: string | null }
      | undefined;
    return {
      dataset_id: row.dataset_id,
      alias: row.alias,
      uri: `dataset://${row.alias}`,
      current_version: row.current_version,
      versions: versions.n,
      schema_version: current?.schema_version ?? null,
    };
  });
}

export function getDatasetByAlias(
  ws: Workspace,
  alias: string,
): DatasetListing {
  const listing = listDatasets(ws).find((d) => d.alias === alias);
  if (!listing) {
    throw new UserError(`unknown dataset alias "${alias}"`);
  }
  return listing;
}
