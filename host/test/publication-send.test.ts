/** Slices 3+4: approve→send happy path, P08 binding vectors, P10 lifecycle, P06 envelope guard. */
import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { assertEnvelopeIsModeA } from "../src/llm/envelope.ts";

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

const planYaml = (target: string) => `dataset: sales
purpose: "interpret July composition"
target_model: "${target}"
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

function preparedWorkspace() {
  const cwd = mkdtempSync(join(tmpdir(), "xanthil-send-"));
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
  return { cwd, csv };
}

function preparedPublication(cwd: string, target = "fixture") {
  const planPath = join(cwd, "plan.yaml");
  writeFileSync(planPath, planYaml(target));
  const prepare = JSON.parse(
    runCli(["publish", "prepare", planPath], cwd).stdout,
  );
  expect(prepare.status).toBe("prepared");
  return prepare;
}

function egressRecords(cwd: string) {
  const dir = join(cwd, ".xanthil", "logs", "egress");
  return readdirSync(dir)
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .sort((a, b) => (JSON.parse(a).at < JSON.parse(b).at ? -1 : 1))
    .map((raw) => JSON.parse(raw) as Record<string, unknown>);
}

function sql(cwd: string, statement: string) {
  execSync(
    `node -e "const {DatabaseSync}=require('node:sqlite');new DatabaseSync(process.env.DB).exec(process.env.SQL)"`,
    {
      env: {
        ...process.env,
        DB: join(cwd, ".xanthil", "db.sqlite"),
        SQL: statement,
      },
    },
  );
}

test("approve -> send delivers exactly the authorized aggregates and records the reply", () => {
  const { cwd } = preparedWorkspace();
  const pub = preparedPublication(cwd);
  const fixture = join(cwd, "interp.jsonl");
  writeFileSync(
    fixture,
    "Interpretation: womens 2026-07 net 110.5 with 2 orders.\n",
  );
  const env = { XANTHIL_LLM_FIXTURE: fixture };

  const approve = runCli(["publish", "approve", pub.id], cwd);
  expect(approve.status).toBe(0);
  expect(JSON.parse(approve.stdout).max_sends).toBe(3);

  const send = runCli(["publish", "send", pub.id], cwd, env);
  expect(send.status).toBe(0);
  expect(send.stdout).toContain("Interpretation: womens 2026-07");
  expect(send.stdout).toContain('"status":"sent"');

  const records = egressRecords(cwd);
  expect(records).toHaveLength(1);
  const first = records[0];
  if (!first || typeof first.request !== "object" || first.request === null) {
    throw new Error("missing egress record");
  }
  const user = JSON.parse(String((first.request as { user: string }).user));
  expect(
    user.publication.metrics.find(
      (m: { name: string }) => m.name === "net_sales",
    ).rows[0].value,
  ).toBe(110.5);
  expect(user.publication.suppressed_group_count).toBe(1); // distinct groups (R8)
  expect(user.authorization.approval_id).toMatch(/^appr_/);
  // No row-level data anywhere in the outbound payload.
  expect(JSON.stringify(records[0])).not.toContain('"007"');
  const audit = JSON.parse(runCli(["audit"], cwd).stdout);
  expect(audit[0].purpose).toBe("mode_a_publication");
}, 60_000);

test("P08: data version drift, template drift, model swap, expiry each block the send", () => {
  const { cwd, csv } = preparedWorkspace();

  // (a) re-registered file (new content version) after approval
  const pubA = preparedPublication(cwd);
  runCli(["publish", "approve", pubA.id], cwd);
  writeFileSync(csv, `${SALES_CSV}010,2026-07-03,C03,mens,10\n`);
  runCli(["register", csv, "--alias", "sales"], cwd);
  const drift = runCli(["publish", "send", pubA.id], cwd, {
    XANTHIL_LLM_FIXTURE: "/nonexistent",
  });
  expect(JSON.parse(drift.stdout).block_reason).toContain("data version drift");

  // reset file to approved content for the remaining vectors
  writeFileSync(csv, SALES_CSV);
  runCli(["register", csv, "--alias", "sales"], cwd);

  // (b) silent file change WITHOUT re-register: version row matches, recompute digest differs
  const pubB = preparedPublication(cwd);
  runCli(["publish", "approve", pubB.id], cwd);
  writeFileSync(csv, `${SALES_CSV}010,2026-07-03,C03,womens,5\n`);
  const template = runCli(["publish", "send", pubB.id], cwd, {
    XANTHIL_LLM_FIXTURE: "/nonexistent",
  });
  // R12 catches silent edits EARLIER via the file hash (the send-time recompute
  // digest comparison remains the second line of defense for template drift).
  expect(JSON.parse(template.stdout).block_reason).toContain(
    "no longer matches the bound version",
  );
  writeFileSync(csv, SALES_CSV);

  // (c) target model mismatch: approval binds glm-test, env endpoint is fixture
  const pubC = preparedPublication(cwd, "glm-test");
  runCli(["publish", "approve", pubC.id], cwd);
  const model = runCli(["publish", "send", pubC.id], cwd, {
    XANTHIL_LLM_FIXTURE: "/nonexistent",
  });
  expect(JSON.parse(model.stdout).block_reason).toContain(
    "target model mismatch",
  );

  // (d) expired approval — expires_hours min is 1h, so expiry is time-injected
  // via the approval row (the ONLY fabricated state; the check under test is
  // the send-time comparison itself)
  const pubD = preparedPublication(cwd);
  runCli(["publish", "approve", pubD.id], cwd);
  sql(cwd, "UPDATE approvals SET expires_at = '2000-01-01T00:00:00.000Z'");
  const expired = runCli(["publish", "send", pubD.id], cwd, {
    XANTHIL_LLM_FIXTURE: "/nonexistent",
  });
  expect(JSON.parse(expired.stdout).block_reason).toContain("expired");
}, 60_000);

test("P10: revocation and max_sends cap stop future sends", () => {
  const { cwd } = preparedWorkspace();
  const fixture = join(cwd, "interp.jsonl");
  writeFileSync(fixture, "ok interpretation\n");
  const env = { XANTHIL_LLM_FIXTURE: fixture };

  // revocation — including the R1 regression: approving TWICE must not leave a
  // stale approval that survives revoke (single-active-approval invariant)
  const pubA = preparedPublication(cwd);
  runCli(["publish", "approve", pubA.id], cwd);
  runCli(["publish", "approve", pubA.id], cwd); // second approval: revokes the first
  runCli(["publish", "revoke", pubA.id], cwd); // revokes ALL active approvals
  const revoked = runCli(["publish", "send", pubA.id], cwd, env);
  expect(revoked.status).not.toBe(0);
  expect(revoked.stderr).toContain("no active approval");

  // max_sends = 1
  const planPath = join(cwd, "cap1.yaml");
  writeFileSync(
    planPath,
    planYaml("fixture").replace("max_sends: 3", "max_sends: 1"),
  );
  const pubB = JSON.parse(runCli(["publish", "prepare", planPath], cwd).stdout);
  runCli(["publish", "approve", pubB.id], cwd);
  const first = runCli(["publish", "send", pubB.id], cwd, env);
  expect(first.stdout).toContain('"status":"sent"');
  // N4: the re-send runs the REAL path against the sent status — no fabricated state.
  const second = runCli(["publish", "send", pubB.id], cwd, env);
  expect(JSON.parse(second.stdout).block_reason).toContain("max_sends");
}, 60_000);

test("P06: the mode-A envelope guard rejects smuggled free text and string numbers", () => {
  const CARD = {
    dataset: "sales",
    grain: "one row = order line",
    columns: { category: { type: "string", semantics: "" } },
    unique_keys: [],
    notes: [],
  };
  const base = {
    system: "s",
    user_goal: "g",
    datasets: [{ alias: "sales", uri: "dataset://sales", schema_card: CARD }],
    allowed_libraries: [],
    publication: {
      plan_digest: "a".repeat(64),
      subject_field: "customer_id",
      min_subjects: 2,
      precision: 2,
      group_count: 2,
      suppressed_group_count: 1,
      data_versions: { sales: "b".repeat(64) },
      generated_at: "2026-09-30T00:00:00Z",
      metrics: [
        {
          name: "net",
          rows: [{ dimensions: { category: "womens" }, value: 110.5 }],
        },
      ],
    },
    authorization: { approval_id: "appr_x", payload_sha256: "c".repeat(64) },
  };
  expect(() => assertEnvelopeIsModeA(base)).not.toThrow();

  const freeText = structuredClone(base);
  (freeText.publication as Record<string, unknown>).note =
    "user 007 spent 100.5";
  expect(() => assertEnvelopeIsModeA(freeText)).toThrow();

  const stringNumber = structuredClone(base);
  const row0 = stringNumber.publication.metrics[0]?.rows[0];
  if (!row0) {
    throw new Error("missing row");
  }
  row0.value = "110.5" as unknown as number;
  expect(() => assertEnvelopeIsModeA(stringNumber)).toThrow(/finite number/);

  const multilineDim = structuredClone(base);
  const dimRow = multilineDim.publication.metrics[0]?.rows[0];
  if (!dimRow) {
    throw new Error("missing row");
  }
  dimRow.dimensions.category = "womens\n007,100.5";
  expect(() => assertEnvelopeIsModeA(multilineDim)).toThrow();

  const badDigest = structuredClone(base);
  badDigest.authorization.payload_sha256 = "not-a-digest";
  expect(() => assertEnvelopeIsModeA(badDigest)).toThrow();
});

test("R2: prepare-stage policy blocks oversized results and bad dimension values", () => {
  const { cwd } = preparedWorkspace();

  // >200 rows with per-dimension cardinality <= 50: 50 order_ids x 5 months
  // = 250 groups on ONE metric (each dim within the cardinality cap).
  const wideCsv = join(cwd, "wide.csv");
  const lines = ["order_id,order_date,customer_id,category,net_amount"];
  for (let m = 1; m <= 5; m++) {
    for (let i = 0; i < 50; i++) {
      lines.push(`${String(i).padStart(3, "0")},2026-0${m}-01,C01,womens,1.0`);
    }
  }
  writeFileSync(wideCsv, `${lines.join("\n")}\n`);
  runCli(["register", wideCsv, "--alias", "wide"], cwd);
  const wide = JSON.parse(runCli(["profile", "wide"], cwd).stdout);
  writeFileSync(
    wide.card_draft_path,
    readFileSync(wide.card_draft_path, "utf8").replace(
      'grain: ""',
      'grain: "line"',
    ),
  );
  runCli(["schema", "approve", "wide"], cwd);

  const overCap = `dataset: wide
