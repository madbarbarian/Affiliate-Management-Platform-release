#!/usr/bin/env node
/**
 * Phase 1a's proof of the mechanical loop
 * (`docs/3-development/external-generation-design.md`, item 3 of
 * "Phase 1a - prove the mechanical loop").
 *
 * Run by hand, from the platform developer's own machine, against a real
 * deployment the developer controls (e.g. `amp-test`). It is not licensee
 * code, not wired into the orchestrator's cycle, and not part of `npm test` -
 * it makes real network calls to a real Cloudflare Worker and to
 * `api.anthropic.com`, and proving those calls work is the entire point.
 *
 * It creates one job, fires the developer's own Claude Code Routine, polls
 * for the routine's answer, and validates that answer against the job's own
 * JSON Schema with `src/llm/validate.ts` - the same check the server already
 * ran when it accepted the answer, run a second time here, independently,
 * because the point of phase 1a is to prove the check itself works, not to
 * trust the system under test to grade itself.
 *
 * Along the way it prints a timestamp at every stage. Real latency and the
 * per-day launch limit are two of phase 1a's own open questions
 * (docs/3-development/external-generation-design.md, "Phase 1a status"), and
 * neither is answered by a print statement someone reads after the fact - so
 * every stage times itself, and the final line reports total elapsed time.
 *
 * Configuration is four environment variables (see `readHarnessConfig`
 * below), read from `process.env` directly - this is a standalone script, not
 * `platform.config.yaml`-driven, so it does not go through
 * `src/config/load.ts`. Run it with Node 22's own built-in dotenv loader so
 * they come from `.env.local` rather than needing to be exported by hand:
 *
 *   node --env-file=.env.local scripts/external-session-harness.ts
 *
 * Exit codes:
 *   0   the answer came back and validated against the schema (PASS).
 *   1   anything else: a missing environment variable, a network failure, a
 *       409 (an unanswered job already exists), a timeout waiting for the
 *       result, or a schema-validation failure (FAIL). Usable as a real
 *       pass/fail check, not just a print statement.
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { type Clock, systemClock } from "../src/core/clock.ts";
import { asRecord, stringField } from "../src/llm/json-shape.ts";
import { buildFireRequest, interpretFireResponse } from "../src/llm/routine-fire.ts";
import { object, string, type JsonSchema } from "../src/llm/schema.ts";
import { validate, type ValidationIssue, type ValidationResult } from "../src/llm/validate.ts";

// Re-exported so `test/external-session-harness.test.ts` keeps importing them
// from here; the definitions moved to `src/llm/routine-fire.ts`.
export { interpretFireResponse, type FireOutcome } from "../src/llm/routine-fire.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** How often to poll `GET /job/result` while waiting for the routine's answer. */
const POLL_INTERVAL_MS = 5_000;
/** Total time to wait for a result before giving up and reporting a timeout. */
const MAX_POLL_WAIT_MS = 5 * 60 * 1000;

/**
 * Mirrors `EXTERNAL_SESSION_JOB_PATH` / `EXTERNAL_SESSION_RESULT_PATH` in
 * `src/console/router.ts`. Kept as local literals rather than importing that
 * module, which pulls in the whole console (rendering, timeline, the
 * orchestrator's event names) for two path strings; if the routes ever move,
 * both places need the same update.
 */
const JOB_PATH = "/api/external-session/job";
const RESULT_PATH = "/api/external-session/job/result";

const ENV_BASE_URL = "AMP_EXTERNAL_SESSION_BASE_URL";
const ENV_TOKEN = "AMP_EXTERNAL_SESSION_TOKEN";
const ENV_ROUTINE_FIRE_URL = "AMP_EXTERNAL_SESSION_ROUTINE_FIRE_URL";
const ENV_ROUTINE_TOKEN = "AMP_EXTERNAL_SESSION_ROUTINE_TOKEN";

const EXIT_PASS = 0;
const EXIT_FAIL = 1;

