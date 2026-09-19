/**
 * The orchestrator - the thing that makes six roles into a company.
 *
 * It owns the day. Roles do their job and return; the orchestrator decides
 * what runs next, persists after every step, and stops dead at the two points
 * where a human is required. Nothing about a cycle lives in memory: kill the
 * process at any moment and `amp cycle run` picks up from the last completed
 * step, which is what makes an approval gate survivable in the first place -
 * the machine may be waiting hours for someone to wake up.
 *
 * One cycle per venture per local day. The id is derived from the date rather
 * than generated, so running the command twice does not start a second
 * company day.
 */

import { localDate } from "../core/clock.ts";
import { describeError, fail, ok, type PlatformError, type Result } from "../core/result.ts";
import type {
  AuditEvent,
  Cycle,
  CycleArtifacts,
  CycleStep,
  CycleStepRecord,
  Decision,
  DecisionId,
  DecisionItem,
  Draft,
  Idea,
  ScheduledPost,
  Venture,
  VentureId,
} from "../core/types.ts";
import { analyst, inspector, planner, publisher, researcher, writer } from "../roles/index.ts";
import { autoResolve, createDecision, requiresHuman, resolveDecision, type ResolutionRequest } from "./approvals.ts";
import { createRoleContext, type Services } from "./role.ts";
import { truncate } from "../roles/format.ts";

const STEP_ORDER: readonly CycleStep[] = [
  "analyze",
  "research",
  "plan",
  "proposal_approval",
  "write",
  "inspect",
  "schedule",
  "publish_approval",
  "dispatch",
];

type StepOutcome =
  | { kind: "advance"; note: string; artifacts: Partial<CycleArtifacts> }
  | { kind: "await"; decisionId: string; note: string; artifacts: Partial<CycleArtifacts> }
  | { kind: "finish"; note: string; artifacts: Partial<CycleArtifacts> };

export type RunCycleOptions = {
  /** Start a cycle for this local date instead of today. Format YYYY-MM-DD. */
  readonly date?: string;
  /** Stop before this step. Used by `amp cycle run --until plan`. */
  readonly until?: CycleStep;
};

export type DispatchSummary = {
  readonly published: readonly string[];
  /**
   * Posts whose slot arrived on a channel that cannot publish by itself. They
   * are composed and waiting for a person, and are deliberately not in
   * `published`: nothing is live until someone says they posted it.
   */
  readonly handedOver: readonly string[];
  readonly failed: readonly { postId: string; reason: string }[];
  readonly stillWaiting: number;
  /** Posts whose slot has passed but that a stop is holding back. */
  readonly held: number;
  /**
   * Posts the channel published on its own clock while stopped, whose comments
   * this platform therefore did not add. Unlike `held`, these are not caught up
   * on resume - the post is live and its comment thread is simply empty, which
   * the operator has to decide about themselves.
   */
  readonly commentsWithheld: number;
};

export type DispatchOptions = {
  /**
   * Ventures that must not publish on this pass. Their due posts stay due:
   * a stop delays a post, it never cancels one, so nothing is lost when the
   * operator starts again.
   */
  readonly skipVentures?: readonly VentureId[];
};

export type Orchestrator = {
  /** Starts today's cycle, or resumes it, running until a gate or the end. */
  runCycle(ventureId: VentureId, options?: RunCycleOptions): Promise<Result<Cycle, PlatformError>>;
  /** Records a person's decision and continues the cycle it was blocking. */
  resolveGate(decisionId: string, request: ResolutionRequest): Promise<Result<Cycle, PlatformError>>;
  /** Publishes anything whose slot has arrived. Called by the daemon. */
  dispatchDue(nowMs: number, options?: DispatchOptions): Promise<Result<DispatchSummary, PlatformError>>;
  /**
   * Records that a person posted, by hand, a post the platform handed them.
   *
   * The only way a `handed_over` post becomes `published`. `nowIso` is when
   * they said so, not when the slot was - the two differ by however long it
   * took them to get to their phone, and the second one would be a guess.
   */
  recordPostedByHand(
    postId: string,
    request: { readonly by: string; readonly url?: string; readonly nowIso: string },
  ): Promise<Result<ScheduledPost, PlatformError>>;
  pendingDecisions(ventureId?: VentureId): Promise<Decision[]>;
  /**
   * Closes gates whose day has gone, in each account's own timezone.
   *
   * A day nobody answered is a day the company does not run - see
   * `requirements.md` 4, "答えないことも答えである". The decision and its ideas
   * are kept; only the invitation to act on them is withdrawn.
   */
  expireStaleGates(): Promise<Result<{ readonly expired: readonly DecisionId[] }, PlatformError>>;
};

