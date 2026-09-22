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
- 判定処理(`/api/judge`)はステートレス。リクエストで受け取った盤面だけを見て Jev に聞き、結果を返す。盤面・判定結果・セッションは一切保存しない。永続化しているのはレート制限のカウンタ(Durable Object。3.2)だけ
- 正解(`SOLUTION`)は `PAGE_HTML` 内のブラウザ用スクリプトにだけ定義する。Worker 側の判定コード(`handleJudge` とその配下)からは参照できない構造にし、Jev にも渡さない。採点はブラウザで行う(理由は 8 章、検証方法は 10 章)

## 2. ファイル構成と責務

| ファイル | 責務 |
|---|---|
| `wrangler.toml` | Worker名、エントリ、`compatibility_date`、`[ai] binding = "AI"`、`[[durable_objects.bindings]] name = "RATE_LIMITER"` と `[[migrations]]`、`[vars]`(レート制限の上限値)。詳細は 6 章 |
| `package.json` | wrangler 4.x を devDependency に固定。`check` / `deploy` / `dev` / `test` スクリプト |
| `src/index.js` | Worker本体。`RateLimitCounter`(Durable Object)、`checkRateLimit`、`handleJudge`、`PAGE_HTML`、`fetch` ハンドラ |
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
    if (url.pathname === "/api/status" && request.method === "GET") return readRateLimitStatus(request, env);
    if (url.pathname === "/" && request.method === "GET") return new Response(PAGE_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
    return new Response("Not found", { status: 404 });
  },
};
````

`GET /api/status` は `readRateLimitStatus(request, env)`(3.2)。レート制限のカウンタを `peek` だけで読んで残り回数を返す。判定はしないので `AI.run` は呼ばない(SPEC 4章)。

### 3.2 `checkRateLimit(request, env)`

IP単位・全体、の2段構えの固定ウィンドウ・レート制限。`handleJudge` の先頭(415 の検査の後)で呼ぶ。カウンタは **Durable Object**(`RateLimitCounter`、バインディング `RATE_LIMITER`)に置く。

- ウィンドウ幅 `windowSeconds`、IP単位上限 `perIpMax`、全体上限 `globalMax` は `env.RATE_LIMIT_WINDOW_SECONDS` / `env.RATE_LIMIT_PER_IP_MAX` / `env.RATE_LIMIT_GLOBAL_MAX` から読む(それぞれ既定 3600 / 30 / 500)
- 現在時刻を `windowSeconds` で割った商を `bucket` とする(固定ウィンドウ方式。ウィンドウの境界をまたぐ攻撃には多少甘いが、実装が単純で十分)
- インスタンスは `env.RATE_LIMITER.idFromName("global")`(全体用に1個)と `idFromName("ip:" + ip)`(IPごとに1個)。`ip` は `CF-Connecting-IP`(無ければ `"unknown"`)を64文字に切り詰めたもの
- 戻り値は `{ allowed, scope?, reason?, headers }`。`scope` は拒否したときだけ入り、`"global"` / `"ip"` / `"counter"` のいずれか。`handleJudge` は `"counter"` を 503、それ以外を 429 に対応づける
- **呼ぶ順番と理由**(この順序が安全側に倒れる鍵)
  1. 全体を **`peek`**(読むだけ)。超過していれば `scope:"global"` で拒否し、**IP 側のインスタンスには触らない**(数える意味も書き込む意味も無い)
  2. IP単位を **`increment`**。超過していれば `scope:"ip"` で拒否(このとき全体はまだ +1 しない)
  3. 全体を **`increment`**。1 の `peek` から時間が空いているので、際どい競合で `allowed:false` が返ることがある。そのときは `scope:"global"` で拒否し、**IP 側は 2 で +1 したままにする** —— 数え過ぎ(= 安全側)に倒し、数え漏れ(= コストの上限が外れる)を絶対に作らないため
- 通過したときの `headers` は `X-RateLimit-Remaining-IP` / `X-RateLimit-Remaining-Global`(いずれも `max(0, 上限 - 加算後のカウント)`)。拒否したときは `Retry-After`(= `(bucket+1)*windowSeconds - now`。現在のバケットが終わるまでの秒数)と `X-RateLimit-Scope` を付け、残数は付けない
- `[vars]` の値は **10進整数の文字列としてそのまま読めて1以上のときだけ** 採用し、それ以外(空文字・`" 30 "`・`"1e3"`・`"0x10"`・`"0"` など)は既定値に落とす。緩い数値変換をすると、書き間違いで上限が 0(全面停止)や想定外の値になる
- **バインディングの有無と、カウンタの障害は区別する**
  - `env.RATE_LIMITER` が無い → 何もチェックせず `{ allowed:true, headers:{} }`(フェイルオープン。`wrangler dev` など Durable Object 未設定の環境でアプリ自体が動かなくなるのを防ぐ)
  - バインディングはあるのに呼び出しが例外を投げる / 非2xx を返す / 応答の形が違う → **フェイルクローズ**。`console.error` でログを残し、`{ allowed:false, scope:"counter", reason:"レート制限の記録に失敗しました。しばらくしてから再試行してください", headers:{ "Retry-After": "60" } }` を返す。`handleJudge` はこれを 503 にする。回数を数えられない状態で Workers AI を呼ぶと、コストの上限が外れてしまうため

- **状態の読み取り(`readRateLimitStatus` / `GET /api/status`)は `peek` のみ**。全体と呼び出し元 IP のカウンタを読むだけで加算せず(残数を見るために残数を減らさない)、ウィンドウ幅・上限・バケット計算は `checkRateLimit` と同じヘルパー(`currentWindow` / `clientIp` / `readLimit`)を共有する。バインディングが無ければ `{ rate_limit: "disabled" }`、カウンタの障害は 503 + `Retry-After: 60` と、`checkRateLimit` の区別をそのまま踏襲する(SPEC 4章)

#### `RateLimitCounter`(Durable Object)

カウンタ本体。`ctx` / `env` をコンストラクタで受け取り、`fetch(request)` で操作する。

