/**
 * `src/llm/routine-fire.ts`: the fire request and the reading of its answer,
 * shared by `scripts/external-session-harness.ts` and `ExternalSessionProvider`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { repoRoot } from "../src/config/load.ts";
import { ANTHROPIC_API_VERSION, ROUTINE_BETA_HEADER, buildFireRequest, interpretFireResponse } from "../src/llm/routine-fire.ts";
import { advancingClock } from "./helpers.ts";

test("the fire request carries the routine token, both version headers and an empty JSON body", () => {
  const request = buildFireRequest({
    fireUrl: "https://api.anthropic.com/v1/claude_code/routines/r-1/fire",
    routineToken: "sk-ant-oat01-fake",
  });
  assert.equal(request.url, "https://api.anthropic.com/v1/claude_code/routines/r-1/fire");
  assert.equal(request.method, "POST");
  assert.equal(request.headers["authorization"], "Bearer sk-ant-oat01-fake");
  assert.equal(request.headers["anthropic-beta"], ROUTINE_BETA_HEADER);
  assert.equal(request.headers["anthropic-version"], ANTHROPIC_API_VERSION);
  assert.equal(request.headers["content-type"], "application/json");
  assert.equal(request.body, "{}");
});

test("a 2xx fire response is fired and carries the session url; anything else is failed with its status", () => {
  const fired = interpretFireResponse(200, { claude_code_session_id: "s-1", claude_code_session_url: "https://claude.ai/code/s-1" });
  assert.deepEqual(fired, { kind: "fired", sessionId: "s-1", sessionUrl: "https://claude.ai/code/s-1" });
  const refused = interpretFireResponse(401, { error: "bad token" });
  assert.deepEqual(refused, { kind: "failed", status: 401, body: { error: "bad token" } });
  const redirected = interpretFireResponse(302, undefined);
  assert.equal(redirected.kind, "failed", "a 3xx is not a fire");
});

test("src/ never imports from scripts/ - shared code lives in src/ and scripts import it", () => {
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".ts") && /from\s+["'](\.\.\/)+scripts\//.test(readFileSync(path, "utf8"))) offenders.push(path);
    }
  };
  walk(join(repoRoot(), "src"));
  assert.deepEqual(offenders, []);
});

test("advancingClock: sleep moves time forward, unlike fixedClock whose sleep is a no-op", async () => {
  const clock = advancingClock("2026-09-30T00:00:00Z");
  const before = clock.now();
  await clock.sleep(5_000);
  assert.equal(clock.now() - before, 5_000);
  assert.equal(clock.nowIso(), "2026-09-30T00:00:05.000Z");
});
