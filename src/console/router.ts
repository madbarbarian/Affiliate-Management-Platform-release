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

import { readPause } from "../kernel/pause.ts";
import { REDIRECT_PATH } from "../affiliate/links.ts";
import { describeError, fail, ok, type PlatformError, type Result } from "../core/result.ts";
import { engagementScore } from "../domain/engagement.ts";
import { formatMoney, revenueByPost, totalCounts, totalsByCurrency } from "../affiliate/attribution.ts";
import { latestMetricByPost } from "../domain/performance.ts";
import { buildPortfolio } from "../domain/portfolio.ts";
import { appendVentureBlock, listProposals, markAppended, renderVentureBlock, resolveProposal } from "../kernel/exploration.ts";
import { deactivateVenture, reactivateVenture } from "../kernel/venture-state.ts";
import { CYCLES_LOCK } from "../scheduler/tick.ts";
import type { Operator } from "./operators.ts";
import type { Runtime } from "../runtime.ts";
import type { Services } from "../kernel/role.ts";
import type { Store } from "../storage/store.ts";
import { COMPANY_SCOPE } from "../core/types.ts";
import { renderPage } from "./ui.ts";
import { fill, messagesFor, type Messages } from "./messages.ts";

export const COOKIE_NAME = "amp_console";
export const MAX_BODY_BYTES = 256 * 1024;

/**
 * How long a run started from the console holds the lock before it is assumed
 * dead. Shorter than the tick's, because a request has a smaller CPU budget
 * than a cron trigger and a browser gives up long before this.
 */
