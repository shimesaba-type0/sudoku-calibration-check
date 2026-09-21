# 引き継ぎ手順 — 数独キャリブレーションチェック

最終更新: 2026-09-21

このファイルは「人が手を離しても、Claude Code が Issue → 実装 → テスト → レビュー → マージ のループを回し続けられる」ための手順書。セッションを引き継ぐときは、`CLAUDE.md` → `docs/SPEC.md` → `docs/DESIGN.md` → このファイルの順に読む。

## 1. 人間にしかできない作業(未完了なら最初に依頼する)

Worker アプリ自体は `wrangler deploy` が自動で作るので、Cloudflare のダッシュボードで「アプリを作る」操作は不要。GUI が必要なのは 1.1〜1.3(Cloudflare ダッシュボードと Claude Code の環境設定)と 1.5(GitHub の設定)。レート制限のカウンタ(1.4)は Durable Object になったので手作業は不要。

| 作業 | 状態 |
|---|---|
| 1.1 API トークンと Account ID を取得 | 済(2026-09-21) |
| 1.2 workers.dev サブドメインを登録 | 済(2026-09-21) |
| 1.3 Claude Code のクラウド環境にトークンと環境変数を設定 | 済(2026-09-21) |
| 1.4 レート制限のカウンタ(Durable Object)| 不要(`wrangler deploy` が作る) |
| 1.5 デフォルトブランチを `main` にする | 未 |

### 1.1 API トークンと Account ID(Cloudflare ダッシュボード)

1. https://dash.cloudflare.com/profile/api-tokens → 「Create Token」→ 一番下の「Create Custom Token」→「Get started」
2. Token name: `sudoku-calibration-check-deploy`(任意)
3. Permissions に4行追加: `Account / Workers Scripts / Edit`、`Account / Workers KV Storage / Edit`、`Account / Workers AI / Read`、`Account / Account Settings / Read`(`Workers Scripts / Edit` に Durable Objects の作成も含まれる。`Workers KV Storage / Edit` は現在は使っていないが、付けたままで害は無い)
4. Account Resources: Include → 自分のアカウント
5. 「Continue to summary」→「Create Token」。トークンは一度しか表示されないので控える。**チャットやリポジトリには貼らない**
6. Account ID: https://dash.cloudflare.com → Workers & Pages → 右側「Account details」

### 1.2 workers.dev サブドメイン(初回のみ)

Workers & Pages → Overview の右側に「Your subdomain」が無ければ「Set up a subdomain」で登録する。非対話の `wrangler deploy` はこれが無いと失敗することがある。

### 1.3 Claude Code のクラウド環境(claude.ai/code → Settings → Environments)

2026-09-21 に次の形で設定し、これで通ることを実環境で確認した。**環境変数にトークンの実物を入れない**のがポイント。

1. **トークンは「API 認証情報」として登録する**。環境設定の API 認証情報(API credentials)に、ホスト `*.cloudflare.com` 宛ての Bearer トークンとして 1.1 のトークンを登録する。こうするとセッションのプロキシがリクエストに注入してくれるので、セッション自身(= Claude Code)はトークンの値を一度も見ない
2. **環境変数** は次の3つだけ:

````text
CLOUDFLARE_API_TOKEN=placeholder
CLOUDFLARE_ACCOUNT_ID=<1.1 の Account ID>
WRANGLER_SEND_METRICS=false
````

`CLOUDFLARE_API_TOKEN` はダミーの文字列でよい。wrangler は「トークンが設定されていない」と非対話実行を拒否するので、その判定を通すためだけに置く。実際の認証は 1 のプロキシ注入で行われる。

3. **ネットワーク(egress)の許可リスト** に次を入れる。
   - `api.cloudflare.com` / `*.cloudflare.com` — 無いと `wrangler deploy` / `wrangler kv` が動かない
   - `*.workers.dev` — デプロイした Worker を `curl` で動作確認するのに要る(`CLAUDE.md` 作業ルール5)

4. **AI Gateway の課金を有効にする**。`typesafe/jev` は Workers AI のニューロンではなく **AI Gateway のクレジット** で課金される(`docs/DESIGN.md` 3.4)。ダッシュボード → AI → AI Gateway で課金を有効にしていないと、デプロイは通るのに `/api/judge` だけが失敗する。

