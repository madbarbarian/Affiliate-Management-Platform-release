/**
 * Two readers for JSON that came from somewhere this process does not control
 * (an HTTP body, a stored slot). They exist so the fire logic and the harness
 * read a response the same way instead of each carrying a private copy.
 */

/** A non-null, non-array object, or `undefined`. */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** `record[key]` when it is a string, otherwise `undefined` - never a coerced value. */
export function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}
