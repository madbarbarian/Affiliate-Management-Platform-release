/**
 * Meta Threads, via the Threads Graph API.
 *
 * The publish flow is two calls, which is worth knowing before reading the
 * code: you create a *media container* holding the text, then publish that
 * container by id. Replies are the same flow with `reply_to_id` set, which is
 * how the first-comment link drop works.
 *
 * The API has no scheduling of its own, so `nativeScheduling` is false and the
 * daemon holds a post until its slot.
 *
 * Before this adapter can run, the operator needs a long-lived access token
 * for a Threads professional account. Discovery additionally needs the keyword
 * search permission, which is granted separately - `discover` degrades to an
 * empty swipe file rather than failing the cycle when it is missing, so the
 * rest of the pipeline keeps working. Verify the current scopes and API
 * version against Meta's documentation; both are config, not code
 * (`options.apiVersion`, `options.baseUrl`).
 */

import { fail, ok, tryAsync, type PlatformError, type Result } from "../core/result.ts";
import type { EngagementSnapshot, SwipeItem } from "../core/types.ts";
import { composeThreadParts } from "./format.ts";
import type {
  Channel,
  ChannelFactoryContext,
  CommentRequest,
  DiscoverRequest,
  PublishRequest,
  PublishResult,
} from "./channel.ts";

const DEFAULT_BASE_URL = "https://graph.threads.net";
const DEFAULT_API_VERSION = "v1.0";
/** Threads' own limit on a single post. */
const MAX_CHARACTERS = 500;