### 1.4 レート制限のカウンタ(Durable Object)

**手作業は不要**。レート制限のカウンタは Durable Object(クラス `RateLimitCounter`、バインディング `RATE_LIMITER`)で、`wrangler.toml` の `[[migrations]]` を見て `wrangler deploy` が作る。ダッシュボードでの事前作成も `id` の貼り付けも要らない。

以前は Workers KV(`RATE_LIMIT_KV`)を使っており、ネームスペースを1回作って `id` を `wrangler.toml` に貼る手作業があった。KV は結果整合で全体上限が分散アクセスに効かなかったため、Issue #10 で Durable Object に移行した(`docs/DESIGN.md` 3.2)。**古い KV ネームスペースはそのまま残っている**ので、不要なら Workers & Pages → KV から削除してよい(消さなくても害は無い)。

注意: SQLite バックエンドの Durable Objects は Workers **Free** プランでも使える(`new_sqlite_classes` で登録しているのはそのため)。ただしプランごとの上限は変わることがあるので、デプロイがプラン関連のエラーになったらダッシュボードで確認する。1 判定あたりのカウンタ操作は最大3回(全体 peek / IP +1 / 全体 +1)。以前の KV(書き込み 1,000 回/日で 1 日約 500 判定が上限)のような日次の書き込み制限に当たる心配は無くなった。

### 1.5 デフォルトブランチ

GitHub → Settings → General → Default branch → 鉛筆アイコン → `main` を選んで Update → 確認。その後 Branches ページで不要な旧ブランチを削除。

トークンが無いセッションでは deploy をせず、`npm test` と `npm run check` までで止めて報告する(`CLAUDE.md` 作業ルール5)。

## 2. 自律ループ

1. **Issue を選ぶ**: `status:ready` ラベルの付いた open Issue のうち番号が小さいものから。無ければ `docs/SPEC.md` 7章の「今後の拡張」から次を Issue に起こす(受け入れ基準を必ず書く)
2. **ブランチを切る**: `main` から `claude/issue-<番号>-<短い英語名>`。Issue 番号を必ず含める
3. **実装する**: 担当モデルは 3 章の表に従う。実装者には Issue 本文・関連ドキュメントの節・触ってよいファイルを明示して渡す
4. **検証する**: `npm test` → `npm run check`。落ちたら直す。テストを消したり skip したりして通すのは禁止
5. **PR を作る**: base は `main`。本文に「Closes #<番号>」、変更点、テスト結果(コマンドの出力)、確認できなかったことを書く。Draft で作り、レビュー後に Ready にする
6. **レビューする**: 実装者とは別のエージェントに、PR の diff と関連ドキュメントを渡してレビューさせる。レビュー観点は 4 章。指摘は実装者(または同じ担当帯のエージェント)が直し、再レビュー。指摘ゼロになるまで繰り返す
7. **マージする**: CI(GitHub Actions)が緑で、レビュー指摘がゼロなら squash merge。Issue は「Closes」で自動クローズ
8. **状態を更新する**: `CLAUDE.md` の「現在の状態」と、このファイルの 6 章「現在地」を直す。設計が変わったなら `docs/DESIGN.md` も同じ PR で直す(`CLAUDE.md` 作業ルール3)
9. 1 に戻る

ループを止める条件: 人間にしかできない作業(1 章)でブロックされた / 仕様の曖昧さで判断が割れる(`CLAUDE.md` 作業ルール8に従い質問として報告する) / レート制限を緩める変更が必要になった(作業ルール4)。

**進行役は 1 セッションだけ。** このループ(Issue 起票・ブランチ作成・PR 作成・マージ・ドキュメントの現在地更新)を回すのは親セッション 1 つに限る。親セッションが起動した子セッション(デプロイ確認など)や実装・レビューのサブエージェントは、渡された手順だけを実行して報告し、Issue や PR を自分で作らない・マージしない。同じ Issue を 2 つのセッションが並行して実装すると、重複 PR と競合が生じ、コストも倍になる(2026-09-21 に実際に起きた)。

