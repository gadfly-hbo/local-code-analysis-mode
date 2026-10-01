/**
 * M5 seam tests: the HTTP API is the workbench's contract. Full-chain e2e
 * with the fixture provider + upload safety + the KA-M5-1 canary — the UI is
 * an operation surface and must never become a second egress boundary.
 */

import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { listen, startWorkbenchServer } from "../src/server.ts";

const hostDir = fileURLToPath(new URL("..", import.meta.url));

const SALES_CSV =
  "order_id,order_date,customer_id,category,net_amount\n" +
  "007,2026-07-01,C01,womens,100.5\n" +
  "008,2026-07-01,C01,mens,50\n" +
  "009,2026-07-02,C02,womens,-20\n" +
  "007,2026-07-02,C01,womens,30\n";

const ANALYSIS = [
  "import pandas as pd",
  "df = ctx.datasets['sales']",
  "agg = df.assign(net_amount=df['net_amount'].astype(float)).groupby('category')['net_amount'].sum().reset_index()",
  "ctx.save_result('by_category', agg)",
  "print(df)",
].join("\n");

interface StartedWorkbench {
  url: string;
  close: () => Promise<void>;
  cwd: string;
}

async function startWorkbench(): Promise<StartedWorkbench> {
  const cwd = mkdtempSync(join(tmpdir(), "xanthil-web-"));
  const fixture = join(cwd, "fixture.jsonl");
  writeFileSync(
    fixture,
    `${JSON.stringify({ goal: "g", assumptions: [], code: ANALYSIS, validation_checks: [] })}\n`,
  );
  const { server, url, close } = startWorkbenchServer({
    workspaceDir: join(cwd, ".xanthil"),
    port: 0,
    model: { kind: "fixture", fixturePath: fixture },
  });
  // random port
  await listen(server, 0, "127.0.0.1");
  const address = server.address() as { port: number };
  return { url: `http://127.0.0.1:${address.port}`, close, cwd };
}

