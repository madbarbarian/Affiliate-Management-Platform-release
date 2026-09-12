/**
 * One day, read back: what each role did, in order, and what it decided.
 *
 * The operating promise is that a person can audit why a post was proposed.
 * Everything needed for that has been persisted since the beginning - the step
 * records carry their own timings, and `cycle.artifacts` carries every role's
 * output - but until now nothing rendered it, so the answer existed only in the
 * database. This turns one cycle into lines a person can read.
 *
 * **It is not on the daily path, and must not become so.** The product promises
 * two decisions a day at thirty seconds each, and a screen the operator has to
 * look at every morning to feel informed is how that promise is lost. This
 * answers a question that only comes up when something looks wrong: *why did it
 * propose that?* So it hangs off a date in the account's history, and the day's
 * own screen is unchanged.
 *
 * Pure: a cycle and the records it points at, in - a serialisable structure out.
 * Nothing here reads a store or a clock.
 */

import { CYCLE_STEPS } from "../core/types.ts";
import type {
  Cycle,
  CycleStep,
  Decision,
  Draft,
  Idea,
  InspectionReport,
  ScheduledPost,
} from "../core/types.ts";

/** What one role produced, in the words of someone reading it later. */
export type TimelineEntry = {
  readonly step: CycleStep;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  /** The role's own one-line note, recorded when it ran. */
  readonly note: string;
  /**
   * What came out, as lines. Empty when the step records nothing beyond its
   * note - which is honest, and better than inventing a sentence per step.
   */
  readonly said: readonly string[];
  /** The ideas, drafts or posts this step produced, when it produced any. */
  readonly items?: readonly TimelineItem[];
  /** True where a person decided rather than a role. The two gates. */
  readonly byHuman?: boolean;
};

export type TimelineItem = {
  readonly title: string;
  /** Why this exists - a rationale, a finding, a slot. */
  readonly detail?: string;
  /** Chosen by the operator, where the step was a gate. */
  readonly chosen?: boolean;
  /** Refused by the guardrails, where the step was the inspection. */
  readonly blocked?: boolean;
};

export type Timeline = {
  readonly cycleId: string;
  readonly date: string;
  readonly status: string;
  readonly entries: readonly TimelineEntry[];
  /** Present when the day ended on an error. */
  readonly failure?: { readonly step: CycleStep; readonly message: string; readonly code: string };
  /** The step it stopped before, when it has not finished. */
  readonly nextStep?: CycleStep;
};

export type TimelineSources = {
  readonly cycle: Cycle;
  readonly ideas: readonly Idea[];
  readonly drafts: readonly Draft[];
  readonly inspections: readonly InspectionReport[];
  readonly posts: readonly ScheduledPost[];
  readonly decisions: readonly Decision[];
};

export function buildTimeline(sources: TimelineSources): Timeline {
  const { cycle } = sources;
  return {
    cycleId: cycle.id,
    date: cycle.date,
    status: cycle.status,
    // Ordered by when they ran rather than by the canonical step order: a
    // resumed day runs its remaining steps later, and a reader trying to work
    // out what happened wants the order it happened in.
    entries: [...cycle.completed]
      // By when, then by the canonical order. Two steps can share a timestamp -
      // a fixed clock in a test, or simply a fast step - and a comparator that
      // never returns 0 hands those to the engine's tie-breaking rather than
      // deciding them.
      .sort((a, b) =>
        a.startedAt === b.startedAt
          ? CYCLE_STEPS.indexOf(a.step) - CYCLE_STEPS.indexOf(b.step)
          : a.startedAt < b.startedAt ? -1 : 1)
      .map((record) => ({
        step: record.step,
        startedAt: record.startedAt,
        finishedAt: record.finishedAt,
        durationMs: record.durationMs,
        note: record.note,
        ...describe(record.step, sources),
      })),
    ...(cycle.failure ? { failure: cycle.failure } : {}),
    ...(cycle.nextStep ? { nextStep: cycle.nextStep } : {}),
  };
}

