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

import type { AuditEvent, Cycle, InspectionReport, TrackedLink } from "../src/core/types.ts";
import type { Store, StoreRegistry } from "../src/storage/store.ts";

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

function link(id: string, ventureId: string, code: string): TrackedLink {
  return {
    id,
    ventureId,
    offerId: "off_1",
    code,
    destinationUrl: "https://example.test/offer",
    createdAt: "2026-04-01T00:00:00Z",
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
      // Ten events from another cycle in between: a limit applied before the
      // filter would return nothing for cyc_9.
      await store.audit.append(event({ cycleId: "cyc_9", type: "cycle.started" }));
      for (let i = 0; i < 10; i += 1) {
        await store.audit.append(event({ cycleId: "cyc_other", type: "cycle.started" }));
      }
      await store.audit.append(event({ cycleId: "cyc_9", type: "cycle.completed" }));

      const mine = await store.audit.recent(5, { cycleId: "cyc_9" });
      assert.deepEqual(
        mine.map((item) => item.type),
        ["cycle.completed", "cycle.started"],
      );
      assert.deepEqual(await store.audit.recent(5, { cycleId: "no-such-cycle" }), []);
    });
  });

  test(`${label}: an account's log holds that account's events and no others`, async () => {
    // A store belongs to one account, so an event claiming to be another
    // account's cannot get in - it is stamped with the scope on the way. And
    // asking this log for another account's events answers with none rather
    // than quietly handing back its own: the ventureId filter narrows, it
    // cannot widen. Reading across accounts is StoreRegistry.each.
    await withStore(async (store) => {
      await store.audit.append(event({ ventureId: "somebody-else", type: "cycle.started" }));

      const all = await store.audit.recent(5);
      assert.equal(all.length, 1);
      assert.equal(all[0]?.ventureId, "main", "the event kept an account id that is not this store's");

      assert.deepEqual(await store.audit.recent(5, { ventureId: "somebody-else" }), []);
      assert.equal((await store.audit.recent(5, { ventureId: "main" })).length, 1);
    });
  });

  test(`${label}: flush() and close() can be called with nothing pending`, async () => {
    await withStore(async (store) => {
      await store.flush();
      await store.flush();
    });
  });
}

/**
 * What a `StoreRegistry` owes its callers, whichever backend it is over.
 *
 * The point of the split is one sentence: **an account's store cannot reach
 * another account's data.** That is a property of every implementation or it
 * is a property of none, and "the code that reads it is careful" is exactly
 * the assurance this replaces.
 */
export function describeRegistryContract(label: string, create: () => Promise<StoreRegistry>): void {
  const withRegistry = async (body: (registry: StoreRegistry) => Promise<void>): Promise<void> => {
    const registry = await create();
    try {
      await body(registry);
    } finally {
      await registry.close();
    }
  };

  test(`${label}: two accounts do not see each other`, async () => {
    await withRegistry(async (registry) => {
      const beauty = await registry.for("beauty");
      const zakka = await registry.for("zakka");

      await beauty.cycles.put(cycle("cyc_shared_id", { ventureId: "beauty" }));
      await zakka.cycles.put(cycle("cyc_shared_id", { ventureId: "zakka" }));

      // The same id in two accounts is two records, not one overwriting the
      // other. Ids are ours to generate, so this is not hypothetical for a
      // date-derived one like cyc_<venture>_<date>.
      assert.equal((await beauty.cycles.get("cyc_shared_id"))?.ventureId, "beauty");
      assert.equal((await zakka.cycles.get("cyc_shared_id"))?.ventureId, "zakka");

      assert.deepEqual((await beauty.cycles.all()).map((item) => item.ventureId), ["beauty"]);
      assert.deepEqual((await zakka.cycles.all()).map((item) => item.ventureId), ["zakka"]);

      // find() is a predicate over this account's items, so a predicate that
      // matches everything still cannot reach past the account.
      assert.equal((await beauty.cycles.find(() => true)).length, 1);
    });
  });

  test(`${label}: an account's history is its own`, async () => {
    await withRegistry(async (registry) => {
      const beauty = await registry.for("beauty");
      const zakka = await registry.for("zakka");
      await beauty.audit.append(event({ ventureId: "beauty", type: "role.write.completed" }));
      await zakka.audit.append(event({ ventureId: "zakka", type: "post.published" }));

      assert.deepEqual((await beauty.audit.recent(10)).map((item) => item.type), ["role.write.completed"]);
      assert.deepEqual((await zakka.audit.recent(10)).map((item) => item.type), ["post.published"]);
    });
  });

  test(`${label}: removing from one account leaves the other alone`, async () => {
    await withRegistry(async (registry) => {
      const beauty = await registry.for("beauty");
      const zakka = await registry.for("zakka");
      await beauty.cycles.put(cycle("cyc_1", { ventureId: "beauty" }));
      await zakka.cycles.put(cycle("cyc_1", { ventureId: "zakka" }));

      await beauty.cycles.remove("cyc_1");
      assert.equal(await beauty.cycles.get("cyc_1"), undefined);
      assert.equal((await zakka.cycles.get("cyc_1"))?.ventureId, "zakka", "a delete crossed accounts");
    });
  });

  test(`${label}: each() lists every account that has data`, async () => {
    await withRegistry(async (registry) => {
      await (await registry.for("beauty")).cycles.put(cycle("cyc_1", { ventureId: "beauty" }));
      await (await registry.for("zakka")).cycles.put(cycle("cyc_2", { ventureId: "zakka" }));

      const found = await registry.each();
      assert.deepEqual(found.map((entry) => entry.ventureId).sort(), ["beauty", "zakka"]);
      // And the store handed back is that account's, not a fresh one.
      const beauty = found.find((entry) => entry.ventureId === "beauty");
      assert.equal((await beauty!.store.cycles.all()).length, 1);
    });
  });

  test(`${label}: a code finds its link, and the link names its account`, async () => {
    // The reader arrives with a code and nothing else. This is the one lookup
    // that legitimately starts outside any account - and it still lands in
    // exactly one, because the link says which.
    await withRegistry(async (registry) => {
      const zakka = await registry.for("zakka");
      await (await registry.for("beauty")).links.put(link("lnk_b", "beauty", "aaa"));
      await zakka.links.put(link("lnk_z", "zakka", "bbb"));

      const found = await registry.findLinkByCode("bbb");
      assert.equal(found?.id, "lnk_z");
      assert.equal(found?.ventureId, "zakka", "the click would be recorded against the wrong account");
      assert.equal(await registry.findLinkByCode("not-a-code"), undefined);
    });
  });

  test(`${label}: the same account asked for twice is the same store`, async () => {
    await withRegistry(async (registry) => {
      const first = await registry.for("beauty");
      await first.cycles.put(cycle("cyc_1", { ventureId: "beauty" }));
      const second = await registry.for("beauty");
      assert.equal((await second.cycles.get("cyc_1"))?.ventureId, "beauty");
    });
  });
}
