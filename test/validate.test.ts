import test from "node:test";
import assert from "node:assert/strict";

import { array, boolean, enumOf, integer, number, object, string, type JsonSchema } from "../src/llm/schema.ts";
import { MAX_DEPTH, MAX_ISSUES, validate } from "../src/llm/validate.ts";

function paths(result: ReturnType<typeof validate>): string[] {
  assert.equal(result.ok, false);
  return result.ok ? [] : result.issues.map((issue) => issue.path);
}

function messages(result: ReturnType<typeof validate>): string[] {
  assert.equal(result.ok, false);
  return result.ok ? [] : result.issues.map((issue) => issue.message);
}

// ---------------------------------------------------------------------------
// Each builder, accepted and rejected, at the top level
// ---------------------------------------------------------------------------

test("accepts a value that matches an object schema, and rejects one that is not an object", () => {
  const schema = object({ name: string() });
  assert.equal(validate(schema, { name: "a" }).ok, true);
  assert.equal(validate(schema, "not an object").ok, false);
  assert.equal(validate(schema, null).ok, false);
  assert.equal(validate(schema, [1, 2]).ok, false);
});

test("accepts a value that matches an array schema, and rejects a non-array", () => {
  const schema = array(string());
  assert.equal(validate(schema, ["a", "b"]).ok, true);
  assert.equal(validate(schema, "not an array").ok, false);
  assert.equal(validate(schema, { 0: "a" }).ok, false);
});

test("accepts a matching string, and rejects a non-string", () => {
  const schema = string();
  assert.equal(validate(schema, "hi").ok, true);
  assert.equal(validate(schema, 5).ok, false);
});

test("accepts a matching number, and rejects a non-number", () => {
  const schema = number();
  assert.equal(validate(schema, 3.5).ok, true);
  assert.equal(validate(schema, "3.5").ok, false);
});

test("accepts a whole number for an integer schema, and rejects a fractional one", () => {
  const schema = integer();
  assert.equal(validate(schema, 5).ok, true);
  assert.equal(validate(schema, 5.5).ok, false);
  assert.equal(validate(schema, "5").ok, false);
});

test("accepts a matching boolean, and rejects a non-boolean", () => {
  const schema = boolean();
  assert.equal(validate(schema, true).ok, true);
  assert.equal(validate(schema, "true").ok, false);
});

// ---------------------------------------------------------------------------
// Object semantics: required, additionalProperties, what gets walked
// ---------------------------------------------------------------------------

test("names every required property missing from the value, not just the first", () => {
  const schema = object({ a: string(), b: string(), c: string() }, { required: ["a", "b", "c"] });
  const result = validate(schema, {});
  assert.deepEqual(paths(result).sort(), ["$.a", "$.b", "$.c"]);
});

test("names every key that additionalProperties: false does not allow", () => {
  const schema = object({ a: string() });
  const result = validate(schema, { a: "x", surprise: 1, another: 2 });
  assert.deepEqual(paths(result).sort(), ["$.another", "$.surprise"]);
});

test("null and an array both fail an object schema, despite typeof reporting 'object' for both", () => {
  // The exact bug this validator must not have: `typeof null === "object"` and
  // `typeof [] === "object"` are both true in JS.
  const schema = object({ a: string() });
  assert.equal(validate(schema, null).ok, false);
  assert.equal(validate(schema, []).ok, false);
});

test("an absent optional property is never walked, and a missing required one is reported once, not walked", () => {
  const schema = object({ a: string(), b: integer() }, { required: ["a"] });
  // `b` is optional and absent - no issue about it at all, and no type-mismatch
  // issue about `undefined` not being an integer.
  const result = validate(schema, { a: "x" });
  assert.equal(result.ok, true);

  // `a` is required and absent - reported once, never also walked as "not a string".
  const missing = validate(object({ a: string() }, { required: ["a"] }), {});
  assert.deepEqual(paths(missing), ["$.a"]);
});

// ---------------------------------------------------------------------------
// enum
// ---------------------------------------------------------------------------

test("rejects a string outside its enum, naming the allowed values", () => {
  const schema = enumOf(["red", "green", "blue"]);
  assert.equal(validate(schema, "green").ok, true);
  const result = validate(schema, "purple");
  assert.equal(result.ok, false);
  const [message] = messages(result);
  assert.match(message ?? "", /red/);
  assert.match(message ?? "", /green/);
  assert.match(message ?? "", /blue/);
  assert.match(message ?? "", /purple/);
});

test("an enum listing over MAX_ENUM_LISTED values is truncated with a count of the rest", () => {
  const values = Array.from({ length: 15 }, (_, i) => `v${i}`);
  const result = validate(enumOf(values), "not-a-value");
  const [message] = messages(result);
  assert.match(message ?? "", /\.\.\.and 5 more/);
});

// ---------------------------------------------------------------------------
// Nested paths
// ---------------------------------------------------------------------------

test("path convention: root is $, a property is $.name, an array index is $.items[0]", () => {
  const schema = object({ items: array(object({ title: string() }, { required: ["title"] })) });
  const result = validate(schema, { items: [{ title: "ok" }, { title: 5 }] });
  assert.deepEqual(paths(result), ["$.items[1].title"]);
});

