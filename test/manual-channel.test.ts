/**
 * Posting it yourself.
 *
 * A channel that cannot publish is not a broken channel - it is the licensee
 * with their phone in their hand. Everything up to the slot is unchanged, and
 * at the slot the post is composed and handed over instead of published.
 *
 * The two things that would quietly destroy this: a dispatcher that records a
 * publication nobody made, and a screen that shows text different from the text
 * that was handed over. Both are asserted here.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { BASE_CONFIG, createTestCompany, HOUR_MS, testConfig, type TestCompany } from "./helpers.ts";
import { unwrap } from "../src/core/result.ts";
import { renderPostParts } from "../src/channels/format.ts";
import { describeMeasurementChain } from "../src/domain/measurement.ts";
import { memoryState } from "../src/kernel/state.ts";
import { createTickMemory, runTick } from "../src/scheduler/tick.ts";
import type { Runtime } from "../src/runtime.ts";
import type { ScheduledPost } from "../src/core/types.ts";

const VENTURE = "main";
const CHANNEL = "by-hand";

const BY_HAND_CHANNEL = {
  id: CHANNEL,
  adapter: "manual",
  enabled: true,
  credentialEnv: {},
  research: { queries: [], minLikes: 0, maxItems: 1, lookbackHours: 24 },
  options: { maxCharacters: 500, format: "thread", composerUrl: "https://www.threads.net/" },
};

/** The test company, posting by hand, deciding both gates itself. */
function byHandCompany(responses: Record<string, (request: never) => unknown> = {}): TestCompany {
  return createTestCompany({
    config: testConfig({
      company: { name: "Hand Co", operator: "owner", autonomy: "auto" },
      channels: [BY_HAND_CHANNEL],
      ventures: BASE_CONFIG.ventures.map((venture) => ({ ...venture, channels: [CHANNEL] })),
    }),
    ...(Object.keys(responses).length > 0 ? { responses } : {}),
  });
}

/** A Runtime with no process behind it, exactly as `tick.test.ts` builds one. */
function runtimeFor(company: TestCompany): Runtime {
  return {
    loaded: { config: company.config, path: "test", dataDir: ".amp-test", promptsDir: "prompts" },
    config: company.config,
    state: memoryState(),
    services: company.services,
    orchestrator: company.orchestrator,
    bus: company.services.bus,
    dryRun: false,
    close: async () => {},
  } as unknown as Runtime;
}

/** Runs a whole day and moves the clock past every slot it booked. */
async function dayPastEverySlot(company: TestCompany): Promise<ScheduledPost[]> {
  unwrap(await company.orchestrator.runCycle(VENTURE));
  const approved = await company.store.posts.find((post) => post.status === "approved");
  assert.ok(approved.length > 0, "a channel that cannot publish still books its slots");
  const latest = Math.max(...approved.map((post) => post.scheduledFor));
  company.clock.set(new Date(latest + HOUR_MS).toISOString());
  return approved;
}

test("a due post on a channel that cannot publish is never published by the tick - it waits for a person", async () => {
  const company = byHandCompany();
  const approved = await dayPastEverySlot(company);

  await runTick(runtimeFor(company), createTickMemory(), company.clock.now(), { dispatch: true });

  const posts = await company.store.posts.all();
  assert.equal(
    posts.filter((post) => post.status === "published").length,
    0,
    "nothing may be recorded as live: nobody has posted anything",
  );
  const waiting = posts.filter((post) => post.status === "handed_over");
  assert.equal(waiting.length, approved.length, "every due post is now waiting for the operator");

  for (const post of waiting) {
    assert.ok((post.handOverParts ?? []).length > 0, "a post handed over with no text is nothing to hand over");
    assert.ok(post.handedOverAt, "when it was handed over is part of the record");
    assert.equal(post.publishedAt, undefined, "and it has no publication time, because it was not published");
  }

  // Persisted where every other artifact is, and in the trail, so the day can
  // be read back.
  const events = await company.store.audit.recent(50);
  assert.equal(
    events.filter((event) => event.type === "post.handed_over").length,
    waiting.length,
  );
  assert.equal(events.filter((event) => event.type === "post.published").length, 0);
});

