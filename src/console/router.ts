/**
 * Every route the console answers, as one function from a `Request` to a
 * `Response`.
 *
 * It is written against the web platform rather than `node:http` for one
 * reason: the same routes have to be servable by a process on a machine and by
 * a handler on a host that has no process. Two implementations would mean a
 * security fix applied to one of them - and the authentication below has
 * already had a hole in it once.
 *
 * `server.ts` adapts a Node request into this; a Worker calls it directly.
 */

import { timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
import { join } from "node:path";

import { localDate, nextLocalTime, parseTimeOfDay } from "../core/clock.ts";
import { composeThreadParts } from "../channels/format.ts";
import { composerUrlOf } from "../channels/manual.ts";
import { readPause } from "../kernel/pause.ts";
import { resumeEverything } from "../kernel/resume.ts";
import { REDIRECT_PATH } from "../affiliate/links.ts";
import { describeError, fail, ok, type PlatformError, type Result } from "../core/result.ts";
import { formatMoney } from "../affiliate/attribution.ts";
import { buildPortfolio } from "../domain/portfolio.ts";
import { findMarket, resolveCompliance } from "../domain/market.ts";
import { appendVentureBlock, listProposals, markAppended, renderVentureBlock, resolveProposal } from "../kernel/exploration.ts";
import { CYCLES_LOCK } from "../scheduler/tick.ts";
import { DECISION_CLOSED_EVENT } from "../kernel/orchestrator.ts";
import { switchVentureOff, switchVentureOn } from "../kernel/venture-switch.ts";
import type { Operator } from "./operators.ts";
import type { Runtime } from "../runtime.ts";
import { buildTimeline, type Timeline } from "./timeline.ts";
import type { Services } from "../kernel/role.ts";
import type { Store, StoreRegistry } from "../storage/store.ts";
import { COMPANY_SCOPE, type VentureId } from "../core/types.ts";
import { renderPage } from "./ui.ts";
import { commentPurposeKey, fill, messagesFor, type Messages } from "./messages.ts";
import { POST_STATUS_KEYS } from "./labels.ts";
import { companyTimezone, createWhen, type When } from "./when.ts";
import { checkForUpdate } from "./updates.ts";
import { isVentureActive, readVentureState } from "../kernel/venture-state.ts";
import { readUnlockSubmission, renderUnlock, UNLOCK_MISMATCH, UNLOCK_PATH } from "./unlock.ts";

export const COOKIE_NAME = "amp_console";
export const MAX_BODY_BYTES = 256 * 1024;

/**
 * The session a valid passphrase buys, written once.
 *
 * Three places hand it out - `/`, `/unlock`, and the Worker's setup page - and
 * a flag that differs between them is a flag nobody would notice missing.
 */
export function sessionCookie(token: string): string {
  // Percent-encoded, because a cookie value is not a place a raw passphrase
  // fits: a `;` in one ends the cookie and starts an attribute, a space ends it
  // outright. Unencoded, the form would take a generated passphrase, say it
  // matched, and hand back a session the browser drops - the same refusal as
  // before, one screen later. `readCookie` undoes it, and a session written
  // before this still reads, because a value with nothing escaped in it decodes
  // to itself.
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`;
}

/**
 * How long a run started from the console holds the lock before it is assumed
 * dead. Shorter than the tick's, because a request has a smaller CPU budget
 * than a cron trigger and a browser gives up long before this.
 */
const RUN_LOCK_TTL_MS = 5 * 60_000;

/**
 * How many posts waiting on a person are carried to the page at once, **per
 * account**. Each one is a whole post's text, on a payload the browser
 * re-fetches every thirty seconds, so this is a size bound and not a policy:
 * the oldest come first, and pressing one brings the next into view.
 *
 * Per account rather than one cap across the company: the account screen and
 * the status strip's badge both read this array, filtered to one venture. A
 * company-wide slice let a busy account's backlog push a quiet account's own
 * hand-over out of the answer entirely - with nothing on that account's own
 * screen, or its badge, to say one was waiting. That is exactly the failure
 * the status strip's badge exists to make impossible (decisions.md,
 * 2026-09-23): a count that can silently under-report.
 */
const HAND_OVER_SHOWN = 20;

/** Same reasoning as `HAND_OVER_SHOWN`, for the upcoming-schedule table. */
const UPCOMING_SHOWN = 12;

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

export async function handleRequest(
  runtime: Runtime,
  operators: readonly Operator[],
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/healthz") return json(200, { ok: true });

  // Every request is its own invocation on a host with no process, so the
  // switches are re-read here rather than trusted from whenever the runtime was
  // built. No-op for the file adapter.
  await runtime.state.refresh?.();

  // The redirect is public by design - it is the link in the posts.
  if (path.startsWith(REDIRECT_PATH)) return handleRedirect(runtime.services, url, request);

  // The passphrase, typed. Before the gate, because this is how you get through
  // it: everything else here needs a credential, and this route is where one is
  // presented. It admits nothing on its own - the same `holderOf` decides.
  if (path === UNLOCK_PATH && request.method === "POST") return handleUnlock(request, operators);

  // The name, not a yes. Everything this request records is attributed to it,
  // which is the whole reason a passphrase carries one.
  const actor = identify(request, url, operators);
  if (actor === undefined) {
    // The console, and the page a browser lands back on when the form was
    // reloaded after a refusal. It used to answer, in English, "Open the URL
    // printed by `amp console`" - a licensee on Cloudflare has no terminal to
    // run that in, and a passphrase worth having cannot go in a URL at all, so
    // the page asks for it instead. `next` is `/` and never `/unlock`: landing
    // back here after getting in is a loop, not an arrival.
    if (path === "/" || path === UNLOCK_PATH) return html(401, renderUnlock({ next: "/" }));
    return json(401, { error: "unauthorised" });
  }

  if (path === "/" && request.method === "GET") {
    const suppliedToken = url.searchParams.get("token");
    const headers: Record<string, string> = { "content-type": "text/html; charset=utf-8" };
    // Only a token that is somebody's. Now that a request is admitted on any
    // one of its three credentials, a stale `?token=` in a bookmark would
    // otherwise overwrite the good cookie that just let the holder in, and log
    // them out on their next click.
    if (suppliedToken && holderOf(suppliedToken, operators) !== undefined) {
      // Move the token out of the URL so it stops appearing in history.
      headers["set-cookie"] = sessionCookie(suppliedToken);
    }
    return new Response(
      renderPage({ companyName: runtime.config.company.name, locale: runtime.config.console.locale }),
      { status: 200, headers },
    );
  }

  // Deliberately not part of `/api/state`: that payload is what the operator
  // came for, it is re-fetched every 30 seconds, and it must never wait on
  // github.com being up. This is asked for once per page load instead, and a
  // slow or failed answer costs the notice and nothing else.
  if (path === "/api/updates" && request.method === "GET") {
    return json(200, await checkForUpdate(runtime.release, fetch));
  }

  if (path === "/api/state" && request.method === "GET") {
    // `you` so the page can say whose passphrase this is. Everything approved
    // from here is recorded against that name.
    return json(200, { ...(await buildState(runtime)), you: actor });
  }

  // What is in force for the whole company. Its own request for the same reason
  // as the timeline: static config does not belong in a payload re-fetched
  // every thirty seconds. Read-only - the config file stays the one answer to
  // "what is my configuration" (requirements 3.1).
  if (path === "/api/settings" && request.method === "GET") {
    const { config } = runtime;
    return json(200, {
      configPath: runtime.loaded.path,
      companyName: config.company.name,
      operator: config.company.operator,
      // The same source checkForUpdate() already reads (updates.ts), not a
      // second one: `runtime.release` is undefined for a checkout that was
      // never released, and then there is genuinely no version to name here
      // either - the settings screen says so rather than falling back to
      // package.json, which would be a second copy of this value with no way
      // to notice the two had drifted.
      ...(runtime.release ? { version: runtime.release.version } : {}),
      // The two that decide what actually happens, and neither was visible
      // anywhere on this screen: a licensee could be running unattended, or
      // running on the simulated model, and have no way to find out.
      autonomy: config.company.autonomy,
      llm: {
        provider: config.llm.provider,
        model: config.llm.model,
        fastModel: config.llm.fastModel,
        effort: config.llm.effort,
      },
      policy: {
        requireDisclosure: config.policy.requireDisclosure,
        maxAiSmellScore: config.policy.maxAiSmellScore,
        maxPostsPerDay: config.policy.maxPostsPerDay,
        minMinutesBetweenPosts: config.policy.minMinutesBetweenPosts,
        bannedPhrases: config.policy.bannedPhrases.length,
      },
      // The disclosure and the claims are NOT company-wide, and reporting
      // `config.policy` for them was this file re-deriving compliance - which
      // CLAUDE.md forbids in as many words. They are resolved per market by
      // src/domain/market.ts, so a US venture is owed a different disclosure
      // and three more prohibited claims than the company list holds. One row
      // per market, from the one function that is allowed to answer.
      compliance: config.ventures.map((venture) => {
        const market = findMarket(config.markets, venture.market);
        const resolved = resolveCompliance({ policy: config.policy, market });
        return {
          venture: venture.id,
          market: venture.market,
          // The reader's name for the market, not only its config id - the
          // settings screen names markets in its own words everywhere else
          // (accounts table, the account screen's setup card), and `jp` /
          // `us` on their own mean nothing to an operator who has never
          // opened the YAML.
          marketName: market?.name ?? venture.market,
          disclosureText: resolved.disclosureText,
          prohibitedClaims: resolved.prohibitedClaims.length,
          regulator: resolved.regulator,
        };
      }),
      trackingBaseUrl: config.tracking.baseUrl,
      ventures: config.ventures.length,
      markets: config.markets.map((market) => market.id),
      // From the operators this request was already resolved against, not from
      // process.env - there is no process on a Worker, and that is exactly the
      // band where this project's elementary bugs have lived.
      operators: operators.map((entry) => entry.name),
    });
  }

  // One day, read back. Deliberately its own request rather than a field on
  // `/api/state`: it reads five collections for one date, and the day's screen
  // - which polls every 30 seconds - must not pay for a question almost nobody
  // asks. Nobody reaches it without clicking a date in an account's history.
  const timelineMatch = /^\/api\/ventures\/([^/]+)\/cycles\/([^/]+)$/.exec(path);
  if (timelineMatch && request.method === "GET") {
    const ventureId = decodeURIComponent(timelineMatch[1] as string);
    const date = decodeURIComponent(timelineMatch[2] as string);
    if (!runtime.config.ventures.some((venture) => venture.id === ventureId)) {
      return json(404, { error: `アカウント ${ventureId} は設定にありません。` });
    }
    const timeline = await readTimeline(runtime, ventureId, date);
    if (!timeline) return json(404, { error: `${date} のサイクルはありません。` });
    return json(200, timeline);
  }

  const resolveMatch = /^\/api\/decisions\/([^/]+)\/resolve$/.exec(path);
  if (resolveMatch && request.method === "POST") {
    const body = await readJson(request);
    if (!body.ok) return errorJson(400, body.error);
    const payload = body.value as { selectedIds?: unknown; ordering?: unknown; note?: unknown };
    const result = await runtime.orchestrator.resolveGate(decodeURIComponent(resolveMatch[1] as string), {
      decidedBy: actor,
      selectedIds: toStringArray(payload.selectedIds),
      ordering: toStringArray(payload.ordering),
      ...(typeof payload.note === "string" ? { note: payload.note } : {}),
      nowIso: runtime.services.clock.nowIso(),
    });
    if (!result.ok) return errorJson(result.error.kind === "validation" ? 400 : 409, result.error);
    // The table's "判断待ち" and last-cycle columns just changed.
    forgetPortfolio(runtime);
    return json(200, { cycleId: result.value.id, status: result.value.status });
  }

  // The weekly decision. Accepting appends the block to the config as text -
  // an append keeps every comment and one source of truth, which is what the
  // earlier "never write the config" rule was protecting (see
  // docs/3-development/exploration-design.md). If the append cannot happen
  // the block comes back for the person to paste, and `written` says which.
  const proposalMatch = /^\/api\/proposals\/([^/]+)\/(accept|dismiss)$/.exec(path);
  if (proposalMatch && request.method === "POST") {
    const body = await readJson(request);
    if (!body.ok) return errorJson(400, body.error);
    const payload = body.value as { note?: unknown };
    const status = proposalMatch[2] === "accept" ? "accepted" : "dismissed";
    const result = await resolveProposal(runtime.services, {
      proposalId: decodeURIComponent(proposalMatch[1] as string),
      status,
      by: actor,
      nowIso: runtime.services.clock.nowIso(),
      ...(typeof payload.note === "string" && payload.note.trim() !== "" ? { note: payload.note.trim() } : {}),
    });
    if (!result.ok) return errorJson(result.error.kind === "not_found" ? 404 : 409, result.error);
    if (status !== "accepted") return json(200, { proposal: result.value });
    // Appended as text under `ventures:`, inactive, with a backup - the same
    // append the CLI does. If the file cannot take it, the block is returned
    // and the person pastes.
    const block = renderVentureBlock(result.value, runtime.config);
    const nowIso = runtime.services.clock.nowIso();
    const appended = await appendVentureBlock(runtime.loaded.path, block, join(runtime.loaded.dataDir, "config-backups"), { nowIso });
    if (appended.ok) {
      await markAppended(await runtime.services.stores.for(COMPANY_SCOPE), result.value.id, appended.value, nowIso);
    }
    return json(200, {
      proposal: result.value,
      block,
      configPath: runtime.loaded.path,
      ...(appended.ok
        ? { written: true, backupPath: appended.value.backupPath }
        : { written: false, writeError: appended.error.message }),
    });
  }

  // "I posted it." The only thing that makes a handed-over post live, and the
  // reason it is a press rather than something inferred: nobody but the person
  // who opened the app knows whether it went out.
  //
  // `url` is optional and is the post's own address. Nothing hangs off it yet -
  // engagement for these posts stays empty on purpose - but it is the one piece
  // of information that would be needed later, and it is only available in the
  // seconds after posting.
  const postedMatch = /^\/api\/posts\/([^/]+)\/posted$/.exec(path);
  if (postedMatch && request.method === "POST") {
    const body = await readJson(request);
    if (!body.ok) return errorJson(400, body.error);
    const payload = body.value as { url?: unknown };
    const url = typeof payload.url === "string" ? payload.url.trim() : "";
    const result = await runtime.orchestrator.recordPostedByHand(decodeURIComponent(postedMatch[1] as string), {
      by: actor,
      ...(url !== "" ? { url } : {}),
      nowIso: runtime.services.clock.nowIso(),
    });
    if (!result.ok) return errorJson(result.error.kind === "not_found" ? 404 : 409, result.error);
    // The row's post count and the day's numbers just changed.
    forgetPortfolio(runtime);
    return json(200, { postId: result.value.id, status: result.value.status, publishedAt: result.value.publishedAt });
  }

  // Switching an account on or off. Writes the state file the daemon re-reads
  // every tick - no config edit, no restart, nothing deleted.
  const switchMatch = /^\/api\/ventures\/([^/]+)\/(deactivate|activate)$/.exec(path);
  if (switchMatch && request.method === "POST") {
    const ventureId = decodeURIComponent(switchMatch[1] as string);
    const venture = runtime.config.ventures.find((entry) => entry.id === ventureId);
    if (!venture) return json(404, { error: `No venture "${ventureId}".` });
    const body = await readJson(request);
    if (!body.ok) return errorJson(400, body.error);
    const payload = body.value as { note?: unknown };
    // The whole of switching off - the state file, the gate that is still
    // open, the line in the account's trail - is one call, and `amp venture
    // deactivate` makes the same one. They were two sequences here and in
    // `cli.ts`, and they had already diverged: the command left the gate
    // standing, so the same decision produced a question nobody could answer
    // depending on which surface the operator had used.
    const switching = {
      services: runtime.services,
      state: runtime.state,
      orchestrator: runtime.orchestrator,
      ventureId: ventureId as VentureId,
      by: actor,
    };
    let closedGates = 0;
    if (switchMatch[2] === "deactivate") {
      const off = await switchVentureOff({
        ...switching,
        reason: typeof payload.note === "string" ? payload.note.trim() : "",
      });
      if (!off.ok) return errorJson(500, off.error);
      closedGates = off.value.closedGates;
    } else {
      const on = await switchVentureOn(switching);
      if (!on.ok) return errorJson(500, on.error);
    }
    forgetPortfolio(runtime);
    // What deactivating does and does not reach, so the page can say so.
    const store = await runtime.services.stores.for(ventureId);
    const nowMs = runtime.services.clock.now();
    const posts = await store.posts.all();
    return json(200, {
      ventureId,
      active: switchMatch[2] === "activate" && venture.active,
      configActive: venture.active,
      heldApproved: posts.filter((post) => post.status === "approved").length,
      beyondRecall: posts.filter((post) => post.status === "scheduled" && post.scheduledFor > nowMs).length,
      closedGates,
    });
  }

  // The console's exit from the emergency stop. Whole-platform only, never a
  // venture id: `applyResume` refuses a per-venture resume while a global stop
  // is on, and a button that is visible but refuses is worse than no button -
  // see `pause.ts` and `docs/3-development/console-ux-proposal.md` §6.2.
  if (path === "/api/resume" && request.method === "POST") {
    const outcome = await resumeEverything({ services: runtime.services, state: runtime.state, by: actor });
    if (!outcome.ok) {
      if ("stillUnreadable" in outcome) {
        // pause.ts's guard: the state could not be re-read after a forced
        // refresh, so writing RUNNING here could silently erase a stop that is
        // recorded but simply not visible right now. Refuse rather than guess.
        return errorJson(503, {
          kind: "storage",
          code: "state.unreadable",
          message: `the state could not be read (${outcome.detail})`,
          retryable: true,
        });
      }
      // Unreachable: `blockedByAll` is only returned when a ventureId is
      // given, and this route never gives one.
      throw new Error("applyResume(no ventureId) returned blockedByAll - this should never happen");
    }
    forgetPortfolio(runtime);
    return json(200, { wasPaused: outcome.wasPaused });
  }

  // One account, in full. The list is for comparing; this is what is behind a
  // row, and it is where the whole failure, the history and the settings live.
  const detailMatch = /^\/api\/ventures\/([^/]+)$/.exec(path);
  if (detailMatch && request.method === "GET") {
    const detail = await buildVentureDetail(runtime, decodeURIComponent(detailMatch[1] as string));
    if (!detail) return json(404, { error: "not found" });
    return json(200, detail);
  }

  const runMatch = /^\/api\/ventures\/([^/]+)\/run$/.exec(path);
  if (runMatch && request.method === "POST") {
    // The same lock the cycles tick takes, so this cannot run beside it and
    // draft the day twice. `undefined` where the host has no lock - on a
    // machine the data directory's lock has already answered this.
    const held = await runtime.lock?.acquire(CYCLES_LOCK, { holder: "console", ttlMs: RUN_LOCK_TTL_MS });
    if (runtime.lock && !held) {
      return json(409, {
        error: messagesFor(runtime.config.console.locale)["run.busy"],
      });
    }
    try {
      const result = await runtime.orchestrator.runCycle(decodeURIComponent(runMatch[1] as string));
      if (!result.ok) return errorJson(400, result.error);
      forgetPortfolio(runtime);
      return json(200, {
        cycleId: result.value.id,
        status: result.value.status,
        nextStep: result.value.nextStep ?? null,
      });
    } finally {
      await held?.release();
    }
  }

  return json(404, { error: "not found" });
}

