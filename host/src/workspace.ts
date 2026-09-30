import { existsSync, mkdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const WORKSPACE_DIRNAME = ".xanthil";

export interface Workspace {
  root: string;
  db: DatabaseSync;
}

export class UserError extends Error {}

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS datasets (
    dataset_id TEXT PRIMARY KEY,
    alias TEXT NOT NULL UNIQUE,
    current_version TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS dataset_versions (
    dataset_id TEXT NOT NULL,
    version TEXT NOT NULL,
    path TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    registered_at TEXT NOT NULL,
    schema_version TEXT,
    PRIMARY KEY (dataset_id, version)
  )`,
  `CREATE TABLE IF NOT EXISTS schema_cards (
    dataset_id TEXT NOT NULL,
    schema_version TEXT NOT NULL,
    card_json TEXT NOT NULL,
    approved_at TEXT NOT NULL,
    PRIMARY KEY (dataset_id, schema_version)
  )`,
];

export function resolveWorkspacePath(
  explicit?: string,
  cwd = process.cwd(),
): string {
  return explicit ? resolve(cwd, explicit) : join(cwd, WORKSPACE_DIRNAME);
}

export function initWorkspace(wsPath: string): { created: boolean } {
  const dbFile = join(wsPath, "db.sqlite");
  const created = !existsSync(dbFile);
  for (const rel of ["datasets", "artifacts", "runs", "logs/egress"]) {
    mkdirSync(join(wsPath, rel), { recursive: true });
  }
  const db = new DatabaseSync(dbFile);
  try {
    for (const migration of MIGRATIONS) {
      db.exec(migration);
    }
  } finally {
    db.close();
  }
  return { created };
}

export function openWorkspace(wsPath: string): Workspace {
  const dbFile = join(wsPath, "db.sqlite");
  if (!existsSync(dbFile)) {
    throw new UserError(
      `no workspace found at ${wsPath} — run "xanthil init" first`,
    );
  }
  const db = new DatabaseSync(dbFile);
  for (const migration of MIGRATIONS) {
    db.exec(migration);
  }
  return { root: wsPath, db };
}

export { isAbsolute };
