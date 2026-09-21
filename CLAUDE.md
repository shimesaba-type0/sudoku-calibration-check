# CLAUDE.md — sudoku-calibration-check

このファイルは Claude Code が毎セッション開始時に自動で読み込む。作業前に必ず `docs/` の3つを読むこと。

## このプロジェクトは何か

TypeSafe AI の決定モデル **Jev**(`typesafe/jev`、Cloudflare Workers AI 経由)に数独のマスを1つずつ「何の数字か」聞き、実際の正解と突き合わせて、**Jevの「較正された確率」という主張が本当かを目で確かめる**実験用の小さなWebアプリ。Cloudflare Workers 1つで完結する。

遊び半分の実験だが、将来は同じ土台をホームラボのログ異常検知(Noul/Choice判定)に転用する予定。

**スコープについて**: v0.1はJev一本に絞る。他モデルとの比較は次の拡張(`docs/SPEC.md` 7参照。次点はAnthropic Claude API)で、依頼されない限り先回りして手を広げない。OpenAI・Grok等は現時点で対象外の方針。

## 必読ドキュメント

- `docs/SPEC.md` — 仕様書(何をするアプリか、API契約、受け入れ基準)
- `docs/DESIGN.md` — 設計書(Worker/フロントの構造、Jevのリクエスト・レスポンス形式、設計判断)
- `docs/HANDOFF.md` — 引き継ぎ手順、自律ループ(Issue → PR → テスト → レビュー → マージ)の回し方、モデルの使い分け

## ファイル構成

````text
.
├── CLAUDE.md          # このファイル
├── README.md          # 人間向け概要とデプロイ手順
├── LICENSE            # MIT
├── package.json       # wrangler を devDependency として固定、npm scripts
├── wrangler.toml      # Workers AI バインディング(env.AI)、レート制限用 Durable Object(env.RATE_LIMITER)、[vars]
├── src/index.js       # Worker本体。GET / でHTML一式、POST /api/judge でJev呼び出し
├── test/              # node:test によるテスト(モックの env で Worker を直接呼ぶ)
├── .github/workflows/ci.yml  # push / PR で npm test と npm run check
└── docs/
    ├── SPEC.md
    ├── DESIGN.md
    └── HANDOFF.md
````

## 技術スタックと制約

- Cloudflare Workers(Module Worker、JavaScript)。フレームワーク・ビルドステップなし
- フロントエンドは `src/index.js` 内の `PAGE_HTML` テンプレート文字列に素のHTML/CSS/JSとして埋め込み。**別ファイル化や React 化はしない**(1ファイルで読める・デプロイできることを優先)
- AI 呼び出しは `env.AI.run('typesafe/jev', {...})` のみ。他のモデル・外部APIは使わない
- Node.js 22 以上、wrangler 4.x(wrangler 4.135 の engines が Node 22 以上。`npm test` のグロブ指定も Node 22 以降の機能)

## よく使うコマンド

````bash
npm install                 # wrangler を入れる
npm test                    # node --test "test/**/*.test.js"(認証不要。ロジックと不変条件の検証)
npm run check               # wrangler deploy --dry-run(認証不要。設定とビルドの検証だけ)
npm run deploy              # 本番デプロイ(CLOUDFLARE_API_TOKEN が必要)
npm run dev                 # ローカル起動。AIバインディングはリモート実行なので、これもトークンが必要
````

## 環境変数

クラウドセッションの環境設定から注入されるもの:

- `CLOUDFLARE_API_TOKEN` — wrangler の非対話認証用。**未設定なら deploy は行わず、`npm run check` までで止めて報告する**。クラウド環境では値は `placeholder` のダミーでよく、実際の認証は環境設定の「API 認証情報」経由でプロキシが付与する(`docs/HANDOFF.md` 1.3)
- `CLOUDFLARE_ACCOUNT_ID` — 対象アカウント
- `WRANGLER_SEND_METRICS=false` — テレメトリ送信を止める

`wrangler.toml` の `[vars]` にコミットされているもの(レート制限。秘密情報ではないので平文でよい):