async function call(
  base: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: any }> {
  const init: RequestInit = {
    method,
    headers: { "content-type": "application/json" },
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${base}${path}`, init);
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

test("web workbench drives the full chain: upload → schema → ask → confirm → run → artifact", {
  timeout: 120_000,
}, async () => {
  const wb = await startWorkbench();
  try {
    // upload (base64, W4 path is server-controlled)
    const upload = await call(wb.url, "POST", "/api/datasets", {
      alias: "sales",
      filename: "sales.csv",
      contentB64: Buffer.from(SALES_CSV).toString("base64"),
    });
    expect(upload.status).toBe(200);
    expect(upload.data.profile.row_count).toBe(4);

    // schema approve (card object → same validation as CLI)
    const approve = await call(wb.url, "POST", "/api/schema", {
      alias: "sales",
      card: {
        dataset: "sales",
        grain: "one row = order line",
        columns: {
          order_id: { type: "string", semantics: "" },
          order_date: { type: "string", semantics: "" },
          customer_id: { type: "string", semantics: "" },
          category: { type: "string", semantics: "" },
          net_amount: { type: "number", semantics: "" },
        },
        unique_keys: [],
        notes: [],
      },
    });
    expect(approve.status).toBe(200);
    expect(approve.data.schema_version).toMatch(/^sch_/);

    // ask → awaiting_confirmation
    const ask = await call(wb.url, "POST", "/api/ask", {
      goal: "net sales by category",
      datasets: ["sales"],
    });
    expect(ask.data.status).toBe("awaiting_confirmation");
    const taskId = ask.data.id;

    // run before confirm must fail
    const early = await call(wb.url, "POST", `/api/tasks/${taskId}/run`);
    expect(early.status).toBe(400);

    // confirm + run (sync terminal state, W7)
    await call(wb.url, "POST", `/api/tasks/${taskId}/confirm`);
    const run = await call(wb.url, "POST", `/api/tasks/${taskId}/run`);
    expect(run.data.status).toBe("succeeded");
    expect(run.data.artifacts).toHaveLength(1);

    // artifact raw renders CSV text
    const raw = await call(
      wb.url,
      "GET",
      `/api/artifacts/${run.data.artifacts[0].id}/raw`,
    );
    expect(raw.data.text.trim()).toBe(
      "category,net_amount\nmens,50.0\nwomens,110.5",
    );

    // skill-run path: zero model calls
    const skill = await call(wb.url, "POST", "/api/skill-run", {
      skill: "category_contribution",
      dataset: "sales",
      params: {
        dataset: "sales",
        category_field: "category",
        value_field: "net_amount",
      },
    });
    expect(skill.data.status).toBe("awaiting_confirmation");

    // state endpoint aggregates everything
    const state = await call(wb.url, "GET", "/api/state");
    expect(state.data.datasets).toHaveLength(1);
    expect(state.data.skills.map((s: { name: string }) => s.name)).toContain(
      "monthly_compare",
    );
    expect(state.data.model).toBe("fixture");
  } finally {
    await wb.close();
  }
});

test("web canary: uploads with a marker never leak through any model call (KA-M5-1)", {
  timeout: 120_000,
}, async () => {
  const wb = await startWorkbench();
  try {
    const canary = "CNRYweb9f8e7d6c";
    const csv = SALES_CSV.replaceAll("007", canary);
    await call(wb.url, "POST", "/api/datasets", {
      alias: "sales",
      filename: "sales.csv",
      contentB64: Buffer.from(csv).toString("base64"),
    });
    await call(wb.url, "POST", "/api/schema", {
      alias: "sales",
      card: {
        dataset: "sales",
        grain: "line",
        columns: Object.fromEntries(
          [
            "order_id",
            "order_date",
            "customer_id",
            "category",
            "net_amount",
          ].map((c) => [c, { type: "string", semantics: "" }]),
        ),
        unique_keys: [],
        notes: [],
      },
    });
    const ask = await call(wb.url, "POST", "/api/ask", {
      goal: "g",
      datasets: ["sales"],
    });
    await call(wb.url, "POST", `/api/tasks/${ask.data.id}/confirm`);
    const run = await call(wb.url, "POST", `/api/tasks/${ask.data.id}/run`);
    expect(run.data.status).toBe("succeeded");

    // The canary exists in LOCAL artifacts/logs, and in ZERO audit records.
    const audit = await call(wb.url, "GET", "/api/audit");
    expect(JSON.stringify(audit.data)).not.toContain(canary);
    const egressDir = join(wb.cwd, ".xanthil", "logs", "egress");
    for (const file of readdirSync(egressDir)) {
      expect(readFileSync(join(egressDir, file), "utf8").includes(canary)).toBe(
        false,
      );
    }
  } finally {
    await wb.close();
  }
});

test("upload safety: traversal names, bad extensions, oversize rejected (KA-M5-2)", {
  timeout: 60_000,
}, async () => {
  const wb = await startWorkbench();
  try {
    const traversal = await call(wb.url, "POST", "/api/datasets", {
      alias: "evil",
      filename: "../../etc/passwd.csv",
      contentB64: Buffer.from("a\n1\n").toString("base64"),
    });
    expect(traversal.status).toBe(400);

    const badExt = await call(wb.url, "POST", "/api/datasets", {
      alias: "evil2",
      filename: "payload.sh",
      contentB64: Buffer.from("a").toString("base64"),
    });
    expect(badExt.status).toBe(400);

    const huge = await call(wb.url, "POST", "/api/datasets", {
      alias: "big",
      filename: "big.csv",
      contentB64: "A".repeat(51 * 1024 * 1024),
    });
    expect(huge.status).toBeGreaterThanOrEqual(400);
  } finally {
    await wb.close();
  }
});

test("static UI is served from the workbench server", {
  timeout: 60_000,
}, async () => {
  const wb = await startWorkbench();
  try {
    const index = await fetch(`${wb.url}/`);
    expect(index.status).toBe(200);
    expect(await index.text()).toContain("Xanthil 本地分析工作台");
    const app = await fetch(`${wb.url}/app.js`);
    expect(app.status).toBe(200);
    const missing = await fetch(`${wb.url}/nope.js`);
    expect(missing.status).toBe(404);
  } finally {
    await wb.close();
  }
});
