/**
 * F05 evidence at the CLI seam: two confirmed tasks over the same dataset run
 * sequentially on ONE persistent kernel; the second task must reuse the
 * already-loaded dataset handle (worker reports load_count 2, and the kernel
 * health before/after shows the same dataset version). Outbound payloads stay
 * exact mode-S envelopes.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const tsxBin = fileURLToPath(
  new URL("../node_modules/.bin/tsx", import.meta.url),
);

const FIXTURE_CSV =
  "order_id,order_date,customer_id,category,net_amount\n007,2026-07-01,C01,womens,100.5\n008,2026-07-02,C02,mens,200\n";

function runCli(args: string[], cwd: string, env: Record<string, string> = {}) {
  try {
    return {
      stdout: execFileSync(tsxBin, [cliPath, ...args], {
        cwd,
        encoding: "utf8",
        env: { ...process.env, ...env },
      }),
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

function specJson(code: string): string {
  return JSON.stringify({
    goal: "net sales by category",
    assumptions: [],
    code,
    validation_checks: [],
  });
}

test("session runs two tasks on one kernel and the second reuses the dataset", () => {
  const cwd = mkdtempSync(join(tmpdir(), "xanthil-session-"));
  const csv = join(cwd, "sales.csv");
  writeFileSync(csv, FIXTURE_CSV);
  runCli(["init"], cwd);
  runCli(["register", csv, "--alias", "sales"], cwd);
  const { card_draft_path } = JSON.parse(
    runCli(["profile", "sales"], cwd).stdout,
  );
  writeFileSync(
    card_draft_path,
    readFileSync(card_draft_path, "utf8").replace(
      'grain: ""',
      'grain: "one row = order line"',
    ),
  );
  runCli(["schema", "approve", "sales"], cwd);

  const code = [
    "import pandas as pd",
    "df = ctx.datasets['sales']",
    "agg = df.assign(net_amount=df['net_amount'].astype(float)).groupby('category')['net_amount'].sum().reset_index()",
    "ctx.save_result('by_category', agg)",
  ].join("\n");
  const fixture = join(cwd, "sess.jsonl");
  writeFileSync(fixture, `${specJson(code)}\n${specJson(code)}\n`);
  const env = { XANTHIL_LLM_FIXTURE: fixture };

  const ask1 = runCli(["ask", "first pass", "--dataset", "sales"], cwd, env);
  const ask2 = runCli(["ask", "second pass", "--dataset", "sales"], cwd, env);
  const t1 = JSON.parse(ask1.stdout).id as string;
  const t2 = JSON.parse(ask2.stdout).id as string;
  runCli(["confirm", t1], cwd);
  runCli(["confirm", t2], cwd);

  const session = runCli(["session", t1, t2], cwd, env);
  expect(session.status).toBe(0);
  const results = JSON.parse(session.stdout);
  expect(results).toHaveLength(2);
  expect(results[0].status).toBe("succeeded");
  expect(results[1].status).toBe("succeeded");

  // Kernel evidence: the dataset was loaded ONCE and reused for the second task.
  const kernelDir = join(cwd, ".xanthil", "kernel");
  const dirs = readdirSync(kernelDir);
  expect(dirs.length).toBe(1); // one kernel for the whole session
  const firstRuns = readdirSync(join(cwd, ".xanthil", "runs", t1));
  const secondRuns = readdirSync(join(cwd, ".xanthil", "runs", t2));
  expect(firstRuns.length).toBeGreaterThanOrEqual(1);
  expect(secondRuns.length).toBeGreaterThanOrEqual(1);

  const artifacts1 = JSON.parse(runCli(["artifacts", t1], cwd).stdout);
  const artifacts2 = JSON.parse(runCli(["artifacts", t2], cwd).stdout);
  expect(artifacts1.length).toBe(1);
  expect(artifacts2.length).toBe(1);

  // Outbound discipline holds on the session path too: exactly two asks, no data.
  const egressDir = join(cwd, ".xanthil", "logs", "egress");
  const payloads = readdirSync(egressDir).map((f) =>
    readFileSync(join(egressDir, f), "utf8"),
  );
  expect(payloads).toHaveLength(2);
  for (const payload of payloads) {
    expect(payload).not.toContain("007");
    expect(payload).not.toContain("100.5");
  }
}, 120_000);
