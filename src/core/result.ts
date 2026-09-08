/**
 * A tiny Result type. Domain code returns failures as values instead of
 * throwing, so an orchestrator can persist a partial cycle and resume it
 * rather than losing a whole day's work to one bad LLM response.
 *
 * Exceptions are still used for programmer errors (bad config, impossible
 * state) - anything a retry would not fix.
 */

export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<E> = { readonly ok: false; readonly error: E };
export type Result<T, E = PlatformError> = Ok<T> | Err<E>;

export type ErrorKind =
  | "config"
  | "llm"
  | "channel"
  | "network"
  | "storage"
  | "policy"
  | "validation"
  | "not_found"
  | "conflict"
  | "internal";

export type PlatformError = {
  readonly kind: ErrorKind;
  readonly message: string;
  /** Machine-readable discriminator, e.g. "llm.invalid_json". */
  readonly code: string;
  /** True when the same call has a realistic chance of succeeding later. */
  readonly retryable: boolean;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
};

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}

export function fail(
  kind: ErrorKind,
  code: string,
  message: string,
  options: { retryable?: boolean; details?: Record<string, unknown>; cause?: unknown } = {},
): Err<PlatformError> {
  return err({
    kind,
    code,
    message,
    retryable: options.retryable ?? false,
    ...(options.details ? { details: options.details } : {}),
    ...(options.cause !== undefined ? { cause: options.cause } : {}),
  });
}

export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.ok;
}

export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return !result.ok;
}

/** Unwraps a Result, throwing on failure. Only for tests and CLI top level. */
export function unwrap<T>(result: Result<T, PlatformError>): T {
  if (result.ok) return result.value;
  throw new Error(`[${result.error.kind}/${result.error.code}] ${result.error.message}`, {
    cause: result.error.cause,
  });
}

export function mapOk<T, U, E>(result: Result<T, E>, fn: (value: T) => U): Result<U, E> {
  return result.ok ? ok(fn(result.value)) : result;
}

/** Collects results, short-circuiting on the first failure. */
export function all<T, E>(results: readonly Result<T, E>[]): Result<T[], E> {
  const values: T[] = [];
  for (const result of results) {
    if (!result.ok) return result;
    values.push(result.value);
  }
  return ok(values);
}

/** Splits results into successes and failures without short-circuiting. */
export function partition<T, E>(
  results: readonly Result<T, E>[],
): { values: T[]; errors: E[] } {
  const values: T[] = [];
  const errors: E[] = [];
  for (const result of results) {
    if (result.ok) values.push(result.value);
    else errors.push(result.error);
  }
  return { values, errors };
}

export function describeError(error: PlatformError): string {
  const detail = error.details ? ` ${JSON.stringify(error.details)}` : "";
  return `[${error.kind}/${error.code}] ${error.message}${detail}`;
}

/** Wraps a throwing async call so adapter boundaries never leak exceptions. */
export async function tryAsync<T>(
  kind: ErrorKind,
  code: string,
  fn: () => Promise<T>,
  options: { retryable?: boolean } = {},
): Promise<Result<T, PlatformError>> {
  try {
    return ok(await fn());
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return fail(kind, code, message, { retryable: options.retryable ?? false, cause });
  }
}