- リクエスト: `POST { op: "peek" | "increment", bucket: <整数>, max: <上限> }` / レスポンス: `{ allowed: <真偽値>, count: <操作後のカウント> }`
- `peek` … 読むだけ。`allowed` は `count < max`
- `increment` … `count >= max` なら加算せずに `{ allowed:false, count }`、そうでなければ +1 して `{ allowed:true, count: count+1 }`
- ストレージ(`ctx.storage.get/put/delete`)は `count:<bucket>` にカウント、`bucket` に「今生きているバケット番号」を持つ。バケットが変わっていたら呼び出し時に古い `count:<前のバケット>` を削除するので、残るカウンタのキーは常に1つ(KV の `expirationTtl` に相当する後始末)
- ストレージの値が0以上の安全な整数でない(壊れている・改ざんされた)場合は **上限超過として扱う**(フェイルクローズ)。数えられないまま AI を呼ぶよりは止める
- **`cloudflare:workers` の `DurableObject` を継承せず、`fetch` ハンドラ方式にしている**。RPC を使うには継承が必要だが、`cloudflare:workers` は Node の `node:test` から import できず、テストが `src/index.js` をそのまま import できなくなるため(10 章)。Workers ランタイムは継承していないクラスでも `fetch` ハンドラ方式なら動く

#### なぜ KV をやめたか(GitHub Issue #10)

当初はカウンタを Workers KV の固定ウィンドウ・カウンタ(`rl:global:<bucket>` / `rl:ip:<ip>:<bucket>` を読んで +1 して書き戻す)に置いていた。しかし **KV は結果整合で、`get` がコロケーションごとに最大60秒キャッシュされる**ため、複数のコロケーションから同時に来たリクエストが揃って古い値を読み、それぞれ +1 を上書きし合う(lost update)。結果として **全体上限(500回/時)が、それを設けた唯一の目的である分散アクセスに対してほとんど効いていなかった**(実測でも、別コロ経由のリクエストで残数が 28 → 29 に戻る現象を確認した)。

Durable Object は同じ名前のインスタンスが世界に1つしか存在せず、そこへのリクエストは直列に実行され、`ctx.storage` の書き込みは暗黙のトランザクションにまとまる。したがって数え落としが起きない。Workers AI のコストを頭打ちにする砦(7 章 / `CLAUDE.md` 作業ルール4)としては、この厳密さが要る。

なお **これは上限を緩める変更ではない**。`[vars]` の値(30 / 500 / 3600)は据え置きで、「数え漏れによって実質的に緩くなっていた」状態を、設計どおりの厳しさに戻すだけの変更である。

### 3.3 `handleJudge(request, env)`

0. `content-type` ヘッダーのメディアタイプ(`;` の前)が `application/json` と一致しなければ 415(`charset` 等のパラメータは無視。前方一致にしないのは `application/json-patch+json` のような別タイプを通さないため)(`{ "error": "content-type は application/json である必要があります" }`)。**レート制限より前**に行う。これは 7 章のクロスサイト対策の要なので外さない
1. `checkRateLimit` を呼ぶ。`allowed:false` かつ `scope` が `"ip"` / `"global"` なら 429(`error` に理由、レスポンスヘッダーに `Retry-After` と `X-RateLimit-Scope`)、`scope` が `"counter"` なら 503(`error` に理由、`Retry-After: 60`)
2. `request.json()` → 失敗なら 400
3. 入力を検証し、不備なら 400 を返す。検証項目は次の通り
   - `puzzle` が長さ9の配列で、各要素が9文字の文字列。文字は `1`〜`9` と `.` のみ
   - `target.row` / `target.col` が 0〜8 の整数
   - `puzzle` の `target` のマスが `.`(空)である。再判定のときも対象マスの前回の推測は消して送る(アンカリング回避。4.2 `buildSnapshot`・SPEC F3)
   - `puzzle` の埋まっているマスが `MIN_FILLED_CELLS`(17)個以上。17 は一意解を持つ数独の最小ヒント数で、これ未満は数独として成立しない
   - **行・列・箱の矛盾は検証しない**。過去の周の不正解の推測を正誤問わず残して送る設計なので、矛盾した盤面が来るのは正常な状態(8 章)
   - 盤面はブラウザ側のジェネレーターが作る(4.2 `generatePuzzle`)ので、Worker は特定の問題の初期配置を持たない。`GIVEN` も `SOLUTION` も Worker 側には無い(1 章・10 章)
4. `criteria` を `{ "1": "the digit 1", ..., "9": "the digit 9" }` として生成
5. `env.AI.run("typesafe/jev", { state, questions })` を呼ぶ。例外は 502(`raw` に例外メッセージを200文字まで入れ、`console.error` でログを残す)
6. 返ってきたレスポンスから `answers.digit` を取り出して検証し(`extractAnswer` → `validateAnswer`)、次のどれかを満たさなければ 502(`raw` に生レスポンスを添えて返す。デバッグ用)
   - レスポンスがオブジェクトである
   - `state` フィールドがある場合、その値が `"Completed"` である(AI Gateway のラッパー。3.4)。違えば中身を見ずに 502
   - `answers` の取り出しは **`result` がオブジェクトなら `result.answers`、そうでなければトップレベルの `answers`**。ゲートウェイのラッパーが将来外れても動くようにするための2段構え(3.4)
   - `answers` がオブジェクトで、`answers.digit` が存在し、オブジェクトである
   - `probabilities` がオブジェクトで、キーがちょうど `"1"`〜`"9"` の9個。値はすべて有限の数値
   - `choice` が文字列で、`"1"`〜`"9"` のいずれか
   - `confidence` が有限の数値。**値の妥当性は見ない**(Jev 独自の確信度で `probabilities[choice]` とは一致しないため。3.4 / SPEC 4章)
7. `{ probabilities, choice, confidence }` に絞って 200 で返す。`confidence` は Jev の値をそのまま通す(`probabilities[choice]` に差し替えない)
8. `X-RateLimit-Remaining-IP` / `X-RateLimit-Remaining-Global`(その時点の残り回数)は、**レート制限を通過したすべてのレスポンス** に付く(`RATE_LIMITER` バインディングがあるとき。無いフェイルオープン時は残数が存在しないので付かない)。200 だけでなく、その後の 400(入力不正)や 502(AI 失敗・形式不正)にも付く(どれも1回として数えているため)。レート制限より手前で止まる 415 と、制限に引っかかった 429 / 503 には付かない

`state` はオブジェクトで渡す(Jev は string / object / array を受け付ける):

