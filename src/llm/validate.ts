/**
 * A validator for the small JSON Schema subset `src/llm/schema.ts` builds.
 *
 * Phase 1a of `docs/3-development/external-generation-design.md`: the answer a
 * licensee's own Claude Code Routine posts back to `POST /job/result` is
 * untrusted input from a process this platform does not control, and it has to
 * be checked against the same schema a model response would be, before
 * anything downstream treats it as real. This is that check, standalone - it
 * knows nothing about routes, jobs or state; it only knows the four builder
 * shapes (`object`, `array`, `string`/`number`/`integer`/`boolean`, `enumOf`)
 * and their exact keyword subset (`type`, `properties`, `required`,
 * `additionalProperties: false`, `items`, `enum` on strings only,
 * `description` - documentation, never a constraint).
 *
 * **Fail-closed by construction.** A schema fragment this validator does not
 * recognise - `null`, not an object, or missing a recognised `type` - is a
 * rejection at that path, never a silent pass and never a thrown exception.
 * `validate()` itself never throws, whatever it is given: see the pathological
 * inputs covered in `test/validate.test.ts`.
 */

import type { JsonSchema } from "./schema.ts";

export type ValidationIssue = { readonly path: string; readonly message: string };
export type ValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly issues: readonly ValidationIssue[] };

/** Issues collected in one call to `validate()`. Never more than this many. */
const MAX_ISSUES = 20;
/** Recursion depth `validate()` stops descending at, reporting one issue instead. */
const MAX_DEPTH = 20;
/** Characters of a previewed value's `JSON.stringify` kept in a message. */
const MAX_VALUE_PREVIEW = 100;
/** `enum` values named in a message before "...and N more". */
const MAX_ENUM_LISTED = 10;

const RECOGNISED_TYPES = new Set(["object", "array", "string", "number", "integer", "boolean"]);

/** Collects issues up to `MAX_ISSUES`, then a single fixed sentinel and nothing more. */
class IssueCollector {
  private readonly items: ValidationIssue[] = [];
  private full = false;

  add(path: string, message: string): void {
    if (this.full) return;
    if (this.items.length < MAX_ISSUES - 1) {
      this.items.push({ path, message });
      return;
    }
    // The last slot is the sentinel, not one more real issue.
    this.items.push({ path: "$", message: `more than ${MAX_ISSUES} issues found; showing the first ${MAX_ISSUES}.` });
    this.full = true;
  }

  get hasAny(): boolean {
    return this.items.length > 0;
  }

  get all(): readonly ValidationIssue[] {
    return this.items;
  }
}

export function validate(schema: JsonSchema, value: unknown): ValidationResult {
  const issues = new IssueCollector();
  walk(schema, value, "$", 0, issues);
  return issues.hasAny ? { ok: false, issues: issues.all } : { ok: true };
}

function walk(schema: unknown, value: unknown, path: string, depth: number, issues: IssueCollector): void {
  if (depth > MAX_DEPTH) {
    issues.add(path, `exceeds the maximum schema depth of ${MAX_DEPTH}; stopped checking here.`);
    return;
  }

  // Fail-closed: every recursion entry re-checks the schema fragment itself,
  // not only the top-level call - a schema built by hand (never by
  // src/llm/schema.ts) could nest something malformed several levels down.
  if (!isPlainObject(schema)) {
    issues.add(path, "the schema at this location has no recognised type; this validator only understands what src/llm/schema.ts can build.");
    return;
  }
  const type = schema["type"];
  if (typeof type !== "string" || !RECOGNISED_TYPES.has(type)) {
    issues.add(path, "the schema at this location has no recognised type; this validator only understands what src/llm/schema.ts can build.");
    return;
  }

  switch (type) {
    case "object":
      walkObject(schema, value, path, depth, issues);
      return;
    case "array":
      walkArray(schema, value, path, depth, issues);
      return;
    case "string":
      walkString(schema, value, path, issues);
      return;
    case "number":
      walkNumber(value, path, issues, false);
      return;
    case "integer":
      walkNumber(value, path, issues, true);
      return;
    case "boolean":
      if (typeof value !== "boolean") {
        issues.add(path, `expected a boolean, got ${previewOf(value)}.`);
      }
      return;
  }
}

