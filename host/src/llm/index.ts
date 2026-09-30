import { readFileSync } from "node:fs";
import { UserError } from "../workspace.ts";
import { FixtureCaller, type FixtureTurn } from "./fixture-caller.ts";
import { createPiCaller } from "./pi-caller.ts";
import type { ModelCaller } from "./types.ts";

/**
 * Assemble the model caller from the environment (G9):
 * - XANTHIL_LLM_FIXTURE=<path>       -> fixture replay (tests / offline demo)
 * - XANTHIL_LLM_BASE_URL + _MODEL    -> real pi-ai caller (key from XANTHIL_LLM_API_KEY)
 * - neither                          -> fail with guidance; no silent fallback
 */
export function createCallerFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ModelCaller {
  if (env.XANTHIL_LLM_FIXTURE) {
    let raw: string;
    try {
      raw = readFileSync(env.XANTHIL_LLM_FIXTURE, "utf8");
    } catch {
      throw new UserError(
        `cannot read fixture file: ${env.XANTHIL_LLM_FIXTURE}`,
      );
    }
    const turns: FixtureTurn[] = raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => ({ response: line }));
    return new FixtureCaller(turns, `${env.XANTHIL_LLM_FIXTURE}.consumed`);
  }
  if (env.XANTHIL_LLM_BASE_URL && env.XANTHIL_LLM_MODEL) {
    return createPiCaller({
      baseUrl: env.XANTHIL_LLM_BASE_URL,
      model: env.XANTHIL_LLM_MODEL,
    });
  }
  throw new UserError(
    "no model provider configured — set XANTHIL_LLM_BASE_URL/XANTHIL_LLM_MODEL/XANTHIL_LLM_API_KEY " +
      "for a real endpoint, or XANTHIL_LLM_FIXTURE for fixture replay",
  );
}
