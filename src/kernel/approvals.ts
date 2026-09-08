/**
 * The human's two jobs, modelled.
 *
 * The whole operating promise is that a person does exactly two things a day:
 * says OK to a slate of proposals, and decides what goes out first. Everything
 * in this file exists to make those two actions cheap, unambiguous, and
 * recorded.
 *
 * Resolution is deliberately forgiving about input and strict about output. A
 * person clicking through a list at 7am will send a partial ordering, an id
 * twice, or an id that no longer exists; none of those should be an error
 * message. What comes out the other side is always a clean, validated set.
 */

import { fail, ok, type PlatformError, type Result } from "../core/result.ts";
import type { Autonomy } from "../config/schema.ts";
import type {
  Decision,
  DecisionGate,
  DecisionItem,
  DecisionResolution,
  VentureId,
} from "../core/types.ts";

export type CreateDecisionInput = {
  readonly id: string;
  readonly cycleId: string;
  readonly ventureId: VentureId;
  readonly gate: DecisionGate;
  readonly items: readonly DecisionItem[];
  readonly min: number;
  readonly max: number;
  readonly nowIso: string;
};

export function createDecision(input: CreateDecisionInput): Decision {
  return {
    id: input.id,
    cycleId: input.cycleId,
    ventureId: input.ventureId,
    gate: input.gate,
    createdAt: input.nowIso,
    items: input.items,
    selectionHint: { min: input.min, max: input.max },
    status: "pending",
    autoResolved: false,
  };
}

export type ResolutionRequest = {
  readonly decidedBy: string;
  /** Item ids the person approved. Unknown and duplicate ids are dropped. */
  readonly selectedIds: readonly string[];
  /** Preferred order. May be partial; the rest keep their proposed order. */
  readonly ordering?: readonly string[];
  readonly note?: string;
  readonly nowIso: string;
};

/**
 * Applies a person's decision.
 *
 * Rejecting everything is a legitimate outcome, not an error - some mornings
 * the whole slate deserves to die. It resolves the decision as `rejected` so
 * the cycle can end cleanly rather than sitting open forever.
 */
export function resolveDecision(
  decision: Decision,
  request: ResolutionRequest,
): Result<Decision, PlatformError> {
  if (decision.status !== "pending") {
    return fail("conflict", "decision.already_resolved", `Decision ${decision.id} was already ${decision.status}.`, {
      details: { decidedBy: decision.resolution?.decidedBy, decidedAt: decision.resolution?.decidedAt },
    });
  }

  const known = new Map(decision.items.map((item) => [item.id, item]));
  const selected = dedupe(request.selectedIds.filter((id) => known.has(id)));

  if (selected.length > decision.selectionHint.max) {
    return fail(
      "validation",
      "decision.too_many",
      `Selected ${selected.length} items but at most ${decision.selectionHint.max} can go ahead.`,
      { details: { max: decision.selectionHint.max } },
    );
  }

  const ordering = normaliseOrdering(selected, request.ordering ?? [], decision.items);

  const resolution: DecisionResolution = {
    decidedBy: request.decidedBy,
    decidedAt: request.nowIso,
    selectedIds: selected,
    ordering,
    ...(request.note ? { note: request.note } : {}),
  };

  return ok({
    ...decision,
    status: selected.length === 0 ? "rejected" : "approved",
    resolution,
  });
}

/**
 * Resolves a decision on the operator's behalf, using the platform's own
 * recommendation. Only reached when the venture runs in `auto`.
 */
export function autoResolve(decision: Decision, nowIso: string): Result<Decision, PlatformError> {
  const recommended = decision.items.filter((item) => item.recommended).map((item) => item.id);
  const fallback = decision.items.slice(0, decision.selectionHint.max).map((item) => item.id);
  const selected = (recommended.length > 0 ? recommended : fallback).slice(0, decision.selectionHint.max);

  const resolved = resolveDecision(decision, {
    decidedBy: "auto",
    selectedIds: selected,
    ordering: selected,
    note: "Resolved automatically: company.autonomy is set to \"auto\".",
    nowIso,
  });
  if (!resolved.ok) return resolved;
  return ok({ ...resolved.value, autoResolved: true });
}

/** Whether this gate waits for a person. */
export function requiresHuman(autonomy: Autonomy): boolean {
  return autonomy !== "auto";
}

/**
 * Turns a possibly-partial ordering into a total one.
 * Anything the person ranked comes first in the order they gave; everything
 * else follows in the order it was proposed.
 */
function normaliseOrdering(
  selected: readonly string[],
  requested: readonly string[],
  items: readonly DecisionItem[],
): string[] {
  const selectedSet = new Set(selected);
  const ranked = dedupe(requested.filter((id) => selectedSet.has(id)));
  const rankedSet = new Set(ranked);
  const remainder = items.map((item) => item.id).filter((id) => selectedSet.has(id) && !rankedSet.has(id));
  return [...ranked, ...remainder];
}

function dedupe(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

/** A one-line description of what a person is being asked, for the CLI. */
export function describeGate(gate: DecisionGate): string {
  return gate === "proposal_approval"
    ? "Which of today's proposed posts should be written?"
    : "Which posts go out, and in what order?";
}
