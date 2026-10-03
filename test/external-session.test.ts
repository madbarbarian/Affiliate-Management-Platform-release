/**
 * Phase 1a's four job routes (`docs/3-development/external-generation-design.md`).
 *
 * Direct `handleRequest(runtime, operators, request, token)` calls, the same
 * idiom `test/console.test.ts`'s own memo test uses - no real HTTP server
 * needed to exercise the router.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { EXTERNAL_SESSION_JOB_PATH, EXTERNAL_SESSION_RESULT_PATH, handleRequest } from "../src/console/router.ts";
import { createTestCompany, testConfig, BASE_CONFIG } from "./helpers.ts";
import { guardWithStop } from "../src/kernel/assemble.ts";
import { memoryState, type StateStore } from "../src/kernel/state.ts";
import { createStateJobStore, readExternalSessionJob, tombstoneJob, writeExternalSessionJob } from "../src/kernel/external-session.ts";
import { sequentialIds } from "../src/core/ids.ts";
import { silentLogger } from "../src/core/logger.ts";
import { createExternalSessionProvider } from "../src/llm/external-session.ts";
import { advancingClock } from "./helpers.ts";
import { object, string, type JsonSchema } from "../src/llm/schema.ts";
import type { Runtime } from "../src/runtime.ts";
import type { Operator } from "../src/console/operators.ts";

const JOB_URL = `http://console.test.invalid${EXTERNAL_SESSION_JOB_PATH}`;
const RESULT_URL = `http://console.test.invalid${EXTERNAL_SESSION_RESULT_PATH}`;
const TOKEN = "ext-secret-token";
const operators: readonly Operator[] = [{ name: "tester", token: "console-token" }];

function buildRuntime(options: { enabled?: boolean } = {}): { runtime: Runtime; state: StateStore } {
  const config = testConfig({
    llm: {
      ...BASE_CONFIG.llm,
      externalSession: { enabled: options.enabled ?? true, tokenEnv: "AMP_EXTERNAL_SESSION_TOKEN" },
    },
  });
  const company = createTestCompany({ config });
  const state = memoryState();
  const runtime = {
    loaded: { config, path: "test", dataDir: "test-data", promptsDir: "prompts" },
    config,
    state,
    services: company.services,
    orchestrator: guardWithStop(company.orchestrator, company.services, state),
    bus: company.services.bus,
    dryRun: false,
    close: async () => {},
  } as unknown as Runtime;
  return { runtime, state };
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

async function createJob(runtime: Runtime, token: string, prompt: string, schema: JsonSchema): Promise<Response> {
  return handleRequest(
    runtime,
    operators,
    new Request(JOB_URL, { method: "POST", headers: bearer(token), body: JSON.stringify({ prompt, schema }) }),
    token,
  );
}

async function postResult(runtime: Runtime, token: string, id: string, value: unknown): Promise<Response> {
  return handleRequest(
    runtime,
    operators,
    new Request(RESULT_URL, { method: "POST", headers: bearer(token), body: JSON.stringify({ id, value }) }),
    token,
  );
}

const ANSWER_SCHEMA = object({ answer: string() }, { required: ["answer"] });

test("every external-session route 404s when externalSession.enabled is false, even with a plausible matching bearer", async () => {
  const { runtime } = buildRuntime({ enabled: false });
  const jobGet = await handleRequest(runtime, operators, new Request(JOB_URL, { headers: bearer(TOKEN) }), TOKEN);
  assert.equal(jobGet.status, 404);
  const jobPost = await createJob(runtime, TOKEN, "x", ANSWER_SCHEMA);
  assert.equal(jobPost.status, 404);
  const resultGet = await handleRequest(runtime, operators, new Request(RESULT_URL, { headers: bearer(TOKEN) }), TOKEN);
  assert.equal(resultGet.status, 404);
  const resultPost = await postResult(runtime, TOKEN, "extjob_x", { answer: "x" });
  assert.equal(resultPost.status, 404);
});

test("every external-session route 404s when externalSession is absent from config entirely", async () => {
  // No `llm.externalSession` override at all - the schema's own default, not a
  // test-authored `enabled: false`.
  const config = testConfig();
  assert.equal(config.llm.externalSession.enabled, false, "sanity: the default really is off");
  const company = createTestCompany({ config });
  const state = memoryState();
  const runtime = {
    loaded: { config, path: "test", dataDir: "test-data", promptsDir: "prompts" },
    config,
    state,
    services: company.services,
    orchestrator: guardWithStop(company.orchestrator, company.services, state),
    bus: company.services.bus,
    dryRun: false,
    close: async () => {},
  } as unknown as Runtime;

  const jobGet = await handleRequest(runtime, operators, new Request(JOB_URL, { headers: bearer(TOKEN) }), TOKEN);
  assert.equal(jobGet.status, 404);
});

test("enabled but a missing or wrong bearer is 401, and the job state is left untouched", async () => {
  const { runtime, state } = buildRuntime({ enabled: true });
  const created = await createJob(runtime, TOKEN, "do the thing", ANSWER_SCHEMA);
  assert.equal(created.status, 201);
  const createdBody = (await created.json()) as { id: string };

  const noHeader = await handleRequest(runtime, operators, new Request(JOB_URL), TOKEN);
  assert.equal(noHeader.status, 401);
  const wrongHeader = await handleRequest(
    runtime,
    operators,
    new Request(JOB_URL, { headers: bearer("wrong-token") }),
    TOKEN,
  );
  assert.equal(wrongHeader.status, 401);

  // The job is exactly as it was - a wrong or missing bearer touched nothing.
  const job = readExternalSessionJob(state);
  assert.equal(job?.id, createdBody.id);
  assert.equal(job?.result, undefined);
});

test("full lifecycle: create a job, fetch it, answer it, and poll the done result", async () => {
  const { runtime } = buildRuntime({ enabled: true });

  const created = await createJob(runtime, TOKEN, "say hi", ANSWER_SCHEMA);
  assert.equal(created.status, 201);
  const job = (await created.json()) as { id: string; prompt: string; schema: unknown; createdAt: string };
  assert.equal(job.prompt, "say hi");
  assert.deepEqual(job.schema, ANSWER_SCHEMA);

  const fetched = await handleRequest(runtime, operators, new Request(JOB_URL, { headers: bearer(TOKEN) }), TOKEN);
  assert.equal(fetched.status, 200);
  const fetchedBody = (await fetched.json()) as { id: string };
  assert.equal(fetchedBody.id, job.id);

  const posted = await postResult(runtime, TOKEN, job.id, { answer: "hi" });
  assert.equal(posted.status, 200);
  assert.deepEqual(await posted.json(), { id: job.id, status: "done" });

  const polled = await handleRequest(runtime, operators, new Request(RESULT_URL, { headers: bearer(TOKEN) }), TOKEN);
  assert.equal(polled.status, 200);
  const polledBody = (await polled.json()) as { id: string; status: string; result: unknown; receivedAt: string };
  assert.equal(polledBody.id, job.id, "a poller must be able to tell which job a done answer belongs to");
  assert.equal(polledBody.status, "done");
  assert.deepEqual(polledBody.result, { answer: "hi" });
  assert.match(polledBody.receivedAt, /^\d{4}-\d{2}-\d{2}T/, "receivedAt is echoed alongside the answer");
});

test("creating a job while an unanswered one exists is refused with 409, and the old job's id remains the only valid one", async () => {
  const { runtime } = buildRuntime({ enabled: true });
  const first = await createJob(runtime, TOKEN, "first", ANSWER_SCHEMA);
  assert.equal(first.status, 201);
  const firstBody = (await first.json()) as { id: string };

  const second = await createJob(runtime, TOKEN, "second", ANSWER_SCHEMA);
  assert.equal(second.status, 409);

  const fetched = await handleRequest(runtime, operators, new Request(JOB_URL, { headers: bearer(TOKEN) }), TOKEN);
  const fetchedBody = (await fetched.json()) as { id: string };
  assert.equal(fetchedBody.id, firstBody.id, "the pending job is still the first one, not silently replaced");
});

test("posting a job's answer succeeds again once the first job has been answered", async () => {
  const { runtime } = buildRuntime({ enabled: true });
  const first = await createJob(runtime, TOKEN, "first", ANSWER_SCHEMA);
  const firstBody = (await first.json()) as { id: string };
  const answered = await postResult(runtime, TOKEN, firstBody.id, { answer: "done" });
  assert.equal(answered.status, 200);

  // No unanswered job remains, so a second POST job is not a 409.
  const second = await createJob(runtime, TOKEN, "second", ANSWER_SCHEMA);
  assert.equal(second.status, 201);
});

test("posting a result under an id that does not match the current job is refused with 409", async () => {
  const { runtime } = buildRuntime({ enabled: true });
  await createJob(runtime, TOKEN, "job", ANSWER_SCHEMA);
  const response = await postResult(runtime, TOKEN, "extjob_does_not_exist", { answer: "x" });
  assert.equal(response.status, 409);
});

test("posting a result that fails the job's own schema is 422, naming the issues", async () => {
  const { runtime } = buildRuntime({ enabled: true });
  const created = await createJob(runtime, TOKEN, "job", ANSWER_SCHEMA);
  const job = (await created.json()) as { id: string };

  const response = await postResult(runtime, TOKEN, job.id, { answer: 5 });
  assert.equal(response.status, 422);
  const body = (await response.json()) as { error: string; issues: { path: string }[] };
  assert.ok(Array.isArray(body.issues) && body.issues.length > 0);
  assert.equal(body.issues[0]?.path, "$.answer");
});

test("posting a result body that is not valid JSON at all is 400 - distinct from a schema mismatch's 422", async () => {
  const { runtime } = buildRuntime({ enabled: true });
  const created = await createJob(runtime, TOKEN, "job", ANSWER_SCHEMA);
  const job = (await created.json()) as { id: string };

  const malformed = await handleRequest(
    runtime,
    operators,
    new Request(RESULT_URL, { method: "POST", headers: bearer(TOKEN), body: "{not json" }),
    TOKEN,
  );
  assert.equal(malformed.status, 400);

  const schemaInvalid = await postResult(runtime, TOKEN, job.id, { answer: 5 });
  assert.equal(schemaInvalid.status, 422);
  assert.notEqual(malformed.status, schemaInvalid.status);
});

test("GET job and GET result both 404 when nothing has ever been created", async () => {
  const { runtime } = buildRuntime({ enabled: true });
  const job = await handleRequest(runtime, operators, new Request(JOB_URL, { headers: bearer(TOKEN) }), TOKEN);
  assert.equal(job.status, 404);
  const result = await handleRequest(runtime, operators, new Request(RESULT_URL, { headers: bearer(TOKEN) }), TOKEN);
  assert.equal(result.status, 404);
});

test("GET job 404s once the pending job has already been answered", async () => {
  const { runtime } = buildRuntime({ enabled: true });
  const created = await createJob(runtime, TOKEN, "job", ANSWER_SCHEMA);
  const job = (await created.json()) as { id: string };
  await postResult(runtime, TOKEN, job.id, { answer: "done" });

  const fetched = await handleRequest(runtime, operators, new Request(JOB_URL, { headers: bearer(TOKEN) }), TOKEN);
  assert.equal(fetched.status, 404, "an already-answered job is not something the routine should fetch again");
});

test("creating a job with a missing prompt or a non-object schema is 400", async () => {
  const { runtime } = buildRuntime({ enabled: true });
  const noPrompt = await handleRequest(
    runtime,
    operators,
    new Request(JOB_URL, { method: "POST", headers: bearer(TOKEN), body: JSON.stringify({ schema: ANSWER_SCHEMA }) }),
    TOKEN,
  );
  assert.equal(noPrompt.status, 400);

  const badSchema = await handleRequest(
    runtime,
    operators,
    new Request(JOB_URL, { method: "POST", headers: bearer(TOKEN), body: JSON.stringify({ prompt: "x", schema: "not an object" }) }),
    TOKEN,
  );
  assert.equal(badSchema.status, 400);
});

// ---------------------------------------------------------------------------
// Phase 1b: a discarded job is a tombstone
// ---------------------------------------------------------------------------

const DISCARDED_AT = "2026-09-30T00:10:00.000Z";

/** A job created through the router, then given up on by the platform. */
async function createDiscardedJob(runtime: Runtime, state: StateStore): Promise<string> {
  const created = await createJob(runtime, TOKEN, "old work", ANSWER_SCHEMA);
  assert.equal(created.status, 201);
  const job = readExternalSessionJob(state);
  assert.ok(job);
  await writeExternalSessionJob(state, tombstoneJob(job, DISCARDED_AT));
  return job.id;
}

