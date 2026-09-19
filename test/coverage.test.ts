/**
 * Coverage: which angles the planner is told not to repeat.
 *
 * The rule under test is that being proposed is not the same as being read.
 * The operator is shown more ideas than the account can publish in a day, so
 * an idea they liked and left has to survive until they come back to it.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { COVERED_ANGLE_LIMIT, coveredAngles, publishedHooks } from "../src/domain/coverage.ts";
import type { Draft, Idea, PostStatus, ScheduledPost } from "../src/core/types.ts";

const VENTURE = "venture-1";
const CYCLE = "cycle-1";

function idea(id: string, angle: string): Idea {
  return {
    id,
    cycleId: CYCLE,
    ventureId: VENTURE,
    title: `title ${id}`,
    angle,
    targetPain: "読者の困りごと",
    promisedOutcome: "読み終えて手に入るもの",
    expectedEngagement: 40,
    rationale: "過去の投稿が伸びたから",
    risk: "刺さらないかもしれない",
    rank: 1,
  };
}

function draft(id: string, ideaId: string): Draft {
  return {
    id,
    ideaId,
    cycleId: CYCLE,
    ventureId: VENTURE,
    channel: "threads",
    content: { hook: "hook", body: "body", cta: "cta", disclosure: "PR", hashtags: [] },
    createdAt: "2026-09-18T00:00:00.000Z",
    revision: 1,
  };
}

function post(id: string, draftId: string, status: PostStatus): ScheduledPost {
  return {
    id,
    cycleId: CYCLE,
    ventureId: VENTURE,
    draftId,
    channel: "threads",
    content: { hook: "hook", body: "body", cta: "cta", disclosure: "PR", hashtags: [] },
    scheduledFor: Date.parse("2026-09-18T09:00:00.000Z"),
    slotReason: "測定した最良の時間",
    order: 1,
    status,
    commentDrafts: [],
  };
}

test("an idea that was proposed and never picked stays available", () => {
  const angles = coveredAngles({
    ideas: [idea("idea-1", "選ばれなかった切り口")],
    drafts: [],
    posts: [],
  });

  assert.deepEqual(angles, []);
});

test("an angle that reached a published post is covered", () => {
  const angles = coveredAngles({
    ideas: [idea("idea-1", "公開まで行った切り口")],
    drafts: [draft("draft-1", "idea-1")],
    posts: [post("post-1", "draft-1", "published")],
  });

  assert.deepEqual(angles, ["公開まで行った切り口"]);
});

test("an angle waiting in the queue is not covered until it goes out", () => {
  const angles = coveredAngles({
    ideas: [idea("idea-1", "まだ出ていない切り口")],
    drafts: [draft("draft-1", "idea-1")],
    posts: [post("post-1", "draft-1", "scheduled")],
  });

  assert.deepEqual(angles, []);
});

test("the cap counts published angles only, and the newest of them survive it", () => {
  const count = COVERED_ANGLE_LIMIT + 5;
  // Every published idea is followed by one the operator was shown and left,
  // so a cap applied to proposals rather than to what went out lands on a
  // different window - and on angles that were never read by anyone.
  const ideas = Array.from({ length: count }, (_, index) => [
    idea(`published-${index}`, `公開した切り口 ${index}`),
    idea(`unpicked-${index}`, `選ばなかった切り口 ${index}`),
  ]).flat();
  const drafts = Array.from({ length: count }, (_, index) => draft(`draft-${index}`, `published-${index}`));
  const posts = drafts.map((item, index) => post(`post-${index}`, item.id, "published"));

  const angles = coveredAngles({ ideas, drafts, posts });

  assert.equal(angles.length, COVERED_ANGLE_LIMIT);
  assert.equal(angles.at(0), `公開した切り口 ${count - COVERED_ANGLE_LIMIT}`);
  assert.equal(angles.at(-1), `公開した切り口 ${count - 1}`);
});

test("an opening nobody has read is not an opening this account has used", () => {
  // The writing role is told not to repeat the openings of "recent posts from
  // this account", and was handed every draft - including the ones written,
  // inspected and then not chosen. Those hooks were retired without ever having
  // been read, exactly as the planner was retiring unpicked angles.
  const drafts = [
    { id: "draft_published", ideaId: "idea_1", createdAt: "2026-09-01T00:00:00.000Z", content: { hook: "公開した書き出し" } },
    { id: "draft_left", ideaId: "idea_2", createdAt: "2026-09-02T00:00:00.000Z", content: { hook: "選ばれなかった書き出し" } },
  ] as unknown as Parameters<typeof publishedHooks>[0]["drafts"];
  const posts = [
    { draftId: "draft_published", status: "published" },
    { draftId: "draft_left", status: "cancelled" },
  ] as unknown as Parameters<typeof publishedHooks>[0]["posts"];

  const hooks = publishedHooks({ drafts, posts }, 25).map((draft: { content: { hook: string } }) => draft.content.hook);
  assert.deepEqual(hooks, ["公開した書き出し"]);
});
