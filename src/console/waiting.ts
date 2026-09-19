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
 * It lives here rather than inside the page's script because that script is an
 * inlined string no test can call. `ui.ts` inlines `WAITING_IS_OVER_SOURCE` -
 * this function, not a second copy of it - so what a browser runs is what the
 * tests run.
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

export function waitingIsOver(
  before: WaitingSnapshot | null | undefined,
  now: WaitingSnapshot | null | undefined,
  ventureId: string,
): boolean {
  if (!before || !now || !ventureId) return false;

  const gatesOf = (snapshot: WaitingSnapshot): string[] =>
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

  const rowOf = (snapshot: WaitingSnapshot): WaitingRow | undefined =>
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
  const mark = (row: WaitingRow): string => {
    const cycle = row.lastCycle;
    return cycle ? [cycle.date, cycle.status, cycle.nextStep || ""].join("|") : "";
  };
  return mark(rowBefore) !== mark(rowNow);
}

/**
 * The function above as source, for the page to inline.
 *
 * Node strips types by blanking them, so what comes back is valid JavaScript.
 * If that ever stopped being true the page would not parse, and the test that
 * parses the page would go red before a licensee saw an inert screen.
 */
/**
 * Why the page may stop waiting, or null while it must keep waiting.
 *
 * Two reasons, and the first is the one that was missing. **The request is the
 * authority**: when the answer finally arrives - late, after the deadline - the
 * work is done and there is nothing left to watch for, whatever the comparison
 * below can or cannot see.
 *
 * The comparison is the fallback, for an answer that never arrives at all, and
 * it needs a `before` to compare against. Pressing the button on a page that
 * had not finished loading left it with nothing: `waitingIsOver` answered "not
 * yet" to every poll and the screen said the work was still running for five
 * minutes after it had finished. The owner hit exactly that on the first real
 * run - opened an account and pressed.
 */
export function waitEndedBecause(input: {
  readonly answered: boolean;
  readonly before: WaitingSnapshot | null | undefined;
  readonly now: WaitingSnapshot | null | undefined;
  readonly ventureId: string;
}): "answered" | "moved" | null {
  if (input.answered) return "answered";
  return waitingIsOver(input.before, input.now, input.ventureId) ? "moved" : null;
}

export const WAITING_IS_OVER_SOURCE = [waitingIsOver.toString(), waitEndedBecause.toString()].join("\n\n");
