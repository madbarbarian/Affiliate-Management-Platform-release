/**
 * A path-aware reader for untrusted config objects.
 *
 * Config mistakes are the single most common way a licensee's fork breaks, and
 * a stack trace saying "Cannot read property 'id' of undefined" helps nobody.
 * Every accessor here records a human-readable issue against the exact YAML
 * path instead, and the loader reports all of them at once.
 */

export type Issue = { readonly path: string; readonly message: string };

export type Reader = {
  readonly issues: Issue[];
  at(path: string, value: unknown): Field;
};

export type Field = {
  readonly path: string;
  readonly value: unknown;
  string(fallback?: string): string;
  number(options?: { min?: number; max?: number; integer?: boolean; fallback?: number }): number;
  boolean(fallback?: boolean): boolean;
  stringArray(fallback?: readonly string[]): string[];
  objectArray(): { path: string; value: Record<string, unknown> }[];
  object(): Record<string, unknown>;
  oneOf<T extends string>(allowed: readonly T[], fallback?: T): T;
  /** Records an issue at this path without reading a value. */
  reject(message: string): void;
  present(): boolean;
};

export function createReader(): Reader {
  const issues: Issue[] = [];

  const at = (path: string, value: unknown): Field => {
    const record = (message: string): void => {
      issues.push({ path, message });
    };

    return {
      path,
      value,
      present: () => value !== undefined && value !== null,

      reject: record,

      string(fallback) {
        if (typeof value === "string" && value.trim() !== "") return value;
        if (value === undefined || value === null || value === "") {
          if (fallback !== undefined) return fallback;
          record("is required");
          return "";
        }
        if (typeof value === "number" || typeof value === "boolean") return String(value);
        record(`expected a string, got ${describe(value)}`);
        return fallback ?? "";
      },

      number(options = {}) {
        const { min, max, integer, fallback } = options;
        let numeric: number | undefined;
        if (typeof value === "number") numeric = value;
        else if (typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value))) {
          numeric = Number(value);
        }
        if (numeric === undefined || !Number.isFinite(numeric)) {
          if (value === undefined || value === null) {
            if (fallback !== undefined) return fallback;
            record("is required");
            return 0;
          }
          record(`expected a number, got ${describe(value)}`);
          return fallback ?? 0;
        }
        if (integer && !Number.isInteger(numeric)) {
          record(`expected a whole number, got ${numeric}`);
          return fallback ?? Math.round(numeric);
        }
        if (min !== undefined && numeric < min) {
          record(`must be at least ${min}, got ${numeric}`);
          return fallback ?? min;
        }
        if (max !== undefined && numeric > max) {
          record(`must be at most ${max}, got ${numeric}`);
          return fallback ?? max;
        }
        return numeric;
      },

      boolean(fallback) {
        if (typeof value === "boolean") return value;
        if (value === undefined || value === null) {
          if (fallback !== undefined) return fallback;
          record("is required");
          return false;
        }
        record(`expected true or false, got ${describe(value)}`);
        return fallback ?? false;
      },

      stringArray(fallback) {
        if (value === undefined || value === null) {
          if (fallback !== undefined) return [...fallback];
          record("is required");
          return [];
        }
        if (!Array.isArray(value)) {
          record(`expected a list, got ${describe(value)}`);
          return fallback ? [...fallback] : [];
        }
        const out: string[] = [];
        value.forEach((entry, index) => {
          if (typeof entry === "string") out.push(entry);
          else if (typeof entry === "number" || typeof entry === "boolean") out.push(String(entry));
          else issues.push({ path: `${path}[${index}]`, message: `expected a string, got ${describe(entry)}` });
        });
        return out;
      },

      objectArray() {
        if (value === undefined || value === null) return [];
        if (!Array.isArray(value)) {
          record(`expected a list, got ${describe(value)}`);
          return [];
        }
        const out: { path: string; value: Record<string, unknown> }[] = [];
        value.forEach((entry, index) => {
          if (isPlainObject(entry)) out.push({ path: `${path}[${index}]`, value: entry });
          else issues.push({ path: `${path}[${index}]`, message: `expected a mapping, got ${describe(entry)}` });
        });
        return out;
      },

      object() {
        if (isPlainObject(value)) return value;
        if (value !== undefined && value !== null) record(`expected a mapping, got ${describe(value)}`);
        return {};
      },

      oneOf<T extends string>(allowed: readonly T[], fallback?: T): T {
        if (value === undefined || value === null) {
          if (fallback !== undefined) return fallback;
          record(`is required (one of: ${allowed.join(", ")})`);
          return allowed[0] as T;
        }
        if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
        record(`must be one of: ${allowed.join(", ")} - got ${describe(value)}`);
        return fallback ?? (allowed[0] as T);
      },
    };
  };

  return { issues, at };
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function get(source: unknown, key: string): unknown {
  return isPlainObject(source) ? source[key] : undefined;
}

export function formatIssues(issues: readonly Issue[]): string {
  return issues.map((issue) => `  - ${issue.path}: ${issue.message}`).join("\n");
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "a list";
  if (isPlainObject(value)) return "a mapping";
  return `${typeof value} (${JSON.stringify(value)})`;
}
