import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { UserError } from "./workspace.ts";

const hostDir = fileURLToPath(new URL("..", import.meta.url));

export function workerDir(): string {
  return process.env.XANTHIL_WORKER_DIR
    ? resolve(process.env.XANTHIL_WORKER_DIR)
    : join(hostDir, "..", "worker");
}

export function workerPython(): string {
  const python = join(workerDir(), ".venv", "bin", "python");
  if (!existsSync(python)) {
    throw new UserError(
      `worker python not found at ${python} — run "uv sync" inside the worker directory`,
    );
  }
  return python;
}
