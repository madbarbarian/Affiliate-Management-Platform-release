/**
 * What the Anthropic adapter actually puts on the wire.
 *
 * The mock provider never sees a request body, so two fields that are gated on
 * the model were sent to every model for months. The second real day of running
 * ended at the first role call with:
 *
 *     400 "This model does not support the effort parameter."
 *
 * The cheap tier ships as `claude-haiku-4-5`, which rejects both
 * `output_config.effort` and `thinking: adaptive`. So this stands a real HTTP
 * server in front of the real SDK and reads the body it sends.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { silentLogger } from "../src/core/logger.ts";
import type { LlmConfig } from "../src/config/schema.ts";
import { createAnthropicProvider } from "../src/llm/anthropic.ts";
import { object, string } from "../src/llm/schema.ts";

type Body = Record<string, unknown>;

/** Enough of the streaming protocol for `finalMessage()` to resolve. */
const SSE = [
  `event: message_start\ndata: ${JSON.stringify({
    type: "message_start",
    message: {
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "test",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 7, output_tokens: 0 },
    },
  })}\n\n`,
  `event: content_block_start\ndata: ${JSON.stringify({
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  })}\n\n`,
  `event: content_block_delta\ndata: ${JSON.stringify({
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: '{"answer":"ok"}' },
  })}\n\n`,
  `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
  `event: message_delta\ndata: ${JSON.stringify({
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 4 },
  })}\n\n`,
  `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
].join("");

async function withApi(run: (baseUrl: string, sent: Body[]) => Promise<void>): Promise<void> {
  const sent: Body[] = [];
  const server: Server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      sent.push(JSON.parse(raw) as Body);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(SSE);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`, sent);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function llmConfig(baseUrl: string, overrides: Partial<LlmConfig> = {}): LlmConfig {
  return {
    provider: "anthropic",
    model: "claude-opus-5",
    fastModel: "claude-haiku-4-5",
    maxOutputTokens: 4096,
    effort: "high",
    fastEffort: "low",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    baseUrl,
    maxRetries: 0,
    requestTimeoutMs: 5000,
    ...overrides,
  };
}

const ask = { system: "You are a test.", user: "Say ok.", purpose: "test.call" };

/** `output_config.effort`, or undefined when the adapter left it out. */
function effortIn(body: Body): unknown {
  return (body["output_config"] as Body | undefined)?.["effort"];
}

test("the cheap tier's model gets no effort and no adaptive thinking", async () => {
  await withApi(async (baseUrl, sent) => {
    const provider = createAnthropicProvider({
      config: llmConfig(baseUrl),
      apiKey: "sk-test",
      logger: silentLogger,
    });
    const result = await provider.completeText({ ...ask, tier: "fast" });
    assert.equal(result.ok, true);

    const body = sent[0]!;
    assert.equal(body["model"], "claude-haiku-4-5");
    assert.equal(effortIn(body), undefined, "Haiku 4.5 answers effort with a 400");
    assert.equal(body["thinking"], undefined, "and adaptive thinking the same way");
    // Nothing else was going in it, so it should not be there at all.
    assert.equal("output_config" in body, false);
  });
});

test("the judgement tier still gets both, because that is what they are for", async () => {
  await withApi(async (baseUrl, sent) => {
    const provider = createAnthropicProvider({
      config: llmConfig(baseUrl),
      apiKey: "sk-test",
      logger: silentLogger,
    });
    assert.equal((await provider.completeText(ask)).ok, true);

    const body = sent[0]!;
    assert.equal(body["model"], "claude-opus-5");
    assert.equal(effortIn(body), "high");
    assert.deepEqual(body["thinking"], { type: "adaptive" });
  });
});

test("a model nobody has taught this adapter about is sent neither", async () => {
  // The safe direction: a model that would have taken effort and did not loses
  // some quality on that call. One that could not take it and was sent it loses
  // the whole cycle, in production.
  await withApi(async (baseUrl, sent) => {
    const provider = createAnthropicProvider({
      config: llmConfig(baseUrl, { model: "claude-someday-9", fastModel: "claude-someday-9-cheap" }),
      apiKey: "sk-test",
      logger: silentLogger,
    });
    assert.equal((await provider.completeText(ask)).ok, true);
    assert.equal((await provider.completeText({ ...ask, tier: "fast" })).ok, true);

    for (const body of sent) {
      assert.equal(effortIn(body), undefined, String(body["model"]));
      assert.equal(body["thinking"], undefined, String(body["model"]));
    }
  });
});

test("an effort level the model does not have is lowered, not sent", async () => {
  // Opus 4.5 stops at high. `effort: max` is a valid config value and a 400
  // there - the same lost cycle, from a setting the licensee was invited to set.
  await withApi(async (baseUrl, sent) => {
    const provider = createAnthropicProvider({
      config: llmConfig(baseUrl, { model: "claude-opus-4-5-20251101", effort: "max" }),
      apiKey: "sk-test",
      logger: silentLogger,
    });
    assert.equal((await provider.completeText(ask)).ok, true);

    const body = sent[0]!;
    assert.equal(effortIn(body), "high");
    assert.equal(body["thinking"], undefined, "Opus 4.5 predates adaptive thinking");
  });
});

test("structured output still asks for a schema on a model that refuses effort", async () => {
  // The two live in the same object. Dropping effort must not drop the format
  // with it, or every role goes back to parsing prose.
  await withApi(async (baseUrl, sent) => {
    const provider = createAnthropicProvider({
      config: llmConfig(baseUrl),
      apiKey: "sk-test",
      logger: silentLogger,
    });
    const result = await provider.completeJson<{ answer: string }>({
      ...ask,
      tier: "fast",
      schema: object({ answer: string("An answer.") }),
    });
    assert.equal(result.ok, true);

    const output = sent[0]!["output_config"] as Body;
    assert.equal(output["effort"], undefined);
    assert.equal((output["format"] as Body)["type"], "json_schema");
  });
});
