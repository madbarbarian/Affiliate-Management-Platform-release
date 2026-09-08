/**
 * Locating, reading and expanding the platform config.
 *
 * Secrets never appear in the config file. Instead the config names env vars,
 * and `${VAR}` interpolation is available for the handful of values (a base
 * URL, an account handle) that differ per licensee but are not sensitive.
 */

import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseYaml } from "./yaml.ts";
import { parseConfig, type PlatformConfig } from "./schema.ts";

const CONFIG_FILENAMES = [
  "platform.config.yaml",
  "platform.config.yml",
  "platform.config.json",
];

/** The repository root, derived from this module's own location. */
export function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/**
 * Finds the config file: an explicit path, then `$AMP_CONFIG`, then the
 * standard filenames in `cwd`, then in the repo root.
 */
export function resolveConfigPath(options: { explicit?: string; cwd?: string } = {}): string {
  const cwd = options.cwd ?? process.cwd();
  const explicit = options.explicit ?? process.env["AMP_CONFIG"];
  if (explicit) {
    const path = isAbsolute(explicit) ? explicit : resolve(cwd, explicit);
    if (!existsSync(path)) throw new Error(`Config file not found: ${path}`);
    return path;
  }
  for (const directory of [cwd, repoRoot()]) {
    for (const filename of CONFIG_FILENAMES) {
      const candidate = join(directory, filename);
      if (existsSync(candidate)) return candidate;
    }
  }
  throw new Error(
    `No config file found. Looked for ${CONFIG_FILENAMES.join(", ")} in ${cwd} and ${repoRoot()}.\n` +
      `Run \`node src/cli.ts init\` to create one from the shipped example.`,
  );
}

/**
 * Loads environment files into `process.env`, in precedence order:
 *
 *   real environment variables  >  .env.local  >  .env
 *
 * `.env` holds shared, non-secret defaults and is committed. `.env.local`
 * holds keys and tokens and is not. A real deployment overrides both by
 * setting variables properly, which is why nothing here overwrites something
 * already set.
 */
export function loadDotEnv(directory = repoRoot()): void {
  // Order matters: the first file to claim a key wins, so the local overrides
  // are read before the shared defaults.
  readEnvFile(join(directory, ".env.local"));
  readEnvFile(join(directory, ".env"));
}

function readEnvFile(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    if (key === "" || process.env[key] !== undefined) continue;
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

export type LoadedConfig = {
  readonly config: PlatformConfig;
  readonly path: string;
  /** Absolute data directory, with `runtime.dataDir` resolved. */
  readonly dataDir: string;
  /** Absolute prompts directory, with `runtime.promptsDir` resolved. */
  readonly promptsDir: string;
};

export async function loadConfig(
  options: { explicit?: string; cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<LoadedConfig> {
  const path = resolveConfigPath(options);
  const text = await readFile(path, "utf8");
  return buildConfig(text, path, options.env ?? process.env);
}

export function loadConfigSync(
  options: { explicit?: string; cwd?: string; env?: NodeJS.ProcessEnv } = {},
): LoadedConfig {
  const path = resolveConfigPath(options);
  return buildConfig(readFileSync(path, "utf8"), path, options.env ?? process.env);
}

/** Parses config text directly. Exposed for tests and for `amp doctor`. */
export function buildConfig(text: string, path: string, env: NodeJS.ProcessEnv): LoadedConfig {
  const document = path.endsWith(".json") ? JSON.parse(text) : parseYaml(text);
  const expanded = interpolate(document, env);
  const config = parseConfig(expanded, path);
  const base = dirname(path);
  const resolveFrom = (value: string): string => (isAbsolute(value) ? value : resolve(base, value));
  return {
    config,
    path,
    dataDir: resolveFrom(config.runtime.dataDir),
    promptsDir: resolveFrom(config.runtime.promptsDir),
  };
}

/**
 * Expands `${VAR}` and `${VAR:-fallback}` inside string values.
 * An unset variable with no fallback is an error rather than an empty string -
 * silently publishing to `https://` because a var was missing is worse than
 * refusing to start.
 */
export function interpolate(value: unknown, env: NodeJS.ProcessEnv): unknown {
  if (typeof value === "string") return expandString(value, env);
  if (Array.isArray(value)) return value.map((entry) => interpolate(entry, env));
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = interpolate(entry, env);
    }
    return out;
  }
  return value;
}

const INTERPOLATION_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

function expandString(text: string, env: NodeJS.ProcessEnv): string {
  return text.replace(INTERPOLATION_RE, (_match, name: string, fallback?: string) => {
    const resolved = env[name];
    if (resolved !== undefined && resolved !== "") return resolved;
    if (fallback !== undefined) return fallback;
    throw new Error(
      `Config references \${${name}} but that environment variable is not set. ` +
        `Set it in .env.local (or .env if it is not a secret), or give it a default with \${${name}:-value}.`,
    );
  });
}
