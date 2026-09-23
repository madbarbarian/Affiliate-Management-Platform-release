# Changelog

All notable changes to this platform. Written for someone who already has a
running operation and one question: *will merging this break my morning?*

The format is [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html) as
seen from a licensee's config: a **major** release is one where an existing
`platform.config.yaml` stops validating.

## [Unreleased]

## [0.11.0] - 2026-09-23

**既存の `platform.config.yaml` はそのまま通ります。** 設定は増えていません。
`prompts/` も変えていません。**公開される文面も変わりません。**
**更新の仕組みの貼り替えも要りません。**

### Fixed

- 🔴 **アカウントを切り替えた直後に「今日のサイクルを動かす」を押すと、
  別のアカウントが動くことがありました。**

  画面は、アカウントの情報を取りに行ってから描きます。その**取りに行っている間に別の
  アカウントへ移ると、あとから返ってきた古いほうが画面を上書き**していました。
  URL は新しいアカウントなのに、中身は前のアカウント、という状態です。

  そしてそのカードの「動かす」ボタンは、**前のアカウント**を指していました。
  押すと**そちらの1日が動きます。**表示の問題ではなく、**選んでいないアカウントの仕事が
  始まる**欠陥でした。

  画面を描く前に「いま見ているのは本当にこのアカウントか」を必ず確かめるようにしました。
  ボタンを押した瞬間にも同じ確認をします。

- **「この日を見る」でも同じことが起きていました。**最初の日付の結果が返る前に別の日付を
  押すと、遅いほうが速いほうを上書きしていました。アカウントを切り替える必要すらなく、
  **2回押すだけ**で起きます。同じ確認を入れました。

- **動いている版が、画面のどこにも出ていませんでした。**
  「いまお使いなのは …」は**更新があるときにしか出ない**ので、最新の方は一度も見られませんでした。
  **設定画面のいちばん上**に出るようにしました。

### Added

- **非常停止から、画面で戻れるようになりました。**

  これまで、全体が停止した状態から戻す手段が画面にありませんでした。停止中の赤い箱には
  **「全体を再開する」**が出ます。押す前に、**いつ・どこから・なぜ止まったか**が表示され、
  確認を挟みます。**誰かが理由があって止めたものを、知らずに解除しないため**です。

  停止が「ファイルが読めなくて止まった」場合は、**そうと分かる文面**に変わります。
  誰かが止めたわけではないので、読む意味がまったく違います。

  🔴 **見えていない停止を消さないようにしてあります。**状態がその瞬間だけ読めないときにも
  画面は「全体を止めています」と出ます。そこで再開を押すと、**記録されていたのに読めなかった
  停止まで消えてしまう**可能性がありました。押されたら必ず読み直し、**それでも読めなければ
  何も書き換えず**、その旨を表示します。

  **一時停止する手段は、まだ画面にありません。**この版で増えたのは戻る側だけです。

### Changed

- **「直近の数字」を「全アカウント合計 — 直近◯日」に変えました。**すぐ下の表と
  同じ言い方に揃えています。中身は変わりません。


## [0.10.0] - 2026-09-22

**既存の `platform.config.yaml` は、Amazon の案件を足していなければそのまま通ります。**
`prompts/` は変えていません。**更新の仕組みの貼り替えは要りません。**

🔴 **公開される文面が変わります。**投稿の本文に入るリンクが、これまでの「販売元へ直接」から
**あなたのリダイレクト（`/go/<code>`）**に変わります。下の1件目を読んでください。

### Fixed

- 🔴 **投稿の本文に入っていたリンクが、初版からずっと「販売元へ直接」でした。**
  **つまり、本文のリンクから来たクリックは、一度も数えられていません。**

  コメントに入るリンクは正しく `/go/` でした。本文だけが違いました。原因は、文面を
  最終的に書き直す担当だけが、渡されるリンクを間違えていたことです。書き直しは本文全体に
  かかるので、その前に正しく入っていたリンクも上書きされていました。

  **あなたの側でやることはありません。**次に作られる投稿から、本文のリンクも数えられます。
  **過去の投稿は遡って直りません**（すでに公開された文面は変わりません）。報酬そのものは
  ASP 側で記録されているので、失われていたのは「どの投稿が効いたか」という情報です。

  あわせて、**本文にもコメントにも、販売元への直接リンクが出ていないかを毎回検査する**ように
  しました。検査は文面を書き直したあとに走ります。

- 🔴 **画面の時刻が、あなたの時計でも UTC の表示でもありませんでした。**
  東京のアカウントの 07:30 の枠が、画面では「前日 22:30」と出ていました。ニューヨークで
  開いても同じ文字列が出ていました。**つまり、誰にとっても間違っていました。**

  時刻はアカウントの時計で出し、**必ずその時計の名前を添える**ようにしました
  （`2026-09-22 07:30（日本標準時）`）。夏時間は夏時間と名乗ります。

- **「直近の数字」が、実は全期間の合計でした。**すぐ下の「全アカウント — 直近30日」だけが
  正しく30日で区切っていて、同じ画面の隣り合う2つが別のものを数えていました。
  同じ30日に揃えました。

  **「エンゲージ合計」は外しました。**年齢の違う投稿のエンゲージを足した数字は、
  「いつ投稿したか」で決まってしまい、どう直しても正直になりません。5つが4つになります。

- **手渡しの投稿で、コメントがどれも「最初のコメント」と名乗っていました。**
  3つ出ても3つとも「最初の」でした。`コメント 2/3：リンクの案内` のように、
  **番号と役割**が出るようになりました。
  **貼る順番も画面に出ます** — 本文のつなぎ方、コメントをどれにぶら下げるか、
  そして**リンクの案内を出さないとその投稿の報酬が記録されないこと**。

- **予約中の投稿の「状態」が英語のままでした**（`scheduled` など）。日本語になりました。

- **停止中の画面が、端末で打つコマンドを案内していました。**あなたには端末がありません。
  実際にできることだけを言うようにしました。**再開の手段そのものは、まだありません**
  （次の版で入ります）。

- **うまくいかなかったときの表示に、内部用の英語がそのまま出ていました。**
  日本語で、何が起きたかを言うようにしました。

### Added

- **判断待ちの画面が、「推奨」と「そのほかの N 件」に分かれます。**
  これまでは10件が同じ重さで平らに並んでいました。推奨は開いた状態で最初から選ばれており、
  残りは畳んであります。**そのまま押せば終わります。**別の案を選べば、その案は必ず見える側に出ます。

