/**
 * Which URL reaches a reader.
 *
 * The platform counts a click because the reader went through `/go/<code>`
 * first. For the whole life of this project the inspector was handed the
 * affiliate network's own destination URL while the writer and the publisher
 * were handed the redirect - and the inspector rewrites the whole body, so its
 * URL is the one that shipped. No click from a post body was ever counted.
 *
 * `policy.test.ts` covers the guardrail in isolation. This file runs the real
 * cycle and looks at what actually came out of it: what every role put in
 * front of a model, and what the scheduled post ended up carrying.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { unwrap } from "../src/core/result.ts";
import { createTestCompany, type TestCompany } from "./helpers.ts";

/** Runs a whole day: propose, approve, inspect, schedule, approve, dispatch. */
async function runWholeCycle(options: Parameters<typeof createTestCompany>[0] = {}): Promise<TestCompany> {
  const company = createTestCompany(options);
  const atProposal = unwrap(await company.orchestrator.runCycle("main"));
  const proposals = (await company.store.decisions.get(atProposal.pendingDecisionId as string))!;

  const atPublish = unwrap(
    await company.orchestrator.resolveGate(proposals.id, {
      decidedBy: "tester",
      selectedIds: proposals.items.filter((item) => item.recommended).map((item) => item.id),
      nowIso: company.clock.nowIso(),
    }),
  );

  const publishId = atPublish.pendingDecisionId;
  if (publishId) {
    const publish = (await company.store.decisions.get(publishId))!;
    unwrap(
      await company.orchestrator.resolveGate(publish.id, {
        decidedBy: "tester",
        selectedIds: publish.items.map((item) => item.id),
        nowIso: company.clock.nowIso(),
      }),
    );
  }

  return company;
}

/**
 * Every role that writes text, not just the inspector.
 *
 * The first fix checked the inspector's prompt and nothing else, which left
 * the publisher's `schedule.comments` - the other place a URL is put in front
 * of a model, and the one that writes the link drop - covered by nothing.
 */
test("every prompt that hands a model a link hands it the tracked one", async () => {
  const company = await runWholeCycle();
  const links = await company.store.links.all();
  assert.ok(links.length > 0, "the cycle must have issued at least one tracked link");

  const shown = company.llm.calls
    .map((call) => ({ purpose: call.purpose, user: call.user, url: /link to use: (\S+)/.exec(call.user)?.[1] }))
    .filter((call) => call.url?.startsWith("http"));

  const purposes = new Set(shown.map((call) => call.purpose));
  for (const required of ["write.draft", "inspect.review", "schedule.comments"]) {
    assert.ok(purposes.has(required), `${required} never named a link, so this test proves nothing about it`);
  }

  for (const call of shown) {
    assert.ok(
      call.url!.startsWith(`${company.config.tracking.baseUrl}/go/`),
      `${call.purpose} was shown ${call.url}; a reader has to go through the platform's own redirect`,
    );
    for (const link of links) {
      assert.equal(
        call.user.includes(link.destinationUrl),
        false,
        `${call.purpose} was shown the merchant's own URL somewhere in its prompt`,
      );
    }
  }
});

/**
 * The repair, end to end.
 *
 * Removing the offending comment was the first answer, and it silently cost
 * the post its link: the publisher appends the tracked URL to the link drop
 * immediately before the check runs, so dropping the comment threw that away
 * too. What shipped was a post with an offer, a link id and no URL anywhere -
 * it looks entirely normal and earns nothing.
 */
test("a link drop the model wrote with the merchant's URL still ships a tracked link", async () => {
  const company = await runWholeCycle({
    responses: {
      // `https://example.com/lp` is the test offer's own landing page, which is
      // the destination stripped of its tracking query - what a model that
      // knows the product writes when it is not given a URL to copy.
      "schedule.comments": (() => ({
        comments: [
          { purpose: "link_drop", text: "使ったのはこれです → https://example.com/lp" },
          { purpose: "faq", text: "どこで詰まりましたか。" },
        ],
      })) as never,
    },
  });

  const posts = await company.store.posts.all();
  const withOffer = posts.filter((post) => post.offerId);
  assert.ok(withOffer.length > 0, "at least one scheduled post must carry an offer");

  for (const post of withOffer) {
    const drops = post.commentDrafts.filter((comment) => comment.purpose === "link_drop");
    assert.equal(drops.length, 1, `a post with an offer must keep its link drop, got ${drops.length}`);

    const link = post.linkId ? await company.store.links.get(post.linkId) : undefined;
    assert.ok(link, "the post must still be bound to its tracked link");
    assert.ok(
      drops[0]!.text.includes(`${company.config.tracking.baseUrl}/go/${link.code}`),
      `the link drop must carry the tracked URL, got: ${drops[0]!.text}`,
    );
    assert.equal(
      drops[0]!.text.includes("example.com/lp"),
      false,
      "the merchant's own URL must be gone, not sitting beside the tracked one",
    );
  }
});