function describe(
  step: CycleStep,
  sources: TimelineSources,
): { said: readonly string[]; items?: readonly TimelineItem[]; byHuman?: boolean } {
  const { cycle } = sources;
  const artifacts = cycle.artifacts;

  switch (step) {
    case "analyze": {
      const report = artifacts.analyze;
      if (!report) return { said: [] };
      const said = [
        `投稿 ${report.examinedPosts} 件を読み、エンゲージメントの中央値は ${report.medianEngagement}`,
        `クリック ${report.revenue.clicks}、成果 ${report.revenue.conversions}`,
      ];
      // Money is never summed across currencies. One line each, or the reader
      // is looking at a number that means nothing.
      for (const entry of report.revenue.approved) {
        said.push(`確定した報酬 ${entry.amount} ${entry.currency}`);
      }
      // Going up means the chain is leaking, and it is the kind of thing nobody
      // notices until a month of revenue is missing.
      if (report.revenue.unattributed > 0) {
        said.push(`どの投稿のものか分からない成果が ${report.revenue.unattributed} 件`);
      }
      if (report.promoted.length > 0) said.push(`型を ${report.promoted.length} 件、実績ありに格上げ`);
      if (report.retired.length > 0) said.push(`型を ${report.retired.length} 件、引退`);
      if (report.summary) said.push(report.summary);
      return { said };
    }

    case "research": {
      const report = artifacts.research;
      if (!report) return { said: [] };
      return {
        said: [
          `参考になる投稿を ${report.capturedItems.length} 件集め、${report.discardedCount} 件は捨てた`,
          `再現できそうな型を ${report.candidatePatterns.length} 件`,
          ...(report.summary ? [report.summary] : []),
        ],
        items: report.candidatePatterns.map((pattern) => ({
          title: pattern.name,
          ...(pattern.whyItWorks ? { detail: pattern.whyItWorks } : {}),
        })),
      };
    }

    case "plan": {
      const ideas = sources.ideas;
      if (ideas.length === 0) return { said: [] };
      // The answer to "why did it propose that". Every idea carries the past
      // data point it was argued from, and that is the whole reason this screen
      // exists - so it is shown, not folded away.
      return {
        said: [`案を ${ideas.length} 件`],
        items: [...ideas]
          .sort((a, b) => a.rank - b.rank)
          .map((idea) => ({
            title: `${idea.rank}. ${idea.title}`,
            detail: [idea.angle, idea.rationale && `根拠: ${idea.rationale}`, idea.risk && `失敗の仕方: ${idea.risk}`]
              .filter(Boolean)
              .join(" / "),
          })),
      };
    }

    case "proposal_approval":
      return gate(artifacts.proposal_approval?.decisionId, sources);

    case "write": {
      const drafts = sources.drafts;
      if (drafts.length === 0) return { said: [] };
      return {
        said: [`${drafts.length} 件を書いた`],
        items: drafts.map((draft) => ({ title: draft.content.hook })),
      };
    }

    case "inspect": {
      const reports = sources.inspections;
      const rejected = artifacts.inspect?.rejectedDraftIds ?? [];
      if (reports.length === 0) return { said: [] };
      const worst = Math.max(...reports.map((report) => report.aiSmellScore));
      return {
        said: [
          `${reports.length} 件を検品`,
          `AIっぽさの最大値は ${worst}`,
          ...(rejected.length > 0 ? [`${rejected.length} 件は出さないと判断`] : ["全部通った"]),
        ],
        items: reports.map((report) => ({
          title: `AIっぽさ ${report.aiSmellScore}`,
          ...(report.findings.length > 0
            ? { detail: report.findings.map((finding) => finding.message).join(" / ") }
            : {}),
          blocked: rejected.includes(report.draftId) || !report.passed,
        })),
      };
    }

    case "schedule": {
      const posts = sources.posts;
      if (posts.length === 0) return { said: [] };
      return {
        said: [`${posts.length} 件の枠を決めた`],
        items: posts.map((post) => ({
          title: new Date(post.scheduledFor).toISOString(),
          detail: post.content.hook,
        })),
      };
    }

    case "publish_approval":
      return gate(artifacts.publish_approval?.decisionId, sources);

    case "dispatch": {
      const result = artifacts.dispatch;
      if (!result) return { said: [] };
      return {
        said: [
          `${result.dispatchedPostIds.length} 件を公開`,
          ...(result.failedPostIds.length > 0 ? [`${result.failedPostIds.length} 件は失敗`] : []),
        ],
      };
    }

    default:
      return { said: [] };
  }
}

/**
 * A gate, read back: what was put in front of the person, and what they picked.
 *
 * Shown as the whole list with the chosen ones marked, rather than only the
 * chosen ones - "what was rejected" is as much a part of why the day looks the
 * way it does, and a list of two approved posts hides that eight were offered.
 */
function gate(
  decisionId: string | undefined,
  sources: TimelineSources,
): { said: readonly string[]; items?: readonly TimelineItem[]; byHuman: boolean } {
  const decision = sources.decisions.find((entry) => entry.id === decisionId);
  if (!decision) return { said: [], byHuman: false };

  // Built from the decision's own items rather than re-derived from the ideas
  // or posts they point at. That record *is* what was put in front of the
  // person - it carries the title and summary they actually read - and
  // `selectedIds` are its item ids, not the ids of the records behind them.
  // Under `autonomy: auto` the machine resolves both gates. Marking those as a
  // person's decision is the one lie this screen must not tell: it is the
  // record of who decided, and an operator reading it back would see their own
  // name implied on a day they never opened.
  const byHuman = !decision.autoResolved;
  const approved = decision.resolution?.selectedIds ?? [];
  const all: TimelineItem[] = decision.items.map((item) => ({
    title: item.title,
    ...(item.summary ? { detail: item.summary } : {}),
    chosen: approved.includes(item.id),
  }));
  const who = !byHuman ? "自動で " : decision.resolution?.decidedBy ? `${decision.resolution.decidedBy} が` : "";
  const said =
    decision.status === "expired"
      ? ["誰も答えないまま日付が変わり、この日は取り消された"]
      : [`${who}${all.length} 件のうち ${approved.length} 件を選んだ`];
  return { said, items: all, byHuman };
}