/**
 * The tracking redirect. Records the click, then hands the visitor to the
 * network. An unknown code is a 404 rather than a redirect to anywhere - this
 * endpoint must never become an open redirector.
 */
/**
 * Deliberately narrow: a store, an id source and a clock, not a `Runtime`.
 *
 * The redirect has to keep working when the rest cannot be built - a config
 * that stopped validating, a secret that went missing. Every link already in a
 * post points here, and a click that is not recorded is not a click that can be
 * counted later. So this asks for the least it can, and an entry point that has
 * only that much can still serve it.
 */
export type RedirectDeps = Pick<Services, "stores" | "ids" | "clock">;

export async function handleRedirect(deps: RedirectDeps, url: URL, request: Request): Promise<Response> {
  const code = url.pathname.slice(REDIRECT_PATH.length);
  // The reader has a code and nothing else, which is why this lookup is the
  // one that starts outside any account. The link names its account, so the
  // click below is recorded in exactly one.
  const link = await deps.stores.findLinkByCode(code);
  if (!link) {
    return new Response("Unknown link.\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  const store = await deps.stores.for(link.ventureId);

  const referrer = request.headers.get("referer");
  const country = request.headers.get("cf-ipcountry");
  await store.clicks.put({
    id: deps.ids.next("clk"),
    linkId: link.id,
    at: deps.clock.nowIso(),
    ...(referrer ? { referrer } : {}),
    ...(country ? { country } : {}),
  });

  return new Response(null, { status: 302, headers: { location: link.destinationUrl, "cache-control": "no-store" } });
}

// ---------------------------------------------------------------------------
// State for the page
// ---------------------------------------------------------------------------

async function buildState(runtime: Runtime): Promise<Record<string, unknown>> {
  const { stores, clock } = runtime.services;
  // The same words the page uses, in the language console.locale asked for.
  // These strings were written straight into this file, so `locale: en` left
  // the two gates and the day's numbers - the screens an operator actually
  // works in - entirely Japanese, and the gate's own question English in both.
  const T = messagesFor(runtime.config.console.locale);
  const ventureName = new Map(runtime.config.ventures.map((venture) => [venture.id, venture.name]));

  // Every timestamp on the day's page goes through this. It is built once here
  // rather than at each call site because the rule it carries - the account's
  // clock, and always named - is the whole of the fix, and a call site that
  // formatted its own time would quietly opt out of it.
  const when = createWhen(T, runtime.config.console.locale);
  const ventureZone = new Map(runtime.config.ventures.map((venture) => [venture.id as string, venture.timezone]));
  const companyZone = companyTimezone(runtime.config.ventures);
  const zoneOf = (ventureId: string): string => ventureZone.get(ventureId) ?? companyZone;
  // Minutes-since-midnight form of each venture's `cadence.cycleStartsAt`,
  // resolved once here rather than per row: the schema already validated the
  // "HH:MM" string at load time, so this never throws.
  const cadenceMinutes = new Map(
    runtime.config.ventures.map((venture) => [venture.id as string, parseTimeOfDay(venture.cadence.cycleStartsAt)]),
  );

  // The day's page is the whole company's: what is waiting, what goes out
  // next, the numbers, what just happened. So this is a named crossing, and
  // the only one on this page - everything account-shaped goes through
  // `stores.for()` and reads one account.
  const scopes = await stores.each();
  // Every account's read in parallel, not one account after another: this was
  // a `for` loop awaiting one scope at a time, which on a Worker meant three
  // accounts paid three sequential D1 round trips for what is, per call site
  // below, one read. `Promise.all` keeps `scopes`' own order internally, but
  // nothing downstream depends on that order - `upcoming`, `handOver` and
  // `activity` all sort what this returns before showing it.
  const gather = async <T>(pick: (store: Store) => Promise<T[]>): Promise<T[]> => {
    const perScope = await Promise.all(scopes.map((scope) => pick(scope.store)));
    return perScope.flat();
  };

  // Kicked off together, not awaited one at a time: none of these six depend
  // on each other, and the function used to reach each `await` only after the
  // one before it had fully returned - six independent reads turned into six
  // sequential round trips, which is most of what made this endpoint take
  // seconds on a Worker instead of the milliseconds each read costs on its
  // own. Every one of them is awaited below, at the point the comments there
  // already explain why it is its own read.
  const decisionsPromise = runtime.orchestrator.pendingDecisions();
  const upcomingRawPromise = gather((store) =>
    store.posts.find((post) => post.status === "approved" || post.status === "scheduled" || post.status === "queued"),
  );
  const handOverRawPromise = gather((store) => store.posts.find((post) => post.status === "handed_over"));
  const activityRawPromise = gather((store) => store.audit.recent(12));
  const portfolioPromise = memoisedPortfolio(runtime);
  const proposalsStorePromise = stores.for(COMPANY_SCOPE);

  // Only the accounts that are running. Stopping one is how an operator says
  // "do nothing more here", and the tick hears it - no new cycle starts. The
  // gate already open did not hear it, so the screen kept asking for a decision
  // about an account that had been stopped, with no way to make the question go
  // away. The record stays pending and the day-turn lapse closes it, the same
  // as any gate nobody answered; this is about what the operator is asked.
  const ventureState = readVentureState(runtime.state);
  const runningVentures = new Set(
    runtime.config.ventures
      .filter((venture) => isVentureActive(venture, ventureState))
      .map((venture) => venture.id as string),
  );
  const decisions = (await decisionsPromise).filter((decision) =>
    runningVentures.has(decision.ventureId as string),
  );

  // The accounts table's 判断待ち column is counted from *this* list and not
  // from the portfolio's own tally. They were two answers to one question, and
  // they disagreed: the table counted every pending decision while the list
  // above counted only the ones a person can still answer, so a switched-off
  // account showed a badge of 1 next to a screen with nothing on it.
  const pendingByVenture = new Map<string, number>();
  for (const decision of decisions) {
    pendingByVenture.set(decision.ventureId, (pendingByVenture.get(decision.ventureId) ?? 0) + 1);
  }

  // Which day each one belongs to.
  //
  // Two gates can be open at once and look identical: a day nobody approved
  // leaves its gate standing, the next cycle opens its own, and both render as
  // "企画の承認 — メインアカウント" with nothing between them. It happened in
  // production, and the operator's reasonable read was that the page had
  // duplicated a row.
  //
  // The cycle is asked rather than the id parsed. `cyc_<venture>_<date>` looks
  // splittable until a venture id has an underscore in it, and a date is not a
  // thing to guess at on the screen where the day is the difference.
  // Staleness is decided here, in the account's own timezone, and never in the
  // page: the browser's midnight belongs to whoever is reading, and an operator
  // in another country would be told the wrong thing about somebody else's day.
  // One decision's lookup never depends on another's, so these run together -
  // each writes its own key of `dayOf`, and nothing reads the map until every
  // write below has finished.
  const dayOf = new Map<string, { day: string; stale: boolean }>();
  await Promise.all(
    decisions.map(async (decision) => {
      const store = await stores.for(decision.ventureId);
      const cycle = await store.cycles.get(decision.cycleId);
      if (!cycle) return;
      const zone = runtime.config.ventures.find((entry) => entry.id === decision.ventureId)?.timezone;
      const today = localDate(runtime.services.clock.now(), zone ?? "UTC");
      dayOf.set(decision.id, { day: cycle.date, stale: cycle.date < today });
    }),
  );

  const pending = decisions.map((decision) => ({
    id: decision.id,
    day: dayOf.get(decision.id)?.day,
    stale: dayOf.get(decision.id)?.stale ?? false,
    gateLabel: T[decision.gate === "proposal_approval" ? "gate.proposalLabel" : "gate.publishLabel"],
    question: T[decision.gate === "proposal_approval" ? "gate.questionProposal" : "gate.questionPublish"],
    ventureName: ventureName.get(decision.ventureId) ?? decision.ventureId,
    // The account, not only its name. Answering this gate starts minutes of
    // work, and when the answer to that request is lost the page watches this
    // account's row to find out what became of it - which it cannot do from a
    // display name two accounts are allowed to share.
    ventureId: decision.ventureId,
    max: decision.selectionHint.max,
    // In `manual` autonomy nothing is pre-ticked; the operator starts from a
    // blank slate on purpose.
    preselect: runtime.config.company.autonomy !== "manual",
    items: decision.items.map((item) => ({
      id: item.id,
      title: item.title,
      summary: item.summary,
      recommended: item.recommended,
      chips: buildChips(item.detail, runtime.config.policy.maxAiSmellScore, T, when, zoneOf(decision.ventureId)),
      preview: buildPreview(item.detail, T),
      // At the publishing gate the operator is the last thing between a draft
      // and someone else's followers. Collapsing the text they are approving
      // behind "本文を見る" reliably produces approvals of unread posts, so the
      // exact text - and whether the disclosure is in it - is carried out
      // separately and shown without a click.
      ...(decision.gate === "publish_approval"
        ? {
            post: buildPostText(item.detail),
            disclosure: readText(item.detail, "disclosure"),
            // Only a post carrying an offer owes the reader a disclosure. Without
            // this flag the page showed the red "missing" warning on every
            // offer-less post - about half of every slate - and the first-week
            // instructions tell the operator never to approve a red one.
            hasOffer: Boolean(item.detail["offerId"]),
          }
        : {}),
    })),
  }));

  const upcomingByVenture = new Map<string, number>();
  const upcoming = (await upcomingRawPromise)
    .sort((a, b) => a.scheduledFor - b.scheduledFor)
    // Per account, not across the company (see HAND_OVER_SHOWN): this table now
    // renders on one account's own screen, filtered to its ventureId, and a
    // company-wide slice could fill the top {UPCOMING_SHOWN} with a busier
    // account's posts and leave a quieter account's screen wrongly saying
    // nothing is scheduled.
    .filter((post) => {
      const seen = upcomingByVenture.get(post.ventureId) ?? 0;
      if (seen >= UPCOMING_SHOWN) return false;
      upcomingByVenture.set(post.ventureId, seen + 1);
      return true;
    })
    .map((post) => ({
      ventureId: post.ventureId,
      at: when.at(post.scheduledFor, zoneOf(post.ventureId)),
      // The word, not the identifier. `scheduled` reached the screen as
      // `scheduled`, in the cell under a card that had just been fixed for the
      // same fault; sending the word means there is nothing for the page to
      // print raw.
      status: T[POST_STATUS_KEYS[post.status]],
      hook: post.content.hook.slice(0, 70),
    }));

  // Posts on a channel the platform cannot publish to. They live above the
  // schedule rather than as another row in it, because every other row is
  // something the machine is going to do and these are the only ones that will
  // not happen unless the operator does them.
  //
  // The text is read from the post, never recomposed here: it is what the
  // channel composed at the slot, and a screen that recomposed it would be free
  // to disagree with what was actually handed over - the same drift the gate's
  // preview already had once.
  const composerUrlByChannel = new Map(
    runtime.config.channels.map((channel) => [channel.id, composerUrlOf(channel.options)]),
  );
  const handOverByVenture = new Map<string, number>();
  const handOver = (await handOverRawPromise)
    // Oldest slot first, and capped per account: each card carries a whole
    // post, and this payload is re-fetched every thirty seconds. An operator
    // who leaves a month of these unpressed works through them from the top
    // rather than downloading all of them on every poll - nothing is dropped,
    // because pressing one brings the next into view. See HAND_OVER_SHOWN for
    // why the cap is per account rather than company-wide.
    .sort((a, b) => a.scheduledFor - b.scheduledFor)
    .filter((post) => {
      const seen = handOverByVenture.get(post.ventureId) ?? 0;
      if (seen >= HAND_OVER_SHOWN) return false;
      handOverByVenture.set(post.ventureId, seen + 1);
      return true;
    })
    .map((post) => ({
      postId: post.id,
      ventureId: post.ventureId,
      ventureName: ventureName.get(post.ventureId) ?? post.ventureId,
      channel: post.channel,
      at: when.at(post.scheduledFor, zoneOf(post.ventureId)),
      parts: post.handOverParts ?? [],
      // The link drop goes with it. It is where the affiliate URL lives on a
      // channel with comments, and on this one nobody is going to post it
      // unless it is on the screen next to the post it belongs under.
      //
      // Named, not classified: `purpose` is this platform's own English and the
      // screen printed it - 「最初のコメント（link_drop）」 - to a licensee who
      // has no way to look it up. The name travels instead of the identifier so
      // there is no identifier on the page to leak, and `carriesLink` is the one
      // thing the screen has to be able to say out loud about a comment.
      comments: post.commentDrafts.map((comment) => ({
        name: T[commentPurposeKey(comment.purpose)],
        text: comment.text,
        carriesLink: comment.purpose === "link_drop",
      })),
      ...(composerUrlByChannel.get(post.channel) ? { composerUrl: composerUrlByChannel.get(post.channel) } : {}),
    }));

  // The four headline numbers below (`stats`) are windowed to the same
  // `{days}` as the accounts table under them, both from this one
  // company-wide computation - so "直近" cannot mean two different things on
  // the same page. It used to: this block queried every published post, link,
  // click and conversion ever recorded, with no window at all, directly under
  // a heading that says "直近の数字", while the table underneath correctly
  // windowed itself to "直近30日". CLAUDE.md names the same defect in a
  // different place - "a report whose totals were lifetime figures the
  // billing command then charged against" - and `computePerformance`
  // (`src/domain/performance.ts`) already carries the scar from fixing it
  // there once. `portfolio.totals` is that fix, reused rather than
  // re-derived: a second computation of "clicks" is a second answer.
  //
  // There is no fifth "engagement total" here. There was, briefly: a sum of
  // every post's raw engagement score in the window, windowed the same way as
  // the other four. It was still wrong, in a smaller version of the same way -
  // not because it was unwindowed, but because a sum of this particular
  // number is not a meaningful quantity at all. `medianScore`, on the
  // accounts table right below this, is age-normalised
  // (`src/domain/engagement.ts`'s `normaliseForAge`) precisely so a two-hour-
  // old post can be compared with a three-day-old one; summing the raw score
  // instead makes the total dominated by *when in the window* a post landed,
  // not by how it did. Summing the *normalised* score instead does not fix
  // that - it turns the total into a forecast of what engagement will mature
  // to, presented as a number that already happened. Both are dishonest in a
  // different way, because engagement here was built for ranking one post
  // against another, not for adding up. If this needs a company-wide
  // engagement figure again, it wants a real design - a pooled median across
  // every venture's posts in the window, most likely - not a sum revived
  // because the row felt empty without a fourth number in it.
  const portfolio = await portfolioPromise;

  // `type` travels with the entry so the page can say a failure in the
  // operator's words. The summary is the durable English record and stays the
  // fallback; it is not what a licensee should have to read.
  const activity = (await activityRawPromise)
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 12)
    .map((event) => ({
    at: when.atIso(event.at, zoneOf(event.ventureId)),
    actor: event.actor,
    summary: event.summary,
    type: event.type,
    ...(event.type === "cycle.failed"
      ? { failureCode: String(event.data["code"] ?? ""), failureStep: String(event.data["step"] ?? "") }
      : {}),
    // The day, so the page can say it in the operator's language rather than
    // showing the stored English. Which day lapsed - or was closed - is the
    // whole content of these two entries, and they are two entries on purpose:
    // one is a gate nobody answered, the other is one the operator ended.
    ...(event.type === "decision.expired" || event.type === DECISION_CLOSED_EVENT
      ? { day: String(event.data["day"] ?? "") }
      : {}),
  }));

  // Surfaced so the console cannot show a calm list of scheduled posts while
  // the platform is stopped and none of them are going anywhere.
  const stop = readPause(runtime.state);
  // Every stop, not just the first. Showing one of three stopped ventures left
  // the other two looking like a calm schedule that was going out on time.
  const stopped = stop.all
    ? [{ scope: "all", ...stop.all, at: when.atIso(stop.all.at, companyZone) }]
    // `scope` is the id, because the console prints it inside a command the
    // operator pastes. `label` is what they read. Rendering the display name
    // into `amp resume --venture <name>` produced a command that reported
    // "was not stopped" and did nothing.
    : Object.entries(stop.ventures).map(([ventureId, record]) => ({
        scope: ventureId,
        label: ventureName.get(ventureId as never) ?? ventureId,
        ...record,
        // After the spread, not before it: `record` carries its own raw `at`,
        // and an override written above it is silently thrown away.
        at: when.atIso(record.at, zoneOf(ventureId)),
      }));

  // The weekly decision, below the daily ones. Open proposals, plus the ones
  // accepted in the last week with their block: the block is the whole point
  // of accepting, and the page polls every thirty seconds, so an accepted
  // proposal that vanished on the next poll took the block with it. Dismissed
  // ones are history; `amp scout list --all` has them.
  const recentlyAcceptedSince = clock.now() - 7 * 86_400_000;
  const proposals = (await listProposals(await proposalsStorePromise))
    .filter(
      (proposal) =>
        proposal.status === "proposed" ||
        (proposal.status === "accepted" && Date.parse(proposal.resolvedAt ?? proposal.createdAt) >= recentlyAcceptedSince),
    )
    .map((proposal) => ({
    id: proposal.id,
    status: proposal.status,
    ...(proposal.status === "accepted"
      ? { block: renderVentureBlock(proposal, runtime.config), appended: proposal.appended !== undefined }
      : {}),
    // The company's clock, not one account's: a proposal is an account that
    // does not exist yet, so there is no account timezone to read.
    createdAt: when.atIso(proposal.createdAt, companyZone),
    niche: proposal.niche,
    audience: proposal.audience,
    market: proposal.market,
    category: proposal.category,
    nameCandidates: proposal.nameCandidates,
    offerIds: proposal.offerIds,
    hypothesis: proposal.hypothesis,
    evidence: proposal.evidence,
    risk: proposal.risk,
    firstHooks: proposal.firstHooks,
    killSignal: proposal.killSignal,
  }));

  // `portfolio` was already fetched above, memoised, to window the headline
  // numbers - the per-venture performance windows underneath are not free on
  // a thirty-second poll, and this is the same computation, not a second one.
  return {
    now: clock.nowIso(),
    ...(stopped.length > 0 ? { stopped } : {}),
    pending,
    proposals,
    portfolio: {
      days: portfolio.days,
      rows: portfolio.rows.map((row) => ({
        ventureId: row.ventureId,
        name: row.name,
        state: row.stopped ? "stopped" : row.deactivated ? "deactivated" : row.active ? "active" : "inactive",
        ...(row.deactivated ? { deactivated: row.deactivated } : {}),
        ...(row.review ? { review: row.review } : {}),
        pendingDecisions: pendingByVenture.get(row.ventureId) ?? 0,
        // Sent in parts, not as a sentence. The page is Japanese and these
        // three values are the platform's own English vocabulary; the words
        // the operator reads are chosen there, next to every other label.
        ...(row.lastCycle ? { lastCycle: row.lastCycle } : {}),
        // Whether *today's* cycle, in this account's own timezone, is the one
        // on record - never the browser's or the server's day. This is what
        // lets an idle row tell "ran and found nothing" apart from "has not
        // run at all", the exact confusion console-architecture.md records: a
        // venture was dead for two days while an empty row looked the same as
        // a quiet one.
        ranToday: row.lastCycle?.date === localDate(clock.now(), zoneOf(row.ventureId)),
        // The next cycle's scheduled start, from cadence - resolved to a real
        // instant so an idle row can say when, not just that it ran. Sent for
        // every row, not only idle ones, so the client has no branch where it
        // has to guess at a missing value.
        nextCycleAt: when.at(
          nextLocalTime(clock.now(), cadenceMinutes.get(row.ventureId) ?? 0, zoneOf(row.ventureId)),
          zoneOf(row.ventureId),
        ),
        posts: row.posts,
        medianScore: row.medianScore,
        clicks: row.clicks,
        conversions: row.conversions,
        approved: formatMoney(new Map(row.revenue.map((rollup) => [rollup.currency, rollup])), "approvedRevenue"),
        playbook: `${row.playbook.active}/${row.playbook.total}`,
        measurement: row.measurementClosed ? "closed" : "INCOMPLETE",
        // The step, not the sentence: `doctor`'s prose is English and written
        // for a terminal, and this page is Japanese and written for the
        // operator. The page names the step in its own words.
        ...(row.measurementStep ? { measurementStep: row.measurementStep } : {}),
      })),
    },
    upcoming,
    handOver,
    stats: [
      { label: T["stats.posts"], value: String(portfolio.totals.posts) },
      { label: T["stats.clicks"], value: String(portfolio.totals.clicks) },
      { label: T["stats.conversions"], value: String(portfolio.totals.conversions) },
      {
        label: T["stats.revenue"],
        value: formatMoney(
          new Map(portfolio.totals.byCurrency.map((rollup) => [rollup.currency, rollup])),
          "approvedRevenue",
        ),
      },
    ],
    activity,
  };
}

/**
 * Everything one account is, for the screen behind a row.
 *
 * The numbers come from the same `buildPortfolio` the list uses, so the two can
 * never disagree about an account - a second computation of "clicks" is a
 * second answer. What is added here is what only makes sense for one account:
 * the whole failure rather than a summary of it, the last few days, and the
 * config that is actually in force, each field with where it came from.
 */
async function buildVentureDetail(runtime: Runtime, ventureId: string): Promise<Record<string, unknown> | undefined> {
  const venture = runtime.config.ventures.find((entry) => entry.id === ventureId);
  if (!venture) return undefined;

  const portfolio = await memoisedPortfolio(runtime);
  const row = portfolio.rows.find((entry) => entry.ventureId === ventureId);
  if (!row) return undefined;

  const cycles = (await (await runtime.services.stores.for(ventureId)).cycles.all())
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .slice(0, 7)
    .map((cycle) => ({
      date: cycle.date,
      status: cycle.status,
      ...(cycle.nextStep ? { nextStep: cycle.nextStep } : {}),
      // Only for a day that ended there. See the same guard in portfolio.ts.
      ...(cycle.failure && cycle.status === "failed"
        ? { failureCode: cycle.failure.code, failureStep: cycle.failure.step }
        : {}),
      published: cycle.artifacts.dispatch?.dispatchedPostIds.length ?? 0,
    }));

  const market = runtime.config.markets.find((entry) => entry.id === venture.market);
  const offers = runtime.config.offers.filter((offer) => venture.offers.includes(offer.id));
  const index = runtime.config.ventures.indexOf(venture);

  return {
    ...row,
    // Formatted the same way the list formats it, from the same numbers.
    // Money is never summed across currencies, here or anywhere.
    approvedRevenue: formatMoney(new Map(row.revenue.map((rollup) => [rollup.currency, rollup])), "approvedRevenue"),
    pendingRevenue: formatMoney(new Map(row.revenue.map((rollup) => [rollup.currency, rollup])), "pendingRevenue"),
    recentCycles: cycles,
    // Read-only, and each line says where it comes from: a screen that cannot
    // be edited still has to save the operator from opening the YAML to find
    // out what is in force.
    setup: {
      configPath: runtime.loaded.path,
      niche: venture.niche,
      audience: venture.audience,
      voice: venture.voice,
      cadence: venture.cadence,
      language: venture.language,
      timezone: venture.timezone,
      channels: venture.channels,
      path: `ventures[${index}]`,
      ...(market
        ? {
            market: {
              id: market.id,
              name: market.name,
              language: market.language,
              currency: market.currency,
              timezone: market.timezone,
              disclosureText: market.disclosureText,
              regulator: market.regulator,
            },
          }
        : {}),
      offers: offers.map((offer) => ({
        id: offer.id,
        name: offer.name,
        network: offer.network,
        payoutModel: offer.payoutModel,
        payoutValue: offer.payoutValue,
        currency: offer.currency,
        crossBorder: offer.originMarket !== venture.market,
      })),
    },
  };
}

const PORTFOLIO_MEMO_MS = 30_000;
/**
 * Keyed on the store registry, not on `runtime` itself.
 *
 * On a machine or the daemon, `runtime` is built once and lives for the whole
 * process, so either key would have hit. On a Worker, `handleRequest` gets a
 * brand new `Runtime` on every single request (`worker/handler.ts` calls
 * `createWorkerRuntime` inside `fetch`), so a memo keyed on it could never
 * hit there at all - a fresh key every time is the same as no memo, which is
 * why the second `/api/state` call was never any faster than the first.
 *
 * `runtime.services.stores` does not have that problem. It is the one part of
 * a Worker's `Runtime` this platform deliberately keeps for the life of the
 * isolate rather than rebuilding per request (`worker/runtime.ts`'s
 * `sqlPartsFor`), because a `StoreRegistry` holds no per-request state of its
 * own - only a D1 driver that answers the same database for as long as the
 * isolate lives. Keying on it rather than on the driver directly, or on some
 * value invented just for this cache, means this memo automatically tracks
 * whatever the platform has *already* decided is safe to share across
 * requests: if a future change ever does give the Worker a fresh
 * `StoreRegistry` per request again, this memo goes back to never hitting
 * there - degrading to today's behaviour, never to serving one isolate's
 * numbers to a different database's.
 */
const portfolioMemo = new WeakMap<StoreRegistry, { at: number; value: Awaited<ReturnType<typeof buildPortfolio>> }>();

async function memoisedPortfolio(runtime: Runtime): Promise<Awaited<ReturnType<typeof buildPortfolio>>> {
  const now = runtime.services.clock.now();
  const cached = portfolioMemo.get(runtime.services.stores);
  if (cached && now - cached.at < PORTFOLIO_MEMO_MS) return cached.value;
  const value = await buildPortfolio({
    config: runtime.config,
    stores: runtime.services.stores,
    nowMs: now,
    days: 30,
    state: runtime.state,
  });
  portfolioMemo.set(runtime.services.stores, { at: now, value });
  return value;
}

/** Forgets the memo, so a switch the operator just made shows on the next poll. */
export function forgetPortfolio(runtime: Runtime): void {
  portfolioMemo.delete(runtime.services.stores);
}

function buildChips(
  detail: Readonly<Record<string, unknown>>,
  maxAiSmellScore: number,
  T: Messages,
  when: When,
  timezone: string,
): { label: string; tone?: string }[] {
  const chips: { label: string; tone?: string }[] = [];
  if (typeof detail["scheduledFor"] === "string") {
    chips.push({ label: when.atIso(String(detail["scheduledFor"]), timezone) });
  }
  if (typeof detail["expectedEngagement"] === "number") {
    chips.push({ label: fill(T, "chip.expected", { n: Math.round(detail["expectedEngagement"]) }) });
  }
  if (typeof detail["aiSmellScore"] === "number") {
    // Amber from 70% of the configured limit: the policy's number, not a second
    // threshold the operator cannot find in any config file.
    const warnFrom = Math.round(maxAiSmellScore * 0.7);
    chips.push({ label: fill(T, "chip.aiSmell", { n: detail["aiSmellScore"] }), tone: detail["aiSmellScore"] > warnFrom ? "warn" : "" });
  }
  if (detail["offerId"]) chips.push({ label: "PR", tone: "warn" });
  if (Array.isArray(detail["findings"]) && detail["findings"].length > 0) {
    chips.push({ label: fill(T, "chip.findings", { n: detail["findings"].length }), tone: "danger" });
  }
  if (typeof detail["risk"] === "string" && detail["risk"] !== "") {
    chips.push({ label: `${T["preview.risk"]}: ${String(detail["risk"]).slice(0, 40)}` });
  }
  return chips;
}

function readText(detail: Readonly<Record<string, unknown>>, key: string): string {
  const value = detail[key];
  return typeof value === "string" ? value.trim() : "";
}

/**
 * The parts of the post as the channel will publish them, in order.
 *
 * `threadParts` wins over `body` when it is present, because that is what the
 * channel publishes. Showing `body` here meant the operator approved one text
 * while a different one went out - which defeats the entire point of putting
 * the post in front of them unfolded. The same reasoning is why the hook and
 * the close are composed by `composeThreadParts` rather than bolted on here: a
 * writer returns parts that already carry both, and a screen that adds them
 * again shows a post nobody is going to publish.
 */
function buildPostParts(detail: Readonly<Record<string, unknown>>): string[] {
  const threadParts = Array.isArray(detail["threadParts"])
    ? (detail["threadParts"] as unknown[]).map((part) => String(part ?? ""))
    : [];
  const hashtags = Array.isArray(detail["hashtags"])
    ? (detail["hashtags"] as unknown[]).map((tag) => String(tag ?? ""))
    : [];

  const composed = composeThreadParts({
    hook: readText(detail, "hook"),
    cta: readText(detail, "cta"),
    hashtags,
    threadParts,
  });
  if (composed.length > 0) return composed;

  return [readText(detail, "hook"), readText(detail, "body"), readText(detail, "cta")].filter(
    (part) => part !== "",
  );
}

/** The literal text that will appear on the channel, with the notice under it. */
function buildPostText(detail: Readonly<Record<string, unknown>>): string {
  return [...buildPostParts(detail), readText(detail, "disclosure")]
    .filter((part) => part !== "")
    .join("\n\n");
}

/**
 * Gathers the one day the timeline describes.
 *
 * Scoped to the account throughout - `stores.for(ventureId)` - so this can never
 * become a way to read another account's ideas by asking for its date. The
 * collections are filtered by `cycleId` rather than trusted to hold one day.
 */
async function readTimeline(runtime: Runtime, ventureId: string, date: string): Promise<Timeline | undefined> {
  const store = await runtime.services.stores.for(ventureId as VentureId);
  const cycles = await store.cycles.find((cycle) => cycle.date === date);
  const cycle = cycles[0];
  if (!cycle) return undefined;

  const drafts = await store.drafts.find((draft) => draft.cycleId === cycle.id);
  // The day is read back on the clock the account keeps, not the server's. The
  // name is resolved for the instant the day started, so a day inside summer
  // time is named as summer time rather than by the zone's winter name.
  const locale = runtime.config.console.locale;
  const timezone =
    runtime.config.ventures.find((venture) => venture.id === ventureId)?.timezone ??
    companyTimezone(runtime.config.ventures);
  return buildTimeline({
    cycle,
    ideas: await store.ideas.find((idea) => idea.cycleId === cycle.id),
    drafts,
    inspections: await store.inspections.forCycle(drafts.map((draft) => draft.id)),
    posts: await store.posts.find((post) => post.cycleId === cycle.id),
    decisions: await store.decisions.find((decision) => decision.cycleId === cycle.id),
    timezone,
    zoneLabel: createWhen(messagesFor(locale), locale).zone(Date.parse(cycle.createdAt), timezone),
  });
}

function buildPreview(detail: Readonly<Record<string, unknown>>, T: Messages): string {
  const lines: string[] = [];
  const push = (label: string, key: string): void => {
    const value = detail[key];
    if (typeof value === "string" && value.trim() !== "") lines.push(`${label}: ${value}`);
  };
  // A threaded draft's parts already contain the hook and the close, so listing
  // the raw fields beside them printed the whole post twice and left the
  // operator guessing which copy was the one going out. Either way this shows
  // the text once, in publication order - and the notice, which is the line
  // they are here to check.
  const threaded = Array.isArray(detail["threadParts"]) && (detail["threadParts"] as unknown[]).length > 0;
  if (threaded) {
    buildPostParts(detail).forEach((part, index) => lines.push(`THREAD ${index + 1}: ${part}`));
  } else {
    push("HOOK", "hook");
    push("BODY", "body");
    push("CTA", "cta");
  }
  push("PR", "disclosure");
  push(T["preview.angle"], "angle");
  push(T["preview.targetPain"], "targetPain");
  push(T["preview.promisedOutcome"], "promisedOutcome");
  push(T["preview.rationale"], "rationale");
  push(T["preview.risk"], "risk");
  push(T["preview.slotReason"], "slotReason");

  if (Array.isArray(detail["comments"])) {
    for (const comment of detail["comments"] as { purpose?: string; text?: string }[]) {
      lines.push(`${T["preview.comment"]}(${comment.purpose ?? "?"}): ${comment.text ?? ""}`);
    }
  }
  if (Array.isArray(detail["findings"])) {
    for (const finding of detail["findings"] as { severity?: string; message?: string }[]) {
      lines.push(`${T["preview.finding"]}[${finding.severity ?? "?"}]: ${finding.message ?? ""}`);
    }
  }
  return lines.join("\n\n");
}

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

/**
 * The passphrase as the form sent it.
 *
 * The comparison is `holderOf` - the same one every other route is admitted by,
 * with the same constant-time compare and the same refusal of an empty
 * credential. A second comparison here would be a second place for that bug to
 * come back in.
 */
async function handleUnlock(request: Request, operators: readonly Operator[]): Promise<Response> {
  const body = await readBodyText(request);
  if (!body.ok) return errorJson(400, body.error);

  const submitted = readUnlockSubmission(body.value);
  if (holderOf(submitted.token, operators) === undefined) {
    // The page again, with the reason, and never carrying what was typed: this
    // page's whole job is to be the only place that value exists.
    return html(401, renderUnlock({ next: submitted.next, problem: UNLOCK_MISMATCH }));
  }

  // 303, so a refresh of where they land is not a re-post of the passphrase.
  return new Response(null, {
    status: 303,
    headers: {
      location: submitted.next,
      "set-cookie": sessionCookie(submitted.token),
      "cache-control": "no-store",
    },
  });
}

/** The name of whoever presented a valid passphrase, or undefined for nobody. */
function identify(request: Request, url: URL, operators: readonly Operator[]): string | undefined {
  const header = request.headers.get("authorization");
  // All three, in order, rather than the first one that happens to be present.
  // Picking one up front meant a request that carried a useless credential lost
  // the good one it also carried: `?token=` with nothing after it is "" and not
  // absent, so a link with an emptied token in it logged the holder out of a
  // session whose cookie was sitting right there.
  const presented = [
    header?.startsWith("Bearer ") ? header.slice(7) : undefined,
    url.searchParams.get("token") ?? undefined,
    readCookie(request.headers.get("cookie") ?? undefined, COOKIE_NAME),
  ];

  for (const credential of presented) {
    const name = holderOf(credential, operators);
    if (name !== undefined) return name;
  }
  return undefined;
}

/** Whose passphrase this is, or undefined for nobody's. */
function holderOf(credential: string | undefined, operators: readonly Operator[]): string | undefined {
  // Defence in depth against the same class of bug: an empty secret must never
  // be satisfiable, and an empty presented credential must never satisfy one.
  // `Cookie: amp_console=` opened every route once, the one that approves and
  // publishes included.
  if (credential === undefined || credential === "") return undefined;
  // Every operator is compared rather than stopping at the first match, so the
  // time taken says nothing about where in the list the holder is.
  let found: string | undefined;
  for (const operator of operators) {
    if (operator.token !== "" && safeEqual(credential, operator.token)) found = operator.name;
  }
  return found;
}

// `node:crypto` and `node:buffer` are imported by name rather than taken from
// globals: both are available to a Worker with Node compatibility on, and an
// explicit import is what makes that true on any runtime that has them.
function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  // timingSafeEqual throws on length mismatch, which would itself leak length.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeCookieValue(rest.join("="));
  }
  return undefined;
}

