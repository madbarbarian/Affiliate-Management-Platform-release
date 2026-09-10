/**
 * Exploration - running the scout and acting on what it proposes.
 *
 * The scout is a role: it takes the portfolio and returns proposals. Everything
 * around that is here, in the kernel, because it is sequencing and persistence:
 * when the scout is due, what gets stored, what accepting a proposal produces.
 *
 * Accepting produces a config block, not a config edit. The one file a
 * licensee edits stays theirs; the platform generates, the person pastes. That
 * is slower than writing the file, and it is the same decision the onboarding
 * design made for the same reason - a config the machine rewrites has two
 * sources of truth and loses its comments.
 */

import { copyFile, mkdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { writeFileAtomic } from "../storage/atomic.ts";

import { fail, ok, type PlatformError, type Result } from "../core/result.ts";
import { COMPANY_SCOPE, type ProposalStatus, type VentureProposal } from "../core/types.ts";
import { buildConfig } from "../config/load.ts";
import type { PlatformConfig } from "../config/schema.ts";
import type { StateStore } from "./state.ts";
import { buildPortfolio } from "../domain/portfolio.ts";
import { scout, type ScoutOutput } from "../roles/scout.ts";
import type { Store } from "../storage/store.ts";
import { createCompanyContext, type Services } from "./role.ts";

/** The audit event that marks a completed run - including one with no proposals. */
export const SCOUT_COMPLETED_EVENT = "role.scout.completed";

export type ScoutRunOptions = {
  readonly count?: number;
  /** The stop and deactivation switches, for the portfolio's state column. */
  readonly state?: StateStore;
};

export async function runScout(services: Services, options: ScoutRunOptions = {}): Promise<Result<ScoutOutput, PlatformError>> {
  const { config, stores, clock } = services;
  // The scout works for the company, not for an account: its proposals and its
  // own history live under COMPANY_SCOPE, which is a store like any other.
  const store = await stores.for(COMPANY_SCOPE);
  const count = options.count ?? config.company.exploration.proposals;
  const portfolio = await buildPortfolio({
    config,
    stores,
    nowMs: clock.now(),
    days: config.company.exploration.lookbackDays,
    state: options.state,
  });

  const context = await createCompanyContext(services, scout.id);
  const result = await scout.run(context, { count, portfolio });
  if (!result.ok) return result;

  await store.proposals.putMany(result.value.proposals);
  // Written even when nothing was proposed: "the scout ran and found nothing"
  // is what stops the daemon running it again every minute.
  await context.note(
    SCOUT_COMPLETED_EVENT,
    `Proposed ${result.value.proposals.length} venture(s); ${result.value.dropped.length} dropped by the guardrails.`,
    {
      proposalIds: result.value.proposals.map((proposal) => proposal.id),
      dropped: result.value.dropped.length,
      ventures: portfolio.rows.length,
    },
  );
  return ok(result.value);
}

/** When the scout last completed, from the audit log. Undefined when never. */
export async function lastScoutAt(store: Store): Promise<number | undefined> {
  const events = await store.audit.recent(200, { ventureId: COMPANY_SCOPE });
  const completed = events.find((event) => event.type === SCOUT_COMPLETED_EVENT);
  return completed ? Date.parse(completed.at) : undefined;
}

export function scoutDue(lastMs: number | undefined, nowMs: number, everyDays: number): boolean {
  if (lastMs === undefined) return true;
  return nowMs - lastMs >= everyDays * 86_400_000;
}

export async function listProposals(store: Store, status?: ProposalStatus): Promise<VentureProposal[]> {
  const proposals = await store.proposals.find((proposal) => status === undefined || proposal.status === status);
  return proposals.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export type ProposalResolution = {
  readonly proposalId: string;
  readonly status: Exclude<ProposalStatus, "proposed">;
  readonly by: string;
  readonly nowIso: string;
  readonly note?: string;
};

/** Accepts or dismisses a proposal. A proposal is decided once. */
export async function resolveProposal(
  services: Services,
  resolution: ProposalResolution,
): Promise<Result<VentureProposal, PlatformError>> {
  const proposal = await (await services.stores.for(COMPANY_SCOPE)).proposals.get(resolution.proposalId);
  if (!proposal) {
    return fail("not_found", "proposal.not_found", `No proposal "${resolution.proposalId}". \`amp scout list\` shows the open ones.`);
  }
  if (proposal.status !== "proposed") {
    return fail(
      "conflict",
      "proposal.already_resolved",
      `Proposal "${proposal.id}" was already ${proposal.status}${proposal.resolvedBy ? ` by ${proposal.resolvedBy}` : ""}.`,
    );
  }
  const resolved: VentureProposal = {
    ...proposal,
    status: resolution.status,
    resolvedAt: resolution.nowIso,
    resolvedBy: resolution.by,
    ...(resolution.note ? { resolutionNote: resolution.note } : {}),
  };
  await (await services.stores.for(COMPANY_SCOPE)).proposals.put(resolved);
  await (await createCompanyContext(services, "operator")).note(
    `proposal.${resolution.status}`,
    `${resolution.status === "accepted" ? "Accepted" : "Dismissed"} "${proposal.niche}"${resolution.note ? `: ${resolution.note}` : ""}.`,
    { proposalId: proposal.id, suggestedVentureId: proposal.suggestedVentureId },
  );
  return ok(resolved);
}

/**
 * The `ventures[]` entry an accepted proposal becomes. Commented, inactive,
 * and built from what the config already has (the market's timezone, an
 * existing venture's channels), so it validates when pasted and changes
 * nothing until the person turns it on.
 */
export function renderVentureBlock(proposal: VentureProposal, config: PlatformConfig): string {
  const market = config.markets.find((entry) => entry.id === proposal.market);
  const sibling =
    config.ventures.find((venture) => venture.market === proposal.market && venture.active) ?? config.ventures[0];
  const channels = sibling?.channels ?? [];
  const q = yamlString;
  const list = (values: readonly string[]): string => `[${values.map(q).join(", ")}]`;
  const names = proposal.nameCandidates;

  return [
    `  # --- Proposed by the scout (${proposal.id}, ${proposal.createdAt.slice(0, 10)}). Paste under \`ventures:\`.`,
    `  # Hypothesis: ${oneLine(proposal.hypothesis)}`,
    `  # Risk:       ${oneLine(proposal.risk)}`,
    `  # Stop when:  ${oneLine(proposal.killSignal)}`,
    `  - id: ${q(proposal.suggestedVentureId)}`,
    `    name: ${q(names[0] ?? proposal.niche)}${names.length > 1 ? `   # other candidates: ${oneLine(names.slice(1).join(" / "))}` : ""}`,
    `    niche: ${q(proposal.niche)}`,
    `    audience: ${q(proposal.audience)}`,
    `    market: ${q(proposal.market)}`,
    `    timezone: ${q(market?.timezone ?? "Asia/Tokyo")}`,
    `    language: ${q(proposal.language)}`,
    `    active: false   # turn on once the voice below reads right, then restart the daemon`,
    `    channels: ${list(channels)}${sibling ? `   # copied from "${sibling.id}"` : ""}`,
    `    offers: ${list(proposal.offerIds)}${proposal.offerIds.length === 0 ? "   # no contracted offer is permitted in this market yet" : ""}`,
    `    voice:`,
    `      persona: ${q(proposal.voice.persona)}`,
    `      firstPerson: ${q(proposal.voice.firstPerson)}`,
    `      tone: ${list(proposal.voice.tone)}`,
    `      bannedPhrases: []`,
    `      signaturePhrases: []`,
    `    cadence:`,
    `      postsPerDay: 1   # a new account starts at one, like the first week`,
    `      minMinutesBetweenPosts: 240`,
    `      cycleStartsAt: ${q(sibling?.cadence.cycleStartsAt ?? "06:30")}`,
    `      ideasPerCycle: 10`,
  ].join("\n");
}

export type AppendOutcome = {
  /** Where the block now lives. */
  readonly configPath: string;
  /** The copy of the file as it was before, in case the paste is regretted. */
  readonly backupPath: string;
};

export type AppendOptions = {
  /** Injected time for the backup's name, so a test can predict it. */
  readonly nowIso: string;
  readonly env?: NodeJS.ProcessEnv;
};

/**
 * Puts an accepted proposal's block into `platform.config.yaml`, under
 * `ventures:`, as text.
 *
 * The onboarding design ruled out a console that *rewrites* the config,
 * because serialising it back loses every comment and leaves two sources of
 * truth. This is the other thing: an append. The file is read as text, the
 * block is inserted after the `ventures:` line, nothing else is touched, and
 * the result is loaded through the real validator before it replaces the
 * original. If it does not validate, the original is left alone and the block
 * is handed back for the person to paste. A dated backup is kept either way -
 * the config is git-ignored, so git will not have it.
 */
export async function appendVentureBlock(
  configPath: string,
  block: string,
  backupDir: string,
  options: AppendOptions,
): Promise<Result<AppendOutcome, PlatformError>> {
  const env = options.env ?? process.env;
  let original: string;
  try {
    original = await readFile(configPath, "utf8");
  } catch (cause) {
    // A config that cannot be read back is a reason to hand over the block,
    // not a reason to fail the acceptance the person just made.
    return fail(
      "config",
      "config.unreadable",
      `Could not read ${configPath} (${cause instanceof Error ? cause.message : String(cause)}). Paste the block by hand.`,
    );
  }
  const anchor = /^ventures:[ \t]*(#.*)?\r?\n/m.exec(original);
  if (!anchor) {
    return fail(
      "config",
      "config.no_ventures_anchor",
      `Could not find a \`ventures:\` line in ${configPath} to append under. Paste the block by hand.`,
    );
  }
  const insertAt = anchor.index + anchor[0].length;
  const next = `${original.slice(0, insertAt)}${block}\n\n${original.slice(insertAt)}`;

  try {
    buildConfig(next, configPath, env);
  } catch (cause) {
    return fail(
      "config",
      "config.append_invalid",
      // The first issue, not only the headline: the headline is the file name.
      `The block would not validate once pasted (${
        cause instanceof Error ? cause.message.split("\n").slice(0, 2).map((line) => line.trim()).join(" ") : String(cause)
      }). ` +
        `${configPath} was left unchanged; paste and fix the block by hand.`,
    );
  }

  const stamp = options.nowIso.replace(/[:.]/g, "-");
  const backupPath = join(backupDir, `${basename(configPath)}.${stamp}.bak`);
  try {
    await mkdir(backupDir, { recursive: true });
    await copyFile(configPath, backupPath);
    await writeFileAtomic(configPath, next);
  } catch (cause) {
    // A read-only mount or a full disk is a reason to hand over the block, not
    // to lose the acceptance the person just made - the same as an unreadable
    // file above. The backup is written before the config, so a failure here
    // has changed nothing that mattered.
    return fail(
      "storage",
      "config.append_failed",
      `Could not write ${configPath} (${cause instanceof Error ? cause.message : String(cause)}). ` +
        `The file was not changed; paste the block by hand.`,
    );
  }
  return ok({ configPath, backupPath });
}

/** Records on the proposal that its block reached the config, so every surface can say so truthfully. */
export async function markAppended(store: Store, proposalId: string, outcome: AppendOutcome, nowIso: string): Promise<void> {
  const proposal = await store.proposals.get(proposalId);
  if (!proposal) return;
  await store.proposals.put({ ...proposal, appended: { at: nowIso, configPath: outcome.configPath, backupPath: outcome.backupPath } });
}

/** A proposal in a form a person reads before deciding. */
export function describeProposal(proposal: VentureProposal): string {
  return [
    `${proposal.id}  [${proposal.status}]  ${proposal.niche}`,
    `  audience     ${proposal.audience}`,
    `  market       ${proposal.market} (${proposal.language}) · category ${proposal.category}`,
    `  names        ${proposal.nameCandidates.join(" / ") || "(none)"}`,
    `  offers       ${proposal.offerIds.join(", ") || "(none permitted in this market)"}`,
    `  hypothesis   ${proposal.hypothesis}`,
    `  evidence     ${proposal.evidence}`,
    `  risk         ${proposal.risk}`,
    `  first hooks  ${proposal.firstHooks.map((hook) => `「${hook}」`).join(" ")}`,
    `  stop when    ${proposal.killSignal}`,
  ].join("\n");
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Every scalar in the block is double-quoted, whatever it looks like. The
 * in-tree YAML reader turns a bare `no` into false and `on` stays a string
 * only by luck, so a language code or a market id must never be emitted
 * bare. Only the escapes that reader understands are produced; control
 * characters a model might emit become spaces rather than ``, which the
 * reader would refuse and the paste would fail to load.
 */
export function yamlString(value: string): string {
  const cleaned = value.replace(/[\r\n\t]/g, " ").replace(/[ -]/g, "");
  return `"${cleaned.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