- 🔴 **Amazon の商品ページを指す案件を、設定の読み込みで止めるようにしました。**

  **これまでは、足しても何も起きませんでした。**設定は通り、リンクは発行され、投稿も出て、
  **報酬だけが1円も入りませんでした。**画面のどこにもその理由は出ませんでした。

  Amazon アソシエイトの規約は、**リダイレクトを経由したリンク紹介を禁じています**。
  このプラットフォームは全てのリンクを `/go/<code>` に通すので、**構造的に両立しません。**
  料率表は、そうして到達した購入を**成果報酬の対象から除外**します。
  「集計されない」のではなく、**報酬そのものが没収されます。**

  **いま Amazon の案件を設定に足している場合、この版から設定が通らなくなります。**
  画面に日本語で、どの案件かと、どうすればよいか（その案件のブロックを削除するか
  `active: false` を足す）が出ます。**それ以外の設定は影響を受けません。**

  **リダイレクトを経由しない直リンクの仕組みは、まだありません。**入れるかどうかは検討中です。


## [0.9.1] - 2026-09-21

**既存の `platform.config.yaml` はそのまま通ります。** 設定は増えていません。
`prompts/` も変えていません。**公開される文面も変わりません。**
**更新の仕組みの貼り替えも要りません**（v0.9.0 で殻にしたので、この修正はそのまま届きます）。

### Fixed

- 🔴 **「今日のサイクルを動かす」と「承認」を押すと、画面が「動かしています…」のまま戻ってきませんでした。**
  **Cloudflare で動かしている場合だけ**で、**v0.7.0 から**そうでした。
  裏の処理は正しく終わっていて、読み込み直せば結果は出ていました。

  原因は、配る前にコードを変換する道具（wrangler）が、画面の「終わったか見張る」処理の中に
  補助の呼び出しを差し込むことでした。画面の側にはその補助が無いので、押して約24秒後に
  見張りがエラーで止まり、ボタンを元に戻す処理に二度と届きませんでした。
  手元で動かすときはこの変換が無いので、**v0.7.0 で直したと思っていたものが、
  Cloudflare では最初から動いていませんでした。**

  見張りの判定を、変換の影響を受けない形で持つようにしました。あわせて、**見張りが別の理由で
  止まっても、ボタンは必ず元に戻り、読み込み直すよう案内が出る**ようにしました。
  **動いていないのに「動いています」と言い続けることは、もうありません。**


## [0.9.0] - 2026-09-21

**既存の `platform.config.yaml` はそのまま通ります。** 設定は増えていません。
`prompts/` も変えていません。**公開される文面も変わりません。**

更新の仕組みを作り替えました。**貼り替えが1回要ります。そしてそれが最後です。**

### Changed

- 🔴 **更新の仕組みの貼り替えは、これが最後です。**
  いままでは、更新の仕組みそのものを直すたびに、あなたが手で貼り替える必要がありました。
  GitHub はワークフローに `.github/workflows/` を書かせないので、**仕組みは自分自身を更新できない**からです。
  今回、`.github/workflows/take-updates.yml` を**スクリプトを呼ぶだけの短いファイル**にし、
  中身を `scripts/take-updates.ts` に移しました。`scripts/` はほかの更新と一緒に届くので、
  **以後、更新の仕組みへの修正も貼り替えなしで届きます。** やることは今までと同じで、
  Actions タブの名前（*Take updates from the platform*）も変わりません。

  **やること（1回だけ）:** この版の Pull request を**マージしてから**、
  リポジトリ直下の `update-workflow.yml` の中身を `.github/workflows/take-updates.yml` に
  貼り替えてください。ブラウザで数分です（2026-09-21 に実際に測ったら、読む時間を含めて5分でした）。

  - **Pull request の本文には「これが最後」と書かれていません。** 本文を書くのは、
    いまあなたの控えで動いている古い仕組みだからです。**ここに書いてあることが正です。**
  - ⚠️ **貼らずにマージすると、この案内は二度と出ません。** 以後の更新ではこのファイルが
    変わらないので、「貼り替えてください」の節が付かなくなります。古い仕組みはそのまま動き続け、
    更新も届きますが、**更新の仕組みへの修正だけは、あなたの控えに届かないままになります。**
    貼り忘れに気づいたら、いつでも上の手順で貼れます。
  - **マージの前に貼ると、次の実行が赤で止まります。** 新しいファイルが呼ぶ
    `scripts/take-updates.ts` は、マージするまでリポジトリに無いからです。赤い実行の画面に
    理由が出ます。Pull request をマージすれば、貼ったファイルのまま動きます。

  **スクリプトへの修正は、運ばれた次の回から効きます。** 実行するのは、あなたがマージした版だけです。
  取ってきたばかりの、まだ誰も読んでいない版は、書き込みの権限つきでは動かしません。

  あわせて、`platform-update` ブランチからは実行しなくなりました。そのブランチにはマージ前の
  版が載っているので、そこから動かすと、読んでいない版を書き込みの権限つきで動かすことになるためです。

## [0.8.1] - 2026-09-21

**既存の `platform.config.yaml` はそのまま通ります。** 設定は増えていません。
`prompts/` も変えていません。**公開される文面も変わりません。**

更新の取り込みと、画面設計の開示文の修正です。

### Fixed

- 🔴 **更新の取り込みが、同じ Pull request を二度作ることがありました。**
  1回押しただけなのに、同じ内容の Pull request が2本出ます。
  GitHub 側が実行を**やり直した**ときに起きます — やり直しは最初に読んだときの
  状態を読み直すので、**あなたが1本目をマージした後でも、マージ前の状態から
  やり直してしまいます。**「もう最新です」で止まる判定をすり抜け、
  重複よけも「いま開いている Pull request があるか」しか見ていないため、
  直前にマージしたものが同じ内容を運んでいることに気づけませんでした。

  いつも**いまの状態**を読むようにしました。

  ⚠️ **あわせて、Cloudflare の Version History に、使われない版が1つ残らなくなります。**
  二度目の押し込みがプレビューを作っていたためで、**一覧の先頭に身に覚えのない
  新しい版が出て「更新が反映されていないのでは」と読めてしまう**原因でした。

  🔴 **この修正が効くには、1回だけ手作業が要ります。** GitHub はワークフローに
  `.github/workflows/` を書かせないので、**更新の仕組みは自分自身を更新できません。**
  次の更新の Pull request に「この Pull request にできない1つのこと」という節が付くので、
  そこに書いてあるとおり `update-workflow.yml` の中身を
  `.github/workflows/take-updates.yml` に貼り替えてください。ブラウザで2分です。

