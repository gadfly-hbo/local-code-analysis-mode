import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
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

const GOOD_CODE = [
  "import pandas as pd",
  "df = ctx.datasets['sales']",
  "agg = df.assign(net_amount=df['net_amount'].astype(float)).groupby('category')['net_amount'].sum().reset_index()",
  "ctx.save_result('by_category', agg)",
].join("\n");
const BAD_CODE = GOOD_CODE.replace("df['net_amount']", "df['revenue']");

function specJson(code: string): string {
  return JSON.stringify({
    goal: "net sales by category",
    assumptions: ["net_amount is already net of refunds"],
    code,
    validation_checks: ["category totals reconcile with overall sum"],
  });
}

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

function preparedWorkspace(): { cwd: string; csv: string } {
  const cwd = mkdtempSync(join(tmpdir(), "xanthil-loop-"));
  const csv = join(cwd, "sales.csv");
  writeFileSync(csv, FIXTURE_CSV);
  runCli(["init"], cwd);
  runCli(["register", csv, "--alias", "sales"], cwd);
  const { card_draft_path } = JSON.parse(
    runCli(["profile", "sales"], cwd).stdout,
  );
  const draft = readFileSync(card_draft_path, "utf8").replace(
    'grain: ""',
    'grain: "one row = order line"',
  );
  writeFileSync(card_draft_path, draft);
  runCli(["schema", "approve", "sales"], cwd);
  return { cwd, csv };
}

let fixtureCounter = 0;
function writeFixture(cwd: string, turns: string[]): string {
  fixtureCounter += 1;
  const fixturePath = join(cwd, `fixture-${fixtureCounter}.jsonl`);
  writeFileSync(fixturePath, `${turns.join("\n")}\n`);
  return fixturePath;
}

function egressPayloads(cwd: string): string[] {
  const dir = join(cwd, ".xanthil", "logs", "egress");
  return readdirSync(dir)
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .sort((a, b) => (JSON.parse(a).at < JSON.parse(b).at ? -1 : 1));
}

function taskIdOf(stdout: string): string {
  return (JSON.parse(stdout) as { id: string }).id;
}

test("ask -> confirm -> run produces correct local artifacts end to end", {
  timeout: 30_000,
}, () => {
  const { cwd, csv } = preparedWorkspace();
  const fixture = writeFixture(cwd, [specJson(GOOD_CODE)]);
  const env = { XANTHIL_LLM_FIXTURE: fixture };

  const ask = runCli(
    ["ask", "net sales by category", "--dataset", "sales"],
    cwd,
    env,
  );
  expect(ask.status).toBe(0);
  const taskId = taskIdOf(ask.stdout);
  expect(JSON.parse(ask.stdout).status).toBe("awaiting_confirmation");

  const confirm = runCli(["confirm", taskId], cwd, env);
  expect(JSON.parse(confirm.stdout).status).toBe("ready");

  const run = runCli(["run", taskId], cwd, env);
  expect(run.status).toBe(0);
  expect(JSON.parse(run.stdout).status).toBe("succeeded");

  const artifacts = JSON.parse(runCli(["artifacts", taskId], cwd, env).stdout);
  expect(artifacts).toHaveLength(1);
  expect(artifacts[0].name).toBe("by_category");
  const artifactCsv = readFileSync(String(artifacts[0].path), "utf8");
  expect(artifactCsv.trim()).toBe(
    "category,net_amount\nmens,200.0\nwomens,100.5",
  );

  // Exactly one model call left the machine, and it contains no row data.
  const payloads = egressPayloads(cwd);
  expect(payloads).toHaveLength(1);
  expect(payloads[0]).not.toContain("007");
  expect(payloads[0]).not.toContain("100.5");
  expect(csv.length).toBeGreaterThan(0);
});

test("structural failure triggers one diagnostic fix round, runtime failure does not", {
  timeout: 30_000,
}, () => {
  const { cwd } = preparedWorkspace();

  // Round 1 references a column that is not in the schema; round 2 fixes it.
  const fixFixture = writeFixture(cwd, [
    specJson(BAD_CODE),
    specJson(GOOD_CODE),
  ]);
  const ask1 = runCli(
    ["ask", "net sales by category", "--dataset", "sales"],
    cwd,
    { XANTHIL_LLM_FIXTURE: fixFixture },
  );
  const t1 = taskIdOf(ask1.stdout);
  runCli(["confirm", t1], cwd);
  const run1 = runCli(["run", t1], cwd, { XANTHIL_LLM_FIXTURE: fixFixture });
  expect(JSON.parse(run1.stdout).status).toBe("succeeded");

  const payloads = egressPayloads(cwd);
  expect(payloads).toHaveLength(2);
  const [firstPayload, secondPayload] = payloads;
  if (!firstPayload || !secondPayload) {
    throw new Error("expected two egress payloads");
  }
  const second = JSON.parse(secondPayload);
  expect(second.request.user).toContain("structural_diagnostics");
  expect(second.request.user).toContain("revenue");
  // The diagnostic carries column NAMES from the approved schema, never values.
  expect(second.request.user).not.toContain("007");
  expect(second.request.user).not.toContain("100.5");

  // A pure runtime failure never re-prompts the model.
  const runtimeCode = GOOD_CODE.replace(
    "ctx.save_result('by_category', agg)",
    "raise ValueError('boom: 007')",
  );
  const runtimeFixture = writeFixture(cwd, [specJson(runtimeCode)]);
  const ask2 = runCli(["ask", "boom", "--dataset", "sales"], cwd, {
    XANTHIL_LLM_FIXTURE: runtimeFixture,
  });
  const t2 = taskIdOf(ask2.stdout);
  runCli(["confirm", t2], cwd);
  const run2 = runCli(["run", t2], cwd, {
    XANTHIL_LLM_FIXTURE: runtimeFixture,
  });
  expect(JSON.parse(run2.stdout).status).toBe("failed");
  expect(egressPayloads(cwd)).toHaveLength(3); // 2 from fix loop + 1 initial ask, never more
});

test("unconfirmed tasks refuse to run; input drift fails the task", {
  timeout: 30_000,
}, () => {
  const { cwd, csv } = preparedWorkspace();
  const fixture = writeFixture(cwd, [specJson(GOOD_CODE)]);
  const env = { XANTHIL_LLM_FIXTURE: fixture };

  const ask = runCli(
    ["ask", "net sales by category", "--dataset", "sales"],
    cwd,
    env,
  );
  const taskId = taskIdOf(ask.stdout);
  const early = runCli(["run", taskId], cwd, env);
  expect(early.status).not.toBe(0);
  expect(early.stderr).toContain("confirm");

  runCli(["confirm", taskId], cwd);
  writeFileSync(csv, `${FIXTURE_CSV}009,2026-07-03,C03,womens,10\n`);
  const drifted = runCli(["run", taskId], cwd, env);
  expect(JSON.parse(drifted.stdout).status).toBe("failed");
  expect(JSON.parse(drifted.stdout).error_summary).toContain("drift");
  expect(existsSync(join(cwd, ".xanthil"))).toBe(true);
});
