import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createJsonRegistry, createJsonStore } from "../src/storage/json-store.ts";
import { createMemoryRegistry, createMemoryStore } from "../src/storage/memory-store.ts";
import { createSqlRegistry, createSqlStore } from "../src/storage/sql-store.ts";
import { createSqliteDriver } from "../src/storage/sqlite-driver.ts";
import { describeRegistryContract, describeStoreContract } from "./store-contract.ts";
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
    const first = await createJsonStore({ venture: "main", dataDir: dir });
    await first.cycles.put(cycle("cyc_1"));
    await first.close();

    const second = await createJsonStore({ venture: "main", dataDir: dir });
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
    const store = await createJsonStore({ venture: "main", dataDir: dir });
    await store.cycles.putMany([cycle("cyc_1"), cycle("cyc_2")]);
    await store.close();

    const parsed = JSON.parse(await readFile(join(dir, "ventures", "main", "cycles.json"), "utf8"));
    assert.ok(Array.isArray(parsed));
    assert.equal(parsed.length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a corrupt file names itself instead of throwing a parser error", async () => {
  const dir = await tempDir();
  try {
    await mkdir(join(dir, "ventures", "main"), { recursive: true });
    await writeFile(join(dir, "ventures", "main", "cycles.json"), "{not json", "utf8");
    const store = await createJsonStore({ venture: "main", dataDir: dir });
    await assert.rejects(() => store.cycles.all(), /Corrupt store file .*cycles\.json/);
    await store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a second process is refused the lock while the first holds it", async () => {
  const dir = await tempDir();
  try {
    const holder = await createJsonStore({ venture: "main", dataDir: dir, lock: true, owner: "daemon" });
    await assert.rejects(
      () => createJsonStore({ venture: "main", dataDir: dir, lock: true, owner: "cycle run" }),
      /Another process is using .*daemon/s,
    );
    await holder.close();

    // Once released, the lock is available again.
    const next = await createJsonStore({ venture: "main", dataDir: dir, lock: true, owner: "cycle run" });
    await next.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("read-only access does not need the lock", async () => {
  const dir = await tempDir();
  try {
    const holder = await createJsonStore({ venture: "main", dataDir: dir, lock: true, owner: "daemon" });
    const reader = await createJsonStore({ venture: "main", dataDir: dir, lock: false });
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
    const store = await createJsonStore({ venture: "main", dataDir: dir, lock: true, owner: "cycle run" });
    await store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the audit log appends and reads back newest first", async () => {
  const dir = await tempDir();
  try {
    const store = await createJsonStore({ venture: "main", dataDir: dir });
    for (let index = 0; index < 3; index += 1) {
      await store.audit.append({
        id: `evt_${index}`,
        at: `2026-04-01T0${index}:00:00Z`,
        ventureId: "main",
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
    assert.equal(filtered.length, 3);
    await store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a torn final line in the audit log does not break status commands", async () => {
  const dir = await tempDir();
  try {
    const store = await createJsonStore({ venture: "main", dataDir: dir });
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

    await writeFile(join(dir, "ventures", "main", "audit.jsonl"), `${await readFile(join(dir, "ventures", "main", "audit.jsonl"), "utf8")}{"partial":`, "utf8");
    const reopened = await createJsonStore({ venture: "main", dataDir: dir });
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
    const store = await createJsonStore({ venture: "main", dataDir: dir, lock: false });
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

    const reopened = await createJsonStore({ venture: "main", dataDir: dir, lock: false });
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
    return createJsonStore({ venture: "main", dataDir: dir });
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
    return createSqlStore(createSqliteDriver({ filename: ":memory:" }), { venture: "main" });
  },
});

// The registry contract, against all three. This is the file that says
// "accounts cannot see each other" is true of the implementations rather than
// of the code that happens to read them.
const registryDirs: string[] = [];
describeRegistryContract("json registry", async () => {
  const dir = await tempDir();
  registryDirs.push(dir);
  return createJsonRegistry({ dataDir: dir });
});

describeRegistryContract("memory registry", async () => createMemoryRegistry());

describeRegistryContract("sql registry (sqlite)", async () =>
  createSqlRegistry(createSqliteDriver({ filename: ":memory:" })));

test.after(async () => {
  for (const dir of registryDirs) await rm(dir, { recursive: true, force: true });
});

test("a data directory written before the split is moved, not lost", async () => {
  // The worst way for a migration to fail is silently. These files sat at the
  // top level and say nothing about which account they are; the new layout
  // simply would not look at them, so an operator would open the console and
  // find their history apparently gone, with no error to search for.
  const dir = await tempDir();
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "cycles.json"), JSON.stringify([cycle("cyc_old")]), "utf8");
    await writeFile(
      join(dir, "audit.jsonl"),
      `${JSON.stringify({ id: "evt_old", at: "2026-04-01T00:00:00Z", ventureId: "beauty", type: "test", actor: "t", summary: "s", data: {} })}\n`,
      "utf8",
    );

    const stores = createJsonRegistry({ dataDir: dir, assignExistingTo: "beauty" });
    const store = await stores.for("beauty");
    assert.deepEqual((await store.cycles.all()).map((item) => item.id), ["cyc_old"], "the history did not come across");
    assert.equal((await store.audit.recent(10))[0]?.id, "evt_old");
    await stores.close();

    // And they are in the account's folder now, not still at the top.
    assert.equal(existsSync(join(dir, "cycles.json")), false);
    assert.equal(existsSync(join(dir, "ventures", "beauty", "cycles.json")), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("with two accounts configured, the move refuses rather than guessing", async () => {
  // Nothing in those files says whose they are, and a wrong answer mixes two
  // histories permanently - which is the exact thing the split exists to stop.
  const dir = await tempDir();
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "cycles.json"), JSON.stringify([cycle("cyc_old")]), "utf8");

    const stores = createJsonRegistry({ dataDir: dir });
    await assert.rejects(() => stores.for("beauty"), /exactly one account in ventures:/);
    // And it left the files where they were.
    assert.equal(existsSync(join(dir, "cycles.json")), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a database written before the split keeps its rows", async () => {
  // The SQL half of the same question. SQLite cannot add a column to a primary
  // key, so this is a rebuild - and a rebuild that dropped rows would be the
  // same silent loss.
  const driver = createSqliteDriver({ filename: ":memory:" });
  try {
    await driver.run(
      `CREATE TABLE records (collection TEXT NOT NULL, id TEXT NOT NULL, seq INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY (collection, id))`,
    );
    await driver.run(`INSERT INTO records (collection, id, seq, json) VALUES ('cycles', 'cyc_old', 1, ?)`, [
      JSON.stringify(cycle("cyc_old")),
    ]);

    const stores = createSqlRegistry(driver, { assignExistingTo: "beauty" });
    const store = await stores.for("beauty");
    assert.deepEqual((await store.cycles.all()).map((item) => item.id), ["cyc_old"]);
    // And the account that was not there gets nothing.
    assert.deepEqual(await (await stores.for("zakka")).cycles.all(), []);
  } finally {
    await driver.close?.();
  }
});

test("a database with rows and two accounts refuses rather than guessing", async () => {
  const driver = createSqliteDriver({ filename: ":memory:" });
  try {
    await driver.run(
      `CREATE TABLE records (collection TEXT NOT NULL, id TEXT NOT NULL, seq INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY (collection, id))`,
    );
    await driver.run(`INSERT INTO records (collection, id, seq, json) VALUES ('cycles', 'cyc_old', 1, '{}')`);

    const stores = createSqlRegistry(driver);
    await assert.rejects(() => stores.for("beauty"), /exactly one account in ventures:/);
  } finally {
    await driver.close?.();
  }
});
