# sudoku-calibration-check

数独のマスを1つずつ「何の数字か」AIに聞き、返ってきた確率と実際の正解を突き合わせて、
**「較正された確率」という主張が本当かを目で確かめる**ための小さな実験用 Web アプリです。
Cloudflare Workers 1つで完結し、ビルドステップはありません。判定ループ・採点・周回はすべて
ブラウザ側で動き、Worker は「1マス分の確率を聞いて返す」だけの薄い層です。
詳しい仕様と設計は [`docs/`](./docs/) を参照してください
([SPEC](./docs/SPEC.md) / [DESIGN](./docs/DESIGN.md) / [HANDOFF](./docs/HANDOFF.md))。

## 必要なもの

- Node.js 22 以上
- Cloudflare アカウント(Workers AI と Workers KV を使います)

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

## 初回だけ必要な手作業: KV ネームスペースの作成

レート制限のカウンタに Workers KV を使います。`wrangler.toml` の `RATE_LIMIT_KV` の `id` は
プレースホルダー(`REPLACE_WITH_KV_NAMESPACE_ID`)のままなので、**初回デプロイ前に一度だけ**
ネームスペースを作り、その id を貼り付けてください。

```sh
npx wrangler kv namespace create RATE_LIMIT_KV
```

出力された `id` を `wrangler.toml` の以下の箇所に書き込んでコミットします(id は秘密情報では
ありません)。

```toml
[[kv_namespaces]]
binding = "RATE_LIMIT_KV"
id = "REPLACE_WITH_KV_NAMESPACE_ID"  # ← ここを差し替える
```

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
| `/` | GET | フロントエンド一式(HTML)。**現時点では「実装中」と表示するだけの仮ページ**で、本格的なUIは別 Issue で入ります |
| `/api/judge` | POST | 盤面と対象マスを受け取り、`{ probabilities, choice, confidence }` を返す |

それ以外のパスは 404 です。`/api/judge` は `content-type: application/json` 以外を 415 で
弾き、CORS ヘッダーも付けていないため、他サイトのページからは呼べません。

## レート制限

`/api/judge` には IP 単位と全体の2段構えのレート制限があります。上限とウィンドウ幅は
`wrangler.toml` の `[vars]`(`RATE_LIMIT_PER_IP_MAX` / `RATE_LIMIT_GLOBAL_MAX` /
`RATE_LIMIT_WINDOW_SECONDS`)だけで調整でき、コードを触る必要はありません。
コストの上限を確保するための仕組みなので、理由なく緩めないでください。

## ライセンス

[MIT](./LICENSE)
