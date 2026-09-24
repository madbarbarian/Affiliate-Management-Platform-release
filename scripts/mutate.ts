#!/usr/bin/env node
/**
 * Mutation-test a single regression test against a single source change.
 *
 * CLAUDE.md's rule: "A regression test that does not fail on the bug is
 * decoration. Before committing one, put the bug back, watch the test go
 * red, then restore." Done by hand that is: edit the source, run the whole
 * suite, read the output, edit it back, and trust yourself that the restore
 * was exact. This makes it one command with one answer.
 *
 * Usage:
 *   node scripts/mutate.ts <file> --from <text> --to <text> -- <node --test args...>
 *
 * Run `node scripts/mutate.ts --help` for the full usage, exit codes and the
 * `arch -arm64` note (this script does not add that prefix itself).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const USAGE = `mutate.ts - prove a regression test actually tests something.

Usage:
  node scripts/mutate.ts <file> --from <text> --to <text> -- <node --test args...>

What it does:
  1. Checks --from appears in <file> exactly once, or refuses to touch it.
  2. Replaces that one occurrence with --to.
  3. Runs \`node --test <test args>\` with the mutation in place.
  4. Restores <file> no matter what happened above (including Ctrl-C),
     re-reads it, and reports loudly if it is not byte-identical to before.
  5. Reports the verdict via exit code - see below. This is the point: "did
     it actually go red" stops being a thing a person reads off scrollback.

Exit codes:
  0    the mutation was caught - the tests went red, as they should. This is
       what "the test is a real guard" looks like.
  1    the mutation was NOT caught - the tests stayed green. The test does
       not detect this change; it is decoration.
  2    usage error, or \`node --test\` itself could not be run. For a usage
       error nothing was touched. For a failed run, <file> has already been
       restored by the time this prints.
  3    <file> was mutated and restored, but the restore did not come back
       byte-identical. This overrides every other code above - stop and
       check <file> by hand (\`git diff -- "<file>"\`) before doing anything
       else.
  130/143  interrupted by SIGINT/SIGTERM mid-run. <file> has been restored
       (verified the same way as a normal run; a failed restore still wins
       as exit code 3).

--from must appear in <file> exactly once. If it appears more than once,
widen it with surrounding context until it is unique - there is no
--occurrence flag by design: a mutation that could land on the wrong
occurrence proves nothing, and picking one by index would let a vague
--from through instead of asking for a precise one.

On this machine, \`npm run check\` needs \`arch -arm64\` because the shell
runs under Rosetta. mutate.ts spawns \`node --test\` using the exact node
binary that is running mutate.ts itself (process.execPath) - so whatever
architecture you invoked mutate.ts with is what runs the tests too. Prefix
mutate.ts with \`arch -arm64\` yourself when that is what you want; the
script does not add it for you.

Example:
  node scripts/mutate.ts src/kernel/policy.ts \\
    --from 'fullText.includes(disclosure)' \\
    --to 'declared !== ""' \\
    -- test/policy.test.ts
`;

function fail(message: string): never {
  console.error(message);
  console.error(`\n${USAGE}`);
  process.exit(2);
}

export interface ParsedArgs {
  readonly file: string;
  readonly from: string;
  readonly to: string;
  readonly testArgs: readonly string[];
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  // Only checked in the first position, so a --to or a forwarded test arg
  // that happens to spell "-h" is never mistaken for a help request.
  if (argv[0] === "--help" || argv[0] === "-h") {
    console.log(USAGE);
    process.exit(0);
  }

  const file = argv[0];
  if (file === undefined || file.startsWith("-")) {
    fail(`Expected a file path as the first argument, got ${file === undefined ? "nothing" : `"${file}"`}.`);
  }

  const sepIndex = argv.indexOf("--");
  if (sepIndex === -1) {
    fail(`Missing "-- <test args>". mutate.ts needs to know what to run \`node --test\` against.`);
  }
  const testArgs = argv.slice(sepIndex + 1);
  if (testArgs.length === 0) {
    fail(`Nothing after "--". Pass at least one test file for \`node --test\` to run.`);
  }

  let from: string | undefined;
  let to: string | undefined;
  const own = argv.slice(1, sepIndex);
  for (let i = 0; i < own.length; i++) {
    const arg = own[i];
    if (arg === "--from" || arg === "--to") {
      const value = own[i + 1];
      if (value === undefined) fail(`${arg} needs a value.`);
      if (arg === "--from") from = value;
      else to = value;
      i++;
    } else {
      fail(`Unrecognized argument "${arg}" before "--". Expected --from and --to.`);
    }
  }

  if (from === undefined) fail(`Missing --from <text>.`);
  if (from === "") fail(`--from must not be empty - an empty string "appears" everywhere and mutates nothing.`);
  if (to === undefined) fail(`Missing --to <text>.`);
  if (from === to) fail(`--from and --to are identical ("${from}") - that is not a mutation.`);

  return { file, from, to, testArgs };
}

/** Literal substring count - never a regex, so --from's own characters never need escaping. */
export function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  let count = 0;
  let index = 0;
  for (;;) {
    const found = haystack.indexOf(needle, index);
    if (found === -1) return count;
    count++;
    index = found + needle.length;
  }
}

