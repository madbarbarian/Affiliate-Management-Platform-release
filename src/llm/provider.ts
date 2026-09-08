/**
 * The LLM port.
 *
 * Roles never touch the Anthropic SDK directly. They ask this port for either
 * free text or a value matching a JSON Schema, and get a `Result` back. That
 * keeps role code readable, lets the whole company run against a deterministic
 * fake in tests, and gives one place to account for token spend.
 */

import type { PlatformError, Result } from "../core/result.ts";
import type { JsonSchema } from "./schema.ts";

/**
 * Which model to use. `primary` is for judgement - research, planning,
 * inspection. `fast` is for mechanical transforms where a cheaper model is
 * indistinguishable.
 */
export type LlmTier = "primary" | "fast";

export type LlmUsage = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
};

export type LlmCallStats = LlmUsage & { readonly calls: number };

export type LlmRequest = {
  /** Stable across a cycle so the prompt prefix caches. */
  readonly system: string;
  readonly user: string;
  readonly tier?: LlmTier;
  readonly maxTokens?: number;
  /** Short label for logs and per-role cost attribution, e.g. "plan.ideas". */
  readonly purpose: string;
};

export type LlmJsonRequest = LlmRequest & {
  readonly schema: JsonSchema;
};

/**
 * Roles get the answer, not an envelope around it. Per-call model and token
 * counts are logged by the adapter and accumulated in `stats()`, which is
 * where cost reporting reads them - no role has ever needed them inline, and
 * making every call site unwrap twice to reach the value is not worth it.
 */
export type LlmProvider = {
  readonly name: string;
  completeText(request: LlmRequest): Promise<Result<string, PlatformError>>;
  completeJson<T>(request: LlmJsonRequest): Promise<Result<T, PlatformError>>;
  /** Cumulative usage since the provider was created. */
  stats(): LlmCallStats;
};

export const zeroUsage: LlmUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };

export function addUsage(a: LlmUsage, b: LlmUsage): LlmUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  };
}
