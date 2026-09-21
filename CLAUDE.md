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
├── wrangler.toml      # Workers AI バインディング(env.AI)、レート制限用KV、[vars]
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

- `CLOUDFLARE_API_TOKEN` — wrangler の非対話認証用。**未設定なら deploy は行わず、`npm run check` までで止めて報告する**
- `CLOUDFLARE_ACCOUNT_ID` — 対象アカウント
- `WRANGLER_SEND_METRICS=false` — テレメトリ送信を止める

`wrangler.toml` の `[vars]` にコミットされているもの(レート制限。秘密情報ではないので平文でよい):

- `RATE_LIMIT_PER_IP_MAX`(既定 `30`)/ `RATE_LIMIT_GLOBAL_MAX`(既定 `500`)/ `RATE_LIMIT_WINDOW_SECONDS`(既定 `3600`)
- 調整は `wrangler.toml` の値を書き換えるだけ。`src/index.js` は触らない

## 作業ルール

1. **秘密情報をコミットしない**。トークン・アカウントIDをファイルに書かない。`wrangler.toml` に `account_id` を追記しない
2. **`SOLUTION`(数独の正解)は絶対に Jev に送らない**。送ってよいのは「現時点で埋まっているマス(過去の周の推測込み、正誤問わず)」だけ。これが崩れると実験として無意味になる(`docs/DESIGN.md` の不変条件を参照)
3. Jev のレスポンス形式(`answers.<key>.choice / confidence / probabilities`)は2026年9月時点の Cloudflare 公式ドキュメント準拠。**実際に叩いて形が違ったら `handleJudge` を直し、`docs/DESIGN.md` の該当節も同時に更新する**
4. **レート制限の上限を理由なく緩めない**(`RATE_LIMIT_PER_IP_MAX` / `RATE_LIMIT_GLOBAL_MAX` を上げる、または `RATE_LIMIT_KV` を外すなど)。コストの青天井を防ぐための唯一の砦なので、緩める変更を求められたら、なぜ必要かを報告に明記する
5. 変更後は必ず `npm test` と `npm run check` を通す。デプロイできる環境なら `npm run deploy` → `curl` で `/api/judge` を叩いて動作確認し、結果(レイテンシ・実際のレスポンスJSON)を報告に含める
6. UIの見た目(ダーク基調、IBM Plex、緑=正解/赤=不正解/アクセント色=フォーカス)は維持する。大きなデザイン変更は指示があるときだけ
7. コメント・ドキュメント・コミットメッセージは日本語でよい。識別子は英語
8. 分からないこと・仕様の曖昧さは推測で埋めず、報告の中で質問として挙げる
9. 実装は Issue 単位で進め、PR にしてテストとレビューを通してからマージする。手順とモデルの使い分けは `docs/HANDOFF.md` に従う

## 現在の状態(2026-09-21)

- v0.1 を Issue 単位で実装中。進捗は GitHub の Issues / PR を参照(`docs/HANDOFF.md` の「現在地」も併せて更新する)
- **まだ一度も実環境で Jev を叩いていない**。実装が揃ったら最初のタスクは「本当に動くかの検証」
- **デプロイ前に必須の手作業**: `wrangler.toml` の `RATE_LIMIT_KV` の `id` がプレースホルダー(`REPLACE_WITH_KV_NAMESPACE_ID`)のまま。`npx wrangler kv namespace create RATE_LIMIT_KV` を実行し、出力された id に置き換えてからでないと deploy が失敗する
- 既知の未実装: 数独ジェネレーター/ソルバー、集計ビュー(信頼度較正図)
