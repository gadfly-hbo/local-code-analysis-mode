/**
 * Adversarial privacy suite — the M0 exit evidence (P01/P02/P03/P09 mechanism).
 *
 * Strategy: every row of the synthetic CSV carries a high-entropy canary.
 * Fixture-driven model responses include deliberately hostile code (print the
 * frame, smuggle a cell value into a KeyError). After the full pipeline runs,
 * EVERY outbound payload must be exactly the approved mode-S envelope — no
 * canary anywhere — while the SAME canary must be present in local artifacts
 * and run logs, proving the two channels are physically separate.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { assertEnvelopeIsModeS } from "../src/llm/envelope.ts";

const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const tsxBin = fileURLToPath(
  new URL("../node_modules/.bin/tsx", import.meta.url),
);

const CANARY_A = "CNRY9f8e7d6c5b4a";
const CANARY_B = "CNRY2a1b3c4d5e6f";
// Column names are approved schema (model MAY see them); values may NOT.
const CANARY_CSV =
  `order_id,order_date,customer_id,category,net_amount\n` +
  `${CANARY_A},2026-07-01,C01,womens,100.5\n` +
  `${CANARY_B},2026-07-02,C02,mens,200\n`;

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
  const cwd = mkdtempSync(join(tmpdir(), "xanthil-privacy-"));
  const csv = join(cwd, "sales.csv");
  writeFileSync(csv, CANARY_CSV);
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
  return cwd;
}

function specJson(code: string): string {
  return JSON.stringify({
    goal: "net sales by category",
    assumptions: ["net_amount is net of refunds"],
    code,
    validation_checks: ["totals reconcile"],
  });
}

function egressRecords(cwd: string): Record<string, unknown>[] {
  const dir = join(cwd, ".xanthil", "logs", "egress");
  return readdirSync(dir)
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .sort((a, b) => (JSON.parse(a).at < JSON.parse(b).at ? -1 : 1))
    .map((raw) => JSON.parse(raw) as Record<string, unknown>);
}

/** G14: stronger than canary scanning — every outbound payload must be exactly the mode-S envelope. */
function assertAllPayloadsAreExactEnvelopes(
  cwd: string,
): Record<string, unknown>[] {
  const records = egressRecords(cwd);
  for (const record of records) {
    const request = record.request as { system: string; user: string };
    const user = JSON.parse(request.user);
    const envelope = { system: request.system, ...user };
    expect(
      () => assertEnvelopeIsModeS(envelope),
      `payload ${String(record.id)}`,
    ).not.toThrow();
  }
  return records;
}

test("P01: successful analysis never sends canary values, artifacts keep them locally", {
  timeout: 30_000,
}, () => {
  const cwd = preparedWorkspace();
  const goodCode = [
    "import pandas as pd",
    "df = ctx.datasets['sales']",
    "agg = df.assign(net_amount=df['net_amount'].astype(float)).groupby('category')['net_amount'].sum().reset_index()",
    "ctx.save_result('by_category', agg)",
    "print(df)",
  ].join("\n");
  const fixture = join(cwd, "good.jsonl");
  writeFileSync(fixture, `${specJson(goodCode)}\n`);
  const env = { XANTHIL_LLM_FIXTURE: fixture };

  const ask = runCli(
    ["ask", "net sales by category", "--dataset", "sales"],
    cwd,
    env,
  );
  const taskId = (JSON.parse(ask.stdout) as { id: string }).id;
  runCli(["confirm", taskId], cwd);
  const run = runCli(["run", taskId], cwd, env);
  expect(JSON.parse(run.stdout).status).toBe("succeeded");

  const records = assertAllPayloadsAreExactEnvelopes(cwd);
  expect(records.length).toBeGreaterThanOrEqual(1);
  for (const record of records) {
    const payload = JSON.stringify(record);
    expect(
      payload.includes(CANARY_A),
      `canary A leaked in ${String(record.id)}`,
    ).toBe(false);
    expect(
      payload.includes(CANARY_B),
      `canary B leaked in ${String(record.id)}`,
    ).toBe(false);
  }

  // The canary lives in LOCAL artifacts and run logs (channel separation).
  const artifactCsv = JSON.parse(runCli(["artifacts", taskId], cwd).stdout)[0]
    .path as string;
  expect(readFileSync(artifactCsv, "utf8")).not.toContain(CANARY_A); // aggregation dropped ids — also local-only anyway
  const runLog = readdirSync(join(cwd, ".xanthil", "runs", taskId), {
    recursive: true,
  })
    .map((f) => String(f))
    .filter((f) => f.endsWith("run.log"))[0];
  const logPath = join(cwd, ".xanthil", "runs", taskId, runLog ?? "");
  expect(readFileSync(logPath, "utf8")).toContain(CANARY_A); // print(df) stayed local
});

test("P02: a KeyError carrying a cell value must not smuggle it into diagnostics", {
  timeout: 30_000,
}, () => {
  const cwd = preparedWorkspace();
  const hostileCode = [
    "import pandas as pd",
    "df = ctx.datasets['sales']",
    "leaked = str(df['order_id'].iloc[0])",
    "raise KeyError(leaked)",
  ].join("\n");
  const fixture = join(cwd, "hostile.jsonl");
  writeFileSync(fixture, `${specJson(hostileCode)}\n`);
  const env = { XANTHIL_LLM_FIXTURE: fixture };

  const ask = runCli(["ask", "hostile", "--dataset", "sales"], cwd, env);
  const taskId = (JSON.parse(ask.stdout) as { id: string }).id;
  runCli(["confirm", taskId], cwd);
  const run = runCli(["run", taskId], cwd, env);
  expect(JSON.parse(run.stdout).status).toBe("failed");

  const records = assertAllPayloadsAreExactEnvelopes(cwd);
  for (const record of records) {
    const payload = JSON.stringify(record);
    expect(
      payload.includes(CANARY_A),
      `canary A leaked in ${String(record.id)}`,
    ).toBe(false);
    expect(
      payload.includes(CANARY_B),
      `canary B leaked in ${String(record.id)}`,
    ).toBe(false);
  }
});

test("P03: chart artifacts are local files, never referenced in outbound payloads", {
  timeout: 60_000,
}, () => {
  const cwd = preparedWorkspace();
  const chartCode = [
    "import matplotlib",
    "matplotlib.use('Agg')",
    "import pandas as pd",
    "df = ctx.datasets['sales']",
    "import matplotlib.pyplot as plt",
    "fig, ax = plt.subplots()",
    "ax.bar(['womens','mens'], [1,2])",
    "ctx.save_chart('totals', fig)",
  ].join("\n");
  const fixture = join(cwd, "chart.jsonl");
  writeFileSync(fixture, `${specJson(chartCode)}\n`);
  const env = { XANTHIL_LLM_FIXTURE: fixture };

  const ask = runCli(["ask", "chart it", "--dataset", "sales"], cwd, env);
  const taskId = (JSON.parse(ask.stdout) as { id: string }).id;
  runCli(["confirm", taskId], cwd);
  const run = runCli(["run", taskId], cwd, env);
  expect(JSON.parse(run.stdout).status).toBe("succeeded");

  const artifacts = JSON.parse(runCli(["artifacts", taskId], cwd).stdout);
  expect(artifacts[0].type).toBe("chart");
  expect(readFileSync(String(artifacts[0].path)).length).toBeGreaterThan(100);

  const records = assertAllPayloadsAreExactEnvelopes(cwd);
  for (const record of records) {
    expect(JSON.stringify(record)).not.toContain(".png");
    expect(JSON.stringify(record)).not.toContain("artifacts");
  }
});
