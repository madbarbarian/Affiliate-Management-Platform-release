/**
 * `llm.provider: external-session`: the config it adds and the environment it
 * needs. Both collect every problem before failing.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  ConfigError,
  DEFAULT_EXTERNAL_SESSION_CONFIG,
  EXTERNAL_SESSION_MAX_INVOCATION_BUDGET_MS,
  EXTERNAL_SESSION_MAX_JOB_TIMEOUT_MS,
  EXTERNAL_SESSION_MEASURED_WALL_MS,
  EXTERNAL_SESSION_WALL_HEADROOM_MS,
} from "../src/config/schema.ts";
import { CYCLE_RETRY_BACKOFF_MS } from "../src/scheduler/tick.ts";
import { repoRoot } from "../src/config/load.ts";
import { EXTERNAL_SESSION_ENV_ERROR_CODE, isPubliclyReachableHost, readExternalSessionEnv } from "../src/llm/external-session-env.ts";
import { BASE_CONFIG, testConfig } from "./helpers.ts";

const GOOD_ENV = {
  AMP_EXTERNAL_SESSION_BASE_URL: "https://amp-test.example.workers.dev",
  AMP_EXTERNAL_SESSION_TOKEN: "job-token",
  AMP_EXTERNAL_SESSION_ROUTINE_FIRE_URL: "https://api.anthropic.com/v1/claude_code/routines/r-1/fire",
  AMP_EXTERNAL_SESSION_ROUTINE_TOKEN: "sk-ant-oat01-fake",
};

function withExternal(llm: Record<string, unknown>, externalSession: Record<string, unknown> = {}): ReturnType<typeof testConfig> {
  return testConfig({ llm: { ...BASE_CONFIG.llm, ...llm, externalSession } });
}

function issuesOf(build: () => unknown): readonly { path: string; message: string; code?: string }[] {
  try {
    build();
  } catch (cause) {
    if (cause instanceof ConfigError) return cause.issues;
    throw cause;
  }
  return [];
}

test("external-session is a provider value, and the block's defaults are the named ones", () => {
  const config = withExternal({ provider: "external-session" }, { enabled: true });
  assert.equal(config.llm.provider, "external-session");
  assert.deepEqual(config.llm.externalSession, { ...DEFAULT_EXTERNAL_SESSION_CONFIG, enabled: true });
});

test("a provider of external-session with the routes switched off is refused, naming the switch", () => {
  const issues = issuesOf(() => withExternal({ provider: "external-session" }, { enabled: false }));
  const issue = issues.find((entry) => entry.path === "llm.externalSession.enabled");
  assert.ok(issue, "the switch that would leave every call waiting out its timeout must be named");
  assert.match(issue.message, /enabled: true/);
  assert.match(issue.message, /"anthropic" or "mock"/);
});

test("every impossible timing pair is reported in the same pass, each with its fix", () => {
  const issues = issuesOf(() =>
    withExternal(
      { provider: "external-session" },
      { enabled: true, jobTimeoutMs: 300_000, invocationBudgetMs: 120_000, pollIntervalMs: 30_000, pollMaxIntervalMs: 5_000 },
    ),
  );
  const paths = issues.map((issue) => issue.path);
  assert.ok(paths.includes("llm.externalSession.invocationBudgetMs"));
  assert.ok(paths.includes("llm.externalSession.pollMaxIntervalMs"));
  assert.match(issues.find((entry) => entry.path === "llm.externalSession.invocationBudgetMs")?.message ?? "", /Raise invocationBudgetMs or lower jobTimeoutMs/);
});

test("a budget past the wall time measured for Cloudflare (Task 0: 12 minutes) is refused, so a killed invocation cannot be configured in", () => {
  const issues = issuesOf(() => withExternal({}, { invocationBudgetMs: EXTERNAL_SESSION_MAX_INVOCATION_BUDGET_MS + 1 }));
  assert.ok(issues.some((issue) => issue.path === "llm.externalSession.invocationBudgetMs"));
});

test("a job timeout past the scheduler's retry backoff is refused, so a retry never meets its own leftover job as still young", () => {
  const issues = issuesOf(() => withExternal({}, { jobTimeoutMs: CYCLE_RETRY_BACKOFF_MS + 1 }));
  assert.ok(issues.some((issue) => issue.path === "llm.externalSession.jobTimeoutMs"));
});

test("the limits and defaults all derive from the one measured wall-time constant and agree with each other", () => {
  assert.equal(EXTERNAL_SESSION_MAX_INVOCATION_BUDGET_MS, EXTERNAL_SESSION_MEASURED_WALL_MS - EXTERNAL_SESSION_WALL_HEADROOM_MS);
  assert.equal(EXTERNAL_SESSION_MAX_JOB_TIMEOUT_MS, CYCLE_RETRY_BACKOFF_MS, "the schema copy of the scheduler's retry backoff has drifted");
  assert.ok(DEFAULT_EXTERNAL_SESSION_CONFIG.invocationBudgetMs <= EXTERNAL_SESSION_MAX_INVOCATION_BUDGET_MS);
  assert.ok(
    DEFAULT_EXTERNAL_SESSION_CONFIG.jobTimeoutMs <= DEFAULT_EXTERNAL_SESSION_CONFIG.invocationBudgetMs,
    "the defaults must pass the rule that the budget covers one job timeout",
  );
});

test("the provider does not need llm.apiKeyEnv, and anthropic does not need the external variables", () => {
  // Parsing never reads the environment; this pins that a config naming no
  // key is valid for external-session.
  const config = withExternal({ provider: "external-session", apiKeyEnv: "NOT_SET_ANYWHERE" }, { enabled: true });
  assert.equal(config.llm.provider, "external-session");
});

test("all four variables present and usable read into one value", () => {
  const config = withExternal({ provider: "external-session" }, { enabled: true });
  const result = readExternalSessionEnv(config.llm.externalSession, GOOD_ENV);
  assert.ok(result.ok);
  assert.equal(result.ok && result.value.fireUrl, GOOD_ENV.AMP_EXTERNAL_SESSION_ROUTINE_FIRE_URL);
  assert.equal(result.ok && result.value.routineToken, "sk-ant-oat01-fake");
});

test("every missing variable is named in one error, with the Cloudflare fix before the terminal one", () => {
  const config = withExternal({ provider: "external-session" }, { enabled: true });
  const result = readExternalSessionEnv(config.llm.externalSession, {});
  assert.ok(!result.ok);
  if (result.ok) return;
  assert.equal(result.error.code, EXTERNAL_SESSION_ENV_ERROR_CODE);
  assert.equal(result.error.retryable, false);
  for (const name of [
    "AMP_EXTERNAL_SESSION_BASE_URL",
    "AMP_EXTERNAL_SESSION_TOKEN",
    "AMP_EXTERNAL_SESSION_ROUTINE_FIRE_URL",
    "AMP_EXTERNAL_SESSION_ROUTINE_TOKEN",
  ]) {
    assert.match(result.error.message, new RegExp(`${name} is not set`));
  }
  assert.ok(result.error.message.indexOf("Variables and Secrets") < result.error.message.indexOf(".env.local"));
  assert.match(result.error.message, /llm\.provider to "anthropic" or "mock"/);
});

test("a blank variable is a missing one", () => {
  const config = withExternal({ provider: "external-session" }, { enabled: true });
  const result = readExternalSessionEnv(config.llm.externalSession, { ...GOOD_ENV, AMP_EXTERNAL_SESSION_ROUTINE_TOKEN: "   " });
  assert.ok(!result.ok);
  assert.match(result.ok ? "" : result.error.message, /AMP_EXTERNAL_SESSION_ROUTINE_TOKEN is not set/);
});

test("a console address the routine cannot reach is refused with the reason, not only when a variable is missing", () => {
  const config = withExternal({ provider: "external-session" }, { enabled: true });
  const result = readExternalSessionEnv(config.llm.externalSession, {
    ...GOOD_ENV,
    AMP_EXTERNAL_SESSION_BASE_URL: "https://127.0.0.1:4321",
  });
  assert.ok(!result.ok);
  assert.match(result.ok ? "" : result.error.message, /127\.0\.0\.1, which the routine cannot reach/);
});

test("http:// on either URL is refused because a token is sent to it", () => {
  const config = withExternal({ provider: "external-session" }, { enabled: true });
  const result = readExternalSessionEnv(config.llm.externalSession, {
    ...GOOD_ENV,
    AMP_EXTERNAL_SESSION_BASE_URL: "http://amp-test.example.workers.dev",
    AMP_EXTERNAL_SESSION_ROUTINE_FIRE_URL: "http://api.anthropic.com/x/fire",
  });
  assert.ok(!result.ok);
  const message = result.ok ? "" : result.error.message;
  assert.match(message, /AMP_EXTERNAL_SESSION_BASE_URL must start with https/);
  assert.match(message, /AMP_EXTERNAL_SESSION_ROUTINE_FIRE_URL must start with https/);
});

test("which hosts count as reachable from the internet", () => {
  for (const host of ["localhost", "app.localhost", "127.0.0.1", "0.0.0.0", "10.1.2.3", "192.168.1.5", "172.16.0.1", "172.31.255.1", "169.254.1.1", "[::1]", "printer.local"]) {
    assert.equal(isPubliclyReachableHost(host), false, host);
  }
  for (const host of ["amp.example.workers.dev", "203.0.113.9", "172.32.0.1", "172.15.0.1", "example.com"]) {
    assert.equal(isPubliclyReachableHost(host), true, host);
  }
});

test("the shipped example shows every key of the block, so none is discoverable only from src/", async () => {
  const example = await readFile(join(repoRoot(), "platform.config.example.yaml"), "utf8");
  for (const key of Object.keys(DEFAULT_EXTERNAL_SESSION_CONFIG)) {
    assert.match(example, new RegExp(`^\\s*#\\s+${key}:`, "m"), `platform.config.example.yaml does not show llm.externalSession.${key}`);
  }
  assert.match(example, /^\s*provider:\s*mock\b/m, "the example must still start on the simulated model");
  assert.match(example, /anthropic \| mock \| external-session/);
});
