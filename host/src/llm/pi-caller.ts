/**
 * pi-ai backed model caller for OpenAI-compatible endpoints (e.g. GLM).
 * This is the ONLY module that imports @earendil-works/* (AGENT-RUNTIME
 * §4.1): provider quirks stay here, business code sees ModelCaller.
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
}

export function createPiCaller(config: PiCallerConfig): ModelCaller {
  const model: Model<"openai-completions"> = {
    provider: "xanthil",
    id: config.model,
    name: config.model,
    api: "openai-completions",
    baseUrl: config.baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
  };

  const provider: Provider<"openai-completions"> = createProvider({
    id: "xanthil",
    baseUrl: config.baseUrl,
    auth: { apiKey: envApiKeyAuth("Xanthil LLM", ["XANTHIL_LLM_API_KEY"]) },
    models: [model],
    api: {
      "openai-completions": {
        stream: openaiCompletionsStream,
        streamSimple: openaiCompletionsStreamSimple,
      },
    },
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
      const stream = provider.streamSimple(model, context);
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
