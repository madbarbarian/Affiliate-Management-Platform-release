/**
 * Reading a channel's post format out of its config options.
 *
 * Shared by the adapters so a licensee sets `options.format` the same way
 * everywhere, and an unrecognised value falls back to the adapter's own
 * default rather than silently becoming `undefined` in a prompt.
 */

import type { PostFormat } from "./channel.ts";

const FORMATS: readonly PostFormat[] = ["short", "thread", "longform"];

export function readFormat(options: Readonly<Record<string, unknown>>, fallback: PostFormat): PostFormat {
  const value = options["format"];
  return typeof value === "string" && (FORMATS as readonly string[]).includes(value)
    ? (value as PostFormat)
    : fallback;
}

/** What the writing role is told about the shape it is writing. */
export function describeFormat(format: PostFormat, maxCharacters: number): string {
  switch (format) {
    case "short":
      return [
        `- Format: ONE short post, at most ${maxCharacters} characters.`,
        `- The hook is most of the work. If the whole thing does not fit, cut the body, never the hook.`,
        `- Leave \`threadParts\` empty.`,
      ].join("\n");
    case "thread":
      return [
        `- Format: a lead post plus continuation, each part at most ${maxCharacters} characters.`,
        `- Write one post if the idea fits in one. Padding an idea out to five parts is obvious and costs reach.`,
        `- When you do split it, each part must earn the next: end on the thing not yet said.`,
        `- Someone joining at part 3 should not be lost.`,
      ].join("\n");
    case "longform":
      return [
        `- Format: a piece to be read in one sitting, up to ${maxCharacters} characters.`,
        `- The hook is the title and the first paragraph. Everything after it has to keep the promise the title made.`,
        `- Use \`threadParts\` for the sections, in order. Each one is a section of the same piece, not a standalone post.`,
        `- Structure it, but do not turn it into a listicle: sections carry a narrative, headings are not bullet points.`,
        `- Longer does not mean padded. If the idea is exhausted in 600 characters, stop at 600.`,
      ].join("\n");
  }
}
