import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCsvNetwork, parseAmount, parseCsv, parseDate } from "../src/networks/csv.ts";
import type { NetworkFactoryContext } from "../src/networks/network.ts";

const NOW = Date.parse("2026-04-10T00:00:00Z");

function context(options: Record<string, unknown>): NetworkFactoryContext {
  return { id: "a8", credentials: {}, options, nowMs: () => NOW };
}

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "amp-csv-"));
}

// ---------------------------------------------------------------------------
// The parser
// ---------------------------------------------------------------------------

test("quoted fields may contain the delimiter, newlines and doubled quotes", () => {
  const rows = parseCsv('a,b,c\n"x,1","line\nbreak","say ""hi"""\n');
  assert.deepEqual(rows, [
    ["a", "b", "c"],
    ["x,1", "line\nbreak", 'say "hi"'],
  ]);
});

test("blank lines and a trailing newline do not produce phantom rows", () => {
  assert.deepEqual(parseCsv("a,b\n\n1,2\n\n"), [
    ["a", "b"],
    ["1", "2"],
  ]);
});

test("a non-comma delimiter is supported", () => {
  assert.deepEqual(parseCsv("a\tb\n1\t2", "\t"), [
    ["a", "b"],
    ["1", "2"],
  ]);
});

test("dates arrive in the shapes real exports use", () => {
  assert.equal(parseDate("2026-04-09T10:30:00Z"), Date.parse("2026-04-09T10:30:00Z"));
  assert.equal(parseDate("2026/04/09 10:30"), Date.UTC(2026, 3, 9, 10, 30));
  assert.equal(parseDate("2026年4月9日 10:30"), Date.UTC(2026, 3, 9, 10, 30));
  assert.equal(parseDate("2026年4月9日"), Date.UTC(2026, 3, 9));
  // Unparseable is undefined, not a guess - a wrong date moves money into the
  // wrong reporting window without anyone noticing.
  assert.equal(parseDate("last tuesday"), undefined);
  assert.equal(parseDate(""), undefined);
});

test("amounts survive currency symbols and separators", () => {
  assert.equal(parseAmount("¥2,500"), 2500);
  assert.equal(parseAmount("$12.34"), 12.34);
  assert.equal(parseAmount("1 234"), 1234);
  assert.equal(parseAmount("-500"), -500);
  assert.equal(parseAmount("n/a"), 0);
});

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