// ---------------------------------------------------------------------------
// Configuration - pure, given an env map
// ---------------------------------------------------------------------------

export type HarnessConfig = {
  readonly baseUrl: string;
  readonly token: string;
  readonly routineFireUrl: string;
  readonly routineToken: string;
};

export type EnvReadResult =
  | { readonly ok: true; readonly value: HarnessConfig }
  | { readonly ok: false; readonly errors: readonly string[] };

/**
 * Reads all four required variables and collects every missing one before
 * failing (this repo's own convention: "one run should fix the whole file"),
 * rather than stopping at the first.
 */
export function readHarnessConfig(env: Readonly<Record<string, string | undefined>>): EnvReadResult {
  const errors: string[] = [];
  const baseUrl = readVar(
    env,
    ENV_BASE_URL,
    "the deployment to test against, e.g. https://amp-test.madbarbarian.workers.dev " +
      "(there is no default - it must never silently point at a real deployment).",
    errors,
  );
  const token = readVar(
    env,
    ENV_TOKEN,
    "the same token already set as the Cloudflare secret on that deployment and as the Claude Routine's API credential value.",
    errors,
  );
  const routineFireUrl = readVar(
    env,
    ENV_ROUTINE_FIRE_URL,
    "the full https://api.anthropic.com/v1/claude_code/routines/{id}/fire URL copied from the Routine's API trigger setup.",
    errors,
  );
  const routineToken = readVar(
    env,
    ENV_ROUTINE_TOKEN,
    "the routine's own trigger bearer token (the sk-ant-oat01-... one), shown once when the API trigger was added.",
    errors,
  );
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { baseUrl: baseUrl!, token: token!, routineFireUrl: routineFireUrl!, routineToken: routineToken! } };
}

function readVar(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  hint: string,
  errors: string[],
): string | undefined {
  const value = env[name]?.trim();
  if (value === undefined || value === "") {
    errors.push(`${name} is not set. Put it in .env.local, or export it before running: ${hint}`);
    return undefined;
  }
  return value;
}

// ---------------------------------------------------------------------------
// The test job - pure
// ---------------------------------------------------------------------------

const GREETING_TEXT = "Hello from the external session harness.";

/**
 * A short, deterministic job. The point of phase 1a is proving the mechanism
 * works end to end, not testing a model's creativity, so the prompt names the
 * exact string expected back and leaves nothing for the answering session to
 * interpret.
 */
export function buildGreetingJob(): { readonly prompt: string; readonly schema: JsonSchema } {
  const schema = object(
    { greeting: string(`Must be exactly this text, unchanged: "${GREETING_TEXT}"`) },
    { required: ["greeting"] },
  );
  const prompt =
    `Reply with JSON matching the given schema exactly. Set "greeting" to precisely this text, ` +
    `with no changes: "${GREETING_TEXT}". Do not add any other fields, punctuation, or commentary.`;
  return { prompt, schema };
}

// ---------------------------------------------------------------------------
// Response interpretation - pure decision logic, given a status and a body
// ---------------------------------------------------------------------------

export type CreateJobOutcome =
  | { readonly kind: "created"; readonly id: string; readonly createdAt: string }
  | { readonly kind: "conflict"; readonly id: string | undefined }
  | { readonly kind: "failed"; readonly status: number; readonly body: unknown };

/** `POST /api/external-session/job`'s response, read against the shapes `src/console/router.ts` documents. */
export function interpretCreateJobResponse(status: number, body: unknown): CreateJobOutcome {
  const record = asRecord(body);
  if (status === 201) {
    return { kind: "created", id: stringField(record, "id") ?? "", createdAt: stringField(record, "createdAt") ?? "" };
  }
  // 409 means an unanswered job already exists - a known, expected outcome the
  // owner needs to act on, never conflated with a 500 or any other failure.
  if (status === 409) {
    return { kind: "conflict", id: stringField(record, "id") };
  }
  return { kind: "failed", status, body };
}

