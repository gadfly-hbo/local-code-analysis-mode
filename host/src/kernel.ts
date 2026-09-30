import { type ChildProcess, spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { workerPython } from "./config.ts";
import {
  buildSeatbeltProfile,
  isolationBackendName,
  seatbeltBin,
  workerSitePackages,
} from "./isolation.ts";
import { UserError, type Workspace } from "./workspace.ts";

/**
 * Persistent analysis kernel (M1): a sandboxed worker daemon speaking
 * NDJSON over stdio. Dataset handles and the `session` namespace survive
 * across execute calls within the kernel's lifetime (F05). Scope is fixed
 * at start: the datasets registered at that moment; new registrations
 * require a new kernel.
 */
export class KernelManager {
  private child: ChildProcess | null = null;
  private nextId = 0;
  private buffer = "";
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  readonly kernelDir: string;
  readonly scopedDatasets: Set<string>;

  constructor(
    private readonly ws: Workspace,
    scopedDatasets: string[],
    private readonly runRoots: string[] = [],
  ) {
    this.kernelDir = join(
      ws.root,
      "kernel",
      `kernel_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    );
    this.scopedDatasets = new Set(scopedDatasets);
  }

  start(): void {
    if (isolationBackendName() === null) {
      throw new UserError(
        "no isolation backend available — kernel start refused",
      );
    }
    mkdirSync(this.kernelDir, { recursive: true });
    const allowedReads = [...this.scopedDatasets].map((alias) => {
      const row = this.ws.db
        .prepare(
          `SELECT dv.path FROM datasets d
           JOIN dataset_versions dv ON dv.dataset_id = d.dataset_id AND dv.version = d.current_version
           WHERE d.alias = ?`,
        )
        .get(alias) as { path: string } | undefined;
      if (!row) {
        throw new UserError(`kernel scope includes unknown dataset "${alias}"`);
      }
      return row.path;
    });

    // R4: writes are scoped to the kernel dir plus ONLY the participating
    // tasks' run roots — not the whole workspace runs tree.
    const sharedMpl = join(this.ws.root, "tmp-mpl");
    mkdirSync(sharedMpl, { recursive: true });
    const profile = buildSeatbeltProfile(allowedReads, this.kernelDir, [
      ...this.runRoots.map((root) => join(this.ws.root, "runs", root)),
      sharedMpl,
    ]);
    const env: Record<string, string | undefined> = {
      ...process.env,
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      PYTHONDONTWRITEBYTECODE: "1",
      MPLCONFIGDIR: join(this.ws.root, "tmp-mpl"),
      TMPDIR: join(this.kernelDir, "tmp"),
      PYTHONPATH: workerSitePackages(),
    };
    delete env.XANTHIL_SANDBOX_EXEC;
    mkdirSync(join(this.kernelDir, "tmp"), { recursive: true });

    this.child = spawn(
      seatbeltBin(),
      ["-p", profile, "--", workerPython(), "-m", "worker.kernel"],
      { env, stdio: ["pipe", "pipe", "pipe"], cwd: this.kernelDir },
    );
    this.child.stdout?.setEncoding("utf8");
    this.child.stdout?.on("data", (chunk: string) => this.onStdout(chunk));
    this.child.stderr?.on("data", (chunk: Buffer) => {
      appendFileSync(join(this.kernelDir, "kernel-stderr.log"), chunk);
    });
    this.child.on("exit", () => {
      for (const pending of this.pending.values()) {
        pending.reject(new UserError("kernel exited unexpectedly"));
      }
      this.pending.clear();
      this.child = null;
    });
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf("\n");
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line.length > 0) {
        try {
          const response = JSON.parse(line) as {
            id: number | null;
            ok: boolean;
            result?: unknown;
            error?: unknown;
          };
          const id = response.id ?? undefined;
          const waiter = id !== undefined ? this.pending.get(id) : undefined;
          if (waiter && id !== undefined) {
            this.pending.delete(id);
            if (response.ok) {
              waiter.resolve(response.result);
            } else {
              waiter.reject(
                new UserError(
                  `kernel error: ${JSON.stringify(response.error)}`,
                ),
              );
            }
          }
        } catch {
          // Non-protocol output from generated code leaked to stdout — ignore.
        }
      }
      index = this.buffer.indexOf("\n");
    }
  }

  private call<T>(
    method: string,
    params: unknown,
    timeoutMs: number,
  ): Promise<T> {
    const child = this.child;
    if (!child?.stdin) {
      throw new UserError("kernel is not running");
    }
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new UserError(`kernel call ${method} timed out after ${timeoutMs}ms`),
        );
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value as T);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      child.stdin?.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  health(): Promise<{
    pid: number;
    datasets: Record<string, { version: string; load_count: number }>;
    session_keys: string[];
  }> {
    return this.call("health", {}, 10_000);
  }

  execute(input: {
    code: string;
    datasets: Record<string, { path: string; version: string }>;
    runDir: string;
  }): Promise<{
    status: "succeeded" | "failed";
    artifacts: { name: string; type: string; path: string }[];
    error: { kind: string; detail?: string } | null;
    dataset_loads: Record<string, number>;
  }> {
    return this.call("execute", { ...input, run_dir: input.runDir }, 120_000);
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) {
      return;
    }
    child.stdin?.end();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 3_000);
      child.on("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.child = null;
  }

  get running(): boolean {
    return this.child !== null;
  }
}
