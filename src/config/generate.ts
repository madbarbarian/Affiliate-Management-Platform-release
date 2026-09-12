/**
 * Filling the shipped example config from a handful of answers.
 *
 * The licensee's first hour used to begin by opening a 428-line YAML file, and
 * `docs/2-setup/onboarding.md` names that moment as where most people stop. This
 * is the generator that replaces it: a few questions in a browser, and the same
 * file comes out with their words in it.
 *
 * **It edits text, it does not serialise an object.** Most of those 428 lines
 * are comments explaining why each value is what it is, and parsing the file
 * into an object and writing it back would delete every one of them - which is
 * the reason `onboarding.md` gives for the console never becoming an editor for
 * this file. So each answer replaces exactly one line, anchored on the line the
 * example ships with, and everything around it survives untouched.
 *
 * That anchoring is the fragile part, and it fails loudly on purpose: editing
 * `platform.config.example.yaml` can silently make an anchor unfindable, so a
 * missing one is an error naming the line, and a test holds every anchor against
 * the real file.
 */

import { fail, ok, type PlatformError, type Result } from "../core/result.ts";
import { buildConfig } from "./load.ts";
import { parseYaml } from "./yaml.ts";

export type SetupAnswers = {
  readonly companyName: string;
  /**
   * Whose name goes against every approval in the audit trail.
   *
   * Asked here rather than left at the example's `owner`, which is truthful for
   * a single operator but says nothing the day a second one is added - and by
   * then the record cannot be rewritten.
   */
  readonly operatorName: string;
  readonly ventureId: string;
  readonly ventureName: string;
  readonly niche: string;
  readonly audience: string;
  /** Which market's rules the readers are under. Must be an id the template defines. */
  readonly market: string;
  readonly persona: string;
  readonly firstPerson: string;
  /**
   * Where the tracking links point. Empty leaves the example's placeholder, which
   * is a hostname that does not resolve - correct while nothing is published yet,
   * and caught by `doctor` and the console's measurement check once it is.
   */
  readonly trackingBaseUrl?: string;
};

/**
 * One answer's destination: the exact line the example ships, and how to write
 * the replacement. `find` has to match exactly once in the template.
 */
type Anchor = {
  readonly field: keyof SetupAnswers;
  readonly find: string;
  readonly write: (value: string) => string;
};

const ANCHORS: readonly Anchor[] = [
  { field: "companyName", find: '\n  name: "ひとり運用カンパニー"', write: (v) => `\n  name: ${quote(v)}` },
  // The example interpolates an env var with "owner" as its default. A name
  // typed here replaces the whole expression: a licensee who never sets
  // AMP_OPERATOR would otherwise still be "owner" whatever they answered.
  { field: "operatorName", find: '\n  operator: "${AMP_OPERATOR:-owner}"', write: (v) => `\n  operator: ${quote(v)}` },
  { field: "ventureId", find: "\n  - id: ai-tools", write: (v) => `\n  - id: ${v}` },
  { field: "ventureName", find: '\n    name: "AI仕事術"', write: (v) => `\n    name: ${quote(v)}` },
  { field: "niche", find: '\n    niche: "', write: (v) => `\n    niche: ${quote(v)}` },
  { field: "audience", find: '\n    audience: "', write: (v) => `\n    audience: ${quote(v)}` },
  { field: "market", find: "\n    market: jp", write: (v) => `\n    market: ${v}` },
  { field: "persona", find: '\n      persona: "', write: (v) => `\n      persona: ${quote(v)}` },
  { field: "firstPerson", find: '\n      firstPerson: "', write: (v) => `\n      firstPerson: ${quote(v)}` },
];

/** Fields whose anchor matches only the start of the line, so the rest of it is dropped. */
const TO_END_OF_LINE = new Set<keyof SetupAnswers>(["niche", "audience", "persona", "firstPerson"]);

export function generateConfig(
  template: string,
  answers: SetupAnswers,
  env: NodeJS.ProcessEnv = {},
): Result<string, PlatformError> {
  const problems = validate(template, answers);
  if (problems.length > 0) {
    return fail("config", "setup.invalid_answers", problems.join("\n"), { details: { problems } });
  }

  let out = template;
  for (const anchor of ANCHORS) {
    const value = answers[anchor.field];
    if (value === undefined) continue;
    const first = out.indexOf(anchor.find);
    if (first === -1 || out.indexOf(anchor.find, first + 1) !== -1) {
      return fail(
        "config",
        "setup.anchor_lost",
        `The setup form cannot fill "${anchor.field}": the line it replaces is no longer unique in ` +
          `platform.config.example.yaml. Restore the line "${anchor.find.trim()}" there, or update ANCHORS ` +
          `in src/config/generate.ts to match the line that took its place.`,
        { retryable: false, details: { field: anchor.field } },
      );
    }
    const end = TO_END_OF_LINE.has(anchor.field)
      ? indexOfLineEnd(out, first + 1)
      : first + anchor.find.length;
    out = out.slice(0, first) + anchor.write(value) + out.slice(end);
  }

  if (answers.trackingBaseUrl) {
    const found = out.match(/\n {2}baseUrl: .*/);
    if (!found) {
      return fail(
        "config",
        "setup.anchor_lost",
        `The setup form cannot fill "trackingBaseUrl": no "  baseUrl:" line in ` +
          `platform.config.example.yaml. Restore it, or update src/config/generate.ts.`,
        { retryable: false, details: { field: "trackingBaseUrl" } },
      );
    }
    // A function replacement, because a string one expands $& and $' - a URL
    // carrying either would splice part of the file back into itself.
    out = out.replace(found[0], () => `\n  baseUrl: ${quote(answers.trackingBaseUrl as string)}`);
  }

  // The whole point of generating rather than instructing is that what comes out
  // is known to load. Anything that reaches here and does not parse is our bug,
  // not the licensee's, and they would meet it as a Worker that will not boot.
  try {
    buildConfig(out, "platform.config.yaml", env);
  } catch (error) {
    return fail(
      "config",
      "setup.generated_invalid",
      `The generated configuration did not load: ${error instanceof Error ? error.message : String(error)}. ` +
        `This is a defect in the setup form, not in what you typed - please report it.`,
      { retryable: false },
    );
  }
  return ok(out);
}

