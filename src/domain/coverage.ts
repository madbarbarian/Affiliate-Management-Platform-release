/**
 * What counts as ground this account has already covered.
 *
 * Only an angle that reached a reader is covered. An idea that was merely
 * proposed is not: the operator is shown more ideas than they can publish, so
 * one they liked and left for tomorrow has to be able to come back. Treating a
 * proposal as covered retired the angle permanently the moment it was printed
 * on screen - nothing was deleted, it simply could never be offered again.
 *
 * Kept pure, and separate from the planning role, because the judgement is a
 * rule about the account's history rather than anything about the model call.
 */

import type { Draft, Idea, ScheduledPost } from "../core/types.ts";

/**
 * How many covered angles the planner is shown. Enough that it can see the
 * shape of what has run, short enough that it does not crowd out the evidence.
 */
export const COVERED_ANGLE_LIMIT = 25;

export type CoverageInput = {
  /** In the order the store holds them: oldest first. */
  readonly ideas: readonly Idea[];
  readonly drafts: readonly Draft[];
  readonly posts: readonly ScheduledPost[];
};

/**
 * The angles of ideas that reached a published post, oldest first, capped to
 * the newest `limit`.
 *
 * The path is post -> draft -> idea, and only a post whose status is
 * `published` counts. A post that is queued, approved, scheduled, failed or
 * cancelled leaves its angle available: it has not been read by anyone yet.
 */
export function coveredAngles(input: CoverageInput, limit: number = COVERED_ANGLE_LIMIT): readonly string[] {
  const publishedDraftIds = new Set(
    input.posts.filter((post) => post.status === "published").map((post) => post.draftId),
  );
  const publishedIdeaIds = new Set(
    input.drafts.filter((draft) => publishedDraftIds.has(draft.id)).map((draft) => draft.ideaId),
  );
  return input.ideas
    .filter((idea) => publishedIdeaIds.has(idea.id))
    .map((idea) => idea.angle)
    .slice(-limit);
}

/**
 * The openings of drafts that reached a published post, newest first, capped.
 *
 * The same rule as `coveredAngles`, one layer down. The writing role is told
 * "do not repeat these openings" about posts this account has made - and it was
 * being handed every draft, including the ones that were written, inspected and
 * then never chosen. A hook nobody has read is not an opening this account has
 * used.
 */
export function publishedHooks(
  input: { readonly drafts: readonly Draft[]; readonly posts: readonly ScheduledPost[] },
  limit: number,
): readonly Draft[] {
  const publishedDraftIds = new Set(
    input.posts.filter((post) => post.status === "published").map((post) => post.draftId),
  );
  return input.drafts
    .filter((draft) => publishedDraftIds.has(draft.id))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit);
}