export type PollOutcome =
  | { readonly kind: "pending" }
  | { readonly kind: "done"; readonly id: string | undefined; readonly result: unknown; readonly receivedAt: string | undefined }
  | { readonly kind: "failed"; readonly status: number; readonly body: unknown };

/** `GET /api/external-session/job/result`'s response, read the same way. */
export function interpretPollResponse(status: number, body: unknown): PollOutcome {
  const record = asRecord(body);
  const jobStatus = stringField(record, "status");
  if (status === 200 && jobStatus === "pending") return { kind: "pending" };
  if (status === 200 && jobStatus === "done") {
    return { kind: "done", id: stringField(record, "id"), result: record?.["result"], receivedAt: stringField(record, "receivedAt") };
  }
  return { kind: "failed", status, body };
}

export type PollStep =
  | { readonly kind: "continue" }
  | { readonly kind: "timed_out" }
  | { readonly kind: "done"; readonly result: unknown }
  | { readonly kind: "error"; readonly status: number; readonly body: unknown };

/**
 * What to do next, given one poll's outcome and how long polling has run so
 * far. Pure: takes elapsed time as a value rather than reading a clock, so it
 * is testable without waiting on anything real.
 */
export function nextPollStep(outcome: PollOutcome, elapsedMs: number, maxWaitMs: number): PollStep {
  if (outcome.kind === "done") return { kind: "done", result: outcome.result };
  if (outcome.kind === "failed") return { kind: "error", status: outcome.status, body: outcome.body };
  return elapsedMs >= maxWaitMs ? { kind: "timed_out" } : { kind: "continue" };
}

export type FinalOutcome =
  | { readonly kind: "pass"; readonly answer: unknown; readonly elapsedMs: number }
  | { readonly kind: "fail"; readonly issues: readonly ValidationIssue[]; readonly elapsedMs: number };

/** The script's own pass/fail verdict, independent of whatever the server already checked. */
export function decideFinalOutcome(validation: ValidationResult, answer: unknown, elapsedMs: number): FinalOutcome {
  return validation.ok ? { kind: "pass", answer, elapsedMs } : { kind: "fail", issues: validation.issues, elapsedMs };
}

export function exitCodeForFinalOutcome(outcome: FinalOutcome): typeof EXIT_PASS | typeof EXIT_FAIL {
  return outcome.kind === "pass" ? EXIT_PASS : EXIT_FAIL;
}

// ---------------------------------------------------------------------------
// I/O - the only impure part
// ---------------------------------------------------------------------------

type HttpResult =
  | { readonly ok: true; readonly status: number; readonly body: unknown }
  | { readonly ok: false; readonly error: string };

