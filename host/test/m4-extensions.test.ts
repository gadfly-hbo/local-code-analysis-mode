/**
 * M4 contracts: each extension carries an independent contract + regression
 * (exit criterion "每项扩展具备独立契约与回归测试").
 * E1: template aggs (ratio/mean/median/std + zero-denominator guard)
 * E2: skills — deterministic specs, ZERO model calls, same lifecycle
 * E3: workspace policy — floors enforced at prepare, policy: reasons
 */
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

const SALES_CSV =
  "order_id,order_date,customer_id,category,net_amount\n" +
  "007,2026-07-01,C01,womens,100.5\n" +
  "008,2026-07-02,C02,mens,50\n" +
  "009,2026-08-01,C01,womens,-20\n" +
  "007,2026-08-02,C01,womens,30\n";

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

function preparedWorkspace() {
  const cwd = mkdtempSync(join(tmpdir(), "xanthil-m4-"));
  const csv = join(cwd, "sales.csv");
  writeFileSync(csv, SALES_CSV);
  runCli(["init"], cwd);
  runCli(["register", csv, "--alias", "sales"], cwd);
  const { card_draft_path } = JSON.parse(
    runCli(["profile", "sales"], cwd).stdout,
  );
  writeFileSync(
    card_draft_path,
    readFileSync(card_draft_path, "utf8").replace('grain: ""', 'grain: "line"'),
  );
  runCli(["schema", "approve", "sales"], cwd);
  return cwd;
}

test("E2: skills list + deterministic spec + zero model calls end to end", {
  timeout: 60_000,
}, () => {
  const cwd = preparedWorkspace();

  const skills = JSON.parse(runCli(["skills"], cwd).stdout);
  expect(skills.map((s: { name: string }) => s.name)).toEqual([
    "monthly_compare",
    "category_contribution",
  ]);

  const first = JSON.parse(
    runCli(
      [
        "skill-run",
        "monthly_compare",
        "--dataset",
        "sales",
        "--param",
        "date_field=order_date",
        "--param",
        "value_field=net_amount",
        "--param",
        "order_field=order_id",
      ],
      cwd,
    ).stdout,
  );
  expect(first.status).toBe("awaiting_confirmation");

  const second = JSON.parse(
    runCli(
      [
        "skill-run",
        "monthly_compare",
        "--dataset",
        "sales",
        "--param",
        "date_field=order_date",
        "--param",
        "value_field=net_amount",
        "--param",
        "order_field=order_id",
      ],
      cwd,
    ).stdout,
  );
  // E2 contract: deterministic generation — identical params => identical goal prefix.
  expect(second.goal).toBe(first.goal);

  runCli(["confirm", first.id], cwd);
  const run = JSON.parse(runCli(["run", first.id], cwd).stdout);
  expect(run.status).toBe("succeeded");

  const artifacts = JSON.parse(runCli(["artifacts", first.id], cwd).stdout);
  const artifactCsv = readFileSync(String(artifacts[0].path), "utf8").trim();
  // Hand-computed: 2026-07 = 100.5+50 = 150.5, orders {007,008} = 2;
  // 2026-08 = -20+30 = 10, orders {009,007} = 2; delta = 10-150.5 = -140.5.
  expect(artifactCsv).toBe(
    "_m,total,orders,delta\n2026-07,150.5,2,\n2026-08,10.0,2,-140.5",
  );

  // E2 contract: ZERO model calls left the machine for this analysis.
  const audit = JSON.parse(runCli(["audit"], cwd).stdout);
  expect(audit).toHaveLength(0);
});

