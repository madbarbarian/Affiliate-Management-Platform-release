import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createJsonStore } from "../src/storage/json-store.ts";
import { createMemoryStore } from "../src/storage/memory-store.ts";
import { createSqlStore } from "../src/storage/sql-store.ts";
import { createSqliteDriver } from "../src/storage/sqlite-driver.ts";
import { describeStoreContract } from "./store-contract.ts";
import type { Cycle } from "../src/core/types.ts";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "amp-store-"));
}

function cycle(id: string): Cycle {
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
  };
}

test("writes survive a restart", async () => {
  const dir = await tempDir();
  try {
    const first = await createJsonStore({ dataDir: dir });
    await first.cycles.put(cycle("cyc_1"));
    await first.close();

    const second = await createJsonStore({ dataDir: dir });
    const loaded = await second.cycles.get("cyc_1");
    assert.equal(loaded?.ventureId, "main");
    await second.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("collection files are readable JSON arrays, not an opaque format", async () => {
  const dir = await tempDir();
  try {
    const store = await createJsonStore({ dataDir: dir });
    await store.cycles.putMany([cycle("cyc_1"), cycle("cyc_2")]);
    await store.close();

    const parsed = JSON.parse(await readFile(join(dir, "cycles.json"), "utf8"));
    assert.ok(Array.isArray(parsed));
    assert.equal(parsed.length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a corrupt file names itself instead of throwing a parser error", async () => {
  const dir = await tempDir();
  try {
    await writeFile(join(dir, "cycles.json"), "{not json", "utf8");
    const store = await createJsonStore({ dataDir: dir });
    await assert.rejects(() => store.cycles.all(), /Corrupt store file .*cycles\.json/);
    await store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a second process is refused the lock while the first holds it", async () => {
  const dir = await tempDir();
  try {
    const holder = await createJsonStore({ dataDir: dir, lock: true, owner: "daemon" });
    await assert.rejects(
      () => createJsonStore({ dataDir: dir, lock: true, owner: "cycle run" }),
      /Another process is using .*daemon/s,
    );
    await holder.close();

    // Once released, the lock is available again.
    const next = await createJsonStore({ dataDir: dir, lock: true, owner: "cycle run" });
    await next.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("read-only access does not need the lock", async () => {
  const dir = await tempDir();
  try {
    const holder = await createJsonStore({ dataDir: dir, lock: true, owner: "daemon" });
    const reader = await createJsonStore({ dataDir: dir, lock: false });
    assert.deepEqual(await reader.cycles.all(), []);
    await reader.close();
    await holder.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a lock left behind by a dead process is reclaimed", async () => {
  const dir = await tempDir();
  try {
    // A lock recorded against a pid that cannot exist, with an old timestamp.
    await mkdir(join(dir, ".lock"), { recursive: true });
    await writeFile(
      join(dir, ".lock", "owner.json"),
      JSON.stringify({ owner: "crashed", pid: 2 ** 30, at: new Date(Date.now() - 3_600_000).toISOString() }),
      "utf8",
    );
    const store = await createJsonStore({ dataDir: dir, lock: true, owner: "cycle run" });
    await store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the audit log appends and reads back newest first", async () => {
  const dir = await tempDir();
  try {
    const store = await createJsonStore({ dataDir: dir });
    for (let index = 0; index < 3; index += 1) {
      await store.audit.append({
        id: `evt_${index}`,
        at: `2026-04-01T0${index}:00:00Z`,
        ventureId: index === 2 ? "other" : "main",
        cycleId: "cyc_1",
        type: "test",
        actor: "tester",
        summary: `event ${index}`,
        data: {},
      });
    }

    const recent = await store.audit.recent(10);
    assert.equal(recent[0]?.id, "evt_2");

    const filtered = await store.audit.recent(10, { ventureId: "main" });
    assert.equal(filtered.length, 2);
    await store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a torn final line in the audit log does not break status commands", async () => {
  const dir = await tempDir();
  try {
    const store = await createJsonStore({ dataDir: dir });
    await store.audit.append({
      id: "evt_ok",
      at: "2026-04-01T00:00:00Z",
      ventureId: "main",
      type: "test",
      actor: "tester",
      summary: "fine",
      data: {},
    });
    await store.close();

    await writeFile(join(dir, "audit.jsonl"), `${await readFile(join(dir, "audit.jsonl"), "utf8")}{"partial":`, "utf8");
    const reopened = await createJsonStore({ dataDir: dir });
    const recent = await reopened.audit.recent(10);
    assert.equal(recent.length, 1);
    assert.equal(recent[0]?.id, "evt_ok");
    await reopened.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a failed write does not poison every write that follows", async () => {
  // One rejected write used to leave the chain permanently rejected while the
  // collection was already marked clean, so every later write rethrew the
  // original error and nothing reached disk again - a whole day of cycle state
  // lost to one transient ENOSPC.
  const dir = await mkdtemp(join(tmpdir(), "amp-store-"));
  try {
    const store = await createJsonStore({ dataDir: dir, lock: false });
    await store.patterns.put({ id: "pat_1", ventureId: "main" } as never);
    await store.flush();

    // Make the directory unwritable so the next flush fails, then restore it.
    await chmod(dir, 0o500);
    let failed = false;
    try {
      await store.patterns.put({ id: "pat_2", ventureId: "main" } as never);
      await store.flush();
    } catch {
      failed = true;
    }
    await chmod(dir, 0o700);

    if (!failed) return; // running as root: the premise does not hold here

    await store.patterns.put({ id: "pat_3", ventureId: "main" } as never);
    await store.flush();
    await store.close();

    const reopened = await createJsonStore({ dataDir: dir, lock: false });
    const all = await reopened.patterns.all();
    assert.ok(
      all.some((pattern) => pattern.id === "pat_3"),
      "writes after a failure must reach disk again",
    );
    await reopened.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// The shared contract, run against both shipped adapters. The suite otherwise
// runs entirely on the memory store, so this is the only thing that says the
// two agree.
const jsonDirs: string[] = [];
describeStoreContract("json store", {
  async create() {
    const dir = await tempDir();
    jsonDirs.push(dir);
    return createJsonStore({ dataDir: dir });
  },
  async cleanup() {
    const dir = jsonDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  },
});

describeStoreContract("memory store", {
  async create() {
    return createMemoryStore();
  },
});

// The same contract against real SQLite - which is what D1 is. The statements
// exercised here are the ones a Worker will run.
describeStoreContract("sql store (sqlite)", {
  async create() {
    return createSqlStore(createSqliteDriver({ filename: ":memory:" }));
  },
});
