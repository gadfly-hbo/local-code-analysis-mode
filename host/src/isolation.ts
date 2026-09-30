import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { workerDir, workerPython } from "./config.ts";
import { UserError } from "./workspace.ts";

export interface IsolationSpec {
  command: string;
  args: string[];
  allowedReads: string[];
  writableDir: string;
  extraWritableDirs?: string[];
  input?: string;
  timeoutMs?: number;
}

export interface IsolationResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface SandboxCheckReport {
  backend: string;
  at: string;
  network_blocked: boolean;
  read_blocked: boolean;
  write_blocked: boolean;
  system_read_blocked: boolean;
  passed: boolean;
}

export const SEATBELT_BACKEND = "seatbelt-darwin";

export function seatbeltBin(): string {
  return process.env.XANTHIL_SANDBOX_EXEC ?? "/usr/bin/sandbox-exec";
}

export function isolationBackendName(): string | null {
  if (process.platform === "darwin" && existsSync(seatbeltBin())) {
    return SEATBELT_BACKEND;
  }
  return null;
}

/**
 * Paths under /Users that must stay readable: the uv-managed interpreter tree
 * (its libpython dylib lives next to bin/), the worker venv (site-packages),
 * the worker package itself, and the registered input files.
 */
function homeReadExceptions(): string[] {
  const exceptions = new Set<string>();
  try {
    const realPython = realpathSync(workerPython());
    exceptions.add(dirname(dirname(realPython))); // <cpython-*/>/bin/python -> <cpyton-*/> tree incl. lib/
  } catch {
    // fall through: workerPython() reports its own error when the venv is missing
  }
  try {
    exceptions.add(realpathSync(join(workerDir(), ".venv")));
    exceptions.add(realpathSync(workerDir()));
  } catch {
    // worker venv not created yet
  }
  return [...exceptions];
}

/**
 * Targeted-deny seatbelt profile (R1 hardening). Full read enumeration breaks
 * `python -m` (silent SIGABRT in runpy under this macOS seatbelt), so instead
 * of enumerating allows we keep the runtime working and DENY the two sensitive
 * read scopes, re-allowing only explicit exceptions after each deny
 * (SBPL: later matching rule wins):
 *   1. /Users  — the user's home (exceptions: interpreter tree, venv, worker,
 *      registered inputs, run dirs);
 *   2. /private/var/folders — the system temp area where OTHER processes keep
 *      files (exceptions: this run's own workspace paths, realpath'd).
 * Writes: only the run dirs. Network: denied.
 */
export function buildSeatbeltProfile(
  allowedReads: string[],
  writableDir: string,
  extraWritableDirs: string[] = [],
): string {
  // Seatbelt matches canonical paths: /tmp is a symlink to /private/tmp on
  // macOS, so every scope must be realpath'd or the allow silently misses.
  const real = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  const readExceptions = [
    ...new Set(
      [
        ...homeReadExceptions(),
        writableDir,
        ...extraWritableDirs,
        ...allowedReads,
      ].map(real),
    ),
  ]
    .map((p) => `(subpath "${p}")`)
    .join(" ");
  const writeSubpaths = [writableDir, ...extraWritableDirs, "/dev/null"]
    .map((p) => `(subpath "${real(p)}")`)
    .join(" ");
  return `(version 1)
  (allow default)
  (deny network*)
  (deny file-write*)
  (allow file-write* ${writeSubpaths})
  (deny file-read-data (subpath "/Users"))
  (allow file-read-data ${readExceptions})
  (deny file-read-data (subpath "/private/var/folders"))
  (allow file-read-data ${readExceptions})
`;
}

/** Site-packages of the worker venv (requires-python pinned to 3.12). */
export function workerSitePackages(): string {
  const venvRoot = join(workerDir(), ".venv");
  return join(venvRoot, "lib", "python3.12", "site-packages");
}