/**
 * The passphrase as it was before `sessionCookie` encoded it.
 *
 * A value that predates the encoding, or one a hand rolled a `%` into, is not
 * valid percent-encoding and throws; it is then whatever it already was, which
 * is what those sessions were compared as.
 */
function decodeCookieValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

async function readBodyText(request: Request): Promise<Result<string, PlatformError>> {
  const text = await request.text();
  // Measured in bytes, not characters: a body of multi-byte text is as
  // expensive to hold as the same number of ASCII bytes.
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
    return fail("validation", "console.body_too_large", "Request body is too large.");
  }
  return ok(text);
}

async function readJson(request: Request): Promise<Result<unknown, PlatformError>> {
  const body = await readBodyText(request);
  if (!body.ok) return body;
  if (body.value.trim() === "") return ok({});
  try {
    return ok(JSON.parse(body.value));
  } catch (cause) {
    return fail("validation", "console.invalid_json", "Request body was not valid JSON.", { cause });
  }
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/**
 * A `PlatformError`, to the client - for a route the running console page
 * reads with `api()`, not a plain form post.
 *
 * `error` is `describeError`'s full string: the `[kind/code]`, the message
 * written for a log or a terminal, and the raw `details`. It is here for the
 * network tab, because throwing it away would cost whoever debugs the next
 * one. It is not what `ui.ts` shows: `code` is, looked up in
 * `FAILURE_SUMMARIES` (`src/console/labels.ts`), which already has this
 * platform's own words for `platform.stopped` and the rest, in the operator's
 * language. `describePause`'s "run `amp resume`" reaching the screen through
 * this exact field, unrouted, was the bug - `ui.ts`'s `failureText()` is the
 * other half of this fix.
 */
function errorJson(status: number, error: PlatformError): Response {
  return json(status, { error: describeError(error), code: error.code });
}

function html(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}
