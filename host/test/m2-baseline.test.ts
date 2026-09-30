/** M2 slice 0: baseline extensions — task cancel, card `checks`, shared mpl cache, publications migration. */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { parseAndValidateCard } from "../src/schema.ts";
import { initWorkspace, openWorkspace } from "../src/workspace.ts";

const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const tsxBin = fileURLToPath(
  new URL("../node_modules/.bin/tsx", import.meta.url),
);

const CARD_YAML = `dataset: sales
grain: "one row = order line"
columns:
  order_id:
    type: string
    semantics: ""
  order_date:
    type: string
    semantics: ""
  net_amount:
    type: number
    semantics: ""
unique_keys: []
notes: []
`;

function runCli(args: string[], cwd: string, env: Record<string, string> = {}) {
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

test("cancel moves unstarted tasks to cancelled and refuses terminal states", () => {
  const cwd = mkdtempSync(join(tmpdir(), "xanthil-cancel-"));
  runCli(["init"], cwd);
  const tasks = JSON.parse(runCli(["tasks"], cwd).stdout) as [];
  expect(tasks).toHaveLength(0);

  // Cancel an unknown task fails cleanly.
  expect(runCli(["cancel", "task_nope"], cwd).status).not.toBe(0);

  // Build a real awaiting task via the fixture pipeline.
  const csv = join(cwd, "s.csv");
  writeFileSync(csv, "order_id,net_amount\n007,100\n");
  runCli(["register", csv, "--alias", "sales"], cwd);
  const { card_draft_path } = JSON.parse(
    runCli(["profile", "sales"], cwd).stdout,
  );
  writeFileSync(
    card_draft_path,
    readFileSync(card_draft_path, "utf8").replace('grain: ""', 'grain: "line"'),
  );
  runCli(["schema", "approve", "sales"], cwd);
  const fixture = join(cwd, "f.jsonl");
  const spec = JSON.stringify({
    goal: "g",
    assumptions: [],
    code: "pass",
    validation_checks: [],
  });
  writeFileSync(fixture, `${spec}\n`);
  const ask = runCli(["ask", "g", "--dataset", "sales"], cwd, {
    XANTHIL_LLM_FIXTURE: fixture,
  });
  const id = JSON.parse(ask.stdout).id as string;

  const cancel = runCli(["cancel", id], cwd);
  expect(cancel.status).toBe(0);
  expect(JSON.parse(cancel.stdout).status).toBe("cancelled");
  // Cancelling twice (terminal state) refuses.
  expect(runCli(["cancel", id], cwd).status).not.toBe(0);
});

test("schema card accepts an optional checks block and rejects malformed ones", () => {
  const good = parseAndValidateCard(
    CARD_YAML.replace(
      "notes: []\n",
      "notes: []\nchecks:\n  date_fields:\n    - order_date\n  amount_fields:\n    - net_amount\n  precision: 2\n",
    ),
    "sales",
  );
  expect(good.checks?.date_fields).toEqual(["order_date"]);
  expect(good.checks?.precision).toBe(2);

  // checks referencing unknown columns is a schema-level shape error here
  expect(() =>
    parseAndValidateCard(
      CARD_YAML.replace(
        "notes: []\n",
        "notes: []\nchecks:\n  date_fields:\n    - ghost\n  amount_fields: []\n  precision: 2\n",
      ),
      "sales",
    ),
  ).toThrow(/ghost/);

  expect(() =>
    parseAndValidateCard(
      CARD_YAML.replace(
        "notes: []\n",
        "notes: []\nchecks:\n  date_fields: []\n  amount_fields: []\n  precision: 9\n",
      ),
      "sales",
    ),
  ).toThrow(/precision/);
});

test("publications and approvals tables exist after workspace open", () => {
  const root = mkdtempSync(join(tmpdir(), "xanthil-pubmig-"));
  initWorkspace(root);
  const ws = openWorkspace(root);
  const tables = ws.db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all() as { name: string }[];
  const names = tables.map((t) => t.name);
  expect(names).toContain("publications");
  expect(names).toContain("approvals");
});

test("workspace init creates the shared mpl cache dir", () => {
  const cwd = mkdtempSync(join(tmpdir(), "xanthil-mpl-"));
  runCli(["init"], cwd);
  expect(existsSync(join(cwd, ".xanthil", "tmp-mpl"))).toBe(true);
});

test("F02: checks date_fields must be date-like per the local profile", () => {
  const cwd = mkdtempSync(join(tmpdir(), "xanthil-f02-"));
  const csv = join(cwd, "s.csv");
  writeFileSync(
    csv,
    "order_id,order_date,category,net_amount\n007,2026-07-01,womens,100.5\n008,2026-07-02,mens,200\n",
  );
  runCli(["init"], cwd);
  runCli(["register", csv, "--alias", "sales"], cwd);
  const { card_draft_path, profile } = JSON.parse(
    runCli(["profile", "sales"], cwd).stdout,
  );
  const orderDate = (
    profile.columns as { name: string; date_like: boolean }[]
  ).find((c) => c.name === "order_date");
  expect(orderDate?.date_like).toBe(true);

  const good = readFileSync(card_draft_path, "utf8")
    .replace('grain: ""', 'grain: "line"')
    .replace(
      "notes: []\n",
      "notes: []\nchecks:\n  date_fields:\n    - order_date\n  amount_fields:\n    - net_amount\n  precision: 2\n",
    );
  writeFileSync(card_draft_path, good);
  const approve = runCli(["schema", "approve", "sales"], cwd);
  expect(approve.status).toBe(0);

  // Non-date column as date_field is rejected by the machine check.
  const bad = good.replace("- order_date", "- category");
  writeFileSync(card_draft_path, bad);
  const rejected = runCli(["schema", "approve", "sales"], cwd);
  expect(rejected.status).not.toBe(0);
  expect(rejected.stderr).toContain("not date-like");
});
