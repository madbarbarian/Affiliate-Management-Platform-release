/**
 * `scripts/mutate.ts` automates CLAUDE.md's manual mutation-testing
 * procedure, so this file has to prove the automation is at least as
 * trustworthy as the hand-run version it replaces: refuses an ambiguous
 * target before touching anything, restores the file whichever way the run
 * ends (pass, fail, thrown error, Ctrl-C), and reports the one thing the
 * whole tool exists for - did the mutation actually get caught - as an exit
 * code rather than a line to read off scrollback.
 *
 * `withMutation` is exercised directly for the pass/throw cases (fast,
 * deterministic, no subprocess). The refuse/catch/decorate/interrupt cases
 * go through the real binary, the same way `cli.smoke.test.ts` tests
 * `cli.ts` - argument parsing and process/signal handling are exactly the
 * band a unit test cannot see.
 *
 * Every fixture directory is created with a space in its own name
 * (`mkdtemp(..., "amp mutate ...")`), on top of already living under this
 * repo's own path (`.../Mobile Documents/...`). A file argument or a spawned
 * child that mishandles a space in a path is the most likely way this script
 * breaks, per its own spec.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { countOccurrences, withMutation } from "../scripts/mutate.ts";
import { repoRoot } from "../src/config/load.ts";

const run = promisify(execFile);
const ROOT = repoRoot();
const MUTATE = join(ROOT, "scripts", "mutate.ts");

type Outcome = { readonly code: number; readonly stdout: string; readonly stderr: string };

async function runMutate(args: readonly string[]): Promise<Outcome> {
  try {
    const { stdout, stderr } = await run(process.execPath, [MUTATE, ...args], { cwd: ROOT, timeout: 30_000 });
    return { code: 0, stdout, stderr };
  } catch (cause) {
    const error = cause as { code?: number; stdout?: string; stderr?: string };
    return { code: error.code ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

/**
 * A source file with one line a real test exercises (`isEven`'s `=== 0`) and
 * one it does not (`LABEL`) - one fixture gives both a mutation the suite
 * below catches and one it does not, which is the whole distinction the tool
 * exists to report.
 */
