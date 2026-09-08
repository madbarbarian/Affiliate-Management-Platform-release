import test from "node:test";
import assert from "node:assert/strict";

import { parseYaml, YamlError } from "../src/config/yaml.ts";

test("parses nested mappings and scalar types", () => {
  const parsed = parseYaml(`
version: 1
company:
  name: "Test Co"
  active: true
  ratio: 0.25
  nothing: ~
`) as Record<string, Record<string, unknown>>;

  assert.equal(parsed["version"], 1);
  assert.deepEqual(parsed["company"], {
    name: "Test Co",
    active: true,
    ratio: 0.25,
    nothing: null,
  });
});

test("parses sequences of scalars and of mappings", () => {
  const parsed = parseYaml(`
tags:
  - alpha
  - beta
channels:
  - id: threads
    enabled: true
    research:
      queries:
        - 副業
      minLikes: 300
  - id: x
    enabled: false
`) as Record<string, unknown>;

  assert.deepEqual(parsed["tags"], ["alpha", "beta"]);
  assert.deepEqual(parsed["channels"], [
    { id: "threads", enabled: true, research: { queries: ["副業"], minLikes: 300 } },
    { id: "x", enabled: false },
  ]);
});

test("parses flow sequences and flow mappings", () => {
  const parsed = parseYaml(`
list: [a, b, 3, true]
map: {x: 1, y: "two"}
empty: []
`) as Record<string, unknown>;

  assert.deepEqual(parsed["list"], ["a", "b", 3, true]);
  assert.deepEqual(parsed["map"], { x: 1, y: "two" });
  assert.deepEqual(parsed["empty"], []);
});

test("strips comments but keeps # inside quotes", () => {
  const parsed = parseYaml(`
# leading comment
disclosure: "#PR です"   # trailing comment
plain: value # cut here
`) as Record<string, unknown>;

  assert.equal(parsed["disclosure"], "#PR です");
  assert.equal(parsed["plain"], "value");
});

test("reads literal and folded block scalars", () => {
  const parsed = parseYaml(`
literal: |
  line one
  line two
chomped: |-
  no trailing newline
folded: >-
  these lines
  become one

  but a blank line breaks it
`) as Record<string, string>;

  assert.equal(parsed["literal"], "line one\nline two\n");
  assert.equal(parsed["chomped"], "no trailing newline");
  assert.equal(parsed["folded"], "these lines become one\nbut a blank line breaks it");
});

test("handles a leading document marker and blank lines", () => {
  const parsed = parseYaml(`---

a: 1

b: 2
`) as Record<string, unknown>;
  assert.deepEqual(parsed, { a: 1, b: 2 });
});

test("rejects duplicate keys rather than silently keeping the last", () => {
  assert.throws(() => parseYaml("a: 1\na: 2\n"), (error: unknown) => {
    assert.ok(error instanceof YamlError);
    assert.match(error.message, /duplicate key "a"/);
    return true;
  });
});

test("rejects tab indentation with a pointed message", () => {
  assert.throws(() => parseYaml("a:\n\tb: 1\n"), /tab indentation/);
});

test("rejects anchors rather than mis-parsing them", () => {
  assert.throws(() => parseYaml("a: &anchor\nb: 1\n"), /anchors, aliases and tags/);
});

test("reports the line number of a malformed entry", () => {
  assert.throws(() => parseYaml("a: 1\nthis is not a mapping\n"), (error: unknown) => {
    assert.ok(error instanceof YamlError);
    assert.equal(error.line, 2);
    return true;
  });
});

test("an empty document is an empty mapping, not a crash", () => {
  assert.deepEqual(parseYaml(""), {});
  assert.deepEqual(parseYaml("# only a comment\n"), {});
});

test("a quoted list entry containing a colon stays a string", () => {
  // `- "one: two"` parsed as the mapping {'"one': 'two"'}, silently mangling
  // any list entry with a colon and a space in it - a disclosure line, a
  // prohibited claim, a research query.
  assert.deepEqual(parseYaml('items:\n  - "one: two"\n  - plain\n'), {
    items: ["one: two", "plain"],
  });
});

test("an unquoted `- key: value` is still a mapping", () => {
  assert.deepEqual(parseYaml("items:\n  - key: value\n    other: 2\n"), {
    items: [{ key: "value", other: 2 }],
  });
});
