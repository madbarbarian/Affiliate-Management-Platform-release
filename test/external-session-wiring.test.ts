/**
 * `buildLlm` and the real assembly: which provider a config gets, and what is
 * said when its environment is wrong.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { fixedClock } from "../src/core/clock.ts";
import { sequentialIds } from "../src/core/ids.ts";
import { createLogger, silentLogger } from "../src/core/logger.ts";
import { EXTERNAL_SESSION_ERROR } from "../src/llm/external-session.ts";
import { advancingClock } from "./helpers.ts";
import { buildLlm, type BuildLlmDeps } from "../src/kernel/assemble.ts";
import { memoryState } from "../src/kernel/state.ts";
import { EXTERNAL_SESSION_ENV_ERROR_CODE } from "../src/llm/external-session-env.ts";
import { BASE_CONFIG, testConfig } from "./helpers.ts";

const GOOD_ENV = {
  AMP_EXTERNAL_SESSION_BASE_URL: "https://amp-test.example.workers.dev",
  AMP_EXTERNAL_SESSION_TOKEN: "job-token",
  AMP_EXTERNAL_SESSION_ROUTINE_FIRE_URL: "https://api.anthropic.com/v1/claude_code/routines/r-1/fire",
  AMP_EXTERNAL_SESSION_ROUTINE_TOKEN: "sk-ant-oat01-fake",
};

function deps(wallLimited = false): BuildLlmDeps {
  return { state: memoryState(), clock: fixedClock("2026-09-30T00:00:00Z"), ids: sequentialIds(), wallLimited };
}

function externalConfig() {
  return testConfig({ llm: { ...BASE_CONFIG.llm, provider: "external-session", externalSession: { enabled: true } } });
}

test("external-session with a complete environment builds that provider, with no Anthropic key needed", () => {
  const result = buildLlm(externalConfig(), GOOD_ENV, silentLogger, false, deps());
  assert.ok(result.ok, result.ok ? "" : result.error.message);
  assert.equal(result.ok && result.value.name, "external-session");
});

test("external-session with nothing set names every variable in one error, and is not the API-key error", () => {
  const result = buildLlm(externalConfig(), {}, silentLogger, false, deps());
  assert.ok(!result.ok);
  if (result.ok) return;
  assert.equal(result.error.code, EXTERNAL_SESSION_ENV_ERROR_CODE);
  assert.notEqual(result.error.code, "llm.no_api_key");
  assert.match(result.error.message, /AMP_EXTERNAL_SESSION_BASE_URL is not set/);
  assert.match(result.error.message, /AMP_EXTERNAL_SESSION_ROUTINE_TOKEN is not set/);
  assert.doesNotMatch(result.error.message, /ANTHROPIC_API_KEY/);
});

test("a dry run never needs the external variables: it is the mock, whatever the config says", () => {
  const result = buildLlm(externalConfig(), {}, silentLogger, true, deps());
  assert.ok(result.ok);
  assert.equal(result.ok && result.value.name, "mock");
});

test("anthropic and mock configs are unaffected: they do not ask for the external variables", () => {
  const mock = buildLlm(testConfig(), {}, silentLogger, false, deps());
  assert.equal(mock.ok && mock.value.name, "mock");
  const anthropic = buildLlm(testConfig({ llm: { ...BASE_CONFIG.llm, provider: "anthropic" } }), {}, silentLogger, false, deps());
  assert.ok(!anthropic.ok);
  assert.equal(anthropic.ok ? "" : anthropic.error.code, "llm.no_api_key");
});

test("the provider says whether a wait budget applies on this host: on the Worker yes, on Node no", () => {
  // The flag is otherwise invisible from outside; the build's own warning is
  // where an operator (and the Worker test in test/worker.test.ts) can see it.
  const said = (wallLimited: boolean): string => {
    const lines: string[] = [];
    const logger = createLogger({ level: "debug", sink: (entry) => void lines.push(entry.message) });
    assert.ok(buildLlm(externalConfig(), GOOD_ENV, logger, false, deps(wallLimited)).ok);
    return lines.join("\n");
  };
  assert.match(said(true), /at most 600 s of waiting per invocation/);
  assert.match(said(false), /no wait budget \(this host has no wall cap\)/);
});

test("the provider a config builds writes its jobs into the state store it was given", async () => {
  const state = memoryState();
  const calls: string[] = [];
  const built = buildLlm(externalConfig(), GOOD_ENV, silentLogger, false, {
    state,
    clock: fixedClock("2026-09-30T00:00:00Z"),
    ids: sequentialIds(),
    wallLimited: false,
    fetch: async (url) => {
      calls.push(url);
      return new Response("{}", { status: 500 });
    },
  });
  assert.ok(built.ok);
  if (!built.ok) return;
  const result = await built.value.completeText({ system: "s", user: "u", purpose: "test.wire" });
  assert.equal(result.ok, false, "the fire was refused, so the call fails");
  assert.deepEqual(calls, [GOOD_ENV.AMP_EXTERNAL_SESSION_ROUTINE_FIRE_URL]);
  // The job was written to *this* state, then tombstoned when the fire failed.
  const slot = state.read("external-session-job");
  assert.equal(slot.kind, "text");
  assert.match(slot.kind === "text" ? slot.text : "", /"discardedAt"/);
});

test("on the Worker the provider's run starts when it is built, so time before the first call is spent from the budget; on Node it is not", async () => {
  // The flag is wired here, not left to each caller: a Worker invocation builds
  // its runtime once, and everything it does before the first model call runs
  // on the same wall clock the host kills it by.
  const firstCall = async (wallLimited: boolean) => {
    const clock = advancingClock("2026-09-30T00:00:00Z");
    const fired: string[] = [];
    const built = buildLlm(externalConfig(), GOOD_ENV, silentLogger, false, {
      state: memoryState(),
      clock,
      ids: sequentialIds(),
      wallLimited,
      fetch: async (url) => {
        fired.push(url);
        return new Response("{}", { status: 500 });
      },
    });
    assert.ok(built.ok);
    if (!built.ok) throw new Error("unreachable");
    clock.advance(externalConfig().llm.externalSession.invocationBudgetMs);
    const result = await built.value.completeText({ system: "s", user: "u", purpose: "test.wire" });
    return { code: result.ok ? "ok" : result.error.code, fired: fired.length };
  };
  assert.deepEqual(await firstCall(true), { code: EXTERNAL_SESSION_ERROR.budgetExhausted, fired: 0 });
  assert.deepEqual(await firstCall(false), { code: EXTERNAL_SESSION_ERROR.fireRefused, fired: 1 });
});
