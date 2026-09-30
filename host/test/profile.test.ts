import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
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

function runCli(
  args: string[],
  cwd: string,
): { stdout: string; stderr: string; status: number } {
  try {
    return {
      stdout: execFileSync(tsxBin, [cliPath, ...args], {
        cwd,
        encoding: "utf8",
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
  const cwd = mkdtempSync(join(tmpdir(), "xanthil-profile-"));
  const csv = join(cwd, "sales.csv");
  writeFileSync(csv, FIXTURE_CSV);
  runCli(["init"], cwd);
  runCli(["register", csv, "--alias", "sales"], cwd);
  return cwd;
}

test("profile produces a local profile and a stats-free schema card draft", () => {
  const cwd = preparedWorkspace();
  const out = JSON.parse(runCli(["profile", "sales"], cwd).stdout);

  expect(out.profile.row_count).toBe(2);
  expect(out.profile.is_sampled).toBe(false);
  expect(out.card_draft_path).toBe(
    join(realpathSync(cwd), ".xanthil", "datasets", "sales.schema.yaml"),
  );

  const draft = readFileSync(out.card_draft_path, "utf8");
  // Structural privacy assertion: the model-visible card carries no statistics.
  for (const banned of ["row_count", "null_count", "distinct", "is_sampled"]) {
    expect(draft.includes(banned), banned).toBe(false);
  }
  expect(draft).toContain("order_id");
  expect(existsSync(join(cwd, ".xanthil", "profiles", "sales.json"))).toBe(
    true,
  );
});

test("leading-zero id column stays string in the draft", () => {
  const cwd = preparedWorkspace();
  const out = JSON.parse(runCli(["profile", "sales"], cwd).stdout);
  const draft = readFileSync(out.card_draft_path, "utf8");
  expect(draft).toMatch(/order_id:[\s\S]{0,40}type: string/);
});

test("approve stores the card and bumps the schema version", () => {
  const cwd = preparedWorkspace();
  const { card_draft_path: draftPath } = JSON.parse(
    runCli(["profile", "sales"], cwd).stdout,
  );

  const edited = readFileSync(draftPath, "utf8").replace(
    'grain: ""',
    'grain: "one row = order line"',
  );
  writeFileSync(draftPath, edited);

  const approve = runCli(["schema", "approve", "sales"], cwd);
  expect(approve.status).toBe(0);
  expect(JSON.parse(approve.stdout).schema_version).toMatch(/^sch_/);

  const listing = JSON.parse(runCli(["datasets"], cwd).stdout);
  expect(listing[0]?.schema_version).toMatch(/^sch_/);
});

test("approve rejects a card without grain", () => {
  const cwd = preparedWorkspace();
  runCli(["profile", "sales"], cwd);
  const approve = runCli(["schema", "approve", "sales"], cwd);
  expect(approve.status).not.toBe(0);
  expect(approve.stderr).toContain("grain");
});
