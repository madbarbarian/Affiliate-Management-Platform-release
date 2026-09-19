/**
 * A simulated channel.
 *
 * It is not a stub that returns zeroes - the analysis role has to have
 * something to learn from, or a dry run tells you nothing about whether the
 * loop closes. Engagement is derived deterministically from the text (hook
 * length, question marks, numerals - the crude proxies real hooks lean on) and
 * grows with the post's age, so patterns genuinely separate over a few cycles.
 */

import { createHash } from "node:crypto";

import { ok, type PlatformError, type Result } from "../core/result.ts";
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

type PublishedRecord = { text: string; publishedAtMs: number };

export function createMockChannel(context: ChannelFactoryContext): Channel {
  const published = new Map<string, PublishedRecord>();
  const seed = String(context.options["seed"] ?? context.id);

  return {
    id: context.id,
    adapter: "mock",
    capabilities: {
      publishesItself: true,
      // Configurable because the two cases behave very differently once
      // something goes wrong: a channel that schedules natively is holding the
      // post itself and the platform can no longer recall it, while a channel
      // without scheduling leaves the post with us until its slot. The mock has
      // to be able to be either, or the second path never gets exercised.
      nativeScheduling: context.options["nativeScheduling"] !== false,
      threads: true,
      discovery: true,
      comments: true,
      maxCharacters: Number(context.options["maxCharacters"] ?? 500),
      format: readFormat(context.options, "thread"),
    },

    async discover(request: DiscoverRequest): Promise<Result<SwipeItem[], PlatformError>> {
      const items: SwipeItem[] = [];
      const queries = request.queries.length > 0 ? request.queries : ["general"];
      for (let i = 0; i < request.maxItems; i += 1) {
        const query = queries[i % queries.length] as string;
        const key = `${seed}:${query}:${i}`;
        const likes = 80 + hashInt(key, 4000);
        if (likes < request.minLikes) continue;
        items.push({
          id: `swipe_${hashHex(key, 12)}`,
          ventureId: request.ventureId,
          channel: context.id,
          capturedAt: new Date(context.nowMs()).toISOString(),
          author: `@sample_${hashInt(`${key}:author`, 900) + 100}`,
          text: sampleText(query, i),
          snapshot: {
            impressions: likes * (8 + hashInt(`${key}:imp`, 20)),
            likes,
            replies: Math.round(likes * 0.04) + hashInt(`${key}:re`, 12),
            reposts: Math.round(likes * 0.02) + hashInt(`${key}:rp`, 6),
            saves: Math.round(likes * 0.06),
          },
          tags: [query],
        });
      }
      return ok(items);
    },

    async publish(request: PublishRequest): Promise<Result<PublishResult, PlatformError>> {
      const externalId = `mock_${hashHex(`${seed}:${request.postId}`, 16)}`;
      const scheduled = request.scheduledFor !== undefined && request.scheduledFor > context.nowMs();
      published.set(externalId, {
        text: `${request.content.hook}\n${request.content.body}`,
        publishedAtMs: request.scheduledFor ?? context.nowMs(),
      });
      return ok({
        externalId,
        url: `https://mock.invalid/${context.id}/${externalId}`,
        ...(scheduled ? {} : { publishedAt: new Date(context.nowMs()).toISOString() }),
        scheduled,
      });
    },

    async comment(request: CommentRequest): Promise<Result<{ externalId: string }, PlatformError>> {
      return ok({ externalId: `mock_c_${hashHex(`${request.parentExternalId}:${request.text}`, 12)}` });
    },

    async metrics(externalIds): Promise<Result<Record<string, EngagementSnapshot>, PlatformError>> {
      const out: Record<string, EngagementSnapshot> = {};
      for (const externalId of externalIds) {
        const record = published.get(externalId);
        if (!record) continue;
        out[externalId] = simulate(record, context.nowMs());
      }
      return ok(out);
    },

    async healthCheck(): Promise<Result<string, PlatformError>> {
      return ok("mock channel ready (no credentials needed)");
    },
  };
}

/**
 * The simulated engagement model. Rewards a short hook, a concrete numeral and
 * a question - the same crude signals the writing role is told to aim at, so
 * the analysis role can actually detect the difference between drafts.
 */
function simulate(record: PublishedRecord, nowMs: number): EngagementSnapshot {
  const [hook = "", ...rest] = record.text.split("\n");
  const body = rest.join("\n");
  const ageHours = Math.max(0, (nowMs - record.publishedAtMs) / 3_600_000);
  // Engagement accumulates fast then flattens - most of it lands in a day.
  const maturity = 1 - Math.exp(-ageHours / 8);

  let quality = 1;
  if (hook.length <= 28) quality += 0.45;
  else if (hook.length <= 45) quality += 0.2;
  else quality -= 0.15;
  if (/[0-9０-９]/.test(hook)) quality += 0.3;
  if (/[?？]/.test(hook)) quality += 0.15;
  if (body.length > 120 && body.length < 900) quality += 0.2;
  quality = Math.max(0.2, quality);

  const noise = 0.75 + hashInt(record.text, 50) / 100;
  const base = 220 * quality * noise * maturity;
  const likes = Math.round(base);
  return {
    impressions: Math.round(base * 14),
    likes,
    replies: Math.round(base * 0.05),
    reposts: Math.round(base * 0.025),
    saves: Math.round(base * 0.08),
    linkClicks: Math.round(base * 0.035),
    followsGained: Math.round(base * 0.012),
  };
}

const SAMPLE_SHAPES = [
  "3か月で{topic}をやめた。理由は1つだけ。",
  "{topic}で伸び悩んでる人、たぶんここを飛ばしてる。",
  "{topic}を100件見て気づいた共通点を書く。",
  "正直に言うと、{topic}は最初の2週間が全部です。",
  "{topic}、有料級のことを1つだけ置いていきます。",
];

function sampleText(query: string, index: number): string {
  const shape = SAMPLE_SHAPES[index % SAMPLE_SHAPES.length] as string;
  return `${shape.replace("{topic}", query)}\n\n（サンプル本文。mock アダプタが生成した研究用ダミーです）`;
}

function hashHex(input: string, length: number): string {
  return createHash("sha256").update(input).digest("hex").slice(0, length);
}

function hashInt(input: string, range: number): number {
  const digest = createHash("sha256").update(input).digest();
  return digest.readUInt32BE(0) % Math.max(1, range);
}
