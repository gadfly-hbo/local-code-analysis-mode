/** Slice 2: publication plan validation + trusted recompute + prepare/preview. */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { canonicalJson, sha256Hex } from "../src/publication.ts";

const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const tsxBin = fileURLToPath(
  new URL("../node_modules/.bin/tsx", import.meta.url),
);

const SALES_CSV =
  "order_id,order_date,customer_id,category,net_amount\n" +
  "007,2026-07-01,C01,womens,100.5\n" +
  "008,2026-07-01,C01,mens,50\n" +
  "009,2026-07-02,C02,womens,-20\n" +
  "007,2026-07-02,C01,womens,30\n";

function runCli(args: string[], cwd: string) {
  try {
    return {
      stdout: execFileSync(tsxBin, [cliPath, ...args], {
        cwd,
        encoding: "utf8",
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

function preparedWorkspace() {
  const cwd = mkdtempSync(join(tmpdir(), "xanthil-pub-"));
  const csv = join(cwd, "sales.csv");
  writeFileSync(csv, SALES_CSV);
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
  return cwd;
}

const GOOD_PLAN = `dataset: sales
purpose: "interpret July composition"
target_model: "glm-test"
subject_field: customer_id
min_subjects: 2
max_sends: 3
expires_hours: 24
precision: 2
metrics:
  - {name: net_sales, agg: sum, field: net_amount}
  - {name: orders, agg: count_distinct, field: order_id}
dimensions:
  - category
  - month(order_date)
filters: []
`;

test("plan draft -> edit -> prepare produces exact preview with suppression", () => {
  const cwd = preparedWorkspace();

  const draftOut = JSON.parse(runCli(["publish", "plan", "sales"], cwd).stdout);
  expect(existsSync(draftOut.plan_path)).toBe(true);
  expect(readFileSync(draftOut.plan_path, "utf8")).toContain(
    "trusted publisher",
  );

  const planPath = join(cwd, "plan.yaml");
  writeFileSync(planPath, GOOD_PLAN);
  const prepare = runCli(["publish", "prepare", planPath], cwd);
  expect(prepare.status).toBe(0);
  const pub = JSON.parse(prepare.stdout);
  expect(pub.status).toBe("prepared");
  expect(pub.payload_sha256).toMatch(/^[0-9a-f]{64}$/);

  const preview = JSON.parse(
    readFileSync(
      join(cwd, ".xanthil", "publications", pub.id, "preview.json"),
      "utf8",
    ),
  );
  // Hand-computed §12-style values; mens group suppressed (single subject C01).
  const net = preview.metrics.find(
    (m: { name: string }) => m.name === "net_sales",
  );
  const orders = preview.metrics.find(
    (m: { name: string }) => m.name === "orders",
  );
  expect(net.rows).toEqual([
    {
      dimensions: { category: "womens", "month(order_date)": "2026-07" },
      value: 110.5,
    },
  ]);
  expect(orders.rows).toEqual([
    {
      dimensions: { category: "womens", "month(order_date)": "2026-07" },
      value: 2,
    },
  ]);
  expect(preview.suppressed_group_count).toBe(1); // distinct groups (R8)
  expect(preview.min_subjects).toBe(2);

  // payload_sha256 == sha256(canonical(payload)) — the digest the approval will bind.
  expect(pub.payload_sha256).toBe(sha256Hex(canonicalJson(preview)));

  const listing = JSON.parse(runCli(["publications"], cwd).stdout);
  expect(listing).toHaveLength(1);
});

test("plan validation rejects non-card fields and bad bounds before compute", () => {
  const cwd = preparedWorkspace();
  const badDim = GOOD_PLAN.replace("- category", "- secret_dimension");
  const planPath = join(cwd, "bad1.yaml");
  writeFileSync(planPath, badDim);
  const r1 = runCli(["publish", "prepare", planPath], cwd);
  expect(r1.status).not.toBe(0);
  expect(r1.stderr).toContain("secret_dimension");

  const badSends = GOOD_PLAN.replace("max_sends: 3", "max_sends: 99");
  writeFileSync(join(cwd, "bad2.yaml"), badSends);
  const r2 = runCli(["publish", "prepare", join(cwd, "bad2.yaml")], cwd);
  expect(r2.status).not.toBe(0);
  expect(r2.stderr).toContain("max_sends");
});

test("worker-side recompute failures map to blocked publications with reasons", () => {
  const cwd = preparedWorkspace();
  const planPath = join(cwd, "plan.yaml");
  // month() over a non-date column: category strings are not parseable dates.
  writeFileSync(
    planPath,
    GOOD_PLAN.replace("month(order_date)", "month(category)"),
  );
  const prepare = runCli(["publish", "prepare", planPath], cwd);
  expect(prepare.status).toBe(0); // blocked publication is a normal outcome (§11.4)
  const pub = JSON.parse(prepare.stdout);
  expect(pub.status).toBe("blocked");
  expect(pub.block_reason).toContain("date parse rate");
});

test("canonicalJson is key-order stable (P08 prerequisite)", () => {
  expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: 3 } })).toBe(
    canonicalJson({ a: { c: 3, d: [2, { y: 2, z: 1 }] }, b: 1 }),
  );
});
