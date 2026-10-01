/**
 * M3 seam tests: the adapter surface must behave identically to the CLI path
 * (shared-core by construction, J5) and must not open any new egress path (canary re-run
 * through createXanthilCore — M3 exit criterion: no bypass egress).
 */
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createXanthilCore } from "../src/adapter/xanthil-core.ts";

const CANARY = "CNRYadapter9f8e";

const SALES_CSV =
  "order_id,order_date,customer_id,category,net_amount\n" +
  `007,2026-07-01,C01,womens,100.5\n` +
  `008,2026-07-01,C01,mens,50\n` +
  `009,2026-07-02,C02,womens,-20\n` +
  `007,2026-07-02,C01,womens,30\n`;

const ANALYSIS = [
  "import pandas as pd",
  "df = ctx.datasets['sales']",
  "agg = df.assign(net_amount=df['net_amount'].astype(float)).groupby('category')['net_amount'].sum().reset_index()",
  "ctx.save_result('by_category', agg)",
  "print(df)",
].join("\n");

function makeCore(cwd: string, turns: string[]) {
  const fixture = join(cwd, "fixture.jsonl");
  writeFileSync(fixture, `${turns.join("\n")}\n`);
  return createXanthilCore({
    workspaceDir: join(cwd, ".xanthil"),
    model: { kind: "fixture", fixturePath: fixture },
  });
}

test("adapter drives the full mode-S chain with deterministic CLI-parity results", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "xanthil-adapter-"));
  const core = makeCore(cwd, [
    JSON.stringify({
      goal: "net sales by category",
      assumptions: [],
      code: ANALYSIS,
      validation_checks: [],
    }),
  ]);

  core.init();
  writeFileSync(join(cwd, "sales.csv"), SALES_CSV);
  core.datasets.register(join(cwd, "sales.csv"), "sales");

  const { profile, card_draft_path } = core.schema.profile("sales");
  expect(profile.row_count).toBe(4);
  writeFileSync(
    card_draft_path,
    readFileSync(card_draft_path, "utf8").replace(
      'grain: ""',
      'grain: "one row = order line"',
    ),
  );
  core.schema.approve("sales");

  const task = await core.tasks.ask("net sales by category", ["sales"]);
  expect(task.status).toBe("awaiting_confirmation");
  const confirmed = core.tasks.confirm(task.id);
  expect(confirmed.status).toBe("ready");
  const run = await core.tasks.run(task.id);
  expect(run.status).toBe("succeeded");

  const artifacts = core.artifacts.list(task.id);
  expect(artifacts).toHaveLength(1);
  const artifactCsv = readFileSync(
    String((artifacts[0] as { path: string }).path),
    "utf8",
  );
  expect(artifactCsv.trim()).toBe(
    "category,net_amount\nmens,50.0\nwomens,110.5",
  );
}, 60_000);

test("canary never reaches the model through the adapter seam either", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "xanthil-adapter-canary-"));
  const csv = join(cwd, "sales.csv");
  writeFileSync(csv, SALES_CSV.replaceAll("007", CANARY));
  const core = makeCore(cwd, [
    JSON.stringify({
      goal: "g",
      assumptions: [],
      code: ANALYSIS,
      validation_checks: [],
    }),
  ]);

  core.init();
  core.datasets.register(csv, "sales");
  const { card_draft_path } = core.schema.profile("sales");
  writeFileSync(
    card_draft_path,
    readFileSync(card_draft_path, "utf8").replace('grain: ""', 'grain: "line"'),
  );
  core.schema.approve("sales");

  const task = await core.tasks.ask("g", ["sales"]);
  core.tasks.confirm(task.id);
  const run = await core.tasks.run(task.id);
  expect(run.status).toBe("succeeded");

  // The canary lives in LOCAL artifacts and run logs, never in any audit record.
  const calls = core.audit.modelCalls();
  expect(calls.length).toBeGreaterThanOrEqual(1);
  const egressDir = join(cwd, ".xanthil", "logs", "egress");
  for (const file of readdirSync(egressDir)) {
    const payload = readFileSync(join(egressDir, file), "utf8");
    expect(payload.includes(CANARY)).toBe(false);
  }
  const runs = readdirSync(join(cwd, ".xanthil", "runs", task.id), {
    recursive: true,
  });
  const runLog = runs
    .map((f) => String(f))
    .filter((f) => f.endsWith("run.log"))
    .at(0);
  expect(
    readFileSync(join(cwd, ".xanthil", "runs", task.id, runLog ?? ""), "utf8"),
  ).toContain(CANARY);
}, 60_000);

test("adapter drives mode-A publication send with the injected caller (P1 regression)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "xanthil-adapter-pub-"));
  const csv = join(cwd, "sales.csv");
  writeFileSync(csv, SALES_CSV);
  const core = makeCore(cwd, ["interpretation reply"]);

  core.init();
  core.datasets.register(csv, "sales");
  const { card_draft_path } = core.schema.profile("sales");
  writeFileSync(
    card_draft_path,
    readFileSync(card_draft_path, "utf8").replace('grain: ""', 'grain: "line"'),
  );
  core.schema.approve("sales");

  // J8: plan as an OBJECT (no file management by the host)
  const pub = core.publications.prepare({
    dataset: "sales",
    purpose: "p",
    target_model: "fixture",
    subject_field: "customer_id",
    min_subjects: 2,
    max_sends: 3,
    expires_hours: 24,
    precision: 2,
    metrics: [{ name: "net_sales", agg: "sum", field: "net_amount" }],
    dimensions: ["category"],
    filters: [],
  });
  expect(pub.status).toBe("prepared");

  const approval = core.publications.approve(pub.id);
  expect(approval.target_model).toBe("fixture");

  const sent = await core.publications.send(pub.id);
  expect(sent.status).toBe("sent");
  expect(sent.reply).toContain("interpretation reply");

  // The audit shows exactly one mode-A call via the injected (fixture) caller.
  const calls = core.audit.modelCalls();
  expect(calls.at(-1)?.purpose).toBe("mode_a_publication");
  expect(calls.at(-1)?.provider).toBe("fixture");
}, 60_000);
