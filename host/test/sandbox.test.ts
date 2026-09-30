import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const tsxBin = fileURLToPath(
  new URL("../node_modules/.bin/tsx", import.meta.url),
);
const SEATBELT = "/usr/bin/sandbox-exec";

const FIXTURE_CSV =
  "order_id,order_date,customer_id,category,net_amount\n007,2026-07-01,C01,womens,100.5\n008,2026-07-02,C02,mens,200\n";

function runCli(
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
): { stdout: string; stderr: string; status: number } {
  try {
    return {
      stdout: execFileSync(tsxBin, [cliPath, ...args], {
        cwd,
        encoding: "utf8",
        env: { ...process.env, ...env },
      }),
      stderr: "",
      status: 0,
    };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; status?: number };
    return {
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
      status: err.status ?? 1,
    };
  }
}

function preparedWorkspace(): string {
  const cwd = mkdtempSync(join(tmpdir(), "xanthil-sandbox-"));
  const csv = join(cwd, "sales.csv");
  writeFileSync(csv, FIXTURE_CSV);
  runCli(["init"], cwd);
  runCli(["register", csv, "--alias", "sales"], cwd);
  return cwd;
}

test.skipIf(!existsSync(SEATBELT))(
  "sandbox check blocks network, reads and writes outside scope",
  () => {
    const cwd = preparedWorkspace();
    const result = runCli(["sandbox", "check"], cwd);

    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.backend).toBe("seatbelt-darwin");
    expect(report.network_blocked).toBe(true);
    expect(report.read_blocked).toBe(true);
    expect(report.write_blocked).toBe(true);
    expect(report.system_read_blocked).toBe(true); // R1: system temp area unreadable
    expect(report.passed).toBe(true);

    const persisted = JSON.parse(
      readFileSync(join(cwd, ".xanthil", "sandbox-check.json"), "utf8"),
    );
    expect(persisted.passed).toBe(true);
  },
);

test.skipIf(!existsSync(SEATBELT))(
  "profile execution runs under the isolation backend",
  () => {
    const cwd = preparedWorkspace();
    const result = runCli(["profile", "sales"], cwd);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).profile.row_count).toBe(2);
  },
);

test("missing sandbox-exec binary fails closed", () => {
  const cwd = preparedWorkspace();
  const result = runCli(["profile", "sales"], cwd, {
    XANTHIL_SANDBOX_EXEC: "/nonexistent/sandbox-exec",
  });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("isolation");
});