- `RATE_LIMIT_PER_IP_MAX`(既定 `30`)/ `RATE_LIMIT_GLOBAL_MAX`(既定 `500`)/ `RATE_LIMIT_WINDOW_SECONDS`(既定 `3600`)
- 調整は `wrangler.toml` の値を書き換えるだけ。`src/index.js` は触らない

## 作業ルール

1. **秘密情報をコミットしない**。トークン・アカウントIDをファイルに書かない。`wrangler.toml` に `account_id` を追記しない
2. **`SOLUTION`(数独の正解)は絶対に Jev に送らない**。送ってよいのは「現時点で埋まっているマス(過去の周の推測込み、正誤問わず)」だけ。これが崩れると実験として無意味になる(`docs/DESIGN.md` の不変条件を参照)
3. Jev のレスポンス形式(`answers.<key>.choice / confidence / probabilities`)は2026-09-21 に実環境で確認した形式(`docs/DESIGN.md` 3.4)。**実際に叩いて形が違ったら `handleJudge` を直し、`docs/DESIGN.md` の該当節も同時に更新する**
4. **レート制限の上限を理由なく緩めない**(`RATE_LIMIT_PER_IP_MAX` / `RATE_LIMIT_GLOBAL_MAX` を上げる、または `RATE_LIMITER` バインディングを外すなど)。コストの青天井を防ぐための唯一の砦なので、緩める変更を求められたら、なぜ必要かを報告に明記する
5. 変更後は必ず `npm test` と `npm run check` を通す。デプロイできる環境なら `npm run deploy` → `curl` で `/api/judge` を叩いて動作確認し、結果(レイテンシ・実際のレスポンスJSON)を報告に含める
6. UIの見た目(ダーク基調、IBM Plex、緑=正解/赤=不正解/アクセント色=フォーカス)は維持する。大きなデザイン変更は指示があるときだけ
7. コメント・ドキュメント・コミットメッセージは日本語でよい。識別子は英語
8. 分からないこと・仕様の曖昧さは推測で埋めず、報告の中で質問として挙げる
9. 実装は Issue 単位で進め、PR にしてテストとレビューを通してからマージする。手順とモデルの使い分けは `docs/HANDOFF.md` に従う

## 現在の状態(2026-09-21)

- v0.1 を Issue 単位で実装中。進捗は GitHub の Issues / PR を参照(`docs/HANDOFF.md` の「現在地」も併せて更新する)
- デプロイ済み: https://sudoku-calibration-check.takashi-kono-rb.workers.dev 。フロントエンド(Issue #3)もマージ済みで、v0.1 の機能はすべて実装済み。実環境での UI 確認(SPEC 6章の「デプロイ後」の項目)はマージ後のデプロイで行う
- **Jev は 2026-09-21 に Worker 経由で実環境検証済み**(Issue #4)。レスポンスは AI Gateway のラッパー付きだった(`docs/DESIGN.md` 3.4)。`confidence` は `probabilities[choice]` と一致せず、同じ入力でも `choice` が揺れる
- レート制限のカウンタは Durable Object(`RATE_LIMITER` / `RateLimitCounter`)。`wrangler deploy` が `[[migrations]]` から作るので、ネームスペース作成のような手作業は不要(Issue #10 で Workers KV から移行。KV は結果整合で全体上限が分散アクセスに効かなかった)。PR #14 でマージ・デプロイ済み。`GET /api/status` で残数を読める(#18)
- マージ済み PR: #7(Worker 本体)、#9(Jev 実レスポンス形式 + KV id)、#11(#7/#9 のレビュー指摘)、#13(フロントエンド)、#14(レート制限を Durable Object に置き換え)、#22(モデル方針)、#23(`/api/status`)
- 数独ジェネレーター/ソルバー(#5)は実装済み。「新しい問題」ボタンで毎回違う問題を出せる。これに伴い Worker 側の入力検証から固定問題(`GIVEN`)前提の項目を外した(`docs/DESIGN.md` 3.3)
- 既知の未実装: 集計ビュー(信頼度較正図)(#6)、Playwright E2E スモーク(#17)、AbortController + 振る舞いテスト(#19)、難易度(#21)
- 要判断(オーナー): IP 単位のレート制限(30 回/時)の緩和可否は Issue #20 を参照。上限を緩める変更は作業ルール4によりオーナーの判断が必要
