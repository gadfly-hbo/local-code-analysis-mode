/** F01: xlsx and parquet run the FULL mode-S chain with CSV-parity results. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const tsxBin = fileURLToPath(
  new URL("../node_modules/.bin/tsx", import.meta.url),
);
const workerDir = fileURLToPath(new URL("../../worker", import.meta.url));

const ANALYSIS = [
  "import pandas as pd",
  "df = ctx.datasets['sales']",
  "agg = df.assign(net_amount=df['net_amount'].astype(float)).groupby('category')['net_amount'].sum().reset_index()",
  "ctx.save_result('by_category', agg)",
].join("\n");

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

function makeXlsx(path: string) {
  execFileSync(join(workerDir, ".venv", "bin", "python"), [
    "-c",
    `from openpyxl import Workbook
b = Workbook(); s = b.active
for row in [("order_id","category","net_amount"),("007","womens",100.5),("008","mens",200)]:
    s.append(row)
b.save("${path}")`,
  ]);
}

function makeParquet(path: string) {
  execFileSync(join(workerDir, ".venv", "bin", "python"), [
    "-c",
    `import duckdb
duckdb.sql("COPY (SELECT * FROM (VALUES ('007','womens',100.5),('008','mens',200)) AS t(order_id,category,net_amount)) TO '${path}' (FORMAT PARQUET)")`,
  ]);
}

function chainForFormat(ext: "xlsx" | "parquet", maker: (p: string) => void) {
  const cwd = mkdtempSync(join(tmpdir(), `xanthil-f01-${ext}-`));
  const dataPath = join(cwd, `sales.${ext}`);
  maker(dataPath);
  runCli(["init"], cwd);
  runCli(["register", dataPath, "--alias", "sales"], cwd);
  const { card_draft_path, profile } = JSON.parse(
    runCli(["profile", "sales"], cwd).stdout,
  );
  expect(profile.row_count).toBe(2);
  if (ext === "xlsx") {
    expect(profile.sheet_names).toEqual(["Sheet"]); // H1: sheet names surfaced
  }
  expect(profile.columns.map((c: { name: string }) => c.name)).toEqual([
    "order_id",
    "category",
    "net_amount",
  ]);
  writeFileSync(
    card_draft_path,
    readFileSync(card_draft_path, "utf8").replace(
      'grain: ""',
      'grain: "one row = order line"',
    ),
  );
  runCli(["schema", "approve", "sales"], cwd);

  const fixture = join(cwd, "f.jsonl");
  writeFileSync(
    fixture,
    `${JSON.stringify({
      goal: "g",
      assumptions: [],
      code: ANALYSIS,
      validation_checks: [],
    })}\n`,
  );
  const env = { XANTHIL_LLM_FIXTURE: fixture };
  const taskId = JSON.parse(
    runCli(["ask", "g", "--dataset", "sales"], cwd, env).stdout,
  ).id;
  runCli(["confirm", taskId], cwd);
  const run = JSON.parse(runCli(["run", taskId], cwd, env).stdout);
  expect(run.status).toBe("succeeded");
  const artifacts = JSON.parse(runCli(["artifacts", taskId], cwd).stdout);
  const csvOut = readFileSync(String(artifacts[0].path), "utf8");
  // CSV-parity aggregate (same numbers as the CSV pipeline fixture).
  expect(csvOut.trim()).toBe("category,net_amount\nmens,200.0\nwomens,100.5");
}

test.skipIf(process.platform !== "darwin")(
  "F01: xlsx runs the full mode-S chain with CSV parity",
  () => {
    chainForFormat("xlsx", makeXlsx);
  },
  60_000,
);

test.skipIf(process.platform !== "darwin")(
  "F16: pathological xlsx is rejected at the CLI with a clear error",
  () => {
    const cwd = mkdtempSync(join(tmpdir(), "xanthil-f16-"));
    runCli(["init"], cwd);
    const merged = join(cwd, "merged.xlsx");
    execFileSync(join(workerDir, ".venv", "bin", "python"), [
      "-c",
      `from openpyxl import Workbook
b = Workbook(); s = b.active
s.append(["cat", "v"]); s.append(["womens", 1]); s.append(["mens", 2])
s.merge_cells("A2:A3"); b.save("${merged}")`,
    ]);
    runCli(["register", merged, "--alias", "m"], cwd);
    const profile = runCli(["profile", "m"], cwd);
    expect(profile.status).not.toBe(0);
    expect(profile.stderr).toContain("merged cells");
  },
  60_000,
);

test.skipIf(process.platform !== "darwin")(
  "F01: parquet runs the full mode-S chain with CSV parity",
  () => {
    chainForFormat("parquet", makeParquet);
  },
  60_000,
);
