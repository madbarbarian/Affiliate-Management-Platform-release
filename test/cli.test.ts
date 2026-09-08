import test from "node:test";
import assert from "node:assert/strict";

import { commandKey, parseArgs } from "../src/cli.ts";

test("recognises one-word and two-word commands", () => {
  assert.equal(commandKey(parseArgs(["doctor"]).command), "doctor");
  assert.equal(commandKey(parseArgs(["cycle", "run"]).command), "cycle run");
  assert.equal(commandKey(parseArgs(["cycle", "status"]).command), "cycle status");
});

test("keeps a command's argument without breaking the command name", () => {
  const options = parseArgs(["approve", "dec_123"]);
  assert.equal(commandKey(options.command), "approve");
  assert.equal(options.command[1], "dec_123");
});

test("parses flags in any position", () => {
  const options = parseArgs(["--dry-run", "cycle", "run", "--venture", "main", "--until", "plan"]);
  assert.equal(commandKey(options.command), "cycle run");
  assert.equal(options.dryRun, true);
  assert.equal(options.venture, "main");
  assert.equal(options.until, "plan");
});

test("parses comma-separated selections and orderings", () => {
  const options = parseArgs(["approve", "dec_1", "--select", "a, b ,c", "--order", "c,a"]);
  assert.deepEqual(options.select, ["a", "b", "c"]);
  assert.deepEqual(options.order, ["c", "a"]);
});

test("--none and --json are recognised", () => {
  const options = parseArgs(["approve", "dec_1", "--none", "--json"]);
  assert.equal(options.none, true);
  assert.equal(options.json, true);
});

test("--days only accepts a positive number", () => {
  assert.equal(parseArgs(["report", "--days", "30"]).days, 30);
  assert.equal(parseArgs(["report", "--days", "-2"]).days, undefined);
  assert.equal(parseArgs(["report", "--days", "nonsense"]).days, undefined);
});

test("no command asks for help rather than doing something surprising", () => {
  assert.equal(commandKey(parseArgs([]).command), "");
  assert.equal(parseArgs(["--help"]).help, true);
  assert.equal(parseArgs(["-h"]).help, true);
});