export function createThreadsChannel(context: ChannelFactoryContext): Channel {
  const baseUrl = String(context.options["baseUrl"] ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const apiVersion = String(context.options["apiVersion"] ?? DEFAULT_API_VERSION);
  const timeoutMs = Number(context.options["timeoutMs"] ?? 30_000);
  const token = context.credentials["token"] ?? "";
  const userId = context.credentials["userId"] ?? "";

  const endpoint = (path: string): string => `${baseUrl}/${apiVersion}/${path.replace(/^\//, "")}`;

  const request = async <T>(
    method: "GET" | "POST",
    path: string,
    params: Record<string, string | undefined>,
    label: string,
  ): Promise<Result<T, PlatformError>> => {
    if (token === "") {
      return fail("config", "channel.no_credentials", `Threads channel "${context.id}" has no access token. Set the env var named by credentialEnv.token.`);
    }
    const query = new URLSearchParams({ access_token: token });
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) query.set(key, value);
    }

    const attempt = await tryAsync("network", "channel.request_failed", async () => {
      const url = method === "GET" ? `${endpoint(path)}?${query.toString()}` : endpoint(path);
      const response = await fetch(url, {
        method,
        ...(method === "POST"
          ? {
              headers: { "content-type": "application/x-www-form-urlencoded" },
              body: query.toString(),
            }
          : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
      return { status: response.status, text: await response.text() };
    }, { retryable: true });

    if (!attempt.ok) return attempt;
    const { status, text } = attempt.value;

    let parsed: unknown;
    try {
      parsed = text.trim() === "" ? {} : JSON.parse(text);
    } catch (cause) {
      return fail("channel", "channel.invalid_json", `Threads ${label} returned a non-JSON body (HTTP ${status}).`, {
        details: { body: text.slice(0, 300) },
        cause,
      });
    }

    if (status < 200 || status >= 300) {
      const apiError = (parsed as { error?: { message?: string; code?: number } }).error;
      return fail("channel", "channel.api_error", `Threads ${label} failed: ${apiError?.message ?? `HTTP ${status}`}`, {
        // 4 = rate limit, 32/613 = throttling. 5xx is worth another go too.
        retryable: status >= 500 || status === 429 || apiError?.code === 4,
        details: { status, code: apiError?.code },
      });
    }
    return ok(parsed as T);
  };

  return {
    id: context.id,
    adapter: "threads",
    capabilities: {
      nativeScheduling: false,
      threads: true,
      discovery: true,
      comments: true,
      maxCharacters: MAX_CHARACTERS,
      format: "thread",
    },

    async discover(discoverRequest: DiscoverRequest): Promise<Result<SwipeItem[], PlatformError>> {
      const collected: SwipeItem[] = [];
      for (const query of discoverRequest.queries) {
        const response = await request<{ data?: ThreadsPost[] }>(
          "GET",
          "keyword_search",
          {
            q: query,
            search_type: "TOP",
            fields: "id,text,username,permalink,timestamp",
            limit: String(Math.min(50, discoverRequest.maxItems)),
          },
          `keyword search for "${query}"`,
        );
        if (!response.ok) {
          // Keyword search is a separately-granted permission. Losing it should
          // cost the swipe file, not the whole cycle.
          if (response.error.kind === "channel") continue;
          return response;
        }
        for (const post of response.value.data ?? []) {
          const capturedAt = post.timestamp ?? new Date(context.nowMs()).toISOString();
          if (Date.parse(capturedAt) < discoverRequest.since) continue;
          const insights = await readInsights(request, post.id);
          const snapshot = insights.ok ? insights.value : { likes: 0, replies: 0, reposts: 0 };
          if (snapshot.likes < discoverRequest.minLikes) continue;
          collected.push({
            id: `swipe_${post.id}`,
            ventureId: discoverRequest.ventureId,
            channel: context.id,
            capturedAt,
            ...(post.username ? { author: `@${post.username}` } : {}),
            ...(post.permalink ? { sourceUrl: post.permalink } : {}),
            text: post.text ?? "",
            snapshot,
            tags: [query],
          });
          if (collected.length >= discoverRequest.maxItems) return ok(collected);
        }
      }
      return ok(collected);
    },

    async publish(publishRequest: PublishRequest): Promise<Result<PublishResult, PlatformError>> {
      if (userId === "") {
        return fail("config", "channel.no_credentials", `Threads channel "${context.id}" has no user id. Set the env var named by credentialEnv.userId.`);
      }
      const parts = renderParts(publishRequest.content);
      const first = parts[0] as string;

      const container = await request<{ id?: string }>(
        "POST",
        `${userId}/threads`,
        { media_type: "TEXT", text: first },
        "container creation",
      );
      if (!container.ok) return container;
      if (!container.value.id) {
        return fail("channel", "channel.missing_container_id", "Threads did not return a container id.");
      }

      const publishResponse = await request<{ id?: string }>(
        "POST",
        `${userId}/threads_publish`,
        { creation_id: container.value.id },
        "publish",
      );
      if (!publishResponse.ok) return publishResponse;
      const externalId = publishResponse.value.id;
      if (!externalId) return fail("channel", "channel.missing_external_id", "Threads did not return a post id.");

      // Remaining parts become a self-reply chain, each replying to the last.
      let replyTarget = externalId;
      for (const part of parts.slice(1)) {
        const replyContainer = await request<{ id?: string }>(
          "POST",
          `${userId}/threads`,
          { media_type: "TEXT", text: part, reply_to_id: replyTarget },
          "thread part container",
        );
        if (!replyContainer.ok || !replyContainer.value.id) break;
        const published = await request<{ id?: string }>(
          "POST",
          `${userId}/threads_publish`,
          { creation_id: replyContainer.value.id },
          "thread part publish",
        );
        if (!published.ok || !published.value.id) break;
        replyTarget = published.value.id;
      }

      return ok({
        externalId,
        publishedAt: new Date(context.nowMs()).toISOString(),
        scheduled: false,
      });
    },

    async comment(commentRequest: CommentRequest): Promise<Result<{ externalId: string }, PlatformError>> {
      if (userId === "") {
        return fail("config", "channel.no_credentials", `Threads channel "${context.id}" has no user id.`);
      }
      const container = await request<{ id?: string }>(
        "POST",
        `${userId}/threads`,
        { media_type: "TEXT", text: commentRequest.text, reply_to_id: commentRequest.parentExternalId },
        "comment container",
      );
      if (!container.ok) return container;
      if (!container.value.id) return fail("channel", "channel.missing_container_id", "Threads did not return a container id.");

      const published = await request<{ id?: string }>(
        "POST",
        `${userId}/threads_publish`,
        { creation_id: container.value.id },
        "comment publish",
      );
      if (!published.ok) return published;
      if (!published.value.id) return fail("channel", "channel.missing_external_id", "Threads did not return a comment id.");
      return ok({ externalId: published.value.id });
    },

    async metrics(externalIds): Promise<Result<Record<string, EngagementSnapshot>, PlatformError>> {
      const out: Record<string, EngagementSnapshot> = {};
      for (const externalId of externalIds) {
        const insights = await readInsights(request, externalId);
        if (insights.ok) out[externalId] = insights.value;
      }
      return ok(out);
    },

    async healthCheck(): Promise<Result<string, PlatformError>> {
      if (token === "" || userId === "") {
        return fail(
          "config",
          "channel.no_credentials",
          `Threads channel "${context.id}" needs both credentialEnv.token and credentialEnv.userId.`,
        );
      }
      const response = await request<{ username?: string }>("GET", `${userId}`, { fields: "username" }, "account lookup");
      if (!response.ok) return response;
      return ok(`Threads connected as @${response.value.username ?? userId}`);
    },
  };
}

type ThreadsPost = {
  id: string;
  text?: string;
  username?: string;
  permalink?: string;
  timestamp?: string;
};

type ThreadsInsights = {
  data?: { name?: string; values?: { value?: number }[]; total_value?: { value?: number } }[];
};

async function readInsights(
  request: <T>(
    method: "GET" | "POST",
    path: string,
    params: Record<string, string | undefined>,
    label: string,
  ) => Promise<Result<T, PlatformError>>,
  mediaId: string,
): Promise<Result<EngagementSnapshot, PlatformError>> {
  const response = await request<ThreadsInsights>(
    "GET",
    `${mediaId}/insights`,
    { metric: "views,likes,replies,reposts,quotes" },
    `insights for ${mediaId}`,
  );
  if (!response.ok) return response;

  const read = (name: string): number => {
    const entry = response.value.data?.find((item) => item.name === name);
    return entry?.total_value?.value ?? entry?.values?.[0]?.value ?? 0;
  };
  return ok({
    impressions: read("views"),
    likes: read("likes"),
    replies: read("replies"),
    reposts: read("reposts") + read("quotes"),
  });
}

/**
 * Renders a draft into Threads-sized parts. The hook always leads, and the
 * disclosure always rides on the first part - a `#PR` buried in part four is
 * not a disclosure.
 */
export function renderParts(content: {
  hook: string;
  body: string;
  cta: string;
  disclosure: string;
  hashtags: readonly string[];
  threadParts?: readonly string[];
}): string[] {
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
    // notice at all, which is the exact failure this file's header promises not
    // to allow. Part 0 is trimmed with room reserved for it instead.
    return parts.map((part, index) =>
      index === 0 ? fitWithDisclosure(part, content.disclosure) : part.slice(0, MAX_CHARACTERS),
    );
  }

  const single = [content.hook, content.body, content.cta, content.hashtags.join(" ")]
    .filter((line) => line.trim() !== "")
    .join("\n\n");
  const withNotice = withDisclosure(single, content.disclosure);
  if (withNotice.length <= MAX_CHARACTERS) return [withNotice];

  // Too long for one post: lead with hook + disclosure, continue in replies.
  const head = fitWithDisclosure(content.hook, content.disclosure);
  const rest = [content.body, content.cta, content.hashtags.join(" ")]
    .filter((line) => line.trim() !== "")
    .join("\n\n");
  return [head, ...chunk(rest, MAX_CHARACTERS)];
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
function fitWithDisclosure(text: string, disclosure: string): string {
  const notice = disclosure.trim();
  if (notice === "") return text.slice(0, MAX_CHARACTERS);
  if (text.length <= MAX_CHARACTERS && text.includes(notice)) return text;

  const room = MAX_CHARACTERS - notice.length - 2;
  if (room <= 0) return notice.slice(0, MAX_CHARACTERS);

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