- **画面設計の資料に、実際とは違う開示文が載っていました。**
  `docs/_proposed/design/` の板5枚が `#PR 広告を含みます` と書いていましたが、
  このプラットフォームが実際に書くのは **`※PR・アフィリエイトリンクを含みます`** です。
  古くなった例が残っていたもので、**そのまま投稿に写すと、このプラットフォームが
  一度も書かない開示を公開することになります。**開示は法律が見ている部分なので、
  設定の値を正として揃えました。

### Added

- **更新の取り込み方を README に書きました。** 承認画面が「README に書いてあります」と
  言うのに、書いてありませんでした。**端末は一度も出てきません** —
  Actions タブ → Run workflow → Pull request を読む → Merge の4手順です。
  押さなくても毎月1日に同じ Pull request ができること、
  `platform.config.yaml` と `wrangler.jsonc` は入らないことも書いてあります。

- **README の先頭に版が出るようになりました。** GitHub で開いた瞬間に、
  いま何版かが分かります。


## [0.8.0] - 2026-09-20

**既存の `platform.config.yaml` はそのまま通ります。** 設定は1つ**増えました**が、
書かなくても既定値で動きます（確認済み）。`prompts/` は変えていません。
**公開される文面も変わりません。**

いちばん重いのは**お金の話**です。失敗した日が毎時やり直されて、
モデルを呼び続けていました。

### Fixed

- 🔴 **失敗した日が、毎時やり直されていました。ライセンシーの請求で。**
  出力の上限に当たって企画が失敗すると、**その手順だけが1時間ごとに呼ばれ続け**、
  日付が変わるまで止まりませんでした。参照環境の記録では 22:03・23:03 と
  毎時やり直していました。
  Cloudflare は1時間ごとに**まっさらな実行環境**を作るので、「今日はもう走った」も
  「しばらく待つ」も**記憶の中にしか無く、毎回消えていました**。
  判断をサイクルの記録から行うようにし、**その日に何回動かしたか**で上限をかけました。
  **回復は止めていません** — 通信の瞬断のような一時的な失敗は、いままでどおり再開します。

- 🔴 **アカウントの画面に、そのアカウントの判断待ちが出ませんでした。**
  「判断待ち 1」とは出るのに、**中身がその画面に無く**、全アカウントの画面に
  戻らないと読めませんでした。サイクルを動かした本人が、出てきた企画案を
  その場で見られない状態でした。
  あわせて、**数字と中身が別々の場所から作られていた**のも直しました。
  止めたアカウントで「バッジ 1・中身ゼロ」になることがありました。

- 🔴 **開いた「ねらいと根拠」が、勝手に閉じていました。**
  30秒ごとの画面更新だけでなく、**チェックを入れる・推奨を選ぶ・並べ替える**でも
  閉じていました。根拠を読んで判断する、という動作そのものと衝突していました。
  複数を同時に開いたままにでき、並べ替えても**開いた案についていきます**。

- **止めたアカウントが、判断を求め続けていました。**
  止めても開いている承認が残り、画面が答えを待ち続けていました。
  止めたら**理由を付けて閉じる**ようにしました（記録は残ります）。
  再開したら、次のサイクルから新しく始まります。
  一時停止（`pause`）では閉じません — **10分止めた人の一日は捨てません**。

- **承認画面が、実行できないことを案内していました。**
  探索の提案が無いときの文面が「コマンドで探索担当に候補を出させられます」と
  書いていましたが、**その画面からは実行できません**。見出しも「週に1回の判断」と
  名乗っていましたが、既定では探索は動きません。
  実際に起きることだけを書くようにしました。

- **設定ファイルへの追記ができなかったときの文面が、失敗のように読めました。**
  Cloudflare では追記できないのが**正常**です。何をすればいいかを書くようにしました。

### Added

- **`company.retry.maxCycleAttempts`（既定 2、範囲 1〜5）。**
  失敗した日を、その日のうちに何回まで動かし直すかです。**書かなくても動きます。**
  🔴 **この値は請求額に直接効きます。** 1増やすごとに、失敗した日の最大費用が
  おおよそ1サイクル分増えます。やり直しは失敗した手順を丸ごとやり直すので、
  執筆なら承認した案の数だけ、検品なら下書きの数だけモデルを呼びます。
  **Cloudflare では、ここを変えても配置し直すまで反映されません。**

- **設計キャンバスを自分で作り直せるようになりました。** `npm run build:canvas` が
  `docs/_proposed/design/` の板から1枚のHTMLを生成します。依存は増えていません。

### Changed

- ⚠️ **`docs/_drafts/` を `docs/_proposed/` に改めました。**
  更新の Pull request では、**23件が「名前の変更」として表示されます**
  （GitHub が改名だと分かるため）。README 2本だけは中身も大きく変わったので、
  削除と追加に分かれます。**中身は変わっていません。名前だけです。**
  実際に控えで1回通して確かめました。
  そこに置いてあるのは**見せるために作った画面設計**で、「下書き」という名前が
  実態と逆を向いていました。

- **画面設計の板に、その画面が製品にあるかどうかを書きました。**
  24枚のうちどれが動いていて、どれが構想なのかが分かります。
  ⚠️ **それまでの説明文は間違っていました** — 実装済みの画面3つを
  「まだ実装が無い」と書いたまま配っていました。


## [0.7.0] - 2026-09-19

**既存の `platform.config.yaml` はそのまま通ります。** 設定の追加はありません。
`prompts/` も変えていません。**公開される文面も変わりません。**

承認画面の見た目と、押したあとの挙動の修正です。

### Added

- **配色を選べるようになりました。** ヘッダーの「配色」で **自動／明るい／暗い**。
  これまでは OS の設定に従うだけで、選べませんでした。選択はブラウザごとに記憶します。

### Fixed

- 🔴 **全アカウントの表が、右端で切れていました。** 幅1440pxの画面で、列の合計が
  容器より138px広く、**各行の「開く」が画面の外**にありました。1024pxでは
  「型・計測・開く」の390px分が見えていませんでした。
  列の幅を1か所で決めて、表の幅・余白・折り返しをそこから導くようにしました。
  **列は1つも減らしていません。** 幅が足りない画面（スマホなど）では、表をやめて
  **1アカウント1カード**になり、11項目すべてが見出し付きで縦に並びます。

- **アカウント名と id が同じ大きさで密着し、3行の塊に見えていました。**
  名前を見出しに、id を小さい等幅にしました。行の区切りとホバーも足しています。

