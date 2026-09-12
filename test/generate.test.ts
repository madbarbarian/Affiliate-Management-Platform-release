/**
 * The setup generator, run against the config that actually ships.
 *
 * Every test here reads `platform.config.example.yaml` from disk rather than a
 * fixture. The generator's anchors are lines in that file, so a fixture would
 * keep passing on the day someone rewords the real one and the wizard quietly
 * stops being able to fill it in.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { generateConfig, type SetupAnswers } from "../src/config/generate.ts";
import { buildConfig } from "../src/config/load.ts";
import { repoRoot } from "../src/config/load.ts";

const template = (): string => readFileSync(join(repoRoot(), "platform.config.example.yaml"), "utf8");

const answers = (over: Partial<SetupAnswers> = {}): SetupAnswers => ({
  companyName: "みどり商店",
  operatorName: "みどり",
  ventureId: "cosme",
  ventureName: "コスメ",
  niche: "敏感肌向けのスキンケア",
  audience: "季節の変わり目に肌が荒れる30代。値段より成分を見る。",
  market: "jp",
  persona: "元美容部員。自分の肌で失敗してきた当事者。",
  firstPerson: "わたし",
  ...over,
});

test("the answers reach the config, and the config still loads", () => {
  const result = generateConfig(template(), answers());
  assert.ok(result.ok, result.ok ? "" : result.error.message);

  const { config } = buildConfig(result.value, "platform.config.yaml", {});
  assert.equal(config.company.name, "みどり商店");
  assert.equal(config.ventures[0]?.id, "cosme");
  assert.equal(config.ventures[0]?.name, "コスメ");
  assert.equal(config.ventures[0]?.niche, "敏感肌向けのスキンケア");
  assert.equal(config.ventures[0]?.voice.firstPerson, "わたし");
  assert.equal(config.ventures[0]?.market, "jp");
});

test("the comments survive, because they are most of what the file is", () => {
  // The whole reason this fills text instead of serialising an object. If a
  // future version parses and rewrites, this is the test that notices.
  const before = template();
  const result = generateConfig(before, answers());
  assert.ok(result.ok);

  const comments = (text: string): number => text.split("\n").filter((line) => line.trim().startsWith("#")).length;
  assert.equal(comments(result.value), comments(before));
  assert.match(result.value, /景表法|ステルスマーケティング/, "the market guidance is still in the file");
});

test("nothing but the answered lines moves", () => {
  const before = template().split("\n");
  const result = generateConfig(template(), answers());
  assert.ok(result.ok);
  const after = result.value.split("\n");

  assert.equal(after.length, before.length, "no line was added or lost");
  const moved = before.filter((line, i) => line !== after[i]).length;
  // Eight, not nine: the answers include market "jp", which is what the
  // template already says, so that line is rewritten to its own value.
  assert.equal(moved, 8, `expected the 8 answered lines to change, ${moved} did`);
});

test("a quote in an answer cannot end the string it is inside", () => {
  // The one input that turns a generated config into a syntax error, or worse
  // into a different key. It arrives from a browser form, so it will happen.
  const result = generateConfig(template(), answers({ ventureName: 'あの "名前" です', persona: 'バック\\スラッシュ' }));
  assert.ok(result.ok, result.ok ? "" : result.error.message);

  const { config } = buildConfig(result.value, "platform.config.yaml", {});
  assert.equal(config.ventures[0]?.name, 'あの "名前" です');
  assert.equal(config.ventures[0]?.voice.persona, "バック\\スラッシュ");
});

test("every problem in the form is reported at once", () => {
  const result = generateConfig(template(), answers({ companyName: "", ventureId: "Cosme Shop", market: "de" }));
  assert.ok(!result.ok);
  const message = result.error.message;
  assert.match(message, /会社の名前/);
  assert.match(message, /id/);
  assert.match(message, /jp/, "the markets it could have picked are named");
});

test("an id that cannot be changed later is held to a shape that survives", () => {
  for (const bad of ["Cosme", "コスメ", "-cosme", "cosme-", "c", "a".repeat(41)]) {
    const result = generateConfig(template(), answers({ ventureId: bad }));
    assert.ok(!result.ok, `"${bad}" should be refused as a venture id`);
  }
  for (const good of ["cosme", "cosme-jp", "ai-tools", "a1"]) {
    const result = generateConfig(template(), answers({ ventureId: good }));
    assert.ok(result.ok, `"${good}" should be accepted`);
  }
});

test("a newline in an answer is refused rather than written into the file", () => {
  // It would end the YAML line and leave the rest of the answer standing where
  // a key belongs - a config that fails to load for a reason nobody can see.
  const result = generateConfig(template(), answers({ audience: "30代\nactive: false" }));
  assert.ok(!result.ok);
  assert.match(result.error.message, /改行/);
});

test("the tracking address is left alone unless one is given", () => {
  const kept = generateConfig(template(), answers());
  assert.ok(kept.ok);
  assert.match(kept.value, /example\.invalid/, "the placeholder stays, and doctor keeps reporting it");

  const set = generateConfig(template(), answers({ trackingBaseUrl: "https://amp-midori.example.workers.dev" }));
  assert.ok(set.ok);
  assert.doesNotMatch(set.value, /example\.invalid/);
  assert.match(set.value, /baseUrl: "https:\/\/amp-midori\.example\.workers\.dev"/);

  const bad = generateConfig(template(), answers({ trackingBaseUrl: "amp-midori.workers.dev" }));
  assert.ok(!bad.ok, "a bare hostname is not a URL a reader can follow");
});

test("an anchor that no longer exists is an error naming the line, not a silent skip", () => {
  // The failure this file exists to make loud: the example config is edited,
  // the wizard can no longer find the line, and a licensee gets a config with
  // somebody else's niche in it.
  const reworded = template().replace('\n  name: "ひとり運用カンパニー"', '\n  name: "My Company"');
  const result = generateConfig(reworded, answers());
  assert.ok(!result.ok);
  assert.equal(result.error.code, "setup.anchor_lost");
  assert.match(result.error.message, /companyName/);
  assert.match(result.error.message, /platform\.config\.example\.yaml/, "the message names the file to fix");
});

test("a market no shipped offer permits is refused, and the message names the real fix", () => {
  // Not an oversight - a guardrail. The template's one offer is permitted in jp
  // only, and a venture may not promote an offer outside its targetMarkets. The
  // wizard could widen that list; it must not, because the list is transcribed
  // from the network's contract and this form is not where a territory is
  // granted. So it refuses, and says where the decision actually lives.
  const result = generateConfig(template(), answers({ market: "us" }));
  assert.ok(!result.ok, "us has no offer permitting it in the shipped config");
  assert.equal(result.error.code, "setup.invalid_answers");
  assert.match(result.error.message, /契約から転記/, "it says why the form cannot decide this");
  assert.doesNotMatch(result.error.message, /defect/, "this is the licensee's choice to change, not our bug");
});
