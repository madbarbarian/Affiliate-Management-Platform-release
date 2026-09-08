import test from "node:test";
import assert from "node:assert/strict";

import { autoResolve, createDecision, resolveDecision } from "../src/kernel/approvals.ts";
import type { Decision, DecisionItem } from "../src/core/types.ts";

const NOW = "2026-04-01T00:00:00Z";

function item(id: string, recommended = false): DecisionItem {
  return { id, refId: `ref_${id}`, title: id, summary: "", recommended, detail: {} };
}

function decision(items: DecisionItem[], max = 2): Decision {
  return createDecision({
    id: "dec_1",
    cycleId: "cyc_1",
    ventureId: "main",
    gate: "proposal_approval",
    items,
    min: 0,
    max,
    nowIso: NOW,
  });
}

test("approving a subset records exactly that subset", () => {
  const resolved = resolveDecision(decision([item("a"), item("b"), item("c")]), {
    decidedBy: "tester",
    selectedIds: ["b", "c"],
    nowIso: NOW,
  });
  assert.ok(resolved.ok);
  assert.equal(resolved.value.status, "approved");
  assert.deepEqual(resolved.value.resolution?.selectedIds, ["b", "c"]);
});

test("unknown and duplicate ids are dropped rather than rejected", () => {
  const resolved = resolveDecision(decision([item("a"), item("b")]), {
    decidedBy: "tester",
    selectedIds: ["a", "a", "ghost"],
    nowIso: NOW,
  });
  assert.ok(resolved.ok);
  assert.deepEqual(resolved.value.resolution?.selectedIds, ["a"]);
});

test("a partial ordering is completed with the proposed order", () => {
  const resolved = resolveDecision(decision([item("a"), item("b"), item("c")], 3), {
    decidedBy: "tester",
    selectedIds: ["a", "b", "c"],
    ordering: ["c"],
    nowIso: NOW,
  });
  assert.ok(resolved.ok);
  assert.deepEqual(resolved.value.resolution?.ordering, ["c", "a", "b"]);
});

test("ordering never contains something that was not approved", () => {
  const resolved = resolveDecision(decision([item("a"), item("b")]), {
    decidedBy: "tester",
    selectedIds: ["a"],
    ordering: ["b", "a"],
    nowIso: NOW,
  });
  assert.ok(resolved.ok);
  assert.deepEqual(resolved.value.resolution?.ordering, ["a"]);
});

test("selecting nothing is a valid decision, recorded as a rejection", () => {
  const resolved = resolveDecision(decision([item("a"), item("b")]), {
    decidedBy: "tester",
    selectedIds: [],
    nowIso: NOW,
  });
  assert.ok(resolved.ok);
  assert.equal(resolved.value.status, "rejected");
  assert.deepEqual(resolved.value.resolution?.selectedIds, []);
});

test("selecting more than capacity is refused with a usable message", () => {
  const resolved = resolveDecision(decision([item("a"), item("b"), item("c")], 2), {
    decidedBy: "tester",
    selectedIds: ["a", "b", "c"],
    nowIso: NOW,
  });
  assert.equal(resolved.ok, false);
  if (!resolved.ok) {
    assert.equal(resolved.error.code, "decision.too_many");
    assert.match(resolved.error.message, /at most 2/);
  }
});

test("a decision cannot be resolved twice", () => {
  const first = resolveDecision(decision([item("a")]), {
    decidedBy: "tester",
    selectedIds: ["a"],
    nowIso: NOW,
  });
  assert.ok(first.ok);
  const second = resolveDecision(first.value, { decidedBy: "someone-else", selectedIds: [], nowIso: NOW });
  assert.equal(second.ok, false);
  if (!second.ok) assert.equal(second.error.code, "decision.already_resolved");
});

test("auto-resolution takes the recommendation, capped at capacity", () => {
  const resolved = autoResolve(decision([item("a", true), item("b", true), item("c", true)], 2), NOW);
  assert.ok(resolved.ok);
  assert.equal(resolved.value.autoResolved, true);
  assert.deepEqual(resolved.value.resolution?.selectedIds, ["a", "b"]);
  assert.equal(resolved.value.resolution?.decidedBy, "auto");
});

test("auto-resolution falls back to the proposed order when nothing is recommended", () => {
  const resolved = autoResolve(decision([item("a"), item("b"), item("c")], 2), NOW);
  assert.ok(resolved.ok);
  assert.deepEqual(resolved.value.resolution?.selectedIds, ["a", "b"]);
});
