/**
 * Demo answers for the mock provider.
 *
 * A dry run whose research role cites imaginary post ids teaches an operator
 * nothing - every pattern gets dropped as hallucinated and the playbook stays
 * empty, which is exactly the opposite of what they need to see. These
 * handlers read the ids the platform actually put in the prompt and answer
 * with them, so `--dry-run` walks the full loop: patterns get created, ideas
 * cite them, drafts carry real links, and the console shows something a person
 * can read and approve.
 *
 * The text is obviously placeholder. That is deliberate - nobody should
 * mistake a dry run for the real thing.
 */

import type { LlmJsonRequest, LlmRequest } from "./provider.ts";
import type { MockHandler } from "./mock.ts";

const DEMO_PATTERNS = [
  {
    name: "失敗の告白から入る型",
    kind: "hook",
    template: "{期間}かけて{やったこと}、結局{失敗}した。原因は{一つの理由}。",
    whyItWorks:
      "一行目が損失の告白なので、読み手は「自分も同じことをしていないか」を確かめたくなる。損失回避が働いて、スクロールが止まる。",
  },
  {
    name: "数字で殴る型",
    kind: "hook",
    template: "{具体的な数字}を{期間}続けた結果を、正直に置いておきます。",
    whyItWorks: "冒頭に検証可能な数字があると、主張ではなく記録として読まれる。反論より確認の動機が先に立つ。",
  },
  {
    name: "定説をひっくり返す型",
    kind: "structure",
    template: "{よく言われる助言}、{特定の読者}には逆効果でした。理由は{一つの理由}。",
    whyItWorks: "読者が既に持っている前提と衝突するので、否定するために最後まで読む必要が生まれる。",
  },
];

const DEMO_IDEAS = [
  {
    title: "自動化ツールを3つ捨てた話",
    angle: "増やすほど遅くなった。残したのは1つだけで、それも用途を絞った。",
    targetPain: "ツールを増やしたのに、むしろ管理に時間を取られている",
    promisedOutcome: "何を残して何を捨てるかの判断基準が1つ手に入る",
    risk: "ツール名を出すと単なる比較記事に読まれ、体験談としての強度が落ちる",
  },
  {
    title: "朝30分の作業をやめた3週間",
    angle: "習慣化の話ではなく、やめてみて初めて分かった効果の話にする。",
    targetPain: "続けているが、効果があるのか分からない習慣がある",
    promisedOutcome: "効果測定できない習慣の切り分け方",
    risk: "「やめた」だけで終わると読後に何も残らない",
  },
  {
    title: "見積もりを2倍にしたら仕事が増えた",
    angle: "値上げの話ではなく、期待値の設計の話として書く。",
    targetPain: "安く受けているのに評価されない",
    promisedOutcome: "価格ではなく前提の合わせ方が変わる",
    risk: "再現性がないと読まれると、ただの自慢になる",
  },
];

