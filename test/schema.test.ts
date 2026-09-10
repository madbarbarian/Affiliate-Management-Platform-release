/**
 * What the roles actually ask the API for.
 *
 * `output_config.format` takes a subset of JSON Schema. The first real model
 * call this platform ever made came back:
 *
 *     400 output_config.format.schema: For 'array' type, property 'maxItems'
 *         is not supported
 *
 * Every role's schema used at least one keyword from that list, so none of them
 * could have worked - and nothing noticed, because the whole suite runs on the
 * mock, which accepts anything. So this walks the schemas the roles really send
 * (the mock records them) rather than the builders in isolation.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { unwrap } from "../src/core/result.ts";
import { array, integer, number, object, string, stripUnsupported, UNSUPPORTED_KEYWORDS } from "../src/llm/schema.ts";
import type { JsonSchema } from "../src/llm/schema.ts";
import { runScout } from "../src/kernel/exploration.ts";
import { createTestCompany, testConfig } from "./helpers.ts";

/** Every key present anywhere in the schema, at any depth. */
function keysIn(value: unknown, found: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const entry of value) keysIn(entry, found);
  } else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      found.add(key);
      keysIn(child, found);
    }
  }
  return found;
}

test("no schema the roles send carries a keyword the API refuses", async () => {
  const company = createTestCompany({
    config: testConfig({
      company: { name: "Auto Co", operator: "auto", autonomy: "auto", exploration: { enabled: true } },
    }),
  });
  unwrap(await company.orchestrator.runCycle("main"));
  unwrap(await runScout(company.services, { count: 1 }));

  const structured = company.llm.calls.filter((call) => call.schema !== undefined);
  // Six daily roles plus the scout. If this ever drops to nothing the test
  // below passes vacuously, which is how the bug survived in the first place.
  assert.ok(structured.length >= 6, `expected the roles' schemas, saw ${structured.length}`);

  for (const call of structured) {
    const keys = keysIn(call.schema);
    for (const banned of UNSUPPORTED_KEYWORDS) {
      assert.equal(
        keys.has(banned),
        false,
        `${call.purpose} sends "${banned}", which output_config.format rejects with a 400`,
      );
    }
  }
});

test("a bound the schema cannot carry is told to the model instead", () => {
  // Dropping it silently would be worse than the 400: the model would never
  // hear "at most three hashtags" and nothing downstream counts them.
  const hashtags = array(string(), { description: "Hashtags.", maxItems: 3 });
  assert.match(String(hashtags["description"]), /Hashtags\./);
  assert.match(String(hashtags["description"]), /At most 3/);

  const both = array(string(), { minItems: 1, maxItems: 3 });
  assert.match(String(both["description"]), /Between 1 and 3/);

  const score = integer("How AI it reads.", { minimum: 0, maximum: 100 });
  assert.match(String(score["description"]), /Between 0 and 100/);
  assert.equal(score["type"], "integer");

  const title = string("A working title.", { maxLength: 80 });
  assert.match(String(title["description"]), /At most 80 characters/);

  // A field with no description of its own still gets the bound.
  assert.match(String(number(undefined, { minimum: 0 })["description"]), /0 or more/);
  // And one with neither gets no empty description at all.
  assert.equal("description" in string(), false);
});

test("a hand-written schema is cleaned before it reaches the wire", () => {
  // The builders no longer produce these; this is the guard for a schema that
  // did not come from them, at the one place every request passes through.
  const handWritten: JsonSchema = {
    type: "object",
    properties: {
      tags: { type: "array", items: { type: "string", maxLength: 20 }, maxItems: 3 },
      score: { type: "integer", minimum: 0, maximum: 100 },
    },
    required: ["tags", "score"],
    additionalProperties: false,
  };
  const cleaned = stripUnsupported(handWritten);
  const keys = keysIn(cleaned);
  for (const banned of UNSUPPORTED_KEYWORDS) assert.equal(keys.has(banned), false, banned);

  // And it is still the same schema otherwise.
  assert.deepEqual(cleaned["required"], ["tags", "score"]);
  assert.equal(cleaned["additionalProperties"], false);
  const score = (cleaned["properties"] as Record<string, JsonSchema>)["score"];
  assert.equal(score?.["type"], "integer");
});

test("a field named after a keyword is a field, not a keyword", () => {
  // The walk did not know where it was, so a property called `pattern` was
  // deleted from `properties` and left standing in `required` - a 400 saying
  // the schema asks for a field it does not define. `pattern` is this
  // project's own word for what the playbook learns, so this was one schema
  // away, and the message it produces points nowhere near the cause.
  const shape: JsonSchema = object({
    pattern: string("The pattern this post follows."),
    minimum: integer("The floor."),
    maxItems: string("Deliberately awkward."),
  });
  const cleaned = stripUnsupported(shape);
  const properties = cleaned["properties"] as Record<string, JsonSchema>;

  for (const name of ["pattern", "minimum", "maxItems"]) {
    assert.ok(properties[name], `the field "${name}" was taken for a keyword and deleted`);
    assert.ok(
      (cleaned["required"] as string[]).includes(name),
      `"${name}" is required but no longer defined`,
    );
  }
  assert.equal(properties["pattern"]?.["type"], "string");

  // And the keyword in the same position is still removed.
  const bounded = stripUnsupported({
    type: "object",
    properties: { pattern: { type: "string", pattern: "^a", maxLength: 4 } },
  });
  const field = (bounded["properties"] as Record<string, JsonSchema>)["pattern"]!;
  assert.equal(field["type"], "string");
  assert.equal("pattern" in field, false, "the keyword inside the field survived");
  assert.equal("maxLength" in field, false);
});

test("the builders still produce what a schema needs to be a schema", () => {
  const shape: JsonSchema = object({ name: string("A name.") }, { description: "Someone." });
  assert.equal(shape["additionalProperties"], false, "a relaxed object silently accepts anything");
  assert.deepEqual(shape["required"], ["name"]);
  assert.equal(shape["description"], "Someone.");
});
