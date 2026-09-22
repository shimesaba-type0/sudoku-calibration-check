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
| `/` | GET | フロントエンド一式(HTML)。数独グリッド、判定パネル、周回ログ、「新しい問題」ボタン(ブラウザ側で唯一解の問題を生成)。`?embed=1` 等の URL パラメータで比較モードの iframe から埋め込める(下記) |
| `/compare` | GET | 比較モード(下記)。`/` と同じ HTML を返す |
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
モデルごとに絞り込めます。1 問あたり約 78 回呼ぶので、Opus 5 + 思考ありでは 1 問で相応の料金になります
(この経路に Worker のレート制限は効きません)。確率は structured outputs で Claude 自身に申告させたものです
(`docs/SPEC.md` 4章「Claude 経路」/ `docs/DESIGN.md` 3.6)。

## 確信度順モード

画面の「左上から / 確信度順」トグル(既定「左上から」)で、マスを聞く順番を切り替えられます。
「確信度順」では、その周でまだ確定していないマスの中から「最も確定しやすいマス」をまず1回
モデルに選ばせ(マス選び)、選ばれたマスだけを従来どおり数字判定します。1マスあたりの API
呼び出しが2回になるぶん、レート制限・料金・所要時間はおよそ倍かかります。マス選びの直後は
グリッドに候補マスの確率をヒートマップ(背景の濃さ)で表示します。モデル切り替えと同じく、
実行中・停止中は切り替えられません(`docs/SPEC.md` 3章 F1・F3、`docs/DESIGN.md` 4章)。

## 比較モード

`/compare` を開くと、同じ問題を Jev と Claude に同時に解かせて左右に並べて見比べられます。
上部バーの「新しい問題」「実行」「停止」「リセット」と各種トグルが、内部で `/` を埋め込んだ
2枚の `<iframe>`(`?embed=1&model=jev...` / `?embed=1&model=claude...`)を `postMessage` で
同時に操作します(判定ループの状態はページに1組しかない設計のままで、2インスタンス化は
していません)。左右とも同じ `localStorage` を共有する(記録は追記のたびに読み直して書くので、2 枚が同時に書いても失われない)ので、Claude 側を動かすには通常ページの
「Claude の設定」で先に API キーを保存しておく必要があります(未設定だとその側だけエラー表示
になり、もう片方はそのまま続きます)。詳細は `docs/SPEC.md` 3章 F1' / `docs/DESIGN.md` 8章。

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