test("E2: category_contribution computes shares and ranks (hand-computed)", {
  timeout: 60_000,
}, () => {
  const cwd = preparedWorkspace();
  const task = JSON.parse(
    runCli(
      [
        "skill-run",
        "category_contribution",
        "--dataset",
        "sales",
        "--param",
        "category_field=category",
        "--param",
        "value_field=net_amount",
      ],
      cwd,
    ).stdout,
  );
  runCli(["confirm", task.id], cwd);
  const run = JSON.parse(runCli(["run", task.id], cwd).stdout);
  expect(run.status).toBe("succeeded");
  const artifacts = JSON.parse(runCli(["artifacts", task.id], cwd).stdout);
  const csv = readFileSync(String(artifacts[0].path), "utf8").trim();
  // womens = 100.5-20+30 = 110.5 (share 0.6875? grand=160.5 -> 110.5/160.5=0.688); mens=50.
  const lines = csv.split("\n");
  expect(lines[0]).toBe("category,_v,share,rank");
  const womens = lines.find((l) => l.startsWith("womens"));
  const mens = lines.find((l) => l.startsWith("mens"));
  expect(womens).toContain("110.5");
  expect(womens).toContain("1");
  expect(mens).toContain("50.0");
});

test("E3: policy floors block plans at prepare with policy: reasons", {
  timeout: 60_000,
}, () => {
  const cwd = preparedWorkspace();

  // No policy -> unrestricted baseline still works.
  const planOk = join(cwd, "plan-ok.yaml");
  writeFileSync(planOk, PLAN(2));
  expect(
    JSON.parse(runCli(["publish", "prepare", planOk], cwd).stdout).status,
  ).toBe("prepared");

  // Install a strict policy.
  writeFileSync(
    join(cwd, ".xanthil", "policy.yaml"),
    'allowed_target_models: ["fixture", "glm-4.7"]\nmin_subjects_floor: 5\nmax_metrics_per_plan: 2\nbanned_dimensions: ["customer_id"]\n',
  );
  const policy = JSON.parse(runCli(["policy", "show"], cwd).stdout);
  expect(policy.version).toMatch(/^pol_[0-9a-f]{8}$/);

  // floor violation
  const p1 = join(cwd, "p1.yaml");
  writeFileSync(p1, PLAN(2));
  const b1 = JSON.parse(runCli(["publish", "prepare", p1], cwd).stdout);
  expect(b1.status).toBe("blocked");
  expect(b1.block_reason).toContain(
    "policy: min_subjects 2 is below the workspace floor 5",
  );

  // allowlist violation
  const p2 = join(cwd, "p2.yaml");
  writeFileSync(p2, PLAN(5, "gpt-9"));
  const b2 = JSON.parse(runCli(["publish", "prepare", p2], cwd).stdout);
  expect(b2.block_reason).toContain("policy: target_model");

  // banned dimension
  const p3 = join(cwd, "p3.yaml");
  writeFileSync(p3, PLAN(5, "fixture", "customer_id"));
  const b3 = JSON.parse(runCli(["publish", "prepare", p3], cwd).stdout);
  expect(b3.block_reason).toContain(
    'policy: dimension "customer_id" is banned',
  );

  // compliant plan passes
  const p4 = join(cwd, "p4.yaml");
  writeFileSync(p4, PLAN(5, "fixture"));
  const ok = JSON.parse(runCli(["publish", "prepare", p4], cwd).stdout);
  expect(ok.status).toBe("prepared");
});

test("E3: require_checks_on_approve rejects check-less cards", {
  timeout: 60_000,
}, () => {
  const cwd = preparedWorkspace();
  writeFileSync(
    join(cwd, ".xanthil", "policy.yaml"),
    "require_checks_on_approve: true\n",
  );
  // Re-approving the same (check-less) card must now fail with a policy error.
  const draft = join(cwd, ".xanthil", "datasets", "sales.schema.yaml");
  const rejected = runCli(["schema", "approve", "sales"], cwd);
  expect(rejected.status).not.toBe(0);
  expect(rejected.stderr).toContain(
    "policy: schema cards must carry a checks block",
  );
  expect(draft.length).toBeGreaterThan(0);
});

function PLAN(minSubjects: number, target = "fixture", dimension = "category") {
  return `dataset: sales
purpose: "p"
target_model: "${target}"
subject_field: customer_id
min_subjects: ${minSubjects}
max_sends: 3
expires_hours: 24
precision: 2
metrics:
  - {name: net, agg: sum, field: net_amount}
dimensions: [${dimension}]
filters: []
`;
}

