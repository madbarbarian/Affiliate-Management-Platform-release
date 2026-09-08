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

import { describeGate } from "../kernel/approvals.ts";
import { readPause } from "../kernel/pause.ts";
import { REDIRECT_PATH } from "../affiliate/links.ts";
import { describeError, fail, ok, type PlatformError, type Result } from "../core/result.ts";
import { engagementScore } from "../domain/engagement.ts";
import { formatMoney, revenueByPost, totalCounts, totalsByCurrency } from "../affiliate/attribution.ts";
import { latestMetricByPost } from "../domain/performance.ts";
import { buildPortfolio } from "../domain/portfolio.ts";
import { appendVentureBlock, listProposals, markAppended, renderVentureBlock, resolveProposal } from "../kernel/exploration.ts";
import { deactivateVenture, reactivateVenture } from "../kernel/venture-state.ts";
import type { Runtime } from "../runtime.ts";
import type { Services } from "../kernel/role.ts";
import { renderPage } from "./ui.ts";

export const COOKIE_NAME = "amp_console";
export const MAX_BODY_BYTES = 256 * 1024;

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

export async function handleRequest(runtime: Runtime, token: string, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/healthz") return json(200, { ok: true });

  // Every request is its own invocation on a host with no process, so the
  // switches are re-read here rather than trusted from whenever the runtime was
  // built. No-op for the file adapter.
  await runtime.state.refresh?.();

  // The redirect is public by design - it is the link in the posts.
  if (path.startsWith(REDIRECT_PATH)) return handleRedirect(runtime.services, url, request);

  if (!authorised(request, url, token)) {
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
    if (suppliedToken) {
      // Move the token out of the URL so it stops appearing in history.
      headers["set-cookie"] = `${COOKIE_NAME}=${suppliedToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`;
    }
    return new Response(renderPage({ companyName: runtime.config.company.name }), { status: 200, headers });
  }

  if (path === "/api/state" && request.method === "GET") return json(200, await buildState(runtime));

  const resolveMatch = /^\/api\/decisions\/([^/]+)\/resolve$/.exec(path);
  if (resolveMatch && request.method === "POST") {
    const body = await readJson(request);
    if (!body.ok) return json(400, { error: body.error.message });
    const payload = body.value as { selectedIds?: unknown; ordering?: unknown; note?: unknown };
    const result = await runtime.orchestrator.resolveGate(decodeURIComponent(resolveMatch[1] as string), {
      decidedBy: runtime.config.company.operator,
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
      by: runtime.config.company.operator,
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
    if (appended.ok) await markAppended(runtime.services.store, result.value.id, appended.value, nowIso);
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
        by: runtime.config.company.operator,
        reason: typeof payload.note === "string" ? payload.note.trim() : "",
      });
    } else {
      await reactivateVenture(runtime.state, ventureId);
    }
    await runtime.services.store.audit.append({
      id: runtime.services.ids.next("evt"),
      at: runtime.services.clock.nowIso(),
      ventureId,
      type: switchMatch[2] === "deactivate" ? "venture.deactivated" : "venture.activated",
      actor: runtime.config.company.operator,
      summary:
        switchMatch[2] === "deactivate"
          ? `Deactivated "${venture.name}"${typeof payload.note === "string" && payload.note.trim() ? `: ${payload.note.trim()}` : ""}.`
          : `Reactivated "${venture.name}".`,
      data: {},
    });
    forgetPortfolio(runtime);
    // What deactivating does and does not reach, so the page can say so.
    const nowMs = runtime.services.clock.now();
    const posts = await runtime.services.store.posts.find((post) => post.ventureId === ventureId);
    return json(200, {
      ventureId,
      active: switchMatch[2] === "activate" && venture.active,
      configActive: venture.active,
      heldApproved: posts.filter((post) => post.status === "approved").length,
      beyondRecall: posts.filter((post) => post.status === "scheduled" && post.scheduledFor > nowMs).length,
    });
  }

  const runMatch = /^\/api\/ventures\/([^/]+)\/run$/.exec(path);
  if (runMatch && request.method === "POST") {
    const result = await runtime.orchestrator.runCycle(decodeURIComponent(runMatch[1] as string));
    if (!result.ok) return json(400, { error: describeError(result.error) });
    forgetPortfolio(runtime);
    return json(200, { cycleId: result.value.id, status: result.value.status, nextStep: result.value.nextStep ?? null });
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
export type RedirectDeps = Pick<Services, "store" | "ids" | "clock">;

export async function handleRedirect(deps: RedirectDeps, url: URL, request: Request): Promise<Response> {
  const code = url.pathname.slice(REDIRECT_PATH.length);
  const links = await deps.store.links.find((link) => link.code === code);
  const link = links[0];
  if (!link) {
    return new Response("Unknown link.\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  }

  const referrer = request.headers.get("referer");
  const country = request.headers.get("cf-ipcountry");
  await deps.store.clicks.put({
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

async function buildState(runtime: Runtime): Promise<unknown> {
  const { store, clock } = runtime.services;
  const ventureName = new Map(runtime.config.ventures.map((venture) => [venture.id, venture.name]));

  const decisions = await runtime.orchestrator.pendingDecisions();
  const pending = decisions.map((decision) => ({
    id: decision.id,
    gateLabel: decision.gate === "proposal_approval" ? "企画の承認" : "投稿の承認と順番",
    question: describeGate(decision.gate),
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
      chips: buildChips(item.detail, runtime.config.policy.maxAiSmellScore),
      preview: buildPreview(item.detail),
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
    await store.posts.find(
      (post) => post.status === "approved" || post.status === "scheduled" || post.status === "queued",
    )
  )
    .sort((a, b) => a.scheduledFor - b.scheduledFor)
    .slice(0, 12)
    .map((post) => ({
      at: new Date(post.scheduledFor).toISOString().replace("T", " ").slice(0, 16),
      status: post.status,
      hook: post.content.hook.slice(0, 70),
    }));

  const published = await store.posts.find((post) => post.status === "published");
  const latest = await latestMetricByPost(store, published.map((post) => post.id));
  const [links, clicks, conversions] = await Promise.all([
    store.links.all(),
    store.clicks.all(),
    store.conversions.all(),
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

  const activity = (await store.audit.recent(12)).map((event) => ({
    at: event.at.replace("T", " ").slice(0, 16),
    actor: event.actor,
    summary: event.summary,
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
  const proposals = (await listProposals(store))
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
        lastCycle: row.lastCycle
          ? `${row.lastCycle.date} ${row.lastCycle.status}${row.lastCycle.nextStep ? ` → ${row.lastCycle.nextStep}` : ""}`
          : "—",
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
      { label: "公開済み投稿", value: String(published.length) },
      { label: "エンゲージ合計", value: String(Math.round(engagementTotal)) },
      { label: "クリック", value: String(counts.clicks) },
      { label: "成果", value: String(counts.conversions) },
      { label: "確定報酬", value: formatMoney(revenue, "approvedRevenue") },
    ],
    activity,
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
    store: runtime.services.store,
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
): { label: string; tone?: string }[] {
  const chips: { label: string; tone?: string }[] = [];
  if (typeof detail["scheduledFor"] === "string") {
    chips.push({ label: String(detail["scheduledFor"]).replace("T", " ").slice(0, 16) });
  }
  if (typeof detail["expectedEngagement"] === "number") {
    chips.push({ label: `予測 ${Math.round(detail["expectedEngagement"])}` });
  }
  if (typeof detail["aiSmellScore"] === "number") {
    // Amber from 70% of the configured limit: the policy's number, not a second
    // threshold the operator cannot find in any config file.
    const warnFrom = Math.round(maxAiSmellScore * 0.7);
    chips.push({ label: `AIっぽさ ${detail["aiSmellScore"]}`, tone: detail["aiSmellScore"] > warnFrom ? "warn" : "" });
  }
  if (detail["offerId"]) chips.push({ label: "PR", tone: "warn" });
  if (Array.isArray(detail["findings"]) && detail["findings"].length > 0) {
    chips.push({ label: `指摘 ${detail["findings"].length}`, tone: "danger" });
  }
  if (typeof detail["risk"] === "string" && detail["risk"] !== "") {
    chips.push({ label: `risk: ${String(detail["risk"]).slice(0, 40)}` });
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

function buildPreview(detail: Readonly<Record<string, unknown>>): string {
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
  push("狙い", "angle");
  push("読者の悩み", "targetPain");
  push("提供する結果", "promisedOutcome");
  push("根拠", "rationale");
  push("リスク", "risk");
  push("枠の理由", "slotReason");

  if (Array.isArray(detail["comments"])) {
    for (const comment of detail["comments"] as { purpose?: string; text?: string }[]) {
      lines.push(`コメント(${comment.purpose ?? "?"}): ${comment.text ?? ""}`);
    }
  }
  if (Array.isArray(detail["findings"])) {
    for (const finding of detail["findings"] as { severity?: string; message?: string }[]) {
      lines.push(`指摘[${finding.severity ?? "?"}]: ${finding.message ?? ""}`);
    }
  }
  return lines.join("\n\n");
}

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

function authorised(request: Request, url: URL, token: string): boolean {
  // Defence in depth against the same class of bug: an empty secret must never
  // be satisfiable, and an empty presented credential must never satisfy one.
  if (token === "") return false;

  const header = request.headers.get("authorization");
  if (header?.startsWith("Bearer ") && safeEqual(header.slice(7), token)) return true;
  const query = url.searchParams.get("token");
  if (query && safeEqual(query, token)) return true;
  const cookie = readCookie(request.headers.get("cookie") ?? undefined, COOKIE_NAME);
  return cookie !== undefined && cookie !== "" && safeEqual(cookie, token);
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