purpose: "oversize"
target_model: "fixture"
subject_field: customer_id
min_subjects: 1
max_sends: 3
expires_hours: 24
precision: 2
metrics:
  - {name: a, agg: sum, field: net_amount}
dimensions: [order_id, month(order_date)]
filters: []
`;
  const p1 = join(cwd, "over.yaml");
  writeFileSync(p1, overCap);
  const blocked = JSON.parse(runCli(["publish", "prepare", p1], cwd).stdout);
  expect(blocked.status).toBe("blocked");
  expect(blocked.block_reason).toContain("rows across metrics");

  // newline in a dimension value -> blocked at prepare (xlsx cells can carry these)
  const nlCsv = join(cwd, "nl.csv");
  // Quoted CSV cell with an EMBEDDED newline (xlsx cells can carry these too).
  writeFileSync(
    nlCsv,
    `order_id,order_date,customer_id,category,net_amount\n007,2026-07-01,C01,"womens${"\n"} SECRET-007",100.5\n`,
  );
  runCli(["register", nlCsv, "--alias", "nl"], cwd);
  const nl = JSON.parse(runCli(["profile", "nl"], cwd).stdout);
  writeFileSync(
    nl.card_draft_path,
    readFileSync(nl.card_draft_path, "utf8").replace(
      'grain: ""',
      'grain: "line"',
    ),
  );
  runCli(["schema", "approve", "nl"], cwd);
  const nlPlan = join(cwd, "nl.yaml");
  writeFileSync(
    nlPlan,
    planYaml("fixture")
      .replace("dataset: sales", "dataset: nl")
      .replace("min_subjects: 2", "min_subjects: 1"), // keep the dirty group visible
  );
  const nlBlocked = JSON.parse(
    runCli(["publish", "prepare", nlPlan], cwd).stdout,
  );
  expect(nlBlocked.status).toBe("blocked");
  expect(nlBlocked.block_reason).toContain("publish bounds");
}, 60_000);
