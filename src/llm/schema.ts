/**
 * A very small JSON Schema builder.
 *
 * Every role asks the model for structured output, and the schema is the
 * contract between a prompt and the TypeScript type it fills in. Writing the
 * schemas by hand is noisy and easy to get subtly wrong (a missing
 * `additionalProperties: false` silently relaxes the constraint), so they are
 * built here instead.
 */

export type JsonSchema = Record<string, unknown>;

export function object(
  properties: Record<string, JsonSchema>,
  options: { required?: readonly string[]; description?: string } = {},
): JsonSchema {
  return {
    type: "object",
    ...(options.description ? { description: options.description } : {}),
    properties,
    required: options.required ?? Object.keys(properties),
    additionalProperties: false,
  };
}

export function array(
  items: JsonSchema,
  options: { description?: string; minItems?: number; maxItems?: number } = {},
): JsonSchema {
  return {
    type: "array",
    items,
    ...(options.description ? { description: options.description } : {}),
    ...(options.minItems !== undefined ? { minItems: options.minItems } : {}),
    ...(options.maxItems !== undefined ? { maxItems: options.maxItems } : {}),
  };
}

export function string(description?: string, options: { maxLength?: number } = {}): JsonSchema {
  return {
    type: "string",
    ...(description ? { description } : {}),
    ...(options.maxLength !== undefined ? { maxLength: options.maxLength } : {}),
  };
}

export function number(
  description?: string,
  options: { minimum?: number; maximum?: number } = {},
): JsonSchema {
  return {
    type: "number",
    ...(description ? { description } : {}),
    ...(options.minimum !== undefined ? { minimum: options.minimum } : {}),
    ...(options.maximum !== undefined ? { maximum: options.maximum } : {}),
  };
}

export function integer(
  description?: string,
  options: { minimum?: number; maximum?: number } = {},
): JsonSchema {
  return { ...number(description, options), type: "integer" };
}

export function boolean(description?: string): JsonSchema {
  return { type: "boolean", ...(description ? { description } : {}) };
}

export function enumOf(values: readonly string[], description?: string): JsonSchema {
  return { type: "string", enum: [...values], ...(description ? { description } : {}) };
}
