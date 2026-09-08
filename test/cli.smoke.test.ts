/**
 * Does the program actually run?
 *
 * The rest of the suite tests the domain through `test/helpers.ts`, which
 * builds a company out of in-memory storage and mock adapters. That is the
 * right shape for testing the learning loop, and it is structurally blind to
 * everything outside it: argument dispatch, loading a config off disk, wiring
 * the adapters, the data directory. Every elementary bug found in this project
 * so far has lived in exactly that band - and that band is a licensee's entire
 * first day.
 *
 * So these spawn the real binary against the shipped example config and assert
 * the least interesting thing possible: that each command runs, does not throw,
 * and says something recognisable. Slow by unit-test standards, and the only
 * thing that would have caught any of them.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { repoRoot } from "../src/config/load.ts";

const run = promisify(execFile);
const ROOT = repoRoot();
const CLI = join(ROOT, "src", "cli.ts");

type Outcome = { readonly code: number; readonly stdout: string; readonly stderr: string };

async function amp(args: readonly string[], env: NodeJS.ProcessEnv = {}): Promise<Outcome> {
  try {
    const { stdout, stderr } = await run("node", [CLI, ...args], {
      cwd: ROOT,
      timeout: 60_000,
      // A stray key in the real environment would hide exactly the failure
      // these tests exist to catch.
      env: { ...process.env, ANTHROPIC_API_KEY: "", AMP_CONFIG: "", ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (cause) {
    const error = cause as { code?: number; stdout?: string; stderr?: string };
    return { code: error.code ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

/**
 * A working config in a scratch directory, built from the example a licensee
 * actually starts with - so a broken `platform.config.example.yaml` fails here
 * rather than on someone's first evening.
 */
