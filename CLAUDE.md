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
- **Worker 側の** AI 呼び出しは `env.AI.run('typesafe/jev', {...})` のみ。Claude(Anthropic API)は **ブラウザから利用者自身のキーで直接呼ぶ**(BYOK、`docs/DESIGN.md` 3.6)。Worker でキーを中継しない・Worker から他のモデルや外部 API を呼ばない
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

- `RATE_LIMIT_PER_IP_MAX`(現在 `120`。コード側のフォールバックは `30`)/ `RATE_LIMIT_GLOBAL_MAX`(`500`)/ `RATE_LIMIT_WINDOW_SECONDS`(`3600`)
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

## 現在の状態(2026-09-22)

- v0.1 と SPEC 7 章の拡張 1・2・3・5(5 は最小版)まで **すべてマージ・デプロイ済み**。進捗は GitHub の Issues / PR を参照(`docs/HANDOFF.md` の「現在地」も併せて更新する)
- デプロイ済み: https://sudoku-calibration-check.takashi-kono-rb.workers.dev (2026-09-23 時点の Version は `66b9572b`。以後は `docs/HANDOFF.md` 6 章の最新の Version 記載を参照)。`npm run e2e -- --url <URL>` の本番モード(ヘッダー 3 つ + 最速で 3 判定)が PASS
- **Jev は 2026-09-21 に Worker 経由で実環境検証済み**(Issue #4)。レスポンスは AI Gateway のラッパー付き(`docs/DESIGN.md` 3.4)。`confidence` は `probabilities[choice]` と一致せず、同じ入力でも `choice` が揺れる
- レート制限のカウンタは Durable Object(`RATE_LIMITER` / `RateLimitCounter`)。`wrangler deploy` が `[[migrations]]` から作るので、ネームスペース作成のような手作業は不要(Issue #10 で Workers KV から移行。KV は結果整合で全体上限が分散アクセスに効かなかった)。`GET /api/status` で残数を読める(#18)
- マージ済み PR: #7(Worker 本体)、#9(Jev 実レスポンス形式 + KV id)、#11(#7/#9 のレビュー指摘)、#13(フロントエンド)、#14(DO レート制限)、#15(ジェネレーター/ソルバー)、#22(モデル方針)、#23(`/api/status`)、#24(E2E スモーク)、#25(集計ビュー)、#26(README)、#27(AbortController + 振る舞いテスト)、#28(難易度)、#33(停止/再開)、#35(Jev に送ったプロンプトの表示枠)、#39(Claude API、BYOK)、#40(`/api/judge` の `ask:"cell"`)、#41(確信度順モードのフロント)、#47(`ask:"where"`)、#49(比較モード)、#50(E2E の CSP 追随)、#51(一時的な失敗の停止扱い)、#52(`ask:"all"`)、#57(`usage`)、#58(一括モードのフロント)、#62(バナーを最上部へ)、#65(`exclude`)、#67(処理時間・コスト)
- 数独ジェネレーター/ソルバー(#5)と難易度トグル(#21、やさしい 36 / ふつう 30 / むずかしい 25 ヒント)。Worker 側の入力検証から固定問題(`GIVEN`)前提の項目は外れている(`docs/DESIGN.md` 3.3)
- 集計ビュー(信頼度較正図)(#6): 判定結果を `localStorage`(`scc.records.v1`)に蓄積し、`pc` / `conf` それぞれの帯ごとの正解率を較正図として表示。JSON エクスポート・記録の消去あり
- リセット/新しい問題/エラー時に in-flight の `/api/judge` を `AbortController` で中断する(#19)。周回ロジックの振る舞いテスト(S1〜S4)あり
- Playwright E2E スモーク(#17): `npm run e2e`(モック)/ `npm run e2e -- --url <URL>`(本番、最大 3 判定)。プロキシ環境では `E2E_PROXY` / `E2E_IGNORE_HTTPS_ERRORS=1`
- 実行中に「停止」で止め、「再開」で続きから動かせる(#32)。盤面・周回・ログは保持し、判定中だったマスは再開時にもう一度聞く。振る舞いテスト T1〜T6 あり
- Claude(Anthropic API)との比較(#37、SPEC 7 章 拡張 3): 「Jev / Claude」トグルと設定パネル(API キー・モデル・思考の有無)。ブラウザから `api.anthropic.com` を直接呼び(BYOK、Worker は関与しない)、structured outputs で `choice` / `probabilities` / `confidence` を自己申告させる。記録に `m`(モデル識別子)が付き、較正図をモデルで絞り込める。**実キーでの疎通はオーナーのブラウザで確認する**(セッションにキーは無い)
- 確信度順モード(#38、SPEC 3章 F1・F3): 「左上から / 確信度順 / 一括」の順番トグル。確信度順では周ごとに、まだ確定していないマス(`queue`)から Worker の `ask:"cell"`(Jev)/ 同種のスキーマ(Claude)で「最も確定しやすいマス」を選ばせてから、そのマスを従来どおり数字判定する(1マス = 2 API呼び出し)。マス選び直後はグリッドにヒートマップ(候補マスの確率を背景の濃さで表示)、現在の判定パネルに「マス選び: N候補中…」、プロンプト枠に「マス選び」「数字」2段を表示する。**1マス2回呼ぶぶん、IP単位のレート制限(120回/時)への到達が早まる**(1問51マス×平均3周で単純計算 約156回。1時間で完走できないことがあるので急ぐ場合は「左上から」を使う)。振る舞いテスト W1〜W7 あり
- 一括モード(#48、SPEC 3章 F1・F3): 「左上から / 確信度順 / 一括」の順番トグルに「一括」を追加。周ごとに1回だけ Worker の `ask:"all"`(Jev)/ 同種のスキーマ(Claude)を呼び、その周でまだ確定していないマス全部の `choice` をまとめて受け取る。応答はその周だけのキャッシュ(`allResults`)に置き、以降は「フォーカス→バー表示→確定→次へ」の流れを **fetch なしで** 1マスずつ回す(記録は従来どおり1マス1件)。周が変わる・リセット/新しい問題/エラーでキャッシュを空にし、停止/再開(手動・一時的な失敗とも)はキャッシュを保って再開時に再度呼ばない(呼び出し自体の最中に停止したときだけ呼び直す)。記録の `m` は `typesafe/jev/all`(Claude は `<既存のモデル識別子>/all`)、`o` は `"all"`。現在の判定パネルは呼び出し中「一括で判定中…(Nマス)」、プロンプト枠は「一括: 質問N問」の要約 + 折りたたみ。**1周1回なので回数は最少だが、1回の単価は `digit` の約14倍**(`docs/SPEC.md` 5章)。Claude 経路の `max_tokens` は思考なし16000・adaptive 24000・Haiku(budget 2048)12000を下限にする(既存設定との `Math.max`。実キーでの疎通は未検証、オーナーのブラウザで確認する必要あり)。振る舞いテスト Z1〜Z8・E2E [9] あり
- 既知の未実装: 消去法(#61 履歴・#63 ルール候補)のフロントと統計カードの分割(#60)は #55/#56 の後に 1 本の PR で(Worker 側の `exclude` は #65 で済み)。局所文脈(#64)はその後の実験。`ask:"where"` のフロントはオーナー判断で作らない(#45 は閉じた。Worker 側の API は残る)。SPEC 7 章の拡張 4(ログ異常検知への転用)は依頼があるまで着手しない。#36(盤面の表現の比較)は検討 Issue
- オーナー判断待ち 2 件: 確信度順とレート制限(#20)・実キー疎通(#44)。内容は `docs/HANDOFF.md` 6 章の「要オーナー判断」を参照(Claude 経路の 429/529 の扱い(#43)はオーナー判断済み・実装済みで解消)
- IP 単位のレート制限は 2026-09-22 にオーナー判断(Issue #20)で 30 → 120 回/時に緩和済み(1 問 ≈ 78 判定を 1 時間で完走できるように)。全体 500 回/時は据え置き
- `/api/judge` の `ask:"cell"`(#38 の Worker 側)。空マスの一覧を criteria にして「最も確定しやすいマス」を Jev に choice で聞く。`target` は取らず(付いていたら 400)、200 に `cell:{row,col}` を添える。`ask` 省略時は従来どおり
- `/api/judge` の `ask:"where"`(#45 の Worker 側、数字ごとモード)。`digit`("1"〜"9" の文字列)を受け取り、空マスごとの `noul` 質問を1回の `env.AI.run` にまとめて「その数字がどのマスに入るか」を聞く。`target` は取らず(付いていたら 400)、200 は `{probabilities, digit, request}` のみ(`choice` / `confidence` は noul に無い)。**フロント(UI)は別 PR**
- `/api/judge` の `ask:"all"`(#48 の Worker 側、一括モード)。空マスごとに `choice` の質問を1つ作り、1回の `env.AI.run` で「残りの全マスにそれぞれ入る数字」をまとめて聞く。`target` も `digit` も取らない(付いていたら 400)。200 は `{ cells: { "r0c2": { choice, probabilities, confidence }, … }, request }`(`type` は落とし、キーは行優先)。1 周 1 回で済むが 1 回の単価は `digit` の約14倍(`docs/SPEC.md` 5章)。**フロント(UI)** は上記「一括モード(#48)」の行を参照
- `/api/judge` の `exclude`(#61 の Worker 側、消去法)。`digit`(省略時)は外す数字の配列、`ask:"all"` はマスのキーごとの配列。criteria と応答検証(`probabilities` のキー・`choice`)を残りの数字だけにする。9 個全部・不正な要素・重複は 400、`cell` / `where` に付いていたら 400。送るのは外れた数字だけで正解は送らない(`docs/DESIGN.md` 9 章 不変条件 1 の例外)。**フロント(履歴の保持・トグル)は別 PR**
- Jev に送ったプロンプトの表示枠(#34)。`/api/judge` のレスポンス(200・502)に `request`(Worker が `env.AI.run` に渡した payload)を添え、フロントの「現在の判定」パネル直下に表示する。502 の分は「(このプロンプトで失敗)」付き。振る舞いテスト U1〜U5 あり
- 比較モード(#46、SPEC 3章 F1'): `GET /compare` が通常ページを iframe で2枚(Jev/Claude)並べ、上部バーから `postMessage` で同時に操作する。判定ループの `state`/`queue`/実行世代は2インスタンス化せず、通常ページ(`GET /`)側に `puzzle=` / `model=` / `order=` / `speed=` / `embed=1` の URL パラメータと埋め込みモードを追加して対応。CSP の `frame-ancestors` は `'none'` から `'self'` に変更。記録の追記は毎回 localStorage を読み直す(2 枚が同時に書いても失われない)。振る舞いテスト X1〜X4・E2E [8]
- 一時的な失敗は停止扱い(#43、SPEC F5、オーナー判断済み): Jev 経路(Worker)の 429(レート制限)/503(カウンタ障害)、Claude 経路の 429/529/5xx・ネットワーク失敗は、`errorMessage` を立てず `pauseForTransientError()` で「停止」(#32 と同じ後始末)にする。盤面・周回ログ・queue は保たれ、「停止中」の下に理由(`state.pauseReason`)が出て「再開」で続きから動く。それ以外(400/401/415/502/形式不正・キー未設定など)は従来どおりエラー停止(復帰はリセットのみ)。振る舞いテスト Y1〜Y8 あり。E2E モック `--mode ratelimit` の [4] もこの停止扱いを検証する形に更新済み
- 処理時間(#55)とコスト表示(#56)のフロント: 「現在の判定」パネルと周回ログに、周ごと/全体の走っている時間(ミリ秒。停止中は数えない)と累計コストを表示。記録に `u`(トークン使用量)・`t`(呼び出しのレイテンシ)が付き(一括モードは周の先頭1件だけ、確信度順はマス選び+数字の合算)、`costOf()` が単価(設定パネルの「単価」。既定値と `localStorage` の `scc.prices.v1`)から計算する。振る舞いテスト AA1〜AA13 あり。「単価」パネルとは別に「この実行の消費」パネル(累計トークン・コスト・平均 tok/s の実測値)を単価パネルの直上に表示する(オーナー要望 2026-09-23: 単価パネルは定義であって実消費が見えないという指摘への対応)