````javascript
state: {
  puzzle: puzzle,          // 9行の文字列配列。"." が未確定
  target: target,          // { row, col }
  note: "puzzle is a 9x9 Sudoku grid ... Standard Sudoku rules apply: ..."
}
````

`note` は Jev にルールを伝えるための固定文。ルール自体を推論させたいわけではなく、「何を聞かれているか」を誤解させないための最低限の説明。

### 3.4 Jev のリクエスト/レスポンス形式(2026-09-21 実測)

`typesafe/jev` は **Cloudflare AI Gateway 経由** で提供されている。Workers AI の他モデルと違い、
REST の `ai/run` ルートやモデルカタログには出てこず、Worker の `env.AI` バインディングからしか
到達できない。課金も Workers AI のニューロンではなく **AI Gateway のクレジット** で行われるため、
アカウントで AI Gateway の課金を有効にしていないと呼び出しが失敗する(`docs/HANDOFF.md` 1.3)。

リクエスト(ここは公開ドキュメントどおりで、実測でも変わらなかった):

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

レスポンス(`choice` の場合)。2026-09-21 に実環境で `env.AI.run` が返した値そのまま:

````json
{
  "state": "Completed",
  "result": {
    "model": "jev-1.13.0",
    "answers": {
      "digit": {
        "type": "choice",
        "choice": "1",
        "probabilities": { "1": 0.2, "2": 0.2, "3": 0.09, "4": 0.2, "5": 0.02, "6": 0.08, "7": 0.07, "8": 0.07, "9": 0.07 },
        "confidence": 0.1
      }
    },
    "usage": { "input_tokens": 665, "output_tokens": 80 }
  },
  "gatewayMetadata": { "keySource": "Unified" }
}
````

- `state` と `gatewayMetadata` は **AI Gateway が付けるフィールド**で、Jev 自身の回答ではない。
  `state` が `"Completed"` 以外なら中身を見ずに 502 にする
- Jev の回答本体は `result` の中の `answers` / `model` / `usage`。公開ドキュメントが載せている
  「素の `{ model, answers, usage }`」はこのラッパーの `result` に相当する
- そのため `handleJudge`(`extractAnswer`)は **`result` がオブジェクトなら `result.answers`、
  そうでなければトップレベルの `answers`** を読む。将来ゲートウェイが外れて素の形に戻っても
  コードを触らずに動く
- **`confidence` は `probabilities[choice]` と一致しない。** 実測で 0.10 対 0.20 / 0.13 対 0.22 /
  0.11 対 0.20 だった。Jev 独自の確信度指標なのでそのまま通し、較正の検証には `probabilities`
  を使う(SPEC 4章)
- `usage.input_tokens` は 1 判定あたり約 665。SPEC 5章の見積り(約400)より多かったので、
  SPEC 5章のコスト試算は実測値に更新した
- 同じ入力を3回投げて `choice` が `1` / `4` / `2` と割れた(正解は `4`)。確率もほぼ平坦
  (最大 0.22)だった。**決定的ではない**。これは不具合ではなく、このアプリが観測したい対象そのもの

参考(将来の転用用):

- `noul` のレスポンスは `{ "type": "noul", "noul": 0.98 }`(確率のみ。閾値判断はアプリ側)
- `score` は順序付きの段階から1つを選び、同様に確率を返す

**この形式は変わり得る。** Jev は公開直後で頻繁に更新されており、ゲートウェイのラッパーも
Cloudflare 側の都合で変わる。形が違っていたらこの節と `handleJudge` を同時に直す
(9 章 不変条件5 / `CLAUDE.md` 作業ルール3)。

### 3.5 `PAGE_HTML`

バッククォート付きテンプレートリテラルにHTML全体を格納。中で `${...}` は使っていない(素のHTMLを埋めているだけ)ので、テンプレート内のJSで `${}` を書く必要が出たら `\${}` とエスケープすること。

`PAGE_HTML` は **`src/index.js` の最後の宣言に固定する**。不変条件7のテスト(10 章)は「行頭の `var PAGE_HTML = \`` = テンプレートの開き」「ファイル最後のバッククォート = テンプレートの閉じ」と見なして外側のソースを切り出し、その後ろに `;` と空白しか無いことも併せて検査する。ここに何かを足すと検査が無効になるので、新しいコードは `PAGE_HTML` より前に書く。`var PAGE_HTML = \`` という文字列はコメントを含めてファイル中に1つだけにする(テストで確認している)。

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
  speedMode: "slow",   // "slow" | "fast"
  errorMessage: null,  // エラーボックスに出す文言。null なら非表示
  stoppedAtLimit: false, // 15周の安全弁で止まったか(完了バナーの出し分け)
  lastJudgment: null   // 直前に確定した1件 { r, c, choice, confidence, status, probs }。
                       // 次の結果が来るまで表示に残す(最速モードでも判定が見えるように)
};
// 描画に不要な進行管理はモジュール変数
var queue = [];                 // この周でまだ判定していないマス [{r,c}]
var roundWrong = [];            // この周で不正解だったマス。次の周の queue になる
var roundTally = { correct:0, total:0 };
var roundSize = TOTAL_EMPTY;    // この周の対象マス数(「この周の進捗」の分母)。開始前は空マス数
var generating = false;         // 問題を生成している最中か(4.2 newPuzzle)
var started = false;
var pendingCommit = null;       // API結果を受けて確定待ちの1件
var runToken = 0;               // 実行の世代。reset() / showError() で +1 する(4.3)
var inflightController = null;  // in-flight の /api/judge 用 AbortController(4.3、Issue #19)
````

