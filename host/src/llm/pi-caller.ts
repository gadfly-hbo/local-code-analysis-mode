/**
 * pi-ai backed model caller for OpenAI-compatible AND Anthropic-compatible
 * endpoints (e.g. GLM /api/paas/v4 and /api/anthropic). The API family is
 * selected from the base URL. This is the ONLY module that imports
 * @earendil-works/* (AGENT-RUNTIME §4.1): provider quirks stay here, business
 * code sees ModelCaller.
 */
import {
  contentText,
  createProvider,
  envApiKeyAuth,
  type Model,
  type Provider,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  stream as anthropicMessagesStream,
  streamSimple as anthropicMessagesStreamSimple,
} from "@earendil-works/pi-ai/api/anthropic-messages";
import {
  stream as openaiCompletionsStream,
  streamSimple as openaiCompletionsStreamSimple,
} from "@earendil-works/pi-ai/api/openai-completions";
import { UserError } from "../workspace.ts";
import type {
  ModelCaller,
  ModelCallRequest,
  ModelCallResult,
} from "./types.ts";

export interface PiCallerConfig {
  baseUrl: string;
  model: string;
  /** Literal key (param-injected callers). When absent, env auth is used. */
  apiKey?: string;
}

function isAnthropicStyle(baseUrl: string): boolean {
  return /\/anthropic\/?$/.test(baseUrl);
}

export function createPiCaller(config: PiCallerConfig): ModelCaller {
  const anthropicStyle = isAnthropicStyle(config.baseUrl);
  const apiFamily = anthropicStyle
    ? "anthropic-messages"
    : "openai-completions";
  const model: Model<"openai-completions" | "anthropic-messages"> = {
    provider: "xanthil",
    id: config.model,
    name: config.model,
    api: apiFamily,
    baseUrl: config.baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
  };

  const provider: Provider<"openai-completions" | "anthropic-messages"> =
    createProvider({
      id: "xanthil",
      baseUrl: config.baseUrl,
      auth: {
        apiKey: config.apiKey
          ? {
              name: "Xanthil LLM",
              // Literal-key auth: resolve() returns a fixed credential so the
              // key NEVER transits process.env (P0 fix, §8.2).
              resolve: async () => ({
                auth: {
                  apiKey: config.apiKey as string,
                  baseUrl: config.baseUrl,
                },
                source: "injected",
              }),
            }
          : envApiKeyAuth("Xanthil LLM", ["XANTHIL_LLM_API_KEY"]),
      },
      models: [model],
      api: anthropicStyle
        ? ({
            "anthropic-messages": {
              stream: anthropicMessagesStream,
              streamSimple: anthropicMessagesStreamSimple,
            },
          } as const)
        : ({
            "openai-completions": {
              stream: openaiCompletionsStream,
              streamSimple: openaiCompletionsStreamSimple,
            },
          } as const),
    });

  return {
    name: `pi:${config.model}`,
    async call(request: ModelCallRequest): Promise<ModelCallResult> {
      const context = {
        systemPrompt: request.system,
        messages: [
          { role: "user", content: [{ type: "text", text: request.user }] },
        ],
      } as unknown as TranscriptContext;
      // pi-ai's API modules take the key from PER-CALL options (provider.auth
      // is only applied by the Models layer, which we bypass). Resolve it here:
      // literal injected key first, env fallback for the env-config path.
      const apiKey = config.apiKey ?? process.env.XANTHIL_LLM_API_KEY ?? "";
      const stream = provider.streamSimple(model, context, { apiKey });
      const message = await stream.result();
      if (message.stopReason === "error") {
        // pi-ai swallows provider errors into stopReason=error — rethrow (§10).
        throw new UserError(
          `model provider error: ${contentText(message.content).slice(0, 300)}`,
        );
      }
      return {
        text: contentText(message.content),
        stopReason: message.stopReason,
      };
    },
  };
}
