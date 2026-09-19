/**
 * A generic HTTP channel.
 *
 * Most operators already have something that can post on their behalf - a
 * Make/Zapier scenario, an n8n workflow, a small server of their own. This
 * adapter speaks to that instead of to any one social platform, which means a
 * licensee can be live on day one and swap in a first-party adapter later
 * without touching anything but config.
 *
 * The contract is four endpoints, all `POST` with a JSON body and a JSON
 * response. Only `publish` is required; the others degrade gracefully.
 * The full request/response shapes are in docs/3-development/extending.md.
 */

import { fail, ok, tryAsync, type PlatformError, type Result } from "../core/result.ts";
import type { EngagementSnapshot, SwipeItem } from "../core/types.ts";
import { readFormat } from "./format.ts";
import type {
  Channel,
  ChannelFactoryContext,
  CommentRequest,
  DiscoverRequest,
  PublishRequest,
  PublishResult,
} from "./channel.ts";

type Endpoints = {
  publish?: string;
  discover?: string;
  metrics?: string;
  comment?: string;
};

export function createWebhookChannel(context: ChannelFactoryContext): Channel {
  const endpoints: Endpoints = {
    publish: readString(context.options, "publishUrl"),
    discover: readString(context.options, "discoverUrl"),
    metrics: readString(context.options, "metricsUrl"),
    comment: readString(context.options, "commentUrl"),
  };
  const token = context.credentials["token"] ?? "";
  const timeoutMs = Number(context.options["timeoutMs"] ?? 30_000);

  const call = async <T>(url: string | undefined, name: string, body: unknown): Promise<Result<T, PlatformError>> => {
    if (!url) {
      return fail("config", "channel.endpoint_missing", `Channel "${context.id}" has no options.${name}Url configured.`);
    }
    const response = await tryAsync("network", "channel.request_failed", async () => {
      const result = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await result.text();
      return { status: result.status, text };
    }, { retryable: true });

    if (!response.ok) return response;
    const { status, text } = response.value;
    if (status < 200 || status >= 300) {
      return fail("channel", "channel.http_error", `${name} endpoint for "${context.id}" returned HTTP ${status}.`, {
        retryable: status >= 500 || status === 429,
        details: { body: text.slice(0, 400) },
      });
    }
    if (text.trim() === "") return ok(undefined as T);
    try {
      return ok(JSON.parse(text) as T);
    } catch (cause) {
      return fail("channel", "channel.invalid_json", `${name} endpoint for "${context.id}" did not return JSON.`, {
        details: { body: text.slice(0, 400) },
        cause,
      });
    }
  };

  return {
    id: context.id,
    adapter: "webhook",
    capabilities: {
      publishesItself: true,
      nativeScheduling: Boolean(context.options["nativeScheduling"] ?? false),
      threads: Boolean(context.options["threads"] ?? false),
      discovery: Boolean(endpoints.discover),
      comments: Boolean(endpoints.comment),
      maxCharacters: Number(context.options["maxCharacters"] ?? 500),
      format: readFormat(context.options, "short"),
    },

    async discover(request: DiscoverRequest): Promise<Result<SwipeItem[], PlatformError>> {
      if (!endpoints.discover) return ok([]);
      const response = await call<{ items?: unknown[] }>(endpoints.discover, "discover", {
        queries: request.queries,
        minLikes: request.minLikes,
        maxItems: request.maxItems,
        since: new Date(request.since).toISOString(),
      });
      if (!response.ok) return response;
      const items = Array.isArray(response.value?.items) ? response.value.items : [];
      return ok(items.map((item, index) => normaliseSwipeItem(item, request, context.id, index, context.nowMs())));
    },

    async publish(request: PublishRequest): Promise<Result<PublishResult, PlatformError>> {
      const response = await call<{ externalId?: string; url?: string; scheduled?: boolean; publishedAt?: string }>(
        endpoints.publish,
        "publish",
        {
          postId: request.postId,
          ventureId: request.ventureId,
          scheduledFor: request.scheduledFor ? new Date(request.scheduledFor).toISOString() : null,
          content: request.content,
        },
      );
      if (!response.ok) return response;
      const externalId = response.value?.externalId;
      if (!externalId) {
        return fail("channel", "channel.missing_external_id", `publish endpoint for "${context.id}" returned no externalId.`);
      }
      const scheduled = response.value?.scheduled ?? false;
      return ok({
        externalId,
        ...(response.value?.url ? { url: response.value.url } : {}),
        ...(response.value?.publishedAt ? { publishedAt: response.value.publishedAt } : {}),
        scheduled,
      });
    },

    async comment(request: CommentRequest): Promise<Result<{ externalId: string }, PlatformError>> {
      const response = await call<{ externalId?: string }>(endpoints.comment, "comment", {
        parentExternalId: request.parentExternalId,
        text: request.text,
      });
      if (!response.ok) return response;
      return ok({ externalId: response.value?.externalId ?? `${request.parentExternalId}:comment` });
    },

    async metrics(externalIds): Promise<Result<Record<string, EngagementSnapshot>, PlatformError>> {
      if (!endpoints.metrics || externalIds.length === 0) return ok({});
      const response = await call<Record<string, unknown>>(endpoints.metrics, "metrics", { externalIds });
      if (!response.ok) return response;
      const out: Record<string, EngagementSnapshot> = {};
      for (const [externalId, raw] of Object.entries(response.value ?? {})) {
        out[externalId] = normaliseSnapshot(raw);
      }
      return ok(out);
    },

    async healthCheck(): Promise<Result<string, PlatformError>> {
      // A malformed configured URL used to throw out of `amp doctor` as a raw
      // stack trace. Doctor's whole job is reporting problems in a form the
      // operator can act on, so it reports this one too.
      if (!endpoints.publish) {
        return fail("config", "channel.endpoint_missing", `Channel "${context.id}" needs options.publishUrl.`);
      }
      try {
        return ok(`webhook channel configured (${new URL(endpoints.publish).origin})`);
      } catch {
        return fail(
          "config",
          "channel.bad_endpoint",
          `Channel "${context.id}" has options.publishUrl = "${endpoints.publish}", which is not a URL. ` +
            `Use a full address, e.g. "https://hooks.example.com/post".`,
        );
      }
    },
  };
}