test("a deeply nested object-in-array-in-object path is reported correctly", () => {
  const schema = object({
    posts: array(
      object({ tags: array(string()) }, { required: ["tags"] }),
    ),
  });
  const result = validate(schema, { posts: [{ tags: ["a", 1, "c"] }] });
  assert.deepEqual(paths(result), ["$.posts[0].tags[1]"]);
});

// ---------------------------------------------------------------------------
// A combined schema using every builder together
// ---------------------------------------------------------------------------

test("a schema combining every builder validates a fully-correct value and names every fault in a broken one", () => {
  const schema: JsonSchema = object(
    {
      title: string(),
      score: number(),
      count: integer(),
      active: boolean(),
      mood: enumOf(["happy", "sad"]),
      tags: array(string()),
    },
    { required: ["title", "score", "count", "active", "mood", "tags"] },
  );

  const good = {
    title: "hello",
    score: 1.5,
    count: 3,
    active: true,
    mood: "happy",
    tags: ["a", "b"],
  };
  assert.equal(validate(schema, good).ok, true);

  const bad = {
    title: 5,
    score: "1.5",
    count: 3.5,
    active: "yes",
    mood: "furious",
    tags: ["a", 1],
  };
  const result = validate(schema, bad);
  assert.deepEqual(
    paths(result).sort(),
    ["$.active", "$.count", "$.mood", "$.score", "$.tags[1]", "$.title"].sort(),
  );
});

// ---------------------------------------------------------------------------
// MAX_ISSUES and its sentinel
// ---------------------------------------------------------------------------

test("never reports more than MAX_ISSUES issues, and the last one is a fixed sentinel", () => {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (let i = 0; i < MAX_ISSUES + 10; i += 1) {
    properties[`field${i}`] = string();
    required.push(`field${i}`);
  }
  const schema = object(properties, { required });
  const result = validate(schema, {}); // every required field missing
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.issues.length, MAX_ISSUES);
  const last = result.issues[result.issues.length - 1];
  assert.deepEqual(last, { path: "$", message: `more than ${MAX_ISSUES} issues found; showing the first ${MAX_ISSUES}.` });
});

// ---------------------------------------------------------------------------
// Fail-closed on a malformed schema, at any recursion depth
// ---------------------------------------------------------------------------

test("a schema fragment with no recognised type is a rejection at that path, not a silent pass", () => {
  assert.equal(validate({} as JsonSchema, "anything").ok, false);
  assert.equal(validate({ type: "not-a-real-type" } as unknown as JsonSchema, "anything").ok, false);
});

test("a null schema anywhere in the tree fails closed rather than throwing or passing", () => {
  const schema = object({ child: null as unknown as JsonSchema });
  const result = validate(schema, { child: "anything" });
  assert.equal(result.ok, false);
});

test("a schema whose array items fragment is malformed fails closed for every element", () => {
  const schema = array(undefined as unknown as JsonSchema);
  const result = validate(schema, ["a", "b"]);
  assert.equal(result.ok, false);
});

// ---------------------------------------------------------------------------
// validate() never throws
// ---------------------------------------------------------------------------

test("validate() never throws, for a battery of pathological schema/value combinations", () => {
  const circular: Record<string, unknown> = { self: undefined };
  circular["self"] = circular;

  const withBigInt = { amount: 10n };

  // A schema nested past MAX_DEPTH.
  let deepSchema: JsonSchema = string();
  for (let i = 0; i < MAX_DEPTH + 5; i += 1) deepSchema = object({ next: deepSchema }, { required: ["next"] });
  let deepValue: unknown = "leaf";
  for (let i = 0; i < MAX_DEPTH + 5; i += 1) deepValue = { next: deepValue };

  const cases: [JsonSchema, unknown][] = [
    [null as unknown as JsonSchema, {}],
    [{} as JsonSchema, {}],
    [{ type: "object" } as JsonSchema, null],
    [{ type: "object" } as JsonSchema, []],
    [object({ a: string() }), circular],
    [object({ a: number() }), withBigInt],
    [deepSchema, deepValue],
    [array(object({ a: string() })), [null, 5, "x", {}]],
    [string(), circular],
    [string(), withBigInt],
    [undefined as unknown as JsonSchema, undefined],
  ];

  for (const [schema, value] of cases) {
    assert.doesNotThrow(() => validate(schema, value), `validate() threw for schema=${JSON.stringify(schema) ?? "n/a"}`);
  }
});

test("a value preview never throws even when the offending value contains a circular reference or a BigInt", () => {
  const circular: Record<string, unknown> = {};
  circular["self"] = circular;
  const result = validate(string(), circular);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.issues[0]?.message ?? "", /<value could not be shown>/);

  const bigIntResult = validate(string(), 10n);
  assert.equal(bigIntResult.ok, false);
  if (bigIntResult.ok) return;
  assert.match(bigIntResult.issues[0]?.message ?? "", /<value could not be shown>/);
});