**集計ビューの記録は `state` に持たない。** 判定結果の記録(SPEC F1 拡張2、Issue #6)は
`state.values` のような「今の実行」の状態ではなく、複数の問題・複数回の実行をまたいで
残る `localStorage`(キー `scc.records.v1`)が正本。`reset()` / `newPuzzle()` でも消えない
(記録を消すのは「記録を消す」ボタン、すなわち `clearRecords()` のときだけ)。**正本は
引き続き `localStorage` だが、モジュールスコープの `recordsCache` にも読み込み結果を
キャッシュとして持つ**(PR #25 レビュー指摘。以前は `render()` のたびに `loadRecords()`
で全件 `JSON.parse` していたため、記録が数千件になると描画のたびに数msかかっていた)。
`getRecords()` が初回だけ `localStorage` を読んでキャッシュを作り、以後の `render()` /
`exportRecords()` はキャッシュを読む。`appendRecord()` もキャッシュへの追記で済ませ、
`saveRecords()` の呼び出しでキャッシュと `localStorage` を同期する。詳細は 4.2 の
`loadRecords` / `getRecords` / `appendRecord` を参照。

同じマスの判定は、周ごとにスナップショット(埋まっているマスの文脈)が異なる独立した
サンプルとして、正誤にかかわらずすべて記録・集計する(同一マスの重複除去や再判定分の
除外はしない)。

### 4.2 関数と責務

| 関数 | 責務 |
|---|---|
| `solveCount(grid, limit, found)` | 解の個数を数えるソルバー。`limit` 個見つけたら打ち切る(一意解の判定は `limit=2` で足りる)。候補の少ないマスから埋める(MRV)+ 行・列・箱のビットマスクでのバックトラッキング。`found` に配列を渡すと見つけた解を9行の文字列配列で受け取れる。置かれている数字がすでに矛盾していれば 0 |
| `generateSolvedGrid()` | 空盤面に対し、各マスの候補をシャッフルしながらバックトラッキングして完成盤を1つ作る純粋関数(乱数のみ外部依存) |
| `generatePuzzle(targetGivens)` | 完成盤からマスをランダム順に消し、消すたびに `solveCount(grid, 2) === 1` を確認する(2 になるなら戻す)。与えられた数字が `targetGivens`(既定 `DEFAULT_TARGET_GIVENS` = 30、下限 `MIN_TARGET_GIVENS` = 24)になったら打ち切る。戻り値 `{ given, solution }`(どちらも9行の文字列配列) |
| `newPuzzle()` | 「新しい問題」ボタン。`generating` を立てて `reset()`(= 世代トークンを進めて進行中のループを無効化し、in-flight の `/api/judge` も `abort()` する。Issue #19)し、`setTimeout(…, 0)` で生成してから `GIVEN` / `SOLUTION` / `TOTAL_EMPTY` / `roundSize` を差し替えて再描画。生成は同期で概ね 10 ms 以下(実測: 中央値 4ms、最大 10ms、100回) |
| `countEmpty(grid)` / `boxIndex` / `gridToCells` / `cellsToGrid` / `shuffled` | 上記の下請け。盤面の2つの表現(9行の文字列配列 ⇔ 81要素の数値配列。0 が空)の変換と、Fisher-Yates シャッフル |
| `buildSnapshot()` | `GIVEN` + `state.values`(正誤問わず)から9行の文字列配列を作る。未確定は `.`。**判定対象のマスだけは `.` にして送る(他のマスの過去の推測は正誤問わず残す)**。Worker 側も 3.3 でこれを検証する |
| `formatRoundSummary(round, correct, total)` | 周回ログの1行「N周目: M中K正解 (P%)」を組み立てる純粋関数。`total` が0でも割り算しない |
| `nextQueue(roundWrong)` | 次の周の `queue` を作る純粋関数。配列も要素も複製して返す(`roundWrong = []` の影響を受けないため) |
| `shouldStop(round, incorrectCount)` | 周の終わりの判断を返す純粋関数。`"solved"`(不正解0)/ `"limit"`(`MAX_ROUNDS` に到達)/ `"continue"` |
| `isCurrent(token)` | `state.running && token === runToken`。古い世代のコールバックを弾く(4.3) |
| `judgeCell(r,c,signal)` | `buildSnapshot()` を作って `/api/judge` を `fetch`(`signal` をそのまま渡す。`focusNext` が渡す `inflightController.signal`)。非2xxは `Error` にして投げる |
| `focusNext()` | 先頭で `runToken` を捕まえ、`queue` から1つ取り出しフォーカス→(リクエストごとに新しい `AbortController` を `inflightController` に作って)`judgeCell`→バー表示→(待ち)→`commitFocused`→(待ち)→再帰。`queue` が空なら `finalizeRound`。`judgeCell` が `AbortError` で reject したときは(世代トークンの判定と同じ扱いで)無視して `return` し、`showError` には流さない(4.3、Issue #19) |
| `commitFocused()` | `pendingCommit` を `state.values` に反映し、`roundTally`/`roundWrong`/`state.lastJudgment` を更新。`pendingCommit` が無い、または `state.focusedKey` と一致しないときは何もしない。正誤が確定するこの時点で `appendRecord()` を呼び、集計ビュー用の1件を記録する |
| `finalizeRound()` | ログ追記→`shouldStop` の結果で完了 / 強制終了 / 次の周(`queue = nextQueue(roundWrong)`) |
| `run()` | 初回のみ queue を全空マスで初期化し `focusNext` を開始 |
| `reset()` | `runToken` を進め、`inflightController` があれば `abort()` して in-flight の `/api/judge` を打ち切り、進行管理と `state` を初期化(`speedMode` は維持)(Issue #19) |
| `showError(message)` | `runToken` を進め、`inflightController` があれば `abort()` して `state.errorMessage` を立て、`running=false` で止める(不変条件4、Issue #19) |
| `setSpeed(mode)` | `state.speedMode` を切り替えて再描画。実行中でも切り替えられる(4.4) |
| `render()` | `state` から DOM(グリッド・統計・バー・ログ・集計パネル・バナー・ボタン)を **全部 innerHTML で再生成**。周回ログのスクロール位置だけは引き継ぐ |
| `render*()` | `renderGrid` / `renderLegend` / `renderControls` / `renderErrorBox` / `renderStats`(+`statCard`)/ `renderCurrentPanel`(+`coordLabel` / `renderBars`)/ `renderRoundLog` / `renderCalibration`(+`renderCalibrationChart`)/ `renderBanner`。それぞれHTML文字列を返すだけで、DOMには触らない |
| `buildCellStyle()` | マスの状態(given/pending/correct/incorrect + focused)からインラインstyle文字列を返す |
| `escapeHtml(text)` | `innerHTML` に入れる前に `& < > " '` を実体参照にする |
| `fnv1a32(text)` / `puzzleId()` | 集計ビュー(SPEC F1 拡張2)の問題ID用の簡易ハッシュ。32bit FNV-1a を8桁16進で返す。`puzzleId()` は `GIVEN` の9行を結合した文字列をハッシュ化する |
| `loadRecords()` | `localStorage`(キー `scc.records.v1`)から読む。戻り値は `{ ok, records }`。`ok:false` は「読めなかった」(`localStorage` が無い、または `getItem` が例外)ときだけで、`records` は空のまま呼び出し側に「保存してよい空」だと誤解させない。保存が無い・JSON が壊れている・配列でない、はいずれも `ok:true, records:[]`(壊れていた場合は元の文字列を退避キー `scc.records.v1.broken` に逃がしてから空で作り直す)。**`ok` を見ずに `records` だけ使わないこと**(PR #25 レビュー指摘 should-fix 1) |
| `saveRecords(records)` | `records` を `localStorage` に書き込み、`recordsCache`(後述)も同時に同期する |
| `getRecords()` | `render()` / `exportRecords()` が読む窓口。モジュールスコープの `recordsCache`(初期値 `null`)が無ければ `loadRecords()` で読んで(`ok:true` のときだけ)キャッシュを作り、以後はキャッシュをそのまま返す。読み直しのコストを避けるための追加(PR #25 レビュー指摘 should-fix 2。以前は `render()` のたびに全件 `JSON.parse` していた) |
| `appendRecord(rec)` | 1件追記する。キャッシュが無ければ初回だけ `loadRecords()` を読むが、`ok:false`(読めなかった)なら **このレコードを黙って捨てて保存しない**(読めなかった状態を「空」と取り違えて上書きし、既存の記録を全消しにしないため。should-fix 1)。上限 `RECORDS_MAX`(既定 5,000。テストでは `ctx.RECORDS_MAX` を差し替えて境界だけ検証する)を超えたら古いものから捨てる |
| `binRecords(records, key)` | `records` を `key`(`"pc"` または `"conf"`)の値で10%刻み10帯に分ける純粋関数。帯は `Math.min(9, Math.floor(v * 10))`(`v=1.0` は最後の帯)。数値でない/有限でない値、および 0〜1 の範囲外の値は除外。戻り値は長さ10の配列 `{ lo, hi, n, correct, rate }`(`rate` は `n===0` なら `null`) |
| `renderCalibration()` / `renderCalibrationChart(bins, title)` | 集計パネル(見出し「較正図」)。`getRecords()` を読み、合計件数・全体正解率・記録している問題数(`p` のユニーク数)を出したあと、`binRecords` の結果(記録数と最終追記時刻が前回と同じなら再計算しない軽いキャッシュ付き)を `pc` / `conf` 各10帯のインラインSVGの棒グラフ(対角線は理想の較正線)として横並びで描く。件数0の帯は棒を描かない。件数>0だが正解率0%の帯は高さ1pxの台座を描き、件数0の帯と見分けられるようにする(should-fix 2 / nit)。色は CSS 変数(`--accent` / `--muted` / `--border`)をそのまま使う |
| `exportRecords()` | `getRecords()` の内容を `{ version:1, exported_at, records }` として `Blob` + `<a download>` でダウンロードさせる。ファイル名 `sudoku-calibration-YYYYMMDD-HHMMSS.json`(ローカル時刻) |
| `clearRecords()` | `confirm()` で確認したうえで `saveRecords([])` し、再描画する |

### 4.3 状態遷移(1マス)

````text
idle ──run()──▶ focusNext()
                 │ token = runToken(この呼び出しの世代を捕まえる)
                 │ focusedKey=key, currentProbs=null, render()
                 ▼
              judgeCell()  ── 失敗 ──▶ showError(), running=false, 停止
                 │ 成功
                 ▼
            currentProbs=probs, pendingCommit={...}, render()
                 │ (slow: 700ms)
                 ▼
            commitFocused(): values[key]=…, lastJudgment=…, focusedKey=null, render()
                 │ (slow:150ms / fast:20ms)
                 ▼
            queue 残あり → focusNext() / 空 → finalizeRound()
````

**実行世代(`runToken`)のルール。** `reset()` と `showError()` は `runToken` を1つ進める。
`focusNext()` / `finalizeRound()` は入口で `var token = runToken;` と世代を捕まえ、その後の
`then` / 失敗ハンドラ / `setTimeout` のコールバックは **すべて先頭で `isCurrent(token)`
(= `state.running && token === runToken`)を確認し、偽なら何もせずに return する**。

`state` はオブジェクトごと差し替えられるが、飛んでいる `fetch` の Promise や予約済みの
`setTimeout` は生き続けてモジュール変数を読むため、`state.running` を見るだけでは足りない。
「リセット → すぐ実行」で古い連鎖が生き返ると、同じマスを二度判定して二重に課金され、
`roundTally` が `state.values` とずれ、`pendingCommit`(モジュール変数は1つしかない)が
上書きされて `queue` から取り出したマスがどこにも確定されないまま周が終わらなくなる。
世代トークンはこれを一箇所で断ち切るための仕組みなので、非同期のコールバックを足すときは
必ず同じガードを付ける。

**in-flight の abort(Issue #19)。** `runToken` は「古い世代の結果を無視する」だけで、
Jev への問い合わせそのものは止めない。リセット/新しい問題(`newPuzzle()` は内部で
`reset()` を呼ぶ)/エラーでは、`runToken` を進めるのと同じタイミングで `inflightController.abort()`
も呼び、in-flight の `/api/judge` を実際に打ち切る(無駄な待ち時間とレート制限消費を防ぐ)。

なお API 失敗は `then(onOk, onErr)` の第2引数で受け、成功ハンドラ側で投げた例外は後ろの
`catch` で別の文言(「画面の更新に失敗しました」)にする。描画のバグを API エラーとして
報告しないため。abort による `AbortError`(`err.name === "AbortError"`)は、世代トークンの
判定と同じ「古い世代は無視する」扱いで `showError` に流さない(そもそも abort は古い世代
にしか起きない設計だが、明示的にガードしている)。

### 4.4 描画方針

- 状態が変わるたびに `render()` で該当領域を丸ごと再生成する。81マス+9本のバー程度なので差分更新は不要
- 色や枠線は `buildCellStyle` が返すインラインstyleで指定(クラス切り替えではなく、状態から毎回組み立てる)
- 「現在の判定」パネルは、結果が届いているマスについては座標とバーを出し、結果待ち・確定直後は
  「いま聞いているマス」と **直前に確定した判定**(`state.lastJudgment`: 座標・選んだ数字・正誤・
  `confidence`・バー)を並べる。最速モードだと結果が一瞬で消えてしまうため
- `innerHTML` を作り直すと周回ログのスクロールが先頭に戻るので、`render()` は置き換えの前に
  `#round-log ul` の `scrollTop` を保存し、置き換えの後に戻す。末尾に居たときは末尾のままにする
- 速度モード(`setSpeed`)は実行中でも切り替えられる。**予約済みの `setTimeout` の残り時間は
  変わらず、新しい待ち時間は次にタイマーを張るところから効く**(切り替えた瞬間に待ち時間を
  張り直す必要はない、という割り切り)
- 「この周の進捗」の分母 `roundSize` は開始前・リセット後も空マス数(51)にしておく。
  `0 / 0` と出すと「対象が無い」ように見えるため

## 5. データ

`GIVEN`(与えられた数字)と `SOLUTION`(正解表)は **再代入できる `var`** で、初期値は
Wikipedia の数独記事で使われている例題。「新しい問題」(4.2 `newPuzzle`)を押すと
`generatePuzzle()` の結果で丸ごと差し替わり、`TOTAL_EMPTY` と `roundSize` も再計算される。
どちらもブラウザ用スクリプトの中にだけあり、Worker 側には無い(1 章・9 章 不変条件7)。

````javascript
var GIVEN = [ "53..7....", "6..195...", ".98....6.", "8...6...3", "4..8.3..1", "7...2...6", ".6....28.", "...419..5", "....8..79" ];
var SOLUTION = [ "534678912", "672195348", "198342567", "859761423", "426853791", "713924856", "961537284", "287419635", "345286179" ];
````

固定問題の空マスは51。生成した問題は既定30ヒント(空マス51)で、下限24ヒントまでしか削らない。`SOLUTION` は採点表示にだけ使う。

## 6. 設定・デプロイ

- `wrangler.toml`: `name`, `main = "src/index.js"`, `compatibility_date`, `[ai] binding = "AI"`, `[vars]`(レート制限の上限値)、およびレート制限のカウンタ用の Durable Object。`account_id` は書かない(環境変数 `CLOUDFLARE_ACCOUNT_ID` で渡す)

````toml
[[durable_objects.bindings]]
name = "RATE_LIMITER"
class_name = "RateLimitCounter"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["RateLimitCounter"]
````

- Durable Object は **事前の手作業が要らない**。`wrangler deploy` が `[[migrations]]` を見てクラスを作る(以前の Workers KV のような「ネームスペースを1回作って `id` を貼り付ける」手順は不要になった。3.2 / `docs/HANDOFF.md` 1.4)
- `typesafe/jev` は AI Gateway 経由で提供されており、課金も AI Gateway のクレジットで行われる(3.4)。アカウント側で AI Gateway の課金を有効にしていないと、デプロイは通るのに `/api/judge` だけが失敗する(`docs/HANDOFF.md` 1.3)
- `package.json`: `"wrangler": "^4"`、scripts は `test`(`node --test`)/`check`(`--dry-run`)/`deploy`/`dev`
- 認証: `CLOUDFLARE_API_TOKEN`(非対話)。`wrangler login` はブラウザが要るのでクラウドセッションでは使えない
- `wrangler dev` は AI バインディングをリモート実行するため、これもトークンが要る

## 7. セキュリティ・運用上の注意

- `/api/judge` は認証なしだが、F6のレート制限(IP単位30回/時・全体500回/時、既定値)でコストの上限を確保している。値は `wrangler.toml` の `[vars]` で調整可能
- 上限を緩める(数値を大きくする、または `RATE_LIMITER` バインディングを外す)と、コストの上限が無くなる。特にバインディングを外すとフェイルオープンの設計上、制限なしで動いてしまう(カウンタが一時的に落ちた場合は 3.2 のとおりフェイルクローズで 503)。**理由なく緩めない**
- リポジトリには秘密情報を置かない。`account_id` も置かない
- `/api/judge` には CORS ヘッダーを付けない。加えて **`content-type` のメディアタイプが `application/json` でないリクエストは 415 で弾く**(`handleJudge` の最初、レート制限より前)。この2つはセットで意味を持つ: `application/json` の POST はブラウザで必ずプリフライトが必要になり、CORS ヘッダーを返していないのでプリフライトが通らず、他サイトのページからは呼べない。一方 `text/plain` などプリフライト不要の content-type はフォーム送信等でクロスサイトに投げられてしまうため、415 で入口を閉じる(第三者のサイトに埋め込まれて Workers AI のコストを消費される経路を塞ぐ)。`curl` 等からの直接アクセスはレート制限で頭打ちにする
- `GET /` のレスポンスには `X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`Content-Security-Policy: frame-ancestors 'none'` を付ける(クリックジャッキング対策。インラインスクリプトを使うため、それ以上の CSP はかけない)
- 3.3 の検証を通った盤面文字列だけが Jev に渡る(形式・対象マスが空であること・埋まっているマスが17個以上であることまで見る)
- `SOLUTION` は Wikipedia の例題の答えなので秘密ではない。守るべきは「Jev に渡る `state` に `SOLUTION` が混ざらないこと」であり、そのために `SOLUTION` をブラウザ用スクリプトの中にだけ置き、Worker の判定コードから構造的に隔離する(8 章)

## 8. 設計上の判断と理由

| 判断 | 理由 |
|---|---|
| 1ファイル・フレームワークなし | 読める・デプロイできる・壊れにくいを優先。実験装置に抽象化は要らない |
| 判定ループをブラウザ側で駆動 | Worker をステートレスに保てる。1マスごとの待ち時間(演出)もブラウザ側で自然に入れられる |
| スナップショットに不正解の推測も含める | 「周を重ねて文脈が増えると精度が上がるか」を見るのが目的。正解だけ渡すと SOLUTION のリークになる |
| `SOLUTION` を Worker に渡さない | 実験の前提。Worker 側でも採点しない |
| 問題はブラウザ側で生成し、Worker は問題を知らない | ジェネレーター(#5)を入れた以上、Worker が特定の初期配置を持つと「新しい問題」のたびに Worker も直す羽目になる。Worker は「数独の盤面として受け付けられる形か」だけを見るステートレスな層に留める。初期表示だけは固定問題のままにして、開いてすぐ同じ条件で比べられるようにしている |
| 生成した問題の一意解をソルバーで確認する | 解が複数ある問題だと「Jev の答えが不正解」の判定そのものが無意味になる。マスを1つ消すたびに `solveCount(grid, 2) === 1` を確認するので、出題時点で一意解であることが保証される |
| 行・列・箱の矛盾を Worker で検証しない | 不正解の推測を正誤問わず残して送るのが実験の前提(F3)なので、矛盾した盤面は正常な入力。ここを弾くと2周目以降がほぼ全部 400 になる |
| 速度モード2択 | 「じっくり見る」と「Jevの速さを体感する」の両方が目的 |
| IP単位+全体の2段レート制限 | IP単位だけだと分散アクセス(多数のIPからの同時アクセス)で回避され、コストが青天井になる。全体上限を最終防衛ラインとして併設 |
| カウンタをKVでなくDurable Objectに(Issue #10) | KVは結果整合で `get` がコロケーションごとに最大60秒キャッシュされるため、複数コロからの同時アクセスが lost update を起こし、**全体上限が「分散アクセスへの最終防衛ライン」という唯一の目的に対して効かなかった**(実測で確認)。Durable Object はインスタンスが1つで直列実行のため厳密に数えられる。カウンタが緩いと Workers AI のコストの上限が実質無くなるので、ここは実装の単純さより正確さを取る(3.2) |
| Durable Object を `fetch` ハンドラ方式に(RPC にしない) | RPC を使うには `cloudflare:workers` の `DurableObject` を継承する必要があるが、そのモジュールは `node:test` から import できず、`src/index.js` をモックの `env` で直接呼ぶテスト方針(10 章)が使えなくなる。素のクラス + `fetch` なら Workers でもそのまま動く |
| レート制限をフェイルオープンに | `RATE_LIMITER` バインディングが無い環境(ローカルdevなど)でアプリ自体が止まらないようにするため。本番では必ずバインディングを設定する前提 |
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
  - `RATE_LIMITER`: `Map` ベースの Durable Object スタブ(`test/helpers.js` の `makeRateLimiter`)。本物と同じく `idFromName(name)` → `get(id)` → `stub.fetch(request)` で使え、中身は `RateLimitCounter` と同じ意味論(`peek` は読むだけ、`increment` は上限未満のときだけ +1、バケットが変われば数え直し)を再現する。`calls` に `{ name, op, bucket, max }` を順に記録するので「全体超過なら IP 側のインスタンスを呼ばない」ような**呼び出し順**まで検証できる。`fetch` が例外を投げるモード(`"throw"`)と 500 を返すモード(`"500"`)も用意する
    - レート制限のバケット番号は現在時刻依存。テスト側でバケットを計算するとウィンドウ境界をまたいだ瞬間に落ちるので、**シードはインスタンス名の前方一致(`{"ip:*": 30}`)で行い、バケットが要る検証はスタブが実際に受け取った呼び出し(`limiter.calls[i].bucket`)から取り出して行う**
  - `RateLimitCounter` 単体のテストには `makeStorageCtx`(`ctx.storage` の `get` / `put` / `delete` を `Map` で提供する)を使い、`increment` の境界・バケットが変わったときの数え直しと古いキーの削除・壊れた値のフェイルクローズを直接確かめる
  - `RATE_LIMIT_*`: 文字列で与える(`wrangler.toml` の `[vars]` は文字列として渡ってくるため)
- 必ず含めるテスト
  - **不変条件1**: `AI.run` に渡された `payload` が期待どおりのオブジェクトと **完全に一致する**(`deepStrictEqual`)。期待値の `note` / `instructions` / `criteria` は実装から import せず、テスト側に意図的に複製して持つ(`state` に何かが足されたら落ちるようにするため)。加えて `JSON.stringify` した文字列に `SOLUTION` の9行のどれも含まれていないこと
  - **不変条件7**: `src/index.js` のソースを読み、`PAGE_HTML` のテンプレートリテラルの外に `SOLUTION` という文字列が現れない。開きバッククォートは「**行頭の** `var PAGE_HTML = \`` の宣言」とし、その文字列がファイル中に1つしか無いことも確認する(コメント中の同じ文字列を拾って切り出し範囲がずれると検査が無効になるため)。閉じバッククォートは「ファイル最後のバッククォート」とし、その後ろが `;` と空白だけであること(= `PAGE_HTML` が最後の宣言であること。3.5)も併せて検査する
  - content-type: `text/plain` や content-type 無しのリクエストが 415 になり、`AI.run` もレート制限のカウンタも触られないこと
  - 入力検証: 3.3 の各項目について 400 になること(対象マスが空でない場合を含む)。正常入力で 200 と9キーの `probabilities` が返ること
  - レート制限: IP上限・全体上限それぞれの超過で 429 と `Retry-After` / `X-RateLimit-Scope` が返ること。全体超過時に全体を `peek` するだけで IP 側のインスタンスを呼ばないこと。`Retry-After` が `(bucket+1)*window - now` であること。`RATE_LIMITER` が無ければ通ること(フェイルオープン)。カウンタの呼び出しが例外を投げる / 500 を返せば 503 になり `AI.run` が呼ばれないこと(フェイルクローズ)。`[vars]` の値が反映され、紛らわしい表記が既定値に落ちること。残数ヘッダーが 200 / 400 / 502 に付き、429 / 503 には付かないこと
  - `RateLimitCounter` 単体: `increment` の境界(`max-1` なら通って `max` になる、`max` なら加算せず拒否)、`peek` が加算しないこと、別バケットが独立していること、バケットが変わったときに古いバケットのキーが消えること、壊れた値が超過扱いになること
  - `AI.run` が例外を投げる / `answers.digit` が無い(ラッパーの有無どちらでも)/ `state` が `"Completed"` でない / `answers.digit` の形が 3.3 の条件を満たさない場合に 502 になること
  - ラッパー付き(3.4 の実測形式)とラッパー無し(素の `{ model, answers, usage }`)の **どちらでも** 200 になること。`confidence` は Jev の値がそのまま返り、`probabilities[choice]` に差し替えられていないこと
  - `GET /` が `text/html; charset=utf-8` と 7 章のセキュリティヘッダーを返し、それ以外のパスが 404 であること
  - **ジェネレーター / ソルバー**(`test/page.test.js`)。`PAGE_HTML` の `<script>` を取り出し、`node:vm` のコンテキストで丸ごと評価する harness を使う(`document` は `#app` だけ、`setTimeout` は待たずに即実行、`fetch` は呼び出しを記録するスタブ、`AbortController` は Node のグローバルをそのまま渡す。`focusNext()` の `new AbortController()` が vm コンテキストからも見えるようにするため)。スクリプト直下の `var` / 関数宣言はコンテキストのプロパティになるので、`ctx.generatePuzzle` のように直接呼べる
    - `solveCount` が固定問題で 1 を返し、その解が既知の正解(DESIGN 5 章の `SOLUTION`)と一致すること。空盤面は `limit` で打ち切られ、矛盾した盤面は 0 になること
    - `generatePuzzle` を **20回** 呼び、毎回 `solveCount(given, 2) === 1`、`solveCount` が見つける解が `solution` と一致、与えられた数字が 17〜40 個、`solution` が数独として正しい(行・列・箱に1〜9が1回ずつ)こと。乱数を使うので所要時間の上限も見る(実測: 20回で 160ms 前後)
    - `newPuzzle()` で `GIVEN` / `SOLUTION` / `TOTAL_EMPTY` / `roundSize` が差し替わり、周回・統計が初期化されること。初期表示は固定問題のままであること
    - 「新しい問題」の後に `run()` すると、**新しい `GIVEN` の空マスだけを行優先の順で** `/api/judge` に問い合わせること(回数と座標の両方を見る。空マスの「数」は固定問題と同じ51になりうるため)
    - vm のコンテキストで作った配列は host とは別レルムなので、`deepStrictEqual` の前に host 側の配列へ移し替える(`hostRows`)
  - **周回ロジックの振る舞い: in-flight の abort**(`test/page.test.js` S1〜S4、Issue #19)。これまでの世代トークンの検査は正規表現によるソース検査だけだったが、`runScript` harness で `run()` / `reset()` / `newPuzzle()` を実際に走らせて振る舞いを検証する。`fetch` モックは resolve/reject を外側から制御できる「宙吊り」な `Promise` を返し、`init.signal` に `addEventListener("abort", ...)` を仕込んで `inflightController.abort()` を再現する(`makeAbortAwareFetch`)
    - S1: `run()` → 1件目の fetch を宙吊り → `reset()` → `run()` → 宙吊りを解決 → 全部流す。fetch 総数が51以下(abort により宙吊り分が再送されない)、commit 51、空マス0、`state.done === true` であること
    - S2: in-flight で `reset()` のみ。commit 0、`state.values` が空、`state.running === false`、記録(`getRecords()`)も増えないこと
    - S3: in-flight で `newPuzzle()`。古い結果が新しい盤面に commit されないこと
    - S4: `reset()` で fetch が `AbortError` で reject されても `showError` されない(エラーボックスが出ない)こと
    - 修正前(AbortController 導入前)のコードに当てると、S1〜S4 はいずれも「in-flight の fetch が abort されていない」で落ちることを確認済み
  - **集計ビュー**(`test/page.test.js`、Issue #6)。`runScript` の harness に `localStorage` / `confirm` / `Blob` / `URL` / `document.createElement` / `document.body` のモックを足してある(`makeLocalStorage()` は `Map` ベース、`makeThrowingLocalStorage()` は必ず例外を投げる)
    - `binRecords`: 境界(`0.0`→帯0、`0.1`→帯1、`0.95`・`1.0`→帯9。`1.0` は最後の帯に入る)、帯ごとの `n`/`correct`/`rate`(`n===0` なら `rate=null`)の計算、数値でない/`NaN`/0〜1の範囲外(`1.5`・`-0.5`)の値の除外、`"pc"` と `"conf"` を独立に集計すること(pc が範囲外でも conf は数えること)
    - `appendRecord`: 上限(`RECORDS_MAX` は既定5,000だが、テストでは `ctx.RECORDS_MAX = 5` のように vm コンテキストのプロパティとして差し替えて境界だけ検証する。既定値5,000であることは別途1行で確認する)を超えたら最古から捨てて上限件数のまま保たれること
    - `loadRecords`: 戻り値が `{ ok, records }` であること。`localStorage` が無い・例外を投げる、いずれも `ok:false` で `records` は空配列。壊れた JSON・配列でない JSON(`{"a":1}`)は `ok:true` で空配列に作り直し、壊れたJSONは元の文字列を退避キー(`scc.records.v1.broken`)に残すこと。いずれの場合も `appendRecord` / `run()` が例外を出さずに続くこと
    - `appendRecord`: 読み取りが失敗している(`loadRecords().ok === false`)あいだは **保存せず黙って捨てる**こと。読み取りが復旧したあとに既存の記録がそのまま残っていること(蓄積済みの記録を `[] + 1件` で上書きして全消しにしない。PR #25 レビュー指摘 should-fix 1。実測: 20件蓄積 → `getItem` が1回throw → 1件に減っていた)
    - `run()`(常に正解を返す `fetch` スタブ)で固定問題(51マス)を解かせ、記録が51件になること。各件が `p`(`puzzleId()` と一致)/ `pc`(`probabilities[choice]`)/ `conf`(Jevの`confidence`)/ `ok`(採点と一致)を持つこと
    - `renderCalibration`: 記録が無ければ0件/0%/0問と表示され、記録があれば合計件数・SVG(`<svg`)・エクスポート/消去ボタンが描画されること
    - `renderCalibrationChart`: 件数>0で正解率0%の帯は高さ1pxの台座を描き、`height="0"` の矩形にならない(n=0の帯と見分けられる)こと
    - `render()`: 記録が蓄積済み(5,000件)でも、初回の `render()` 以降は `localStorage.getItem` を呼ばない(`recordsCache` で使い回すこと。should-fix 2)
    - `exportRecords`: `Blob` に渡した JSON(`version`/`exported_at`/`records`)が `loadRecords().records` の内容と一致し、`exported_at` が ISO 文字列であること。`<a>` が `appendChild` → `removeChild` で対になっていること(モックの `Blob` / `URL.createObjectURL` / `document.createElement`)
    - `clearRecords`: `confirm()` が `true` を返すモックなら記録が0件になり、`false` を返すモックなら消えないこと
- CI(`.github/workflows/ci.yml`)は push と PR で `npm ci` → `npm test` → `npm run check` を実行する。`check` は `wrangler deploy --dry-run` で、認証なしで動く
