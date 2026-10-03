/**
 * `scripts/external-session-harness.ts`'s pure decision logic: reading its
 * environment, and interpreting the responses `src/console/router.ts`'s
 * external-session routes document, without any real network call.
 *
 * The harness itself is meant to run by hand against real infrastructure
 * (`docs/3-development/external-generation-design.md`, Phase 1a), so nothing
 * here starts a server or calls a network - only the pure "given this input,
 * decide what to do" functions are exercised, per the script's own
 * decision/I-O split.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildGreetingJob,
  decideFinalOutcome,
  exitCodeForFinalOutcome,
  interpretCreateJobResponse,
  interpretFireResponse,
  interpretPollResponse,
  nextPollStep,
  readHarnessConfig,
} from "../scripts/external-session-harness.ts";

const FULL_ENV = {
  AMP_EXTERNAL_SESSION_BASE_URL: "https://amp-test.example.workers.dev",
  AMP_EXTERNAL_SESSION_TOKEN: "ext-token",
  AMP_EXTERNAL_SESSION_ROUTINE_FIRE_URL: "https://api.anthropic.com/v1/claude_code/routines/r-1/fire",
  AMP_EXTERNAL_SESSION_ROUTINE_TOKEN: "sk-ant-oat01-fake",
};

// ---------------------------------------------------------------------------
// readHarnessConfig
// ---------------------------------------------------------------------------

test("reads all four variables into a config when every one is set", () => {
  const result = readHarnessConfig(FULL_ENV);
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.ok ? result.value : undefined,
    {
      baseUrl: FULL_ENV.AMP_EXTERNAL_SESSION_BASE_URL,
      token: FULL_ENV.AMP_EXTERNAL_SESSION_TOKEN,
      routineFireUrl: FULL_ENV.AMP_EXTERNAL_SESSION_ROUTINE_FIRE_URL,
      routineToken: FULL_ENV.AMP_EXTERNAL_SESSION_ROUTINE_TOKEN,
    },
  );
});

test("names every missing variable at once, not just the first, each with a fix", () => {
  const result = readHarnessConfig({});
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.errors.length, 4);
  const names = [
    "AMP_EXTERNAL_SESSION_BASE_URL",
    "AMP_EXTERNAL_SESSION_TOKEN",
    "AMP_EXTERNAL_SESSION_ROUTINE_FIRE_URL",
    "AMP_EXTERNAL_SESSION_ROUTINE_TOKEN",
  ] as const;
  names.forEach((name, index) => {
    const message = result.errors[index];
    assert.ok(message !== undefined);
    assert.match(message, new RegExp(`^${name} is not set\\.`));
    assert.match(message, /Put it in \.env\.local/);
  });
});

test("treats a blank or whitespace-only variable the same as a missing one", () => {
  const result = readHarnessConfig({ ...FULL_ENV, AMP_EXTERNAL_SESSION_TOKEN: "   " });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.errors.length, 1);
  const [message] = result.errors;
  assert.ok(message !== undefined);
  assert.match(message, /^AMP_EXTERNAL_SESSION_TOKEN is not set\./);
});

// ---------------------------------------------------------------------------
// buildGreetingJob
// ---------------------------------------------------------------------------

test("the test job's schema requires a greeting string, and its prompt names the exact text expected back", () => {
  const { prompt, schema } = buildGreetingJob();
  assert.equal(schema["type"], "object");
  assert.deepEqual(schema["required"], ["greeting"]);
  assert.match(prompt, /Hello from the external session harness\./);
});

// ---------------------------------------------------------------------------
// interpretCreateJobResponse - POST /api/external-session/job
// ---------------------------------------------------------------------------

test("a 201 response is read as a created job, with its id and createdAt", () => {
  const outcome = interpretCreateJobResponse(201, { id: "extjob-1", prompt: "p", schema: {}, createdAt: "2026-09-29T00:00:00.000Z" });
  assert.deepEqual(outcome, { kind: "created", id: "extjob-1", createdAt: "2026-09-29T00:00:00.000Z" });
});

test("a 409 response is recognised as an existing unanswered job, distinct from a fatal failure", () => {
  const outcome = interpretCreateJobResponse(409, { error: "an unanswered job already exists.", id: "extjob-old" });
  assert.deepEqual(outcome, { kind: "conflict", id: "extjob-old" });
  assert.notEqual(outcome.kind, "failed");
});

test("a 500 (or any other non-201/409 status) is a plain failure, not a conflict", () => {
  const outcome = interpretCreateJobResponse(500, { error: "internal" });
  assert.equal(outcome.kind, "failed");
});

// ---------------------------------------------------------------------------
// interpretFireResponse - POST {routineFireUrl}
// ---------------------------------------------------------------------------

test("a successful fire response carries the session url to open in a browser", () => {
  const outcome = interpretFireResponse(200, {
    type: "routine.fired",
    claude_code_session_id: "sess-1",
    claude_code_session_url: "https://claude.ai/code/session/sess-1",
  });
  assert.deepEqual(outcome, { kind: "fired", sessionId: "sess-1", sessionUrl: "https://claude.ai/code/session/sess-1" });
});

test("a non-2xx fire response is a failure", () => {
  const outcome = interpretFireResponse(401, { error: "unauthorised" });
  assert.equal(outcome.kind, "failed");
});

// ---------------------------------------------------------------------------
// interpretPollResponse - GET /api/external-session/job/result
// ---------------------------------------------------------------------------

test("a pending job means keep waiting", () => {
  assert.deepEqual(interpretPollResponse(200, { id: "extjob-1", status: "pending" }), { kind: "pending" });
});

test("a done job hands back its result, id and receivedAt", () => {
  const outcome = interpretPollResponse(200, { id: "extjob-1", status: "done", result: { greeting: "hi" }, receivedAt: "2026-09-29T00:05:00.000Z" });
  assert.deepEqual(outcome, { kind: "done", id: "extjob-1", result: { greeting: "hi" }, receivedAt: "2026-09-29T00:05:00.000Z" });
});

test("a 404 (no job at all) is a failure, not silently treated as pending", () => {
  const outcome = interpretPollResponse(404, { error: "not found" });
  assert.equal(outcome.kind, "failed");
});

// ---------------------------------------------------------------------------
// nextPollStep
// ---------------------------------------------------------------------------

test("pending, with time left, means continue polling", () => {
  const step = nextPollStep({ kind: "pending" }, 10_000, 300_000);
  assert.deepEqual(step, { kind: "continue" });
});

test("pending, with the maximum wait already reached, means timed out - not one more poll", () => {
  const step = nextPollStep({ kind: "pending" }, 300_000, 300_000);
  assert.deepEqual(step, { kind: "timed_out" });
});

test("done stops polling and hands back the result, regardless of elapsed time", () => {
  const step = nextPollStep({ kind: "done", id: "j", result: { greeting: "hi" }, receivedAt: "t" }, 0, 300_000);
  assert.deepEqual(step, { kind: "done", result: { greeting: "hi" } });
});

test("a failed poll stops immediately as an error, even with time left", () => {
  const step = nextPollStep({ kind: "failed", status: 500, body: { error: "boom" } }, 0, 300_000);
  assert.deepEqual(step, { kind: "error", status: 500, body: { error: "boom" } });
});

// ---------------------------------------------------------------------------
// decideFinalOutcome / exitCodeForFinalOutcome
// ---------------------------------------------------------------------------

test("a value that validates against the schema is a pass, exiting 0", () => {
  const outcome = decideFinalOutcome({ ok: true }, { greeting: "hi" }, 1234);
  assert.deepEqual(outcome, { kind: "pass", answer: { greeting: "hi" }, elapsedMs: 1234 });
  assert.equal(exitCodeForFinalOutcome(outcome), 0);
});

test("a value that fails validation is a fail, carrying the validator's own issues, exiting 1", () => {
  const issues = [{ path: "$.greeting", message: "is required and is missing." }];
  const outcome = decideFinalOutcome({ ok: false, issues }, {}, 999);
  assert.deepEqual(outcome, { kind: "fail", issues, elapsedMs: 999 });
  assert.equal(exitCodeForFinalOutcome(outcome), 1);
});