const RUN_LOCK_TTL_MS = 5 * 60_000;

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

  // The name, not a yes. Everything this request records is attributed to it,
  // which is the whole reason a passphrase carries one.
  const actor = identify(request, url, operators);
  if (actor === undefined) {
    if (path === "/") {
      return new Response("Unauthorised. Open the URL printed by `amp console`, which carries the token.\n", {
        status: 401,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
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
      headers["set-cookie"] = `${COOKIE_NAME}=${suppliedToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`;
    }
    return new Response(
      renderPage({ companyName: runtime.config.company.name, locale: runtime.config.console.locale }),
      { status: 200, headers },
    );
  }

  if (path === "/api/state" && request.method === "GET") {
    // `you` so the page can say whose passphrase this is. Everything approved
    // from here is recorded against that name.
    return json(200, { ...(await buildState(runtime)), you: actor });
  }

  const resolveMatch = /^\/api\/decisions\/([^/]+)\/resolve$/.exec(path);
  if (resolveMatch && request.method === "POST") {
    const body = await readJson(request);
    if (!body.ok) return json(400, { error: body.error.message });
    const payload = body.value as { selectedIds?: unknown; ordering?: unknown; note?: unknown };
    const result = await runtime.orchestrator.resolveGate(decodeURIComponent(resolveMatch[1] as string), {
      decidedBy: actor,
      selectedIds: toStringArray(payload.selectedIds),
      ordering: toStringArray(payload.ordering),
      ...(typeof payload.note === "string" ? { note: payload.note } : {}),
      nowIso: runtime.services.clock.nowIso(),
    });
    if (!result.ok) return json(result.error.kind === "validation" ? 400 : 409, { error: result.error.message });
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
    if (!body.ok) return json(400, { error: body.error.message });
    const payload = body.value as { note?: unknown };
    const status = proposalMatch[2] === "accept" ? "accepted" : "dismissed";
    const result = await resolveProposal(runtime.services, {
      proposalId: decodeURIComponent(proposalMatch[1] as string),
      status,
      by: actor,
      nowIso: runtime.services.clock.nowIso(),
      ...(typeof payload.note === "string" && payload.note.trim() !== "" ? { note: payload.note.trim() } : {}),
    });
    if (!result.ok) return json(result.error.kind === "not_found" ? 404 : 409, { error: result.error.message });
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

  // Switching an account on or off. Writes the state file the daemon re-reads
  // every tick - no config edit, no restart, nothing deleted.
  const switchMatch = /^\/api\/ventures\/([^/]+)\/(deactivate|activate)$/.exec(path);
  if (switchMatch && request.method === "POST") {
    const ventureId = decodeURIComponent(switchMatch[1] as string);
    const venture = runtime.config.ventures.find((entry) => entry.id === ventureId);
    if (!venture) return json(404, { error: `No venture "${ventureId}".` });
    const body = await readJson(request);
    if (!body.ok) return json(400, { error: body.error.message });
    const payload = body.value as { note?: unknown };
    if (switchMatch[2] === "deactivate") {
      await deactivateVenture(runtime.state, ventureId, {
        at: runtime.services.clock.nowIso(),
        by: actor,
        reason: typeof payload.note === "string" ? payload.note.trim() : "",
      });
    } else {
      await reactivateVenture(runtime.state, ventureId);
    }
    const store = await runtime.services.stores.for(ventureId);
    await store.audit.append({
      id: runtime.services.ids.next("evt"),
      at: runtime.services.clock.nowIso(),
      ventureId,
      type: switchMatch[2] === "deactivate" ? "venture.deactivated" : "venture.activated",
      actor,
      summary:
        switchMatch[2] === "deactivate"
          ? `Deactivated "${venture.name}"${typeof payload.note === "string" && payload.note.trim() ? `: ${payload.note.trim()}` : ""}.`
          : `Reactivated "${venture.name}".`,
      data: {},
    });
    forgetPortfolio(runtime);
    // What deactivating does and does not reach, so the page can say so.
    const nowMs = runtime.services.clock.now();
    const posts = await store.posts.all();
    return json(200, {
      ventureId,
      active: switchMatch[2] === "activate" && venture.active,
      configActive: venture.active,
      heldApproved: posts.filter((post) => post.status === "approved").length,
      beyondRecall: posts.filter((post) => post.status === "scheduled" && post.scheduledFor > nowMs).length,
    });
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
      if (!result.ok) return json(400, { error: describeError(result.error) });
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

  // The day's page is the whole company's: what is waiting, what goes out
  // next, the numbers, what just happened. So this is a named crossing, and
  // the only one on this page - everything account-shaped goes through
  // `stores.for()` and reads one account.
  const scopes = await stores.each();
  const gather = async <T>(pick: (store: Store) => Promise<T[]>): Promise<T[]> => {
    const out: T[] = [];
    for (const scope of scopes) out.push(...(await pick(scope.store)));
    return out;
  };

  const decisions = await runtime.orchestrator.pendingDecisions();
  const pending = decisions.map((decision) => ({
    id: decision.id,
    gateLabel: T[decision.gate === "proposal_approval" ? "gate.proposalLabel" : "gate.publishLabel"],
    question: T[decision.gate === "proposal_approval" ? "gate.questionProposal" : "gate.questionPublish"],
    ventureName: ventureName.get(decision.ventureId) ?? decision.ventureId,
    max: decision.selectionHint.max,
    // In `manual` autonomy nothing is pre-ticked; the operator starts from a
    // blank slate on purpose.
    preselect: runtime.config.company.autonomy !== "manual",
    items: decision.items.map((item) => ({
      id: item.id,
      title: item.title,
      summary: item.summary,
      recommended: item.recommended,
      chips: buildChips(item.detail, runtime.config.policy.maxAiSmellScore, T),
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

  const upcoming = (
    await gather((store) =>
      store.posts.find(
        (post) => post.status === "approved" || post.status === "scheduled" || post.status === "queued",
      ),
    )
  )
    .sort((a, b) => a.scheduledFor - b.scheduledFor)
    .slice(0, 12)
    .map((post) => ({
      at: new Date(post.scheduledFor).toISOString().replace("T", " ").slice(0, 16),
      status: post.status,
      hook: post.content.hook.slice(0, 70),
    }));

  const published = await gather((store) => store.posts.find((post) => post.status === "published"));
  const publishedIds = published.map((post) => post.id);
  const latest = new Map<string, Awaited<ReturnType<typeof latestMetricByPost>> extends Map<string, infer M> ? M : never>();
  for (const scope of scopes) {
    for (const [postId, metric] of await latestMetricByPost(scope.store, publishedIds)) latest.set(postId, metric);
  }
  const [links, clicks, conversions] = await Promise.all([
    gather((store) => store.links.all()),
    gather((store) => store.clicks.all()),
    gather((store) => store.conversions.all()),
  ]);
  const revenue = totalsByCurrency(
    revenueByPost({
      links,
      clicks,
      conversions,
      offers: runtime.config.offers,
      defaultCurrency: runtime.config.offers[0]?.currency ?? "JPY",
    }).values(),
  );
  const counts = totalCounts(revenue.values());

  const engagementTotal = [...latest.values()].reduce(
    (sum, metric) => sum + engagementScore(metric.snapshot),
    0,
  );

  // `type` travels with the entry so the page can say a failure in the
  // operator's words. The summary is the durable English record and stays the
  // fallback; it is not what a licensee should have to read.
  const activity = (await gather((store) => store.audit.recent(12)))
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 12)
    .map((event) => ({
    at: event.at.replace("T", " ").slice(0, 16),
    actor: event.actor,
    summary: event.summary,
    type: event.type,
    ...(event.type === "cycle.failed"
      ? { failureCode: String(event.data["code"] ?? ""), failureStep: String(event.data["step"] ?? "") }
      : {}),
  }));

  // Surfaced so the console cannot show a calm list of scheduled posts while
  // the platform is stopped and none of them are going anywhere.
  const stop = readPause(runtime.state);
  // Every stop, not just the first. Showing one of three stopped ventures left
  // the other two looking like a calm schedule that was going out on time.
  const stopped = stop.all
    ? [{ scope: "all", ...stop.all }]
    // `scope` is the id, because the console prints it inside a command the
    // operator pastes. `label` is what they read. Rendering the display name
    // into `amp resume --venture <name>` produced a command that reported
    // "was not stopped" and did nothing.
    : Object.entries(stop.ventures).map(([ventureId, record]) => ({
        scope: ventureId,
        label: ventureName.get(ventureId as never) ?? ventureId,
        ...record,
      }));

  // The weekly decision, below the daily ones. Open proposals, plus the ones
  // accepted in the last week with their block: the block is the whole point
  // of accepting, and the page polls every thirty seconds, so an accepted
  // proposal that vanished on the next poll took the block with it. Dismissed
  // ones are history; `amp scout list --all` has them.
  const recentlyAcceptedSince = clock.now() - 7 * 86_400_000;
  const proposals = (await listProposals(await stores.for(COMPANY_SCOPE)))
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
    createdAt: proposal.createdAt.replace("T", " ").slice(0, 16),
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

  // The per-venture performance windows are not free on a thirty-second poll,
  // and the page polls every thirty seconds; the table is memoised for that
  // long so the poll costs one computation, not one per venture per poll.
  const portfolio = await memoisedPortfolio(runtime);

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
        pendingDecisions: row.pendingDecisions,
        // Sent in parts, not as a sentence. The page is Japanese and these
        // three values are the platform's own English vocabulary; the words
        // the operator reads are chosen there, next to every other label.
        ...(row.lastCycle ? { lastCycle: row.lastCycle } : {}),
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
    stats: [
      { label: T["stats.posts"], value: String(published.length) },
      { label: T["stats.engagement"], value: String(Math.round(engagementTotal)) },
      { label: T["stats.clicks"], value: String(counts.clicks) },
      { label: T["stats.conversions"], value: String(counts.conversions) },
      { label: T["stats.revenue"], value: formatMoney(revenue, "approvedRevenue") },
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
const portfolioMemo = new WeakMap<Runtime, { at: number; value: Awaited<ReturnType<typeof buildPortfolio>> }>();

async function memoisedPortfolio(runtime: Runtime): Promise<Awaited<ReturnType<typeof buildPortfolio>>> {
  const now = runtime.services.clock.now();
  const cached = portfolioMemo.get(runtime);
  if (cached && now - cached.at < PORTFOLIO_MEMO_MS) return cached.value;
  const value = await buildPortfolio({
    config: runtime.config,
    stores: runtime.services.stores,
    nowMs: now,
    days: 30,
    state: runtime.state,
  });
  portfolioMemo.set(runtime, { at: now, value });
  return value;
}

/** Forgets the memo, so a switch the operator just made shows on the next poll. */
export function forgetPortfolio(runtime: Runtime): void {
  portfolioMemo.delete(runtime);
}

function buildChips(
  detail: Readonly<Record<string, unknown>>,
  maxAiSmellScore: number,
  T: Messages,
): { label: string; tone?: string }[] {
  const chips: { label: string; tone?: string }[] = [];
  if (typeof detail["scheduledFor"] === "string") {
    chips.push({ label: String(detail["scheduledFor"]).replace("T", " ").slice(0, 16) });
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
 * The literal text that will appear on the channel, in the order it appears.
 *
 * `threadParts` wins over `body` when it is present, because that is what the
 * channel publishes. Showing `body` here meant the operator approved one text
 * while a different one went out - which defeats the entire point of putting
 * the post in front of them unfolded.
 */
function buildPostText(detail: Readonly<Record<string, unknown>>): string {
  const parts = Array.isArray(detail["threadParts"])
    ? (detail["threadParts"] as unknown[]).map((part) => String(part ?? "").trim())
    : [readText(detail, "body")];

  return [readText(detail, "hook"), ...parts, readText(detail, "cta"), readText(detail, "disclosure")]
    .filter((part) => part !== "")
    .join("\n\n");
}

function buildPreview(detail: Readonly<Record<string, unknown>>, T: Messages): string {
  const lines: string[] = [];
  const push = (label: string, key: string): void => {
    const value = detail[key];
    if (typeof value === "string" && value.trim() !== "") lines.push(`${label}: ${value}`);
  };
  push("HOOK", "hook");
  push("BODY", "body");
  if (Array.isArray(detail["threadParts"])) {
    (detail["threadParts"] as unknown[]).forEach((part, index) => {
      lines.push(`THREAD ${index + 1}: ${String(part ?? "")}`);
    });
  }
  push("CTA", "cta");
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
    if (key === name) return rest.join("=");
  }
  return undefined;
}

async function readJson(request: Request): Promise<Result<unknown, PlatformError>> {
  const text = await request.text();
  // Measured in bytes, not characters: a body of multi-byte text is as
  // expensive to hold as the same number of ASCII bytes.
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
    return fail("validation", "console.body_too_large", "Request body is too large.");
  }
  if (text.trim() === "") return ok({});
  try {
    return ok(JSON.parse(text));
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
