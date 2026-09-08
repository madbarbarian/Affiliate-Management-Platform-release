# 運用者の2つの判断 — 画面設計

要件定義（`docs/1-requirements/requirements.md` の「体験の接点」）で最初に挙げた、
**人間が1日に2回だけ行う判断**の画面。ここが遅ければ、あとの自動化に意味がない。

公開版（Claude Design のキャンバス）:
<https://claude.ai/code/artifact/d1e2d79a-bf60-44c5-a252-73b430bcf6bb>

## 5枚

| ファイル | 画面 | 状態 |
|---|---|---|
| `Main.dc.html` | ① 企画の承認 | 動く（選ぶ・畳む・承認する） |
| `Publish.dc.html` | ② 投稿の承認と順番 | 動く（選ぶ・並べ替える・予約する） |
| `PlanDetail.dc.html` | ①の詳細 — 根拠と失敗の仕方 | 静止 |
| `PostDetail.dc.html` | ②の詳細 — 本文・指摘・コメント下書き | 静止 |
| `Idle.dc.html` | 判断待ちなし（週の大半はこれ） | 静止 |
| `Portfolio.dc.html` | 全アカウント — 状態・見直し候補・非アクティブにする／再開する | 静止 |
| `Proposals.dc.html` | 探索の提案 — 採用／見送り、採用後の追記の案内 | 静止 |

`canvas.json` が配置と付箋を持つ。右の2枚（全アカウント、探索の提案）は日課ではなく週に1回の
画面で、実装では承認画面の同じページの判断待ちの**下**に節として付く
（`docs/3-development/exploration-design.md`）。

**要件・承認画面・用語を変えたら、このキャンバスも変える。** ルールは `CLAUDE.md` の Conventions にある。

## 設計上の決めごと

- **トークンは承認画面（`src/console/ui.ts`）からの写し**であって、近似ではない。
  `--bg: #fbfbfa` / `--accent: #2f6f4f` / カード角丸 10px / チップ 999px /
  `15px/1.65 ui-sans-serif, -apple-system, "Hiragino Sans", "Noto Sans JP"`。
  この設計が実装に落ちるとき、CSS を書き直さずに済む。
- **推奨3件は最初からチェック済み**で、残り7件は畳んである。そのまま押せば30秒で終わる。
  疑ったときだけ開く。10案を平等に並べると、30秒では終わらない。
- **枠の時刻は動かせない。** 投稿担当が実測から決めたもの。人間が動かせるのは
  「どれを、どの枠に」だけなので、並べ替えると時刻が付け替わる。
- **詳細画面にも編集はない。** 書き直させた瞬間、人間の仕事は2つでなくなる。
  直したいときは、その投稿を外して明日の企画で言い直す。
- **「判断待ちなし」に会社の動きを出す。** 週の大半はこの画面で、何もないとだけ
  出されると、動いているのか止まっているのか分からない。

## 作り直しかた

`.dc.html` は Claude Design のコンポーネント形式（`<x-dc>` ・ `{{hole}}` ・
`sc-for` / `sc-if` ・ `DCLogic`）。素の HTML ではない。

```bash
cd docs/_drafts/design
node "<design skill>/seed-canvas.mjs" \
  --template "<design skill>/payload.template.html" \
  --out operator-two-decisions.html \
  --title "運用者の2つの判断" \
  --artboard Main.dc.html --artboard Publish.dc.html \
  --artboard PlanDetail.dc.html --artboard PostDetail.dc.html \
  --artboard Idle.dc.html --artboard Portfolio.dc.html --artboard Proposals.dc.html \
  --canvas canvas.json
```

出力の `operator-two-decisions.html` は 2.5MB のエディタ同梱ページなので、
コミットしない（`.gitignore` 済み）。上のリンクに再公開する。
