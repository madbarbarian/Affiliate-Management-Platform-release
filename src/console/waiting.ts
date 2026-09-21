/**
 * Has the thing the console is waiting for actually happened?
 *
 * Two of the console's actions - running a day, and answering the ideas gate -
 * do minutes of work inside one HTTP request. When that answer never arrives
 * (a Cloudflare edge timeout, a closed laptop, a network that dropped) the work
 * has still been done and persisted; only the reply was lost. The page
 * therefore stops waiting on the response after a deadline and starts watching
 * `/api/state` instead, and this is the judgement it makes on every poll.
 *
 * **It is text, not a function, and that is the point.** It used to be a
 * TypeScript function that `ui.ts` inlined as `waitingIsOver.toString()`, on
 * the theory that what a browser runs is then what the tests run. That holds
 * only while nothing rewrites the code in between - and on Cloudflare
 * something always does. wrangler bundles the Worker with esbuild, which by
 * default wraps named functions in `__name(...)`; `.toString()` handed those
 * calls to a page that has no `__name`, and the judgement threw on its first
 * poll. From v0.7.0 on, run and approve stayed on 動かしています… / 送信中…
 * for good on every Cloudflare deploy, and every test was green, because Node
 * strips types and rewrites nothing.
 *
 * A bundler does not look inside a string. Written as the JavaScript the page
 * runs, the judgement reaches the browser byte for byte under any transform -
 * esbuild's defaults, `--minify`, whatever comes next. The tests evaluate this
 * same text (`test/page-harness.ts`, `waitingJudgementFrom`), so there is still
 * one answer and it is still the tested one. What this costs is tsc: nothing
 * type-checks the text, so the tests do that job - the named cases in
 * `test/console.test.ts`, run in strict mode in a context holding nothing a
 * bundler might have assumed was there, and a check that wrangler's build
 * leaves every page unchanged.
 *
 * Do not patch the page with a no-op `__name` instead. That depends on one
 * esbuild helper's name, and `--minify` already renames it.
 *
 * It answers "no" whenever it cannot tell. Saying "yes" wrongly takes down the
 * line that says the work is still going, which is the exact silence this path
 * exists to end; saying "no" wrongly costs one more poll, and the caller's own
 * bound decides when to stop asking.
 */

/** The parts of `/api/state` this judgement reads. */
export type WaitingSnapshot = {
  readonly pending?: readonly { readonly id: string; readonly ventureId?: string }[];
  readonly portfolio?: {
    readonly rows?: readonly WaitingRow[];
  };
};

export type WaitingRow = {
  readonly ventureId: string;
  readonly lastCycle?: {
    readonly date?: string;
    readonly status?: string;
    readonly nextStep?: string | null;
  };
};

/**
 * The two functions `WAITING_IS_OVER_SOURCE` declares, as the page calls them.
 *
 * A promise about the text below that tsc cannot hold it to - the tests do.
 */
export type WaitingJudgement = {
  readonly waitingIsOver: (
    before: WaitingSnapshot | null | undefined,
    now: WaitingSnapshot | null | undefined,
    ventureId: string,
  ) => boolean;
  readonly waitEndedBecause: (input: {
    readonly answered: boolean;
    readonly before: WaitingSnapshot | null | undefined;
    readonly now: WaitingSnapshot | null | undefined;
    readonly ventureId: string;
  }) => "answered" | "moved" | null;
};

// Plain JavaScript that a browser can run as it stands: no types, no
// backticks, no `${`. It is inlined into the page's module script, so it has to
// be valid there - strict mode included.
export const WAITING_IS_OVER_SOURCE = String.raw`function waitingIsOver(before, now, ventureId) {
  if (!before || !now || !ventureId) return false;

  const gatesOf = (snapshot) =>
    (snapshot.pending || [])
      .filter((decision) => decision.ventureId === ventureId)
      .map((decision) => decision.id);

  // A gate that was not open before is the plainest answer there is: the work
  // finished, and it is asking this operator something new. Scoped to the
  // account on purpose - another account's cycle opening its own gate says
  // nothing about this one, and treating it as an answer would end the wait
  // with a screen that has not changed.
  const openBefore = gatesOf(before);
  if (gatesOf(now).some((id) => openBefore.indexOf(id) < 0)) return true;

  const rowOf = (snapshot) =>
    ((snapshot.portfolio && snapshot.portfolio.rows) || [])
      .find((row) => row.ventureId === ventureId);
  const rowBefore = rowOf(before);
  const rowNow = rowOf(now);
  // The state cannot answer the question, so it is not an answer.
  if (!rowBefore || !rowNow) return false;

  // "running" is the middle of the work, and the middle is persisted one step
  // at a time: a cycle that has moved from write to inspect has not finished
  // anything the operator asked for, and a screen that said so would be lying
  // a second way. Only a cycle that has come to rest - completed, failed,
  // cancelled, or waiting at a gate - ends the wait.
  if (rowNow.lastCycle && rowNow.lastCycle.status === "running") return false;

  // Which day, how far it got, and what is next. All three move as a cycle
  // advances, and a failure moves the status.
  const mark = (row) => {
    const cycle = row.lastCycle;
    return cycle ? [cycle.date, cycle.status, cycle.nextStep || ""].join("|") : "";
  };
  return mark(rowBefore) !== mark(rowNow);
}

// Why the page may stop waiting, or null while it must keep waiting.
//
// Two reasons, and the first is the one that was missing. The request is the
// authority: when the answer finally arrives - late, after the deadline - the
// work is done and there is nothing left to watch for, whatever the comparison
// can or cannot see.
//
// The comparison is the fallback, for an answer that never arrives at all, and
// it needs a before to compare against. Pressing the button on a page that had
// not finished loading left it with nothing: waitingIsOver answered "not yet"
// to every poll and the screen said the work was still running for five
// minutes after it had finished. The owner hit exactly that on the first real
// run - opened an account and pressed.
function waitEndedBecause(input) {
  if (input.answered) return "answered";
  return waitingIsOver(input.before, input.now, input.ventureId) ? "moved" : null;
}`;
