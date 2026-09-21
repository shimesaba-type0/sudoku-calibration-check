# 設計書 — 数独キャリブレーションチェック

最終更新: 2026-09-21 / 対象バージョン: v0.1

## 1. 全体構成

````text
┌──────────────┐   GET /              ┌──────────────────────┐
│   ブラウザ    │ ───────────────────▶ │  Cloudflare Worker    │
│  (素のJS)    │ ◀─────────────────── │  src/index.js         │
│              │   HTML一式            │                      │
│  判定ループ   │                      │  POST /api/judge     │
│  を駆動      │   POST /api/judge    │    ├─ 入力検証         │
│              │ ───────────────────▶ │    ├─ state/questions │
│              │ ◀─────────────────── │    │  を組み立て        │
│              │   {probabilities,    │    └─ env.AI.run(     │──▶ Workers AI
│              │    choice,confidence}│         'typesafe/jev')│    typesafe/jev
└──────────────┘                      └──────────────────────┘
````

- **判定の順序制御・周回ロジック・採点はすべてブラウザ側**。Worker は「1マス分の確率を Jev に聞いて返す」だけの薄い層
- 判定処理(`/api/judge`)はステートレス。リクエストで受け取った盤面だけを見て Jev に聞き、結果を返す。盤面・判定結果・セッションは一切保存しない。Workers KV はレート制限のカウンタ(3.2)にだけ使う
- 正解(`SOLUTION`)は `PAGE_HTML` 内のブラウザ用スクリプトにだけ定義する。Worker 側の判定コード(`handleJudge` とその配下)からは参照できない構造にし、Jev にも渡さない。採点はブラウザで行う(理由は 8 章、検証方法は 10 章)

## 2. ファイル構成と責務

| ファイル | 責務 |
|---|---|
| `wrangler.toml` | Worker名、エントリ、`compatibility_date`、`[ai] binding = "AI"`、`[[kv_namespaces]] binding = "RATE_LIMIT_KV"`、`[vars]`(レート制限の上限値)。詳細は 6 章 |
| `package.json` | wrangler 4.x を devDependency に固定。`check` / `deploy` / `dev` / `test` スクリプト |
| `src/index.js` | Worker本体。`checkRateLimit`、`handleJudge`、`PAGE_HTML`、`fetch` ハンドラ |
| `test/*.test.js` | Node 標準の `node:test` によるテスト。モックの `env` で Worker を直接呼ぶ(10 章) |
| `.github/workflows/ci.yml` | GitHub Actions。push / PR ごとに `npm test` と `npm run check` を実行 |
| `CLAUDE.md` | Claude Code 向けの作業ルール |
| `docs/*.md` | 仕様・設計・引き継ぎ手順 |

## 3. Worker 側設計(`src/index.js`)

### 3.1 ルーティング

