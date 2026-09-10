/**
 * A very small JSON Schema builder.
 *
 * Every role asks the model for structured output, and the schema is the
 * contract between a prompt and the TypeScript type it fills in. Writing the
 * schemas by hand is noisy and easy to get subtly wrong (a missing
 * `additionalProperties: false` silently relaxes the constraint), so they are
 * built here instead.
 *
 * **Bounds are written into the description, not into the schema.** Structured
 * output (`output_config.format`) accepts a subset of JSON Schema, and the
 * counting and length keywords are not in it:
 *
 *     400 output_config.format.schema: For 'array' type, property 'maxItems'
 *         is not supported
 *
 * That was the first real model call this platform ever made, and it failed -
 * every role's schema used at least one of these, so none of them could have
 * worked. The bounds still matter, so they are stated in the description where
 * the model reads them, rather than dropped. Nothing enforces them afterwards:
 * a role that must have a bound honoured has to check it itself.
 */

export type JsonSchema = Record<string, unknown>;

/** Keywords `output_config.format` refuses. Kept as data for `stripUnsupported`. */
const UNSUPPORTED = [
  "minItems",
  "maxItems",
  "uniqueItems",
  "minLength",
  "maxLength",
  "pattern",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minProperties",
  "maxProperties",
] as const;

/** Joins a caller's description with the bound sentences, either being absent. */
function describe(description: string | undefined, bounds: readonly string[]): JsonSchema {
  const text = [description?.trim(), ...bounds].filter((part) => part && part !== "").join(" ");
  return text === "" ? {} : { description: text };
}

export function object(
  properties: Record<string, JsonSchema>,
  options: { required?: readonly string[]; description?: string } = {},
): JsonSchema {
  return {
    type: "object",
    ...describe(options.description, []),
    properties,
    required: options.required ?? Object.keys(properties),
    additionalProperties: false,
  };
}

export function array(
  items: JsonSchema,
  options: { description?: string; minItems?: number; maxItems?: number } = {},
): JsonSchema {
  const bounds: string[] = [];
  if (options.minItems !== undefined && options.maxItems !== undefined) {
    bounds.push(`Between ${options.minItems} and ${options.maxItems} items.`);
  } else if (options.minItems !== undefined) {
    bounds.push(`At least ${options.minItems} item(s).`);
  } else if (options.maxItems !== undefined) {
    bounds.push(`At most ${options.maxItems} item(s).`);
  }
  return { type: "array", items, ...describe(options.description, bounds) };
}

export function string(description?: string, options: { maxLength?: number } = {}): JsonSchema {
  const bounds = options.maxLength !== undefined ? [`At most ${options.maxLength} characters.`] : [];
  return { type: "string", ...describe(description, bounds) };
}

export function number(
  description?: string,
  options: { minimum?: number; maximum?: number } = {},
): JsonSchema {
  const bounds: string[] = [];
  if (options.minimum !== undefined && options.maximum !== undefined) {
    bounds.push(`Between ${options.minimum} and ${options.maximum}.`);
  } else if (options.minimum !== undefined) {
    bounds.push(`${options.minimum} or more.`);
  } else if (options.maximum !== undefined) {
    bounds.push(`${options.maximum} or less.`);
  }
  return { type: "number", ...describe(description, bounds) };
}

export function integer(
  description?: string,
  options: { minimum?: number; maximum?: number } = {},
): JsonSchema {
  return { ...number(description, options), type: "integer" };
}

export function boolean(description?: string): JsonSchema {
  return { type: "boolean", ...describe(description, []) };
}

export function enumOf(values: readonly string[], description?: string): JsonSchema {
  return { type: "string", enum: [...values], ...describe(description, []) };
}

/**
 * Removes anything `output_config.format` would refuse, at any depth.
 *
 * The builders above no longer produce these, so this is normally a no-op. It
 * runs anyway, in the adapter, on every schema: the cost of getting one wrong
 * is a 400 in production on the request a whole day's work depends on, and the
 * cost of this is one walk of a small object.
 */
export function stripUnsupported(schema: JsonSchema): JsonSchema {
  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(schema)) {
    if ((UNSUPPORTED as readonly string[]).includes(key)) continue;
    out[key] = NAMES_NOT_KEYWORDS.has(key) ? cleanNamed(value) : clean(value);
  }
  return out;
}

/**
 * Keys whose own keys are the caller's field names rather than JSON Schema
 * keywords.
 *
 * Without this, a field genuinely called `pattern` or `minimum` was deleted
 * from `properties` while staying in `required`, which is a 400 of its own and
 * a strange one to read. `pattern` is already this project's word for what the
 * playbook learns, so it was one schema away.
 */
const NAMES_NOT_KEYWORDS: ReadonlySet<string> = new Set(["properties", "$defs", "definitions"]);

function cleanNamed(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return clean(value);
  const out: Record<string, unknown> = {};
  for (const [name, child] of Object.entries(value)) out[name] = clean(child);
  return out;
}

function clean(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(clean);
  if (value !== null && typeof value === "object") return stripUnsupported(value as JsonSchema);
  return value;
}

/** The keywords `stripUnsupported` removes. Exported for the test that guards them. */
export const UNSUPPORTED_KEYWORDS: readonly string[] = UNSUPPORTED;
