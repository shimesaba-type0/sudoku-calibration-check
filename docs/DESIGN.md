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
    if ((url.pathname === "/" || url.pathname === "/compare") && request.method === "GET") {
      return new Response(PAGE_HTML, { headers: PAGE_HEADERS });
    }
    return new Response("Not found", { status: 404 });
  },
};
````

`GET /api/status` は `readRateLimitStatus(request, env)`(3.2)。レート制限のカウンタを `peek` だけで読んで残り回数を返す。判定はしないので `AI.run` は呼ばない(SPEC 4章)。

`GET /compare`(比較モード、Issue #46)は `GET /` と**同じ** `PAGE_HTML` / `PAGE_HEADERS` を返す。Worker 側で盤面や質問の中身が変わるわけではなく、差は「フロントが比較シェルを描くかどうか」だけなので、Worker 側にはルーティング1行を足すだけで済む(判定ロジックは一切触らない)。どちらの画面を描くかはフロントの `location.pathname` 判定に委ねる(4.2)。

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
3. 入力を検証し(`validateInput`)、不備なら 400 を返す。**質問の種類(`ask`)で分岐する**(Issue #38 / #45 / #48)。`ask` は `"digit"`(既定・省略時)/ `"cell"` / `"where"` / `"all"` のいずれかで、それ以外なら 400(`readAsk` が `null` を返す。文言は `ASK_ERROR` =「askはdigit・cell・where・allのいずれかである必要があります」)。検証項目は次の通り
   - **共通**
     - `puzzle` が長さ9の配列で、各要素が9文字の文字列。文字は `1`〜`9` と `.` のみ
     - `puzzle` の埋まっているマスが `MIN_FILLED_CELLS`(17)個以上。17 は一意解を持つ数独の最小ヒント数で、これ未満は数独として成立しない
     - **行・列・箱の矛盾は検証しない**。過去の周の不正解の推測を正誤問わず残して送る設計なので、矛盾した盤面が来るのは正常な状態(8 章)
     - 盤面はブラウザ側のジェネレーターが作る(4.2 `generatePuzzle`)ので、Worker は特定の問題の初期配置を持たない。`GIVEN` も `SOLUTION` も Worker 側には無い(1 章・10 章)
   - **`ask:"digit"`(従来どおり)**
     - `target.row` / `target.col` が 0〜8 の整数
     - `puzzle` の `target` のマスが `.`(空)である。再判定のときも対象マスの前回の推測は消して送る(アンカリング回避。4.2 `buildSnapshot`・SPEC F3)
     - `exclude`(任意。Issue #61「消去法」)は `readExcludeList(value)` で検証する。`"1"`〜`"9"` の文字列の配列で、重複なし・9個全部は不可。省略・空配列は「外さない」。文言は `EXCLUDE_ERROR` / `EXCLUDE_DUPLICATE_ERROR` / `EXCLUDE_ALL_ERROR`(SPEC 4章)。検証の位置は **各行の形式の後、`target` の範囲チェックの前**
   - **`ask:"cell"`(マス選び)**
     - `target` が **付いていないこと**。付いていたら 400 にする(無視して通すと、どちらのつもりのリクエストか曖昧なまま別の質問が飛ぶため)
     - `exclude` が **付いていないこと**(Issue #61。`!== undefined` で判定するので `null` も 400)。候補が数字ではないため。`where` も同じ(`digit` の検証の直後に置く)
     - 空マス(`.`)が1つ以上あること。1つも無ければ聞くものが無いので 400
   - **`ask:"where"`(数字ごと。Issue #45)**
     - `target` が **付いていないこと**(`cell` と同じ理由。文言は「盤面全体に聞くため」)
     - `digit` が `"1"`〜`"9"` の **文字列** であること。欠落・数値(`4`)・範囲外(`"0"` / `"10"`)は 400。criteria ではなく質問文にそのまま埋め込む値なので、曖昧なまま Jev に送らない
     - 空マス(`.`)が1つ以上あること(`cell` と同じ)
     - 検証の順番は `ask` → `puzzle` が9要素の配列 → `target` 禁止 → `digit` → 各行の形式 → 17個以上 → 空マスあり(`cell` に揃えてある)
   - **`ask:"all"`(一括。Issue #48)**
     - `target` が **付いていないこと**(`cell` / `where` と同じ理由。文言は「残りの全マスに聞くため」)
     - `digit` が **付いていないこと**。付いていたら 400(`"ask:allではdigitを指定できません"`)。`all` は空マス全部にそれぞれ数字を聞く質問なので、特定の数字を指す `digit` は取らない。`where` と取り違えたリクエストを黙って別の質問として飛ばさないため
     - 空マス(`.`)が1つ以上あること(`cell` / `where` と同じ)
     - `exclude`(任意。Issue #61)は `readExcludeMap(value, puzzle)` で検証する。オブジェクトで、キーは `emptyCells(puzzle)` の空マスのキーのいずれか(`EXCLUDE_MAP_ERROR` / `EXCLUDE_KEY_ERROR`)、各値は `readExcludeList` と同じ規則。空配列のマスは戻り値の `byKey` に載せない(= 1〜9 のまま)。空マスかどうかを盤面で見るので **各行の形式の後** に検証する
     - 検証の順番は `ask` → `puzzle` が9要素の配列 → `target` 禁止 → `digit` 禁止 → 各行の形式 → `exclude` → 17個以上 → 空マスあり(`cell` / `where` に揃えてある)
   - `readExcludeList` / `readExcludeMap` は副作用の無い純粋関数で、`validateInput`(400 の判定)と手順4(criteria の組み立て。検証済みなので必ず成功する)の両方から呼ぶ。`validateInput` の戻り値の形(文字列か `null`)は変えていない
4. `criteria` と「期待するキー集合」(`expectedKeys`)を `ask` ごとに生成する
   - `ask:"digit"`: `{ "1": "the digit 1", ..., "9": "the digit 9" }`。`expectedKeys` は `DIGITS`。**`exclude` があれば、残りの数字(昇順)だけ**(`fillDigitCriteria(criteria, digits)`。第2引数を省略すると 1〜9)で、`expectedKeys` も同じ残りの数字になる。したがって応答の `probabilities` は残りの数字とちょうど一致、`choice` はそのいずれかでなければ 502(`exclude` があるときだけ `ANSWER_MESSAGES.digitExcluded` / `all.cellExcluded` の「候補の数字(exclude後)」の文言。無いときは従来どおり)
   - `ask:"cell"`: `emptyCells(puzzle)` が返す空マスを **行優先の順** に並べ、`{ "r0c2": "row 0, column 2 (zero-based)", ... }`。キーは `"r" + row + "c" + col`。`expectedKeys` はそのキー配列。Jev の `choice` は選択肢を255個まで取れるので、空マスは最大64個(埋まっているマスが17個以上という共通条件のため)なので1回で聞ける
   - `ask:"all"`: criteria は `ask:"digit"` と同じ 1〜9。`emptyCells(puzzle)` の各マスを **そのまま質問キー** にして `{ "r0c2": { type: "choice", instructions: ..., criteria: ... }, ... }` を組み立てる(行優先)。`expectedKeys` はそのキー配列(= `answers` に期待するキー集合。各マスの `probabilities` / `choice` に期待するのは `DIGITS` のほう)。`instructions` は `ALL_INSTRUCTIONS_TEMPLATE` に座標を埋めた文(`allInstructions(row, col)`)。`criteria` は質問ごとに **同じオブジェクトを使い回す**(`request` にそのまま載るので JSON 化できる形のまま。9個 × 空マス数を作り直す意味が無い)。**`exclude`(Issue #61)のあるマスだけ** は残りの数字だけの別オブジェクト(`fillDigitCriteria({}, digits)`)にし、そのマスの残りの数字を `digitsByKey`(`{ "r0c2": ["1", ...] }`)に記録する(手順6の検証で使う)
   - `ask:"where"`: criteria は使わない。`emptyCells(puzzle)` の各マスを **そのまま質問キー** にして `{ "r0c2": { type: "noul", instructions: ... }, ... }` を組み立てる(行優先)。`expectedKeys` はそのキー配列。`instructions` は `WHERE_INSTRUCTIONS_TEMPLATE` に座標と `digit` を埋めた文(`whereInstructions(row, col, digit)`)。テンプレートを定数として持つのは、フロント(Claude 経路)が同じ文言を組み立てられるようにするため
5. `env.AI.run("typesafe/jev", payload)`(`payload = { state, questions }`。質問キーは `ask:"digit"` / `ask:"cell"` では `ask` と同じ `digit` / `cell`、`ask:"where"` / `ask:"all"` では空マスのキーがそのまま質問キーになる。`state` は `ask:"cell"` / `ask:"where"` / `ask:"all"` のとき `target` を持たない。下記参照)を呼ぶ。例外は 502(`raw` に例外メッセージを200文字まで入れ、`console.error` でログを残す)。**この 502 にも `request: payload` を添える**(Issue #34。フロントが「何を送って失敗したか」を確認できるように)
6. 返ってきたレスポンスから `answers[ask]` を取り出して検証し(`extractAnswer(result, key)` → `validateAnswer(answer, expectedKeys, messages)`。`ask:"where"` は質問が空マスの数だけあるので、代わりに `extractAnswers(result)` で **`answers` オブジェクトそのもの** を取り出して `validateNoulAnswers(answers, expectedKeys, messages)` にかける)、次のどれかを満たさなければ 502(`raw` に生レスポンスを、**`request: payload` も**添えて返す。デバッグ用・Issue #34)
   - レスポンスがオブジェクトである
   - `state` フィールドがある場合、その値が `"Completed"` である(AI Gateway のラッパー。3.4)。違えば中身を見ずに 502
   - `answers` の取り出しは **`result` がオブジェクトなら `result.answers`、そうでなければトップレベルの `answers`**。ゲートウェイのラッパーが将来外れても動くようにするための2段構え(3.4)
   - `answers` がオブジェクトで、`answers[key]`(`key` は `"digit"` か `"cell"`)が存在し、オブジェクトである
   - `probabilities` がオブジェクトで、キーが `expectedKeys` と **ちょうど一致**(個数も各キーも)。値はすべて有限の数値
   - `choice` が文字列で、`expectedKeys` のいずれか
   - `confidence` が有限の数値。**値の妥当性は見ない**(Jev 独自の確信度で `probabilities[choice]` とは一致しないため。3.4 / SPEC 4章)

   `ask:"all"`(Issue #48)の判定基準は次の通り。`extractAnswers(result)` で `answers` そのものを取り出し、`validateAllAnswers(answers, expectedKeys, digitsByKey, ANSWER_MESSAGES.all)` にかける。`answers` のキー集合が `expectedKeys`(空マスのキー)と **ちょうど一致**(個数も各キーも)し、各マスの回答が **`ask:"digit"` とまったく同じ基準**(`validateAnswer(answer, digits, ...)`。`digits` は `digitsByKey` にそのマスがあれば残りの数字、無ければ `DIGITS`。Issue #61)を満たすこと。マス単位の 502 の文言は「どのマスで落ちたか」が分かるよう `ANSWER_MESSAGES.all.cell` のテンプレート(`{key}` をマスのキーに差し替える。`allCellMessages`)を使う。このために `validateAnswer` は `messages.answer` / `messages.missing` / `messages.confidence` の差し替え口を持つが、**渡されなければ従来の固定文に落ちる**ので `digit` / `cell` の 502 の文言は1文字も変わらない。

   `ask:"where"`(Issue #45)の判定基準は次の通り。`answers` のキー集合が `expectedKeys`(空マスのキー)と **ちょうど一致**(個数も各キーも)し、各要素の `noul` が有限の数値であること。`type` は見ない。`choice` / `confidence` は `noul` の回答に存在しないので検証しない。

   `extractAnswer` は Issue #45 で `extractAnswers(response)`(ラッパーの有無を吸収して `answers` を取り出す)の上に組み直した。`answers[key]` を1つ取り出す従来の形はそのまま残っているので、`digit` / `cell` の挙動と 502 の文言は1文字も変わらない。`extractAnswer` / `validateAnswer` は Issue #38 で **質問キーと期待するキー集合を引数で受け取る形に一般化** した(以前は `answers.digit` と `DIGITS` に固定だった)。502 の理由の文面は質問の種類で変わる(`digit` は「1〜9」、`cell` は「候補マス」)ので、`ANSWER_MESSAGES[ask]` として外から渡す。**`digit` 側の文言は従来のまま**(既存のテストとフロントの表示を変えないため)。
7. `{ probabilities, choice, confidence, request }` に絞って 200 で返す。`ask:"all"` のときは **`{ cells, request }`**(`cells` は質問キー = 空マスごとの `{ choice, probabilities, confidence }`。`type` は落とす。並びは行優先)で、`choice` / `confidence` / `probabilities` / `cell` / `digit` はトップレベルに付けない。`ask:"where"` のときだけは形が変わり、**`{ probabilities, digit, request }`**(`probabilities` は質問キー = 空マスごとの `noul`、`digit` は聞いた数字のエコー)を返す。`choice` / `confidence` / `cell` は付けない(`noul` の回答に無いため)。`ask:"cell"` のときは **`cell: { row, col }`**(`choice` の `"r0c2"` を座標に分解したもの)を加える。フロントが毎回パースしなくて済むようにするためで、`choice` は検証済み(必ず criteria のキーのいずれか)なので分解に失敗することはない。`confidence` は Jev の値をそのまま通す(`probabilities[choice]` に差し替えない)。`request` は **同じ `payload` をそのまま**渡す(別オブジェクトを組み立て直さない)。フロントの「モデルに送ったプロンプト」パネル(4.2 `renderPromptPanel`)がこれをそのまま表示する(Issue #34)。400/415/429/503 には `request` を付けない(まだ `payload` を組み立てていないため) なお **`usage`(Jev のトークン使用量 `{ input_tokens, output_tokens }`。`extractUsage`、Issue #56)は `ask` の種類によらず 3 つの 200 すべてに添える**(取り出せない・形がおかしい・負値なら `usage` ごと省略し、502 にはしない。3.4 / SPEC 4 章)。
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

`ask:"cell"`(Issue #38)の `state` は `target` を持たない:

````javascript
state: {
  puzzle: puzzle,          // 9行の文字列配列。"." が未確定
  note: CELL_NOTE,         // NOTE をベースに「target は無く、空マスの一覧が criteria で与えられる。
                           // どの空マスが最も確定しやすいかを選べ」に書き換えた固定文
}
````

`ask:"where"`(Issue #45)の `state` は `target` の代わりに `digit` を持つ:

````javascript
state: {
  puzzle: puzzle,          // 9行の文字列配列。"." が未確定
  digit: digit,            // "1"〜"9" の文字列。いま聞いている数字
  note: WHERE_NOTE,        // NOTE をベースに「target は無く、digit が聞いている数字。
                           // 各質問は1つの空マスについて、そのマスに digit が入るかを問う」
                           // に書き換えた固定文
}
````

`ask:"all"`(Issue #48)の `state` は `target` も `digit` も持たない:

````javascript
state: {
  puzzle: puzzle,          // 9行の文字列配列。"." が未確定
  note: ALL_NOTE,          // NOTE をベースに「target は無い。各質問は1つの空マスについて、
                           // そこに入る数字を問う。既に置かれている数字が間違っていることもある」
                           // に書き換えた固定文
}
````

`questions` は空マス1つにつき1問で、キーは `"r0c2"` のようなマスのキー、中身は `{ type: "choice", instructions: <ALL_INSTRUCTIONS_TEMPLATE に埋めた文>, criteria: <digit と同じ 1〜9> }`。`ALL_INSTRUCTIONS_TEMPLATE` は `"Which digit from 1 to 9 belongs in the empty cell at row {row}, column {col} (zero-based)?"` で、`WHERE_INSTRUCTIONS_TEMPLATE` と同じく **フロント(Claude 経路)が同じ文言を使えるように定数として `PAGE_HTML` より前に置いてある**。

`ask:"where"` の `questions` は空マス1つにつき1問で、キーは `"r0c2"` のようなマスのキー、中身は `{ type: "noul", instructions: <WHERE_INSTRUCTIONS_TEMPLATE に埋めた文> }`。`WHERE_INSTRUCTIONS_TEMPLATE` は `"Is the digit {digit} the one that belongs in the empty cell at row {row}, column {col} (zero-based)?"` で、**フロント(Claude 経路)が同じ文言を使えるように定数として `PAGE_HTML` より前に置いてある**。

`CELL_NOTE` / `CELL_INSTRUCTIONS` / `WHERE_NOTE` / `WHERE_INSTRUCTIONS_TEMPLATE` / `ALL_NOTE` / `ALL_INSTRUCTIONS_TEMPLATE` は `NOTE` / `INSTRUCTIONS` とは別の定数で、**`NOTE` の文面は変えない**(`ask` を省略したときの挙動を1文字も変えないため)。どちらの経路でも `state` に入るのは「今埋まっているマス」と固定の説明文だけで、`SOLUTION` 由来の情報は入らない(9 章 不変条件1。10 章のテストが `payload` の完全一致で機械的に確認する)。

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
- この `usage`(`input_tokens` / `output_tokens`)は **`/api/judge` の 200 にそのまま載せる**
  (コスト表示用。`extractUsage`。取り出し元は `extractAnswers` と同じで、ラッパー付きなら
  `result.usage`、素の形ならトップレベルの `usage`。形がおかしければ `usage` ごと省略し、502 にはしない)
- 同じ入力を3回投げて `choice` が `1` / `4` / `2` と割れた(正解は `4`)。確率もほぼ平坦
  (最大 0.22)だった。**決定的ではない**。これは不具合ではなく、このアプリが観測したい対象そのもの

参考(将来の転用用):

- `noul` のレスポンスは `{ "type": "noul", "noul": 0.98 }`(確率のみ。閾値判断はアプリ側)。**1回の呼び出しに複数の質問を入れられる**(2026-09-22 に、探り用の使い捨て Worker から `noul` の質問を51個まとめて1回で投げ、51件そのまま返ることを実環境で確認。215 ms、入力 1,948 / 出力 973 トークン。同日、`choice` の質問51個(各 1〜9 の criteria)でも 51 件返った: 1,097 ms、入力 9,483 / 出力 4,083 トークン)。`ask:"where"`(Issue #45)は `noul` 側を、`ask:"all"`(Issue #48)は `choice` 側を使っている。**いずれも探り用の使い捨て Worker からの実測で、本 PR の payload そのもの(`ask:"where"` はキー `r0c2`・`WHERE_NOTE`・`state.digit`、`ask:"all"` はキー `r0c2`・`ALL_NOTE`・質問ごとの 1〜9 の criteria)での疎通は、マージ後に本番で `curl` 1 回で確認する**
- `score` は順序付きの段階から1つを選び、同様に確率を返す

**この形式は変わり得る。** Jev は公開直後で頻繁に更新されており、ゲートウェイのラッパーも
Cloudflare 側の都合で変わる。形が違っていたらこの節と `handleJudge` を同時に直す
(9 章 不変条件5 / `CLAUDE.md` 作業ルール3)。

### 3.5 `PAGE_HTML`

バッククォート付きテンプレートリテラルにHTML全体を格納。テンプレート内の `${...}` は **`NOTE` と `INSTRUCTIONS` を埋め込む 2 箇所だけ**(`var NOTE = ${JSON.stringify(NOTE)};` の形。Claude 経路が Jev と同じルール説明・質問文を使うため。3.6)。それ以外で `${}` を書く必要が出たら `\${}` とエスケープすること。

`PAGE_HTML` は **`src/index.js` の最後の宣言に固定する**。不変条件7のテスト(10 章)は「行頭の `var PAGE_HTML = \`` = テンプレートの開き」「ファイル最後のバッククォート = テンプレートの閉じ」と見なして外側のソースを切り出し、その後ろに `;` と空白しか無いことも併せて検査する。ここに何かを足すと検査が無効になるので、新しいコードは `PAGE_HTML` より前に書く。`var PAGE_HTML = \`` という文字列はコメントを含めてファイル中に1つだけにする(テストで確認している)。

### 3.6 Claude 経路(Issue #37、SPEC 7 章 拡張 3)

**Worker は関与しない。** モデルトグルが「Claude」のとき、ブラウザの `judgeCellClaude()` が
`https://api.anthropic.com/v1/messages` を直接呼ぶ(BYOK。キーは利用者のブラウザの
`localStorage` にだけある)。Worker 側の AI 呼び出しは引き続き `env.AI.run("typesafe/jev")` のみ。

- **なぜブラウザ直呼びか**: Worker でキーを中継すると、オーナーのキーで公開デモを動かすことになり
  (コストの青天井)、レート制限をもう一段作る羽目になる。利用者自身のキーなら課金は利用者持ちで、
  Worker はステートレスなまま。Anthropic API は CORS に対応しており、ブラウザからは
  `anthropic-dangerous-direct-browser-access: true` ヘッダーを付ければ呼べる
- **なぜ SDK でなく素の `fetch` か**: フロントは `PAGE_HTML` に埋めた素の JS でビルドステップが無く、
  `@anthropic-ai/sdk` を読み込む手段が無い(CLAUDE.md の制約)。リクエストの形は SPEC 4 章に固定する
- **確率の取り方**: structured outputs(`output_config.format` = `json_schema`)で
  `{ choice, probabilities(1〜9), confidence }` を **自己申告** させる。Jev の `probabilities` と
  同じ形なので、以降の処理(バー表示・採点・記録・較正図)は共通。較正されている保証は無く、
  それを較正図で見るのが目的
- **プロンプト**: `system` = Worker の `NOTE`(テンプレートに埋め込んだ同じ文字列)+ JSON で答える指示。
  `messages[0].content` = Worker の `INSTRUCTIONS` + 改行 + `{ puzzle, target }`(`buildSnapshot()`。
  対象マスは `.`)。Jev と比較条件を揃えるため、ルール説明と質問文は同一にする
- **thinking**: `claudeThinkingConfig(model, on)`。Opus 5 / Sonnet 5 は `adaptive` / `disabled`、
  Haiku 4.5 は `enabled` + `budget_tokens: 2048`(`max_tokens` に上乗せ)/ 省略。思考トークンは
  `max_tokens` に含まれるので、`adaptive` のときは `max_tokens` を 16000 にする(1024 のままだと
  JSON が出る前に `stop_reason: max_tokens` で終わる)。記録の `m` は
  `<model>+think` / `<model>` で分ける
- **キーの扱い**: `localStorage` の `scc.anthropic_key.v1`。`x-api-key` ヘッダーにだけ載せ、
  「キーを消す」は実行中・停止中はロック(次のマスで止まってしまうため)。保存の失敗は判定ループを
  止めず(`showError` を使わず)パネル内の注意書き(`claudeKeyNotice`)に留める。
  リクエストボディ・`state.lastRequest`(プロンプトパネル)・記録・エクスポート・DOM のどこにも出さない
  (画面は末尾 4 文字のヒントだけ)。`saveAnthropicKey` / `clearAnthropicKey` / `loadAnthropicKey`
- **エラー**: 非 2xx は `Claude API HTTP <status>: <error.message>`、`stop_reason` が `refusal` /
  `max_tokens`、テキストが JSON でない、検証(`validateClaudeAnswer`、Worker の `validateAnswer` と
  同じ基準)に落ちる、ネットワーク失敗、いずれも `Error` に `request`(ボディ。ネットワーク失敗も
  送ろうとしたボディを載せる)を載せて投げ、`focusNext` のエラー側で「(このプロンプトで失敗)」
  として残す(#34 と同じ経路)
  - **一時的な失敗と非一時的な失敗の分類(Issue #43、SPEC F5)**: HTTP 429(レート制限)/ 529
    (過負荷)/ 5xx(`isTransientClaudeStatus()`)、およびネットワーク失敗(`fetch` 自体が reject。
    `AbortError` は別扱いで無視される)は `err.transient=true` を付けて投げる。呼び出し側
    (`focusCellForDigit` / `selectNextCell`)はこれを見て `showError()` の代わりに
    `pauseForTransientError()` に分岐し、`errorMessage` を立てずに「停止」扱いにする(盤面・
    周回ログ・`queue` を保ち「再開」で続けられる)。401(キー不正)・`refusal`・`max_tokens`・
    JSON 不正・検証失敗はそれ以外(非一時的)なので `err.transient` を付けず、従来どおり
    `showError()` でエラー停止になる(復帰はリセットのみ)。この区別は「利用者の操作では直せない
    一時的な事情か、それとも入力やキー設定など利用者側に直せる要因か」がおおまかな基準
- **設定の保存**: `scc.claude_settings.v1` に `{ modelMode, model, thinking }`。`reset()` /
  `newPuzzle()` をまたいで保持し、次回開いたときに `loadClaudeSettings()` で復元する
- **不変条件**(9 章 1 の Claude 版): Claude に送るボディにも `SOLUTION` 由来の情報を入れない。
  `judgeCell()` がスナップショットを 1 回だけ作って両経路に渡すので、盤面の作り方は共通
- **確信度順モードのマス選び(Issue #38)**: `askCellClaude(puzzle, signal)` が
  `buildClaudeCellRequest(puzzle, keys)` のボディで呼ぶ。`keys` は `selectionKeys()`
  (`queue` を行優先に並べた `"r<row>c<col>"` の配列)。`system` は `CLAUDE_CELL_SYSTEM`
  (`CELL_NOTE` ベース)、`messages[0].content` は `CELL_INSTRUCTIONS` + 改行 + `{ puzzle }`
  (`target` は無い)、スキーマは `buildClaudeCellSchema(keys)`(`choice.enum` /
  `probabilities.required` が `keys`。呼び出しのたびに候補が変わるので毎回組み立てる)。
  `thinking` / `max_tokens` の規則は `buildClaudeRequest` と同じ(コードも共有: どちらも
  `claudeThinkingConfig` を呼ぶ)。応答の検証は `validateClaudeAnswer(answer, expectedKeys)` /
  `parseClaudeAnswer(data, expectedKeys)` を `keys` 付きで呼ぶ形に一般化した(省略時は
  `DIGITS`。Worker の `validateAnswer` が `expectedKeys` を取るのと同じ考え方)。`choice`
  (`"r0c2"`)は正規表現 `/^r(\d)c(\d)$/` で座標に分解して `cell: { row, col }` として返す
  (`askCellJev` が Worker のレスポンスの `cell` をそのまま返すのと同じ形に揃える)
- **一括モードの1周ぶん(Issue #48)**: `askAllClaude(puzzle, signal)` が
  `buildClaudeAllRequest(puzzle, keys)` のボディで呼ぶ。`keys` は `selectionKeys()`
  (`queue` を行優先に並べた `"r<row>c<col>"` の配列、確信度順のマス選びと同じ)。`system` は
  `CLAUDE_ALL_SYSTEM`(`ALL_NOTE` ベース + 「マスごとに choice/probabilities/confidence の
  3つ組を答えよ」という指示)、`messages[0].content` は `CLAUDE_ALL_INSTRUCTIONS`(全マスまとめて
  聞く1本の質問文。Worker の `ALL_INSTRUCTIONS_TEMPLATE` はマス1つぶんの文言なので、Claude の
  1本のユーザーメッセージには使わずフロント側で別に用意した)+ 改行 + `{ puzzle }`(`target` は
  無い)。スキーマは `buildClaudeAllSchema(keys)`(`keys` の各キーを `required` に持つオブジェクトで、
  各値は digit 判定と同じ形 `{ choice(enum 1〜9), probabilities(1〜9 が required), confidence }`。
  呼び出しのたびに候補(= その周の `queue`)が変わるので毎回組み立てる)。
  - **`max_tokens` の下限**: 一括は出力が大きい(最大64マス×9確率ぶんの JSON)ので、既存の
    設定(digit 判定用の `CLAUDE_ANSWER_MAX_TOKENS`=1024 / `CLAUDE_ADAPTIVE_MAX_TOKENS`=16000 /
    Haiku の `budget_tokens + CLAUDE_ANSWER_MAX_TOKENS`)と、一括専用の最低値
    (`CLAUDE_ALL_ANSWER_MAX_TOKENS`=16000 / `CLAUDE_ALL_ADAPTIVE_MAX_TOKENS`=24000 /
    `CLAUDE_ALL_HAIKU_MAX_TOKENS`=12000)の **大きい方**(`Math.max`)を使う。思考なしは常に
    一括の最低値がそのまま勝つ(1024 < 16000)。adaptive も同様(16000 < 24000)。Haiku の
    思考ありは `budget_tokens(2048) + 1024 = 3072` のままだと、51マス分の JSON 本体を
    書き切る前に `stop_reason: max_tokens` で切れる見込みが高いため(`ask:"where"` /
    `ask:"all"` の Worker 側実測(3.4)から、空マス51個ぶんの出力は数千トークン規模になると
    分かっている)、12000 を下限にした。**実キーでの疎通(この値で本当に足りるか)はオーナーの
    ブラウザで確認する**(CLAUDE.md、セッションにキーが無いため未検証)
  - 応答の検証は `validateClaudeAllAnswer(answer, expectedKeys, excludeByKey)` /
    `parseClaudeAllAnswer(data, expectedKeys, excludeByKey)`(`extractClaudeText(data)` で stop_reason の
    チェックとテキストブロックの取り出しを `parseClaudeAnswer` と共有する)。`answer` は
    `expectedKeys`(= `keys`)をちょうど持つオブジェクトで、各値が
    `validateClaudeAnswer(answer[key], digits, ...)` と同じ基準を満たすこと
    (`digits` は下記 exclude の残り。無いマスは `DIGITS`)。どのマスで落ちたかが
    わかるよう、文言の先頭にそのマスのキーを添える(Worker の `ask:"all"` の 502 の文言(3.3)
    と同じ考え方)。戻り値は `askAllJev` と同じ形 `{ cells, request }`(`cells` はマスのキー →
    `{ choice, probabilities, confidence }`)
  - **チャンク分割(Issue #74)**: `buildClaudeAllSchema` はマス数ぶん独立した入れ子オブジェクトを
    `properties` に持つため、マス数が多い(実機では固定問題の51マスで再現)と Anthropic の
    構造化出力が「The compiled grammar is too large, which would cause performance issues.
    Simplify your tool schemas or reduce the number of strict tools.」という 400 を返すことが
    実機で確認された。`askAllClaude(puzzle, excludeByKey, signal)` は `selectionKeys()` の結果を
    `chunkArray(keys, CLAUDE_ALL_CHUNK_SIZE)`(既定 10)でチャンクに区切り、チャンクごとに
    `askAllClaudeChunk(puzzle, chunkKeys, excludeByKey, key, signal)`(旧 `askAllClaude` の
    fetch/検証本体をそのまま切り出したもの。1チャンクぶんの `buildClaudeAllRequest` /
    `parseClaudeAllAnswer` を呼ぶ)を `Promise.all` で**並列に**呼ぶ。全チャンクが同じ
    `AbortController`(`signal`)を共有するので、停止すれば全部まとめて中断される。いずれかの
    チャンクが失敗すれば `Promise.all` がその場でエラーになり(他チャンクの結果は捨てる)、
    従来どおり周全体が失敗扱いになる(部分成功は扱わない)。戻り値の `cells` は各チャンクの
    結果をマージしたもの、`usage` は `combineClaudeUsage(a, b)`(`extractClaudeUsage()` と同じ
    形 `{ input_tokens, output_tokens, cache_read_input_tokens? }` を2つ合算する純粋関数。
    `combineRecordUsage`(4.2)の記録形版と同じ考え方だが、`toRecordUsage()` に通す前の生の
    usage を合算する必要があるので別に持つ)で全チャンクぶんを合算したもの、`chunkCount` は
    チャンク数。`request` は先頭チャンクの `body` だけを返す(プロンプト枠は
    `renderAllRequestBlock()` が `allReq.chunkCount > 1` のとき「(N回に分割。先頭の1回だけ
    表示)」を添えて、表示しているのが全部ではないことを明示する)。Jev 経路(Worker、
    `ask:"all"`)はこの制約と無縁なので変更していない
- **消去法(履歴 Issue #61・ルール候補 Issue #63)の Claude 経路**: digit 判定は
  `buildClaudeRequest(puzzle, r, c, exclude)`(`exclude` は `excludeFor(r,c)` の結果、「外す数字」の
  配列)、一括は `buildClaudeAllRequest(puzzle, keys, excludeByKey)`(`excludeByKey` は
  `excludeMapForQueue()` の結果、マスのキー →「外す数字」の配列。Worker に送る `exclude` と
  同じ形)を受け取る。どちらも `remainingDigits(exclude)`(`DIGITS` から `exclude` を引いた残り。
  省略・空なら `DIGITS` のまま)でスキーマの候補を絞り、絞ったとき(残りが9個未満)だけ
  `system` の末尾に `EXCLUDE_NOTE`(`"Digits already ruled out for a cell are omitted from its
  choices."`)を1文足す(絞っていないときはこれまでどおり同じプロンプトのまま変えない。
  `buildClaudeDigitSchema(digits)` / `buildClaudeAllSchema(keys, excludeByKey)` がスキーマを組み立てる。
  `buildClaudeAllSchema` は `excludeByKey[key]` を毎回 `remainingDigits()` に通す ―― Worker に送る
  `exclude` と同じ「外す数字」の形で受け取り、内部で「残りの数字」に変換してから使う点を
  取り違えないこと)。応答の検証は `parseClaudeDigitAnswer(data, remainingDigits(exclude))`
  (digit)/ `validateClaudeAllAnswer(answer, expectedKeys, excludeByKey)`(一括)。どちらも
  `digitAnswerMessages(excluded)` で文言を「候補の数字(exclude後)とちょうど一致していません」/
  「候補の数字(exclude後)のいずれかではありません」に出し分ける(絞っていないときは従来の
  「1〜9の…」の文言のまま)。`validateClaudeAnswer(answer, expectedKeys, keysMessage, choiceMessage)`
  は第3・第4引数を渡すとこの文言を上書きできるよう一般化してある(省略時は従来どおり
  `expectedKeys` の有無で「候補マスの…」/「1〜9の…」を出し分ける、確信度順のマス選び用の規則のまま)

## 4. フロントエンド設計(`PAGE_HTML` 内の `<script>`)

### 4.1 状態

````javascript
var state = {
  round: 1,            // 現在の周
  values: {},          // "r-c" → { value: "4", status: "correct" | "incorrect" }。周をまたいで保持
  focusedKey: null,    // 判定中のマス "r-c"
  currentProbs: null,  // [{ digit:"1", pct:61, isPick:true }, ...] 1〜9順
  roundLog: [],        // { round, correct, total, ms, cost, m } の配列(Issue #55・#56。以前は
                       // 表示用文字列そのものだったが、周ごとの処理時間(ms)・コスト(cost)を
                       // 持たせるため構造体に変えた。表示は renderRoundLog() が
                       // formatRoundLogLine() で整形する。round/correct/total の意味は従来どおり
  running: false,
  done: false,
  roundsToSolve: null, // 完了時の周数
  speedMode: "slow",   // "slow" | "fast"
  difficulty: "normal", // "easy" | "normal" | "hard"。次の newPuzzle() のヒント数に効く(SPEC F1/F4')
  errorMessage: null,  // エラーボックスに出す文言。null なら非表示
  stoppedAtLimit: false, // 15周の安全弁で止まったか(完了バナーの出し分け)
  lastJudgment: null,  // 直前に確定した1件 { r, c, choice, confidence, status, probs }。
                       // 次の結果が来るまで表示に残す(最速モードでも判定が見えるように)
  lastRequest: null    // 直近の判定で Worker が Jev に渡したペイロード(/api/judge の
                       // レスポンスの request をそのまま保持。3.3 手順7)。「Jev に送った
                       // プロンプト」パネル(renderPromptPanel)が表示する。停止中・
                       // エラー時も消さず、reset() / newPuzzle() でだけ null に戻す(Issue #34)
  lastRequestFailed: false, // lastRequest が失敗した判定(502 の request)のものなら true。
                       // 成功応答で false に戻り、パネルに「(このプロンプトで失敗)」を添える
  modelMode: "jev",    // "jev" | "claude"。どのモデルに聞くか(3.6、Issue #37)。reset() で維持
  claudeModel: "claude-opus-5", // Claude 経路のモデル ID(CLAUDE_MODELS のどれか)
  claudeThinking: true, // Claude 経路で thinking を使うか
  calibModelFilter: "all", // 較正図のモデルフィルタ("all" | 記録の m の値)。reset() で維持
  orderMode: "scan",   // "scan"(左上から) | "confidence"(確信度順、Issue #38) | "all"(一括、Issue #48)。
                       // speedMode と同様 reset() / newPuzzle() をまたいで保持。localStorage には保存しない
  selecting: false,    // 確信度順のマス選び中か(askCell の応答待ち)
  cellProbs: null,     // ヒートマップ用 { "r-c": p, ... }。マス選び直後だけ持ち、
                       // commitFocused() で消える(次のマス選びまで出さない)
  lastSelection: null, // 直近のマス選び1件 { r, c, confidence, candidates, p }。
                       // p は probabilities[choice](= 選ばれたマス自身の確率)
  lastCellRequest: null, // 直近のマス選びでモデルに送ったリクエスト(Jev なら
                       // askCellJev の応答の request、Claude なら送ったボディ)
  allFetching: false,  // 一括モード(Issue #48)の askAll() 呼び出し中か。応答が届くまでは
                       // 座標もバーも無い(renderCurrentPanel が「一括で判定中…」を出す)
  lastAllRequest: null, // 直近の一括呼び出し { request, failed, count }(Issue #48)。
                       // renderPromptPanel が「一括」1段(質問N問の要約 + 折りたたみ)で表示する
  pauseReason: null,   // 一時的な失敗による停止の理由文言(Issue #43)。stop()(手動)
                       // では null のまま。run() / reset() / newPuzzle() / stop() で
                       // null に戻る。isPaused() かつこれが非 null のときだけ
                       // renderCurrentPanel() が理由の箱を出す(4.4)
  historyMode: true,   // 消去法(履歴。Issue #61)のトグル。既定あり。orderMode と同じく
                       // modelSettingsLocked() でロックし、reset() / newPuzzle() をまたいで保持
  ruleMode: true        // ルール候補(消去法。Issue #63)のトグル。既定あり。historyMode と同じ扱い
};
// 描画に不要な進行管理はモジュール変数
var queue = [];                 // この周でまだ判定していないマス [{r,c}]
var roundWrong = [];            // この周で不正解だったマス。次の周の queue になる
var roundTally = { correct:0, total:0 };
var roundSize = TOTAL_EMPTY;    // この周の対象マス数(統計カード「この周の判定済み」「この周の正解」の
                                 // 分母。Issue #60。開始前は空マス数
var wrongDigits = {};           // 消去法(履歴。Issue #61)。"r-c" → 前の周までに入れて不正解だった
                                 // 数字の配列(重複なし)。commitFocused() が不正解のたびに積む。
                                 // 周をまたいで保持し、reset() / newPuzzle() で空にする(停止/再開では保つ)
var generating = false;         // 問題を生成している最中か(4.2 newPuzzle)
var started = false;
var pendingCommit = null;       // API結果を受けて確定待ちの1件
var allResults = null;          // 一括モード(Issue #48)のこの周のキャッシュ。null = まだ askAll()
                                 // していない。応答が届いたら "r-c" 形式のキー →
                                 // { choice, probabilities, confidence } に変換して持つ。停止/再開では
                                 // 保つ(再度呼ばない)。周が変わる(finalizeRound)・reset()/newPuzzle()・
                                 // showError() で null に戻す
var runToken = 0;               // 実行の世代。reset() / showError() で +1 する(4.3)
var inflightController = null;  // in-flight の /api/judge 用 AbortController(4.3、Issue #19)
var embedMode = false;          // GET /?embed=1 で true(比較モードの iframe。Issue #46)。
                                 // render() の描画範囲と postStatus() の要否を分ける
// 計時・コスト(Issue #55・#56)。停止中(手動 stop() / 一時的な失敗による停止)は数えない。
var runningSince = null;        // 現在の実行区間の開始時刻(nowMs())。null なら停止中
var totalElapsedMs = 0;         // 「実行」から完了/強制終了までの走っている時間の累計
var roundElapsedMs = 0;         // 今の周で最初のリクエストを送ってから走っている時間の累計
var roundStarted = false;       // 今の周でまだ最初のリクエストを送っていないか
var totalCostUsd = 0;           // この実行(reset() されるまで)の累計コスト
var roundCostUsd = 0;           // 今の周の累計コスト
var totalTokensIn = 0;          // この実行の累計入力トークン数(オーナー追加要望 2026-09-23。
                                 // renderUsagePanel() が表示する)
var totalTokensOut = 0;         // この実行の累計出力トークン数
var totalLatencyMs = 0;         // この実行の累計 API 待ち時間(record.t の合計。formatTps() の分母)
var pendingAllUsage = null;     // 一括モード(#48)の周の先頭1件に usage/レイテンシを付けるための
                                 // 一時置き場(askAllRound() が立て、commitFocused() が周の
                                 // 先頭1件の確定時に消費して null に戻す)
// 比較シェル(GET /compare)専用のモジュール変数(Issue #46)。8章参照
var compareStatus = { jev: null, claude: null };  // 直近の status メッセージ(iframe ごと)
var compareFrames = { jev: null, claude: null };  // <iframe> 要素への参照
var compareEls = { topbar: null, statusJev: null, statusClaude: null }; // 直接更新する sub要素
var compareGenerating = false;  // 「新しい問題」(比較シェル版)で生成中か
````

**計時の仕組み(Issue #55)。** `nowMs()`(= `Date.now()`)1か所に寄せてあり、テストは `ctx.nowMs` を差し替えて確定値で検証する(`RECORDS_MAX` と同じ上書きパターン)。3つの遷移点だけが `totalElapsedMs` / `roundElapsedMs` を書き換える(表示用の読み取りは `currentTotalElapsedMs()` / `currentRoundElapsedMs()` が副作用なく計算する):

- `markRoundStarted()`: 周の最初のリクエストを送る直前(`focusCellForDigit` / `selectNextCell` / `askAllRound` の先頭。二度目以降は `roundStarted` で弾かれる冪等な呼び出し)。それまでの経過(周をまたぐ待ちなど)を `totalElapsedMs` にだけ足し込み、`runningSince` を今に付け替えて周の計測をここから始める
- `pauseClock()`: `haltRun()`(手動 `stop()` / 一時的な失敗による停止)・`showError()` で呼ぶ。走っている区間の分を両方の累計に足し込み、`runningSince` を `null` にする(周の積算 `roundElapsedMs` はリセットしない = 再開すれば続きから測れる)
- `closeRoundClock(keepRunning)`: `finalizeRound()` の周回ログを積む直前に呼ぶ。走っている区間の分を足し込んでからその周の最終値を返し、`roundElapsedMs` / `roundStarted` を次の周のためにリセットする。`keepRunning`(次の周へ続くか)が true なら `runningSince` を今に付け替え(全体の計測は継続)、false(完了/強制終了)なら `null` にする

コスト(`totalCostUsd` / `roundCostUsd`)は `commitFocused()` が記録を1件追記するたびに `costOf(record)` を両方へ足し込む(時間の計測とは独立)。いずれも `run()`(初回のみ)/ `reset()` で0に戻し、`newPuzzle()` は内部で `reset()` を呼ぶので同様に0に戻る。`totalTokensIn` / `totalTokensOut` / `totalLatencyMs` も同じタイミング(`record.u` があるときだけ。`totalLatencyMs` はさらに `record.t` が数値のときだけ)で足し込み、同じく0に戻る。

**`readUrlOptions()` の結果(Issue #46)。** 通常ページ(`GET /`、`location.pathname !== "/compare"`)は起動時に一度だけ `location.search` を読み、`applyUrlOptions()` で次のように反映する。`localStorage` の設定より優先するが、`localStorage` には一切書き戻さない(通常ページの設定を汚さないため。`saveClaudeSettings()` を呼ばない)。

````javascript
{
  puzzle: "<81文字>" | undefined, // 形式(9行×9文字、"1"〜"9"と"."のみ)が正しいときだけセット。
                                   // 採用は applyPuzzleFromString() が一意解を確認してから
  model:  "jev" | "claude" | undefined,
  order:  "scan" | "confidence" | "all" | undefined,
  speed:  "slow" | "fast" | undefined,
  embed:  true | false             // "1" と一致したときだけ true
}
````

`applyPuzzleFromString(str)` は `parsePuzzleString()`(81文字の正規表現チェック)→ `solveCount(rows, 2, solutions)` が1のときだけ `GIVEN` / `SOLUTION` / `TOTAL_EMPTY` / `roundSize` を差し替える(`newPuzzle()` がジェネレーターの結果を差し替えるのと同じ4項目)。形式不正・非一意解はそのまま無視され、固定問題(または直前の盤面)が残る。`readUrlOptions()` のパースは `URLSearchParams` を使わず、素朴な `parseQueryString()` で行う(node:vm のテストハーネスに追加のグローバルを増やさないため)。

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

**記録1件の形(Issue #55・#56・#61・#63)。** `{ at, p, r, c, round, choice, pc, conf, ok, m, n, e, rc, o?, u?, ci?, t? }`。
`n` は消去法(exclude)後に候補だった数字の数(除外なしなら9。`Object.keys(pendingCommit.probabilities).length`
から取る。probabilities は Worker/Claude が残りの数字だけで返すので、これがそのまま候補数になる)、
`e` / `rc` は確定時点の `state.historyMode` / `state.ruleMode`(トグルの状態)をそのまま入れる。
`at`(記録した時刻、`nowMs()`)は較正図のキャッシュ無効化にだけ使う内部用の値で、以前は
`t` という名前だった(#55 で `t` を「呼び出しのレイテンシ(ミリ秒)」に転用したため `at` に
改名した。混同しないよう注意)。古い記録(`at` が無く `t` がエポックミリ秒(1e11 以上)のもの)は
`loadRecords()` の `migrateLegacyRecordTimestamps()` が読み込み時に `t` → `at` に付け替える(冪等。
次の `appendRecord()` の保存で永続化される)。`u`(`{ i, o }`。入力/出力トークン数)・`ci`(キャッシュ読み
込みトークン数、あれば)は `usage` が取れたときだけ、`t`(その判定のレイテンシ、ミリ秒)も `u` と同時にだけ付く
(一括モードは周の先頭1件だけ、確信度順はマス選び+数字の合算。停止で捨てた応答済みぶんは `carryUsage` で
次の記録に持ち越す。3.6・4.3 参照)。`costOf(rec)`
(4.2)がこれらから表示用のコストを計算する。

### 4.2 関数と責務

| 関数 | 責務 |
|---|---|
| `solveCount(grid, limit, found)` | 解の個数を数えるソルバー。`limit` 個見つけたら打ち切る(一意解の判定は `limit=2` で足りる)。候補の少ないマスから埋める(MRV)+ 行・列・箱のビットマスクでのバックトラッキング。`found` に配列を渡すと見つけた解を9行の文字列配列で受け取れる。置かれている数字がすでに矛盾していれば 0 |
| `generateSolvedGrid()` | 空盤面に対し、各マスの候補をシャッフルしながらバックトラッキングして完成盤を1つ作る純粋関数(乱数のみ外部依存) |
| `generatePuzzle(targetGivens)` | 完成盤からマスをランダム順に消し、消すたびに `solveCount(grid, 2) === 1` を確認する(2 になるなら戻す)。与えられた数字が `targetGivens`(既定 `DEFAULT_TARGET_GIVENS` = 30、下限 `MIN_TARGET_GIVENS` = 24)になったら打ち切る。戻り値 `{ given, solution }`(どちらも9行の文字列配列)。ランダム順の都合で `targetGivens` ちょうどに届かず、それより多いヒント数で止まることがある(下は `generatePuzzleWithRetry`) |
| `generatePuzzleWithRetry(targetGivens)` | `generatePuzzle(targetGivens)` をランダム順を変えて最大 `GENERATE_RETRIES`(既定3)回試し、ちょうど `targetGivens` に届いた時点で打ち切って返す。「むずかしい」(`DIFFICULTY_GIVENS.hard` = 25)は目標ちょうどに届かず26〜28で止まることがある(既知。PR #15 の補足)ため、3回とも届かなければ、そのうち最もヒント数が少ない結果を返す(無限ループにしない)。`newPuzzle()` が呼ぶ |
| `newPuzzle()` | 「新しい問題」ボタン。`generating` を立てて `reset()`(= 世代トークンを進めて進行中のループを無効化し、in-flight の `/api/judge` も `abort()` する。Issue #19)し、`reset()` で維持される `state.difficulty` から目標ヒント数(`DIFFICULTY_GIVENS[state.difficulty]`)を決めてから `setTimeout(…, 0)` で `generatePuzzleWithRetry()` を呼んで生成し、`GIVEN` / `SOLUTION` / `TOTAL_EMPTY` / `roundSize` を差し替えて再描画。生成は同期で「むずかしい」の3回試行でも概ね数十 ms 以下(実測: 10回で 200ms 未満) |
| `countEmpty(grid)` / `boxIndex` / `gridToCells` / `cellsToGrid` / `shuffled` | 上記の下請け。盤面の2つの表現(9行の文字列配列 ⇔ 81要素の数値配列。0 が空)の変換と、Fisher-Yates シャッフル |
| `buildSnapshot()` | `GIVEN` + `state.values`(正誤問わず)から9行の文字列配列を作る。未確定は `.`。**判定対象のマスだけは `.` にして送る(他のマスの過去の推測は正誤問わず残す)**。Worker 側も 3.3 でこれを検証する |
| `buildSelectionSnapshot()` | 確信度順モード(Issue #38)のマス選びに送る盤面。`buildSnapshot()` と同じ組み立て方だが、`state.focusedKey` ではなく **`queue` に入っている全マス** を `.` にする。こうすると Worker(`/api/judge` の `ask:"cell"`)/ Claude が列挙する「空マス」が、その周でまだ確定していないマスとちょうど一致する(2周目以降は前の周の不正解の推測が残ったままだと空マスとして数えられないため) |
| `selectionKeys()` | `queue` を行優先(`r`→`c`)にソートし `"r<row>c<col>"` の配列にする純粋関数。Claude 経路のマス選びのスキーマ(`choice.enum` / `probabilities.required`)に使う(Jev 経路は Worker が同じ集合・同じ順序を作るので使わない) |
| `settledKeys` / `snapshotSettledKeys()` | 消去法・ルール候補(Issue #63)が参照する「前の周までに正解して確定した」マスのスナップショット(`"r-c"` → `true`)。`snapshotSettledKeys()` は `state.values` のキーから、その時点の `queue`(=まだ未確定のマス)に入っているキーを除いて作り直す。`run()` の初回開始時と、`finalizeRound()` が次の周の `queue` を作った直後にだけ呼ぶ(周の途中では変わらない)。`reset()` / `newPuzzle()` で空にする。**同じ周の中の推測(正解・不正解問わず)を `ruleExclusions()` に混ぜないためのガード**(下記、M1) |
| `ruleExclusions(r,c)` | 消去法・ルール候補(Issue #63)。実盤面のうち `settledKeys` に入っているマスだけ(= 前の周までに正解して確定したマス。`GIVEN` は常に含む)から、`(r,c)` と同じ行・列・3×3ブロックに既にある数字を集める純粋関数(昇順・重複なし)。今の周の中の推測(まだ `queue` に残っている=未確定のマス)は正解・不正解を問わず含めない。`GIVEN` / `state` / `settledKeys` だけを自由変数として参照するので、テストから直接評価できる。正解(`SOLUTION`)は一切見ない。**当初 `state.values` を素通りで見ていたため、同じ周内で先に(不正解のまま)埋まった推測が別マスの候補から正解を除外してしまうバグがあった(#72 の Opus レビュー M1)。`settledKeys` 経由に直して修正した(テスト AB11・AB12・AB14)** |
| `wrongDigits` / `addWrongDigit(key,digit)` | 消去法・履歴(Issue #61)。`wrongDigits` は `"r-c"` → 前の周までに入れて不正解だった数字の配列(重複なし)。`addWrongDigit()` は `commitFocused()` が不正解のときだけ呼び、同じ数字は追加しない。周をまたいで保持し、`reset()` / `newPuzzle()` で空にする(4.1) |
| `unionDigits(a,b)` | 2つの数字配列(重複ありうる)を昇順・重複なしにまとめる純粋関数。`excludeFor()` が履歴とルール候補の和集合を作るのに使う |
| `excludeFor(r,c)` | `(r,c)` を聞くときに Worker / Claude の `exclude` に渡す「外す数字」(Issue #61・#63)。`state.historyMode` が true なら `wrongDigits[key]`、`state.ruleMode` が true なら `ruleExclusions(r,c)` を取り、`unionDigits()` で和集合にする。履歴(不正解だった数字)もルール候補(既に確定済みの数字)もそのマスの正解を含まない設計なので、9個全部になる(=正解まで除外される)のは理論上起きないが、防御として履歴側を捨ててルール側だけにし、それでも9個なら空にする(Worker の 400 を絶対に踏まない) |
| `excludeMapForQueue()` | 一括モード(Issue #48)の `exclude` マップ。`queue` の各マスについて `excludeFor(r,c)` を計算し、空でないものだけ `"r<row>c<col>"` キーで集める(空マスは省く。Worker の `ask:"all"` の契約どおり) |
| `buildDigitBars(probabilities,choice)` | 1〜9の確率バー用データを作る純粋関数(`focusCellForDigit` / `focusCellFromCache` 共通)。`probabilities` に無いキー(消去法で除外した数字)は `excluded:true` にする(`renderBars()` が「×」表示に使う。Issue #61・#63) |
| `formatRoundSummary(round, correct, total)` | 周回ログの1行「N周目: M中K正解 (P%)」を組み立てる純粋関数。`total` が0でも割り算しない |
| `nextQueue(roundWrong)` | 次の周の `queue` を作る純粋関数。配列も要素も複製して返す(`roundWrong = []` の影響を受けないため) |
| `shouldStop(round, incorrectCount)` | 周の終わりの判断を返す純粋関数。`"solved"`(不正解0)/ `"limit"`(`MAX_ROUNDS` に到達)/ `"continue"` |
| `isCurrent(token)` | `state.running && token === runToken`。古い世代のコールバックを弾く(4.3) |
| `isPaused()` | `started && !state.running && !state.done && !state.errorMessage`。「実行を始めた後、停止していて、完了もエラーもしていない」状態(SPEC F1、Issue #32)。`renderControls()` の「再開」ラベルと `renderCurrentPanel()` の「停止中」表示で使う |
| `judgeCell(r,c,signal)` | `buildSnapshot()` と `excludeFor(r,c)`(消去法。Issue #61・#63)を **ここで 1 回だけ** 作り、`state.modelMode` に応じて `judgeCellJev` / `judgeCellClaude` に渡す(両経路で盤面・exclude の作り方を共通にする)。戻り値はどちらも `{ probabilities, choice, confidence, request, usage? }` に `_t`(呼び出しのレイテンシ、ミリ秒。`nowMs()` で計った fetch 開始〜応答取得。Issue #55)を足したもの |
| `judgeCellJev(puzzle,r,c,exclude,signal)` | `/api/judge` を `fetch`(`signal` をそのまま渡す。`focusNext` が渡す `inflightController.signal`)。`exclude` が空でなければ `body.exclude` に付ける(空なら付けない=従来どおりの payload。Issue #61・#63)。非2xxは `Error` にして投げる(502 の `request` は `err.request` に載せる)。429 / 503 は `markJevTransientError()` で `err.transient=true` を付ける(429 は `Retry-After` ヘッダーがあれば `err.retryAfter` も。Issue #43) |
| `markJevTransientError(error,res)` | Jev 経路(Worker)の一時的な失敗(Issue #43)の判定。`res.status` が 429 / 503 のときだけ `error.transient=true` を立て、429 なら `Retry-After` ヘッダーを `Number()` して正の有限値のときだけ `error.retryAfter` に入れる(ヘッダーが無い・空文字・HTTP 日付形式のときは付けない)。`judgeCellJev` / `askCellJev` の両方が使う |
| `judgeCellClaude(puzzle,r,c,signal)` | `loadAnthropicKey()` が無ければ即 `Error`。`buildClaudeRequest()` のボディで `api.anthropic.com` を直接 `fetch`(3.6)。非 2xx・`refusal`・形式不正・ネットワーク失敗は `Error` に `request`(ボディ)を載せて投げる。ネットワーク失敗、および `isTransientClaudeStatus(res.status)`(429 / 529 / 5xx)な非 2xx には `err.transient=true` も付ける(Issue #43)。成功時は `extractClaudeUsage(data)`(4.2)で応答の `usage` を戻り値に足す(Issue #56)。`askCellClaude` / `askAllClaude` も同様 |
| `isTransientClaudeStatus(status)` | Claude 経路の一時的な失敗(Issue #43)の判定。`status === 429 \|\| status === 529 \|\| (500 <= status < 600)` |
| `buildClaudeRequest(puzzle,r,c)` / `claudeThinkingConfig(model,on)` / `parseClaudeAnswer(data,expectedKeys)` / `validateClaudeAnswer(answer,expectedKeys)` | Claude 経路のリクエスト組み立て(3.6)、モデル別 thinking、応答からの JSON 取り出し、Worker の `validateAnswer` と同じ検証。`expectedKeys` は省略時 `DIGITS`(Issue #38 で候補キー集合を引数に取る形へ一般化。Worker の `validateAnswer` と同じ考え方) |
| `askCell(signal)` | 確信度順モード(Issue #38)のマス選び1回。`buildSelectionSnapshot()` を **ここで1回だけ** 作り、`state.modelMode` に応じて `askCellJev` / `askCellClaude` に渡す。戻り値はどちらも `{ probabilities, choice, confidence, request, cell, usage? }` + `_t`(Issue #55) |
| `askCellJev(puzzle,signal)` | `/api/judge` に `{ puzzle, ask: "cell" }` を `fetch`(`target` は付けない)。`judgeCellJev` と同じ形でエラーを投げる(429 / 503 の `transient` / `retryAfter` も同じ `markJevTransientError()` で付く) |
| `askCellClaude(puzzle,signal)` | `selectionKeys()` で候補キーを作り、`buildClaudeCellRequest(puzzle,keys)` のボディで `api.anthropic.com` を `fetch`(3.6)。`choice`(`"r0c2"`)を正規表現で座標に分解し `cell` として返す。分解できない(=候補外の応答)場合もエラーとして投げる(429 / 529 / 5xx・ネットワーク失敗の `transient` は `judgeCellClaude` と同じ) |
| `buildClaudeCellRequest(puzzle,keys)` / `buildClaudeCellSchema(keys)` | 確信度順のマス選び(Claude 経路)のリクエスト組み立て(3.6)。`buildClaudeRequest` と同じ `thinking` / `max_tokens` の規則を共有する |
| `askAll(signal)` | 一括モード(Issue #48)の1周ぶん。`buildSelectionSnapshot()` と `excludeMapForQueue()`(消去法。Issue #61・#63)を **ここで1回だけ** 作り、`state.modelMode` に応じて `askAllJev` / `askAllClaude` に渡す。戻り値はどちらも `{ cells, request, usage? }`(`cells` はマスのキー → `{ choice, probabilities, confidence }`)+ `_t`(Issue #55) |
| `askAllJev(puzzle,excludeByKey,signal)` | `/api/judge` に `{ puzzle, ask: "all" }` を `fetch`(`target` も `digit` も付けない)。`excludeByKey` にキーが1つでもあれば `body.exclude` に付ける(空なら付けない。Issue #61・#63)。`judgeCellJev` / `askCellJev` と同じ形でエラーを投げる(429 / 503 の `transient` / `retryAfter` も同じ `markJevTransientError()` で付く) |
| `askAllClaude(puzzle,excludeByKey,signal)` | `selectionKeys()` で候補キーを作り、`chunkArray(keys, CLAUDE_ALL_CHUNK_SIZE)` でチャンクに区切って `askAllClaudeChunk` を `Promise.all` で並列に呼ぶ(3.6、Issue #74)。結果をマージし、戻り値は `askAllJev` と同じ形 `{ cells, request, usage } ` + `chunkCount`(`request` は先頭チャンクのボディだけ、`usage` は `combineClaudeUsage` で全チャンク合算) |
| `askAllClaudeChunk(puzzle,chunkKeys,excludeByKey,key,signal)` | 一括モード(Claude 経路)の1チャンクぶんの `fetch`。`buildClaudeAllRequest(puzzle,chunkKeys,excludeByKey)` のボディで `api.anthropic.com` を呼び、`validateClaudeAllAnswer(...,chunkKeys,excludeByKey)` / `parseClaudeAllAnswer(...,chunkKeys,excludeByKey)` で検証する(429 / 529 / 5xx・ネットワーク失敗の `transient` は `judgeCellClaude` と同じ)。`askAllClaude` がチャンクの数だけ呼ぶ |
| `chunkArray(list,size)` | `list` を `size` 件ずつの配列に区切る純粋関数。一括モード(Claude 経路)のチャンク分割(Issue #74)に使う |
| `combineClaudeUsage(a,b)` | `extractClaudeUsage()` と同じ形( `input_tokens`/`output_tokens`/`cache_read_input_tokens?`)の usage を2つ合算する純粋関数。`combineRecordUsage`(4.2、`i`/`o`/`ci` の record 形)と同じ考え方だが、`askAllClaude` が `toRecordUsage()` より前の生の usage を合算するのに使う(Issue #74) |
| `buildClaudeAllRequest(puzzle,keys)` / `buildClaudeAllSchema(keys)` | 一括モード(Claude 経路)の1チャンクぶんのリクエスト組み立て(3.6)。`max_tokens` は既存の規則と一括専用の最低値の `Math.max`。`keys` はそのチャンクのキーだけ(呼び出し全体の `queue` ではない) |
| `extractClaudeText(data)` | Messages API の応答から `stop_reason` のチェックとテキストブロックの取り出しだけを行う共通部分。`parseClaudeAnswer` / `parseClaudeAllAnswer` が共有する(重複していた抽出ロジックを一本化。Issue #48) |
| `validateClaudeAllAnswer(answer,expectedKeys)` / `parseClaudeAllAnswer(data,expectedKeys)` | 一括モードの応答検証(3.6)。`answer` は `expectedKeys`(= その周の `queue` のキー)をちょうど持つオブジェクトで、各値が `validateClaudeAnswer(answer[key], DIGITS)` と同じ基準を満たすこと。どのマスで落ちたかが文言に出る |
| `loadAnthropicKey()` / `saveAnthropicKey(key)` / `saveAnthropicKeyFromInput()` / `clearAnthropicKey()` / `anthropicKeyHint()` | キーの読み書き(`scc.anthropic_key.v1`)。画面には末尾 4 文字だけ |
| `loadClaudeSettings()` / `saveClaudeSettings()` / `setModelMode(mode)` / `setClaudeModel(model)` / `setClaudeThinking(on)` / `modelSettingsLocked()` / `currentModelId()` | モデル設定(`scc.claude_settings.v1`)。実行中・停止中(`isPaused()`)はロックして切り替えない。`currentModelId()` は記録の `m` に入れる識別子 |
| `setOrderMode(mode)` | 順番トグル(Issue #38・#48)。`"scan"` / `"confidence"` / `"all"` のいずれか。`modelSettingsLocked()` と同じ条件でロックする(周の途中でマスの選び方が混ざらないように)。`localStorage` には保存しない |
| `setHistoryMode(on)` / `setRuleMode(on)` | 消去法の2トグル(履歴 Issue #61 / ルール候補 Issue #63)。`setOrderMode` と同じ条件(`modelSettingsLocked()`)でロックし、`localStorage` には保存しない |
| `focusNext()` | 先頭で `runToken` を捕まえ、`queue` が空なら `finalizeRound()`。`state.orderMode === "confidence"` なら `selectNextCell(token)`、`"all"` なら `focusNextAll(token)` に委譲して `return`。そうでなければ(scan)`queue` から1つ取り出して `focusCellForDigit(cell, token)` を呼ぶ |
| `selectNextCell(token)` | 確信度順モード(Issue #38)のマス選び。周の最初の呼び出しなら `markRoundStarted()`(Issue #55)。`state.selecting=true` にして描画 →(リクエストごとに新しい `AbortController` を `inflightController` に作って)`askCell` → `result.request` があれば先に `state.lastCellRequest` に保存(失敗しても「マス選び」のプロンプトを表示できるように)→ `result.cell` が `queue` に無ければ `showError("選ばれたマスが候補にありません: …")` して `return` → `result.probabilities`(`"r0c2"` 形式)を `"r-c"` 形式に変換して `state.cellProbs`(と最大値 `state.cellProbsMax`。ヒートマップ用)に、`state.lastSelection` に `{ r, c, confidence, candidates: probabilities のキー数, p: probabilities[choice] }` を保存 → `queue.splice(idx,1)` で選ばれたマスを取り除き `state.selecting=false` → `toRecordUsage(result.usage)` / `result._t` を `{ usage, latencyMs }` にまとめ(Issue #56)、`focusCellForDigit(cell, token, priorUsage)` に渡す(この中で描画)。`AbortError` は無視、それ以外の失敗は `err.request` があれば `state.lastCellRequest` に保存し、`err.transient`(Issue #43)なら `pauseForTransientError(err)` に分岐して `return`、そうでなければ従来どおり `showError` |
| `focusCellForDigit(cell,token,priorUsage?)` | 1マスの数字判定本体(従来の `focusNext()` の中身そのもの。Issue #38 で `focusNext` / `selectNextCell` の両方から呼べるように抽出した)。周の最初の呼び出しなら `markRoundStarted()`(Issue #55)。フォーカス→(新しい `AbortController` で)`judgeCell`→バー表示・`result.request` があれば `state.lastRequest` に保存(Issue #34)→ `combineRecordUsage(priorUsage.usage, toRecordUsage(result.usage))` と `(priorUsage.latencyMs || 0) + result._t` を `pendingCommit.usage` / `.latencyMs` に持たせる(`priorUsage` は確信度順のマス選びぶん。scan/all からの呼び出しでは `undefined`。Issue #55・#56)→(待ち)→`commitFocused`→(待ち)→`focusNext()` で次へ。`judgeCell` が `AbortError` で reject したときは(世代トークンの判定と同じ扱いで)無視して `return` し、`showError` には流さない(4.3、Issue #19)。それ以外の失敗で `err.request` があれば(`judgeCell` が 502 の `request` を載せる)`state.lastRequest` に保存して `lastRequestFailed=true` にしてから、`err.transient`(Issue #43)なら `pauseForTransientError(err)` に分岐して `return`、そうでなければ従来どおり `showError`(Issue #34) |
| `focusNextAll(token)` | 一括モード(Issue #48)の周の入口。`allResults`(この周のキャッシュ)が `null`(= まだ `askAll()` していない)なら `askAllRound(token)` を呼ぶ。既にあれば(応答済み、または停止/再開で戻ってきた)`queue` から1つ取り出して `focusCellFromCache(cell, token)` に渡す |
| `askAllRound(token)` | 一括モードの周ぶんの呼び出し。周の最初(で唯一)のリクエストなので `markRoundStarted()`(Issue #55)。`state.allFetching=true` にして描画 →(新しい `AbortController` で)`askAll` → `result.request` があれば `state.lastAllRequest = { request, failed:false, count }`(`count` は呼び出し時点の `queue.length`)を保存 → `pendingAllUsage = { usage: toRecordUsage(result.usage), latencyMs: result._t }` を立てる(周の先頭1件にだけ付けるための一時置き場。Issue #56)→ `result.cells`(`"r0c2"` 形式のキー)を `"r-c"` 形式に変換して `allResults` に持ち `state.allFetching=false` → `focusNextAll(token)` で1マス目へ。失敗は `err.request` があれば `state.lastAllRequest = { request, failed:true, count }`、`err.transient`(Issue #43)なら `pauseForTransientError(err)`、それ以外は従来どおり `showError`(`queue` は変えていないので、いずれの再開も同じ周のまま `askAllRound()` をやり直す) |
| `focusCellFromCache(cell,token)` | 一括モードの1マスぶん。`focusCellForDigit` と同じ「フォーカス→バー表示→確定→次へ」の流れだが、`judgeCell()` を呼ばず `allResults[key]` から読むだけなので `fetch` は発生しない(1周1回の呼び出しで済ませるのが目的)。`pendingAllUsage` が立っていれば(= この周でまだどの記録にも usage を付けていない)`pendingCommit.usage` / `.latencyMs` に写して `null` に戻す(2件目以降は付かない = 二重計上しない。Issue #56)。`SLOW_BEFORE_COMMIT_MS` 等の速度モードの待ちは共通(スロー/最速の見え方も既存どおり) |
| `commitFocused()` | `pendingCommit` を `state.values` に反映し、`roundTally`/`roundWrong`/`state.lastJudgment` を更新。`pendingCommit` が無い、または `state.focusedKey` と一致しないときは何もしない。不正解なら `addWrongDigit(key, pendingCommit.choice)`(消去法・履歴。Issue #61)を呼ぶ。正誤が確定するこの時点で `appendRecord()` を呼び、集計ビュー用の1件を記録する。`m` は `activeModelIdForPricing()`(= `currentModelId()`。一括モードは `"typesafe/jev/all"` または `currentModelId() + "/all"`。`o` も `"all"` を添える。Issue #48)。`n`(候補数。`probabilities` のキー数)・`e`(`state.historyMode`)・`rc`(`state.ruleMode`)も添える(Issue #61・#63)。`pendingCommit.usage` があれば `record.u = { i, o }`(`ci` があれば添える)、`pendingCommit.latencyMs` が数値なら `record.t` を付ける(Issue #55・#56)。続けて `costOf(record)` を `roundCostUsd` / `totalCostUsd` の両方に足し込む。`state.cellProbs` もここで `null` に戻す(Issue #38。次のマス選びまでヒートマップを出さない) |
| `finalizeRound()` | 冒頭で一括モード(Issue #48)のこの周のキャッシュ(`allResults` / `pendingAllUsage`)を `null` に戻す(次の周は改めて1回聞く)。`decision = shouldStop(...)` を先に決め、`closeRoundClock(decision === "continue")`(4.1)でこの周の `ms` を確定・`roundCostUsd` を取り出してから、`state.roundLog` に `{ round, correct, total, ms, cost, m: activeModelIdForPricing() }` を積む(Issue #55・#56。以前は文字列1本を積んでいた)。`decision === "limit"` のときは続けてもう1件、`{ round, limit: true, wrong: roundWrong.length }` を積む(Issue #60。`renderRoundLog()` が `formatLimitLogLine()` で「N周で強制終了(最終周の不正解 M マス)」として描く。`countRoundLogEntries()` はこの行を「周」として数えない)。そのあと `shouldStop` の結果で完了 / 強制終了 / 次の周(`queue = nextQueue(roundWrong)`)。「次の周」のときは、between-round の `setTimeout` を張る**前**に `state.round` / `queue` / `roundSize` / `roundTally` を更新する。この順序のおかげで、待ち時間中に `stop()` されても次の周の状態が既に確定している(下記 `stop()`、Issue #32) |
| `stop()` | 実行中の停止(SPEC F1、Issue #32)。`reset()` と同じく `runToken` を進めて in-flight の `/api/judge`(`inflightController.abort()`)と予約済みの `setTimeout` を無効化するが、`reset()` と違って **`state.values` / `state.round` / `state.roundLog` / `roundTally` / `roundSize` / `queue` / `started` は捨てない**。`state.focusedKey` があれば(= 判定中のマスがまだ `commitFocused()` されていない)、その結果を破棄して記録(`appendRecord`)にも残さず、`queue.unshift({r,c})` で queue の先頭に戻す(再開したら同じマスをもう一度聞く。SPEC F2)。周をまたぐ待ち時間中(`finalizeRound()` の between-round の `setTimeout` 待ち)に呼ばれた場合は、その時点で `focusedKey` は既に `null`(`commitFocused()` で消えている)なので何もすることがなく、次の周の先頭から再開する(`finalizeRound()` の更新順序による。SPEC F3)。`state.done` / `state.errorMessage` のときは何もしない(両者は常に `running=false` とセットで立つので `state.running` を見るだけで判定できる)。**確信度順モード中の停止(Issue #38)**: `state.selecting`(マス選び中)なら無条件で `state.selecting=false` / `state.cellProbs=null` にする。選ばれたマスはまだ `queue` から取り除いていない(選び終わって `splice` して初めて取り除く)ので、`focusedKey` が無い限り再キューは不要。再開(`run()`)はマス選びからやり直す。手動停止には理由が無いので `state.pauseReason=null` にする(下記 `pauseForTransientError()` と区別する。Issue #43)。実体は `haltRun(null)` |
| `haltRun(reason)` | `stop()` と `pauseForTransientError()` の共通処理。`state.running` でなければ何もしない。まず `pauseClock()`(4.1、Issue #55)で計時を止め、`runToken` を進めて in-flight を abort、`running=false`、判定中のマスは `queue` の先頭に戻し `pendingCommit` を破棄、`selecting=false` / `cellProbs=null` / `state.allFetching=false` にし(一括モードのキャッシュ `allResults` はここでは **保つ**。Issue #48)、`state.pauseReason=reason`(手動停止は `null`)にして描画する。`state.errorMessage` は立てない(= `isPaused()` は true になる) |
| `pauseForTransientError(err)` | 一時的な失敗による停止(Issue #43、SPEC F5)。`judgeCell*` / `askCell*` が `err.transient=true` で投げてきたときに `showError()` の代わりに呼ぶ。`haltRun(buildPauseReason(err))` を呼ぶだけ(= **`stop()` と同じ後始末**)。`buildPauseReason(err)` が組み立てる理由文言(`"一時的な失敗で停止しました: " + err.message`。`err.retryAfter` が数値なら `"(N秒後に再試行できます)"` を挟む)を `state.pauseReason` にセットする。`state.values` / `roundLog` / `roundTally` / `roundSize` / `queue` / `started` は `stop()` と同じく捨てない。記録(`appendRecord`)は呼ばない(判定が確定していないため) |
| `run()` | 初回のみ queue を全空マスで初期化し、計時・コストの累計(`totalElapsedMs` / `roundElapsedMs` / `roundStarted` / `totalCostUsd` / `roundCostUsd`)を0に戻す(Issue #55・#56)。そのあと常に `runningSince = nowMs()`(区間の開始)。`started` が既に true なら(= `stop()` / `pauseForTransientError()` した後の再開)queue を作り直さず `focusNext()` を呼ぶだけなので、保たれた進行状態からそのまま続く(確信度順モードで停止していた場合も、queue は変わっていないのでマス選びからやり直す形で自然に再開する。一括モードも同様で、`allResults` が残っていればキャッシュから、無ければ `askAllRound()` からやり直す)。冒頭で `state.pauseReason=null` にする(一時的な失敗からの再開で理由表示を消す。手動停止からの再開はもともと `null` なので無害。Issue #43) |
| `reset()` | `runToken` を進め、`inflightController` があれば `abort()` して in-flight の `/api/judge` を打ち切り、進行管理と `state` を初期化(`speedMode` / `difficulty` / `orderMode` / `historyMode` / `ruleMode` は維持。`lastRequest` / `lastCellRequest` / `lastSelection` / `lastAllRequest` / `pauseReason` も `null` に戻す。一括モードのキャッシュ `allResults` / `pendingAllUsage` も `null` に戻す。`wrongDigits` も `{}` に戻す(消去法・履歴。Issue #61)。計時・コストの累計も0に戻す)(Issue #19、#21、#34、#38、#43、#48、#55、#56、#61) |
| `showError(message)` | `pauseClock()`(4.1、Issue #55)で計時を止めたうえで、`runToken` を進め、`inflightController` があれば `abort()` して `state.errorMessage` を立て、`running=false` で止める(不変条件4、Issue #19)。以前の `pauseReason` が残っていても `null` に戻す(エラー停止が優先されるので理由の表示は不要。Issue #43)。一括モードのキャッシュ(`allResults` / `state.allFetching`)も捨てる(復帰はリセットのみなので、途中から再開することはない。Issue #48) |
| `setSpeed(mode)` | `state.speedMode` を切り替えて再描画。実行中でも切り替えられる(4.4) |
| `setDifficulty(mode)` | `state.difficulty`(`"easy"` / `"normal"` / `"hard"`)を切り替えて再描画。変えただけでは盤面は変わらず、次の `newPuzzle()` の目標ヒント数に効く(Issue #21) |
| `render()` | `state` から DOM(グリッド・統計・バー・ログ・集計パネル・バナー・ボタン)を **全部 innerHTML で再生成**。周回ログのスクロール位置だけは引き継ぐ |
| `render*()` | `renderGrid` / `renderLegend`(確信度順のときだけヒートマップの凡例を1項目足す。Issue #38)/ `renderControls`(モデルトグル・順番トグル・消去法の2トグル(履歴・ルール候補。Issue #61・#63)含む)/ `renderClaudeSettings`(Claude のときだけ)/ `renderErrorBox` / `renderStats`(+`statCard`。「この周の判定済み」「この周の正解」の2枚に分かれる。Issue #60)/ `renderCurrentPanel`(+`coordLabel` / `renderBars` / `renderSelectionLine`)/ `renderPromptPanel`(+`renderRequestBlock` / `renderAllRequestBlock`)/ `renderRoundLog`(+`formatLimitLogLine`。強制終了の行。Issue #60)/ `renderCalibration`(+`renderCalibrationChart`)/ `renderBanner`。それぞれHTML文字列を返すだけで、DOMには触らない |
| `renderSelectionLine()` | 確信度順モード(Issue #38)の「マス選び: N 候補中 r行目c列目(p%)/ confidence q%」行。`state.lastSelection` が無ければ空文字列。`renderCurrentPanel()` が `state.focusedKey` があるとき(= マス選びが終わって数字判定中)にだけ先頭に差し込む |
| `renderPromptPanel()` / `renderRequestBlock(req,failed,heading)` / `renderAllRequestBlock(allReq)` | 「現在の判定」パネルの直下の「モデルに送ったプロンプト」枠(SPEC F1、Issue #34、#38、#48)。`renderRequestBlock` が1件ぶんの表示(座標・失敗注記・見出し・`<pre>` の JSON)を組み立てる下請け。左上からモード(`orderMode` が `"confidence"` でも `"all"` でもないとき)は従来どおり `state.lastRequest` 1件だけを `heading=null` で表示。**確信度順モード**は `state.lastCellRequest`(見出し「マス選び」)→ `state.lastRequest`(見出し「数字」)の順で2段に並べる(どちらも無ければ従来と同じ「まだ判定していません」)。座標(`req.state.target`)・`lastRequestFailed` なら「(このプロンプトで失敗)」を添える処理は共通。**一括モード**は `state.lastAllRequest`(`{ request, failed, count }`)を `renderAllRequestBlock` に渡し、「一括: 質問 N 問」の要約行 + `<details>` の折りたたみで表示する(1周ぶんの `request` は空マスの数だけ質問を含み大きいため)。Jev 経路では Worker の `handleJudge` が返す `request`、Claude 経路ではブラウザが送ったリクエストボディをそのまま表示し、フロント側で組み立て直さない(二重管理を避けるため) |
| `buildCellStyle()` | マスの状態(given/pending/correct/incorrect + focused)からインラインstyle文字列を返す。確信度順モード(Issue #38)では、`state.cellProbs` にそのマスの確率があり(未判定・非フォーカス)、`α = 0.08 + 0.6 * p / pmax`(`pmax` は `cellProbs` の最大値)の `rgba(125, 211, 252, α)` を背景にする(ヒートマップ) |
| `escapeHtml(text)` | `innerHTML` に入れる前に `& < > " '` を実体参照にする |
| `fnv1a32(text)` / `puzzleId()` | 集計ビュー(SPEC F1 拡張2)の問題ID用の簡易ハッシュ。32bit FNV-1a を8桁16進で返す。`puzzleId()` は `GIVEN` の9行を結合した文字列をハッシュ化する |
| `loadRecords()` | `localStorage`(キー `scc.records.v1`)から読む。戻り値は `{ ok, records }`。`ok:false` は「読めなかった」(`localStorage` が無い、または `getItem` が例外)ときだけで、`records` は空のまま呼び出し側に「保存してよい空」だと誤解させない。保存が無い・JSON が壊れている・配列でない、はいずれも `ok:true, records:[]`(壊れていた場合は元の文字列を退避キー `scc.records.v1.broken` に逃がしてから空で作り直す)。**`ok` を見ずに `records` だけ使わないこと**(PR #25 レビュー指摘 should-fix 1) |
| `saveRecords(records)` | `records` を `localStorage` に書き込み、`recordsCache`(後述)も同時に同期する |
| `getRecords()` | `render()` / `exportRecords()` が読む窓口。モジュールスコープの `recordsCache`(初期値 `null`)が無ければ `loadRecords()` で読んで(`ok:true` のときだけ)キャッシュを作り、以後はキャッシュをそのまま返す。読み直しのコストを避けるための追加(PR #25 レビュー指摘 should-fix 2。以前は `render()` のたびに全件 `JSON.parse` していた) |
| `appendRecord(rec)` | 1件追記する。キャッシュが無ければ初回だけ `loadRecords()` を読むが、`ok:false`(読めなかった)なら **このレコードを黙って捨てて保存しない**(読めなかった状態を「空」と取り違えて上書きし、既存の記録を全消しにしないため。should-fix 1)。上限 `RECORDS_MAX`(既定 5,000。テストでは `ctx.RECORDS_MAX` を差し替えて境界だけ検証する)を超えたら古いものから捨てる |
| `binRecords(records, key)` | `records` を `key`(`"pc"` または `"conf"`)の値で10%刻み10帯に分ける純粋関数。帯は `Math.min(9, Math.floor(v * 10))`(`v=1.0` は最後の帯)。数値でない/有限でない値、および 0〜1 の範囲外の値は除外。戻り値は長さ10の配列 `{ lo, hi, n, correct, rate }`(`rate` は `n===0` なら `null`) |
| `renderCalibration()` / `renderCalibrationChart(bins, title)` / `setCalibModelFilter(v)` / `recordModelId(rec)` | 集計パネル(見出し「較正図」)。`getRecords()` を読み、`state.calibModelFilter` でモデル(`rec.m`。無ければ `typesafe/jev`)を絞り込んでから(記録に無いモデルは「すべて」扱い)、合計件数・全体正解率・記録している問題数(`p` のユニーク数)を出したあと、`binRecords` の結果(記録数と最終追記時刻が前回と同じなら再計算しない軽いキャッシュ付き)を `pc` / `conf` 各10帯のインラインSVGの棒グラフ(対角線は理想の較正線)として横並びで描く。件数0の帯は棒を描かない。件数>0だが正解率0%の帯は高さ1pxの台座を描き、件数0の帯と見分けられるようにする(should-fix 2 / nit)。色は CSS 変数(`--accent` / `--muted` / `--border`)をそのまま使う |
| `exportRecords()` | `getRecords()` の内容を `{ version:1, exported_at, records }` として `Blob` + `<a download>` でダウンロードさせる。ファイル名 `sudoku-calibration-YYYYMMDD-HHMMSS.json`(ローカル時刻) |
| `clearRecords()` | `confirm()` で確認したうえで `saveRecords([])` し、再描画する |
| `readUrlOptions()` / `applyUrlOptions(opts)` / `parseQueryString(search)` / `parsePuzzleString(str)` / `applyPuzzleFromString(str)` | URL パラメータ(Issue #46、SPEC F1')。`readUrlOptions()` は `location.search` を1回読んでパースするだけ(副作用なし)。`applyUrlOptions()` がそれを `state.modelMode` / `state.orderMode` / `state.speedMode` / `state.historyMode` / `state.ruleMode`(`history=0|1` / `rules=0|1`、Issue #61・#63)/ `embedMode` に反映し、`puzzle` があれば `applyPuzzleFromString()` に渡す。`applyPuzzleFromString()` は `newPuzzle()` の「盤面差し替え」部分(`GIVEN` / `SOLUTION` / `TOTAL_EMPTY` / `roundSize`)をジェネレーターの代わりに一意解チェック(`solveCount(rows, 2, solutions)`)だけで行う共通処理で、埋め込みモードの `message` の `newPuzzle` からも呼ぶ |
| `countCorrectValues()` | `state.values` で `status === "correct"` の件数。`renderStats()` と `postStatus()` の両方が使う(重複計算を避ける) |
| `postStatus()` | 埋め込みモード(`embedMode`)の `render()` のたびに呼ばれる。`window.parent === window`(iframe でない)なら何もしない。`{ type:"status", model, round, correct, total, remaining, running, paused, pauseReason, done, roundsToSolve, stoppedAtLimit, errorMessage, elapsedMs, costUsd }` を `window.parent.postMessage(payload, location.origin)` する(SPEC F1'、`pauseReason` は Issue #43、`elapsedMs`/`costUsd` は Issue #55・#56。`elapsedMs` は `currentTotalElapsedMs()`)。比較シェルの `compareStatusText()` はこれを見て `paused && pauseReason` なら「停止中(一時的な失敗)」を出し、`renderCompareStatusHtml()` が `elapsedMs`/`costUsd` をそのまま `formatMs()`/`formatUsd()` で見出しに表示する(親側では経過時間を計測し直さない) |
| `setupEmbedMessageListener()` | 埋め込みモードの起動時に1回呼ぶ。`window.addEventListener("message", ...)` で親からの操作を受け、`event.origin === location.origin` のときだけ `run()` / `stop()` / `reset()` / (`newPuzzle` なら `applyPuzzleFromString()` → `reset()`) / `setSpeed()` / `setOrderMode()` / `setHistoryMode()` / `setRuleMode()`(Issue #61・#63)を呼ぶ |
| `renderCompareShell()` / `compareRun()` / `compareStop()` / `compareReset()` / `compareNewPuzzle()` / `compareSetSpeed()` / `compareSetOrderMode()` / `compareSetHistoryMode()` / `compareSetRuleMode()` / `compareSetDifficulty()` / `updateCompareStatus()` / `setupCompareMessageListener()` | 比較シェル(`GET /compare`、Issue #46、8章)。`compareSetHistoryMode()` / `compareSetRuleMode()`(Issue #61・#63)は `compareSetOrderMode()` と同じロック条件(`compareEitherRunning() || compareEitherPaused()`)で `state.historyMode` / `state.ruleMode` を切り替え、両 iframe に `{ type: "setHistoryMode", on }` / `{ type: "setRuleMode", on }` を `postMessage` する。`renderCompareShell()` は `app.innerHTML` を**最初の1回だけ**組み立て(上部バー・2つの `<iframe class="compare-frame">`・各ステータス欄)、直後に `document.querySelectorAll(".compare-topbar" / ".compare-status" / ".compare-frame")` で要素を拾って `compareEls` / `compareFrames` に保持する。以後の更新(`compareRun()` 等)は `app.innerHTML` を触らず、`compareEls.topbar.innerHTML` / `compareEls.statusJev.innerHTML` / `compareEls.statusClaude.innerHTML` だけを差し替える(iframe の再読み込みを避けるため)。`comparePostToFrames(message)` が両 `iframe.contentWindow` に同じメッセージを `postMessage(message, location.origin)` する。`setupCompareMessageListener()` は子からの `status` メッセージ(`event.origin` と `event.source`(どちらの `contentWindow` か)を確認)を `updateCompareStatus()` に振り分ける。経過時間・コストの見出し(`renderCompareStatusHtml()`)は子が申告する `elapsedMs`/`costUsd` をそのまま使い、親側の計測(旧 `compareStartedAt` / `compareElapsedSeconds()`。Issue #55 で廃止)は持たない |

**計時・コスト(Issue #55・#56)の関数。**

| 関数 | 責務 |
|---|---|
| `nowMs()` | `Date.now()` を1か所にまとめただけの薄いラッパー。テストは `ctx.nowMs` を差し替えて確定値で検証する(4.1) |
| `markRoundStarted()` / `pauseClock()` / `closeRoundClock(keepRunning)` | 計時の遷移点(4.1 参照)。`markRoundStarted()` は周の最初のリクエスト送信直前、`pauseClock()` は `haltRun()` / `showError()`、`closeRoundClock()` は `finalizeRound()` が呼ぶ |
| `currentTotalElapsedMs()` / `currentRoundElapsedMs()` | 表示用の読み取り専用関数。`totalElapsedMs` / `roundElapsedMs` に、走っていれば(`runningSince !== null`)現在までの分を足して返す(状態は変えない) |
| `activeModelIdForPricing()` | 今の実行のモデル識別子(一括モードなら `currentModelId() + "/all"`)。`commitFocused()` の記録の `m` と同じ組み立て方を、コスト表示(単価未設定の注記の判定)でも使い回す |
| `formatThousands(n)` / `formatMs(ms)` / `formatUsd(x)` / `formatUsdForModel(x, modelId)` | 表示の書式(SPEC 5章)。`formatMs` は3桁区切り+`" ms"`(負値は0扱い)。`formatUsd` は `$0.01` 以上は小数4桁(末尾0を削る)、それ未満は有効数字2桁程度、0 は `$0`。`formatUsdForModel` は `isPricedModel()` が false なら「(単価未設定)」を足す |
| `formatRoundLogLine(entry)` / `formatTotalSummary()` / `formatLimitLogLine(entry)` / `countRoundLogEntries()` | 周回ログの1行・合計行(SPEC F1)。`entry` は `state.roundLog` の要素(`{ round, correct, total, ms, cost, m }`)。`formatRoundSummary()`(既存)の文字列に `— <ms> / <$>` を続ける。`formatLimitLogLine(entry)` は強制終了の専用行(`{ round, limit:true, wrong }`)を「N周で強制終了(最終周の不正解 M マス)」に整形する(Issue #60)。`countRoundLogEntries()` は `state.roundLog` のうち `entry.limit` が無いものだけを数え(強制終了の行は「周」ではない)、`formatTotalSummary()` の `(N周)` に使う |
| `defaultPrices()` / `isValidPriceEntry(v)` / `loadPrices()` / `savePrices(next)` / `getPrices()` / `setPrice(modelId, field, value)` / `resetPrices()` | 単価(SPEC 5章)。`defaultPrices()` は呼ぶたびに新しいオブジェクトを返す純関数。`getPrices()` は `getRecords()` と同じ「初回だけ `localStorage` を読み、以後はモジュールスコープの `pricesCache` を使う」キャッシュ方式。`setPrice()` は数値・非負のときだけ反映し、`localStorage`(`scc.prices.v1`)に保存してキャッシュも更新する |
| `priceModelKey(m)` / `isPricedModel(m)` / `costOf(rec)` | `priceModelKey()` は記録の `m` から `/all`・`+think` を外して単価テーブルのキーに正規化する。`costOf(rec)` は `rec.u` が無い、または単価が見つからないモデルなら 0 を返す純関数 |
| `toRecordUsage(usage)` / `combineRecordUsage(a, b)` | Jev/Claude の `usage`(`{ input_tokens, output_tokens, cache_read_input_tokens? }`)を記録の形(`{ i, o, ci? }`)に変換・合算する。`combineRecordUsage` は確信度順(マス選び+数字)で使う |
| `extractClaudeUsage(data)` | Claude(Anthropic Messages API)の応答から `usage` を取り出す。Worker の `extractUsage`(3.3)と同じ考え方で、欠けている・壊れていれば `undefined`(判定結果の検証には影響させない) |
| `renderUsagePanel()` | 「この実行の消費」パネル(SPEC F1、Issue #55・#56。オーナー追加要望 2026-09-23)。`renderPricesPanel()` のすぐ上に置く(埋め込みモードでは `renderStats()` の直前)。トークン(`totalTokensIn` / `totalTokensOut`)・コスト(`formatUsdForModel(totalCostUsd, activeModelIdForPricing())`)・速度(`formatTps(totalTokensIn + totalTokensOut, totalLatencyMs)`。**レビュー S1**: 分母に `currentTotalElapsedMs()` を使うと速度モード/順番モードの演出待ち(`SLOW_BEFORE_COMMIT_MS` 等)が混ざって数倍ぶれるため、API 呼び出しの待ち時間の合計 `totalLatencyMs` だけを使う。演出待ちを含まない旨を表示にも添える)の3行(速度の行は `state.speedMode === "fast"` のときだけ出す。オーナー追加要望 2026-09-23: 「じっくり確認」は意図的に待ち時間を挟むモードなので速度の実測値を見る意味が薄い)|
| `formatTps(tokens, elapsedMs)` | 平均トークン/秒。`tokens` が0以下・非有限、または `elapsedMs` が200未満・非有限なら "—"(値が暴れる・崩れた文字列になるのを防ぐ)。それ以外は `formatThousands(Math.round(tokens / (elapsedMs / 1000))) + " tok/s"` |
| `renderPricesPanel()` | 単価パネル(SPEC F1)。モデルごとの入力/出力単価の `<input type="number">` と「既定値に戻す」ボタン。Claude モードに限らず常時表示する |

### 4.3 状態遷移(1マス)

````text
idle ──run()──▶ focusNext()
                 │ token = runToken(この呼び出しの世代を捕まえる)
                 │ focusedKey=key, currentProbs=null, render()
                 ▼
              judgeCell()  ── 失敗(err.transient) ──▶ pauseForTransientError(err), paused
                 │           ── 失敗(それ以外)     ──▶ showError(), running=false, 停止
                 │ 成功
                 ▼
            currentProbs=probs, pendingCommit={...}, render()
                 │ (slow: 700ms)
                 ▼
            commitFocused(): values[key]=…, lastJudgment=…, focusedKey=null, render()
                 │ (slow:150ms / fast:20ms)
                 ▼
            queue 残あり → focusNext() / 空 → finalizeRound()

  (どの待ちの最中でも) ──stop()──▶ paused(pauseReason=null。手動停止)
                 │ runToken+=1, inflightController があれば abort()
                 │ running=false。values/round/roundLog/roundTally/roundSize/queue/started は保持
                 │ focusedKey があれば(未 commit)queue の先頭に戻し、pendingCommit を破棄
                 ▼
  paused ──run()──▶ focusNext()(started が true なので queue を作り直さず続きから。pauseReason=null)
````

**一時的な失敗による停止(`pauseForTransientError()`、Issue #43、SPEC F5)。** `judgeCell()`
(または `askCell()`。下記)が投げた `Error` に `err.transient=true` が付いているときは、
`showError()` の代わりにこちらへ分岐する。中身は `stop()` と同じ後始末(`runToken` を進めて
in-flight を abort、判定中のマスは `queue` の先頭に戻す)をしつつ、`state.errorMessage` を
立てず `state.pauseReason` に理由文言を持たせる点だけが違う(`isPaused()` は `stop()` と同じ
く true になり、盤面・周回ログ・`queue` も同じく保たれる)。「再開」(`run()`)を押すと
`pauseReason=null` に戻り、同じマス(`queue` の先頭に戻した、まだ確定していないマス)を
もう一度聞き直す。`err.transient` が付くのは Claude 経路の HTTP 429/529/5xx・ネットワーク
失敗(`judgeCellClaude` / `askCellClaude`)、Jev 経路(Worker)の HTTP 429(レート制限。
`err.retryAfter` に `Retry-After` ヘッダーの秒数も付く)/ 503(カウンタ障害。
`judgeCellJev` / `askCellJev`)。判定は確定していないので `appendRecord()` は呼ばない。

**確信度順モード(Issue #38)は `focusNext()` の先頭にマス選びが入る。** `state.orderMode
=== "confidence"` のときだけ、`focusNext()` は `queue` から直接取り出さず `selectNextCell()`
に委譲する:

````text
focusNext()(orderMode==="confidence"、queueに残あり)
                 │ token = runToken
                 ▼
            selectNextCell(token)
                 │ selecting=true, focusedKey=null, cellProbs=null, render()
                 ▼
              askCell()  ── 失敗(err.transient) ──▶ pauseForTransientError(err), paused(queueは変更しない)
                 │           ── 失敗(それ以外)     ──▶ showError(), 停止
                 │ 成功(result.cell が queue に無ければ showError)
                 ▼
      cellProbs=…, lastSelection=…, queue.splice(idx,1), selecting=false, render()
                 ▼
            focusCellForDigit(cell, token)  ── 以降は上の1マス判定と同じ

  (マス選び中に)──stop()──▶ selecting=false, cellProbs=null(queueは変更しない、pauseReason=null)
  paused ──run()──▶ focusNext() ── orderMode==="confidence" のマス選びからやり直す(pauseReason=null)
````

**一括モード(Issue #48)は周の最初の呼び出しだけ `fetch` が挟まる。** `state.orderMode
=== "all"` のときは `focusNext()` は `focusNextAll()` に委譲し、この周でまだ `askAll()`
していなければ(`allResults === null`)1回だけ呼んでから、以降は `queue` を1つずつ
キャッシュ(`allResults`)から確定する(`fetch` なし):

````text
focusNext()(orderMode==="all"、queueに残あり)
                 │ token = runToken
                 ▼
            focusNextAll(token)
                 │ allResults === null?
        ┌────yes─┴─no─────────────────┐
        ▼                             ▼
   askAllRound(token)          cell = queue.shift()
   │ allFetching=true, render()       │
   ▼                                  ▼
 askAll()  ── 失敗(transient) ──▶ pauseForTransientError(err), paused(queueは変更しない)
   │        ── 失敗(それ以外)   ──▶ showError(), 停止
   │ 成功
   ▼
 allResults=…("r0c2"→"r-c"に変換), allFetching=false
   │
   ▼
 focusNextAll(token) ── queue.shift() → focusCellFromCache(cell, token)
                                          │ focusCellForDigit と同じ
                                          │ フォーカス→バー→確定→次へ
                                          ▼ (judgeCell は呼ばない = fetch なし)
                                        focusNext()

  (askAllRound の呼び出し中に)──stop()──▶ allFetching=false(queueは変更しない、allResultsは保つ)
  (focusCellFromCache 確定待ち中に)──stop()──▶ 従来どおり queue の先頭に戻す(allResultsは保つ)
  paused ──run()──▶ focusNext() ── allResults があればキャッシュから続き、無ければ askAllRound() をやり直す
````

`allResults` は周が変わる(`finalizeRound()`)たびに `null` に戻すので、次の周は必ず改めて
1回 `askAll()` する。リセット/新しい問題/エラーでも `null` に戻す(`reset()` / `showError()`)。

**停止/再開(`stop()`、Issue #32、SPEC F1〜F3)。** `stop()` は `reset()` と同じく世代
(`runToken`)を進めて in-flight の `fetch` / 予約済みの `setTimeout` を無効化するが、
`reset()` と違って `state`(`values` / `round` / `roundLog` / `errorMessage` 以外の表示用
フィールド)と `queue` / `roundWrong` / `roundTally` / `roundSize` / `started` を **一切
初期化しない**。判定中(`state.focusedKey` があり、まだ `commitFocused()` されていない)
マスがあれば、その結果を破棄して記録(`appendRecord`)にも残さず `queue` の先頭に戻す
(再開したら同じマスをもう一度聞く。SPEC F2)。周をまたぐ待ち時間(`finalizeRound()` の
between-round の `setTimeout` 待ち)の最中に呼ばれた場合は、`finalizeRound()` が
そのタイマーを張る**前**に次の周の `round` / `queue` / `roundSize` / `roundTally` を
既に更新しているため、`stop()` の時点で `focusedKey` は `null` で何もすることがなく、
「実行」(= `run()`)で押すとそのまま次の周の先頭から再開する(SPEC F3)。`state.done` /
`state.errorMessage` のときは何もしない。両者は `finalizeRound()` / `showError()` で常に
`running=false` とセットで立つので、`stop()` は `state.running` を見るだけで判定できる
(`if (!state.running) return;`)。

**実行世代(`runToken`)のルール。** `reset()` と `showError()` と `stop()`(と、`stop()` と同じ
後始末をする `pauseForTransientError()`、Issue #43)は `runToken` を1つ進める。`focusNext()` / `finalizeRound()` は入口で `var token = runToken;` と世代を捕まえ、
その後の `then` / 失敗ハンドラ / `setTimeout` のコールバックは **すべて先頭で
`isCurrent(token)`(= `state.running && token === runToken`)を確認し、偽なら何もせずに
return する**。`stop()` は `state.running` を `false` にするので、`isCurrent()` は
`runToken` を進めるかどうかによらずこれだけで古い世代を弾ける。

`state` はオブジェクトごと差し替えられるが、飛んでいる `fetch` の Promise や予約済みの
`setTimeout` は生き続けてモジュール変数を読むため、`state.running` を見るだけでは足りない。
「リセット → すぐ実行」で古い連鎖が生き返ると、同じマスを二度判定して二重に課金され、
`roundTally` が `state.values` とずれ、`pendingCommit`(モジュール変数は1つしかない)が
上書きされて `queue` から取り出したマスがどこにも確定されないまま周が終わらなくなる。
世代トークンはこれを一箇所で断ち切るための仕組みなので、非同期のコールバックを足すときは
必ず同じガードを付ける。

**in-flight の abort(Issue #19、#32)。** `runToken` は「古い世代の結果を無視する」だけで、
Jev への問い合わせそのものは止めない。リセット/新しい問題(`newPuzzle()` は内部で
`reset()` を呼ぶ)/エラー/停止(`stop()`)では、`runToken` を進めるのと同じタイミングで
`inflightController.abort()` も呼び、in-flight の `/api/judge` を実際に打ち切る(無駄な
待ち時間とレート制限消費を防ぐ)。

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
- 停止中(`isPaused()`)は「現在の判定」パネルを「停止中(残り N マス)」(N は `queue.length`)
  に差し替える。フォーカスの枠線は `stop()` が `state.focusedKey` を `null` にするので
  `buildCellStyle` 側の既存ロジックで自然に消える(新しく分岐を足していない。Issue #32)。
  一時的な失敗による停止(Issue #43)は `state.pauseReason` があればその下に理由の箱
  (`class="pause-reason"`)を添える。手動停止(`stop()`、`pauseReason` が `null` のまま)
  では出ない。実行ボタン(`#run-btn`)は実行中は「停止」(`onclick="stop()"`)、停止中は
  「再開」(`onclick="run()"`、無効化しない。一時的な失敗の停止でも同じ)、それ以外
  (未実行・完了・エラー・生成中)は「実行」(完了・エラー・生成中は無効化)を出す
- 「モデルに送ったプロンプト」パネル(`renderPromptPanel`)は「現在の判定」パネルとは独立して
  `state.lastRequest`(と `lastRequestFailed`)だけを見る。停止中・エラー中でも直前の値をそのまま出し続け、
  `isPaused()` のような特別扱いはしない(消えるのは `reset()` / `newPuzzle()` のときだけ。
  Issue #34)。502 で失敗した判定の `request` は「(このプロンプトで失敗)」付きで表示し、
  `request` の無いエラー(400 など)や一時的な失敗による停止(429/503/529/5xx・ネットワーク
  失敗、Issue #43。`judgeCellClaude` の非 2xx を除き通常 `request` が無い)では直前の値が
  残る。`<pre>` は `white-space: pre-wrap` で長い `note` を折り返す(1 判定あたりレスポンスは
  約 1KB 増える。定数 `NOTE` が大半)
- **確信度順モード(Issue #38)** は `state.orderMode` だけで分岐し、`buildCellStyle` /
  `renderCurrentPanel` / `renderPromptPanel` / `renderLegend` / `renderControls` の既存の
  関数にロジックを足す形にしてある(専用のコンポーネントを新設しない)。ヒートマップは
  `state.cellProbs` が無ければ何もしない(= 左上からモードでは常に空)ので、モードで
  分岐しなくても自然に出ない。`state.orderMode` はモデルトグルと同じ `modelSettingsLocked()`
  でロックし、`localStorage` には保存しない(`speedMode` と違い、実行のたびに選び直す
  性質のものではなく、ページを開き直したときに毎回既定の「左上から」に戻ってよいと判断した)
- **一括モード(Issue #48)** も同じ考え方で `state.orderMode === "all"` の分岐を
  `renderCurrentPanel`(`state.allFetching` のときだけ「一括で判定中…(N マス)」を出す)・
  `renderPromptPanel`(`renderAllRequestBlock`)・`renderControls` / `renderCompareTopbarHtml`
  の順番トグルに足しただけで、専用のコンポーネントは新設していない。ヒートマップ
  (`state.cellProbs`)は一括モードでは一度も立たないので `buildCellStyle` に変更は無い。
  マス自体の確定(フォーカス→バー→確定→次へ)は `focusCellFromCache` が
  `focusCellForDigit` と同じ描画経路(`state.focusedKey` / `state.currentProbs` /
  `pendingCommit`)を使うので、`renderGrid` / `renderCurrentPanel` の本体側は
  モードを意識しない

## 5. データ

`GIVEN`(与えられた数字)と `SOLUTION`(正解表)は **再代入できる `var`** で、初期値は
Wikipedia の数独記事で使われている例題。「新しい問題」(4.2 `newPuzzle`)を押すと
`generatePuzzleWithRetry()` の結果で丸ごと差し替わり、`TOTAL_EMPTY` と `roundSize` も再計算される。
どちらもブラウザ用スクリプトの中にだけあり、Worker 側には無い(1 章・9 章 不変条件7)。

````javascript
var GIVEN = [ "53..7....", "6..195...", ".98....6.", "8...6...3", "4..8.3..1", "7...2...6", ".6....28.", "...419..5", "....8..79" ];
var SOLUTION = [ "534678912", "672195348", "198342567", "859761423", "426853791", "713924856", "961537284", "287419635", "345286179" ];
````

固定問題の空マスは51(ヒント数30)。初期表示は難易度に関係なく常にこの固定問題。

「新しい問題」で生成する目標ヒント数は `DIFFICULTY_GIVENS`(`state.difficulty` で選ぶ。SPEC F4'):

````javascript
var DIFFICULTY_GIVENS = { easy: 36, normal: 30, hard: 25 };
````

`generatePuzzle()` 単体は下限 `MIN_TARGET_GIVENS`(24)までしか削らない。「やさしい」「ふつう」はほぼ常に目標ちょうどに届くが、「むずかしい」(25)はランダムに消す順序の都合でちょうどに届かず26〜28で止まることがある(実測: 2000回中 25=84%・26=12.5%・27=3%・28=0.5%、`generatePuzzle` 単体呼び出し時)。`newPuzzle()` はこれを `generatePuzzleWithRetry()`(4.2)でランダム順を変えて最大 `GENERATE_RETRIES`(3)回まで再試行し、目標ちょうどに届いた結果があればそれを、3回とも届かなければ最もヒント数が少ない結果を採用する形で吸収する。`SOLUTION` は採点表示にだけ使う。

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

- `/api/judge` は認証なしだが、F6のレート制限(IP単位120回/時・全体500回/時。`wrangler.toml` の値)でコストの上限を確保している。値は `wrangler.toml` の `[vars]` で調整可能
- 上限を緩める(数値を大きくする、または `RATE_LIMITER` バインディングを外す)と、コストの上限が無くなる。特にバインディングを外すとフェイルオープンの設計上、制限なしで動いてしまう(カウンタが一時的に落ちた場合は 3.2 のとおりフェイルクローズで 503)。**理由なく緩めない**
- リポジトリには秘密情報を置かない。`account_id` も置かない
- `/api/judge` には CORS ヘッダーを付けない。加えて **`content-type` のメディアタイプが `application/json` でないリクエストは 415 で弾く**(`handleJudge` の最初、レート制限より前)。この2つはセットで意味を持つ: `application/json` の POST はブラウザで必ずプリフライトが必要になり、CORS ヘッダーを返していないのでプリフライトが通らず、他サイトのページからは呼べない。一方 `text/plain` などプリフライト不要の content-type はフォーム送信等でクロスサイトに投げられてしまうため、415 で入口を閉じる(第三者のサイトに埋め込まれて Workers AI のコストを消費される経路を塞ぐ)。`curl` 等からの直接アクセスはレート制限で頭打ちにする
- `GET /` `GET /compare` のレスポンスには `X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`Content-Security-Policy: frame-ancestors 'self'` を付ける(クリックジャッキング対策。インラインスクリプトを使うため、それ以上の CSP はかけない)。**`'self'`**(同一オリジンの iframe だけ許可)なのは、比較モード(`/compare`、Issue #46)が自分自身を `<iframe>` で2枚埋め込むため。他サイトの `<iframe>` に埋め込まれることは引き続き禁止(`'none'` のままだと比較モードが自分自身すら埋め込めなくなるので、そこだけを緩めた最小限の変更)
- 埋め込みモード(`embed=1`)・比較シェル(`GET /compare`)間の `postMessage` は、双方向とも受信側で **`event.origin === location.origin` を確認してから処理する**(7章の CORS/415 と同じ「同一オリジンだけ許可」の考え方を `postMessage` にも適用したもの)。比較シェルはさらに `event.source`(どちらの `iframe.contentWindow` から届いたか)で送信元を区別する。送信側も `postMessage(payload, location.origin)` と `targetOrigin` を明示的に指定し、`"*"`(任意オリジン)は使わない
- 3.3 の検証を通った盤面文字列だけが Jev に渡る(形式・対象マスが空であること・埋まっているマスが17個以上であることまで見る)
- Claude 経路(3.6)の API キーは利用者のブラウザの `localStorage` にだけあり、`x-api-key` ヘッダーで `api.anthropic.com` にだけ送る。Worker・リポジトリ・記録・エクスポート・プロンプト表示・DOM のどこにも出ない(テスト V2 / V4 で確認)。公開ページに他人のキーを入れる行為自体のリスク(端末の共有・XSS)は利用者の判断に委ね、画面にその旨を書く
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
| Claude はブラウザから直接呼ぶ(BYOK)。Worker で中継しない | Worker で中継するとオーナーのキーで公開デモを動かすことになりコストの青天井、かつレート制限をもう一段作る羽目になる。利用者自身のキーなら課金は利用者持ちで Worker はステートレスなまま(3.6)。SDK を使わないのはビルドステップが無いため |
| Claude の確率は structured outputs で自己申告させる | Claude には Jev のような確率出力が無い。JSON スキーマで `probabilities` を強制し、Jev と同じ形に揃えて以降の処理(バー・採点・記録・較正図)を共通化する。較正されている保証が無いことは実験の前提 |
| Cloudflare 公式のテストツールでなく `node:test` | 単一ファイルの Module Worker をモックの `env` で直接呼ぶだけなら Node 22 の標準機能で足りる。依存を増やさず、Cloudflare の認証なしで CI が回る |
| 比較モードは Jev/Claude を2インスタンス化せず、同じページを iframe で2枚並べる(Issue #46) | 判定ループの `state` / `queue` / 実行世代(`runToken`)はモジュールスコープの変数で、ページに1組しかない前提で書かれている(4.1・4.3)。これをモデルごとに2組持つよう書き直すと、`focusNext` / `finalizeRound` / `stop` などループ本体のほぼ全関数がどの組を触っているかを意識する必要が出て、既存の停止/再開・世代トークンの不変条件(4.3)を壊すリスクが大きい。iframe は「同じページをもう1つ、別のブラウジングコンテキストで動かす」だけなので、ページ側のロジックは一切変えずに済む。2枚が同一オリジンなので `localStorage`(記録・Claude のキー・設定)は共有される。ただし記録の追記は 2 ページが同じキーに同時に書くので、`appendRecord()` は追記のたびに読み直してから書く(キャッシュに足して丸ごと書き戻すと相手の書き込みを踏み潰す lost update になる。PR #49 レビュー M1)。これで較正図には両モデルの記録が(モデルフィルタで見分けがつく形で)溜まる |
| 比較シェルは `app.innerHTML` を最初の1回だけ組み立て、以後は sub要素だけを更新する | `render()` のように毎回 `innerHTML` を丸ごと作り直す方針(4.4)を比較シェルにもそのまま適用すると、ステータス表示(経過時間や周番号)が変わるたびに `<iframe>` タグ自体が新しい DOM ノードとして再生成され、**そのたびに iframe が再読み込みされて中の判定ループが最初からやり直しになる**。これでは比較にならないため、比較シェルだけは例外的に「初期構築(innerHTML 1回)+ 更新は対象 sub要素への直接代入」という、他の画面より一段 DOM 寄りの方針にしてある |

## 9. 変更時の不変条件

1. Jev に渡す `state`、および Claude に渡すリクエストボディに `SOLUTION` 由来の情報を入れない(`judgeCell()` が作る同じスナップショット。確信度順モードのマス選び(`askCell()`)も `buildSelectionSnapshot()` を使い、同じく `SOLUTION` を渡さない。Issue #38) **例外: `exclude`(Issue #61、オーナー判断済み)で「前の周でそのマスに入れて不正解だった数字」を criteria から外すことだけは許す(正誤判定は `SOLUTION` から来るが、渡すのは「外れた」という事実だけ)。正解そのもの・正解を一意に絞る目的の除外(正解から逆算して 8 個外す等)は送らない**。フロントはこの `exclude` を `wrongDigits`(履歴)と `ruleExclusions()`(数独のルールだけを使う計算。Issue #63)の和集合(`excludeFor()`)からしか作らない(正解から逆算した除外は絶対に作らない)
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
  - **`ask:"cell"`(Issue #38)**: `payload` が期待どおりのオブジェクトと完全に一致する(`state` に `target` が無い・`note` が `CELL_NOTE`・`criteria` のキーが空マスの一覧と行優先の順で一致・値の文言)。200 の形(`probabilities` / `choice` / `confidence` / `request` / `cell`)と `request` が `payload` そのものであること。400(`ask` が不正 / `target` 付き / 空マスなし / 埋まりが17個未満)、502(`answers.cell` が無い / `probabilities` のキーが criteria と一致しない / `choice` が criteria に無い)。レート制限が `ask` によらず1呼び出し=1カウントであること。**`ask` 省略時(`digit`)の挙動が文言も含めて従来どおりであること**
  - **`ask:"where"`(Issue #45)**: `payload` が期待どおりのオブジェクトと完全に一致する(`state` が `puzzle` / `digit` / `note` の3つだけ・`note` が `WHERE_NOTE`・質問キーが空マスの一覧と行優先の順で一致・各問が `type:"noul"` で `WHERE_INSTRUCTIONS_TEMPLATE` どおりの文言)。200 の形(`probabilities` / `digit` / `request` の3つだけで、`choice` / `confidence` / `cell` が付かない)と `request` が `payload` そのものであること。400(`target` 付き / `digit` の欠落・数値・`"0"` / `"10"` / 全部埋まった盤面 / 17個未満 / puzzle 形式)、502(`answers` が取り出せない / `state` が `"Completed"` でない / キーが質問と一致しない(余計・欠け・キー名違い)/ `noul` が有限の数値でない)。レート制限が1呼び出し=1カウントであること。不変条件1(`payload` の完全一致・未知キー非混入)。空マス1個の境界
  - **`ask:"all"`(Issue #48)**: `payload` が期待どおりのオブジェクトと完全に一致する(`state` が `puzzle` / `note` の2つだけで `target` も `digit` も無い・`note` が `ALL_NOTE`・質問キーが空マスの一覧と行優先の順で一致・各問が `type:"choice"` で `ALL_INSTRUCTIONS_TEMPLATE` どおりの文言と `digit` と同じ 1〜9 の criteria)。200 の形(`cells` / `request` の2つだけで、`cells` の各値が `{ choice, probabilities, confidence }`(`type` は落とす)、トップレベルに `choice` / `confidence` / `probabilities` / `cell` / `digit` が付かない)と `request` が `payload` そのものであること。400(`ask` が不正(文言も)/ `target` 付き / `digit` 付き / 全部埋まった盤面 / 17個未満 / puzzle 形式)、502(`answers` が取り出せない / `state` が `"Completed"` でない / キーが質問と一致しない(余計・欠け・キー名違い)/ あるマスの `probabilities` が8キー・`choice` が `"0"`・`confidence` が文字列・値が非数値・`probabilities` ごと無い・回答がオブジェクトでない。いずれも **どのマスで落ちたか** が文言に出ること)。ラッパー無しでも 200。レート制限が1呼び出し=1カウントであること。不変条件1(`payload` の完全一致・未知キー非混入)。空マス1個・64個(17個埋まり)の境界。**`digit` / `cell` / `where` の挙動が従来どおりであること**
  - **`exclude`(消去法。Issue #61)**: `ask:"digit"` で `criteria` が残りの数字(昇順)だけになること、空配列が省略と同じ payload になること、8個外して1つ残すのは可。応答の `probabilities` が残りのキーとちょうど一致しないと 502(9キー全部を返してきた・欠け・外した数字へのすり替え)、`choice` が外した数字なら 502。400(配列でない・`null`・数値や範囲外の要素・重複・9個全部。いずれも `AI.run` を呼ばない)。`ask:"all"` でマスごとの criteria(`exclude` のあるマスだけ残り、空配列のマスと他のマスは 1〜9)と応答検証がマスごとの残りキーで行われること(どのマスで落ちたかが文言に出る)、空オブジェクトは省略と同じ、400(オブジェクトでない・キーが埋まっているマス / 形式違い / 範囲外・値が不正)。`ask:"cell"` / `ask:"where"` に付いていたら(`null` / `[]` / `{}` でも)400。1呼び出し=1カウントのまま。不変条件1(`digit` / `all` の `exclude` 付き payload の完全一致と、`exclude` の文字列も正解表も payload に載らないこと)
  - **`usage`(Issue #56)**: 200(`digit` / `cell` / `where` / `all` すべて)に `usage: { input_tokens, output_tokens }` が付き、モックの実測値と一致すること。ラッパー無しの応答ではトップレベルの `usage` を読み、ラッパーがあるときはトップレベルの `usage` にフォールバックしないこと。`usage` が無い・オブジェクトでない・片方が非数値 / NaN / Infinity / 負値なら 200 のまま `usage` ごと省略されること。502 には付かないこと
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
    - vm のコンテキストで作った配列は host とは別レルムなので、`deepStrictEqual` の前に host 側の配列へ移し替える(`hostRows`)。オブジェクト(`DIFFICULTY_GIVENS` など)も同じ理由で `deepStrictEqual` はプロトタイプ違いで落ちるので、値だけを個別に比較する
  - **難易度(ヒント数)**(`test/page.test.js`、Issue #21)。ジェネレーター系と同じ `runScript` harness を使う
    - 難易度ごとの `generatePuzzle(DIFFICULTY_GIVENS[difficulty])` を各10回: 常に一意解、解が `solution` と一致、ヒント数がやさしい36/ふつう30は**ちょうど**、むずかしいは25〜28(下限24以上、5章の実測分布どおりジェネレーター単体では時々ちょうどに届かないことがある契約を検証する)
    - 難易度トグルの描画(`renderControls()`): 選択中のボタンだけに `active` クラスと `aria-pressed="true"` が付き、他は `aria-pressed="false"` であること。`setDifficulty("hard")` で `state.difficulty` が変わり、`reset()` 後も維持されること
    - `setDifficulty()` だけを呼んでも `GIVEN` は変わらない(次の `newPuzzle()` から効く)こと
    - `newPuzzle()` が `state.difficulty` に応じたヒント数で生成すること(`hard` で25〜28、`easy` で36ちょうど)
    - `newPuzzle()` の所要時間: `hard`(再試行が最も起きやすい)を10回で2秒以内であること(実測: 10回で200ms未満)
  - **周回ロジックの振る舞い: in-flight の abort**(`test/page.test.js` S1〜S4、Issue #19)。これまでの世代トークンの検査は正規表現によるソース検査だけだったが、`runScript` harness で `run()` / `reset()` / `newPuzzle()` を実際に走らせて振る舞いを検証する。`fetch` モックは resolve/reject を外側から制御できる「宙吊り」な `Promise` を返し、`init.signal` に `addEventListener("abort", ...)` を仕込んで `inflightController.abort()` を再現する(`makeAbortAwareFetch`)
    - S1: `run()` → 1件目の fetch を宙吊り → `reset()` → `run()` → 宙吊りを解決 → 全部流す。fetch 総数が51以下(abort により宙吊り分が再送されない)、commit 51、空マス0、`state.done === true` であること
    - S2: in-flight で `reset()` のみ。commit 0、`state.values` が空、`state.running === false`、記録(`getRecords()`)も増えないこと
    - S3: in-flight で `newPuzzle()`。古い結果が新しい盤面に commit されないこと
    - S4: `reset()` で fetch が `AbortError` で reject されても `showError` されない(エラーボックスが出ない)こと
    - 修正前(AbortController 導入前)のコードに当てると、S1〜S4 はいずれも「in-flight の fetch が abort されていない」で落ちることを確認済み
  - **停止/再開**(`test/page.test.js` T1〜T6、Issue #32)。`runScript` harness に `opts.setTimeout` を追加してある。既定(未指定)なら従来どおり `setImmediate` で即座に発火するが、渡すと `context.setTimeout` の実装そのものを差し替えられる(`context.setTimeoutCalls` に呼ばれた delay を常に記録する点は共通)。T3 だけは `makeManualTimers()`(`setTimeout` を配列に積むだけで自動発火しない、`fireNext()` で1つずつ明示的に発火させる)を渡し、「周の切り替え待ち中でタイマーが張られているが発火していない」状態を tick のポーリングに頼らず決定的に作る
    - T1: `run()` → 9マスを正解で確定させた後、10マス目の fetch が in-flight のときに `stop()`。fetch が増えない(pending の件数が変わらない)こと、`state.values` が9件、`state.running === false`、10マス目の fetch が abort(`settled`)されたこと、記録(`getRecords()`)が9件のまま増えないこと、`queue[0]` が10マス目の座標であること
    - T2: T1 と同じ地点(9マス確定・10マス目 in-flight)で `stop()` した後、`run()` で再開。10マス目から順に聞かれ、応答に使われた fetch の合計が51件、`state.done === true`、`state.values` と記録がそれぞれ51件であること
    - T3: `makeManualTimers()` で1周目(51マス、1マスだけ不正解になるスタブ)を手動発火のタイマーで最後まで進め、`finalizeRound()` が between-round のタイマーを張った直後(`state.round === 2`・`queue` が1周目の不正解マス・タイマーは1件積まれているが未発火)で `stop()`。`state.running === false` で `round` / `queue` はそのまま。次に `run()` で再開すると2周目の先頭(前の周の不正解マス)から聞き、正解を返すと `state.done === true` / `roundsToSolve === 2` になること。`stop()` 後も残っている古い between-round タイマーを実際に発火させても(`isCurrent()` に弾かれて)無害なことも確認する
    - T4: `stop()` の後に `reset()` すると、`started === false`・`state.values` が空・`state.round === 1`・`queue` が空・`roundLog` が空になる(最初から)こと
    - T5: in-flight 中に `stop()` した後、`setSpeed("fast")` してから `run()` で再開すると、再開後に発行される fetch が解決されたときの確定前の待ち時間(`setTimeout` の実引数、`context.setTimeoutCalls[0]`)が `FAST_BEFORE_COMMIT_MS`(0)になっていること(= 停止中の速度変更が再開後の待ち時間に反映される)
    - T6: `driveToCompletion` で `state.done === true` まで進めた後に `stop()` を呼んでも、`state.done` / `state.running` / `state.values` / `roundLog` / `queue` / `state.round` / `runToken` のいずれも変化しないこと(何もしない)
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
  - **確信度順モード**(`test/page.test.js` W1〜W7、Issue #38)。S/T 系と同じ `runScript` / `makeAbortAwareFetch` / `waitFor` を使う。`makeCellResponse(puzzle,keys,chosenKey)` / `makeClaudeCellResponse(keys,chosenKey)` を新設(Jev / Claude それぞれのマス選び応答のモック)
    - W1: `orderMode` の既定が `"scan"` で、左上からモードは1マス1フェッチ・`ask` を送らないこと(従来どおり)
    - W2: 確信度順の1ステップは2フェッチ。1つ目が `ask:"cell"`・`target` 無し・`puzzle` は `queue` の全マスが `.`。応答の `cell` にフォーカスが立ち、`queue` から取り除かれ、`state.cellProbs` / `state.lastSelection` が入ること。2つ目が選ばれたマスの `target` で、`commitFocused()` 後に `cellProbs` が消えること
    - W3: 応答の `cell` が `queue` に無ければ `showError` で停止し、`running=false` になること
    - W4: マス選び中の `stop()` は fetch を abort し `queue` の長さを変えないこと、`run()` で再開するとマス選びからやり直すこと。数字判定中の `stop()` は従来どおり `queue` の先頭に戻ること
    - W5: 2周目(1周目で1マス不正解になるスタブ)のマス選びの候補(`ask:"cell"` の `puzzle` の空マス)が不正解マスだけになること。周回ログの形式は従来どおり
    - W6: Claude 経路のマス選びのリクエストが `api.anthropic.com` へ行き、スキーマの `choice.enum` / `probabilities.required` が `selectionKeys()` と一致し、`system` が `CELL_NOTE` を含むこと(vm レルムの配列は `Array.prototype.slice.call` で host 側に移し替えてから比較する。hostRows と同じ理由)
    - W7: 確信度順でヒートマップの背景(`rgba(125, 211, 252`)がグリッドに出て、選択後にパネルへ「マス選び: N 候補中」が出ること。実行中は順番トグルが `disabled` になること
  - **一時的な失敗 → 停止**(`test/page.test.js` Y1〜Y8、Issue #43)。S/T/W 系と同じ `runScript` / `makeAbortAwareFetch` / `waitFor` を使う
    - Y1: Claude の 429 で `errorMessage` は立たず `isPaused()` が true、`pauseReason` に「429」を含むこと。`state.values` / `roundLog` / `queue` / 記録が保たれ、判定中だったマスが `queue` の先頭に戻ること。`run()` で `pauseReason` が消え、同じマスの `fetch` がもう一度飛ぶこと
    - Y2: Claude の 529 / 500 も停止扱い(`pauseReason` にステータスコードを含む)。401 / `refusal` / 形式不正が従来どおり `showError()` になることは V4 で確認済み(V4 のネットワーク失敗のケースも Issue #43 で停止扱いに変わったため、V4 内で `isPaused()` 待ちに更新した)
    - Y3: Jev の 429(`Retry-After: 30` ヘッダー付き)で `pauseReason` に「30」を含むこと。503 も停止扱い。400 / 502 は従来どおり `showError()`(`isPaused()` は false)であること
    - Y4: 確信度順のマス選び中(`state.selecting`)の Jev 429 も停止扱いで、`queue` の長さが変わらないこと。`run()` で再開するとマス選びからやり直すこと
    - Y5: `renderCurrentPanel()` が `isPaused() && state.pauseReason` のときだけ `class="pause-reason"` の箱を出し、手動 `stop()`(`pauseReason===null`)では出ないこと。`postStatus()` の payload に `pauseReason` が乗ること。`compareStatusText()` が `paused && pauseReason` のとき「停止中(一時的な失敗)」を返すこと
    - Y6: Jev の 429 で `Retry-After` が無い・空文字・HTTP 日付形式・`headers` 自体が無いとき、`pauseReason` に「秒後」が出ないこと(`markJevTransientError()` が正の有限値のときだけ `retryAfter` を付ける)
    - Y7: 確信度順で「マス選び成功 → 数字判定が 429」のとき、選ばれたマス(`queue.splice` 済み)が `queue` の先頭に戻り、盤面・記録は増えず、再開時の `ask:"cell"` で候補(`"."` とキー)に含まれること
    - Y8: Claude 経路のマス選び(`askCellClaude`)の 529 も停止扱いで、`queue` は変わらず `lastCellRequest` に送ったボディが残り、再開はマス選び(`CELL_NOTE` 入りの system)からやり直すこと
  - **比較モード**(`test/page.test.js` X1〜X4、Issue #46)。`runScript` の harness に `opts.location`(`{ pathname, search, origin }`、既定 `{ pathname:"/", search:"", origin:"https://example.com" }`)と `opts.window`(`{ parent, addEventListener, postMessage }`、既定は自分自身が `parent` の自己参照オブジェクト)を追加。`opts.document` は丸ごと差し替えられる(比較シェルの iframe / `querySelectorAll` を検査する X4 用)
    - X1: `puzzle=` で `GIVEN` / `SOLUTION` / `TOTAL_EMPTY` が差し替わること。矛盾した盤面(解0個)・形式不正(長さ81でない)はいずれも無視され、固定問題のままであること
    - X2: `model=claude&order=confidence&speed=fast` で初期 `state` が変わること。`localStorage`(`scc.claude_settings.v1`)には一切書き戻らないこと。既定(`location.pathname==="/"`、`search:""`)では従来どおり(`jev`/`scan`/`slow`)であること
    - X3: `embed=1` でコントロール・Claude設定・較正図・プロンプト枠・見出し(h1)が描かれず、グリッド・統計は描かれること。`message` の `run`/`stop`/`reset`/`newPuzzle` が同一オリジンのときだけ効き、他オリジンは無視されること。`render()` のたびに `status` が `window.parent.postMessage(payload, location.origin)` されること(第2引数が origin であることを含む)
    - X4: `/compare` で2つの `iframe.compare-frame`(`model=jev` / `model=claude`)と上部バーが描かれること。「実行」(`compareRun()`)で両 `iframe.contentWindow.postMessage` に `{type:"run"}` が飛ぶこと。子からの `status` メッセージ(`event.source` で送信元を判定)で該当する見出し(`compareEls.statusJev` / `statusClaude`)だけが更新され、他オリジンの `status` は無視されること
  - **一括モード**(`test/page.test.js` Z1〜Z8、Issue #48)。S/T/W/Y 系と同じ `runScript` / `makeAbortAwareFetch` / `waitFor` / `makeManualTimers` を使う。`makeAllResponse(ctx,puzzle,keys,wrongKeys)` を新設(Jev の `ask:"all"` 応答のモック。`wrongKeys` に挙げたキーだけ不正解の数字を返す。W5 の `makeCellResponse` と同じ考え方)
    - Z1: 一括の1周は `fetch` 1回で `ask:"all"`・`target`/`digit` 無し、盤面は `buildSelectionSnapshot()` と一致し `SOLUTION` の各行を含まないこと。正解のみの応答なら1回の呼び出しで1周が完了すること
    - Z2: 応答後に全マス(`TOTAL_EMPTY` 件)が順に確定し、記録が `TOTAL_EMPTY` 件・すべて `m: "typesafe/jev/all"` / `o: "all"` になること
    - Z3: 一括の呼び出し中(`askAllRound` の `fetch` 待ち)の `stop()` は in-flight を abort し `queue` の長さを変えず、`run()` で再開するともう一度 `fetch` すること。応答後、確定途中(`focusCellFromCache` の確定前の待ち)の `stop()` は queue の先頭に戻り、`run()` で再開しても `fetch` せずキャッシュ(`allResults`)から続いて完走すること(`makeManualTimers()` で確定前の待ちタイマーを制御して検証)
    - Z4: Jev の 429(`Retry-After` ヘッダー)は停止扱い(`pauseReason` に秒数を含む)。`queue` の長さは変わらず、`state.allFetching` は `false` に戻ること。`run()` で再開するともう一度 `ask:"all"` の `fetch` をすること
    - Z5: Claude 経路のスキーマ(`buildClaudeAllRequest` / `buildClaudeAllSchema`。候補キー(その周の `queue`)がそれぞれ `required` で、各値は digit 判定と同じ形)、`system` に `ALL_NOTE` の文言を含むこと、`max_tokens` の下限(思考なし16000・adaptive 24000・Haiku(budget 2048)12000。`buildClaudeAllRequest` を直接呼んで検証)、`target` を送らないこと。応答検証(`validateClaudeAllAnswer`)はキーが1つ欠けていればエラー、揃っていれば通ること。`run()` 経由でも(固定問題の51マスなのでチャンク分割される。Issue #74)キー欠けの応答がエラーで停止すること
    - Z6: 2周目の一括は不正解マスだけを候補にする(`buildSelectionSnapshot()` で空マスがその1マスだけになる)こと。周回ログの形式は従来どおり
    - Z7: URL `order=all` で `state.orderMode` が `"all"` になること、`setOrderMode("all")` が効き順番トグルに「一括」ボタン(`onclick="setOrderMode('all')"`)が出ること。比較シェル(`/compare`)の順番トグルにも「一括」があり、`compareSetOrderMode("all")` で `state.orderMode` が変わり `compareIframeSrc()` の組み立てに `order=all` が反映されること
    - Z8: Claude 経路の一括で全マスが確定し(固定問題の51マスなのでチャンク分割される)、記録の `m` が `claude-opus-5+think/all`・`o` が `"all"` になること、キーが DOM に出ないこと。Jev 経路で `cells` に対象マスが欠けた応答は、1 マスも確定・記録せず `queue` も減らさずにエラー停止すること(`askAllRound` がキャッシュに入れる前に queue の全キーを確かめる)
    - Z9(Issue #74): `chunkArray()` の境界(割り切れる・余りが出る・空・要素1個)、`combineClaudeUsage()` の合算(片方 `undefined`・`cache_read_input_tokens` の合算)。固定問題(51マス)なら `CLAUDE_ALL_CHUNK_SIZE`(既定10)で6チャンクになること。`run()` 経由でチャンクごとに異なる `usage` を返し、合算された値が周の先頭1件の記録にだけ付き(二重計上しない)、プロンプト枠に「(6回に分割。先頭の1回だけ表示)」の注記が出ること
  - **計時・コスト**(`test/page.test.js` AA1〜AA13、Issue #55・#56)。S/T/W/Y/Z 系と同じ `runScript` / `makeAbortAwareFetch` / `waitFor` を使う。`ctx.nowMs = function(){...}` で `Date.now()` を差し替え(`RECORDS_MAX` の上書きと同じパターン)、実時間を待たずに確定値で検証する。`blankCells(solved, cells)` を新設(`ANSWER_KEY` の指定セルだけを `"."` にした81文字の盤面を作り、`applyPuzzleFromString()` で空マス数の少ない盤面に差し替えて周を短く終わらせる)
    - AA1: 空マス2つの盤面で `run()` → 1マス目確定 → 2マス目 in-flight のまま `nowMs` を進めて `stop()`(この時点で `totalElapsedMs` / `roundElapsedMs` が期待どおりの値になること、`runningSince` が `null` になること)→ 停止中にさらに `nowMs` を進める(3600ms 相当)→ `run()` で再開(`runningSince` が再開時刻に付け替わること)→ 2マス目を確定して完了。`state.roundLog[0].ms` と `totalElapsedMs` が、停止中の分を除いた合計(400ms + 200ms = 600ms)になること、`roundElapsedMs` が完了後に0へ戻っていること
    - AA2: `formatMs` / `formatUsd` の書式(3桁区切り、`$0.01` 未満は有効数字2桁程度、負値・0の扱い)。`formatRoundLogLine(entry)` が「N周目: M中K正解 (P%) — 3,214 ms / $0.0004」、`formatTotalSummary()` が `state.roundLog.length` を使って「合計 12,345 ms / $0.0012(3周)」になること
    - AA3: (a) 左上から(Jev)は応答の `usage` がそのまま記録の `u` に載り、`t`(数値のレイテンシ)も付くこと。(b) 確信度順(Jev)はマス選び+数字それぞれに別の `usage` を返し、記録1件の `u` が合算(`i`/`o` それぞれの和)になること。(c) 一括(Jev、空マス2つ)は周の先頭の記録だけに `u`/`t` が付き、2件目には付かない(`undefined`)こと。vm レルムの違いにより `deepEqual` は使わず `.i`/`.o` を個別に比較する(hostRows と同じ理由)
    - AA4: `costOf(rec)` が Jev(出力無料)・`/all` と `+think` を剥がした Claude の単価(`priceModelKey`)・`ci`(入力単価の10%)・単価未設定モデル(0)・`u` の無い記録(0)を正しく計算すること(浮動小数点誤差を許容する `approxEqual` ヘルパーで比較)。`formatUsd` / `formatUsdForModel`(単価未設定に「(単価未設定)」を足す)の書式
    - AA5: `getPrices()` の既定値(`defaultPrices()` と一致)、`setPrice()` が正の数値だけ反映し `localStorage`(`scc.prices.v1`)に保存されること、負値・非数値・未知のモデル/フィールドは無視されること、`resetPrices()` で既定値に戻ること、壊れた `localStorage`(JSON でない・配列)や不正なエントリ(負値)が既定値にフォールバックすること
    - AA6: 埋め込みモード(`embed=1`)の `render()` が `postStatus()` で `elapsedMs` / `costUsd`(いずれも数値)を `window.parent.postMessage` すること。比較シェルの `renderCompareStatusHtml("jev")` が `compareStatus.jev.elapsedMs` / `.costUsd` を `formatMs()` / `formatUsd()` で見出しに表示すること(親側では計測し直さない)
    - AA7: #55 より前の記録(`at` が無く `t` がエポックミリ秒)を読み込むと `t` → `at` に付け替わり、新しい記録の `t`(レイテンシ)はそのままであること
    - AA8: 一括モードで周の先頭マスの確定待ち中に停止 → 再開しても、先頭の記録に `u`/`t` が付くこと(`pendingAllUsage` は `commitFocused()` で消費する)
    - AA9: 確信度順で数字判定の in-flight 中に停止 → 再開すると、届いていたマス選びぶんの `usage` が持ち越され、記録 1 件の `u` が「マス選び 2 回 + 数字 1 回」の和になること
    - AA10: 一時的な失敗(429)の停止でも計時が止まり `runningSince` が `null` になること、`reset()` で計時とコストが 0 に戻ること、周をまたぐ待ち時間は全体にだけ入り次の周の `ms` に入らないこと
    - AA11: `renderUsagePanel()` に累計トークン・コスト・TPS が出ること(オーナー追加要望 2026-09-23)、`reset()` でトークン累計も 0 に戻ること
    - AA12: `formatTps()` の境界(トークン0・負・非有限、経過200ms未満・非有限は "—"。それ以外は四捨五入した tok/s。200msちょうどの境界)
    - AA13: 一括モードで `totalTokensIn` / `totalTokensOut` / `totalLatencyMs` が周の先頭1件ぶんだけ積算されること(二重計上しない)
  - **消去法(履歴 Issue #61・ルール候補 Issue #63)と統計カード(Issue #60)**(`test/page.test.js` AB1〜AB14)。S/T/W/Y/Z/AA 系と同じ `runScript` / `makeAbortAwareFetch` / `waitFor` / `blankCells` を使う。多くは `ctx.judgeCellJev` / `ctx.askAll` / `ctx.buildClaudeRequest` / `ctx.buildClaudeAllRequest` / `ctx.parseClaudeDigitAnswer` / `ctx.validateClaudeAllAnswer` / `ctx.commitFocused` を直接呼び、`run()` を1周丸ごと走らせずに該当する関数の入出力だけを確かめる(`ruleExclusions` / `excludeFor` が `queue` の中身に関わらず決定的であるため、full round のシミュレーションより速く壊れにくい)
    - AB1: `ruleExclusions(r,c)` が固定問題の `r0c2`(行・列・ブロックの和集合 `["3","5","6","7","8","9"]`)と `r1c1` で、手で数えた期待値と一致すること
    - AB2: `excludeFor(0,2)` が1周目(`wrongDigits` が空)はルール由来だけ、`wrongDigits["0-2"]` をセットした2周目は履歴の数字が足されること。`judgeCellJev` に実際に渡してみて、`fetch` ボディの `exclude` がそれぞれ一致すること
    - AB3: `excludeMapForQueue()` / `askAll()` の `exclude` マップが、外す数字の無いマス(空配列)を省き、あるマスだけキーを持つこと(`fetch` ボディで確認)
    - AB4: 消去法の2トグルをともに「なし」にすると `excludeFor` が空配列になり、`judgeCellJev` / `askAll` の `fetch` ボディに `exclude` が付かない(従来どおりの payload の形)こと。Claude 経路の `buildClaudeRequest` もスキーマが1〜9のまま、`system` に `EXCLUDE_NOTE` が付かないこと
    - AB5: `buildClaudeRequest` / `buildClaudeAllRequest` のスキーマ(`choice.enum` / `probabilities` のキー)が `exclude` / `excludeByKey` の残りの数字だけになり、`system` に `EXCLUDE_NOTE` が付くこと。`parseClaudeDigitAnswer` / `validateClaudeAllAnswer` が、残りの数字だけの応答は通し、除外した数字を `choice` にした応答は「exclude後」を含む文言でエラーにすること
    - AB6: `commitFocused()` が積む記録に `n`(`probabilities` のキー数)・`e`(`state.historyMode`)・`rc`(`state.ruleMode`)が付くこと(候補を絞った判定・絞っていない判定の両方で確認)
    - AB7: `wrongDigits` が `reset()` / `newPuzzle()` で空になり、`stop()`(手動)では保たれること
    - AB8: URL パラメータ `history=0|1` / `rules=0|1`(不正値は無視、既定のまま)。比較シェル(`/compare`)の上部バーに `#history-toggle` / `#rules-toggle` があり、`compareSetHistoryMode()` / `compareSetRuleMode()` が `state` を切り替えて両 `iframe` に `{ type:"setHistoryMode"|"setRuleMode", on }` を `postMessage` すること
    - AB9: 消去法を切った1マスの盤面(`blankCells` + `MAX_ROUNDS` を2に差し替え)を常に不正解で答えさせ、2周で強制終了すること。統計カードに「この周の判定済み」「この周の正解」の2枚があり(旧ラベル「この周の進捗」が無い)、`state.roundLog` の末尾に `{ round:2, limit:true, wrong:1 }` が積まれ、周回ログに「2周で強制終了(最終周の不正解 1 マス)」の行が出ること
    - AB10: `buildDigitBars()` が `probabilities` に無いキーを `excluded:true` にし、`renderBars()` がそれを `class="bar excluded"` + 「×」で描くこと(除外していない数字は従来どおり%表示)
    - AB11〜AB14: PR #72 の Opus レビューが見つけた `ruleExclusions()` の正しさのバグ(M1。`settledKeys` 導入前は `state.values` を素通しで見ていたため、同じ周の中で先に(不正解のまま)確定した推測が他のマスの候補から正解を除外しうる状態だった)への回帰テスト。いずれも `git stash` で `settledKeys` 導入前のコードに戻すと落ちる(AB12・AB13 は無関係な経路なので戻しても通る)ことを確認済み
      - AB11: 同じ周の中で `r0c2` に(不正解の)推測を置いても、`ruleExclusions(0,3)` の結果が変わらないこと(`state.values` を直接いじる純粋関数テスト。`settledKeys` を更新していないので混ざらないことを確認)
      - AB12: 前の周に正解して確定したマス(`settledKeys` に追加)は、次の周の `ruleExclusions()` に正しく反映されること(`settledKeys` の伝播が壊れていないことを確認)
      - AB13: `excludeFor()` の防御(履歴とルールの和集合が9個になったら履歴側を捨ててルール側だけにする)が、`ruleExclusions` 側の結果はそのまま保つこと
      - AB14: `run()` を実際に走らせ、`r0c2` を(意図的に)不正解で確定させたあと、同じ周内に聞く `r0c3` への `fetch` ボディの `exclude` に `r0c3` の正解が混ざらないことを、モックした `fetch` 越しに確認する統合テスト(そのまま完了まで走らせて全体のループも壊れていないことも確認)
- E2E モック(`scripts/e2e/smoke.mjs`)の `/api/judge` 応答(`digit` / `cell` / `all` すべて)に固定の `usage`(`{ input_tokens, output_tokens }`)を足し、周回ログの1行目(`[2]` `[7]` `[9]` `[8]`)に `— <N,NNN> ms / $<...>` の形が出ることをチェックに追加した(Issue #55・#56)。`digit` / `all` は `body.exclude`(消去法。Issue #61・#63)を読み、残りの数字だけを `probabilities` / `choice` の候補にする(`remainingDigitsMock()`)。統計カードが5枚になった(Issue #60)ため `[1]` の `statValues` の件数・添字を更新した
- CI(`.github/workflows/ci.yml`)は push と PR で `npm ci` → `npm test` → `npm run check` を実行する。`check` は `wrangler deploy --dry-run` で、認証なしで動く
