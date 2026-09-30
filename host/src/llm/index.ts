import { UserError } from "../workspace.ts";
import { createCaller } from "./caller.ts";
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
    return createCaller({
      kind: "fixture",
      fixturePath: env.XANTHIL_LLM_FIXTURE,
    });
  }
  if (env.XANTHIL_LLM_BASE_URL && env.XANTHIL_LLM_MODEL) {
    return createCaller({
      kind: "openai-compatible",
      baseUrl: env.XANTHIL_LLM_BASE_URL,
      model: env.XANTHIL_LLM_MODEL,
      apiKey: env.XANTHIL_LLM_API_KEY ?? "",
    });
  }
  throw new UserError(
    "no model provider configured — set XANTHIL_LLM_BASE_URL/XANTHIL_LLM_MODEL/XANTHIL_LLM_API_KEY " +
      "for a real endpoint, or XANTHIL_LLM_FIXTURE for fixture replay",
  );
}