test("a late answer to a discarded job is refused with 409 and is never stored", async () => {
  const { runtime, state } = buildRuntime({ enabled: true });
  const id = await createDiscardedJob(runtime, state);

  const late = await postResult(runtime, TOKEN, id, { answer: "too late" });
  assert.equal(late.status, 409);

  const after = readExternalSessionJob(state);
  assert.equal(after?.result, undefined, "the late answer must not have landed");
  assert.equal(after?.discardedAt, DISCARDED_AT);
});

test("a discarded job is not handed to a routine that fetches it", async () => {
  const { runtime, state } = buildRuntime({ enabled: true });
  await createDiscardedJob(runtime, state);
  const fetched = await handleRequest(runtime, operators, new Request(JOB_URL, { headers: bearer(TOKEN) }), TOKEN);
  assert.equal(fetched.status, 404);
});

test("a discarded job does not block the next job, unlike an unanswered one", async () => {
  const { runtime, state } = buildRuntime({ enabled: true });
  const oldId = await createDiscardedJob(runtime, state);
  const next = await createJob(runtime, TOKEN, "new work", ANSWER_SCHEMA);
  assert.equal(next.status, 201);
  assert.notEqual(((await next.json()) as { id: string }).id, oldId);
});

test("the poller is told a job was discarded rather than that it is still pending", async () => {
  const { runtime, state } = buildRuntime({ enabled: true });
  const id = await createDiscardedJob(runtime, state);
  const polled = await handleRequest(runtime, operators, new Request(RESULT_URL, { headers: bearer(TOKEN) }), TOKEN);
  assert.equal(polled.status, 200);
  assert.deepEqual(await polled.json(), { id, status: "discarded" });
});