- 🔴 **画面を開いてすぐボタンを押すと、「まだ動いています」の表示が消えませんでした。**
  処理は正しく終わっているのに、5分間そのままでした。
  画面は「押す前の状態」と「いまの状態」を比べて終了を判断していましたが、
  **開いた直後は「押す前の状態」が存在しません。** 比べる相手が無いまま
  「まだ終わっていない」と答え続けていました。
  押す前に状態を読み込むようにし、さらに**遅れて返ってきた応答そのものを終了の合図**に
  しました。応答が返ってきたなら、それが答えです。

## [0.6.1] - 2026-09-19

**設定の変更はありません。`prompts/` も変えていません。公開される文面も変わりません。**

### Fixed

- 🔴 **更新が、一部のファイルを黙って飛ばすことがありました。**
  更新の取り込みはファイルの**大きさと更新時刻**で「変わったかどうか」を判断していたため、
  **中身が変わっても長さが同じファイルが、届かないこと**がありました。

  実際に起きたことです。v0.6.0 を実物の控えに取り込んだところ、26ファイルは届いたのに
  `package.json` だけが飛ばされました。版数の文字列が `"0.5.1"` から `"0.6.0"` になっただけで、
  **長さが同じ**だったためです。その控えは**新しいコードで動きながら、古い版数を名乗っていました。**

  同じことは、しきい値（`0.35` → `0.45`）やモデル名など、**長さの変わらない変更すべてで起こりえます。**
  しかも画面には何も出ません。**中身そのもので比べる**ようにしました。

  **この版を取り込んだあと、ルートの `update-workflow.yml` を
  `.github/workflows/take-updates.yml` に貼り直してください。** 更新の仕組みは自分自身を
  更新できないため、貼り直すまでは飛ばす側の仕組みが動きます。

## [0.6.0] - 2026-09-19

**既存の `platform.config.yaml` はそのまま通ります。** 何も変えなければ、動きは一切変わりません。
`prompts/` は編集していません。

**新しい設定を1つ足しました** — 投稿を、プラットフォームではなく**あなたが自分で出す**選択肢です。

### Added

- **`adapter: manual` — API をつながずに始められるようになりました。**

  SNS に API でつなぐのは、最初の1時間でいちばん難しい工程です（開発者アプリを作り、
  長期トークンを発行する）。**その前に、手で投稿して始められます。**

  枠の時刻が来ると、承認画面に **「あなたが投稿する番です」** が出ます。投稿される文面が
  そのまま（分割投稿なら1つずつ）並び、コピーのボタン、アプリを開くリンク、
  そして **「投稿しました」** のボタンが1つ。押した時点で公開済みとして記録されます。
  実際の投稿のURLも、任意で残せます。

  ```yaml
  channels:
    - id: threads
      adapter: manual          # mock | threads | webhook | manual
      options:
        maxCharacters: 500
        format: thread
        composerUrl: "https://www.threads.net/"   # 「開く」の行き先
  ```

  **アフィリエイトの経路は閉じたままです。** 投稿に入るリンクはこれまでどおり
  あなたのアドレスの `/go/` を通るので、**クリックも成果も、これまでと同じように記録されます。**

  **取り込めなくなるのは反応の数字**（いいね・返信）です。API でしか取れないためで、
  承認画面の計測欄も「数字が作り物です」ではなく**「反応は取り込めません。クリックと報酬は無傷です」**
  と表示を分けました。分析担当は反応から学ぶので、**型が育つ速度は落ちます。**

  X・Instagram・note・ブログなど、**他のSNSでも同じ形で使えます**（文字数と形は
  `maxCharacters` と `format` で指定します）。

  **これは橋であって、行き先ではありません。** API のアダプタを書く方針は変えていません。

### Fixed

- **採用しなかった企画が、二度と提案されなくなっていました。** 企画担当には
  「最近扱った切り口なので繰り返すな」というリストが渡りますが、そこに
  **提案しただけの案**まで入っていました。1つ承認して残りを見送ると、見送った案は
  使われないまま封じられていました。**公開まで行った切り口だけ**を数えます。
- **同じことが執筆担当にも起きていました。** 公開されなかった草稿の書き出しが
  「もう使った」扱いになっていました。
- **停止したアカウントが、まだ承認を求めてきました。** 停止すると新しいサイクルは
  始まりませんが、**すでに開いていたゲートは残り**、判断待ちに出続けていました。
  停止中のアカウントについては訊かなくなります（記録は未回答のまま残り、日付が
  変わったときに閉じられます）。

## [0.5.1] - 2026-09-19

**既存の `platform.config.yaml` はそのまま通ります。** `prompts/` は編集していません。
**公開される文面も変わりません。**

**更新を受け取る仕組みそのものの修正です。** 0.5.0 を実際の複製に取り込んでみたところ、
**更新を受け取ると運用が止まる**ことが分かりました。お使いの控えがまだ 0.5.0 以前なら、
この版を取り込む前に下の「取り込む前に1つ」をお読みください。

### Fixed

- 🔴 **更新が `wrangler.jsonc` を上書きし、次のデプロイを壊していました。**
  このファイルには、Deploy ボタンが**あなたの Worker 名と、あなたのために作った
  データベースの id** を書き込んでいます。上流のものに置き換わると、こちらの名前と
  プレースホルダになり、マージ直後のデプロイが
  `binding DB of type d1 must have a valid database_id` で失敗します。
  **つまり、修正を受け取った朝に動かなくなります。**
  `platform.config.yaml` と `.github/` と並べて、**触らないもの**に加えました。

- **更新の実行が、届いているのに赤いバツで終わっていました。** 作られたばかりの
  リポジトリは、GitHub Actions に Pull request を作らせない設定が既定です。
  ブランチへの push は成功しているので**更新自体は届いている**のに、画面には失敗としか
  出ませんでした。Pull request が作れないときは **Issue でお知らせし、実行は成功で終わります**。
  Issue には、更新が乗っているブランチへのリンクと、次回から自動で開くための設定
  （Settings → Actions → General → Workflow permissions のチェック1つ）が書いてあります。

### 取り込む前に1つ

**更新の仕組みは、自分自身を更新できません。** GitHub が、ワークフローに
`.github/workflows/` への書き込みを許さないためです。この版を取り込んだあと、
**ルートの `update-workflow.yml` を開いて全文をコピーし、
`.github/workflows/take-updates.yml` に貼り直してください。** 2分で終わり、めったに起きません。
貼り直すまでは、上の2件は直っていない古い仕組みのまま動きます。

## [0.5.0] - 2026-09-19

**既存の `platform.config.yaml` はそのまま通ります。** 追加された設定項目はありません。

