# 引き継ぎ手順 — 数独キャリブレーションチェック

最終更新: 2026-09-21

このファイルは「人が手を離しても、Claude Code が Issue → 実装 → テスト → レビュー → マージ のループを回し続けられる」ための手順書。セッションを引き継ぐときは、`CLAUDE.md` → `docs/SPEC.md` → `docs/DESIGN.md` → このファイルの順に読む。

## 1. 人間にしかできない作業(未完了なら最初に依頼する)

Worker アプリ自体は `wrangler deploy` が自動で作るので、Cloudflare のダッシュボードで「アプリを作る」操作は不要。GUI が必要なのは次の3つ(1.1〜1.3)。KV ネームスペース(1.4)はトークンが揃えば Claude Code 側で作れる。

| 作業 | 状態 |
|---|---|
| 1.1 API トークンと Account ID を取得 | 未 |
| 1.2 workers.dev サブドメインを登録 | 未 |
| 1.3 Claude Code のクラウド環境に環境変数を設定 | 未 |
| 1.4 KV ネームスペース `RATE_LIMIT_KV` を作成し `wrangler.toml` の `id` を置換 | 未 |
| 1.5 デフォルトブランチを `main` にする | 未 |

### 1.1 API トークンと Account ID(Cloudflare ダッシュボード)

1. https://dash.cloudflare.com/profile/api-tokens → 「Create Token」→ 一番下の「Create Custom Token」→「Get started」
2. Token name: `sudoku-calibration-check-deploy`(任意)
3. Permissions に4行追加: `Account / Workers Scripts / Edit`、`Account / Workers KV Storage / Edit`、`Account / Workers AI / Read`、`Account / Account Settings / Read`
4. Account Resources: Include → 自分のアカウント
5. 「Continue to summary」→「Create Token」。トークンは一度しか表示されないので控える。**チャットやリポジトリには貼らない**
6. Account ID: https://dash.cloudflare.com → Workers & Pages → 右側「Account details」

### 1.2 workers.dev サブドメイン(初回のみ)

Workers & Pages → Overview の右側に「Your subdomain」が無ければ「Set up a subdomain」で登録する。非対話の `wrangler deploy` はこれが無いと失敗することがある。

### 1.3 Claude Code のクラウド環境(claude.ai/code → Settings → Environments)

このリポジトリ用の環境に次を追加する。

````text
CLOUDFLARE_API_TOKEN=<1.1 のトークン>
CLOUDFLARE_ACCOUNT_ID=<1.1 の Account ID>
WRANGLER_SEND_METRICS=false
````

ネットワークポリシーが制限付きなら `api.cloudflare.com` と `*.cloudflare.com` を許可する(遮断されていると `wrangler deploy` / `wrangler kv` が動かない)。

### 1.4 KV ネームスペース

1.3 が済んだ新しいセッションで Claude Code が `npx wrangler kv namespace create RATE_LIMIT_KV` を実行し、出力された `id` を `wrangler.toml` の `RATE_LIMIT_KV` の `id`(プレースホルダー `REPLACE_WITH_KV_NAMESPACE_ID`)に書いてコミットする。`id` は秘密ではない。GUI でやる場合は Workers & Pages → KV → 「Create a namespace」で `RATE_LIMIT_KV` を作り、表示された ID を Claude Code に伝える。

注意: Workers **Free** プランの KV は書き込み 1,000 回/日。1 判定で 2 回書くので 1 日約 500 判定(数独 1 問 ≈ 78 判定なので約 6 回分)が上限になる。足りなければ Workers Paid にする。

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

## 3. モデルの使い分け

方針: 通常の実装は Sonnet、判断が重い箇所と全レビューは上位モデル。

| 作業 | モデル |
|---|---|
| フロントエンド(`PAGE_HTML`)、README、ドキュメント整備、小さな修正 | Sonnet |
| `handleJudge`・`checkRateLimit`・入力検証など、コストと実験の正しさに直結する Worker 側コード | Opus |
| レート制限の上限変更、認証・秘密情報・ネットワーク境界に関わる変更 | Opus または Fable。理由を PR に明記 |
| Jev のレスポンス形式が公式と違った場合の `handleJudge` と `DESIGN.md` 3.4 の同時修正 | Opus |
| PR レビュー(全 PR) | 実装者より上位か同格のモデル。Worker 側コードは Fable、それ以外は Opus |
| ループ全体の進行管理、Issue 起票、マージ判断 | セッション本体(Opus 以上) |

## 4. レビュー観点

- `docs/DESIGN.md` 9章の不変条件をすべて満たしているか(特に 1・7: `SOLUTION` が Worker の判定コードや Jev の `state` に混ざっていないか)
- 入力検証が `DESIGN.md` 3.3 の項目を網羅しているか
- レート制限の順序(全体 → IP)、KV への書き込み条件、`[vars]` からの読み取り、フェイルオープンが設計どおりか
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
- 未着手の人間作業: 1 章の3つすべて

## 7. 次のセッションで貼るプロンプト

````text
CLAUDE.md と docs/ の4ファイルを読んでから、docs/HANDOFF.md 2章の自律ループを再開してください。
まず docs/HANDOFF.md 1章の人間作業の状態を確認し、ブロックされている Issue があれば
何が必要かを最初に報告してください。着手できる Issue があれば、3章のモデルの使い分けに
従って実装・テスト・レビュー・マージまで進め、終わったら CLAUDE.md と HANDOFF.md 6章を更新してください。
````
