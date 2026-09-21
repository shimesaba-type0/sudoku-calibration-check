# sudoku-calibration-check

Cloudflare Workers 上で動作するアプリケーションです。Workers AI を利用します。

## 必要なもの

- Node.js 22 以上
- Cloudflare アカウント(Workers AI を使うため)

## セットアップ

```sh
npm install
npx wrangler login
```

## 開発

```sh
npm run dev
```

`npm run dev` はローカル開発サーバーを起動します。Workers AI バインディングはローカルでもリモートの推論を呼び出すため、Cloudflare にログインしている必要があります。

## 型定義の生成

`wrangler.jsonc` のバインディングを変更したら、`Env` 型を再生成してください。

```sh
npm run cf-typegen
npm run typecheck
```

## デプロイ

```sh
npm run deploy
```

## エンドポイント

| パス | 説明 |
| --- | --- |
| `/` | サービス情報 |
| `/health` | ヘルスチェック |
| `/ai/ping` | Workers AI バインディングの疎通確認 |

## ライセンス

[MIT](./LICENSE)