function validate(template: string, answers: SetupAnswers): string[] {
  // Every problem at once: this is a form, and sending someone back for a second
  // field they could have fixed in the same pass is the same failure the config
  // loader avoids by collecting.
  const problems: string[] = [];

  const text = (field: keyof SetupAnswers, label: string, max: number): void => {
    const value = answers[field];
    if (value === undefined || value.trim() === "") {
      problems.push(`${label}を入れてください。`);
      return;
    }
    if (value.length > max) problems.push(`${label}は${max}文字までにしてください（いまは${value.length}文字）。`);
    // A newline would end the YAML line and leave the rest of the answer as a
    // stray key; a control character survives into every generated post.
    if (/[\u0000-\u001f\u007f]/.test(value)) problems.push(`${label}に改行や制御文字は使えません。`);
  };

  text("companyName", "会社の名前", 60);
  text("operatorName", "あなたのお名前", 40);
  text("ventureName", "アカウントの名前", 60);
  text("niche", "何について書くアカウントか", 200);
  text("audience", "読者像", 400);
  text("persona", "書き手の人物像", 400);
  text("firstPerson", "一人称", 20);

  // Written into every stored record and into the console's address, and the
  // example config says it cannot be changed afterwards - so it is held to the
  // shape that survives both.
  if (!/^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/.test(answers.ventureId)) {
    problems.push(
      "アカウントの id は、半角の英小文字・数字・ハイフンで、2文字以上40文字以下にしてください" +
        "（先頭と末尾はハイフン以外）。あとから変えられないので、何のアカウントか分かる名前にしてください。",
    );
  }

  // Not every market the template defines can be picked here, and the reason is
  // a guardrail rather than an oversight: an offer carries the markets its
  // network's contract permits, and a venture may only promote an offer that
  // permits its own market. The template ships one offer, permitted in jp.
  //
  // The wizard could "fix" that by widening the offer's targetMarkets. It must
  // not. That list is transcribed from a contract, and a setup form editing it
  // is the platform granting itself a territory nobody agreed to - which is the
  // failure "compliance follows the audience" exists to prevent. So the form
  // offers what the shipped offers allow, and says what adding a market takes.
  const offered = marketsWithAnOffer(template);
  if (!offered.includes(answers.market)) {
    problems.push(
      `読者のいる市場は ${offered.join(" / ")} のいずれかにしてください。` +
        `他の市場に出すには、その市場を ${"targetMarkets"} に含む案件が要ります。` +
        `案件の対象市場はASPとの契約から転記するもので、この画面では決められません` +
        `（設定ファイルの offers: を直接編集してください）。`,
    );
  }

  if (answers.trackingBaseUrl) {
    let url: URL | undefined;
    try {
      url = new URL(answers.trackingBaseUrl);
    } catch {
      url = undefined;
    }
    // http is allowed only for a local host, because `wrangler dev` serves on
    // http://localhost:8787 and that path is in deploy-checklist.md. A remote
    // http address would send every reader's click over the clear.
    const local = url ? /^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname) : false;
    if (!url || (url.protocol !== "https:" && !(url.protocol === "http:" && local))) {
      problems.push("リンクのアドレスは https:// から始まる URL にしてください。");
    }
    // A newline survives the URL parser, which strips it - so the value that
    // reaches the file is not the value that was validated.
    if (/[\u0000-\u001f\u007f]/.test(answers.trackingBaseUrl)) {
      problems.push("リンクのアドレスに改行や制御文字は使えません。");
    }
  }

  return problems;
}

/**
 * Which markets the template's own offers can actually be promoted in.
 *
 * Read from the parsed template rather than matched with a regex, because a
 * commented-out offer must not count: the file ships two of them commented out,
 * and offering a market whose only offer is a comment produces a config that
 * fails to load with an error about a venture nobody edited.
 */
export function marketsWithAnOffer(template: string): string[] {
  let document: unknown;
  try {
    document = parseYaml(template);
  } catch {
    return [];
  }
  const offers = (document as { offers?: unknown }).offers;
  if (!Array.isArray(offers)) return [];

  const permitted = new Set<string>();
  for (const offer of offers) {
    const entry = offer as { active?: unknown; targetMarkets?: unknown };
    if (entry.active === false) continue;
    if (!Array.isArray(entry.targetMarkets)) continue;
    for (const market of entry.targetMarkets) {
      if (typeof market === "string") permitted.add(market);
    }
  }
  return [...permitted].sort();
}

/** A double-quoted YAML scalar. Only `\\` and `"` need escaping on one line. */
function quote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function indexOfLineEnd(text: string, from: number): number {
  const next = text.indexOf("\n", from);
  return next === -1 ? text.length : next;
}
