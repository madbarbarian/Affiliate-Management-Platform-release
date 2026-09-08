/**
 * The prompt library.
 *
 * Prompts live as Markdown files under `prompts/`, not as string literals in
 * `src/`. That is the difference between a platform and an app: changing what
 * the research role considers "reproducible", or teaching the writing role a
 * house style, is something an operator does to their own fork without ever
 * opening a `.ts` file - and it shows up cleanly in their git history.
 *
 * The template syntax is one thing: `{{name}}`. Anything more and prompts
 * start needing their own debugger.
 */

import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { join } from "node:path";

export type PromptVars = Record<string, string | number | undefined>;

export type PromptLibrary = {
  /** Renders `<name>.md` with `vars` substituted. */
  render(name: string, vars?: PromptVars): string;
  has(name: string): boolean;
};

export class PromptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromptError";
  }
}

export function createPromptLibrary(directory: string): PromptLibrary {
  const cache = new Map<string, string>();

  const load = (name: string): string => {
    const cached = cache.get(name);
    if (cached !== undefined) return cached;
    const path = join(directory, `${name}.md`);
    if (!existsSync(path)) {
      throw new PromptError(
        `Prompt "${name}" not found at ${path}. ` +
          `Restore it from the upstream repo, or point runtime.promptsDir at the directory that has it.`,
      );
    }
    const text = readFileSync(path, "utf8");
    cache.set(name, text);
    return text;
  };

  return fromLoader(load, (name) => existsSync(join(directory, `${name}.md`)));
}

/**
 * The same library over prompts that are already in memory, keyed by name
 * without the `.md`.
 *
 * A host with no readable filesystem bundles `prompts/` at build time and hands
 * the texts over. Rendering, and every error message, is the file-backed
 * version's - a prompt that is missing has to say the same thing wherever it
 * was supposed to come from.
 */
export function createPromptLibraryFrom(files: Readonly<Record<string, string>>): PromptLibrary {
  const load = (name: string): string => {
    const text = files[name];
    if (text === undefined) {
      throw new PromptError(
        `Prompt "${name}" is not in this build. ` +
          `It is bundled from prompts/${name}.md - add the file and deploy again.`,
      );
    }
    return text;
  };
  return fromLoader(load, (name) => files[name] !== undefined);
}

function fromLoader(load: (name: string) => string, has: (name: string) => boolean): PromptLibrary {
  return {
    has,
    render(name, vars = {}) {
      const template = load(name);
      const missing: string[] = [];
      const rendered = template.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_match, key: string) => {
        const value = vars[key];
        if (value === undefined) {
          missing.push(key);
          return "";
        }
        return String(value);
      });
      if (missing.length > 0) {
        throw new PromptError(
          `Prompt "${name}" uses {{${[...new Set(missing)].join("}}, {{")}}} but the role did not supply ` +
            `${missing.length === 1 ? "that value" : "those values"}. ` +
            `Either remove the placeholder or pass it from the role.`,
        );
      }
      return rendered.trim();
    },
  };
}

/** Renders a list as a numbered block, or a placeholder when empty. */
export function numbered(items: readonly string[], emptyText = "(none yet)"): string {
  if (items.length === 0) return emptyText;
  return items.map((item, index) => `${index + 1}. ${item}`).join("\n");
}

/** Renders a list as a bulleted block, or a placeholder when empty. */
export function bulleted(items: readonly string[], emptyText = "(none yet)"): string {
  if (items.length === 0) return emptyText;
  return items.map((item) => `- ${item}`).join("\n");
}

/** Pretty-prints a value for embedding in a prompt. */
export function asJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