**複数セッションが同時に走る場合の調停ルール**(進行役が複数存在しうる状況、または進行役と独立に動くセッションが並行する状況向け):

- 着手前に対象 Issue へ「着手中(セッション ID)」とコメントする。コメントしてから作業を始める
- 同じ Issue に 2 つの PR を出さない。先にコメントした方が担当。後から気づいたセッションは着手を控え、必要ならコメントで調整する
- `src/index.js` の `PAGE_HTML`(フロントエンド部分)を触る変更は直列にする(同時に別セッションが編集すると衝突しやすいため)。Worker 側コード・`docs/` 配下・新規ファイルの追加は、対象ファイルが重ならない限り並列でよい
- 別セッションが出した PR を閉じる場合は、閉じる前に理由をその PR にコメントする

## 3. モデルの使い分け

方針(オーナー指示 2026-09-21): 基本は Sonnet。判断が重い箇所と**全 PR のレビューは Opus**。**Fable は本当に重要なところだけ**に絞る(Fable の利用枠が限られるため)。

| 作業 | モデル | 理由 |
|---|---|---|
| フロントエンド(`PAGE_HTML`)、README、ドキュメント整備、数独ジェネレーター/ソルバーなどの生成器、テスト追加、小さな修正 | Sonnet | 通常の実装作業であり、判断の重さも低いため |
| `handleJudge`・`checkRateLimit`・入力検証など、コストと実験の正しさに直結する Worker 側コードの実装 | Opus | 崩れると課金やレート制限の前提が壊れる、判断の重い実装のため |
| PR レビュー(全 PR。実装者が Sonnet でも Opus でも) | Opus | レビューは実装者と同格以上のモデルで行う方針のため |
| 認証・秘密情報・ネットワーク境界に関わる変更 | Fable | 事故ると秘密情報漏洩やアクセス制御の穴に直結する、特に重い判断のため |
| レート制限の上限変更(`RATE_LIMIT_PER_IP_MAX` / `RATE_LIMIT_GLOBAL_MAX` を緩める、`RATE_LIMITER` バインディングを外すなど)とそのレビュー | Fable | コストの青天井を防ぐ唯一の砦(`CLAUDE.md` 作業ルール4)であり、緩める判断は特に重いため |
| 課金に関わる変更(AI 呼び出し経路・レート制限カウンタの仕組みの変更)とそのレビュー | Fable | Jev の呼び出しはコスト・実験の正しさに直結し、仕組みを変えるミスの影響が大きいため |
| 複雑な設計判断(アーキテクチャの変更、不変条件に関わる判断など) | Fable | 一度の判断ミスの手戻りコストが大きいため |
| Jev のレスポンス形式が公式と違った場合の `handleJudge` と `DESIGN.md` 3.4 の同時修正 | Opus | 実験の正しさに直結する Worker 側コードの修正のため |
| ループ全体の進行管理、Issue 起票、マージ判断 | セッション本体(Opus 以上) | 複数 Issue・PR を横断する意思決定のため |

## 4. レビュー観点

- `docs/DESIGN.md` 9章の不変条件をすべて満たしているか(特に 1・7: `SOLUTION` が Worker の判定コードや Jev の `state` に混ざっていないか)
- 入力検証が `DESIGN.md` 3.3 の項目を網羅しているか
- レート制限の順序(全体 peek → IP +1 → 全体 +1)、拒否したときに加算しない条件、`[vars]` からの読み取り、フェイルオープン/フェイルクローズが設計どおりか
- エラー時に必ず `running=false` になるか(フロント)
- テストが「通るように書かれた」ものでなく、失敗すべき入力で失敗しているか
- `wrangler.toml` に `account_id` や秘密情報が入っていないか
- ドキュメントと実装が食い違っていないか(食い違うなら同じ PR で直す)

## 5. ブランチ・PR・コミットの規約

- ブランチ: `claude/issue-<番号>-<短い英語名>`
- コミットメッセージ: 日本語可。1行目は `<種別>: <要約>`(種別は `feat` / `fix` / `docs` / `test` / `chore` / `ci`)
- PR タイトル: コミットの1行目と同じ形式。本文に `Closes #<番号>`
- マージ方法: squash
- Issue のラベル: `status:ready`(着手可)/ `status:blocked`(人間待ち。理由を本文に書く)/ `type:feature` / `type:verify` / `type:docs`