⚠️ **`prompts/writer.system.md` を編集しました。** 執筆担当の文面をご自分で直している方は、
ここだけコンフリクトします。追記したのは「分割投稿の各部品に、冒頭文と締めの問いかけを
入れないこと」という指示です。

⚠️ **公開される文面が変わります。** 分割投稿（スレッド）の組み立て方を直したので、
`autonomy: auto` で運用している場合は、マージ後の投稿が変わります。**変わるのは重複が
消える方向だけ**です。下記「投稿が、冒頭と締めを2回言っていました」を先にお読みください。

この版は、**製品を初めて人が通した日**に見つかったものの集まりです。7件のうち6件は、
モックのテストでは一度も出ませんでした。出たのは、本物のモデルで、本物のブラウザで、
本物のデプロイボタンを押したからです。

### Fixed

- **投稿が、冒頭と締めを2回言っていました。** 執筆担当は分割投稿の部品を返しますが、
  本物のモデルは**すでに冒頭文で始まり、すでに問いかけで終わる**部品を返します。組み立て側は
  その逆を前提にしていたので、**実際に公開される文が、1行目を2回、問いかけを2回**
  言うところでした。承認画面の下見も同じ重複を出していたので、**出るものと見せるものが
  食い違わないよう、同じ関数を通します**。案件付き投稿の開示表記が1つ目の投稿に残ることは、
  両方の形についてテストで固定しました。

- **合言葉に記号が入っていると、承認画面に入れませんでした。** 合言葉は `?token=` で
  URL に載っていたので、`+` は空白として読まれ、`#` から先は届かず、`&` は別の項目に
  なりました。**パスワード管理ソフトの生成器が出すのは、まさにその文字です。**
  401 の画面に**合言葉を打ち込む欄**を置いたので、URL に載せる必要がなくなりました。
  合言葉に `;` や空白が入っていても、そのまま使えます。

- **「動かしています…」「送信中…」のまま、画面が黙っていました。** 1日を動かす操作と、
  企画の承認は、どちらも裏で数分かかります。返事が届かないと、画面は**何もなかったように
  元へ戻り**、実際には終わっている仕事が見えませんでした。20秒で待つのをやめ、
  **状態を見に行って自分で更新します**。二度押しも止まります。

- **エラー画面が、実行できない直し方を案内していました。** モデルの鍵が無いときの文面が
  `.env.local` と `wrangler secret put` を先に挙げていました。Cloudflare には端末がありません。
  **ダッシュボードでの手順を先に、省略せずに**出します。この画面だけ英語だったのも直しました。

- **その画面から戻る手段がありませんでした。** 直すのは別の場所（GitHub か Cloudflare）
  なので、戻ってきたときに押すものが要ります。**「直したら、ここを押して確かめる」**を
  置きました。

- **企画のゲートのボタンが「本文を見る」でした。** その時点で本文はまだ書かれていません
  （選ばれてから書きます）。**「ねらいと根拠を見る」**に変えました。

### Changed

- **セットアップ画面の「いまの状態」がバッジになりました。** 4行が文章で並んでいたので、
  状態が読み飛ばされていました。**済／これから／あとで**の3種類です。モデルの鍵が無いことは
  **異常ではない**ので、保管場所が見つからないのと同じ色では出しません。

- 見出しの日本語を直しました（「あと1つで、動き始めます」→「あと1つ、決めるだけです」）。

## [0.4.0] - 2026-09-12

**既存の `platform.config.yaml` はそのまま通ります。** 追加された設定項目はありません。
`prompts/` は編集していないので、文面をご自分で直していてもコンフリクトしません。
**公開されるものは何も変わりません** — ガードレールも閾値も同じで、`autonomy: auto` で
運用していても、マージ前に知っておくべき挙動の変更はありません。

### Added

- **最初の1時間が、428行のYAMLから始まらなくなりました。** Deploy を押したあとの画面が
  7つ質問します — 会社の名前、あなたのお名前、アカウントの名前と id、何について書くか、
  誰に読ませるか、書き手はどんな人か、一人称。答えると設定ファイルができあがるので、
  自分のリポジトリに貼ります。貼れば push になり、1〜2分で承認画面に変わります。

  貼り付けは**1回だけ残ります**。中身をURLに載せてGitHubの作成画面を開く案は実測で
  否定しました（GitHubのGET上限が約2KB、この設定ファイルはURLエンコードで41KB）。
  **ファイル名は載る**ので、「Add file → Create new file → 名前を打つ」の3手順は消えています。

  **設定ファイルはテキストとして埋めます。** 428行の大半を占めるコメントが設定の説明
  そのもので、オブジェクトとして書き戻すとそれが消えるためです。

  **あなたのお名前を訊くようになりました。** これまでの既定値 `owner` は、運用者が1人なら
  嘘ではありませんが、2人目が増えた日には何も言っていません。そして監査の記録は
  あとから書き換えられません。

- **1日を読み返せるようになりました。** アカウントを開いて、履歴の日付の横の
  「この日を見る」を押すと、その日に6つの役割が何をして何を言ったかが、走った順に出ます。
  企画の案には**どの過去データから主張されたか**が付いてきます。承認のところは、
  選ばれたものだけでなく**出されたもの全部**が出ます（2件承認されたことは、8件提案された
  ことを隠すので）。

  **毎日の導線には入っていません。** 「今日」の画面は変わっていませんし、30秒ごとに
  取り直される payload にも載せていません。何かがおかしいときにだけ開くものです。

- **会社の設定が読めるようになりました。** ヘッダーの「設定」から。とくに2つは、
  これまで画面のどこにも出ていませんでした:

  - **機械に任せている範囲。** `auto` で無人運用されていても、画面では分かりませんでした
  - **AIモデル。** `mock` のまま＝読んでいる文章が本物でないことが、分かりませんでした

  どちらも、知るべき値のときは警告色で出ます。リンクの行き先が読者のたどれない
  アドレスのままのときも同じです。**読むだけの画面です** — 変更は設定ファイルで行います。

### Fixed

- **判断待ちの件数が、ブラウザのタブに出るようになりました。** これまでタブには会社名しか
  出ていなかったので、タブを開いたまま1日分の判断が放置されうる状態でした。

- **誰として承認しているかが、ヘッダーの右に移りました。** 件数と同じ灰色の一行に
  「1 件の判断待ち ・ owner として」と並んでいたので、名前がロール名に見えていました。

- **押せない操作が、押せるものと同じ見た目でした。** 上限に達したカードと、日付が過ぎた
  ゲートを、別々の見え方に分けました。

## [0.3.0] - 2026-09-11

### Added

