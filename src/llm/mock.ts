/**
 * A deterministic stand-in for the model.
 *
 * Two jobs. In tests it lets a whole cycle run without a network call, with
 * per-purpose scripted answers where a test cares about specific content. In
 * production it backs `llm.provider: mock`, so a licensee can walk the entire
 * pipeline - gates, console, scheduling, tracking links - before they have an
 * API key, and see the shape of what the company will hand them.
 *
 * Unscripted requests are answered by synthesizing a value that satisfies the
 * requested schema. The result is obviously placeholder text, on purpose: a
 * dry run should never be mistaken for real output.
 */

import { ok, type PlatformError, type Result } from "../core/result.ts";
import {
  addUsage,
  zeroUsage,
  type LlmCallStats,
  type LlmJsonRequest,
  type LlmProvider,
  type LlmRequest,
  type LlmUsage,
} from "./provider.ts";
import type { JsonSchema } from "./schema.ts";

export type MockHandler = (request: LlmJsonRequest | LlmRequest) => unknown;

export type MockProviderOptions = {
  /**
   * Scripted answers keyed by `purpose`. An exact match wins; otherwise the
   * longest key that is a prefix of the purpose is used.
   */
  readonly responses?: Record<string, MockHandler>;
  readonly model?: string;
};

export type MockProvider = LlmProvider & {
  /** Every request the provider saw, in order. Useful for assertions. */
  readonly calls: { purpose: string; system: string; user: string }[];
};

export function createMockProvider(options: MockProviderOptions = {}): MockProvider {
  const responses = options.responses ?? {};
  const model = options.model ?? "mock-model";
  const calls: { purpose: string; system: string; user: string }[] = [];
  let totals: LlmUsage = zeroUsage;

  const record = (request: LlmRequest): LlmUsage => {
    calls.push({ purpose: request.purpose, system: request.system, user: request.user });
    const usage: LlmUsage = {
      inputTokens: Math.ceil((request.system.length + request.user.length) / 4),
      outputTokens: 128,
      cacheReadTokens: 0,
    };
    totals = addUsage(totals, usage);
    return usage;
  };

  const scripted = (purpose: string): MockHandler | undefined => {
    if (responses[purpose]) return responses[purpose];
    const prefixes = Object.keys(responses)
      .filter((key) => purpose.startsWith(key))
      .sort((a, b) => b.length - a.length);
    return prefixes[0] ? responses[prefixes[0]] : undefined;
  };

  return {
    name: "mock",
    calls,

    async completeText(request: LlmRequest): Promise<Result<string, PlatformError>> {
      record(request);
      const handler = scripted(request.purpose);
      return ok(handler ? String(handler(request)) : `[mock:${request.purpose}]`);
    },

    async completeJson<T>(request: LlmJsonRequest): Promise<Result<T, PlatformError>> {
      record(request);
      const handler = scripted(request.purpose);
      return ok(
        handler ? (handler(request) as T) : (synthesize(request.schema, new Counter(request.purpose)) as T),
      );
    },

    stats(): LlmCallStats {
      return { ...totals, calls: calls.length };
    },
  };
}

/** Produces stable, human-legible placeholder values from a property path. */
class Counter {
  #seed: string;
  #n = 0;
  constructor(seed: string) {
    this.#seed = seed;
  }
  next(): number {
    this.#n += 1;
    return this.#n;
  }
  label(path: string): string {
    return `[mock ${this.#seed}${path ? ` ${path}` : ""} #${this.next()}]`;
  }
}

function synthesize(schema: JsonSchema, counter: Counter, path = ""): unknown {
  const type = schema["type"];
  const enumValues = schema["enum"];
  if (Array.isArray(enumValues) && enumValues.length > 0) return enumValues[0];

  switch (type) {
    case "object": {
      const properties = (schema["properties"] ?? {}) as Record<string, JsonSchema>;
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(properties)) {
        out[key] = synthesize(child, counter, path ? `${path}.${key}` : key);
      }
      return out;
    }
    case "array": {
      const items = (schema["items"] ?? { type: "string" }) as JsonSchema;
      const min = typeof schema["minItems"] === "number" ? schema["minItems"] : 0;
      const max = typeof schema["maxItems"] === "number" ? schema["maxItems"] : Number.POSITIVE_INFINITY;
      // Three is enough to look like a list rather than a special case, which
      // matters when the output is being eyeballed in a dry run.
      const count = Math.min(max, Math.max(min, 3));
      return Array.from({ length: count }, () => synthesize(items, counter, `${path}[]`));
    }
    case "integer":
      return clampToRange(counter.next(), schema, true);
    case "number":
      return clampToRange(counter.next() / 2, schema, false);
    case "boolean":
      return true;
    default:
      return counter.label(path);
  }
}

function clampToRange(value: number, schema: JsonSchema, integer: boolean): number {
  const min = typeof schema["minimum"] === "number" ? schema["minimum"] : undefined;
  const max = typeof schema["maximum"] === "number" ? schema["maximum"] : undefined;
  let out = value;
  if (min !== undefined && out < min) out = min;
  if (max !== undefined && out > max) out = max;
  return integer ? Math.round(out) : out;
}