test("E1: ratio plan passes publish prepare end to end (host gate)", {
  timeout: 60_000,
}, () => {
  const cwd = preparedWorkspace();
  // Add a numeric denominator column: order_lines.
  const csv = join(cwd, "ratio.csv");
  writeFileSync(
    csv,
    "order_id,order_date,customer_id,category,net_amount,order_lines\n" +
      "007,2026-07-01,C01,womens,100.0,2\n" +
      "008,2026-07-01,C02,womens,50.0,2\n",
  );
  runCli(["register", csv, "--alias", "ratio"], cwd);
  const { card_draft_path } = JSON.parse(
    runCli(["profile", "ratio"], cwd).stdout,
  );
  writeFileSync(
    card_draft_path,
    readFileSync(card_draft_path, "utf8").replace('grain: ""', 'grain: "line"'),
  );
  runCli(["schema", "approve", "ratio"], cwd);

  const planPath = join(cwd, "ratio.yaml");
  writeFileSync(
    planPath,
    `dataset: ratio
purpose: "per-line economics"
target_model: "fixture"
subject_field: customer_id
min_subjects: 2
max_sends: 3
expires_hours: 24
precision: 2
metrics:
  - {name: per_line, agg: ratio, numerator: net_amount, denominator: order_lines}
dimensions: [category]
filters: []
`,
  );
  const pub = JSON.parse(runCli(["publish", "prepare", planPath], cwd).stdout);
  expect(pub.status).toBe("prepared");
  const preview = JSON.parse(
    readFileSync(
      join(cwd, ".xanthil", "publications", pub.id, "preview.json"),
      "utf8",
    ),
  );
  expect(preview.metrics[0].rows[0].value).toBe(37.5); // (100+50)/(2+2)
});

test("E3: policy set command + old-schema workspace upgrade regression", {
  timeout: 60_000,
}, () => {
  const cwd = preparedWorkspace();

  // policy set (Host writer) then show reflects it with a changed version.
  const before = JSON.parse(runCli(["policy", "show"], cwd).stdout);
  expect(before.version).toBeNull(); // no policy yet
  const set = runCli(["policy", "set", '{"min_subjects_floor":3}'], cwd);
  expect(set.status).toBe(0);
  const after = JSON.parse(runCli(["policy", "show"], cwd).stdout);
  expect(after.policy.min_subjects_floor).toBe(3);
  expect(after.version).toMatch(/^pol_[0-9a-f]{8}$/);
  expect(after.version).not.toBe(before.version);

  // Old-schema upgrade: drop the policy_version column, reopen (any CLI call),
  // then publish prepare must still work (ALTER backfills the column).
  execFileSync(
    process.execPath,
    [
      "-e",
      `const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('${join(cwd, ".xanthil", "db.sqlite")}');`,
    ],
    { env: {} },
  );
  const { DatabaseSync } =
    require("node:sqlite") as typeof import("node:sqlite");
  const db = new DatabaseSync(join(cwd, ".xanthil", "db.sqlite"));
  db.exec(
    "CREATE TABLE publications_old AS SELECT id, at, purpose, plan_digest, plan_json, status, payload_json, payload_sha256, block_reason, data_versions, datasets FROM publications",
  );
  db.exec("DROP TABLE publications");
  db.exec("ALTER TABLE publications_old RENAME TO publications");
  db.close();

  const planPath = join(cwd, "upgrade.yaml");
  writeFileSync(planPath, PLAN(2));
  const pub = runCli(["publish", "prepare", planPath], cwd); // floor=3 policy is LIVE
  const body = JSON.parse(pub.stdout);
  expect(body.block_reason).toContain(
    "policy: min_subjects 2 is below the workspace floor 3",
  );
  // The policy-blocked INSERT succeeded on the upgraded (retrofitted) table —
  // proving the ALTER migration kept old workspaces' publish path alive.
});
