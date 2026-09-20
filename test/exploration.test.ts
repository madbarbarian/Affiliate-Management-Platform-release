/**
 * Exploration: the company's principles in every brief, the scout's guardrails,
 * what accepting a proposal produces, and the portfolio the scout reads.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseConfig } from "../src/config/schema.ts";
import { fileState } from "../src/kernel/state.ts";
import { buildConfig, repoRoot } from "../src/config/load.ts";
import { parseYaml } from "../src/config/yaml.ts";
import { COMPANY_SCOPE } from "../src/core/types.ts";
import { unwrap } from "../src/core/result.ts";
import { buildPortfolio, renderPortfolio, reviewReason, type PortfolioRow } from "../src/domain/portfolio.ts";
import {
  SCOUT_COMPLETED_EVENT,
  appendVentureBlock,
  renderVentureBlock,
  resolveProposal,
  runScout,
  scoutDue,
} from "../src/kernel/exploration.ts";
import { deactivateVenture, isVentureActive, readVentureState, reactivateVenture } from "../src/kernel/venture-state.ts";
import { ventureBrief } from "../src/kernel/role.ts";
import { BASE_CONFIG, createTestCompany, refusingProvider, testConfig } from "./helpers.ts";

// ---------------------------------------------------------------------------
// Principles
// ---------------------------------------------------------------------------

test("the company's principles and boundaries reach every venture's brief", () => {
  const config = testConfig({
    company: {
      ...BASE_CONFIG.company,
      principles: ["売る前に役に立つ"],
      boundaries: ["読者の不安を煽って売る型は採用しない"],
    },
  });
  const brief = ventureBrief(config.ventures[0]!, config);
  assert.match(brief, /How this company thinks/);
  assert.match(brief, /売る前に役に立つ/);
  assert.match(brief, /never does, in any venture/);
  assert.match(brief, /煽って売る型/);
});

test("a company that has written nothing down gets no empty heading", () => {
  const config = testConfig();
  const brief = ventureBrief(config.ventures[0]!, config);
  assert.doesNotMatch(brief, /How this company thinks/);
  assert.doesNotMatch(brief, /never does/);
});

test("exploration is off unless asked for, and its numbers are bounded", () => {
  const config = testConfig();
  assert.equal(config.company.exploration.enabled, false);
  assert.equal(config.company.exploration.everyDays, 7);
  assert.throws(
    () => testConfig({ company: { ...BASE_CONFIG.company, exploration: { enabled: true, everyDays: 0 } } }),
    /everyDays/,
  );
});

// ---------------------------------------------------------------------------
// The scout's guardrails
// ---------------------------------------------------------------------------

const proposal = (overrides: Record<string, unknown>) => ({
  niche: "在宅ワーカーの姿勢と机まわり",
  audience: "一日8時間座る在宅ワーカー",
  market: "jp",
  language: "ja",
  category: "productivity",
  ventureId: "desk-setup",
  nameCandidates: ["机の上の3年"],
  voice: { persona: "腰をやった人", firstPerson: "僕", tone: ["率直"] },
  offerIds: ["offer_test"],
  hypothesis: "既存アカウントで失敗告白の型が強い。同じ読者層の隣の悩み。",
  evidence: "main: 中央値 120、失敗告白の型 0.8",
  risk: "商材が机まわりに寄ると、案件の無い投稿が書けない",
  firstHooks: ["椅子を3回買い替えた話。"],
  killSignal: "30日で中央値が main の半分を下回る",
  ...overrides,
});

test("the scout's proposals are checked in code: market, prohibited category, duplicate niche, stopping rule, permitted offers", async () => {
  const company = createTestCompany({
    responses: {
      "scout.propose": (() => ({
        proposals: [
          proposal({ niche: "EUの何か", market: "eu" }),
          proposal({ niche: "オンラインカジノ攻略", category: "gambling" }),
          proposal({ niche: " ai活用 " }),
          proposal({ niche: "やめる条件のない案", killSignal: "" }),
          proposal({ niche: "US freelancers", market: "us", language: "en", ventureId: "us-desk", offerIds: ["offer_test", "offer_nope"] }),
          proposal({}),
        ],
      })) as never,
    },
  });

  const result = unwrap(await runScout(company.services, { count: 5 }));

  assert.deepEqual(
    result.proposals.map((entry) => entry.niche),
    ["US freelancers", "在宅ワーカーの姿勢と机まわり"],
  );
  assert.deepEqual(
    result.dropped.map((entry) => entry.niche),
    ["EUの何か", "オンラインカジノ攻略", "ai活用", "やめる条件のない案"],
  );
  assert.deepEqual(result.proposals[0]!.offerIds, [], "offer_test is not permitted in us, offer_nope does not exist");
  assert.deepEqual(result.proposals[1]!.offerIds, ["offer_test"]);
  assert.notEqual(result.proposals[1]!.suggestedVentureId, "main");

  const stored = await company.stores.open(COMPANY_SCOPE).proposals.all();
  assert.equal(stored.length, 2, "kept proposals are persisted");
  assert.ok(stored.every((entry) => entry.status === "proposed"));

  const events = await company.stores.open(COMPANY_SCOPE).audit.recent(50);
  assert.equal(events.filter((event) => event.type === "role.scout.dropped_proposal").length, 4, "each refusal is audited");
  assert.ok(events.some((event) => event.type === SCOUT_COMPLETED_EVENT));
});

test("a niche already proposed last week is not proposed again this week", async () => {
  const company = createTestCompany({ responses: { "scout.propose": (() => ({ proposals: [proposal({})] })) as never } });
  const first = unwrap(await runScout(company.services, { count: 1 }));
  assert.equal(first.proposals.length, 1);

  const second = unwrap(await runScout(company.services, { count: 1 }));
  assert.equal(second.proposals.length, 0);
  assert.match(second.dropped[0]?.reason ?? "", /open proposal/);
  assert.equal((await company.stores.open(COMPANY_SCOPE).proposals.all()).length, 1, "no duplicate stored");
});

test("the block quotes every scalar, so a language code the YAML reader would read as a boolean survives", async () => {
  const company = createTestCompany({
    responses: { "scout.propose": (() => ({ proposals: [proposal({ language: "no", niche: 'quotes " and \\ slashes' })] })) as never },
  });
  const [proposed] = unwrap(await runScout(company.services, { count: 1 })).proposals;
  const parsed = parseYaml(`ventures:\n${renderVentureBlock(proposed!, company.config)}\n`) as {
    ventures: Record<string, unknown>[];
  };
  assert.equal(parsed.ventures[0]!["language"], "no");
  assert.equal(parsed.ventures[0]!["niche"], 'quotes " and \\ slashes');
});

test("a scout run that proposes nothing still counts as a run", async () => {
  const company = createTestCompany({ responses: { "scout.propose": (() => ({ proposals: [] })) as never } });
  unwrap(await runScout(company.services));
  const events = await company.stores.open(COMPANY_SCOPE).audit.recent(10);
  assert.ok(events.some((event) => event.type === SCOUT_COMPLETED_EVENT), "otherwise the daemon would run it every minute");
});

test("scoutDue: never run means due, and then once per interval", () => {
  const day = 86_400_000;
  const now = Date.parse("2026-09-02T00:00:00Z");
  assert.equal(scoutDue(undefined, now, 7), true);
  assert.equal(scoutDue(now - 6 * day, now, 7), false);
  assert.equal(scoutDue(now - 7 * day, now, 7), true);
});

// ---------------------------------------------------------------------------
// Accepting
// ---------------------------------------------------------------------------

test("accepting produces a ventures[] block that validates when pasted, inactive, and can only be decided once", async () => {
  const company = createTestCompany({ responses: { "scout.propose": (() => ({ proposals: [proposal({})] })) as never } });
  const [proposed] = unwrap(await runScout(company.services, { count: 1 })).proposals;
  assert.ok(proposed);

  const accepted = unwrap(
    await resolveProposal(company.services, {
      proposalId: proposed.id,
      status: "accepted",
      by: "tester",
      nowIso: company.clock.nowIso(),
    }),
  );
  assert.equal(accepted.status, "accepted");

  const block = renderVentureBlock(accepted, company.config);
  const parsed = parseYaml(`ventures:\n${block}\n`) as { ventures: Record<string, unknown>[] };
  const venture = parsed.ventures[0]!;
  assert.equal(venture["id"], "desk-setup");
  assert.equal(venture["active"], false, "nothing runs until the person turns it on");

  // The whole point: pasted next to the existing venture, the config still loads.
  const config = parseConfig({ ...structuredClone(BASE_CONFIG), ventures: [...BASE_CONFIG.ventures, venture] }, "pasted");
  assert.equal(config.ventures.length, 2);
  assert.deepEqual(config.ventures[1]!.channels, ["threads"], "channels are copied from an existing venture");

  const again = await resolveProposal(company.services, {
    proposalId: proposed.id,
    status: "dismissed",
    by: "tester",
    nowIso: company.clock.nowIso(),
  });
  assert.ok(!again.ok && again.error.kind === "conflict", "a proposal is decided once");
});

test("appending the block to the real example config keeps every comment, validates, and leaves a backup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "amp-append-"));
  try {
    const configPath = join(dir, "platform.config.yaml");
    const example = (await readFile(join(repoRoot(), "platform.config.example.yaml"), "utf8"))
      .replace("provider: anthropic", "provider: mock")
      .replace("promptsDir: prompts", `promptsDir: ${join(repoRoot(), "prompts")}`);
    await writeFile(configPath, example, "utf8");

    // The block is rendered against the example's own config, as the CLI would:
    // the offers it may cite and the channels it copies are that file's.
    const exampleConfig = buildConfig(example, configPath, process.env).config;
    const company = createTestCompany({
      responses: { "scout.propose": (() => ({ proposals: [proposal({ offerIds: [] })] })) as never },
    });
    const [proposed] = unwrap(await runScout(company.services, { count: 1 })).proposals;
    const block = renderVentureBlock(proposed!, exampleConfig);

    const outcome = unwrap(
      await appendVentureBlock(configPath, block, join(dir, "backups"), { nowIso: "2026-09-02T09:30:00.000Z" }),
    );
    assert.match(outcome.backupPath, /platform\.config\.yaml\.2026-09-02T09-30-00-000Z\.bak$/, "named by the injected clock");
    const written = await readFile(configPath, "utf8");
    assert.equal(written.split("\n").filter((line) => line.startsWith("#")).length, example.split("\n").filter((line) => line.startsWith("#")).length, "no comment lost");
    assert.match(written, /^ventures:\n {2}# --- Proposed by the scout/m, "inserted directly under ventures:");
    assert.ok(written.includes(example.slice(example.indexOf("licensing:"))), "everything after ventures[] is untouched");
    assert.equal(await readFile(outcome.backupPath, "utf8"), example, "the backup is the file as it was");
    assert.equal((await readdir(join(dir, "backups"))).length, 1);

    // And a file with no `ventures:` line is left alone.
    await writeFile(configPath, example.replace(/^ventures:/m, "ventures_renamed:"), "utf8");
    const refused = await appendVentureBlock(configPath, block, join(dir, "backups"), { nowIso: "2026-09-02T09:31:00.000Z" });
    assert.ok(!refused.ok && refused.error.code === "config.no_ventures_anchor");

    // And a write that cannot happen is a value, not a thrown error: the
    // acceptance was already recorded, and the block must still come back.
    await writeFile(configPath, example, "utf8");
    const unwritable = await appendVentureBlock(configPath, block, join(configPath, "not-a-dir"), { nowIso: "2026-09-02T09:32:00.000Z" });
    assert.ok(!unwritable.ok && unwritable.error.code === "config.append_failed");
    assert.equal(await readFile(configPath, "utf8"), example, "the config is untouched when the write fails");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Switching accounts off and on
// ---------------------------------------------------------------------------

test("deactivating keeps everything and is reversible; an unreadable state file switches nothing off", async () => {
  const dir = await mkdtemp(join(tmpdir(), "amp-state-"));
  try {
    const venture = testConfig().ventures[0]!;
    assert.equal(isVentureActive(venture, readVentureState(fileState(dir))), true, "no file means on");

    const off = await deactivateVenture(fileState(dir), "main", { at: "2026-09-02T00:00:00Z", by: "tester", reason: "no clicks in 30 days" });
    assert.equal(isVentureActive(venture, off), false);
    assert.equal(isVentureActive(venture, readVentureState(fileState(dir))), false, "persisted");

    const { wasInactive } = await reactivateVenture(fileState(dir), "main");
    assert.equal(wasInactive, true);
    assert.equal(isVentureActive(venture, readVentureState(fileState(dir))), true);

    await writeFile(join(dir, "venture-state.json"), "not json", "utf8");
    const broken = readVentureState(fileState(dir));
    assert.equal(isVentureActive(venture, broken), true, "fails open - a corrupt file must not stop the company");
    assert.match(broken.warning ?? "", /could not be read/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an account is flagged for review only from its own numbers, and never once it is off", () => {
  const row = (overrides: Partial<PortfolioRow>): PortfolioRow => ({
    ventureId: "a",
    name: "a",
    niche: "",
    audience: "",
    market: "jp",
    active: true,
    stopped: false,
    pendingDecisions: 0,
    posts: 30,
    medianScore: 100,
    clicks: 10,
    conversions: 1,
    revenue: [],
    playbook: { active: 0, total: 0, top: [] },
    offerCategories: ["productivity"],
    measurementClosed: true,
    ...overrides,
  });
  const thresholds = { afterPosts: 20, belowShareOfMedian: 0.5 };

  assert.equal(reviewReason(row({ posts: 5, clicks: 0, conversions: 0 }), [], thresholds), undefined, "too few posts to judge");
  assert.match(reviewReason(row({ clicks: 0, conversions: 0 }), [], thresholds) ?? "", /not one click/);
  assert.equal(
    reviewReason(row({ clicks: 0, conversions: 0, measurementClosed: false }), [], thresholds),
    undefined,
    "zero clicks on an account that cannot record clicks is not a verdict",
  );
  assert.equal(
    reviewReason(row({ clicks: 0, conversions: 0, offerCategories: [] }), [], thresholds),
    undefined,
    "an account with nothing to link to cannot be blamed for no clicks",
  );
  const peers = [row({ ventureId: "b", medianScore: 200 }), row({ ventureId: "c", medianScore: 220 })];
  assert.match(reviewReason(row({ medianScore: 40 }), [row({ medianScore: 40 }), ...peers], thresholds) ?? "", /under 50%/);
  assert.equal(reviewReason(row({ medianScore: 150 }), [row({ medianScore: 150 }), ...peers], thresholds), undefined);
  assert.equal(
    reviewReason(row({ active: false, clicks: 0, conversions: 0 }), [], thresholds),
    undefined,
    "already off - nothing to review",
  );
});

// ---------------------------------------------------------------------------
// Portfolio
// ---------------------------------------------------------------------------

test("the portfolio shows each account's state, waiting decisions and whether it measures anything", async () => {
  const company = createTestCompany();
  unwrap(await company.orchestrator.runCycle("main"));

  const portfolio = await buildPortfolio({
    state: undefined,
    config: company.config,
    stores: company.stores,
    nowMs: company.clock.now(),
    days: 30,
  });
  assert.equal(portfolio.rows.length, 1);
  const row = portfolio.rows[0]!;
  assert.equal(row.ventureId, "main");
  assert.equal(row.pendingDecisions, 1, "the cycle is waiting at the proposal gate");
  assert.equal(row.lastCycle?.status, "awaiting_approval");
  assert.equal(row.stopped, false);
  assert.equal(row.measurementClosed, false, "mock adapters measure nothing");
  assert.equal(portfolio.totals.posts, 0);
});

test("a day that failed carries its reason, not only the step it stopped at", async () => {
  // The row said `2026-04-02 failed → write` and no more, and this table is the
  // whole of what a hosted operator can see: there is no terminal to run
  // `cycle status` in. The reason lived in the database and nowhere a person
  // would look.
  const company = createTestCompany({
    config: testConfig({ company: { name: "Auto Co", operator: "auto", autonomy: "auto" } }),
    llm: refusingProvider({ "write.draft": "your credit balance is too low" }),
  });
  assert.equal((await company.orchestrator.runCycle("main")).ok, false);

  const portfolio = await buildPortfolio({
    state: undefined,
    config: company.config,
    stores: company.stores,
    nowMs: company.clock.now(),
    days: 30,
  });
  const row = portfolio.rows[0]!;
  assert.equal(row.lastCycle?.status, "failed");
  assert.match(row.lastCycle?.failure ?? "", /credit balance is too low/);
  assert.match(renderPortfolio(portfolio), /credit balance is too low/, "and the terminal view says it too");
});

test("an account that is switched off is not reported as having a decision waiting", async () => {
  // `isVentureActive` is this codebase's one definition of "is this account
  // running", and this row was the only reader that did not consult it. Two
  // readers depend on the answer: the CLI's table, which is what an operator on
  // a machine sees, and the scout, which is shown these aggregates as evidence
  // for what the company should try next - and was being told an account that
  // does nothing is busy with a decision.
  const dir = await mkdtemp(join(tmpdir(), "amp-portfolio-"));
  try {
    const company = createTestCompany();
    unwrap(await company.orchestrator.runCycle("main"));
    const state = fileState(dir);

    const on = await buildPortfolio({
      config: company.config,
      stores: company.stores,
      nowMs: company.clock.now(),
      days: 30,
      state,
    });
    assert.equal(on.rows[0]?.pendingDecisions, 1, "a running account with a gate open");

    await deactivateVenture(state, "main", { at: "2026-04-02T00:00:00Z", by: "tester", reason: "no clicks" });
    const off = await buildPortfolio({
      config: company.config,
      stores: company.stores,
      nowMs: company.clock.now(),
      days: 30,
      state,
    });
    assert.equal(off.rows[0]?.active, false);
    assert.equal(off.rows[0]?.pendingDecisions, 0, "an account that is off cannot be waiting on anybody");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