async function requestJson(url: string, init: RequestInit): Promise<HttpResult> {
  try {
    const response = await fetch(url, init);
    const text = await response.text();
    let body: unknown;
    if (text !== "") {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    return { ok: true, status: response.status, body };
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
  }
}

function log(message: string): void {
  console.log(`[${systemClock.nowIso()}] ${message}`);
}

function logError(message: string): void {
  console.error(`[${systemClock.nowIso()}] ${message}`);
}

async function main(config: HarnessConfig, clock: Clock): Promise<number> {
  const startedAt = clock.now();
  const { prompt, schema } = buildGreetingJob();

  log("creating job...");
  const createResponse = await requestJson(`${config.baseUrl}${JOB_PATH}`, {
    method: "POST",
    headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
    body: JSON.stringify({ prompt, schema }),
  });
  if (!createResponse.ok) {
    logError(`could not reach ${config.baseUrl}: ${createResponse.error}. Check ${ENV_BASE_URL}.`);
    return EXIT_FAIL;
  }
  const createOutcome = interpretCreateJobResponse(createResponse.status, createResponse.body);
  if (createOutcome.kind === "conflict") {
    logError(
      `an unanswered job already exists (id: ${createOutcome.id ?? "unknown"}). ` +
        `Wait for it to be answered, or check the deployment manually, before creating another one.`,
    );
    return EXIT_FAIL;
  }
  if (createOutcome.kind === "failed") {
    logError(`job creation failed: HTTP ${createOutcome.status} ${describeBody(createOutcome.body)}`);
    return EXIT_FAIL;
  }
  log(`job created: id=${createOutcome.id} createdAt=${createOutcome.createdAt} (+${clock.now() - startedAt}ms)`);

  log("firing the routine...");
  const fireRequest = buildFireRequest({ fireUrl: config.routineFireUrl, routineToken: config.routineToken });
  const fireResponse = await requestJson(fireRequest.url, {
    method: fireRequest.method,
    headers: { ...fireRequest.headers },
    body: fireRequest.body,
  });
  if (!fireResponse.ok) {
    logError(`could not reach the routine's fire URL: ${fireResponse.error}. Check ${ENV_ROUTINE_FIRE_URL}.`);
    return EXIT_FAIL;
  }
  const fireOutcome = interpretFireResponse(fireResponse.status, fireResponse.body);
  if (fireOutcome.kind === "failed") {
    logError(`firing the routine failed: HTTP ${fireOutcome.status} ${describeBody(fireOutcome.body)}`);
    return EXIT_FAIL;
  }
  log(`routine fired (+${clock.now() - startedAt}ms). Watch it live: ${fireOutcome.sessionUrl ?? "(no session url in the response)"}`);

  log(`polling for the result every ${POLL_INTERVAL_MS}ms, up to ${MAX_POLL_WAIT_MS}ms total...`);
  const pollStartedAt = clock.now();
  let step: PollStep;
  for (;;) {
    const pollResponse = await requestJson(`${config.baseUrl}${RESULT_PATH}`, {
      method: "GET",
      headers: { authorization: `Bearer ${config.token}` },
    });
    if (!pollResponse.ok) {
      logError(`could not reach ${config.baseUrl}: ${pollResponse.error}.`);
      return EXIT_FAIL;
    }
    const elapsedMs = clock.now() - pollStartedAt;
    const outcome = interpretPollResponse(pollResponse.status, pollResponse.body);
    step = nextPollStep(outcome, elapsedMs, MAX_POLL_WAIT_MS);
    if (step.kind !== "continue") break;
    await clock.sleep(POLL_INTERVAL_MS);
  }

  const totalElapsedMs = clock.now() - startedAt;
  if (step.kind === "timed_out") {
    logError(`timed out waiting for the result after ${totalElapsedMs}ms.`);
    return EXIT_FAIL;
  }
  if (step.kind === "error") {
    logError(`polling failed: HTTP ${step.status} ${describeBody(step.body)}`);
    return EXIT_FAIL;
  }

  const validation = validate(schema, step.result);
  const outcome = decideFinalOutcome(validation, step.result, totalElapsedMs);
  if (outcome.kind === "pass") {
    log(`PASS (${outcome.elapsedMs}ms total): ${describeBody(outcome.answer)}`);
  } else {
    logError(`FAIL (${outcome.elapsedMs}ms total):`);
    for (const issue of outcome.issues) console.error(`  ${issue.path}: ${issue.message}`);
  }
  return exitCodeForFinalOutcome(outcome);
}

/** A short, never-throwing preview of an unknown value for a log line. */
function describeBody(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "<value could not be shown>";
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  log("external-session-harness starting");
  const envResult = readHarnessConfig(process.env);
  if (!envResult.ok) {
    for (const message of envResult.errors) console.error(message);
    process.exitCode = EXIT_FAIL;
  } else {
    main(envResult.value, systemClock).then(
      (code) => {
        process.exitCode = code;
      },
      (error: unknown) => {
        // Only reachable if something above threw outside main's own handling
        // (a programmer error, not a network or validation failure).
        console.error(error);
        process.exitCode = EXIT_FAIL;
      },
    );
  }
}
