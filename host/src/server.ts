/**
 * Local web workbench server (M5): node:http, zero new dependencies.
 * All model calls go through the adapter (createXanthilCore) — the UI is an
 * operation surface, never a second egress boundary (KA-M5-1). Binds
 * 127.0.0.1 only (W5).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { basename, join } from "node:path";
import { createXanthilCore, type XanthilCore } from "./adapter/xanthil-core.ts";
import { createCaller, type ModelCallerParams } from "./llm/caller.ts";
import { loadPolicy } from "./policy.ts";
import { listSkills } from "./skills.ts";
import {
  initWorkspace,
  openWorkspace,
  resolveWorkspacePath,
  UserError,
} from "./workspace.ts";

export interface ServeOptions {
  workspaceDir: string;
  port: number;
  host?: string;
  model?: ModelCallerParams;
}

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const ALLOWED_EXTENSIONS = [".csv", ".xlsx", ".parquet"];

function sanitizeFilename(name: string): string {
  if (name !== basename(name)) {
    throw new UserError("filename must not contain path separators");
  }
  const cleaned = basename(name).replace(/[^A-Za-z0-9._-]/g, "_");
  if (!ALLOWED_EXTENSIONS.some((ext) => cleaned.toLowerCase().endsWith(ext))) {
    throw new UserError(
      `unsupported file type "${cleaned}" — allowed: ${ALLOWED_EXTENSIONS.join(", ")}`,
    );
  }
  return cleaned;
}

function parseJsonBody(buf: Buffer): Record<string, unknown> {
  try {
    return JSON.parse(buf.toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new UserError("request body is not valid JSON");
  }
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > MAX_UPLOAD_BYTES) {
      throw new UserError(
        `upload exceeds ${MAX_UPLOAD_BYTES / 1024 / 1024}MB limit`,
      );
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

interface Route {
  method: string;
  pattern: RegExp;
  handler: (
    req: IncomingMessage,
    res: ServerResponse,
    params: string[],
    core: XanthilCore,
    ctx: ServeOptions,
  ) => Promise<void> | void;
}

const routes: Route[] = [
  {
    method: "GET",
    pattern: /^\/api\/state$/,
    handler: (_req, res, _p, core) => {
      json(res, 200, {
        datasets: core.datasets.list(),
        tasks: core.tasks.list(),
        publications: core.publications.list(),
        audit: core.audit.modelCalls().slice(-5),
        skills: listSkills(),
        sandbox: cachedSandboxStatus(core),
        policy: loadPolicyWs(core),
        model: modelSummary(
          CURRENT_MODEL ?? { kind: "fixture", fixturePath: "/dev/null" },
        ),
      });
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/datasets$/,
    handler: async (req, res, _p, core, ctx) => {
      const body = parseJsonBody(await readBody(req)) as {
        alias: string;
        filename: string;
        contentB64: string;
      };
      const filename = sanitizeFilename(body.filename);
      const content = Buffer.from(body.contentB64, "base64");
      if (content.length === 0) {
        throw new UserError("empty upload");
      }
      const dir = join(core.workspace.root, "datasets");
      mkdirSync(dir, { recursive: true });
      const path = join(dir, filename);
      writeFileSync(path, content);
      const registered = core.datasets.register(path, body.alias);
      const profiled = core.schema.profile(body.alias);
      json(res, 200, {
        registered,
        profile: profiled.profile,
        card_draft_path: profiled.card_draft_path,
      });
      void ctx;
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/schema$/,
    handler: async (req, res, _p, core) => {
      const body = parseJsonBody(await readBody(req)) as {
        alias: string;
        card: Record<string, unknown>;
      };
      if (!/^[a-z][a-z0-9_-]*$/.test(body.alias)) {
        throw new UserError(`invalid alias "${body.alias}"`);
      }
      // Write the edited card as YAML over the draft, then approve through
      // the SAME validation the CLI uses.
      const yaml = await import("yaml");
      const wsRoot = core.workspace.root as string;
      const draftPath = join(wsRoot, "datasets", `${body.alias}.schema.yaml`);
      writeFileSync(draftPath, yaml.default.stringify(body.card));
      json(res, 200, core.schema.approve(body.alias, draftPath));
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/ask$/,
    handler: async (req, res, _p, core) => {
      const body = parseJsonBody(await readBody(req)) as {
        goal: string;
        datasets: string[];
      };
      const task = await core.tasks.ask(body.goal, body.datasets);
      json(res, 200, task);
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/skill-run$/,
    handler: async (req, res, _p, core) => {
      const body = parseJsonBody(await readBody(req)) as {
        skill: string;
        dataset: string;
        params: Record<string, string>;
      };
      json(
        res,
        200,
        core.skills.run(body.skill, { ...body.params, dataset: body.dataset }),
      );
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/tasks\/([^/]+)\/(confirm|run|cancel)$/,
    handler: async (_req, res, params, core) => {
      const id = params[0];
      const action = params[1];
      if (!id || !action) {
        throw new UserError("bad task route");
      }
      if (action === "confirm") {
        json(res, 200, core.tasks.confirm(id));
      } else if (action === "cancel") {
        json(res, 200, core.tasks.cancel(id));
      } else {
        const run = await core.tasks.run(id);
        json(res, 200, { ...run, artifacts: core.artifacts.list(id) });
      }
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/tasks\/([^/]+)$/,
    handler: (_req, res, params, core) => {
      json(res, 200, core.tasks.get(params[0] ?? ""));
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/tasks\/([^/]+)\/artifacts$/,
    handler: (_req, res, params, core) => {
      json(res, 200, core.artifacts.list(params[0] ?? ""));
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/artifacts\/([^/]+)\/raw$/,
    handler: (_req, res, params, core) => {
      const artifact = core.artifacts.get(params[0] ?? "");
      if (artifact.type === "chart") {
        const bytes = readFileSync(artifact.path);
        res.writeHead(200, {
          "content-type": "image/png",
          "content-length": bytes.length,
        });
        res.end(bytes);
        return;
      }
      const text = readFileSync(artifact.path, "utf8");
      json(res, 200, { text });
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/artifacts\/([^/]+)\/export$/,
    handler: async (req, res, params, core) => {
      const body = parseJsonBody(await readBody(req)) as {
        outPath: string;
      };
      json(res, 200, core.artifacts.export(params[0] ?? "", body.outPath));
    },
  },
  {
    // J8: plan OBJECT entry (the UI never manages files).
    method: "POST",
    pattern: /^\/api\/publications\/object$/,
    handler: async (req, res, _p, core) => {
      const body = parseJsonBody(await readBody(req)) as {
        plan: Record<string, unknown>;
      };
      json(res, 200, core.publications.prepare(body.plan));
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/publications\/([^/]+)$/,
    handler: (_req, res, params, core) => {
      const id = params[0] ?? "";
      let payload: unknown = null;
      try {
        payload = JSON.parse(core.publications.payload(id));
      } catch {
        payload = null;
      }
      json(res, 200, { ...core.publications.get(id), payload });
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/publications\/([^/]+)\/(approve|send|revoke)$/,
    handler: async (_req, res, params, core) => {
      const id = params[0];
      const action = params[1];
      if (!id || !action) {
        throw new UserError("bad publication route");
      }
      if (action === "approve") {
        json(res, 200, core.publications.approve(id));
      } else if (action === "revoke") {
        json(res, 200, { revoked: core.publications.revoke(id) });
      } else {
        json(res, 200, await core.publications.send(id));
      }
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/audit$/,
    handler: (_req, res, _p, core) => {
      json(res, 200, core.audit.modelCalls());
    },
  },
];

let SANDBOX_CACHE: { at: number; status: string } | null = null;

function cachedSandboxStatus(core: XanthilCore): string {
  if (SANDBOX_CACHE && Date.now() - SANDBOX_CACHE.at < 60_000) {
    return SANDBOX_CACHE.status;
  }
  try {
    const status = core.sandbox.selfCheck().passed ? "passed" : "failed";
    SANDBOX_CACHE = { at: Date.now(), status };
    return status;
  } catch {
    return "unavailable";
  }
}

function loadPolicyWs(core: XanthilCore): unknown {
  try {
    return loadPolicy(openWorkspace(core.workspace.root));
  } catch {
    return null;
  }
}

let CURRENT_MODEL: ModelCallerParams | null = null;

function modelSummary(model: ModelCallerParams): string {
  if (model.kind === "fixture") {
    return model.fixturePath === "/dev/null"
      ? "未配置（仅 Skill 可用）"
      : "fixture";
  }
  return `${model.model} @ ${model.baseUrl}`;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

function serveStatic(
  res: ServerResponse,
  urlPath: string,
  publicDir: string,
): boolean {
  const rel = urlPath === "/" ? "index.html" : urlPath.slice(1);
  if (rel.includes("..")) {
    json(res, 400, { error: "bad path" });
    return true;
  }
  try {
    const bytes = readFileSync(join(publicDir, rel));
    const ext = rel.slice(rel.lastIndexOf("."));
    res.writeHead(200, {
      "content-type": MIME[ext] ?? "application/octet-stream",
      "content-length": bytes.length,
    });
    res.end(bytes);
    return true;
  } catch {
    return false;
  }
}

export function startWorkbenchServer(options: ServeOptions): {
  server: ReturnType<typeof createServer>;
  url: string;
  close: () => Promise<void>;
} {
  const root = resolveWorkspacePath(options.workspaceDir);
  try {
    initWorkspace(root);
  } catch {
    // existing workspace — open below
  }
  openWorkspace(root); // validate
  const model: ModelCallerParams =
    options.model ??
    (process.env.XANTHIL_LLM_FIXTURE
      ? { kind: "fixture", fixturePath: process.env.XANTHIL_LLM_FIXTURE }
      : process.env.XANTHIL_LLM_BASE_URL &&
          process.env.XANTHIL_LLM_MODEL &&
          process.env.XANTHIL_LLM_API_KEY
        ? {
            kind: "openai-compatible",
            baseUrl: process.env.XANTHIL_LLM_BASE_URL,
            model: process.env.XANTHIL_LLM_MODEL,
            apiKey: process.env.XANTHIL_LLM_API_KEY,
          }
        : { kind: "fixture", fixturePath: "/dev/null" });
  void createCaller; // credentials only live inside the core's caller
  CURRENT_MODEL = model;
  const core = createXanthilCore({ workspaceDir: options.workspaceDir, model });
  const publicDir = join(import.meta.dirname, "..", "public");
  const host = options.host ?? "127.0.0.1";

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      for (const route of routes) {
        if (req.method !== route.method) continue;
        const match = route.pattern.exec(url.pathname);
        if (!match) continue;
        await route.handler(req, res, match.slice(1), core, options);
        return;
      }
      if (req.method === "GET" && serveStatic(res, url.pathname, publicDir)) {
        return;
      }
      json(res, 404, { error: `no route: ${req.method} ${url.pathname}` });
    } catch (error) {
      if (error instanceof UserError) {
        json(res, 400, { error: error.message });
      } else {
        json(res, 500, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  });

  const close = () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
    });

  return {
    server,
    url: `http://${host}:${options.port}`,
    close: () => {
      void core;
      return close();
    },
  };
}

export function listen(
  server: ReturnType<typeof createServer>,
  port: number,
  host: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
}