test("a job whose answer the provider has returned (consumed) is still reported done to the poller, not discarded", async () => {
  // The provider marks a returned answer as consumed so it is never adopted a
  // second time. That mark must not be the tombstone: the poller would read a
  // job that was answered and used as one the platform gave up on.
  const { runtime, state } = buildRuntime({ enabled: true });
  const clock = advancingClock("2026-09-30T00:00:00Z");
  const provider = createExternalSessionProvider({
    store: createStateJobStore(state),
    clock,
    ids: sequentialIds(),
    logger: silentLogger,
    // The routine, answering through the real route the moment it is woken.
    fetch: async () => {
      const job = readExternalSessionJob(state);
      assert.ok(job);
      assert.equal((await postResult(runtime, TOKEN, job.id, { answer: "routed" })).status, 200);
      return new Response(JSON.stringify({ claude_code_session_id: "s-1" }), { status: 200 });
    },
    fireUrl: "https://api.anthropic.com/v1/claude_code/routines/r-1/fire",
    routineToken: "sk-ant-oat01-fake",
    jobTimeoutMs: 60_000,
    pollIntervalMs: 5_000,
    pollMaxIntervalMs: 5_000,
    invocationBudgetMs: Number.POSITIVE_INFINITY,
    fireTimeoutMs: 1_000,
  });
  const answered = await provider.completeJson<{ answer: string }>({ system: "s", user: "u", purpose: "test.route", schema: ANSWER_SCHEMA });
  assert.deepEqual(answered.ok && answered.value, { answer: "routed" });
  const job = readExternalSessionJob(state);
  assert.ok(job?.consumedAt, "the provider marked the answer as consumed");

  const polled = await handleRequest(runtime, operators, new Request(RESULT_URL, { headers: bearer(TOKEN) }), TOKEN);
  assert.equal(polled.status, 200);
  assert.equal(((await polled.json()) as { status: string }).status, "done");
});