- **The console tells you when a fix exists.** One quiet line above the day's
  work, with what changed folded underneath it, and nothing at all when you are
  current. Someone who does not know an update is out keeps hitting a bug that
  is already fixed and has no occasion to find out — worse off than someone who
  knows and has to click three times. It needs no credential and no git: the
  copy carries its own identity in `RELEASE.json`, and the check reads what the
  release repository publishes. If GitHub is unreachable, or this copy was never
  released, you see nothing rather than an error.

- **A day nobody answered closes when the day is over.** The gate is marked
  `expired`, its cycle ends `cancelled`, and "最近の動き" says which day lapsed.
  Nothing is deleted — the ideas and the record stay readable.

  **This changes what an unattended day does.** Before, the gate stayed open and
  could be approved later; doing so wrote that day's posts onto slots that had
  all passed, so the whole day published at once, with the minimum spacing
  between posts observed by nothing. If you were relying on approving yesterday
  today, you no longer can; the reasoning is in `docs/1-requirements/requirements.md`
  section 4.


- **Each account's data is its own, and every read across accounts has a name.**
  A `Store` was one shared space that every reader filtered by `ventureId`, so
  "this account learned this by itself" was a claim about the code doing the
  filtering. It is now a fact about where the data is: `Services` holds a
  `StoreRegistry` and no store, a role is handed its own account's, and the
  eight readers that legitimately compare accounts — the accounts list, the
  scout, the dispatcher, the day's page, the tracking redirect, resolving a
  gate, listing what is pending, and `amp pause` — say so by calling `each()`.
  Nothing else can cross. On SQL this is one database with `venture` in the
  primary key; on files it is a directory per account, which is what makes
  handing an account over a matter of handing over a folder. A contract test
  runs against all three implementations. **Your data is migrated on first
  start**, and a licensee running more than one account is asked rather than
  guessed at — see [the design](docs/3-development/store-split.md).

- **A `Store` contract test**, run against all three implementations (memory,
  JSON files, SQL). It found two divergences the suite could not: the
  file-backed `forCycle` ignored the order its caller asked for, and the
  in-memory audit log read `recent(0)` as the whole log.
- **A SQL `Store` and a SQL state store** — three tables, one JSON document per
  row, so a new field still costs no migration. Tested against real SQLite
  through Node's built-in `node:sqlite`, which is what D1 is, so no dependency
  was added. `sqlite-driver.ts` also gives a licensee a single-file database
  without a server.
- **The stop and the deactivation switch moved behind a `StateStore` port**,
  with fail-closed (the stop) and fail-open (deactivation) decided above it.
  Groundwork for [running on Cloudflare](docs/3-development/cloudflare-design.md).
- **One router and one tick.** The console's routes are now `Request` →
  `Response` with `node:http` as an adapter over them, and a turn of the loop is
  a function the daemon calls on an interval. Both so a host with no process can
  call the same code rather than a second copy of it.
- **The scout** (探索担当), a seventh role that works weekly for the company
  rather than daily for one account. It reads every account's aggregates and
  proposes the next account to try — niche, audience, market, name candidates,
  a voice sketch, permitted offers, the hypothesis and its evidence, the risk,
  three first hooks, and the signal that would mean stop. Market, prohibited
  category, duplicate niche, missing stopping rule and unpermitted offers are
  refused in code after the model answers. `amp scout`, `amp scout list`,
  `amp scout accept <id>` (prints a `ventures[]` block to paste — the config is
  never written), `amp scout dismiss <id>`; the daemon runs it on
  `company.exploration.everyDays` when `enabled`. Off by default.
- **Switching an account off from the console** (`amp venture deactivate`
  / `activate` / `list`, or the button in the 全アカウント table). Nothing is
  deleted and no config is edited: the state lives in
  `.amp/venture-state.json`, the daemon re-reads it every tick, and the
  account's playbook, history and revenue stay. Fails open - a corrupt state
  file switches nothing off. The portfolio flags accounts for review from
  their own numbers (`company.exploration.review`); the switch is the
  operator's.
- **Accepting a proposal appends its block to `platform.config.yaml`** as
  text under `ventures:`, inactive, validated before the swap, with the
  previous file kept in `.amp/config-backups/`. `--print-only` shows it
  instead.
- **A Cloudflare Worker entry point.** `fetch` serves the console's own router
  and `scheduled` runs the same tick the daemon does, so there is one copy of
  each. Storage and the switches are D1; the config and the prompts are bundled
  by `npm run build`. With no config of its own a deploy serves a setup page
  rather than a stranger's example account — and `/healthz` and `/go/<code>`
  answer before any of that, so a link already inside a published post keeps
  redirecting and recording clicks even when nothing else can start.
  A Durable Object stops two overlapping cron fires from publishing twice.
  Verified on real `workerd` with a local D1: the bundle resolves, the SDK
  loads, and a whole day - analyse, research, plan, approve, write, inspect,
  schedule - runs through to the second gate. What is left needs an account or
  a real API key.
- **The licensee guide leads with Cloudflare**, and the release now un-ignores
  `platform.config.yaml` in a licensee's fork — the Worker build bundles it, so
  a config that is not committed is one the deploy never sees. Ours stays
  ignored, and the release script says why in the file it ships.
- **The console says what is missing from the measurement chain**, not just
  that something is. There is no terminal to run `doctor` in on a host.
- **Where a licensee runs this** ([hosting.md](docs/4-operations/hosting.md)):
  what each host costs and asks of them, with the numbers checked — Vercel's
  free tier forbids commercial use and its free cron cannot reach a posting
  slot; Cloudflare has neither limit, bills CPU rather than wall time (so the
  waiting a cycle is mostly made of costs nothing), and comes to $5/month.
  A design for the move is in
  [cloudflare-design.md](docs/3-development/cloudflare-design.md), and the
  decisions behind all of it are in
  [decisions.md](docs/5-project-management/decisions.md).
- **The licensee's first hour redrawn around one link.** Cloudflare's deploy
  button clones the repository into their account, provisions the database,
  prompts for each secret and deploys; `workers.dev` is free and public, so the
  measurement chain closes on day one and the step that asked for a domain is
  gone. Screens in `docs/_drafts/design/onboarding/`.
- **Contract structure written down** (`docs/1-requirements/licensing.md`):
  who the publisher is, what the licensor does and does not promise, a
  responsibility matrix tied to what the code actually enforces, the fee
  options, and the decisions and legal questions still open. Drafts in
  `contracts/`: an early-access licence for the first users, a master licence
  template, and the tenant terms checklist (moved from the repo root, with
  deactivation, the stop, JSON export and AI-text ownership added). None
  reviewed by a lawyer.
