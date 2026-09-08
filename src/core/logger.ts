/**
 * Structured logging. Every agent action is logged with the venture and cycle
 * it belongs to, because the operating model depends on a human being able to
 * audit why a post was proposed.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogFields = Record<string, unknown>;

export type Logger = {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** Returns a logger that merges `fields` into every subsequent entry. */
  child(fields: LogFields): Logger;
};

export type LogSink = (entry: {
  level: LogLevel;
  message: string;
  fields: LogFields;
  time: string;
}) => void;

/**
 * One JSON line per entry through `console.log`.
 *
 * For hosts where there is no `process.stdout` to write to - a Worker's log is
 * whatever `console` was given. `consoleSink("json")` writes the same shape,
 * but through a stream that does not exist there.
 */
export function jsonConsoleSink(): LogSink {
  return (entry) => {
    const line = JSON.stringify({ time: entry.time, level: entry.level, msg: entry.message, ...entry.fields });
    if (entry.level === "error" || entry.level === "warn") console.error(line);
    else console.log(line);
  };
}

export function consoleSink(format: "pretty" | "json" = "pretty"): LogSink {
  return (entry) => {
    if (format === "json") {
      process.stdout.write(`${JSON.stringify({ time: entry.time, level: entry.level, msg: entry.message, ...entry.fields })}\n`);
      return;
    }
    const badge = { debug: "·", info: "→", warn: "!", error: "✗" }[entry.level];
    const extras = Object.entries(entry.fields)
      .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
      .join(" ");
    const stream = entry.level === "error" || entry.level === "warn" ? process.stderr : process.stdout;
    stream.write(`${badge} ${entry.message}${extras ? `  ${extras}` : ""}\n`);
  };
}

export function createLogger(options: {
  level?: LogLevel;
  sink?: LogSink;
  base?: LogFields;
} = {}): Logger {
  const minimum = LEVEL_ORDER[options.level ?? "info"];
  const sink = options.sink ?? consoleSink();
  const base = options.base ?? {};

  const emit = (level: LogLevel, message: string, fields?: LogFields): void => {
    if (LEVEL_ORDER[level] < minimum) return;
    sink({ level, message, fields: { ...base, ...fields }, time: new Date().toISOString() });
  };

  return {
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
    child: (fields) =>
      createLogger({
        ...(options.level ? { level: options.level } : {}),
        sink,
        base: { ...base, ...fields },
      }),
  };
}

/** Collects entries instead of printing them. Used by tests. */
export function memoryLogger(level: LogLevel = "debug"): {
  logger: Logger;
  entries: { level: LogLevel; message: string; fields: LogFields }[];
} {
  const entries: { level: LogLevel; message: string; fields: LogFields }[] = [];
  const logger = createLogger({
    level,
    sink: (entry) => entries.push({ level: entry.level, message: entry.message, fields: entry.fields }),
  });
  return { logger, entries };
}

export const silentLogger: Logger = createLogger({ level: "error", sink: () => {} });
