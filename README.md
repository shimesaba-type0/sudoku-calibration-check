# sudoku-calibration-check

数独のマスを1つずつ「何の数字か」AI(TypeSafe の Jev、または Anthropic の Claude)に聞き、返ってきた確率と実際の正解を突き合わせて、
**「較正された確率」という主張が本当かを目で確かめる**ための小さな実験用 Web アプリです。
Cloudflare Workers 1つで完結し、ビルドステップはありません。判定ループ・採点・周回はすべて
ブラウザ側で動き、Worker は「1マス分の確率を聞いて返す」だけの薄い層です。
詳しい仕様と設計は [`docs/`](./docs/) を参照してください
([SPEC](./docs/SPEC.md) / [DESIGN](./docs/DESIGN.md) / [HANDOFF](./docs/HANDOFF.md))。

## 必要なもの

- Node.js 22 以上
- Cloudflare アカウント(Workers AI と Durable Objects を使います)

## セットアップ

```sh
npm install
```

## テスト

Cloudflare の認証もネットワークも不要です。Worker をモックの `env` で直接呼びます。

```sh
npm test
```

## 設定の検証

`wrangler deploy --dry-run` を実行します。こちらも認証は不要です。

```sh
npm run check
```

## E2E スモークテスト

Playwright でブラウザを実際に操作し、画面が一通り動くことを確認します。`playwright` は
`devDependencies` に含めていないので、初回は `npm install --no-save playwright` で入れてください。
既定はモックモード(`/api/judge` をこのスクリプト自身がモックするので認証不要)で、
`npm run e2e -- --url <デプロイ先URL>` を付けると実際にデプロイした Worker を最大3判定だけ叩きます
(詳細は `scripts/e2e/smoke.mjs` の冒頭コメント)。

```sh
npm run e2e                          # モックモード(--mode mixed が既定)
npm run e2e -- --mode correct        # 完了バナーの確認など
npm run e2e -- --url https://sudoku-calibration-check.takashi-kono-rb.workers.dev
```

プロキシ経由でしか外に出られない環境(クラウドセッションなど)では、`E2E_PROXY=http://127.0.0.1:PORT`
でブラウザにプロキシを渡し、プロキシが TLS を差し替える場合は `E2E_IGNORE_HTTPS_ERRORS=1` も付けます。

## レート制限のカウンタ(Durable Object)

レート制限のカウンタは Durable Object(クラス `RateLimitCounter`、バインディング
`RATE_LIMITER`)に置いています。**事前の手作業はありません**。`wrangler deploy` が
`wrangler.toml` の `[[migrations]]` を見てクラスを作るので、フォークして自分のアカウントに
デプロイする場合もそのまま動きます。

```toml
[[durable_objects.bindings]]
name = "RATE_LIMITER"
class_name = "RateLimitCounter"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["RateLimitCounter"]
```

以前は Workers KV を使っていましたが、KV は結果整合で `get` がコロケーションごとに
キャッシュされるため、複数拠点からの同時アクセスでカウントが上書きし合い、全体上限が
本来の目的(分散アクセスへの最終防衛ライン)に対して効いていませんでした
(`docs/DESIGN.md` 3.2)。

## デプロイ

`CLOUDFLARE_API_TOKEN` と `CLOUDFLARE_ACCOUNT_ID` を環境変数で渡します
(`wrangler.toml` に `account_id` は書きません)。

```sh
npm run deploy
```

ローカルで動かす場合は `npm run dev` ですが、AI バインディングはリモートの推論を呼ぶため、
こちらも認証が必要です。

## エンドポイント

| パス | メソッド | 説明 |
| --- | --- | --- |
| `/` | GET | フロントエンド一式(HTML)。数独グリッド、判定パネル、周回ログ、「新しい問題」ボタン(ブラウザ側で唯一解の問題を生成) |
| `/api/status` | GET | レート制限の残数を読むだけで返す(カウンタは加算しない。`Cache-Control: no-store`) |
| `/api/judge` | POST | 盤面と対象マスを受け取り、`{ probabilities, choice, confidence, request }` を返す |

`confidence` は **Jev が返す独自の確信度** で、`probabilities[choice]` とは一致しません
(実測では 0.20 に対して 0.10 など)。較正が本当かを確かめるのに使うのは `probabilities` の
ほうです(`docs/SPEC.md` 4章 / `docs/DESIGN.md` 3.4)。`request` は Worker が Jev に渡した
ペイロードそのもので、画面の「モデルに送ったプロンプト」枠がそのまま表示します(502 にも付きます)。

## Claude(Anthropic API)で比べる(BYOK)

画面の「Jev / Claude」トグルで Claude を選ぶと設定パネルが出ます。**自分の Anthropic API キー**を
入れて保存すると、ブラウザが `https://api.anthropic.com/v1/messages` を **直接** 呼びます
(この Worker は関与せず、キーも受け取りません)。キーはそのブラウザの `localStorage` にだけ保存され、
「キーを消す」で削除できます。利用料は自分の Anthropic アカウントに課金されます。
モデル(`claude-opus-5` / `claude-sonnet-5` / `claude-haiku-4-5`)と思考の有無を選べ、較正図は
モデルごとに絞り込めます。確率は structured outputs で Claude 自身に申告させたものです
(`docs/SPEC.md` 4章「Claude 経路」/ `docs/DESIGN.md` 3.6)。

それ以外のパスは 404 です。`/api/judge` は `content-type: application/json` 以外を 415 で
弾き、CORS ヘッダーも付けていないため、他サイトのページからは呼べません。

## レート制限

`/api/judge` には IP 単位と全体の2段構えのレート制限があります。上限とウィンドウ幅は
`wrangler.toml` の `[vars]`(`RATE_LIMIT_PER_IP_MAX` / `RATE_LIMIT_GLOBAL_MAX` /
`RATE_LIMIT_WINDOW_SECONDS`)だけで調整でき、コードを触る必要はありません。
コストの上限を確保するための仕組みなので、理由なく緩めないでください。
カウンタが使えないときは制限を通さず 503 を返します(フェイルクローズ)。

## ライセンス

[MIT](./LICENSE)