- **`company.principles` and `company.boundaries`**: how the company thinks and
  what it never does, in prose, read by every role in every account.
- **The portfolio**: `amp portfolio` and a 全アカウント table in the console —
  per account: state, waiting decisions, last cycle, posts, median, clicks,
  conversions, revenue by currency, proven patterns, whether measurement is
  closed. Totals are counts and per-currency only.
- **Emergency stop** `amp pause` / `amp resume`, fail-closed, works without a
  valid config, API key or adapter. `doctor` checks the measurement chain per
  venture. Smoke tests spawn the real binary; the console has HTTP tests.

### Changed


- The inspector's AI-smell verdict compares the model's score of its **rewrite**
  with the heuristic's score of the same rewrite. It used to compare the score
  of the original against the rewrite's heuristic and blocked nearly everything
  an honest model produced.
- `tracking.baseUrl` is the bare host; the example and `.env` no longer end in
  `/go`, which produced `/go/go/<code>`.
- Exploration slots in planning are switched off at one or two posts a day
  (keyed on `postsPerDay`, not on the shortlist size).
- The publish gate marks a missing disclosure red only on posts that carry an
  offer.
- Japanese terminology fixed across the documents (see `docs/7-references/glossary.md`).
- `--dry-run` no longer gets its own answer to what is running: it swaps
  storage, the model and the adapters, but reads the operator's real stop and
  deactivations. A dry run that disagreed with the live one was worse than
  useless, since checking is why anyone runs it.
- **A failed day says why on the console.** The 全アカウント table's 直近サイクル
  cell used to read `2026-09-09 failed → write` and stop there; the reason the
  step failed went to a log, and on a host there is no terminal to read one in.
  The reason now travels with the cycle, into that cell and into
  `amp portfolio`. Two failures were carrying nothing to report in the first
  place: a write step where every idea failed said only that they had, and a
  draft the inspector could not *read* was reported as one it had turned
  down — opposite instructions to the operator, since one asks for a rewrite
  and the other for a retry.
- **「今日のサイクルを動かす」** on each active account in the 全アカウント table. The route
  existed and nothing on the page pressed it, so a hosted operator's only way to
  start or retry a day was to wait for the next hourly cron — there is no
  terminal to run `cycle run` in. It takes the same lock the cycles tick takes,
  so a run and the schedule cannot draft the same day twice; where the host has
  no lock (a machine, whose data directory already holds one) it runs as before.
- **The example account is named for what it is, not for its rank**
  (`main` / メインアカウント → `ai-tools` / AI仕事術). The id goes into the
  console's addresses and every record kept, so it cannot be changed later
  without orphaning the history — the file now says so where it is set. Existing
  configs are untouched: this is the example a new licensee copies.
- **The 直近サイクル cell speaks Japanese.** It read `2026-09-09 failed → write`
  on a page that is otherwise entirely Japanese, to an operator with no
  terminal to look "write" up in. The status and the step have words of their
  own now (`2026-09-09 失敗（執筆）`), kept in `src/console/labels.ts` rather
  than inside the page, so a step added to `CycleStep` without one fails a test
  instead of reaching a screen.
- **The accounts table gives every column a width of its own, and lets you
  change them.** One long value in 直近サイクル took the whole table: the other
  nine columns were squeezed to a character wide and their headers rendered one
  letter per line. Fixed layout with declared widths, the table scrolling inside
  its own container rather than being compressed, numbers right-aligned, and a
  drag handle on every header border (remembered in the browser, with 列の幅を
  もとに戻す to undo).

- **A second operator gets their own passphrase, and their own name in the
  record.** `console.operators` lists anyone beyond the owner, each naming their
  own env var; the console header says whose passphrase you are holding, and
  every approval, deactivation and accepted proposal is stored against that
  name instead of `company.operator`. `doctor` lists who can open the console
  and fails on anyone listed without a passphrase. No roles: everyone named can
  still do everything. The point is only that the audit trail is true — an
  approval recorded while one passphrase was shared can never be attributed
  afterwards, so this is worth doing before a second person starts rather than
  after. A single-operator config is unchanged.

- **The console splits into three levels: today, all accounts, one account.**
  Everything used to be one scroll written from the all-accounts point of view,
  with no place to be inside a single account — so account-shaped things got
  pushed into the comparison row, which is how one API error took a whole table
  with it. `#/ventures/<id>` opens the account: the failure in full with 今日の
  サイクルを動かす directly under it, the last few days, its numbers and
  patterns, what is in force from the config with each field's source, and the
  switch. The list keeps one control, 開く. Reasoning and the screens are in
  [console-architecture.md](docs/3-development/console-architecture.md).
- **A failed day on the list reads 実行できませんでした**, with one smaller line
  under it — **chosen by the failure's code, never by truncating the message.**
  Truncation gives an English fragment or a sentence cut before the word that
  carried the meaning. A code with no words of its own prints the code and fails
  a test.
- **`console.locale`: ja or en.** Every word the console says now lives in
  `src/console/messages.ts`, typed so `en` must answer every key `ja` does — a
  half-translated screen is a compile error. **The screen's language is never
  the disclosure's**: that follows the reader's market, so an operator reading
  English while publishing to Japanese readers still publishes a Japanese
  disclosure. A test holds both halves of that.

### Fixed

- **A control you could not use looked exactly like one you could.** Both the
  cap on a gate ("最大2件") and a gate whose day has passed were already
  enforced, and neither was visible: the checkbox went dead with no change in
  appearance, so the cap read as advice the screen was ignoring. The two closed
  states are now drawn differently, because the way out of them differs — a
  card closed by the cap recedes but keeps its text readable, since unticking
  something else brings it back, while a lapsed day dims as a whole and keeps
  only its heading and its date legible, since nothing there is coming back.

- **Two gates open on different days looked like one gate drawn twice.** The
  card said the gate and the account and nothing else, so an unapproved day
  standing next to today's read as a repeated row. It now says which day it is
  for, and says so when that day has passed — decided in the account's own
  timezone, not the browser's.

- **The update workflow was broken three ways and none of them showed.** It
  never reached a copy made by the Deploy button (GitHub does not let an app
  write under `.github/workflows/`), it could not have pushed if it had (the
  same rule binds `GITHUB_TOKEN`), and it was not valid YAML, so GitHub would
  have refused to load it. The same file now also ships as `update-workflow.yml`
  in the repository root, which a copy does receive; installing it is one paste
  in the browser, once. See the licensee guide.