export function createDemoHandlers(): Record<string, MockHandler> {
  return {
    "research.extract_patterns": (request) => {
      const swipeIds = matchAll(userText(request), /\[(swipe_[A-Za-z0-9_]+)\]/g);
      const patterns = DEMO_PATTERNS.slice(0, Math.max(1, Math.min(3, Math.ceil(swipeIds.length / 8)))).map(
        (pattern, index) => ({
          ...pattern,
          // Cite real ids so the platform's own "did this evidence exist?"
          // check passes, and the playbook actually fills up in a dry run.
          supportingItemIds: swipeIds.slice(index * 2, index * 2 + 2),
          mergesIntoExistingPattern: "",
        }),
      );
      return {
        summary: "[demo] 収集した投稿から再現性のありそうな型を抽出しました。これはモック応答です。",
        discardedCount: Math.max(0, swipeIds.length - patterns.length * 2),
        patterns: patterns.filter((pattern) => pattern.supportingItemIds.length > 0),
      };
    },

    "scout.propose": (request) => {
      const text = userText(request);
      const marketIds = matchAll(text, /\[market:([A-Za-z0-9_-]+)\]/g);
      const offerIds = matchAll(text, /\[(offer_[A-Za-z0-9_]+)\]/g);
      const requested = Number(/exactly (\d+) new accounts/.exec(text)?.[1] ?? 2);
      const market = marketIds[0] ?? "jp";
      return {
        proposals: Array.from({ length: Math.max(1, Math.min(requested, 5)) }, (_, index) => ({
          niche: `[demo] 育児とテクノロジー（案${index + 1}）`,
          audience: "[demo] 0〜3歳の子を育てながら在宅で働く親",
          market,
          language: "ja",
          category: "productivity",
          ventureId: `demo-explore-${index + 1}`,
          nameCandidates: ["寝かしつけ後の30分", "片手で回す家", "育休明けの手帳"],
          voice: { persona: "[demo] 二児の親。失敗談から入る", firstPerson: "私", tone: ["率直", "少し自嘲"] },
          // Cite a real offer id so the platform's own "does this exist and is
          // it permitted here?" check has something to pass.
          offerIds: offerIds.slice(0, 1),
          hypothesis:
            "[demo] 既存アカウントで「失敗の告白から入る型」が最も強い。育児という別の読者でも損失回避は同じに働くはず。これはモック応答です。",
          evidence: "[demo] 既存アカウントの集計を引いた想定。",
          risk: "[demo] 育児カテゴリは共感が強い分、案件を出した瞬間に離脱される。",
          firstHooks: ["[demo] 寝かしつけに3時間かけていた頃の話。", "[demo] 育休明け1週目でやめたこと。", "[demo] 片手で使えないアプリは全部消した。"],
          killSignal: "[demo] 30日で中央値が既存アカウントの最下位を下回る、または保存が20本で0件。",
        })),
      };
    },

    "plan.ideas": (request) => {
      const text = userText(request);
      const patternIds = matchAll(text, /\[(pat_[A-Za-z0-9_]+)\]/g);
      const offerIds = matchAll(text, /\[(offer_[A-Za-z0-9_]+)\]/g);
      const requested = Number(/exactly (\d+) posts/.exec(text)?.[1] ?? 3);
      const count = Math.max(1, Math.min(requested, 10));

      return {
        ideas: Array.from({ length: count }, (_unused, index) => {
          const base = DEMO_IDEAS[index % DEMO_IDEAS.length] as (typeof DEMO_IDEAS)[number];
          return {
            ...base,
            title: index < DEMO_IDEAS.length ? base.title : `${base.title}（案${index + 1}）`,
            rationale: `[demo] ${patternIds[index % Math.max(1, patternIds.length)] ?? "型なし"} の実績にもとづく想定。`,
            expectedEngagement: 400 - index * 25,
            patternId: patternIds[index % Math.max(1, patternIds.length)] ?? "",
            // Roughly a third carry an offer, matching the planning brief.
            offerId: index % 3 === 0 ? (offerIds[0] ?? "") : "",
            rank: index + 1,
          };
        }),
      };
    },

    "write.draft": (request) => {
      const text = userText(request);
      const title = /- Title: (.*)/.exec(text)?.[1]?.trim() ?? "デモ投稿";
      const link = /link to use: (\S+)/.exec(text)?.[1];
      const disclosure = /disclosure when an offer is attached: (.*)/.exec(text)?.[1]?.trim() ?? "";
      const hasOffer = Boolean(link && !link.startsWith("(no"));
      return {
        hook: `[demo] ${title}。3週間で分かったことを1つだけ置いていきます。`,
        body:
          "[demo] これはモック応答です。実際の運用では、ここに一人称の体験談が入ります。\n\n" +
          "最初の2週間はうまくいきませんでした。原因は道具ではなく、記録を取っていなかったことでした。\n\n" +
          "短い。ここで詰まった。",
        cta: "同じところで詰まった人、どこで抜けましたか。",
        disclosure: hasOffer ? disclosure : "",
        hashtags: [],
        threadParts: [],
      };
    },

    "inspect.review": (request) => {
      const text = userText(request);
      const hook = /HOOK: (.*)/.exec(text)?.[1]?.trim() ?? "";
      const body = section(text, "HOOK:", "CTA:");
      const cta = /CTA: (.*)/.exec(text)?.[1]?.trim() ?? "";
      const disclosure = /DISCLOSURE: (.*)/.exec(text)?.[1]?.trim() ?? "";
      const firstPerson = /- First person: (.*)/.exec(text)?.[1]?.trim() ?? "僕";
      return {
        // A first draft that reads a little synthetic, cleaned up by the
        // rewrite. Only the second number is held against the limit.
        aiSmellScore: 48,
        revisedAiSmellScore: 22,
        findings: [
          {
            severity: "note",
            code: "voice.demo",
            message: "[demo] モックの検品です。実運用では別モデルが実際に書き直します。",
            excerpt: "",
            suggestion: "",
          },
        ],
        revised: {
          // Make the one edit the heuristic actually checks for, so a dry run
          // demonstrates the rewrite rather than a no-op.
          hook: hook.includes(firstPerson) ? hook : `${firstPerson}が${hook}`,
          body: body.includes(firstPerson) ? body : `${firstPerson}の話です。\n\n${body}`,
          cta,
          disclosure: disclosure === "(none)" ? "" : disclosure,
          hashtags: [],
          threadParts: [],
        },
        unfixable: "",
      };
    },

    "schedule.comments": (request) => {
      const link = /link to use: (\S+)/.exec(userText(request))?.[1];
      const comments: { purpose: string; text: string }[] = [
        { purpose: "self_reply", text: "[demo] 本文に入らなかった具体的な数字をここに置きます。" },
        { purpose: "objection", text: "[demo] 「それは環境が良かっただけでは」への返答をここに。" },
      ];
      if (link && !link.startsWith("(no")) {
        comments.splice(1, 0, {
          purpose: "link_drop",
          text: `[demo] 使ったのはこれです。無料枠があるので、まず試すのがおすすめ。\n${link}`,
        });
      }
      return { comments };
    },

    "analyze.summary": () => ({
      summary: "[demo] モック分析です。実運用ではここに実データの読みが入ります。",
      stopDoing: "",
      tryNext: "[demo] 未検証の型を1本試す。",
    }),
  };
}

function userText(request: LlmJsonRequest | LlmRequest): string {
  return request.user;
}

function matchAll(text: string, pattern: RegExp): string[] {
  return [...new Set([...text.matchAll(pattern)].map((match) => match[1] as string))];
}

function section(text: string, from: string, to: string): string {
  const start = text.indexOf(from);
  const end = text.indexOf(to);
  if (start === -1 || end === -1 || end <= start) return text.slice(0, 400);
  return text
    .slice(start + from.length, end)
    .split("\n")
    .slice(1)
    .join("\n")
    .trim();
}
