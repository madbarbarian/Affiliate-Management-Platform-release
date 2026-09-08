/**
 * The behaviour every `Store` implementation owes its callers.
 *
 * There are three implementations - memory, JSON files, and (next) SQL - and
 * until this file existed there was nothing saying they behaved the same. The
 * whole suite runs against the memory store, so a divergence in the JSON store
 * would only ever have shown up in production.
 *
 * What is deliberately NOT in the contract: what happens if a caller mutates an
 * object after storing it. Every stored type is `readonly`, both shipped
 * adapters keep the reference they were given, and pinning that down would cost
 * a clone on every write for a case the type system already prevents.
 */

import test from "node:test";
import assert from "node:assert/strict";

import type { AuditEvent, Cycle, InspectionReport } from "../src/core/types.ts";
import type { Store } from "../src/storage/store.ts";

export type StoreFactory = {
  /** A fresh, empty store. */
  create(): Promise<Store>;
  /** Called after each case, with the store already closed. */
  cleanup?(): Promise<void>;
};

function cycle(id: string, patch: Partial<Cycle> = {}): Cycle {
  return {
    id,
    ventureId: "main",
    date: "2026-04-01",
    createdAt: "2026-04-01T00:00:00Z",
    updatedAt: "2026-04-01T00:00:00Z",
    status: "running",
    nextStep: "analyze",
    completed: [],
    artifacts: {},
    ...patch,
  };
}

function report(draftId: string, passed = true): InspectionReport {
  return {
    draftId,
    inspectedAt: "2026-04-01T01:00:00Z",
    aiSmellScore: 20,
    findings: [],
    passed,
    revised: {
      hook: `hook ${draftId}`,
      body: "body",
      cta: "cta",
      disclosure: "#PR",
      hashtags: [],
    },
  };
}

let eventSeq = 0;
function event(patch: Partial<AuditEvent> = {}): AuditEvent {
  eventSeq += 1;
  return {
    id: `evt_${eventSeq}`,
    at: "2026-04-01T00:00:00Z",
    ventureId: "main",
    type: "role.completed",
    actor: "system",
    summary: "something happened",
    data: {},
    ...patch,
  };
}

/**
 * Runs the shared behaviour against one implementation. `label` names it in the
 * test output so a failure says which adapter broke.
 */
export function describeStoreContract(label: string, factory: StoreFactory): void {
  const withStore = async (body: (store: Store) => Promise<void>): Promise<void> => {
    const store = await factory.create();
    try {
      await body(store);
    } finally {
      await store.close();
      await factory.cleanup?.();
    }
  };

  test(`${label}: an item can be stored and read back by id`, async () => {
    await withStore(async (store) => {
      await store.cycles.put(cycle("cyc_1"));
      assert.equal((await store.cycles.get("cyc_1"))?.ventureId, "main");
      assert.equal(await store.cycles.get("cyc_missing"), undefined);
    });
  });

  test(`${label}: storing the same id twice replaces, and keeps its place`, async () => {
    await withStore(async (store) => {
      await store.cycles.put(cycle("cyc_1"));
      await store.cycles.put(cycle("cyc_2"));
      await store.cycles.put(cycle("cyc_1", { status: "completed" }));

      const all = await store.cycles.all();
      assert.deepEqual(
        all.map((item) => item.id),
        ["cyc_1", "cyc_2"],
        "a replacement is not an append",
      );
      assert.equal(all[0]?.status, "completed");
    });
  });

  test(`${label}: all() returns items in the order they were first stored`, async () => {
    await withStore(async (store) => {
      await store.cycles.putMany([cycle("cyc_1"), cycle("cyc_2")]);
      await store.cycles.put(cycle("cyc_3"));
      assert.deepEqual(
        (await store.cycles.all()).map((item) => item.id),
        ["cyc_1", "cyc_2", "cyc_3"],
      );
    });
  });

  test(`${label}: putMany with nothing in it is not an error`, async () => {
    await withStore(async (store) => {
      await store.cycles.putMany([]);
      assert.deepEqual(await store.cycles.all(), []);
    });
  });

  test(`${label}: find() filters, and an empty collection finds nothing`, async () => {
    await withStore(async (store) => {
      assert.deepEqual(await store.cycles.find(() => true), []);
      await store.cycles.putMany([cycle("cyc_1"), cycle("cyc_2", { status: "completed" })]);
      const done = await store.cycles.find((item) => item.status === "completed");
      assert.deepEqual(
        done.map((item) => item.id),
        ["cyc_2"],
      );
    });
  });

  test(`${label}: remove() deletes, and removing what is not there is a no-op`, async () => {
    await withStore(async (store) => {
      await store.cycles.put(cycle("cyc_1"));
      await store.cycles.remove("cyc_1");
      assert.equal(await store.cycles.get("cyc_1"), undefined);
      await store.cycles.remove("cyc_1");
      await store.cycles.remove("never_existed");
      assert.deepEqual(await store.cycles.all(), []);
    });
  });

  test(`${label}: collections do not see each other's items`, async () => {
    await withStore(async (store) => {
      await store.cycles.put(cycle("shared_id"));
      assert.equal(await store.ideas.get("shared_id"), undefined);
      assert.deepEqual(await store.drafts.all(), []);
    });
  });

  test(`${label}: an inspection is keyed by its draft, and forCycle follows the ids asked for`, async () => {
    await withStore(async (store) => {
      await store.inspections.put(report("dft_1"));
      await store.inspections.put(report("dft_2"));
      await store.inspections.put(report("dft_1", false));

      assert.equal((await store.inspections.get("dft_1"))?.passed, false);
      assert.equal(await store.inspections.get("dft_none"), undefined);

      const found = await store.inspections.forCycle(["dft_2", "dft_none", "dft_1"]);
      assert.deepEqual(
        found.map((item) => item.draftId),
        ["dft_2", "dft_1"],
        "the order asked for, with the unknown one dropped rather than a hole",
      );
      assert.deepEqual(await store.inspections.forCycle([]), []);
    });
  });

  test(`${label}: the audit log reads back most recent first`, async () => {
    await withStore(async (store) => {
      await store.audit.append(event({ type: "role.analyze.completed" }));
      await store.audit.append(event({ type: "role.research.completed" }));
      await store.audit.append(event({ type: "role.plan.completed" }));

      assert.deepEqual(
        (await store.audit.recent(2)).map((item) => item.type),
        ["role.plan.completed", "role.research.completed"],
      );
      assert.deepEqual(await store.audit.recent(0), []);
    });
  });

  test(`${label}: the audit limit counts events that match the filter`, async () => {
    await withStore(async (store) => {
      // Ten events from another account in between: a limit applied before the
      // filter would return nothing for `main`.
      await store.audit.append(event({ ventureId: "main", type: "cycle.started" }));
      for (let i = 0; i < 10; i += 1) {
        await store.audit.append(event({ ventureId: "other", type: "cycle.started" }));
      }
      await store.audit.append(event({ ventureId: "main", cycleId: "cyc_9", type: "cycle.completed" }));

      const mine = await store.audit.recent(5, { ventureId: "main" });
      assert.deepEqual(
        mine.map((item) => item.type),
        ["cycle.completed", "cycle.started"],
      );

      const byCycle = await store.audit.recent(5, { cycleId: "cyc_9" });
      assert.equal(byCycle.length, 1);
      assert.deepEqual(await store.audit.recent(5, { ventureId: "nobody" }), []);
    });
  });

  test(`${label}: flush() and close() can be called with nothing pending`, async () => {
    await withStore(async (store) => {
      await store.flush();
      await store.flush();
    });
  });
}