function truncate(text: string, max = 80): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function readFileOrExit(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") fail(`${file} does not exist.`);
    if (err.code === "EISDIR") fail(`${file} is a directory, not a file.`);
    throw error;
  }
}

/** Fails (usage error, exit 2) unless --from appears in `file` exactly once. Nothing is touched either way. */
export function requireUniqueOccurrence(file: string, from: string): void {
  const content = readFileOrExit(file);
  const occurrences = countOccurrences(content, from);
  if (occurrences === 0) {
    fail(`--from "${truncate(from)}" does not appear in ${file}. Nothing to mutate - check the exact text, including whitespace.`);
  }
  if (occurrences > 1) {
    fail(
      `--from "${truncate(from)}" appears ${occurrences} times in ${file}; make it unique by widening it ` +
        `with surrounding context. mutate.ts will not guess which one you mean - see --help for why there ` +
        `is no --occurrence flag.`,
    );
  }
}

export interface RestoreResult {
  readonly restoredCleanly: boolean;
  readonly error?: string;
}

/** Writes the original bytes back and re-reads to confirm. Never throws - a failed restore is reported, not raised. */
function restoreFile(file: string, originalBuffer: Buffer): RestoreResult {
  try {
    writeFileSync(file, originalBuffer);
    const after = readFileSync(file);
    return { restoredCleanly: after.equals(originalBuffer) };
  } catch (error) {
    return { restoredCleanly: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export interface MutationTarget {
  readonly file: string;
  readonly from: string;
  readonly to: string;
}

export type MutationRunResult<T> =
  | { readonly ok: true; readonly value: T; readonly restore: RestoreResult }
  | { readonly ok: false; readonly error: unknown; readonly restore: RestoreResult };

/**
 * Applies the mutation, runs `run`, and restores the file whether `run`
 * resolves or throws - the manual procedure's weak point was exactly that
 * this step was easy to skip after a surprise.
 */
export async function withMutation<T>(target: MutationTarget, run: () => Promise<T>): Promise<MutationRunResult<T>> {
  const originalBuffer = readFileSync(target.file);
  const original = originalBuffer.toString("utf8");
  writeFileSync(target.file, original.replace(target.from, target.to), "utf8");

  let outcome: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };
  let restore: RestoreResult;
  try {
    outcome = { ok: true, value: await run() };
  } catch (error) {
    outcome = { ok: false, error };
  } finally {
    restore = restoreFile(target.file, originalBuffer);
  }

  return outcome.ok ? { ok: true, value: outcome.value, restore } : { ok: false, error: outcome.error, restore };
}

export interface TestRunResult {
  readonly exitCode: number;
  readonly signal: NodeJS.Signals | null;
}

/**
 * `node --test` marks a file it spawns as a test child with
 * `NODE_TEST_CONTEXT=child-v8` in that child's environment. mutate.ts is
 * routinely run from inside this repo's own suite (this file tests it that
 * way), which means mutate.ts's own process can inherit that variable and
 * pass it straight on to the `node --test` it spawns. That grandchild then
 * believes *it* is a nested child of some other test run, prints "run() is
 * being called recursively within a test file", silently skips the test
 * files, and exits 0 - which reads back here as the mutation being missed,
 * whether or not it actually was. Caught by running this script's own test
 * suite under `node --test` and watching a should-fail case report green.
 */
function childTestEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

function runNodeTest(testArgs: readonly string[], onSpawn: (child: ChildProcess) => void): Promise<TestRunResult> {
  return new Promise((promiseResolve, promiseReject) => {
    const child = spawn(process.execPath, ["--test", ...testArgs], { stdio: "inherit", env: childTestEnv() });
    onSpawn(child);
    child.once("error", promiseReject);
    child.once("close", (code, signal) => {
      promiseResolve({ exitCode: code ?? 1, signal });
    });
  });
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function reportRestore(file: string, restore: RestoreResult): void {
  if (restore.restoredCleanly) return;
  console.error(
    `\n!!! RESTORE FAILED !!!\n` +
      `${file} is NOT confirmed byte-identical to what it was before mutate.ts touched it.\n` +
      (restore.error ? `Writing it back raised: ${restore.error}\n` : "") +
      `Stop and check it by hand right now: git diff -- "${file}"`,
  );
}

export async function main(argv: readonly string[]): Promise<number> {
  const { file, from, to, testArgs } = parseArgs(argv);
  requireUniqueOccurrence(file, from);

  let child: ChildProcess | undefined;
  let interruptSignal: NodeJS.Signals | undefined;
  const forwardSignal = (signal: NodeJS.Signals): void => {
    interruptSignal = signal;
    child?.kill(signal);
  };
  process.on("SIGINT", forwardSignal);
  process.on("SIGTERM", forwardSignal);

  let outcome: MutationRunResult<TestRunResult>;
  try {
    outcome = await withMutation({ file, from, to }, () => runNodeTest(testArgs, (spawned) => (child = spawned)));
  } finally {
    process.removeListener("SIGINT", forwardSignal);
    process.removeListener("SIGTERM", forwardSignal);
  }

  reportRestore(file, outcome.restore);
  const mutationLabel = `${file}: "${truncate(from)}" -> "${truncate(to)}"`;

  // A dirty working tree is worse than a misreported verdict - this beats
  // every other outcome below, including a clean interrupt.
  if (!outcome.restore.restoredCleanly) return 3;

  if (interruptSignal) {
    console.error(`\nInterrupted (${interruptSignal}) - ${file} has been restored.`);
    return 128 + (interruptSignal === "SIGINT" ? 2 : 15);
  }

  if (!outcome.ok) {
    console.error(`\nmutate.ts could not run the tests: ${describeError(outcome.error)}`);
    return 2;
  }

  if (outcome.value.exitCode === 0) {
    console.error(
      `\nDECORATION: \`node --test ${testArgs.join(" ")}\` passed with the mutation in place (${mutationLabel}). ` +
        `The test does not detect this change.`,
    );
    return 1;
  }

  console.log(
    `\nCAUGHT: \`node --test ${testArgs.join(" ")}\` failed under the mutation (${mutationLabel}). ` +
      `The "not ok" output above is the evidence.`,
  );
  return 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      // Only reachable if something above threw outside main's own handling
      // (a programmer error, not a usage or test-run failure).
      console.error(error);
      process.exitCode = 2;
    },
  );
}