async function scratchConfig(overrides: (yaml: string) => string = (yaml) => yaml): Promise<{
  dir: string;
  config: string;
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "amp-smoke-"));
  const example = await readFile(join(ROOT, "platform.config.example.yaml"), "utf8");
  // Only the prompts path is rewritten, and only because the scratch directory
  // has no prompts of its own. Nothing else is touched: this used to force
  // provider: mock, which meant every test below ran against a config no
  // licensee has, and the example shipped requiring an API key for months
  // without a single test noticing.
  const yaml = overrides(example.replace("promptsDir: prompts", `promptsDir: ${join(ROOT, "prompts")}`));
  const config = join(dir, "platform.config.yaml");
  await writeFile(config, yaml, "utf8");
  return { dir, config, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** Node prints these when something reached the top level unhandled. */
function looksLikeACrash(outcome: Outcome): boolean {
  return /\n\s+at (async )?\w|Error: .*\n\s+at /.test(`${outcome.stdout}\n${outcome.stderr}`);
}

test("the shipped example needs no API key to run", async () => {
  // The promise the onboarding makes is that you reach a working product
  // holding no key at all. The example shipped with provider: anthropic, so a
  // licensee's first deploy answered with the setup page and the console never
  // opened - on Cloudflare, where there is no terminal to ask why.
  const example = await readFile(join(ROOT, "platform.config.example.yaml"), "utf8");
  assert.match(
    example,
    /^\s*provider:\s*mock\b/m,
    "the example a licensee copies must not require a key before anything runs",
  );

  const { config, cleanup } = await scratchConfig();
  try {
    const outcome = await amp(["doctor", "--config", config]);
    assert.doesNotMatch(
      `${outcome.stdout}${outcome.stderr}`,
      /no_api_key|ANTHROPIC_API_KEY is not set/,
      "the example must assemble a runtime with no key present",
    );
  } finally {
    await cleanup();
  }
});

test("the shipped example config loads and passes doctor", async () => {
  const { config, cleanup } = await scratchConfig();
  try {
    const outcome = await amp(["doctor", "--config", config]);
    assert.equal(outcome.code, 0, `doctor failed:\n${outcome.stdout}\n${outcome.stderr}`);
    assert.match(outcome.stdout, /venture\s+main/);
    assert.ok(!looksLikeACrash(outcome), outcome.stderr);
  } finally {
    await cleanup();
  }
});

test("every read-only command runs without throwing", async () => {
  const { config, cleanup } = await scratchConfig();
  try {
    for (const args of [["roles"], ["cycle status"], ["pending"], ["report"], ["statement"]]) {
      const outcome = await amp([...args[0]!.split(" "), "--config", config]);
      assert.ok(
        !looksLikeACrash(outcome),
        `\`amp ${args[0]}\` threw instead of reporting:\n${outcome.stdout}\n${outcome.stderr}`,
      );
      assert.equal(outcome.code, 0, `\`amp ${args[0]}\` exited ${outcome.code}`);
    }
  } finally {
    await cleanup();
  }
});

test("a command with an argument reaches that command, not the help text", async () => {
  // The bug this locks: the dispatcher joined every positional into one key,
  // so `approve dec_123` looked like the command "approve dec_123" and matched
  // nothing. Approving from the terminal was impossible and every test passed.
  const { config, cleanup } = await scratchConfig();
  try {
    const outcome = await amp(["approve", "dec_does_not_exist", "--config", config]);
    assert.doesNotMatch(
      `${outcome.stdout}${outcome.stderr}`,
      /Unknown command/,
      "an argument must not turn the command into an unknown one",
    );
    assert.match(
      `${outcome.stdout}${outcome.stderr}`,
      /dec_does_not_exist|not found|見つかり/i,
      "it should report the missing decision, which means it got that far",
    );
  } finally {
    await cleanup();
  }
});

test("a whole cycle runs to its first gate through the real binary", async () => {
  const { config, cleanup } = await scratchConfig();
  try {
    const outcome = await amp(["cycle", "run", "--config", config]);
    assert.ok(!looksLikeACrash(outcome), `${outcome.stdout}\n${outcome.stderr}`);
    assert.equal(outcome.code, 0);
    assert.match(outcome.stdout, /plan|承認|decision/i);

    // And the second command can read what the first one wrote to disk. The
    // in-memory store never exercises that.
    const pending = await amp(["pending", "--config", config]);
    assert.equal(pending.code, 0);
    assert.match(pending.stdout, /dec_/, "the decision the cycle persisted should be listed");
  } finally {
    await cleanup();
  }
});

test("the stop works when the model provider is unusable", async () => {
  // The property that makes it a kill switch. A broken credential is one of
  // the reasons to reach for a stop; it must never be the reason you cannot.
  const { config, cleanup } = await scratchConfig((yaml) =>
    yaml.replace("provider: mock", "provider: anthropic"),
  );
  try {
    const blocked = await amp(["doctor", "--config", config]);
    assert.notEqual(blocked.code, 0, "doctor should refuse without a key - that is the premise here");

    const stopped = await amp(["pause", "--config", config, "--reason", "smoke"]);
    assert.equal(stopped.code, 0, `pause must not need the model:\n${stopped.stderr}`);
    assert.match(stopped.stdout, /stopped/i);

    const resumed = await amp(["resume", "--config", config]);
    assert.equal(resumed.code, 0, `resume must not need the model:\n${resumed.stderr}`);
  } finally {
    await cleanup();
  }
});

test("the stop works when the config no longer validates", async () => {
  // A config half-edited, or a `${VAR}` that is not set, is another likely
  // reason to be reaching for the stop. It used to be a reason the stop
  // refused: `pause` ran the full validator, which throws on the first
  // problem.
  const { dir, config, cleanup } = await scratchConfig((yaml) =>
    yaml.replace("maxPostsPerDay: 3", "maxPostsPerDay: three"),
  );
  try {
    const blocked = await amp(["doctor", "--config", config]);
    assert.notEqual(blocked.code, 0, "doctor should refuse this config - that is the premise here");

    const stopped = await amp(["pause", "--config", config, "--reason", "smoke"]);
    assert.equal(stopped.code, 0, `pause must not need a valid config:\n${stopped.stderr}`);
    assert.match(stopped.stderr, /did not validate/, "and it should say it is working from the raw file");
    const written = JSON.parse(await readFile(join(dir, ".amp", "paused.json"), "utf8")) as { all?: unknown };
    assert.ok(written.all, "the stop file must be in the data directory the config names");

    // A partial stop cannot check the venture id, so it refuses rather than
    // stopping a venture that may not exist.
    const partial = await amp(["pause", "--venture", "main", "--config", config, "--reason", "smoke"]);
    assert.equal(partial.code, 2);
    assert.match(partial.stderr, /no --venture/);

    assert.equal((await amp(["resume", "--config", config])).code, 0);
  } finally {
    await cleanup();
  }
});

test("a stop is visible to a dry run, which is when someone is least sure", async () => {
  // `--dry-run` swaps storage, the model and every adapter so nothing is
  // published. It must not also swap the operator's answer to "what is
  // running": a dry run that says the platform is live while the real one is
  // stopped is worse than useless, because checking is why you ran it.
  const { config, cleanup } = await scratchConfig();
  try {
    assert.equal((await amp(["pause", "--config", config, "--reason", "smoke"])).code, 0);

    const live = await amp(["doctor", "--config", config]);
    const dry = await amp(["doctor", "--config", config, "--dry-run"]);
    assert.match(live.stdout, /STOPPED|停止/i, "the live doctor should say so - that is the premise here");
    assert.match(dry.stdout, /STOPPED|停止/i, "and so should the dry run");
  } finally {
    await cleanup();
  }
});

test("a stop refuses a cycle instead of half-running one", async () => {
  const { config, cleanup } = await scratchConfig();
  try {
    assert.equal((await amp(["pause", "--config", config, "--reason", "smoke"])).code, 0);

    const blocked = await amp(["cycle", "run", "--config", config]);
    assert.match(`${blocked.stdout}${blocked.stderr}`, /stopped/i);
    assert.notEqual(blocked.code, 0, "a refused cycle should not report success");

    assert.equal((await amp(["resume", "--config", config])).code, 0);
    assert.equal((await amp(["cycle", "run", "--config", config])).code, 0);
  } finally {
    await cleanup();
  }
});

test("the scout proposes, accepting prints a block, and the block pastes into a config that still passes doctor", async () => {
  const { config, cleanup } = await scratchConfig();
  try {
    const scouted = await amp(["scout", "--count", "1", "--config", config]);
    assert.equal(scouted.code, 0, `scout failed:\n${scouted.stdout}\n${scouted.stderr}`);
    assert.match(scouted.stdout, /proposes 1 account/);

    const listed = await amp(["scout", "list", "--json", "--config", config]);
    assert.equal(listed.code, 0);
    const proposals = JSON.parse(listed.stdout) as { id: string }[];
    assert.equal(proposals.length, 1);

    const before = await readFile(config, "utf8");
    const accepted = await amp(["scout", "accept", proposals[0]!.id, "--config", config]);
    assert.equal(accepted.code, 0, accepted.stderr);
    assert.match(accepted.stdout, /appended it to/);
    assert.match(accepted.stdout, /^\s+- id: /m);

    // Appended, not rewritten: every comment survives, and the config still loads.
    const after = await readFile(config, "utf8");
    assert.notEqual(after, before);
    assert.ok(after.includes(before.slice(0, before.indexOf("ventures:"))), "everything before ventures[] is byte-identical");
    const doctor = await amp(["doctor", "--config", config]);
    assert.equal(doctor.code, 0, `the appended block broke the config:\n${doctor.stdout}\n${doctor.stderr}`);
    assert.match(doctor.stdout, /venture\s+demo-explore-1 — inactive/);

    const twice = await amp(["scout", "accept", proposals[0]!.id, "--config", config]);
    assert.notEqual(twice.code, 0, "a proposal is decided once");

    // But the block can always be read again.
    const shown = await amp(["scout", "show", proposals[0]!.id, "--config", config]);
    assert.equal(shown.code, 0, shown.stderr);
    assert.match(shown.stdout, /Accepted/);
    assert.match(shown.stdout, /^\s+- id: /m);

    // A typo after `scout` must not turn into a run of the scout - that calls
    // the model and stores proposals, the opposite of the no-cost accept meant.
    const typo = await amp(["scout", "acept", proposals[0]!.id, "--config", config]);
    assert.equal(typo.code, 2);
    assert.match(typo.stderr, /Unknown command/);
  } finally {
    await cleanup();
  }
});

test("an account can be switched off and on without touching the config, and a cycle refuses while it is off", async () => {
  const { dir, config, cleanup } = await scratchConfig();
  try {
    const before = await readFile(config, "utf8");
    const off = await amp(["venture", "deactivate", "main", "--reason", "no clicks", "--config", config]);
    assert.equal(off.code, 0, off.stderr);
    assert.match(off.stdout, /deactivated by/);
    assert.equal(await readFile(config, "utf8"), before, "the config file is not what changed");

    const refused = await amp(["cycle", "run", "--config", config]);
    assert.match(`${refused.stdout}${refused.stderr}`, /deactivated|No active venture/);
    const doctor = await amp(["doctor", "--config", config]);
    assert.match(doctor.stdout, /venture\s+main — deactivated by .*no clicks/);

    const portfolio = await amp(["portfolio", "--config", config]);
    assert.match(portfolio.stdout, /deactivated by/);

    const on = await amp(["venture", "activate", "main", "--config", config]);
    assert.equal(on.code, 0, on.stderr);
    assert.match(on.stdout, /running again/);
    assert.equal((await amp(["cycle", "run", "--config", config])).code, 0, "and it runs again");
    assert.ok((await readFile(join(dir, ".amp", "venture-state.json"), "utf8")).includes('"inactive": {}'));
  } finally {
    await cleanup();
  }
});

test("the portfolio runs and lists every account", async () => {
  const { config, cleanup } = await scratchConfig();
  try {
    const outcome = await amp(["portfolio", "--config", config]);
    assert.equal(outcome.code, 0, outcome.stderr);
    assert.match(outcome.stdout, /All accounts/);
    assert.match(outcome.stdout, /^main\s/m);
    assert.match(outcome.stdout, /never summed across/);
  } finally {
    await cleanup();
  }
});

test("an unknown command says so and exits non-zero", async () => {
  const outcome = await amp(["definitely-not-a-command"]);
  assert.equal(outcome.code, 2);
  assert.match(outcome.stderr, /Unknown command/);
});

test("no arguments prints help rather than doing something", async () => {
  const outcome = await amp([]);
  assert.equal(outcome.code, 0);
  assert.match(outcome.stdout, /Usage/);
});

test("a mistyped --until refuses instead of running the whole cycle", async () => {
  // The flag whose entire job is "stop before this" used to be cast to a step
  // without checking, so a typo matched nothing and the cycle ran to the end -
  // under `autonomy: auto`, all the way through publishing.
  const { config, cleanup } = await scratchConfig();
  try {
    const outcome = await amp(["cycle", "run", "--until", "dispatchh", "--config", config]);
    assert.equal(outcome.code, 2, "an unknown step must not fail open");
    assert.match(outcome.stderr, /is not a step/);
    assert.match(outcome.stderr, /analyze/, "and it should list the ones that are");

    // The spelling that is right still works.
    const good = await amp(["cycle", "run", "--until", "plan", "--config", config]);
    assert.equal(good.code, 0);
  } finally {
    await cleanup();
  }
});