/** Execute a command inside the platform isolation backend. Fails closed. */
export function runIsolated(spec: IsolationSpec): IsolationResult {
  const backend = isolationBackendName();
  if (backend === null) {
    throw new UserError(
      `no verified isolation backend on this platform (expected ${SEATBELT_BACKEND} at ${seatbeltBin()}); ` +
        "refusing to execute worker code without isolation",
    );
  }

  mkdirSync(join(spec.writableDir, "tmp"), { recursive: true });
  const extraWritable = spec.extraWritableDirs ?? [];
  const profile = buildSeatbeltProfile(
    spec.allowedReads,
    spec.writableDir,
    extraWritable,
  );
  writeFileSync(join(spec.writableDir, "sandbox-profile.sb"), profile);
  const env: Record<string, string | undefined> = {
    ...process.env,
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    PYTHONDONTWRITEBYTECODE: "1",
    // Shared workspace font cache first (built once), run-local tmp as fallback.
    MPLCONFIGDIR: extraWritable[0] ?? join(spec.writableDir, "tmp"),
    TMPDIR: join(spec.writableDir, "tmp"),
    // sandbox-exec resolves the venv python symlink to the bare interpreter,
    // losing venv activation; force site-packages onto sys.path explicitly.
    PYTHONPATH: workerSitePackages(),
  };
  // §8.2: model credentials must NEVER enter the worker environment — strip
  // every XANTHIL_LLM_* key regardless of how the caller was configured.
  for (const key of Object.keys(env)) {
    if (key.startsWith("XANTHIL_LLM_")) {
      delete env[key];
    }
  }
  delete env.XANTHIL_SANDBOX_EXEC;

  const result = spawnSync(
    seatbeltBin(),
    ["-p", profile, "--", spec.command, ...spec.args],
    {
      input: spec.input,
      encoding: "utf8",
      timeout: spec.timeoutMs ?? 120_000,
      env,
      // Keep sys.path[0] ('' = cwd) inside the sandbox-readable run dir.
      cwd: spec.writableDir,
    },
  );
  if (result.error) {
    throw new UserError(
      `isolation backend failed to start: $String(result.error)`,
    );
  }
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/** Escape self-check: probe read/write/network from inside the sandbox. */
export function runSandboxSelfCheck(): SandboxCheckReport {
  const backend = isolationBackendName();
  if (backend === null) {
    throw new UserError(
      `no isolation backend available for the self-check (expected ${SEATBELT_BACKEND} at ${seatbeltBin()})`,
    );
  }
  // Probes live OUTSIDE the allowed read scope: under HOME (denied except
  // explicit exceptions) and in the SYSTEM TEMP area (denied by the
  // enumerated-read profile — R1). Writes outside the run dir are denied.
  const probeDir = mkdtempSync(join(homedir(), "xanthil-sbprobe-"));
  const systemProbeDir = mkdtempSync(join(tmpdir(), "xanthil-sbsys-"));
  const runDir = mkdtempSync(join(tmpdir(), "xanthil-sbrun-"));
  const readProbe = join(probeDir, "read-probe.txt");
  const writeProbe = join(probeDir, "write-probe.txt");
  const systemReadProbe = join(systemProbeDir, "sys-read-probe.txt");
  writeFileSync(readProbe, "PROBE-outside-scope");
  writeFileSync(systemReadProbe, "PROBE-system-temp");

  const result = runIsolated({
    command: workerPython(),
    args: ["-m", "worker.sandbox_check"],
    allowedReads: [], // probes must stay OUTSIDE the allowed read scope
    writableDir: runDir,
    input: JSON.stringify({
      read_probe: readProbe,
      write_probe: writeProbe,
      system_read_probe: systemReadProbe,
    }),
    timeoutMs: 30_000,
  });
  if (result.status !== 0) {
    throw new UserError(
      `sandbox self-check worker failed: $result.stderr.slice(0, 2000)`,
    );
  }
  const lines = result.stdout.split("\n").filter((l) => l.trim().length > 0);
  const last = lines.at(-1);
  if (!last) {
    throw new UserError("sandbox self-check returned no report");
  }
  const raw = JSON.parse(last) as Omit<SandboxCheckReport, "backend" | "at">;
  return {
    backend,
    at: new Date().toISOString(),
    network_blocked: raw.network_blocked,
    read_blocked: raw.read_blocked,
    write_blocked: raw.write_blocked,
    system_read_blocked: raw.system_read_blocked,
    passed:
      raw.network_blocked &&
      raw.read_blocked &&
      raw.write_blocked &&
      raw.system_read_blocked,
  };
}