test("the text handed over is the text the channel would have posted", async () => {
  const company = byHandCompany();
  await dayPastEverySlot(company);
  unwrap(await company.orchestrator.dispatchDue(company.clock.now()));

  const channel = unwrap(company.services.channels.get(CHANNEL));
  assert.equal(channel.capabilities.publishesItself, false, "this channel says it cannot publish itself");

  const waiting = await company.store.posts.find((post) => post.status === "handed_over");
  for (const post of waiting) {
    // Compared against the shared composition, not against the channel's own
    // answer: asking the channel what it composes and then checking it against
    // what it composed proves nothing. `renderPostParts` is the function the
    // adapters that really publish go through - `threads.ts` calls exactly this
    // with its own limit - so this says the person is handed the same text the
    // API would have sent.
    assert.deepEqual(
      post.handOverParts,
      renderPostParts(post.content, 500),
      "what the person is handed must be the post, not a second rendering of the draft",
    );
    // And it is the composition, not the raw fields: the hook leads the first
    // part whether or not the writer repeated it.
    assert.ok((post.handOverParts?.[0] ?? "").startsWith(post.content.hook.trim().slice(0, 12)));
  }
});

test("an offer post still carries its disclosure in what the person is handed", async () => {
  const company = byHandCompany();
  await dayPastEverySlot(company);
  unwrap(await company.orchestrator.dispatchDue(company.clock.now()));

  const waiting = await company.store.posts.find((post) => post.status === "handed_over");
  const withOffer = waiting.filter((post) => post.offerId);
  assert.ok(withOffer.length > 0, "the demo day has to carry at least one offer for this to mean anything");

  for (const post of withOffer) {
    const first = post.handOverParts?.[0] ?? "";
    assert.ok(
      first.includes("#PR"),
      `the notice must be in the first part a person pastes, not buried later: ${first.slice(0, 80)}`,
    );
  }

  // The day's own drafts happen to repeat the notice in their copy, so the
  // assertion above would stay green even if composition dropped it entirely.
  // This is the case that actually tests the channel: the notice exists in one
  // field and nowhere else, and it still has to reach the first part - in a
  // thread, in a single post, and when the first part is far too long for the
  // limit, which is where it used to be sliced off the end.
  const channel = unwrap(company.services.channels.get(CHANNEL));
  const bare = { hook: "3か月でやめた話", body: "本文です。", cta: "続きはこちら", hashtags: [], disclosure: "#PR" };
  for (const [shape, content] of [
    ["a thread", { ...bare, threadParts: ["1つ目のパート。", "2つ目のパート。"] }],
    ["one post", { ...bare, threadParts: [] }],
    ["an overlong first part", { ...bare, threadParts: ["長い。".repeat(400)] }],
  ] as const) {
    const parts = channel.compose?.(content as never) ?? [];
    assert.ok(
      (parts[0] ?? "").includes("#PR"),
      `${shape}: the person was handed text with no notice on it`,
    );
  }

  // The affiliate link goes with it. On a channel with comments it lives in the
  // link drop; this channel has none, so the drop travels with the post and the
  // console hands it over too. Without it the loop that justifies the whole
  // feature - click, conversion, revenue - never closes.
  const drops = withOffer.flatMap((post) =>
    post.commentDrafts.filter((comment) => comment.purpose === "link_drop"),
  );
  assert.ok(drops.length > 0, "an offer post keeps its link drop");
  assert.ok(drops.every((drop) => drop.text.includes("/go/")), "and the link in it is our own redirect");
});

test("a draft that fails inspection never reaches the person", async () => {
  const company = byHandCompany({
    // The same unfixable inspector `orchestrator.test.ts` uses. Nothing about a
    // person doing the posting may relax a guardrail: the draft is blocked
    // before there is a post to hand anyone.
    "inspect.review": (() => ({
      aiSmellScore: 90,
      revisedAiSmellScore: 90,
      findings: [
        { severity: "blocking", code: "compliance.prohibited_claim", message: "必ず稼げる と書いてある", excerpt: "", suggestion: "" },
      ],
      revised: {
        hook: "これをやれば必ず稼げます",
        body: "必ず稼げる方法です",
        cta: "今すぐ",
        disclosure: "",
        hashtags: [],
        threadParts: [],
      },
      unfixable: "主張を裏づける事実がないため修正できません",
    })) as never,
  });

  unwrap(await company.orchestrator.runCycle(VENTURE));
  assert.equal((await company.store.posts.all()).length, 0, "nothing may be scheduled");

  const dispatched = unwrap(await company.orchestrator.dispatchDue(company.clock.now() + 2 * HOUR_MS));
  assert.deepEqual(dispatched.handedOver, [], "and nothing may be handed to the operator either");
  assert.deepEqual(dispatched.published, []);
});

