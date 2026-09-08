/**
 * The Anthropic implementation of the LLM port.
 *
 * Notes that matter for anyone editing this file:
 *  - Current Claude models take `output_config.effort` instead of a sampling
 *    temperature; sending `temperature` to the Opus 5 family is a 400.
 *  - Adaptive thinking is on by default for the primary tier. Roles here do
 *    real judgement work (is this pattern reproducible? does this read like a
 *    human wrote it?) and thinking measurably helps.
 *  - Every call streams. Output caps are configurable up to 64K and a
 *    non-streaming request that large risks an HTTP timeout.
 *  - Structured output uses `output_config.format` with a JSON Schema, so a
 *    role never has to defend itself against prose wrapped around JSON.
 */

import Anthropic from "@anthropic-ai/sdk";

import { fail, ok, type PlatformError, type Result } from "../core/result.ts";
import type { Logger } from "../core/logger.ts";
import type { LlmConfig } from "../config/schema.ts";
import {
  addUsage,
  zeroUsage,
  type LlmCallStats,
  type LlmJsonRequest,
  type LlmProvider,
  type LlmRequest,
  type LlmUsage,
} from "./provider.ts";

export type AnthropicProviderOptions = {
  readonly config: LlmConfig;
  readonly apiKey: string;
  readonly logger: Logger;
};

export function createAnthropicProvider(options: AnthropicProviderOptions): LlmProvider {
  const { config, apiKey, logger } = options;
  const client = new Anthropic({
    apiKey,
    baseURL: config.baseUrl,
    maxRetries: config.maxRetries,
    timeout: config.requestTimeoutMs,
  });

  let totals: LlmUsage = zeroUsage;
  let calls = 0;

  const resolve = (request: LlmRequest) => {
    const fast = request.tier === "fast";
    return {
      model: fast ? config.fastModel : config.model,
      effort: fast ? config.fastEffort : config.effort,
      maxTokens: request.maxTokens ?? config.maxOutputTokens,
      thinking: fast ? undefined : ({ type: "adaptive" } as const),
    };
  };

  const send = async (
    request: LlmRequest,
    format?: Anthropic.JSONOutputFormat,
  ): Promise<Result<string, PlatformError>> => {
    const resolved = resolve(request);
    const started = Date.now();
    try {
      const stream = client.messages.stream({
        model: resolved.model,
        max_tokens: resolved.maxTokens,
        // The system prompt is the venture brief: stable for a whole cycle, so
        // caching it turns six role calls into one paid prefix.
        system: request.system,
        cache_control: { type: "ephemeral" },
        ...(resolved.thinking ? { thinking: resolved.thinking } : {}),
        output_config: {
          effort: resolved.effort,
          ...(format ? { format } : {}),
        },
        messages: [{ role: "user", content: request.user }],
      });

      const message = await stream.finalMessage();
      calls += 1;
      const usage: LlmUsage = {
        inputTokens: message.usage.input_tokens ?? 0,
        outputTokens: message.usage.output_tokens ?? 0,
        cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
      };
      totals = addUsage(totals, usage);

      logger.debug("llm call", {
        purpose: request.purpose,
        model: message.model,
        ms: Date.now() - started,
        in: usage.inputTokens,
        out: usage.outputTokens,
        cached: usage.cacheReadTokens,
      });

      if (message.stop_reason === "refusal") {
        return fail(
          "llm",
          "llm.refusal",
          `The model declined this request${message.stop_details ? ` (${message.stop_details.category ?? "unspecified"})` : ""}. ` +
            `Review the prompt for ${request.purpose}.`,
          { retryable: false, details: { purpose: request.purpose } },
        );
      }

      const text = message.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("");

      if (text.trim() === "") {
        return fail("llm", "llm.empty_response", `The model returned no text for ${request.purpose}.`, {
          retryable: true,
          details: { stopReason: message.stop_reason },
        });
      }

      if (message.stop_reason === "max_tokens") {
        return fail(
          "llm",
          "llm.truncated",
          `Output hit the ${resolved.maxTokens}-token cap for ${request.purpose}. ` +
            `Raise llm.maxOutputTokens or ask for less in one call.`,
          { retryable: false },
        );
      }

      return ok(text);
    } catch (cause) {
      return translateError(cause, request.purpose);
    }
  };

  return {
    name: "anthropic",

    async completeText(request) {
      return send(request);
    },

    async completeJson<T>(request: LlmJsonRequest): Promise<Result<T, PlatformError>> {
      const response = await send(request, { type: "json_schema", schema: request.schema });
      if (!response.ok) return response;
      try {
        return ok(JSON.parse(response.value) as T);
      } catch (cause) {
        // Schema-constrained output should never land here; if it does, the
        // response is worth surfacing verbatim rather than guessing at a fix.
        return fail("llm", "llm.invalid_json", `Structured output for ${request.purpose} was not valid JSON.`, {
          retryable: true,
          details: { excerpt: response.value.slice(0, 400) },
          cause,
        });
      }
    },

    stats(): LlmCallStats {
      return { ...totals, calls };
    },
  };
}

/** Maps SDK exceptions onto the platform's error vocabulary. */
function translateError(cause: unknown, purpose: string): Result<never, PlatformError> {
  if (cause instanceof Anthropic.AuthenticationError) {
    return fail("config", "llm.auth", "The Anthropic API key was rejected. Check the key named by llm.apiKeyEnv.", {
      retryable: false,
      cause,
    });
  }
  if (cause instanceof Anthropic.RateLimitError) {
    return fail("llm", "llm.rate_limited", `Rate limited while running ${purpose}.`, { retryable: true, cause });
  }
  if (cause instanceof Anthropic.BadRequestError) {
    return fail("llm", "llm.bad_request", `The API rejected the ${purpose} request: ${cause.message}`, {
      retryable: false,
      cause,
    });
  }
  if (cause instanceof Anthropic.APIConnectionError) {
    return fail("network", "llm.connection", `Could not reach the Anthropic API while running ${purpose}.`, {
      retryable: true,
      cause,
    });
  }
  if (cause instanceof Anthropic.APIError) {
    return fail("llm", "llm.api_error", `Anthropic API error ${cause.status ?? "?"} during ${purpose}: ${cause.message}`, {
      retryable: (cause.status ?? 0) >= 500,
      cause,
    });
  }
  const message = cause instanceof Error ? cause.message : String(cause);
  return fail("llm", "llm.unknown", `Unexpected failure during ${purpose}: ${message}`, { retryable: false, cause });
}