test("imports a report and maps its columns and statuses", async () => {
  const dir = await tempDir();
  try {
    await writeFile(
      join(dir, "report.csv"),
      [
        "発生日,注文ID,クリックID,報酬額,ステータス",
        "2026年4月9日 12:00,ORD-1,abc123,¥2500,承認",
        "2026年4月9日 13:00,ORD-2,def456,¥2500,未確定",
        "2026年4月9日 14:00,ORD-3,ghi789,¥2500,キャンセル",
      ].join("\n"),
      "utf8",
    );

    const network = createCsvNetwork(
      context({
        reportsDir: dir,
        currency: "JPY",
        columns: { at: "発生日", externalId: "注文ID", subId: "クリックID", amount: "報酬額", status: "ステータス" },
      }),
    );

    const result = await network.fetchConversions("2026-04-01T00:00:00Z");
    assert.ok(result.ok);
    assert.equal(result.value.length, 3);

    const byId = new Map(result.value.map((conversion) => [conversion.externalId, conversion]));
    assert.equal(byId.get("ORD-1")?.status, "approved");
    assert.equal(byId.get("ORD-2")?.status, "pending");
    assert.equal(byId.get("ORD-3")?.status, "rejected");
    assert.equal(byId.get("ORD-1")?.amount, 2500);
    assert.equal(byId.get("ORD-1")?.subId, "abc123");
    assert.equal(byId.get("ORD-1")?.currency, "JPY");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rows before the requested window are skipped", async () => {
  const dir = await tempDir();
  try {
    await writeFile(
      join(dir, "report.csv"),
      ["date,order_id,subid,amount,status", "2026-01-01,OLD,abc,100,approved", "2026-04-09,NEW,def,100,approved"].join("\n"),
      "utf8",
    );
    const network = createCsvNetwork(context({ reportsDir: dir }));
    const result = await network.fetchConversions("2026-04-01T00:00:00Z");
    assert.ok(result.ok);
    assert.deepEqual(result.value.map((conversion) => conversion.externalId), ["NEW"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the same order id appearing twice is imported once", async () => {
  const dir = await tempDir();
  try {
    const rows = ["date,order_id,subid,amount,status", "2026-04-09,ORD-1,abc,100,approved"];
    // An operator re-downloading last week's report is normal, not an error.
    await writeFile(join(dir, "week1.csv"), rows.join("\n"), "utf8");
    await writeFile(join(dir, "week1-again.csv"), rows.join("\n"), "utf8");

    const network = createCsvNetwork(context({ reportsDir: dir }));
    const result = await network.fetchConversions("2026-04-01T00:00:00Z");
    assert.ok(result.ok);
    assert.equal(result.value.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a mis-mapped column names the fix rather than silently importing nothing", async () => {
  const dir = await tempDir();
  try {
    await writeFile(join(dir, "report.csv"), "date,order,click,amount\n2026-04-09,A,b,100", "utf8");
    const network = createCsvNetwork(context({ reportsDir: dir }));
    const result = await network.fetchConversions("2026-04-01T00:00:00Z");
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "network.column_missing");
      assert.match(result.error.message, /Its headers are: date, order, click, amount/);
      assert.match(result.error.message, /options\.columns/);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("headers match regardless of case, spacing and BOM", async () => {
  const dir = await tempDir();
  try {
    await writeFile(
      join(dir, "report.csv"),
      "﻿ Order ID , Sub ID ,Date,Amount\nORD-9,zzz,2026-04-09,100",
      "utf8",
    );
    const network = createCsvNetwork(
      context({
        reportsDir: dir,
        columns: { externalId: "order_id", subId: "subid", at: "date", amount: "amount" },
      }),
    );
    const result = await network.fetchConversions("2026-04-01T00:00:00Z");
    assert.ok(result.ok);
    assert.equal(result.value[0]?.externalId, "ORD-9");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Shift_JIS exports decode correctly", async () => {
  const dir = await tempDir();
  try {
    // 承認 in Shift_JIS is 0x8FB3 0x94 0x46; write the bytes directly.
    const header = Buffer.from("date,order_id,subid,amount,status\n", "ascii");
    const row = Buffer.concat([
      Buffer.from("2026-04-09,ORD-SJIS,abc,100,", "ascii"),
      Buffer.from([0x8f, 0xb3, 0x94, 0x46]), // 承認
      Buffer.from("\n", "ascii"),
    ]);
    await writeFile(join(dir, "sjis.csv"), Buffer.concat([header, row]));

    const network = createCsvNetwork(context({ reportsDir: dir, encoding: "shift_jis" }));
    const result = await network.fetchConversions("2026-04-01T00:00:00Z");
    assert.ok(result.ok);
    assert.equal(result.value[0]?.status, "approved", "承認 should decode and map to approved");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a missing reports directory is an empty inbox, not a failure", async () => {
  const network = createCsvNetwork(context({ reportsDir: "/nonexistent/amp/reports" }));
  const result = await network.fetchConversions("2026-04-01T00:00:00Z");
  assert.ok(result.ok);
  assert.deepEqual(result.value, []);

  const health = await network.healthCheck();
  assert.ok(health.ok);
  assert.match(health.value, /does not exist yet/);
});

test("no reports directory configured is a config error with the fix in it", async () => {
  const network = createCsvNetwork(context({}));
  const health = await network.healthCheck();
  assert.equal(health.ok, false);
  if (!health.ok) assert.match(health.error.message, /options\.reportsDir/);
});

test("the tracked URL carries the sub-id under the network's own parameter", () => {
  const network = createCsvNetwork(context({ reportsDir: "/tmp", subIdParam: "a8mat" }));
  const built = network.buildTrackedUrl({ landingUrl: "https://example.com/lp?x=1", subId: "code123" });
  assert.ok(built.ok);
  assert.equal(new URL(built.value).searchParams.get("a8mat"), "code123");
});

test("a local-format export date is read in the export's own timezone", () => {
  // `YYYY/MM/DD` and `YYYY年MM月DD日` come from an ASP writing in its own zone.
  // Reading them as UTC shifted every JST date nine hours, which moves
  // conversions across the lookback boundary in both directions.
  assert.equal(new Date(parseDate("2026/08/30 00:30", 540)!).toISOString(), "2026-08-29T15:30:00.000Z");
  assert.equal(new Date(parseDate("2026年8月30日 00:30", 540)!).toISOString(), "2026-08-29T15:30:00.000Z");
  // An offset of zero keeps the old behaviour, which is right for a UTC export.
  assert.equal(new Date(parseDate("2026/08/30 00:30")!).toISOString(), "2026-08-30T00:30:00.000Z");
});
