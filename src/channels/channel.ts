/**
 * The channel port - everything the company needs from a place it posts.
 *
 * Four capabilities, because the operating model needs exactly four things:
 * find what is working (research), put a post out at a chosen time
 * (publishing), read back how it did (analysis), and leave the first comment
 * (the link drop, usually).
 */

import type { PlatformError, Result } from "../core/result.ts";
import type { ChannelId, DraftContent, EngagementSnapshot, SwipeItem, VentureId } from "../core/types.ts";

/**
 * What shape a post takes here.
 *  - `short`    one tight post, hook doing most of the work (X, Threads)
 *  - `thread`   a lead post plus continuation (X threads, Threads chains)
 *  - `longform` an article with structure and subheads (note, blog, a
 *               YouTube description under a video)
 *
 * The writing role is told which of these it is writing, because the same idea
 * becomes a genuinely different piece of work in each.
 */
export type PostFormat = "short" | "thread" | "longform";

export type ChannelCapabilities = {
  /** True when the platform itself can hold a post until a future time. */
  readonly nativeScheduling: boolean;
  /** True when a post can be a multi-part thread. */
  readonly threads: boolean;
  /** True when the channel exposes trending/searchable posts for research. */
  readonly discovery: boolean;
  readonly comments: boolean;
  readonly maxCharacters: number;
  readonly format: PostFormat;
};

export type DiscoverRequest = {
  readonly ventureId: VentureId;
  readonly queries: readonly string[];
  readonly minLikes: number;
  readonly maxItems: number;
  readonly since: number;
};

export type PublishRequest = {
  readonly ventureId: VentureId;
  readonly postId: string;
  readonly content: DraftContent;
  /**
   * Epoch ms. When the channel has native scheduling the adapter should hand
   * this to the platform; otherwise the daemon holds the post and publishes at
   * the right moment.
   */
  readonly scheduledFor?: number;
};

export type PublishResult = {
  readonly externalId: string;
  readonly url?: string;
  /** Set when the post is live now, absent when it was queued for later. */
  readonly publishedAt?: string;
  readonly scheduled: boolean;
};

export type CommentRequest = {
  readonly parentExternalId: string;
  readonly text: string;
};

export type Channel = {
  readonly id: ChannelId;
  readonly adapter: string;
  readonly capabilities: ChannelCapabilities;
  discover(request: DiscoverRequest): Promise<Result<SwipeItem[], PlatformError>>;
  publish(request: PublishRequest): Promise<Result<PublishResult, PlatformError>>;
  comment(request: CommentRequest): Promise<Result<{ externalId: string }, PlatformError>>;
  metrics(externalIds: readonly string[]): Promise<Result<Record<string, EngagementSnapshot>, PlatformError>>;
  /** Cheap credential/reachability check for `amp doctor`. */
  healthCheck(): Promise<Result<string, PlatformError>>;
};

export type ChannelFactory = (context: ChannelFactoryContext) => Channel;

export type ChannelFactoryContext = {
  readonly id: ChannelId;
  /** Values resolved from the env vars named in `credentialEnv`. */
  readonly credentials: Readonly<Record<string, string>>;
  readonly options: Readonly<Record<string, unknown>>;
  readonly nowMs: () => number;
};