async function scratchFixture(): Promise<{
  dir: string;
  target: string;
  targetTest: string;
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "amp mutate fixture "));
  const target = join(dir, "target.ts");
  const targetTest = join(dir, "target.test.ts");
  await writeFile(
    target,
    [
      "export function isEven(n: number): boolean {",
      "  return n % 2 === 0;",
      "}",
      "",
      "export function isOdd(n: number): boolean {",
      "  return n % 2 !== 0;",
      "}",
      "",
      'export const LABEL = "even-checker";',
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    targetTest,
    [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      'import { isEven } from "./target.ts";',
      "",
      'test("4 is even", () => {',
      "  assert.equal(isEven(4), true);",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );
  return { dir, target, targetTest, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("countOccurrences counts non-overlapping literal matches, never as a regex", () => {
  assert.equal(countOccurrences("abcabc", "abc"), 2);
  assert.equal(countOccurrences("abcabc", "xyz"), 0);
  // If this were a regex, "a.c" would match "abc" too - it must not.
  assert.equal(countOccurrences("abc a.c", "a.c"), 1);
});

test("withMutation applies --from/--to only for the duration of run(), then restores it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "amp mutate unit "));
  try {
    const file = join(dir, "target.txt");
    await writeFile(file, "the quick brown fox", "utf8");

    const seenDuringRun: string[] = [];
    const result = await withMutation({ file, from: "quick", to: "slow" }, async () => {
      seenDuringRun.push(await readFile(file, "utf8"));
      return "done";
    });

    assert.equal(seenDuringRun[0], "the slow brown fox", "the mutation must be in place while run() executes");
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.value, "done");
    assert.equal(result.restore.restoredCleanly, true);
    assert.equal(await readFile(file, "utf8"), "the quick brown fox", "restored after a successful run");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("withMutation restores the file even when run() throws", async () => {
  const dir = await mkdtemp(join(tmpdir(), "amp mutate unit "));
  try {
    const file = join(dir, "target.txt");
    await writeFile(file, "the quick brown fox", "utf8");
    const boom = new Error("boom");

    const result = await withMutation({ file, from: "quick", to: "slow" }, async () => {
      throw boom;
    });

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error, boom);
    assert.equal(result.restore.restoredCleanly, true);
    assert.equal(await readFile(file, "utf8"), "the quick brown fox", "restored even though run() threw");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("refuses a --from that is absent from the file, and touches nothing", async () => {
  const { target, targetTest, cleanup } = await scratchFixture();
  try {
    const before = await readFile(target, "utf8");
    const outcome = await runMutate([target, "--from", "no-such-text-in-this-file", "--to", "x", "--", targetTest]);
    assert.equal(outcome.code, 2);
    assert.match(outcome.stderr, /does not appear in/);
    assert.equal(await readFile(target, "utf8"), before);
  } finally {
    await cleanup();
  }
});

test("refuses a --from that appears more than once, names the count, and touches nothing", async () => {
  const { target, targetTest, cleanup } = await scratchFixture();
  try {
    const before = await readFile(target, "utf8");
    // "n % 2" sits in both isEven and isOdd.
    const outcome = await runMutate([target, "--from", "n % 2", "--to", "n % 3", "--", targetTest]);
    assert.equal(outcome.code, 2);
    assert.match(outcome.stderr, /appears 2 times/);
    assert.equal(await readFile(target, "utf8"), before);
  } finally {
    await cleanup();
  }
});

test("a mutation the test catches: exits 0, prints the test's own failing output, restores the file", async () => {
  const { target, targetTest, cleanup } = await scratchFixture();
  try {
    const before = await readFile(target, "utf8");
    const outcome = await runMutate([target, "--from", "n % 2 === 0", "--to", "n % 2 === 1", "--", targetTest]);
    assert.equal(outcome.code, 0);
    assert.match(outcome.stdout + outcome.stderr, /not ok/);
    assert.match(outcome.stdout, /CAUGHT/);
    assert.equal(await readFile(target, "utf8"), before, "restored after a failing (caught) run");
  } finally {
    await cleanup();
  }
});

test("a mutation the test does not catch: exits 1, says so plainly, restores the file", async () => {
  const { target, targetTest, cleanup } = await scratchFixture();
  try {
    const before = await readFile(target, "utf8");
    // LABEL is not read by the test above, so this changes nothing it checks.
    const outcome = await runMutate([target, "--from", "even-checker", "--to", "not-even-checker", "--", targetTest]);
    assert.equal(outcome.code, 1);
    assert.match(outcome.stderr, /DECORATION/);
    assert.equal(await readFile(target, "utf8"), before, "restored after a passing (undetected) run");
  } finally {
    await cleanup();
  }
});

test("SIGINT mid-run restores the file instead of leaving it mutated", async () => {
  const { dir, target, cleanup } = await scratchFixture();
  const slowTest = join(dir, "slow.test.ts");
  await writeFile(
    slowTest,
    ['import test from "node:test";', "", 'test("slow", async () => {', "  await new Promise((r) => setTimeout(r, 8000));", "});", ""].join(
      "\n",
    ),
    "utf8",
  );
  try {
    const before = await readFile(target, "utf8");
    const child = spawn(process.execPath, [MUTATE, target, "--from", "even-checker", "--to", "x", "--", slowTest], {
      cwd: ROOT,
      stdio: "ignore",
    });
    // Give mutate.ts time to validate, mutate, and get its own child into the
    // 8s sleep before we interrupt it.
    await new Promise((r) => setTimeout(r, 1000));
    child.kill("SIGINT");
    const [code] = (await once(child, "close")) as [number | null];
    assert.equal(code, 130, "128 + SIGINT(2)");
    assert.equal(await readFile(target, "utf8"), before, "restored after being interrupted");
  } finally {
    await cleanup();
  }
});
