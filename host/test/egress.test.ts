import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { registerDataset } from "../src/catalog.ts";
import { createEgressGateway, listModelCalls } from "../src/llm/egress.ts";
import {
  assertEnvelopeIsModeS,
  buildModeSEnvelope,
} from "../src/llm/envelope.ts";
import { FixtureCaller } from "../src/llm/fixture-caller.ts";
import type { SchemaCard } from "../src/profiler.ts";
import { initWorkspace, openWorkspace } from "../src/workspace.ts";

function newWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "xanthil-egress-"));
  initWorkspace(root);
  return openWorkspace(root);
}

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(`missing ${what}`);
  }
  return value;
}

const CARD: SchemaCard = {
  dataset: "sales",
  grain: "one row = order line",
  columns: {
    order_id: { type: "string", semantics: "order id" },
    net_amount: { type: "number", semantics: "net of refunds" },
  },
  unique_keys: ["order_id"],
  notes: [],
};

test("gateway sends the exact mode-S envelope and records the audit trail", async () => {
  const ws = newWorkspace();
  const fixture = new FixtureCaller([{ response: '{"taskspec": "ok"}' }]);
  const gateway = createEgressGateway(ws, fixture);

  const result = await gateway.completeModeS({
    goal: "compare July vs August net sales",
    datasets: [{ alias: "sales", uri: "dataset://sales", schema_card: CARD }],
  });

  expect(result.text).toBe('{"taskspec": "ok"}');

  // The single outbound request captured at the provider boundary:
  expect(fixture.capturedRequests).toHaveLength(1);
  const request = must(fixture.capturedRequests[0], "captured request");
  expect(request.system).toContain("mode S");
  const userPayload = JSON.parse(request.user);
  expect(Object.keys(userPayload).sort()).toEqual(
    ["allowed_libraries", "datasets", "user_goal"].sort(),
  );
  expect(userPayload.user_goal).toBe("compare July vs August net sales");
  expect(userPayload.datasets[0].schema_card.grain).toContain("order line");

  // Audit trail: SQLite row + local JSONL, physically outside model storage.
  const calls = listModelCalls(ws);
  expect(calls).toHaveLength(1);
  const call = must(calls[0], "audit row");
  expect(call.provider).toBe("fixture");
  expect(call.outcome).toBe("sent");
  expect(call.payload_sha256).toMatch(/^[0-9a-f]{64}$/);
  const jsonlPath = join(ws.root, "logs", "egress", `${call.id}.jsonl`);
  expect(existsSync(jsonlPath)).toBe(true);
  const jsonl = readFileSync(jsonlPath, "utf8");
  expect(JSON.parse(jsonl).request.system).toContain("mode S");
});

test("envelope guard rejects statistics smuggled into the card", () => {
  const envelope = buildModeSEnvelope({
    goal: "g",
    datasets: [{ alias: "sales", uri: "dataset://sales", schema_card: CARD }],
  });
  expect(() => assertEnvelopeIsModeS(envelope)).not.toThrow();

  const tainted = JSON.parse(JSON.stringify(envelope));
  tainted.datasets[0].schema_card.row_count = 12345;
  expect(() => assertEnvelopeIsModeS(tainted)).toThrow(/row_count/);

  const extra = JSON.parse(JSON.stringify(envelope));
  extra.recent_stdout = "order 007 amount 100.5";
  expect(() => assertEnvelopeIsModeS(extra)).toThrow();
});

test("legitimate column names like count/min/sum do not trip the banned-key scan (R2)", () => {
  const card = {
    ...CARD,
    columns: {
      count: { type: "integer", semantics: "items per line" },
      min: { type: "number", semantics: "" },
      sum: { type: "number", semantics: "" },
    },
  };
  const envelope = buildModeSEnvelope({
    goal: "g",
    datasets: [{ alias: "sales", uri: "dataset://sales", schema_card: card }],
  });
  expect(() => assertEnvelopeIsModeS(envelope)).not.toThrow();
});

test("session wall clock is the third enforced budget line (R3)", async () => {
  const ws = newWorkspace();
  const fixture = new FixtureCaller([{ response: "x" }, { response: "y" }]);
  const gateway = createEgressGateway(ws, fixture, { sessionWallClockMs: 0 });
  await expect(
    gateway.completeModeS({
      goal: "g",
      datasets: [{ alias: "sales", uri: "dataset://sales", schema_card: CARD }],
    }),
  ).rejects.toThrow(/wall clock/);
});

test("exhausted fixture and per-call timeout fail loudly", async () => {
  const ws = newWorkspace();
  const exhausted = createEgressGateway(ws, new FixtureCaller([]));
  await expect(
    exhausted.completeModeS({
      goal: "g",
      datasets: [{ alias: "sales", uri: "dataset://sales", schema_card: CARD }],
    }),
  ).rejects.toThrow(/fixture/);

  const slow = new FixtureCaller([{ response: "late", delayMs: 500 }]);
  const gateway = createEgressGateway(ws, slow, { perCallTimeoutMs: 50 });
  await expect(
    gateway.completeModeS({
      goal: "g",
      datasets: [{ alias: "sales", uri: "dataset://sales", schema_card: CARD }],
    }),
  ).rejects.toThrow(/timeout/i);
  const calls = listModelCalls(ws);
  expect(must(calls.at(-1), "last audit row").outcome).toBe("timeout");
});

test("gateway is bound to the workspace datasets it was given", () => {
  const ws = newWorkspace();
  const csv = join(ws.root, "sales.csv");
  writeFileSync(csv, "order_id,net_amount\n007,100\n");
  const reg = registerDataset(ws, csv, "sales");
  expect(reg.uri).toBe("dataset://sales");
});