test("the operator saying they posted it is what makes it published, timed to the press", async () => {
  const company = byHandCompany();
  await dayPastEverySlot(company);
  const dispatched = unwrap(await company.orchestrator.dispatchDue(company.clock.now()));
  assert.ok(dispatched.handedOver.length > 0);
  assert.deepEqual(dispatched.published, [], "handing over is not publishing");

  const waiting = (await company.store.posts.find((post) => post.status === "handed_over"))[0] as ScheduledPost;

  // The person got to their phone half an hour after the slot. That is the time
  // the post went out, and the slot is not.
  const pressedAt = new Date(company.clock.now() + 37 * 60_000).toISOString();
  company.clock.set(pressedAt);
  const published = unwrap(
    await company.orchestrator.recordPostedByHand(waiting.id, {
      by: "owner",
      url: "https://www.threads.net/@owner/post/abc123",
      nowIso: company.clock.nowIso(),
    }),
  );

  assert.equal(published.status, "published");
  assert.equal(published.publishedAt, pressedAt, "the time it was pressed, not the slot it was booked for");
  assert.notEqual(published.publishedAt, new Date(waiting.scheduledFor).toISOString());
  assert.equal(published.externalUrl, "https://www.threads.net/@owner/post/abc123");
  assert.equal(published.postedBy, "owner");

  const stored = await company.store.posts.get(waiting.id);
  assert.equal(stored?.status, "published", "and it is on disk, not only in the answer");

  const event = (await company.store.audit.recent(50)).find(
    (entry) => entry.type === "post.published" && entry.data["postId"] === waiting.id,
  );
  assert.ok(event, "a post going live is in the trail whoever put it there");
  assert.equal(event?.actor, "owner", "and the trail says who said so");

  // Pressed twice - the poll rebuilds the card, so this will happen.
  const again = await company.orchestrator.recordPostedByHand(waiting.id, {
    by: "owner",
    nowIso: company.clock.nowIso(),
  });
  assert.equal(again.ok, false);
  assert.equal(again.ok ? "" : again.error.code, "post.not_handed_over");
});

test("a due post on an ordinary channel still publishes by itself", async () => {
  // The regression that matters most: the branch above must not have taken the
  // ordinary path with it. This is the stock test config - a mock channel that
  // schedules natively - run end to end.
  const company = createTestCompany({
    config: testConfig({ company: { name: "Auto Co", operator: "auto", autonomy: "auto" } }),
  });
  unwrap(await company.orchestrator.runCycle(VENTURE));
  const scheduled = await company.store.posts.find((post) => post.status === "scheduled");
  assert.ok(scheduled.length > 0);

  const latest = Math.max(...scheduled.map((post) => post.scheduledFor));
  company.clock.set(new Date(latest + HOUR_MS).toISOString());
  const dispatched = unwrap(await company.orchestrator.dispatchDue(company.clock.now()));

  assert.equal(dispatched.published.length, scheduled.length, "an ordinary channel publishes on its own");
  assert.deepEqual(dispatched.handedOver, [], "and asks nobody to do it by hand");
  assert.equal((await company.store.posts.find((post) => post.status === "handed_over")).length, 0);
});

test("a channel you post yourself is not a channel making its numbers up", async () => {
  // The two read the same in a table and are opposite problems. One is a
  // configuration to fix before anyone sees a post; the other is a trade the
  // licensee made on purpose, and telling them to fix it is telling them to
  // undo their own decision.
  const byHand = describeMeasurementChain(
    testConfig({
      channels: [BY_HAND_CHANNEL],
      ventures: BASE_CONFIG.ventures.map((venture) => ({ ...venture, channels: [CHANNEL] })),
    }),
    VENTURE,
  );
  const engagement = byHand.links.find((link) => link.step === "engagement");
  assert.ok(engagement);
  assert.ok(!engagement.ok, "the loss is visible, not hidden");
  assert.doesNotMatch(engagement.problem, /simulated, so nothing/, "nothing here is being invented");
  assert.match(engagement.problem, /you\s+post them yourself/);
  assert.match(engagement.problem, /[Cc]licks, conversions and revenue are unaffected/);

  const simulated = describeMeasurementChain(testConfig(), VENTURE);
  assert.match(
    simulated.links.find((link) => link.step === "engagement")?.problem ?? "",
    /simulated/,
    "and the mock adapter still says what it always said",
  );
});