function readString(options: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = options[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function normaliseSwipeItem(
  raw: unknown,
  request: DiscoverRequest,
  channelId: string,
  index: number,
  nowMs: number,
): SwipeItem {
  const item = (raw ?? {}) as Record<string, unknown>;
  return {
    id: typeof item["id"] === "string" ? item["id"] : `swipe_${channelId}_${request.since}_${index}`,
    ventureId: request.ventureId,
    channel: channelId,
    // The injected clock, not the wall clock: a swipe item enters the store and
    // a replayed cycle has to produce the same one.
    capturedAt: typeof item["capturedAt"] === "string" ? item["capturedAt"] : new Date(nowMs).toISOString(),
    ...(typeof item["author"] === "string" ? { author: item["author"] } : {}),
    ...(typeof item["url"] === "string" ? { sourceUrl: item["url"] } : {}),
    text: typeof item["text"] === "string" ? item["text"] : "",
    snapshot: normaliseSnapshot(item["metrics"] ?? item),
    tags: Array.isArray(item["tags"]) ? item["tags"].filter((tag): tag is string => typeof tag === "string") : [],
  };
}

function normaliseSnapshot(raw: unknown): EngagementSnapshot {
  const source = (raw ?? {}) as Record<string, unknown>;
  const read = (key: string): number | undefined => {
    const value = source[key];
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  };
  return {
    ...(read("impressions") !== undefined ? { impressions: read("impressions") as number } : {}),
    likes: read("likes") ?? 0,
    replies: read("replies") ?? 0,
    reposts: read("reposts") ?? 0,
    ...(read("saves") !== undefined ? { saves: read("saves") as number } : {}),
    ...(read("linkClicks") !== undefined ? { linkClicks: read("linkClicks") as number } : {}),
    ...(read("followsGained") !== undefined ? { followsGained: read("followsGained") as number } : {}),
  };
}
