/**
 * A channel the licensee is.
 *
 * Every other adapter answers "how does a post reach this platform's API". This
 * one answers "how does a post reach the person who has the app open", which
 * costs ten seconds and no credentials at all. Connecting a posting API is the
 * hardest step of a licensee's first hour - the onboarding design budgets 20 to
 * 40 minutes for it - and it is the step that has to happen before anything
 * else in the product can be seen working.
 *
 * What survives the swap is the part that earns money: the link in the text is
 * this platform's own `/go/<code>` redirect, so clicks, conversions and revenue
 * are recorded exactly as they are for a post this platform put out itself.
 *
 * What is lost is engagement - likes and replies - because nobody is asking the
 * platform for them. The analysis role learns less. That is a real cost, it is
 * accepted deliberately, and `src/domain/measurement.ts` says so on the screen
 * rather than letting it look like a fault.
 *
 * This channel therefore never publishes. It composes, and the orchestrator
 * hands the result to a person.
 */

import { fail, ok, type PlatformError, type Result } from "../core/result.ts";
import type { DraftContent, EngagementSnapshot, SwipeItem } from "../core/types.ts";
import { readFormat, renderPostParts } from "./format.ts";
import type { Channel, ChannelFactoryContext, PublishResult } from "./channel.ts";

/**
 * The adapter name, exported so nothing has to spell it twice. The measurement
 * check reads it to tell "cannot report engagement" apart from "is making the
 * numbers up", which are opposite problems that look the same in a table.
 */
export const MANUAL_ADAPTER = "manual";

/**
 * Where the licensee goes to paste. A plain link the console offers - not an
 * integration, not a redirect we control - so adding X, note or a blog is a
 * line of config rather than an adapter.
 */
export function composerUrlOf(options: Readonly<Record<string, unknown>>): string | undefined {
  const value = options["composerUrl"];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  // Only a web address. The console renders this into an href, and a
  // `javascript:` or `data:` URL in a config file would become a way to run
  // script on the one page that approves posts.
  try {
    const url = new URL(trimmed);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function createManualChannel(context: ChannelFactoryContext): Channel {
  const maxCharacters = Number(context.options["maxCharacters"] ?? 500);
  const cannotDoIt = (what: string): Result<never, PlatformError> =>
    fail(
      "channel",
      "channel.hands_to_a_person",
      `Channel "${context.id}" uses the "${MANUAL_ADAPTER}" adapter, so the platform cannot ${what} by ` +
        `itself - you post it. Open the console, copy the text under 予約中の投稿, and press ` +
        `「投稿しました」. To have the platform post for you, set this channel's adapter to one that can.`,
      { retryable: false },
    );

  return {
    id: context.id,
    adapter: MANUAL_ADAPTER,
    capabilities: {
      publishesItself: false,
      // Nothing holds the post but this platform: a person is not a scheduler,
      // and saying otherwise would mean the dispatcher stopped watching the
      // slot and waited for a channel that is never going to call back.
      nativeScheduling: false,
      threads: true,
      discovery: false,
      // The link drop cannot be posted by the platform either. The console
      // hands the comment to the same person, under the post text.
      comments: false,
      maxCharacters,
      format: readFormat(context.options, "short"),
    },

    compose(content: DraftContent): string[] {
      return renderPostParts(content, maxCharacters);
    },

    async discover(): Promise<Result<SwipeItem[], PlatformError>> {
      return ok([]);
    },

    // Reached only if something decided this channel publishes after all. It
    // refuses rather than inventing an id, because a post recorded as live that
    // nobody posted is the one outcome worse than a post nobody posted.
    async publish(): Promise<Result<PublishResult, PlatformError>> {
      return cannotDoIt("publish");
    },

    async comment(): Promise<Result<{ externalId: string }, PlatformError>> {
      return cannotDoIt("comment");
    },

    /**
     * Empty, and not an error.
     *
     * There is nothing to read back and nothing went wrong - a failure here
     * would put a red line in the operator's day about a decision they made on
     * purpose. Engagement for these posts simply stays empty.
     */
    async metrics(): Promise<Result<Record<string, EngagementSnapshot>, PlatformError>> {
      return ok({});
    },

    async healthCheck(): Promise<Result<string, PlatformError>> {
      const composer = composerUrlOf(context.options);
      return ok(
        `you post this channel yourself (no credentials needed)` +
          (composer ? `; the console will offer ${composer}` : `; set options.composerUrl to get a link to the app`),
      );
    },
  };
}