````javascript
export default {
  async fetch(request, env) {
    var url = new URL(request.url);
    if (url.pathname === "/api/judge" && request.method === "POST") return handleJudge(request, env);
    if (url.pathname === "/" && request.method === "GET") return new Response(PAGE_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
    return new Response("Not found", { status: 404 });
  },
};
````

### 3.2 `checkRateLimit(request, env)`

IP単位・全体、の2段構えの固定ウィンドウ・レート制限。`handleJudge` の先頭で呼ぶ。

- ウィンドウ幅 `windowSeconds`、IP単位上限 `perIpMax`、全体上限 `globalMax` は `env.RATE_LIMIT_WINDOW_SECONDS` / `env.RATE_LIMIT_PER_IP_MAX` / `env.RATE_LIMIT_GLOBAL_MAX` から読む(それぞれ既定 3600 / 30 / 500)
- 現在時刻を `windowSeconds` で割った商を `bucket` とし、`rl:global:<bucket>` と `rl:ip:<ip>:<bucket>` の2つのKVキーでカウントする(固定ウィンドウ方式。ウィンドウの境界をまたぐ攻撃には多少甘いが、実装が単純で十分)
- 戻り値は `{ allowed, scope?, reason?, headers }`。`scope` は拒否したときだけ入り、`"global"` / `"ip"` / `"kv"` のいずれか。`handleJudge` は `"kv"` を 503、それ以外を 429 に対応づける
- 先に **全体** を見て、超過していれば即座に `{ allowed:false, scope:"global", reason, headers }` を返す(全体超過ならIP単位のチェックやKV書き込みをする意味が無いため、IP単位のキーは読みもしない)
- 次に **IP単位** を見て、超過していれば同様に `scope:"ip"` で拒否
- どちらも下回っていれば、両方のキーを +1 して `expirationTtl: windowSeconds + 60` で `Promise.all` で並行に書き込み、`{ allowed:true, headers }` を返す。TTLをウィンドウ幅より60秒長くしているのは、次のバケットの書き込みと若干重なっても古いキーが自然に消えるようにするため
- `[vars]` の値は **10進整数の文字列としてそのまま読めて1以上のときだけ** 採用し、それ以外(空文字・`" 30 "`・`"1e3"`・`"0x10"`・`"0"` など)は既定値に落とす。緩い数値変換をすると、書き間違いで上限が 0(全面停止)や想定外の値になる
- KVに入っていたカウンタが10進整数として読めない場合は **上限超過として扱う**(フェイルクローズ)。数えられないまま AI を呼ぶよりは止める
- **バインディングの有無と、KVの障害は区別する**
  - `env.RATE_LIMIT_KV` が無い → 何もチェックせず `{ allowed:true, headers:{} }`(フェイルオープン。`wrangler dev` などKV未設定の環境でアプリ自体が動かなくなるのを防ぐ)
  - バインディングはあるのに `get` / `put` が例外を投げる → **フェイルクローズ**。`console.error` でログを残し、`{ allowed:false, scope:"kv", reason:"レート制限の記録に失敗しました。しばらくしてから再試行してください", headers:{ "Retry-After": "60" } }` を返す。`handleJudge` はこれを 503 にする。回数を数えられない状態で Workers AI を呼ぶと、コストの上限が外れてしまうため
- KVは強い一貫性を持たないので、同時に大量のリクエストが来た際に多少のオーバーカウント/アンダーカウントは起こり得る。このアプリの目的(コストの青天井を防ぐ大まかな安全弁)には十分な精度と判断し、Durable Objectsのような厳密な実装は採用しない

### 3.3 `handleJudge(request, env)`

0. `content-type` ヘッダーのメディアタイプ(`;` の前)が `application/json` と一致しなければ 415(`charset` 等のパラメータは無視。前方一致にしないのは `application/json-patch+json` のような別タイプを通さないため)(`{ "error": "content-type は application/json である必要があります" }`)。**レート制限より前**に行う。これは 7 章のクロスサイト対策の要なので外さない
1. `checkRateLimit` を呼ぶ。`allowed:false` かつ `scope` が `"ip"` / `"global"` なら 429(`error` に理由、レスポンスヘッダーに `Retry-After` と `X-RateLimit-Scope`)、`scope` が `"kv"` なら 503(`error` に理由、`Retry-After: 60`)
2. `request.json()` → 失敗なら 400
3. 入力を検証し、不備なら 400 を返す。検証項目は次の通り
   - `puzzle` が長さ9の配列で、各要素が9文字の文字列。文字は `1`〜`9` と `.` のみ
   - `target.row` / `target.col` が 0〜8 の整数
   - `puzzle` の与えられたマス(`GIVEN`)が改変されていない(与えられた数字がそのまま入っている)
   - `target` が `GIVEN` の空マスである(与えられたマスを判定対象にしない)
   - `puzzle` の `target` のマスが `.`(空)である。再判定のときも対象マスの前回の推測は消して送る(アンカリング回避。4.2 `buildSnapshot`・SPEC F3)
   - `GIVEN` は秘密ではないので Worker 側にも持つ。`SOLUTION` は持たない(1 章・10 章)
4. `criteria` を `{ "1": "the digit 1", ..., "9": "the digit 9" }` として生成
5. `env.AI.run("typesafe/jev", { state, questions })` を呼ぶ。例外は 502(`raw` に例外メッセージを200文字まで入れ、`console.error` でログを残す)
6. 返ってきた `result.answers.digit` を検証し、次のどれかを満たさなければ 502(`raw` に生レスポンスを添えて返す。デバッグ用)
   - `answers.digit` が存在し、オブジェクトである
   - `probabilities` がオブジェクトで、キーがちょうど `"1"`〜`"9"` の9個。値はすべて有限の数値
   - `choice` が文字列で、`"1"`〜`"9"` のいずれか
   - `confidence` が有限の数値
7. `{ probabilities, choice, confidence }` に絞って 200 で返す。レスポンスヘッダーに `X-RateLimit-Remaining-IP` / `X-RateLimit-Remaining-Global`(その時点の残り回数)を付ける

`state` はオブジェクトで渡す(Jev は string / object / array を受け付ける):

````javascript
state: {
  puzzle: puzzle,          // 9行の文字列配列。"." が未確定
  target: target,          // { row, col }
  note: "puzzle is a 9x9 Sudoku grid ... Standard Sudoku rules apply: ..."
}
````

`note` は Jev にルールを伝えるための固定文。ルール自体を推論させたいわけではなく、「何を聞かれているか」を誤解させないための最低限の説明。

### 3.4 Jev のリクエスト/レスポンス形式(2026-09 時点、Cloudflare公式ドキュメント準拠)

リクエスト:

````javascript
await env.AI.run("typesafe/jev", {
  state: <string | object | array>,
  questions: {
    <key>: {
      type: "choice",                       // "choice" | "score" | "noul"
      instructions: "<質問文>",
      criteria: { <option>: "<説明>", ... } // choice: 1〜255個のオブジェクト
                                            // score : 2〜10要素の順序付き配列
                                            // noul  : 省略可。{true:"...", false:"..."} で補足可
    }
  }
})
````

レスポンス(`choice` の場合):

````json
{
  "model": "jev-1.13.0",
  "answers": {
    "digit": {
      "type": "choice",
      "choice": "4",
      "confidence": 0.61,
      "probabilities": { "1": 0.03, "2": 0.05, "3": 0.02, "4": 0.61, "5": 0.08, "6": 0.07, "7": 0.04, "8": 0.06, "9": 0.04 }
    }
  },
  "usage": { "input_tokens": 380, "output_tokens": 45 }
}
````

参考(将来の転用用):

- `noul` のレスポンスは `{ "type": "noul", "noul": 0.98 }`(確率のみ。閾値判断はアプリ側)
- `score` は順序付きの段階から1つを選び、同様に確率を返す

**この形式は変わり得る。** Jev は公開直後で頻繁に更新されているため、初回の実環境テストで必ず生レスポンスを確認し、違っていればこの節と `handleJudge` を同時に直す。

### 3.5 `PAGE_HTML`

バッククォート付きテンプレートリテラルにHTML全体を格納。中で `${...}` は使っていない(素のHTMLを埋めているだけ)ので、テンプレート内のJSで `${}` を書く必要が出たら `\${}` とエスケープすること。

`PAGE_HTML` は **`src/index.js` の最後の宣言に固定する**。不変条件7のテスト(10 章)は「ファイル最後のバッククォート = テンプレートの閉じ」と見なして外側のソースを切り出し、その後ろに `;` と空白しか無いことも併せて検査する。ここに何かを足すと検査が無効になるので、新しいコードは `PAGE_HTML` より前に書く。

## 4. フロントエンド設計(`PAGE_HTML` 内の `<script>`)

### 4.1 状態

````javascript
var state = {
  round: 1,            // 現在の周
  values: {},          // "r-c" → { value: "4", status: "correct" | "incorrect" }。周をまたいで保持
  focusedKey: null,    // 判定中のマス "r-c"
  currentProbs: null,  // [{ digit:"1", pct:61, isPick:true }, ...] 1〜9順
  roundLog: [],        // 表示用文字列の配列
  running: false,
  done: false,
  roundsToSolve: null, // 完了時の周数
  speedMode: "slow"    // "slow" | "fast"
};
// 描画に不要な進行管理はモジュール変数
var queue = [];                 // この周でまだ判定していないマス [{r,c}]
var roundWrong = [];            // この周で不正解だったマス。次の周の queue になる
var roundTally = { correct:0, total:0 };
var started = false;
var pendingCommit = null;       // API結果を受けて確定待ちの1件
````

### 4.2 関数と責務

| 関数 | 責務 |
|---|---|
| `buildSnapshot()` | `GIVEN` + `state.values`(正誤問わず)から9行の文字列配列を作る。未確定は `.`。**判定対象のマスだけは `.` にして送る(他のマスの過去の推測は正誤問わず残す)**。Worker 側も 3.3 でこれを検証する |
| `judgeCell(r,c)` | `/api/judge` を `fetch`。非2xxは `Error` にして投げる |
| `focusNext()` | `queue` から1つ取り出しフォーカス→`judgeCell`→バー表示→(待ち)→`commitFocused`→(待ち)→再帰。`queue` が空なら `finalizeRound` |
| `commitFocused()` | `pendingCommit` を `state.values` に反映し、`roundTally`/`roundWrong` を更新 |
| `finalizeRound()` | ログ追記。不正解0なら完了、そうでなければ `queue = roundWrong` で次の周へ |
| `run()` | 初回のみ queue を全空マスで初期化し `focusNext` を開始 |
| `reset()` | 進行管理と `state` を初期化(`speedMode` は維持) |
| `render()` | `state` から DOM(グリッド・統計・バー・ログ・バナー・ボタン)を **全部 innerHTML で再生成** |
| `buildCellStyle()` | マスの状態(given/pending/correct/incorrect + focused)からインラインstyle文字列を返す |

### 4.3 状態遷移(1マス)

````text
idle ──run()──▶ focusNext()
                 │ focusedKey=key, currentProbs=null, render()
                 ▼
              judgeCell()  ── 失敗 ──▶ showError(), running=false, 停止
                 │ 成功
                 ▼
            currentProbs=probs, pendingCommit={...}, render()
                 │ (slow: 700ms)
                 ▼
            commitFocused(): values[key]=…, focusedKey=null, render()
                 │ (slow:150ms / fast:20ms)
                 ▼
            queue 残あり → focusNext() / 空 → finalizeRound()
````

### 4.4 描画方針

- 状態が変わるたびに `render()` で該当領域を丸ごと再生成する。81マス+9本のバー程度なので差分更新は不要
- 色や枠線は `buildCellStyle` が返すインラインstyleで指定(クラス切り替えではなく、状態から毎回組み立てる)

## 5. データ

固定の1問。Wikipedia の数独記事で使われている例題と同じ。

````javascript
var GIVEN = [ "53..7....", "6..195...", ".98....6.", "8...6...3", "4..8.3..1", "7...2...6", ".6....28.", "...419..5", "....8..79" ];
var SOLUTION = [ "534678912", "672195348", "198342567", "859761423", "426853791", "713924856", "961537284", "287419635", "345286179" ];
````

空マスは51。`SOLUTION` は採点表示にだけ使う。

## 6. 設定・デプロイ

- `wrangler.toml`: `name`, `main = "src/index.js"`, `compatibility_date`, `[ai] binding = "AI"`, `[[kv_namespaces]] binding = "RATE_LIMIT_KV"`, `[vars]`(レート制限の上限値)。`account_id` は書かない(環境変数 `CLOUDFLARE_ACCOUNT_ID` で渡す)
- **初回デプロイ前に1回だけ**、KVネームスペースを作る必要がある: `npx wrangler kv namespace create RATE_LIMIT_KV`。出力される `id` を `wrangler.toml` の `RATE_LIMIT_KV` の `id` に貼り付ける(このリポジトリでは `REPLACE_WITH_KV_NAMESPACE_ID` がプレースホルダー)
- `package.json`: `"wrangler": "^4"`、scripts は `check`(`--dry-run`)/`deploy`/`dev`
- 認証: `CLOUDFLARE_API_TOKEN`(非対話)。`wrangler login` はブラウザが要るのでクラウドセッションでは使えない
- `wrangler dev` は AI バインディングをリモート実行するため、これもトークンが要る

## 7. セキュリティ・運用上の注意

- `/api/judge` は認証なしだが、F6のレート制限(IP単位30回/時・全体500回/時、既定値)でコストの上限を確保している。値は `wrangler.toml` の `[vars]` で調整可能
- 上限を緩める(数値を大きくする、または `RATE_LIMIT_KV` バインディングを外す)と、コストの上限が無くなる。特にバインディングを外すとフェイルオープンの設計上、制限なしで動いてしまう(KVが一時的に落ちた場合は 3.2 のとおりフェイルクローズで 503)。**理由なく緩めない**
- リポジトリには秘密情報を置かない。`account_id` も置かない
- `/api/judge` には CORS ヘッダーを付けない。加えて **`content-type` のメディアタイプが `application/json` でないリクエストは 415 で弾く**(`handleJudge` の最初、レート制限より前)。この2つはセットで意味を持つ: `application/json` の POST はブラウザで必ずプリフライトが必要になり、CORS ヘッダーを返していないのでプリフライトが通らず、他サイトのページからは呼べない。一方 `text/plain` などプリフライト不要の content-type はフォーム送信等でクロスサイトに投げられてしまうため、415 で入口を閉じる(第三者のサイトに埋め込まれて Workers AI のコストを消費される経路を塞ぐ)。`curl` 等からの直接アクセスはレート制限で頭打ちにする
- `GET /` のレスポンスには `X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`Content-Security-Policy: frame-ancestors 'none'` を付ける(クリックジャッキング対策。インラインスクリプトを使うため、それ以上の CSP はかけない)
- 3.3 の検証を通った盤面文字列だけが Jev に渡る(形式・`GIVEN` との一致・対象マスが空であることまで見る)
- `SOLUTION` は Wikipedia の例題の答えなので秘密ではない。守るべきは「Jev に渡る `state` に `SOLUTION` が混ざらないこと」であり、そのために `SOLUTION` をブラウザ用スクリプトの中にだけ置き、Worker の判定コードから構造的に隔離する(8 章)

## 8. 設計上の判断と理由

| 判断 | 理由 |
|---|---|
| 1ファイル・フレームワークなし | 読める・デプロイできる・壊れにくいを優先。実験装置に抽象化は要らない |
| 判定ループをブラウザ側で駆動 | Worker をステートレスに保てる。1マスごとの待ち時間(演出)もブラウザ側で自然に入れられる |
| スナップショットに不正解の推測も含める | 「周を重ねて文脈が増えると精度が上がるか」を見るのが目的。正解だけ渡すと SOLUTION のリークになる |
| `SOLUTION` を Worker に渡さない | 実験の前提。Worker 側でも採点しない |
| 固定の1問 | v0.1 の範囲を小さくするため。ジェネレーター/ソルバーは次のタスク |
| 速度モード2択 | 「じっくり見る」と「Jevの速さを体感する」の両方が目的 |
| IP単位+全体の2段レート制限 | IP単位だけだと分散アクセス(多数のIPからの同時アクセス)で回避され、コストが青天井になる。全体上限を最終防衛ラインとして併設 |
| Durable ObjectsでなくKVの固定ウィンドウ | 要求される精度が「大まかにコストを頭打ちにする」程度で十分なため。実装がシンプルな方を優先 |
| レート制限をフェイルオープンに | KVバインディングが無い環境(ローカルdevなど)でアプリ自体が止まらないようにするため。本番では必ずKVを設定する前提 |
| 採点をブラウザ側で行い、`SOLUTION` を Worker の判定コードから隔離 | `SOLUTION` は秘密ではなく、守るべきは「Jev に渡さないこと」。Worker 側で採点すると `SOLUTION` と Jev 呼び出しが同じ関数の近くに並び、将来の変更で `state` に混ざる事故が起きやすい。ブラウザ用スクリプトの中にだけ置けば、`handleJudge` からは参照のしようがなく、テストで機械的に検証できる(10 章) |
| Cloudflare 公式のテストツールでなく `node:test` | 単一ファイルの Module Worker をモックの `env` で直接呼ぶだけなら Node 22 の標準機能で足りる。依存を増やさず、Cloudflare の認証なしで CI が回る |

## 9. 変更時の不変条件

1. Jev に渡す `state` に `SOLUTION` 由来の情報を入れない
2. 正解したマスは以後の周で再判定しない
3. `probabilities` は必ず `"1"`〜`"9"` の順で表示する(確率順に並べ替えない。見比べやすさ優先)
4. エラー時は必ず `running=false` にして止める(無限ループ・無駄な課金を防ぐ)
5. Jev のレスポンス形式を変えたら、この設計書の 3.4 と `SPEC.md` の 4 を同時に更新する
6. レート制限の上限値はコード中にハードコードせず、必ず `wrangler.toml` の `[vars]` 経由にする(調整のたびにコードを触る羽目にしない)
7. `SOLUTION` という識別子は `PAGE_HTML` の中にだけ現れる。Worker 側のコードに書かない(10 章のテストで機械的に確認する)
8. `npm test` と `npm run check` が通らない変更はマージしない

## 10. テスト

`test/` 配下に Node 標準の `node:test` で書く。`npm test` で実行(`node --test "test/**/*.test.js"`。Node 22 の test runner は位置引数のディレクトリを走査しないため、グロブで渡す)。Cloudflare の認証やネットワークは不要。

- `src/index.js` を ES Module として import し、`default.fetch(request, env)` をモックの `env` で直接呼ぶ。Node 22 のグローバル `Request` / `Response` をそのまま使う
- モック `env`
  - `AI.run(model, payload)`: 呼び出しを記録し、3.4 の形式の固定レスポンスを返す。失敗や異常な形を返すケースも用意する
  - `RATE_LIMIT_KV`: `Map` ベースの `get` / `put`(読んだキー・書いたキー・`expirationTtl` を記録する)。`get` / `put` が例外を投げるモードも用意する
    - レート制限のキーにはバケット番号(現在時刻依存)が入る。テスト側でバケットを計算するとウィンドウ境界をまたいだ瞬間に落ちるので、**シードは前方一致で行い、検証は実際に読み書きされたキーからバケットを取り出して行う**
  - `RATE_LIMIT_*`: 文字列で与える(`wrangler.toml` の `[vars]` は文字列として渡ってくるため)
- 必ず含めるテスト
  - **不変条件1**: `AI.run` に渡された `payload` が期待どおりのオブジェクトと **完全に一致する**(`deepStrictEqual`)。期待値の `note` / `instructions` / `criteria` は実装から import せず、テスト側に意図的に複製して持つ(`state` に何かが足されたら落ちるようにするため)。加えて `JSON.stringify` した文字列に `SOLUTION` の9行のどれも含まれていないこと
  - **不変条件7**: `src/index.js` のソースを読み、`PAGE_HTML` のテンプレートリテラルの外に `SOLUTION` という文字列が現れない。閉じバッククォートは「ファイル最後のバッククォート」とし、その後ろが `;` と空白だけであること(= `PAGE_HTML` が最後の宣言であること。3.5)も併せて検査する
  - content-type: `text/plain` や content-type 無しのリクエストが 415 になり、`AI.run` もKVも触られないこと
  - 入力検証: 3.3 の各項目について 400 になること(対象マスが空でない場合を含む)。正常入力で 200 と9キーの `probabilities` が返ること
  - レート制限: IP上限・全体上限それぞれの超過で 429 と `Retry-After` / `X-RateLimit-Scope` が返ること。全体超過時にKVへ書き込まず、IP単位のキーを読みもしないこと。`Retry-After` が `(bucket+1)*window - now` であること。KVのカウンタが壊れていれば超過扱いになること。KV が無ければ通ること(フェイルオープン)。KVの `get` / `put` が例外を投げれば 503 になり `AI.run` が呼ばれないこと(フェイルクローズ)。`[vars]` の値が反映され、紛らわしい表記が既定値に落ちること
  - `AI.run` が例外を投げる / `answers.digit` が無い / `answers.digit` の形が 3.3 の条件を満たさない場合に 502 になること
  - `GET /` が `text/html; charset=utf-8` と 7 章のセキュリティヘッダーを返し、それ以外のパスが 404 であること
- CI(`.github/workflows/ci.yml`)は push と PR で `npm ci` → `npm test` → `npm run check` を実行する。`check` は `wrangler deploy --dry-run` で、認証なしで動く