- **The console did nothing at all.** Its whole script is one inline module,
  and `(s) => {"running":"動作中"}[s]` parses that brace as a block — so the
  module died at the first colon, and with it every line of the page's
  behaviour. The page served its headings and sat on 読み込み中… forever. Two
  more escapes had been eaten by the template literal the page is written in
  (`\w` reaches the browser as `w`): `fmt`'s placeholder pattern, so no `{n}`
  was ever filled in, and the hash router's, which is what made the syntax
  error fatal rather than local. Every other test reads the page as text; two
  new ones parse the program the browser actually receives, and refuse a lone
  backslash anywhere in `ui.ts` that is not escaping a backtick or a `${`.
- **A day that failed left no trace in the audit log.** The orchestrator wrote
  the reason onto the cycle and into a logger, and the console's 最近の動き
  reads the audit log — so the feed said nothing had happened while the cycle
  was failing every hour. Two days ended that way on Cloudflare, under a
  heading that claims to be the record of what the company did, and finding out
  took a query against the database. A failed step now records a
  `cycle.failed` event carrying the step, the code, whether it is retryable
  and the message; the feed renders it in the operator's language from the same
  code the accounts table uses, in bold, and the API's own sentence stays in
  `data` where the account screen reads it. Recording the failure can never
  replace the failure: if the audit write itself fails, the caller still gets
  the original error.
- **A cycle that recovered on a retry went on calling itself failed.** The
  console shows a failure whenever one is stored, and a resumed cycle kept the
  one it had already got past — so an account that recovered on the next hourly
  retry sat there saying 実行できませんでした directly above its own approval
  gate. The reason is dropped when the day resumes; the failure that did happen
  is in the audit log, which is where history belongs.
- **`effort` was sent to models that refuse it**, which ended the cycle at its
  first call with `400 "This model does not support the effort parameter."`
  The cheap tier ships as `claude-haiku-4-5`, and Haiku 4.5 rejects both
  `output_config.effort` and `thinking: adaptive`. The adapter now decides
  per model, and **a model it does not recognise is sent neither** — losing
  effort costs some quality on that call, sending it wrongly costs the day.
  If you name a newer model than your copy of the adapter knows about, that is
  the direction it will err in; the table is at the bottom of
  `src/llm/anthropic.ts`. An effort level a model does not have is lowered to
  its highest rather than sent — `effort: max` on Opus 4.5, which stops at
  `high`, was the same lost cycle from a setting the config invites you to set.
  A test stands a real HTTP server in front of the real
  SDK and reads the body it sends, which is the only way this class of bug is
  visible at all — the mock provider never sees a request.
- **No role's structured output could ever have worked.** The first real model
  call this platform made came back
  `400 output_config.format.schema: For 'array' type, property 'maxItems' is
  not supported`, and every role's schema used at least one keyword from that
  list — `maxItems`, `minItems`, `maxLength`, `minimum`, `maximum`. The whole
  suite passed because it runs on the mock, which accepts anything. The bounds
  are now written into the field's description, where the model reads them,
  and `stripUnsupported` runs on every schema in the adapter so a hand-written
  one cannot 400 either. A test walks the schemas the roles really send.
  **Nothing enforces those bounds any more** — the API never did — so a role
  that needs one honoured has to check it itself.

## [0.2.0] - 2026-08-27

### Added

- **Markets and cross-border promotion.** A new required `markets:` section
  declares where your readers are and what the law expects of an ad shown to
  them. Compliance follows the **audience**, not the merchant: a US offer
  promoted to Japanese readers is governed by 景表法 and the ステマ規制, and
  the disclosure is written in Japanese.
  - Offers gain `originMarket`, `targetMarkets` and `crossBorderNote`.
  - A venture can only carry an offer whose `targetMarkets` include its own
    market. Config validation refuses to start otherwise.
  - A cross-border offer must declare what a foreign reader is owed before
    clicking — currency, shipping, language support, who they are contracting
    with. The writer is asked to work it into the post; if it is missing after
    the inspection rewrite, the platform adds it and the post is blocked
    without it.
  - A market may prohibit a category outright (e.g. gambling in Japan); such a
    pairing is refused at config time.
- **`csv` affiliate-network adapter.** Reads the conversion reports networks
  actually give publishers — A8.net, もしも, バリューコマース, afb,
  アクセストレード, ShareASale, CJ, Impact, Rakuten Advertising, Amazon
  Associates. Handles Shift_JIS, Japanese date formats, quoted fields, and
  deduplicates re-imported files by the network's own order id.
- **Post formats per channel.** `options.format` is `short`, `thread` or
  `longform`, and the writing role is told which it is producing. Config
  presets shipped for X, note and YouTube descriptions.
- **Release workflow**, matching the `release-repo-split` pattern: a pre-push
  hook, a `/release` skill, and `.github/workflows/sync-to-release.yml`.

### Changed

- **`version: 2` is required in `platform.config.yaml`.** A version-1 file now
  fails validation with a message naming the version rather than running an
  operation with no jurisdiction attached to it.
- **Revenue is reported per currency and never summed across them.** There is
  no exchange rate in this platform on purpose. `report`, the console and the
  analysis role all show `7,500 JPY / 30 USD` rather than one wrong number.
- **Secrets moved to `.env.local`.** `.env` now holds shared, non-secret
  defaults and is committed; `.env.local` holds keys and tokens and is
  git-ignored. Precedence is real environment variables > `.env.local` >
  `.env`. `amp init` creates `.env.local` and generates the console token there.
- **Docs restructured** into the `dev_base` seven-category layout. Every link
  in the README and in `CLAUDE.md` was updated; nothing was deleted.
- `prompts/writer.user.md`, `prompts/inspector.user.md` and
  `prompts/analyst.user.md` gained the market-rules block. **Licensees who have
  customised these three files will get a conflict there and nowhere else.**

### Migration from 0.1.0

1. Add `version: 2` at the top of `platform.config.yaml`.
2. Add a `markets:` section — copy the `jp` / `us` entries from
   `platform.config.example.yaml` and edit them for your jurisdiction.
3. Add `market: <id>` to every venture.
4. Add `originMarket`, `targetMarkets` and (where they differ)
   `crossBorderNote` to every offer.
5. Rename your `.env` to `.env.local`.
6. Run `node src/cli.ts doctor` — it reports every remaining problem at once.

## [0.1.0] - 2026-08-26

### Added

- Initial platform: six agent roles (analyst, research, planning, writing,
  inspection, publishing), a resumable daily cycle with two human gates,
  the playbook with recency-weighted pattern confidence, tracked links and
  revenue attribution, the approval console and tracking redirect, the
  scheduler daemon, and the licensee release packaging script.
