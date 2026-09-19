/**
 * The shape of a post: which format a channel is configured for, and how a
 * draft's fields become the parts that are actually published.
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

/**
 * A threaded draft's parts, in the order they are published, with the hook and
 * the close said once.
 *
 * A real model returns `threadParts` whose first part already opens with the
 * `hook` and whose last part already ends with the `cta` - the mock never did,
 * which is why prepending and appending unconditionally survived this long. It
 * published the hook twice and the CTA twice, and showed the operator a gate
 * preview of the same post said twice over.
 *
 * So: add only what is missing. The channel that publishes the thread and the
 * console that previews it both call this, because the one thing worse than a
 * duplicated post is a preview that disagrees with what goes out.
 */
export function composeThreadParts(content: {
  readonly hook: string;
  readonly cta: string;
  readonly hashtags: readonly string[];
  readonly threadParts: readonly string[];
}): string[] {
  const parts = content.threadParts.map((part) => part.trim()).filter((part) => part !== "");
  if (parts.length === 0) return [];

  // Compared on trimmed text, and anchored: a hook that appears mid-part is a
  // different sentence doing a different job, and still needs a first line.
  const hook = content.hook.trim();
  const first = parts[0] as string;
  if (hook !== "" && !first.startsWith(hook)) parts[0] = `${hook}\n\n${first}`;

  const cta = content.cta.trim();
  const tags = content.hashtags.join(" ").trim();
  const tail = [
    // `includes`, not `endsWith`: the writer's last part often closes with the
    // question and then the hashtags, and an anchored test does not see the
    // question underneath them - so the post asked it twice again, which is the
    // whole defect this function exists to end.
    cta !== "" && !parts.some((part) => part.includes(cta)) ? cta : "",
    tags !== "" && !parts.some((part) => part.includes(tags)) ? tags : "",
  ]
    .filter((line) => line !== "")
    .join("\n\n");
  if (tail !== "") parts.push(tail);

  return parts;
}

/**
 * A whole draft as the parts that actually go out, sized to a channel's limit.
 *
 * The hook always leads and the disclosure always rides on the first part - a
 * `#PR` buried in part four is not a disclosure.
 *
 * It takes `maxCharacters` rather than reading a constant because two very
 * different callers need the same answer: the adapter that posts through an
 * API, and the adapter that hands the text to a person. If the person were
 * shown text composed by a second implementation, the notice could be in one
 * and not the other, and nobody would find out until a regulator did.
 */
export function renderPostParts(
  content: {
    readonly hook: string;
    readonly body: string;
    readonly cta: string;
    readonly disclosure: string;
    readonly hashtags: readonly string[];
    readonly threadParts?: readonly string[];
  },
  maxCharacters: number,
): string[] {
  // `composeThreadParts` counts the hook and the close once wherever the writer
  // already put them; it is empty only when there was nothing to thread.
  const parts = composeThreadParts({
    hook: content.hook,
    cta: content.cta,
    hashtags: content.hashtags,
    threadParts: content.threadParts ?? [],
  });
  if (parts.length > 0) {
    // Trimming to length after appending the disclosure cut the disclosure off
    // whenever the first part was long - publishing an affiliate thread with no
    // notice at all, which is the exact failure this function promises not to
    // allow. Part 0 is trimmed with room reserved for it instead.
    return parts.map((part, index) =>
      index === 0 ? fitWithDisclosure(part, content.disclosure, maxCharacters) : part.slice(0, maxCharacters),
    );
  }

  const single = [content.hook, content.body, content.cta, content.hashtags.join(" ")]
    .filter((line) => line.trim() !== "")
    .join("\n\n");
  const withNotice = withDisclosure(single, content.disclosure);
  if (withNotice.length <= maxCharacters) return [withNotice];

  // Too long for one post: lead with hook + disclosure, continue in replies.
  const head = fitWithDisclosure(content.hook, content.disclosure, maxCharacters);
  const rest = [content.body, content.cta, content.hashtags.join(" ")]
    .filter((line) => line.trim() !== "")
    .join("\n\n");
  return [head, ...chunk(rest, maxCharacters)];
}

function withDisclosure(text: string, disclosure: string): string {
  if (disclosure.trim() === "" || text.includes(disclosure.trim())) return text;
  return `${text}\n\n${disclosure.trim()}`;
}

/**
 * Trims a post to the channel's limit **with room kept for the disclosure**.
 *
 * The order matters and is the whole point: append then trim, and a long first
 * part silently loses the notice; reserve then append, and the post is shorter
 * instead. When even that will not fit, the disclosure wins and the copy is
 * what gets cut - an over-trimmed post is a bad post, a post with no notice is
 * a compliance failure on someone else's account.
 */
function fitWithDisclosure(text: string, disclosure: string, maxCharacters: number): string {
  const notice = disclosure.trim();
  if (notice === "") return text.slice(0, maxCharacters);
  if (text.length <= maxCharacters && text.includes(notice)) return text;

  const room = maxCharacters - notice.length - 2;
  if (room <= 0) return notice.slice(0, maxCharacters);

  const trimmed = text.slice(0, room).trimEnd();
  return trimmed.includes(notice) ? trimmed : `${trimmed}\n\n${notice}`;
}

/** Splits on paragraph, then line, then hard character boundaries. */
function chunk(text: string, size: number): string[] {
  const out: string[] = [];
  let current = "";
  for (const paragraph of text.split(/\n\n+/)) {
    for (const piece of paragraph.length <= size ? [paragraph] : hardSplit(paragraph, size)) {
      const candidate = current === "" ? piece : `${current}\n\n${piece}`;
      if (candidate.length <= size) {
        current = candidate;
      } else {
        if (current !== "") out.push(current);
        current = piece;
      }
    }
  }
  if (current !== "") out.push(current);
  return out;
}

function hardSplit(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
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
