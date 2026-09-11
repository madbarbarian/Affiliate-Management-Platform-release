# ライセンシーの最初の1時間 — 画面設計

設計の根拠と全ステップは [`docs/2-setup/onboarding.md`](../../../2-setup/onboarding.md)。
ここはその画面。

公開版: <https://claude.ai/code/artifact/8a16e852-648e-4a75-94cf-a0dcb775ba5c>

| ファイル | 画面 |
|---|---|
| `Main.dc.html` | 全体 — 9ステップと、2〜5が資格情報ゼロで進むこと |
| `Deploy.dc.html` | 1 メールのボタン。名前と合言葉だけ。モデルの鍵は「あとで」 |
| `Voice.dc.html` | 3 文体を決める → その場で3行出る |
| `Swipe.dc.html` | 4 参考投稿を5つ貼る（初日から手がかりを持って始めるため） |
| `Dryrun.dc.html` | 5 1日を通す。ここでやめられる |
| `Paste.dc.html` | 6 できた設定を自分の控えに貼る。承認画面は設定を書き換えない |
| `Connect.dc.html` | 8 投稿先（Threads）をつなぐ。いちばんつまずきやすい場所 |
| `Offer.dc.html` | 9 案件。越境で必須項目が増える理由をその場で |
| `Ready.dc.html` | 最後の確認。計測は初日から閉じている／合言葉を空にしない／更新を受け取る口を1回だけ作る |

**旧ステップ9（リンクのドメインを用意する）は消えた。** `workers.dev` の
アドレスが無料で公開されるため。詳しくは
[Cloudflare で動かす設計](../../../3-development/cloudflare-design.md)。

トークンは承認画面（`src/console/ui.ts`）からの写し。

## 作り直しかた

```bash
cd docs/_drafts/design/onboarding
node "<design skill>/seed-canvas.mjs" \
  --template "<design skill>/payload.template.html" \
  --out licensee-onboarding.html --title "ライセンシーの最初の1時間" \
  --artboard Main.dc.html --artboard Deploy.dc.html --artboard Voice.dc.html \
  --artboard Swipe.dc.html --artboard Dryrun.dc.html --artboard Paste.dc.html \
  --artboard Connect.dc.html --artboard Offer.dc.html --artboard Ready.dc.html \
  --canvas canvas.json
```