function walkObject(schema: Record<string, unknown>, value: unknown, path: string, depth: number, issues: IssueCollector): void {
  // `typeof null === "object"` and `typeof [] === "object"` are both true, so
  // both are rejected explicitly rather than falling through to a property walk.
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    issues.add(path, `expected an object, got ${previewOf(value)}.`);
    return;
  }
  const record = value as Record<string, unknown>;
  const properties = isPlainObject(schema["properties"]) ? schema["properties"] : {};
  const required = Array.isArray(schema["required"]) ? schema["required"].filter((entry): entry is string => typeof entry === "string") : [];
  const additionalProperties = schema["additionalProperties"];

  for (const name of required) {
    if (!(name in record)) issues.add(`${path}.${name}`, "is required and is missing.");
  }

  if (additionalProperties === false) {
    for (const key of Object.keys(record)) {
      if (!(key in properties)) issues.add(`${path}.${key}`, "is not a recognised property of this object.");
    }
  }

  // Only present properties are walked. A missing optional property has
  // nothing to check; a missing required property was already reported once,
  // above, and is not walked a second time as a type mismatch against `undefined`.
  for (const [name, childSchema] of Object.entries(properties)) {
    if (!(name in record)) continue;
    walk(childSchema, record[name], `${path}.${name}`, depth + 1, issues);
  }
}

function walkArray(schema: Record<string, unknown>, value: unknown, path: string, depth: number, issues: IssueCollector): void {
  if (!Array.isArray(value)) {
    issues.add(path, `expected an array, got ${previewOf(value)}.`);
    return;
  }
  const items = schema["items"];
  value.forEach((element, index) => {
    walk(items, element, `${path}[${index}]`, depth + 1, issues);
  });
}

function walkString(schema: Record<string, unknown>, value: unknown, path: string, issues: IssueCollector): void {
  if (typeof value !== "string") {
    issues.add(path, `expected a string, got ${previewOf(value)}.`);
    return;
  }
  const allowed = schema["enum"];
  if (Array.isArray(allowed)) {
    const values = allowed.filter((entry): entry is string => typeof entry === "string");
    if (!values.includes(value)) {
      issues.add(path, `must be one of: ${describeEnum(values)} - got ${previewOf(value)}.`);
    }
  }
}

function walkNumber(value: unknown, path: string, issues: IssueCollector, integer: boolean): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    issues.add(path, `expected a number, got ${previewOf(value)}.`);
    return;
  }
  if (integer && !Number.isInteger(value)) {
    issues.add(path, `expected a whole number, got ${previewOf(value)}.`);
  }
}

function describeEnum(values: readonly string[]): string {
  const shown = values.slice(0, MAX_ENUM_LISTED).map((entry) => JSON.stringify(entry));
  const rest = values.length - shown.length;
  return rest > 0 ? `${shown.join(", ")}, ...and ${rest} more` : shown.join(", ");
}

/**
 * A short preview of an untrusted value for an error message. `JSON.stringify`
 * throws on a circular reference or a `BigInt` anywhere in `value`, and this
 * function must never throw - `validate()`'s whole contract depends on it.
 */
function previewOf(value: unknown): string {
  let text: string | undefined;
  try {
    // `JSON.stringify` returns the actual value `undefined` (not the string
    // "undefined") for `undefined`, a function, or a symbol - TypeScript's own
    // signature says `string`, but the runtime does not agree.
    text = JSON.stringify(value);
  } catch {
    return "<value could not be shown>";
  }
  if (text === undefined) return String(value);
  return text.length > MAX_VALUE_PREVIEW ? `${text.slice(0, MAX_VALUE_PREVIEW)}...` : text;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export { MAX_ISSUES, MAX_DEPTH, MAX_VALUE_PREVIEW, MAX_ENUM_LISTED };
