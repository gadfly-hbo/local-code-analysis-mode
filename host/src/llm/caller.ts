/**
 * Param-based model caller construction (J2). The env-based assembler in
 * llm/index.ts wraps this. Credentials live only inside the caller instance.
 */

import { readFileSync } from "node:fs";
import { UserError } from "../workspace.ts";
import { FixtureCaller, type FixtureTurn } from "./fixture-caller.ts";
import { createPiCaller } from "./pi-caller.ts";
import type { ModelCaller } from "./types.ts";

export type ModelCallerParams =
  | { kind: "fixture"; fixturePath: string }
  | {
      kind: "openai-compatible";
      baseUrl: string;
      model: string;
      apiKey: string;
    };

function readFixtureTurns(fixturePath: string): FixtureTurn[] {
  let raw: string;
  try {
    raw = readFileSync(fixturePath, "utf8");
  } catch {
    throw new UserError(`cannot read fixture file: ${fixturePath}`);
  }
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => ({ response: line }));
}

export function createCaller(params: ModelCallerParams): ModelCaller {
  if (params.kind === "fixture") {
    return new FixtureCaller(
      readFixtureTurns(params.fixturePath),
      `${params.fixturePath}.consumed`,
    );
  }
  // apiKey is used only to configure the pi-ai caller below; it never reaches
  // disk, the audit store, or the worker environment.
  return createPiCaller({
    baseUrl: params.baseUrl,
    model: params.model,
    apiKey: params.apiKey,
  });
}