## 6. 現在地

- 2026-09-21: ドキュメント(SPEC / DESIGN / CLAUDE / HANDOFF)を整備。v0.1 の実装を Issue に分割して着手
- 2026-09-21: 人間作業 1.1〜1.4 が完了。KV ネームスペースを作成して `wrangler.toml` に反映し、初回デプロイを実施(https://sudoku-calibration-check.takashi-kono-rb.workers.dev)。`GET /` はフロントエンドの Issue が入るまで「実装中」の仮ページ
- 2026-09-21: **Jev を実環境で初めて検証**。レスポンスが AI Gateway のラッパー(`{ state, result, gatewayMetadata }`)で返ってくることが判明し、`handleJudge` と `docs/DESIGN.md` 3.4 / `docs/SPEC.md` 4・5章を実測に合わせて修正。併せて分かったこと: `confidence` は `probabilities[choice]` と一致しない / 1 判定あたり約 670 入力トークン / Worker 経由のレイテンシは 1.0〜1.7 秒 / 同じ入力でも `choice` が揺れる(決定的でない)
- 2026-09-21: フロントエンド(Issue #3、PR #13)をマージ。グリッド・判定パネル・周回ロジック・速度モード・実行世代トークン(リセット直後の再実行で判定が二重化しない)を実装。モック API + Playwright で周回・15 周打ち切り・エラー停止を確認。v0.1 の機能はこれで揃った
- 2026-09-21: 検証用の子セッションが範囲を超えて独自に PR #11(マージ済み、内容は妥当)と PR #12(重複のため閉鎖)を作った。再発防止として 2 章に「進行役は 1 セッションだけ」を追記
- 2026-09-21: レート制限のカウンタを Workers KV から Durable Object(`RateLimitCounter` / `RATE_LIMITER`)に置き換え(Issue #10)。KV の結果整合による lost update で全体上限が分散アクセスに効いていなかった問題を解消。上限値(30 / 500 / 3600)は据え置きで、**緩める変更ではない**(`docs/DESIGN.md` 3.2)。初回デプロイ時に `[[migrations]]` で DO クラスが作られる
- 2026-09-21: PR #14(レート制限を Durable Object に置き換え)をマージ・デプロイ(Version 7f6d90b7)。合わせて PR #7(Worker 本体)・#9(Jev 実レスポンス形式 + KV id)・#11(#7/#9 のレビュー指摘)もマージ済み。本番 URL でフロントエンド + DO レート制限が稼働中
- 2026-09-21: Issue #5(数独ジェネレーター/ソルバー)は PR #15 として実装済み、レビュー中。マージ後は `wrangler.toml` の `GIVEN` 前提を外した入力検証(`docs/DESIGN.md` 3.3)が有効になる
- 2026-09-21: 未着手の Issue を整理: #6(集計ビュー)、#17(Playwright E2E スモーク)、#18(GET /api/status)、#19(AbortController + 振る舞いテスト)、#21(難易度)。Issue #16(このドキュメント整備)で 3 章のモデル方針と本節を更新
- 残っている人間作業: 1.5(デフォルトブランチを `main` にする)。オーナー判断待ち: IP 単位のレート制限(30 回/時)の緩和可否(Issue #20、`CLAUDE.md` 現在の状態を参照)
- 次にやること: PR #15 のレビュー完了・マージとその後のデプロイ確認(SPEC 6 章の「デプロイ後」項目)。続けて #6(集計ビュー)、#17(Playwright E2E スモーク)、#18(GET /api/status)に着手

## 7. 次のセッションで貼るプロンプト

````text
CLAUDE.md と docs/ の4ファイルを読んでから、docs/HANDOFF.md 2章の自律ループを再開してください。
まず docs/HANDOFF.md 1章の人間作業の状態を確認し、ブロックされている Issue があれば
何が必要かを最初に報告してください。着手できる Issue があれば、3章のモデルの使い分けに
従って実装・テスト・レビュー・マージまで進め、終わったら CLAUDE.md と HANDOFF.md 6章を更新してください。
````