export function createOrchestrator(services: Services): Orchestrator {
  const { config, stores, clock, logger } = services;

  const ventureById = new Map(config.ventures.map((venture) => [venture.id, venture]));

  /**
   * Records something that happened, in both places it has to be recorded.
   *
   * The bus is for anything listening right now; the audit log is the durable
   * record the operating promise rests on - that a person can go back and see
   * why a post was proposed. Roles have always written to both (role.ts), but
   * the orchestrator only ever emitted, so the cycle's own decisions - the
   * gates opening and closing, a post going live - were the events missing
   * from the trail and from the console's activity feed.
   */
  async function recordEvent(event: AuditEvent): Promise<void> {
    const store = await stores.for(event.ventureId);
    await store.audit.append(event);
    await services.bus.emit(event);
  }

  const runCycle: Orchestrator["runCycle"] = async (ventureId, options = {}) => {
    const venture = ventureById.get(ventureId);
    if (!venture) {
      return fail("config", "cycle.unknown_venture", `No venture "${ventureId}" in the config.`, {
        details: { known: [...ventureById.keys()] },
      });
    }
    if (!venture.active) {
      return fail("config", "cycle.venture_inactive", `Venture "${ventureId}" is marked inactive.`);
    }

    const date = options.date ?? localDate(clock.now(), venture.timezone);
    const cycle = await loadOrCreateCycle(venture, date);
    return advanceOnce(venture, cycle, options);
  };

  async function loadOrCreateCycle(venture: Venture, date: string): Promise<Cycle> {
    const store = await stores.for(venture.id);
    const id = `cyc_${venture.id}_${date}`;
    const existing = await store.cycles.get(id);
    if (existing) return existing;
    const nowIso = clock.nowIso();
    const created: Cycle = {
      id,
      ventureId: venture.id,
      date,
      createdAt: nowIso,
      updatedAt: nowIso,
      status: "running",
      nextStep: "analyze",
      completed: [],
      artifacts: {},
    };
    await store.cycles.put(created);
    return created;
  }

  /**
   * The cycles being advanced right now, by id.
   *
   * Two callers in one process is not hypothetical: `amp daemon` serves the
   * console and runs the tick in the same process, so pressing 今日のサイクルを
   * 動かす at 09:00:30 and the 09:01 tick both reach `runCycle` for the same
   * `cyc_<venture>_<date>`. Nothing below stopped them - two runs of the write
   * step is two sets of drafts and, past the second gate, two posts. The
   * console's lock only exists on the Worker, and the data directory's lock is
   * between processes, so neither of them was ever going to catch this.
   *
   * A second caller joins the first rather than being refused: for the button
   * that means the operator sees the run that is already happening, which is
   * what they wanted. In memory on purpose - a crashed process must not leave a
   * cycle nobody can start again.
   */
  const inFlight = new Map<string, Promise<Result<Cycle, PlatformError>>>();

  function advanceOnce(
    venture: Venture,
    cycle: Cycle,
    options: RunCycleOptions,
  ): Promise<Result<Cycle, PlatformError>> {
    const already = inFlight.get(cycle.id);
    if (already) {
      logger.info("joining the run already in progress", { cycle: cycle.id });
      return already;
    }
    const work = advance(venture, cycle, options).finally(() => inFlight.delete(cycle.id));
    inFlight.set(cycle.id, work);
    return work;
  }

  /** Runs steps until a gate, the end, a failure, or the `until` boundary. */
  async function advance(
    venture: Venture,
    start: Cycle,
    options: RunCycleOptions,
  ): Promise<Result<Cycle, PlatformError>> {
    const store = await stores.for(venture.id);
    let cycle = start;

    if (cycle.status === "completed" || cycle.status === "cancelled") return ok(cycle);
    if (cycle.status === "failed") {
      // A previous run died. Retry the step it died on rather than the whole day,
      // and drop the reason it died of: the console shows a failure whenever one
      // is stored, so a day that recovered on the next hourly retry went on
      // saying 実行できませんでした next to its own approval gate. The record of
      // the failure lives in the audit log now, which is where history belongs.
      cycle = { ...cycle, status: "running", failure: undefined };
    }

    while (cycle.nextStep) {
      const step = cycle.nextStep;
      if (options.until && step === options.until) break;

      const startedAt = clock.nowIso();
      const startedMs = clock.now();
      logger.info(`step ${step}`, { venture: venture.id, cycle: cycle.id });

      let outcome: Result<StepOutcome, PlatformError>;
      try {
        outcome = await runStep(venture, cycle, step);
      } catch (cause) {
        // A role throwing is a bug, not a business outcome - but it must not
        // take the process down or lose the day's completed work.
        outcome = fail("internal", "cycle.step_threw", `Step "${step}" threw: ${errorText(cause)}`, { cause });
      }

      if (!outcome.ok) {
        cycle = {
          ...cycle,
          status: "failed",
          updatedAt: clock.nowIso(),
          failure: { step, message: outcome.error.message, code: outcome.error.code },
        };
        await store.cycles.put(cycle);
        logger.error(`step ${step} failed`, { error: describeError(outcome.error) });

        // The log line above is the whole record on a host with no terminal,
        // which is to say nobody's. Two days died on Cloudflare with the audit
        // log's last entry three days old, so the console's activity feed said
        // "nothing has happened" while the cycle was failing every hour.
        //
        // The summary stays short and the message goes in `data`: a 400 is a
        // paragraph of JSON, and a feed is not where anyone reads one. The
        // code is what the console turns into the operator's words.
        try {
          await recordEvent({
            id: services.ids.next("evt"),
            at: clock.nowIso(),
            ventureId: venture.id,
            cycleId: cycle.id,
            type: "cycle.failed",
            actor: "orchestrator",
            summary: `The cycle stopped at ${step} (${outcome.error.code}).`,
            data: {
              step,
              code: outcome.error.code,
              retryable: outcome.error.retryable,
              message: truncate(outcome.error.message, 500),
            },
          });
        } catch (cause) {
          // Never let recording the failure replace the failure. The cycle is
          // already persisted; losing the trail is bad, losing the reason the
          // caller is about to act on is worse.
          logger.error("could not record the failure", { error: errorText(cause) });
        }
        return outcome;
      }

      const record: CycleStepRecord = {
        step,
        startedAt,
        finishedAt: clock.nowIso(),
        durationMs: clock.now() - startedMs,
        note: outcome.value.note,
      };

      const artifacts = { ...cycle.artifacts, ...outcome.value.artifacts };

      if (outcome.value.kind === "await") {
        cycle = {
          ...cycle,
          status: "awaiting_approval",
          nextStep: step,
          artifacts,
          pendingDecisionId: outcome.value.decisionId,
          updatedAt: clock.nowIso(),
          failure: undefined,
        };
        await store.cycles.put(cycle);
        logger.info("waiting for a decision", { decision: outcome.value.decisionId, gate: step });
        return ok(cycle);
      }

      const nextStep = outcome.value.kind === "finish" ? undefined : stepAfter(step);
      cycle = {
        ...cycle,
        status: outcome.value.kind === "finish" || nextStep === undefined ? "completed" : "running",
        ...(nextStep ? { nextStep } : { nextStep: undefined }),
        completed: [...cycle.completed, record],
        artifacts,
        pendingDecisionId: undefined,
        updatedAt: clock.nowIso(),
        // Every write that is not a failure clears the last one. Doing it only
        // where a failed cycle resumes was not enough: a cycle that had already
        // resumed carried its old failure through write, inspect and schedule,
        // and the account screen read "実行できませんでした" beside a live step
        // it had long since passed. The cycle record says what is true now; the
        // audit log is what remembers.
        failure: undefined,
      };
      await store.cycles.put(cycle);
    }

    if (!cycle.nextStep && cycle.status === "running") {
      cycle = { ...cycle, status: "completed", updatedAt: clock.nowIso() };
      await store.cycles.put(cycle);
    }
    return ok(cycle);
  }

  // -------------------------------------------------------------------------
  // Steps
  // -------------------------------------------------------------------------

  async function runStep(
    venture: Venture,
    cycle: Cycle,
    step: CycleStep,
  ): Promise<Result<StepOutcome, PlatformError>> {
    const store = await stores.for(venture.id);
    const context = (actor: string) => createRoleContext(services, venture, cycle.id, actor);

    switch (step) {
      case "analyze": {
        const result = await analyst.run(await context(analyst.id), {});
        if (!result.ok) return result;
        return ok({
          kind: "advance",
          note: truncate(result.value.summary, 160),
          artifacts: { analyze: result.value },
        });
      }

      case "research": {
        const lookbackHours = Math.max(
          ...config.channels.map((channel) => channel.research.lookbackHours),
          24,
        );
        const result = await researcher.run(await context(researcher.id), {
          sinceMs: clock.now() - lookbackHours * 3_600_000,
        });
        if (!result.ok) return result;
        return ok({
          kind: "advance",
          note: `${result.value.capturedItems.length} collected, ${result.value.candidatePatterns.length} new patterns`,
          artifacts: { research: result.value },
        });
      }

      case "plan": {
        const result = await planner.run(await context(planner.id), {});
        if (!result.ok) return result;
        return ok({
          kind: "advance",
          note: `${result.value.ideas.length} ideas proposed`,
          artifacts: { plan: { ideas: result.value.ideas } },
        });
      }

      case "proposal_approval":
        return gate(venture, cycle, "proposal_approval");

      case "write": {
        const approved = cycle.artifacts.proposal_approval?.approvedIdeaIds ?? [];
        if (approved.length === 0) {
          return ok({ kind: "finish", note: "Nothing was approved - the day ends here.", artifacts: {} });
        }
        const ideas = cycle.artifacts.plan?.ideas ?? [];
        const byId = new Map(ideas.map((idea) => [idea.id, idea]));
        const draftIds: string[] = [];
        const draftFailures: string[] = [];
        for (const ideaId of approved) {
          const idea = byId.get(ideaId) ?? (await store.ideas.get(ideaId));
          if (!idea) continue;
          const result = await writer.run(await context(writer.id), { idea });
          if (!result.ok) {
            // One idea failing should not cost the others their day.
            logger.warn("draft failed", { ideaId, error: result.error.message });
            draftFailures.push(`${idea.title}: ${result.error.message}`);
            continue;
          }
          draftIds.push(result.value.id);
        }
        if (draftIds.length === 0) {
          // The reasons used to stop at the logger, and the operator was told
          // only that everything failed. On Cloudflare there is no terminal to
          // read a log in: the cause existed for a moment and was thrown away,
          // leaving a red cycle and no next move.
          return fail(
            "llm",
            "write.all_failed",
            ["Every approved idea failed to draft.", draftFailures.join(" / ")]
              .filter((part) => part !== "")
              .join(" "),
            { retryable: true, details: { failures: draftFailures } },
          );
        }
        return ok({ kind: "advance", note: `${draftIds.length} drafts written`, artifacts: { write: { draftIds } } });
      }

      case "inspect": {
        const draftIds = cycle.artifacts.write?.draftIds ?? [];
        const reports = [];
        const rejected: string[] = [];
        // Kept apart from `rejected` for the note only. A draft the inspector
        // turned down and a draft it never managed to read are the same
        // outcome for publishing and opposite ones for the operator: one says
        // the writing broke a rule, the other says the inspection did not
        // happen. Reporting the second as the first sends them to rewrite copy
        // that was never read.
        const uninspected: string[] = [];
        for (const draftId of draftIds) {
          const draft = await store.drafts.get(draftId);
          if (!draft) continue;
          const result = await inspector.run(await context(inspector.id), { draft });
          if (!result.ok) {
            logger.warn("inspection failed", { draftId, error: result.error.message });
            rejected.push(draftId);
            uninspected.push(`${draftId}: ${result.error.message}`);
            continue;
          }
          reports.push(result.value);
          if (!result.value.passed) rejected.push(draftId);
        }
        const passed = reports.filter((report) => report.passed).length;
        if (passed === 0) {
          return ok({
            kind: "finish",
            note:
              uninspected.length > 0
                ? `Nothing publishes today. ${rejected.length - uninspected.length} blocked at inspection, ` +
                  `${uninspected.length} could not be inspected — ${uninspected.join(" / ")}`
                : `Every draft was blocked at inspection (${rejected.length}). Nothing publishes today.`,
            artifacts: { inspect: { reports, rejectedDraftIds: rejected } },
          });
        }
        return ok({
          kind: "advance",
          note: `${passed} of ${reports.length} drafts cleared inspection`,
          artifacts: { inspect: { reports, rejectedDraftIds: rejected } },
        });
      }

      case "schedule": {
        const rejected = new Set(cycle.artifacts.inspect?.rejectedDraftIds ?? []);
        const drafts: Draft[] = [];
        for (const draftId of cycle.artifacts.write?.draftIds ?? []) {
          if (rejected.has(draftId)) continue;
          const draft = await store.drafts.get(draftId);
          if (draft) drafts.push(draft);
        }
        const result = await publisher.run(await context(publisher.id), { drafts });
        if (!result.ok) return result;
        return ok({
          kind: "advance",
          note: `${result.value.posts.length} posts queued`,
          artifacts: { schedule: { postIds: result.value.posts.map((post) => post.id) } },
        });
      }

      case "publish_approval":
        return gate(venture, cycle, "publish_approval");

      case "dispatch": {
        const approvedPostIds = cycle.artifacts.publish_approval?.approvedPostIds ?? [];
        if (approvedPostIds.length === 0) {
          return ok({ kind: "finish", note: "No posts were approved for publishing.", artifacts: {} });
        }
        const dispatched: string[] = [];
        const failed: string[] = [];
        for (const postId of approvedPostIds) {
          const post = await store.posts.get(postId);
          if (!post) continue;
          const result = await handOff(post);
          if (result.ok) dispatched.push(postId);
          else failed.push(postId);
        }
        return ok({
          kind: "finish",
          note: `${dispatched.length} handed off${failed.length > 0 ? `, ${failed.length} failed` : ""}`,
          artifacts: { dispatch: { dispatchedPostIds: dispatched, failedPostIds: failed } },
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Gates
  // -------------------------------------------------------------------------

  async function gate(
    venture: Venture,
    cycle: Cycle,
    which: "proposal_approval" | "publish_approval",
  ): Promise<Result<StepOutcome, PlatformError>> {
    const store = await stores.for(venture.id);
    const existingId = cycle.pendingDecisionId;
    const existing = existingId ? await store.decisions.get(existingId) : undefined;

    if (existing && existing.gate === which) {
      if (existing.status === "pending") {
        return ok({ kind: "await", decisionId: existing.id, note: "waiting for a decision", artifacts: {} });
      }
      return consume(which, existing, cycle);
    }

    const built =
      which === "proposal_approval"
        ? await buildProposalDecision(venture, cycle)
        : await buildPublishDecision(venture, cycle);
    if (!built.ok) return built;

    let decision = built.value;
    if (decision.items.length === 0) {
      return ok({
        kind: "finish",
        note: which === "proposal_approval" ? "No ideas to approve." : "No posts to approve.",
        artifacts: {},
      });
    }

    if (!requiresHuman(config.company.autonomy)) {
      const resolved = autoResolve(decision, clock.nowIso());
      if (!resolved.ok) return resolved;
      decision = resolved.value;
      await store.decisions.put(decision);
      await recordEvent({
        id: services.ids.next("evt"),
        at: clock.nowIso(),
        ventureId: venture.id,
        cycleId: cycle.id,
        type: "decision.auto_resolved",
        actor: "orchestrator",
        summary: `${which} resolved automatically (${decision.resolution?.selectedIds.length ?? 0} selected).`,
        data: { decisionId: decision.id },
      });
      return consume(which, decision, cycle);
    }

    await store.decisions.put(decision);
    await recordEvent({
      id: services.ids.next("evt"),
      at: clock.nowIso(),
      ventureId: venture.id,
      cycleId: cycle.id,
      type: "decision.opened",
      actor: "orchestrator",
      summary: `${which}: ${decision.items.length} items need a decision.`,
      data: { decisionId: decision.id, gate: which, items: decision.items.length },
    });
    return ok({ kind: "await", decisionId: decision.id, note: `${decision.items.length} items awaiting approval`, artifacts: {} });
  }

  /** Turns a resolved decision into the artifacts the next step reads. */
  async function consume(
    which: "proposal_approval" | "publish_approval",
    decision: Decision,
    cycle: Cycle,
  ): Promise<Result<StepOutcome, PlatformError>> {
    const store = await stores.for(decision.ventureId);
    const byItemId = new Map(decision.items.map((item) => [item.id, item]));
    const ordered = (decision.resolution?.ordering ?? [])
      .map((itemId) => byItemId.get(itemId)?.refId)
      .filter((refId): refId is string => refId !== undefined);

    if (which === "proposal_approval") {
      if (ordered.length === 0) {
        return ok({
          kind: "finish",
          note: "Every proposal was rejected.",
          artifacts: { proposal_approval: { decisionId: decision.id, approvedIdeaIds: [] } },
        });
      }
      return ok({
        kind: "advance",
        note: `${ordered.length} ideas approved`,
        artifacts: { proposal_approval: { decisionId: decision.id, approvedIdeaIds: ordered } },
      });
    }

    // Publishing: the person's ordering is the running order, and anything
    // they did not pick is cancelled rather than left to leak out tomorrow.
    const allPostIds = cycle.artifacts.schedule?.postIds ?? [];
    const approvedSet = new Set(ordered);
    for (const [index, postId] of ordered.entries()) {
      const post = await store.posts.get(postId);
      if (!post) continue;
      await store.posts.put({ ...post, status: "approved", order: index + 1 });
    }
    for (const postId of allPostIds) {
      if (approvedSet.has(postId)) continue;
      const post = await store.posts.get(postId);
      if (post && post.status === "queued") await store.posts.put({ ...post, status: "cancelled" });
    }

    if (ordered.length === 0) {
      return ok({
        kind: "finish",
        note: "Nothing was approved for publishing.",
        artifacts: { publish_approval: { decisionId: decision.id, approvedPostIds: [] } },
      });
    }
    return ok({
      kind: "advance",
      note: `${ordered.length} posts approved`,
      artifacts: { publish_approval: { decisionId: decision.id, approvedPostIds: ordered } },
    });
  }

  async function buildProposalDecision(venture: Venture, cycle: Cycle): Promise<Result<Decision, PlatformError>> {
    const store = await stores.for(venture.id);
    const ideas: readonly Idea[] = cycle.artifacts.plan?.ideas ?? [];
    const capacity = Math.min(venture.cadence.postsPerDay, config.policy.maxPostsPerDay);
    const items: DecisionItem[] = ideas.map((idea) => ({
      id: `di_${idea.id}`,
      refId: idea.id,
      title: `#${idea.rank} ${idea.title}`,
      summary: idea.angle,
      // The platform recommends the planner's own top picks, up to capacity.
      recommended: idea.rank <= capacity,
      detail: {
        angle: idea.angle,
        targetPain: idea.targetPain,
        promisedOutcome: idea.promisedOutcome,
        rationale: idea.rationale,
        risk: idea.risk,
        expectedEngagement: idea.expectedEngagement,
        patternId: idea.patternId ?? null,
        offerId: idea.offerId ?? null,
      },
    }));

    return ok(
      createDecision({
        id: services.ids.next("dec"),
        cycleId: cycle.id,
        ventureId: venture.id,
        gate: "proposal_approval",
        items,
        min: 0,
        max: capacity,
        nowIso: clock.nowIso(),
      }),
    );
  }

  async function buildPublishDecision(venture: Venture, cycle: Cycle): Promise<Result<Decision, PlatformError>> {
    const store = await stores.for(venture.id);
    const postIds = cycle.artifacts.schedule?.postIds ?? [];
    const items: DecisionItem[] = [];
    for (const postId of postIds) {
      const post = await store.posts.get(postId);
      if (!post) continue;
      const report = await store.inspections.get(post.draftId);
      items.push({
        id: `di_${post.id}`,
        refId: post.id,
        title: truncate(post.content.hook, 80),
        summary: `${new Date(post.scheduledFor).toISOString()} — ${post.slotReason}`,
        // Everything that cleared inspection is recommended; the human's job
        // here is ordering, not re-litigating quality.
        recommended: true,
        detail: {
          scheduledFor: new Date(post.scheduledFor).toISOString(),
          slotReason: post.slotReason,
          channel: post.channel,
          hook: post.content.hook,
          body: post.content.body,
          cta: post.content.cta,
          disclosure: post.content.disclosure,
          threadParts: post.content.threadParts ?? null,
          hashtags: post.content.hashtags,
          offerId: post.offerId ?? null,
          patternId: post.patternId ?? null,
          comments: post.commentDrafts,
          aiSmellScore: report?.aiSmellScore ?? null,
          findings: report?.findings.filter((finding) => finding.severity !== "note") ?? [],
        },
      });
    }
    return ok(
      createDecision({
        id: services.ids.next("dec"),
        cycleId: cycle.id,
        ventureId: venture.id,
        gate: "publish_approval",
        items,
        min: 0,
        max: Math.min(items.length, config.policy.maxPostsPerDay),
        nowIso: clock.nowIso(),
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Publishing
  // -------------------------------------------------------------------------

  /**
   * Hands a post to its channel. Channels with native scheduling take the slot
   * and hold it; the rest stay `approved` until the daemon's clock catches up.
   */
  async function handOff(post: ScheduledPost): Promise<Result<ScheduledPost, PlatformError>> {
    const store = await stores.for(post.ventureId);
    const channel = services.channels.get(post.channel);
    if (!channel.ok) {
      await store.posts.put({ ...post, status: "failed", failureReason: channel.error.message });
      return channel;
    }
    // Decided here and not in the channel. A channel that cannot publish says
    // only that; what a post then becomes is the orchestrator's to choose, the
    // same way it chooses between holding a slot and handing it to a scheduler.
    if (!channel.value.capabilities.publishesItself) {
      if (post.scheduledFor > clock.now()) return ok(post);
      return handOverToPerson(post);
    }
    if (!channel.value.capabilities.nativeScheduling) {
      if (post.scheduledFor > clock.now()) return ok(post);
      return publishNow(post);
    }
    const result = await channel.value.publish({
      ventureId: post.ventureId,
      postId: post.id,
      content: post.content,
      scheduledFor: post.scheduledFor,
    });
    if (!result.ok) {
      await store.posts.put({ ...post, status: "failed", failureReason: result.error.message });
      return result;
    }
    const updated: ScheduledPost = {
      ...post,
      status: result.value.scheduled ? "scheduled" : "published",
      externalId: result.value.externalId,
      ...(result.value.url ? { externalUrl: result.value.url } : {}),
      ...(result.value.publishedAt ? { publishedAt: result.value.publishedAt } : {}),
    };
    await store.posts.put(updated);
    if (!result.value.scheduled) await postComments(updated);
    return ok(updated);
  }

  /**
   * Composes the post and leaves it waiting for a person.
   *
   * Everything the publishing path does except the part that would be a lie:
   * the text is composed by the channel, persisted on the post, and recorded in
   * the audit trail. What it is not is `published` - the operating promise is
   * that a person can audit why a post was proposed, and a post marked live
   * that nobody put anywhere would make every number downstream of it false.
   */
  async function handOverToPerson(post: ScheduledPost): Promise<Result<ScheduledPost, PlatformError>> {
    const store = await stores.for(post.ventureId);
    const channel = services.channels.get(post.channel);
    if (!channel.ok) return channel;

    // Fail closed. A channel that says it cannot publish and offers no way to
    // compose leaves nothing to hand anyone, and a post sitting silently in
    // `approved` forever is the failure nobody discovers.
    const compose = channel.value.compose?.bind(channel.value);
    if (!compose) {
      const reason =
        `Channel "${post.channel}" (adapter "${channel.value.adapter}") says it cannot publish by itself, ` +
        `but does not compose the text either, so there is nothing to hand you. Give the adapter a ` +
        `\`compose\`, or set the channel to an adapter that publishes.`;
      await store.posts.put({ ...post, status: "failed", failureReason: reason });
      return fail("config", "channel.cannot_compose", reason, { retryable: false });
    }

    const parts = compose(post.content);
    const handed: ScheduledPost = {
      ...post,
      status: "handed_over",
      handOverParts: parts,
      handedOverAt: clock.nowIso(),
    };
    await store.posts.put(handed);

    await recordEvent({
      id: services.ids.next("evt"),
      at: clock.nowIso(),
      ventureId: post.ventureId,
      cycleId: post.cycleId,
      type: "post.handed_over",
      actor: "orchestrator",
      summary: truncate(post.content.hook, 120),
      data: { postId: post.id, channel: post.channel, parts: parts.length },
    });
    return ok(handed);
  }

  async function publishNow(post: ScheduledPost): Promise<Result<ScheduledPost, PlatformError>> {
    const store = await stores.for(post.ventureId);
    const channel = services.channels.get(post.channel);
    if (!channel.ok) return channel;

    const result = await channel.value.publish({
      ventureId: post.ventureId,
      postId: post.id,
      content: post.content,
    });
    if (!result.ok) {
      // A rate limit or a 503 is the channel being busy, not this post being
      // wrong. Marking it `failed` retired it permanently - `dispatchDue` only
      // looks at `approved` and `scheduled`, and nothing ever moved it back -
      // so one blip silently dropped a post the operator had approved. A
      // retryable failure leaves it approved for the next tick, sixty seconds
      // away; only a refusal that will not change is terminal.
      const terminal = !result.error.retryable;
      if (terminal) {
        await store.posts.put({ ...post, status: "failed", failureReason: result.error.message });
      }
      logger.error(terminal ? "publish failed" : "publish deferred", {
        postId: post.id,
        retryable: result.error.retryable,
        error: describeError(result.error),
      });
      await recordEvent({
        id: services.ids.next("evt"),
        at: clock.nowIso(),
        ventureId: post.ventureId,
        cycleId: post.cycleId,
        type: terminal ? "post.failed" : "post.deferred",
        actor: "orchestrator",
        summary: truncate(result.error.message, 120),
        data: { postId: post.id, code: result.error.code, retryable: result.error.retryable },
      });
      return result;
    }

    const published: ScheduledPost = {
      ...post,
      status: "published",
      externalId: result.value.externalId,
      ...(result.value.url ? { externalUrl: result.value.url } : {}),
      publishedAt: result.value.publishedAt ?? clock.nowIso(),
    };
    await store.posts.put(published);
    await postComments(published);

    await recordEvent({
      id: services.ids.next("evt"),
      at: clock.nowIso(),
      ventureId: post.ventureId,
      cycleId: post.cycleId,
      type: "post.published",
      actor: "orchestrator",
      summary: truncate(post.content.hook, 120),
      data: { postId: post.id, externalId: published.externalId, url: published.externalUrl ?? null },
    });
    return ok(published);
  }

  /** Posts the prepared comments under a live post. Failures are not fatal. */
  async function postComments(post: ScheduledPost): Promise<void> {
    const store = await stores.for(post.ventureId);
    if (!post.externalId || post.commentDrafts.length === 0) return;
    const channel = services.channels.get(post.channel);
    if (!channel.ok || !channel.value.capabilities.comments) return;

    for (const comment of post.commentDrafts) {
      const result = await channel.value.comment({
        parentExternalId: post.externalId,
        text: comment.text,
      });
      if (!result.ok) {
        logger.warn("comment failed", { postId: post.id, purpose: comment.purpose, error: result.error.message });
        // A log line is not enough for the link drop. That comment is the only
        // place the affiliate URL exists, so losing it leaves a live post that
        // can never earn anything and no record saying why. Everything else is
        // a nice-to-have and stays a warning.
        if (comment.purpose === "link_drop") {
          await recordEvent({
            id: services.ids.next("evt"),
            at: clock.nowIso(),
            ventureId: post.ventureId,
            cycleId: post.cycleId,
            type: "post.link_drop_failed",
            actor: "orchestrator",
            summary: `The link never reached the post: ${truncate(result.error.message, 90)}`,
            data: { postId: post.id, externalId: post.externalId ?? null, code: result.error.code },
          });
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Public surface
  /**
   * The account holding a decision, and its store.
   *
   * One of the few reads that legitimately starts without an account: an
   * approval arrives as an id and nothing else. Decisions are few and short
   * lived, so a walk is the honest implementation - and it stops at the first
   * account that has it.
   */
  async function findDecision(
    decisionId: string,
  ): Promise<{ decision: Decision; store: Awaited<ReturnType<typeof stores.for>> } | undefined> {
    for (const scope of await stores.each()) {
      const decision = await scope.store.decisions.get(decisionId);
      if (decision) return { decision, store: scope.store };
    }
    return undefined;
  }

  // -------------------------------------------------------------------------

  return {
    runCycle,

    async resolveGate(decisionId, request) {
      // A decision id arrives from a screen with no account attached to it, so
      // finding it is a crossing - a named one. Everything after is that one
      // account's: the decision says which, and nothing else is opened.
      const found = await findDecision(decisionId);
      if (!found) {
        return fail("not_found", "decision.not_found", `No decision "${decisionId}".`);
      }
      const { decision, store } = found;

      // Whether the day has gone is decided here, not only by the sweep that
      // marks gates expired.
      //
      // That sweep runs hourly, so between midnight and the next tick an old
      // gate is still `pending` - and approving it then writes the day's posts
      // onto slots that have all passed, which the dispatcher publishes at
      // once. A guard that only runs on a schedule is not a guard during the
      // hour it has not run. Same reason the policy checks run after the
      // rewrite and not only before it.
      const gateVenture = ventureById.get(decision.ventureId);
      const gateCycle = await store.cycles.get(decision.cycleId);
      if (gateVenture && gateCycle && gateCycle.date < localDate(clock.now(), gateVenture.timezone)) {
        // Left true rather than merely refused: the answer and the stored state
        // have to agree, or the console keeps offering a gate the code will
        // never accept.
        if (decision.status === "pending") await store.decisions.put({ ...decision, status: "expired" });
        return fail(
          "conflict",
          "decision.expired",
          `Decision ${decision.id} was for ${gateCycle.date}, which has passed, so it closed unanswered. ` +
            `Today's cycle is the one to approve; nothing from that day will be published.`,
          { retryable: false, details: { day: gateCycle.date } },
        );
      }

      const resolved = resolveDecision(decision, request);
      if (!resolved.ok) return resolved;
      await store.decisions.put(resolved.value);

      await recordEvent({
        id: services.ids.next("evt"),
        at: clock.nowIso(),
        ventureId: decision.ventureId,
        cycleId: decision.cycleId,
        type: "decision.resolved",
        actor: request.decidedBy,
        summary: `${decision.gate}: ${resolved.value.resolution?.selectedIds.length ?? 0} of ${decision.items.length} approved.`,
        data: {
          decisionId,
          gate: decision.gate,
          selected: resolved.value.resolution?.selectedIds ?? [],
          ordering: resolved.value.resolution?.ordering ?? [],
        },
      });

      const cycle = await store.cycles.get(decision.cycleId);
      if (!cycle) return fail("not_found", "cycle.not_found", `Decision ${decisionId} points at a missing cycle.`);
      const venture = ventureById.get(cycle.ventureId);
      if (!venture) return fail("config", "cycle.unknown_venture", `Cycle ${cycle.id} belongs to an unknown venture.`);

      return advanceOnce(venture, { ...cycle, status: "running" }, {});
    },

    async dispatchDue(nowMs, options) {
      const published: string[] = [];
      const handedOver: string[] = [];
      const failed: { postId: string; reason: string }[] = [];
      const stopped = new Set(options?.skipVentures ?? []);
      let held = 0;
      let commentsWithheld = 0;

      // The dispatcher's whole job is "whatever is due, whoever it belongs to",
      // so this crossing is the feature. Each post is then handled through its
      // own account's store.
      const scopes = await stores.each();
      const postsWhere = async (
        matches: (post: ScheduledPost) => boolean,
      ): Promise<ScheduledPost[]> => {
        const found: ScheduledPost[] = [];
        for (const scope of scopes) found.push(...(await scope.store.posts.find(matches)));
        return found;
      };

      // Posts we hold ourselves, because the channel cannot schedule.
      const due = await postsWhere((post) => post.status === "approved" && post.scheduledFor <= nowMs);
      for (const post of due) {
        if (stopped.has(post.ventureId)) {
          held += 1;
          continue;
        }
        // A channel that hands its posts to a person is asked here too, and
        // the answer decides which list this post lands in. `publishNow` is
        // never called for one: it would report a publication that did not
        // happen, which is the whole thing this branch exists to prevent.
        const channel = services.channels.get(post.channel);
        const byHand = channel.ok && !channel.value.capabilities.publishesItself;
        const result = byHand ? await handOverToPerson(post) : await publishNow(post);
        if (!result.ok) failed.push({ postId: post.id, reason: result.error.message });
        else if (byHand) handedOver.push(post.id);
        else published.push(post.id);
      }

      // Posts the channel is holding. Their slot passing is the only signal we
      // get that they went live, and without promoting them here they would
      // sit as "scheduled" forever - never measured, never learned from.
      //
      // A stop deliberately does NOT skip these. The channel published them on
      // its own schedule whether or not this platform is running; refusing to
      // record that would leave the operator with a stopped machine and a live
      // post it does not know about. `amp pause` says how many are beyond
      // recall, because cancelling those means opening the channel itself.
      const landed = await postsWhere((post) => post.status === "scheduled" && post.scheduledFor <= nowMs);
      for (const post of landed) {
        const wentLive: ScheduledPost = {
          ...post,
          status: "published",
          publishedAt: new Date(post.scheduledFor).toISOString(),
        };
        await (await stores.for(post.ventureId)).posts.put(wentLive);
        // The post itself is beyond recall - the channel published it on its
        // own clock. The comments are not: they are writes this platform has
        // not made yet, and one of them carries the affiliate link. A stop that
        // still drops links under a post is not a stop, so recording that the
        // post went live and adding to it are separated here.
        if (stopped.has(post.ventureId)) commentsWithheld += 1;
        else await postComments(wentLive);
        published.push(post.id);
        await recordEvent({
          id: services.ids.next("evt"),
          at: clock.nowIso(),
          ventureId: post.ventureId,
          cycleId: post.cycleId,
          type: "post.published",
          actor: "scheduler",
          summary: truncate(post.content.hook, 120),
          data: { postId: post.id, externalId: post.externalId ?? null, viaChannelScheduler: true },
        });
      }

      const waiting = await postsWhere(
        (post) => (post.status === "approved" || post.status === "scheduled") && post.scheduledFor > nowMs,
      );
      return ok({ published, handedOver, failed, stillWaiting: waiting.length, held, commentsWithheld });
    },

    async recordPostedByHand(postId, request) {
      // Same shape as `findDecision`, and for the same reason: a press on a
      // screen arrives as an id with no account attached to it.
      let found: { post: ScheduledPost; store: Awaited<ReturnType<typeof stores.for>> } | undefined;
      for (const scope of await stores.each()) {
        const post = await scope.store.posts.get(postId);
        if (post) {
          found = { post, store: scope.store };
          break;
        }
      }
      if (!found) return fail("not_found", "post.not_found", `No post "${postId}".`);
      const { post, store } = found;

      if (post.status !== "handed_over") {
        return fail(
          "conflict",
          "post.not_handed_over",
          `Post ${post.id} is "${post.status}", not a post waiting for you to publish it, so there is ` +
            `nothing to record. Only a post this platform handed you can be marked as posted.`,
          { retryable: false, details: { status: post.status } },
        );
      }

      const published: ScheduledPost = {
        ...post,
        status: "published",
        // When they pressed it. The slot is when it should have gone out, and
        // using that would date every hand-posted piece of work to a moment
        // nobody was at their phone.
        publishedAt: request.nowIso,
        postedBy: request.by,
        ...(request.url ? { externalUrl: request.url } : {}),
      };
      await store.posts.put(published);

      await recordEvent({
        id: services.ids.next("evt"),
        at: request.nowIso,
        ventureId: post.ventureId,
        cycleId: post.cycleId,
        type: "post.published",
        actor: request.by,
        summary: truncate(post.content.hook, 120),
        data: { postId: post.id, url: published.externalUrl ?? null, byHand: true },
      });
      return ok(published);
    },

    async expireStaleGates() {
      const expired: DecisionId[] = [];
      // Every account: the dispatcher's neighbour, and for the same reason -
      // whose gate it is does not change whether the day is over.
      for (const scope of await stores.each()) {
        const venture = ventureById.get(scope.ventureId);
        // COMPANY_SCOPE holds the scout's own records and has no timezone of
        // its own; it also has no cycles, so there is no gate to expire.
        if (!venture) continue;
        const today = localDate(clock.now(), venture.timezone);

        for (const decision of await scope.store.decisions.find((entry) => entry.status === "pending")) {
          const cycle = await scope.store.cycles.get(decision.cycleId);
          // A gate without its cycle cannot be dated, and guessing the date
          // from the id is what this deliberately does not do.
          if (!cycle || cycle.date >= today) continue;

          await scope.store.decisions.put({ ...decision, status: "expired" });
          // The cycle stops waiting for an answer that is no longer possible.
          // `pendingDecisionId` is dropped so nothing goes looking for a gate
          // that will not open.
          const { pendingDecisionId: _dropped, ...rest } = cycle;
          await scope.store.cycles.put({
            ...rest,
            status: "cancelled",
            updatedAt: clock.nowIso(),
          });

          // Loudly, in the record. A day that vanished quietly is the same
          // problem as a day that piled up quietly: nobody finds out that the
          // thirty seconds a day the product promises have stopped happening.
          await recordEvent({
            id: services.ids.next("evt"),
            at: clock.nowIso(),
            ventureId: decision.ventureId,
            cycleId: decision.cycleId,
            type: "decision.expired",
            actor: "scheduler",
            // English, like every other stored summary: the record is durable
            // and the screen's language is a setting. The console says this one
            // in the operator's language from `activityText`, because it is a
            // line they have to act on.
            summary: `The gate for ${cycle.date} lapsed unanswered`,
            data: { decisionId: decision.id, gate: decision.gate, day: cycle.date, items: decision.items.length },
          });
          expired.push(decision.id);
        }
      }
      return ok({ expired });
    },

    async pendingDecisions(ventureId) {
      // The console's "what needs you today" is the whole company's, so this
      // crosses on purpose. Asked for one account, it opens only that one.
      const scopes = ventureId
        ? [{ ventureId, store: await stores.for(ventureId) }]
        : await stores.each();
      const decisions: Decision[] = [];
      for (const scope of scopes) {
        decisions.push(...(await scope.store.decisions.find((decision) => decision.status === "pending")));
      }
      return decisions.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },
  };
}

export function stepAfter(step: CycleStep): CycleStep | undefined {
  const index = STEP_ORDER.indexOf(step);
  return index === -1 ? undefined : STEP_ORDER[index + 1];
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? `${cause.message}\n${cause.stack ?? ""}` : String(cause);
}
