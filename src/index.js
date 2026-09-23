/**
 * sudoku-calibration-check — Cloudflare Worker 本体
 *
 * GET  /           … フロントエンド一式(PAGE_HTML)
 * POST /api/judge  … 盤面と対象マスを受け取り、typesafe/jev に1マス分の確率を聞いて返す
 * GET  /api/status … レート制限の残り回数を読むだけ(カウンタは加算しない)
 *
 * 設計は docs/DESIGN.md 3章・6章・7章・10章に対応する。
 * 判定ループ・採点・周回はすべてブラウザ側にあり、この Worker はステートレス。
 */

// 盤面はブラウザ側で生成される(固定問題とは限らない)ので、Worker は特定の問題を持たない。
// 正解表も当然ここには置かない。ブラウザ用スクリプト(PAGE_HTML の中)にだけ定義し、
// 判定コードから構造的に隔離する(docs/DESIGN.md 9章 不変条件7)。

// 一意解を持つ数独の最小ヒント数(McGuire et al. 2012 で 17 と証明されている)。
// これ未満の盤面は数独として成立しないので受け付けない。
var MIN_FILLED_CELLS = 17;

var DIGITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];

// レート制限の既定値(wrangler.toml の [vars] が無い・読めないときだけ使う)
var DEFAULT_WINDOW_SECONDS = 3600;
var DEFAULT_PER_IP_MAX = 30;
var DEFAULT_GLOBAL_MAX = 500;

// レート制限カウンタの障害(フェイルクローズ)時に返す待ち時間(秒)
var COUNTER_FAILURE_RETRY_AFTER = 60;

// Durable Object の中で使うストレージキー。
// BUCKET_KEY には「今カウンタが生きているバケット番号」を入れ、古いバケットのキーを
// 次の呼び出しで消すために使う(生き残るカウンタのキーは常に1つ)。
var BUCKET_KEY = "bucket";
var COUNT_KEY_PREFIX = "count:";

// 502 の raw に入れるメッセージの最大長
var RAW_MAX_LENGTH = 200;

// Jev にルールを伝えるための固定文。何を聞かれているかを誤解させないための最低限の説明。
var NOTE =
  "puzzle is a 9x9 Sudoku grid given as 9 strings of 9 characters each, " +
  "top row first. A digit character is a cell that is already filled in; " +
  "'.' is an empty cell. target is the cell being asked about, as zero-based " +
  "row and col indices (row 0 is the first string, col 0 is its first character). " +
  "Standard Sudoku rules apply: every row, every column and every 3x3 box must " +
  "contain each of the digits 1 to 9 exactly once. Some of the digits already " +
  "placed may be wrong. Answer which digit belongs in the target cell.";

var INSTRUCTIONS = "Which digit from 1 to 9 belongs in the target cell of this Sudoku grid?";

// 質問の種類(リクエストの ask フィールド。docs/SPEC.md 4章 / Issue #38 / Issue #45)。
// "digit" … 従来どおり target のマスの数字(1〜9)を聞く
// "cell"  … target を取らず、空マスのうち「最も確定しやすいマス」を聞く
// "where" … target を取らず、指定された digit が各空マスに入るかを noul でまとめて聞く
// "all"   … target を取らず、空マスすべてについて「そのマスに入る数字」を choice でまとめて聞く
var ASK_DIGIT = "digit";
var ASK_CELL = "cell";
var ASK_WHERE = "where";
var ASK_ALL = "all";

// ask が未知の値だったときの 400 の文言(validateInput と handleJudge の保険で共用する)。
var ASK_ERROR = "askはdigit・cell・where・allのいずれかである必要があります";

// ask:"cell" 用の固定文。NOTE と同じくルールを伝えるための説明だが、target が無く、
// 代わりに空マスの一覧が criteria として与えられることを伝える。NOTE の文面は変えない。
var CELL_NOTE =
  "puzzle is a 9x9 Sudoku grid given as 9 strings of 9 characters each, " +
  "top row first. A digit character is a cell that is already filled in; " +
  "'.' is an empty cell. There is no target cell this time. Instead, the criteria " +
  "list every empty cell of the grid, keyed as 'r<row>c<col>' with zero-based row " +
  "and col indices (row 0 is the first string, col 0 is its first character). " +
  "Standard Sudoku rules apply: every row, every column and every 3x3 box must " +
  "contain each of the digits 1 to 9 exactly once. Some of the digits already " +
  "placed may be wrong. Answer which of those empty cells is the easiest to " +
  "determine, that is, the cell whose digit you can state with the most confidence.";

var CELL_INSTRUCTIONS =
  "Which empty cell of this Sudoku grid can be filled in with the most certainty? " +
  "Pick the cell whose digit you are most confident about.";

// ask:"where"(数字ごとモード。Issue #45)用の固定文。NOTE / CELL_NOTE と同じくルールを
// 伝えるための説明だが、target は無く、代わりに「聞いている数字」が digit として渡る。
// 質問は空マスごとに1つで、そのマスにその数字が入るかを noul で聞く。
// NOTE / CELL_NOTE の文面は変えない(ask:"digit" / ask:"cell" の挙動を1文字も変えないため)。
var WHERE_NOTE =
  "puzzle is a 9x9 Sudoku grid given as 9 strings of 9 characters each, " +
  "top row first. A digit character is a cell that is already filled in; " +
  "'.' is an empty cell. There is no target cell this time. digit is the digit " +
  "being asked about. Each question is about one empty cell of the grid, keyed as " +
  "'r<row>c<col>' with zero-based row and col indices (row 0 is the first string, " +
  "col 0 is its first character), and asks whether that cell contains digit. " +
  "Standard Sudoku rules apply: every row, every column and every 3x3 box must " +
  "contain each of the digits 1 to 9 exactly once. Some of the digits already " +
  "placed may be wrong.";

// ask:"where" の各質問の文言のテンプレート。{row} / {col} / {digit} を差し替えて使う。
// フロント(PAGE_HTML)が Claude 経路で同じ文言を組み立てられるよう、**テンプレートそのもの**
// を定数として持ち、Worker 側(whereInstructions)もこれ1つから組み立てる。
var WHERE_INSTRUCTIONS_TEMPLATE =
  "Is the digit {digit} the one that belongs in the empty cell at row {row}, column {col} (zero-based)?";

/** WHERE_INSTRUCTIONS_TEMPLATE に座標と数字を埋めて1問分の instructions を作る。 */
function whereInstructions(row, col, digit) {
  return WHERE_INSTRUCTIONS_TEMPLATE.replace("{row}", String(row))
    .replace("{col}", String(col))
    .replace("{digit}", String(digit));
}

// ask:"all"(一括モード。Issue #48)用の固定文。NOTE をベースに、target が無く、質問が
// 空マスごとに1つあることを伝える。NOTE / CELL_NOTE / WHERE_NOTE の文面は変えない
// (ask を省略したとき・cell / where の挙動を1文字も変えないため)。
var ALL_NOTE =
  "puzzle is a 9x9 Sudoku grid given as 9 strings of 9 characters each, " +
  "top row first. A digit character is a cell that is already filled in; " +
  "'.' is an empty cell. There is no target cell this time. Each question is about " +
  "one empty cell of the grid, keyed as 'r<row>c<col>' with zero-based row and col " +
  "indices (row 0 is the first string, col 0 is its first character), and asks which " +
  "digit belongs in that cell. " +
  "Standard Sudoku rules apply: every row, every column and every 3x3 box must " +
  "contain each of the digits 1 to 9 exactly once. Some of the digits already " +
  "placed may be wrong.";

// ask:"all" の各質問の文言のテンプレート。{row} / {col} を差し替えて使う。
// WHERE_INSTRUCTIONS_TEMPLATE と同じく、フロント(PAGE_HTML)の Claude 経路が同じ文言を
// 組み立てられるよう **テンプレートそのもの** を定数として持ち、Worker 側
// (allInstructions)もこれ1つから組み立てる。
var ALL_INSTRUCTIONS_TEMPLATE =
  "Which digit from 1 to 9 belongs in the empty cell at row {row}, column {col} (zero-based)?";

/** ALL_INSTRUCTIONS_TEMPLATE に座標を埋めて1問分の instructions を作る。 */
function allInstructions(row, col) {
  return ALL_INSTRUCTIONS_TEMPLATE.replace("{row}", String(row)).replace("{col}", String(col));
}

// 質問の種類ごとの 502 の理由(validateAnswer に渡す)。digit 側の文言は従来のまま。
var ANSWER_MESSAGES = {
  digit: {
    keys: "AIの応答のprobabilitiesが1〜9の9キーになっていません",
    values: "AIの応答のprobabilitiesに数値でない値が含まれています",
    choice: "AIの応答のchoiceが1〜9のいずれかではありません",
  },
  cell: {
    keys: "AIの応答のprobabilitiesが候補マスのキーと一致していません",
    values: "AIの応答のprobabilitiesに数値でない値が含まれています",
    choice: "AIの応答のchoiceが候補マスのいずれかではありません",
  },
  // where は noul なので choice も confidence も無い(answers そのものを検証する)。
  where: {
    keys: "AIの応答のanswersが質問したマスのキーと一致していません", // validateNoulAnswers 専用(choice は無い)
    values: "AIの応答のnoulに数値でない値が含まれています",
  },
  // all(Issue #48)は1回の応答に空マスの数だけ choice の回答が入る。キー集合の不一致は
  // 全体の話なので固定文、個々の回答の不備は **どのマスで落ちたか** が分かるよう
  // `cell` のテンプレート({key} を落ちたマスのキーに差し替える)を使う
  // (validateAllAnswers → allCellMessages)。
  all: {
    keys: "AIの応答のanswersが質問したマスのキーと一致していません",
    cell: {
      answer: "{key} の応答が予期しない形式です",
      missing: "{key} の応答にprobabilitiesがありません",
      keys: "{key} の応答のprobabilitiesが1〜9の9キーになっていません",
      values: "{key} の応答のprobabilitiesに数値でない値が含まれています",
      choice: "{key} の応答のchoiceが1〜9のいずれかではありません",
      confidence: "{key} の応答のconfidenceが数値ではありません",
    },
  },
};

function jsonResponse(body, status, extraHeaders) {
  var headers = { "content-type": "application/json; charset=utf-8" };
  if (extraHeaders) {
    for (var name in extraHeaders) headers[name] = extraHeaders[name];
  }
  return new Response(JSON.stringify(body), { status: status, headers: headers });
}

function errorResponse(message, status, extraHeaders) {
  return jsonResponse({ error: message }, status, extraHeaders);
}

/**
 * [vars] は文字列で渡ってくる。10進の整数として素直に読めて1以上のときだけ採用し、
 * それ以外(空文字・"0x10"・"1e3"・" 30 " のような紛らわしい表記)は既定値に落とす。
 * 上限が意図せず 0 や巨大な値になる事故を防ぐため、緩い数値変換はしない。
 */
function readLimit(value, fallback) {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return fallback;
  var parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return fallback;
  return parsed;
}

/**
 * Durable Object のストレージから読んだカウンタを正規化する。
 * 未設定(そのバケットの初回)は 0。0以上の安全な整数でない値(壊れている・
 * 改ざんされた)は上限そのものを返して「超過扱い」にする = フェイルクローズ。
 * 数えられないまま AI を呼ぶよりは止める。
 */
function normalizeCount(value, max) {
  if (value === undefined || value === null) return 0;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return max;
  return value;
}

function counterResponse(allowed, count) {
  return new Response(JSON.stringify({ allowed: allowed, count: count }), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/**
 * レート制限のカウンタ本体(docs/DESIGN.md 3.2)。固定ウィンドウのカウンタを
 * Durable Object 1インスタンスに閉じ込めて、厳密に数える。
 *
 * 以前は Workers KV に置いていたが、KV は結果整合で `get` がコロケーションごとに
 * 最大60秒キャッシュされるため、複数コロから同時に来たリクエストが古い値に +1 を
 * 上書きし合い(lost update)、全体上限が分散アクセスに対してほとんど効かなかった
 * (GitHub Issue #10。別コロで残数が 28 → 29 に戻る現象を実測)。Durable Object は
 * 同じ名前のインスタンスが世界に1つで、そこへのリクエストは直列に実行され、
 * `ctx.storage` の書き込みは暗黙のトランザクションになるので数え落としが起きない。
 *
 * インスタンスは `idFromName("global")`(全体用に1個)と `idFromName("ip:" + ip)`
 * (IPごとに1個)。
 *
 * RPC ではなく **fetch ハンドラ方式** にしてあるのは、`cloudflare:workers` の
 * `DurableObject` を継承しないため。RPC を使うには継承が必要だが、`cloudflare:workers`
 * は Node の `node:test` から import できず、テストが `src/index.js` をそのまま
 * import できなくなる(docs/DESIGN.md 10章)。
 *
 * リクエスト: POST `{ op: "peek" | "increment", bucket: <整数>, max: <上限> }`
 * レスポンス: `{ allowed: <真偽値>, count: <操作後のカウント> }`
 * - `peek`     … 読むだけ。`allowed` は `count < max`
 * - `increment`… `count >= max` なら加算せずに拒否、そうでなければ +1 して許可
 */
export class RateLimitCounter {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    var body = await request.json();
    var bucket = body.bucket;
    var max = body.max;
    var countKey = COUNT_KEY_PREFIX + bucket;

    // 別のウィンドウに入っていたら、前のバケットのカウンタを消してから数え直す。
    // 固定ウィンドウなので古い値を持ち越してはいけない(KV の TTL に相当する処理)。
    var storedBucket = await this.ctx.storage.get(BUCKET_KEY);
    var staleBucket =
      storedBucket !== undefined && storedBucket !== null && storedBucket !== bucket;
    if (staleBucket) {
      await this.ctx.storage.delete(COUNT_KEY_PREFIX + storedBucket);
    }

    var count = normalizeCount(await this.ctx.storage.get(countKey), max);

    if (body.op === "peek") return counterResponse(count < max, count);

    if (count >= max) return counterResponse(false, count);

    count = count + 1;
    await this.ctx.storage.put(countKey, count);
    if (storedBucket !== bucket) await this.ctx.storage.put(BUCKET_KEY, bucket);
    return counterResponse(true, count);
  }
}

/**
 * カウンタの Durable Object を1回呼ぶ。
 * 例外・非2xx・壊れた応答はすべて例外に揃えて、呼び出し側(checkRateLimit)の
 * catch = フェイルクローズに倒す。
 */
async function callCounter(limiter, name, op, bucket, max) {
  var stub = limiter.get(limiter.idFromName(name));
  var res = await stub.fetch(
    new Request("https://rate-limiter.invalid/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op: op, bucket: bucket, max: max }),
    })
  );
  if (!res || typeof res.status !== "number" || res.status < 200 || res.status > 299) {
    throw new Error("rate limit counter returned " + (res && res.status));
  }
  var data = await res.json();
  if (
    data === null ||
    typeof data !== "object" ||
    typeof data.allowed !== "boolean" ||
    !Number.isSafeInteger(data.count)
  ) {
    throw new Error("rate limit counter returned an unexpected body");
  }
  return data;
}

/**
 * 固定ウィンドウの現在位置。`bucket` は現在時刻をウィンドウ幅で割った商、
 * `resetsIn` は今のバケットが終わるまでの秒数(= 429 の `Retry-After`)。
 * `checkRateLimit` と `readRateLimitStatus` で同じ式を使うためのヘルパー。
 */
function currentWindow(windowSeconds) {
  var nowSeconds = Math.floor(Date.now() / 1000);
  var bucket = Math.floor(nowSeconds / windowSeconds);
  return { bucket: bucket, resetsIn: (bucket + 1) * windowSeconds - nowSeconds };
}

/**
 * Durable Object のインスタンス名に使う呼び出し元 IP。
 * CF-Connecting-IP はエッジが付けるので偽装はできないが、インスタンス名が際限なく
 * 長くならないよう念のため長さを抑える。
 */
function clientIp(request) {
  return (request.headers.get("CF-Connecting-IP") || "unknown").slice(0, 64);
}

/**
 * IP単位・全体の2段構えの固定ウィンドウ・レート制限(docs/DESIGN.md 3.2)。
 * `handleJudge` の先頭(415 の検査の後)で呼ぶ。
 *
 * 呼ぶ順番と理由:
 *   1. 全体を **peek**(読むだけ)。超過していれば `scope:"global"` で拒否し、
 *      IP 側のインスタンスには触らない(数える意味も書き込む意味も無い)
 *   2. IP を **increment**。超過していれば `scope:"ip"` で拒否(全体はまだ +1 しない)
 *   3. 全体を **increment**。1 の peek から時間が空いているので、際どい競合で
 *      `allowed:false` が返ることがある。そのときは `scope:"global"` で拒否する。
 *      IP 側は 2 で +1 したままにする —— 数え過ぎ(= 安全側)に倒し、
 *      数え漏れ(= コストの上限が外れる)を絶対に作らないため
 *
 * バインディングの有無と、カウンタの障害は区別する:
 * - `RATE_LIMITER` が無い          → フェイルオープン(制限なしで通す。ローカル開発の利便性)
 * - 呼び出しが例外/非2xx を返す    → フェイルクローズ(scope:"counter" で拒否。handleJudge が 503)
 */
async function checkRateLimit(request, env) {
  var limiter = env && env.RATE_LIMITER;
  if (!limiter) return { allowed: true, headers: {} };

  var windowSeconds = readLimit(env.RATE_LIMIT_WINDOW_SECONDS, DEFAULT_WINDOW_SECONDS);
  var perIpMax = readLimit(env.RATE_LIMIT_PER_IP_MAX, DEFAULT_PER_IP_MAX);
  var globalMax = readLimit(env.RATE_LIMIT_GLOBAL_MAX, DEFAULT_GLOBAL_MAX);

  var window = currentWindow(windowSeconds);
  var bucket = window.bucket;
  // 今のバケットが終わるまでの秒数
  var retryAfter = window.resetsIn;

  var ip = clientIp(request);

  function denyGlobal() {
    return {
      allowed: false,
      scope: "global",
      reason: "全体のレート制限(" + globalMax + "回/" + windowSeconds + "秒)を超えました",
      headers: {
        "Retry-After": String(retryAfter),
        "X-RateLimit-Scope": "global",
      },
    };
  }

  try {
    // 1. 全体を読むだけ。超過していれば IP 側のインスタンスには触らない。
    var globalPeek = await callCounter(limiter, "global", "peek", bucket, globalMax);
    if (!globalPeek.allowed) return denyGlobal();

    // 2. IP 単位を +1。
    var ipResult = await callCounter(limiter, "ip:" + ip, "increment", bucket, perIpMax);
    if (!ipResult.allowed) {
      return {
        allowed: false,
        scope: "ip",
        reason:
          "アクセス元(IP)ごとのレート制限(" + perIpMax + "回/" + windowSeconds + "秒)を超えました",
        headers: {
          "Retry-After": String(retryAfter),
          "X-RateLimit-Scope": "ip",
        },
      };
    }

    // 3. 全体を +1。1 の peek との隙間で埋まっていたら拒否する(IP 側は +1 のまま)。
    var globalResult = await callCounter(limiter, "global", "increment", bucket, globalMax);
    if (!globalResult.allowed) return denyGlobal();

    return {
      allowed: true,
      headers: {
        "X-RateLimit-Remaining-IP": String(Math.max(0, perIpMax - ipResult.count)),
        "X-RateLimit-Remaining-Global": String(Math.max(0, globalMax - globalResult.count)),
      },
    };
  } catch (err) {
    // バインディングはあるのにカウンタが使えない。回数を数えられないので通さない。
    console.error("rate limit counter error", err);
    return {
      allowed: false,
      scope: "counter",
      reason: "レート制限の記録に失敗しました。しばらくしてから再試行してください",
      headers: { "Retry-After": String(COUNTER_FAILURE_RETRY_AFTER) },
    };
  }
}

// /api/status のレスポンスに付けるヘッダー。残数は数秒で変わるのでキャッシュさせない。
// CORS ヘッダーは付けない(/api/judge と同じ方針。docs/DESIGN.md 7章)。
var STATUS_HEADERS = { "Cache-Control": "no-store" };

/** 上限と現在のカウントから `{ max, used, remaining }` を作る。 */
function usageOf(max, count) {
  return { max: max, used: count, remaining: Math.max(0, max - count) };
}

/**
 * GET /api/status(docs/SPEC.md 4章 / docs/DESIGN.md 3.1)。
 * レート制限の残り回数を **読むだけ** で返す。カウンタは `peek` でしか触らないので、
 * この呼び出し自体は回数に数えられない(状態を見るために残数を減らさない)。
 *
 * - `RATE_LIMITER` バインディングが無い → `{ rate_limit: "disabled" }`(フェイルオープン中)
 * - カウンタが例外/非2xx → 503。`checkRateLimit` のフェイルクローズと同じ `Retry-After: 60`
 */
async function readRateLimitStatus(request, env) {
  var limiter = env && env.RATE_LIMITER;
  if (!limiter) return jsonResponse({ rate_limit: "disabled" }, 200, STATUS_HEADERS);

  var windowSeconds = readLimit(env.RATE_LIMIT_WINDOW_SECONDS, DEFAULT_WINDOW_SECONDS);
  var perIpMax = readLimit(env.RATE_LIMIT_PER_IP_MAX, DEFAULT_PER_IP_MAX);
  var globalMax = readLimit(env.RATE_LIMIT_GLOBAL_MAX, DEFAULT_GLOBAL_MAX);

  var window = currentWindow(windowSeconds);
  var ip = clientIp(request);

  try {
    var globalPeek = await callCounter(limiter, "global", "peek", window.bucket, globalMax);
    var ipPeek = await callCounter(limiter, "ip:" + ip, "peek", window.bucket, perIpMax);
    return jsonResponse(
      {
        window_seconds: windowSeconds,
        resets_in: window.resetsIn,
        global: usageOf(globalMax, globalPeek.count),
        ip: usageOf(perIpMax, ipPeek.count),
      },
      200,
      STATUS_HEADERS
    );
  } catch (err) {
    console.error("rate limit status error", err);
    return errorResponse("レート制限の状態を取得できません", 503, {
      "Retry-After": String(COUNTER_FAILURE_RETRY_AFTER),
      "Cache-Control": "no-store",
    });
  }
}

var CELL_PATTERN = /^[1-9.]{9}$/;

/**
 * リクエストの ask(質問の種類)を読む。省略時は従来どおり "digit"。
 * 未知の値は null を返し、呼び出し側が 400 にする(docs/SPEC.md 4章 / Issue #38 / #45)。
 */
function readAsk(body) {
  if (body === null || typeof body !== "object") return null;
  if (body.ask === undefined) return ASK_DIGIT;
  if (
    body.ask === ASK_DIGIT ||
    body.ask === ASK_CELL ||
    body.ask === ASK_WHERE ||
    body.ask === ASK_ALL
  ) {
    return body.ask;
  }
  return null;
}

/**
 * 盤面の空マスを行優先の順で列挙する。
 * 戻り値は `{ key: "r0c2", row: 0, col: 2 }` の配列(ask:"cell" の criteria の元)。
 */
function emptyCells(puzzle) {
  var cells = [];
  for (var r = 0; r < 9; r++) {
    for (var c = 0; c < 9; c++) {
      if (puzzle[r][c] === ".") cells.push({ key: "r" + r + "c" + c, row: r, col: c });
    }
  }
  return cells;
}

/**
 * 入力検証(docs/DESIGN.md 3.3 手順3)。
 * 問題なければ null、不備があれば日本語の理由を返す。
 *
 * ask:"digit"(既定)/ ask:"cell" / ask:"where" / ask:"all" で見る項目が変わる。puzzle の
 * 形式・最小ヒント数は共通で、target は digit のとき必須・cell / where / all のとき禁止
 * (付いていたら 400。どちらのつもりのリクエストか曖昧にしないため)。cell / where / all は
 * 空マスが1個も無ければ聞くものが無いので 400。where はさらに digit("1"〜"9" の文字列)が
 * 必須で、逆に all は digit を取らない(付いていたら 400)。
 */
function validateInput(body, ask) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return "puzzle(9行の配列)とtarget({row,col})が必要です";
  }

  // ask は呼び出し元(handleJudge)が readAsk で 1 回だけ解釈して渡す(レビュー指摘 S1。
  // 2 か所で別々に解釈すると、検証順の変更で null が素通りする余地ができる)。
  if (ask !== ASK_DIGIT && ask !== ASK_CELL && ask !== ASK_WHERE && ask !== ASK_ALL) {
    return ASK_ERROR;
  }

  var puzzle = body.puzzle;
  var target = body.target;
  if (!Array.isArray(puzzle) || puzzle.length !== 9) {
    // cell / where では target を取らないので、文言でも target に触れない(S3)。
    // digit の文言は従来どおり。
    return ask === ASK_DIGIT
      ? "puzzle(9行の配列)とtarget({row,col})が必要です"
      : "puzzle(9行の配列)が必要です";
  }
  if (ask === ASK_DIGIT && (target === null || typeof target !== "object" || Array.isArray(target))) {
    return "puzzle(9行の配列)とtarget({row,col})が必要です";
  }
  if (ask === ASK_CELL && target !== undefined) {
    return "ask:cellではtargetを指定できません(盤面全体から選ぶため)";
  }
  if (ask === ASK_WHERE && target !== undefined) {
    return "ask:whereではtargetを指定できません(盤面全体に聞くため)";
  }
  if (ask === ASK_ALL && target !== undefined) {
    return "ask:allではtargetを指定できません(残りの全マスに聞くため)";
  }

  // where は「どの数字について聞くか」が必須。数値の 4 や範囲外("0" / "10")は受け付けない
  // (criteria ではなく質問文にそのまま埋め込むため、曖昧なまま Jev に送らない)。
  if (ask === ASK_WHERE && (typeof body.digit !== "string" || DIGITS.indexOf(body.digit) === -1)) {
    return "ask:whereではdigitに1〜9の文字列を指定してください";
  }

  // all は「空マス全部にそれぞれ数字を聞く」質問なので、特定の数字を指す digit は取らない
  // (where と取り違えたリクエストを黙って別の質問として飛ばさないため)。
  if (ask === ASK_ALL && body.digit !== undefined) {
    return "ask:allではdigitを指定できません";
  }

  for (var r = 0; r < 9; r++) {
    if (typeof puzzle[r] !== "string" || !CELL_PATTERN.test(puzzle[r])) {
      return "puzzleの各行は1〜9と.だけからなる9文字の文字列である必要があります";
    }
  }

  if (ask === ASK_DIGIT) {
    var row = target.row;
    var col = target.col;
    if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || row > 8 || col < 0 || col > 8) {
      return "target.rowとtarget.colは0〜8の整数である必要があります";
    }

    // 対象マスは必ず空。判定対象のマスに数字が入っていたら、そのマスは聞く必要がない。
    // 再判定のときも対象マス自身は空にして送る。前回の推測を Jev に見せない(アンカリング回避)。
    if (puzzle[row][col] !== ".") {
      return "puzzleのtargetのマスは.(空)である必要があります";
    }
  }

  // 埋まっているマスが少なすぎる盤面は数独として成立しない。
  // なお行・列・箱の矛盾は検証しない。不正解の推測を正誤問わず残して送る設計なので、
  // 矛盾した盤面が来るのは正常な状態(docs/DESIGN.md 3.3)。
  var filled = 0;
  for (var fr = 0; fr < 9; fr++) {
    for (var fc = 0; fc < 9; fc++) {
      if (puzzle[fr][fc] !== ".") filled++;
    }
  }
  if (filled < MIN_FILLED_CELLS) {
    return "puzzleの埋まっているマスが少なすぎます(" + MIN_FILLED_CELLS + "個以上必要です)";
  }

  // ask:"cell" / ask:"where" / ask:"all" は空マスについての質問なので、空マスが無ければ
  // 聞くものが無い。
  if ((ask === ASK_CELL || ask === ASK_WHERE || ask === ASK_ALL) && filled === 81) {
    return "puzzleに空(.)のマスがありません";
  }

  return null;
}

/**
 * Jev の回答が期待した形かを検証する(docs/DESIGN.md 3.3 手順6)。
 * 形が違うものをそのまま 200 で返すとフロントが黙って壊れるので、502 にして raw を見せる。
 * 問題なければ null、不備があれば日本語の理由を返す。
 *
 * `expectedKeys` は `probabilities` のキーと `choice` が取りうる値の集合
 * (ask:"digit" なら DIGITS、ask:"cell" なら criteria のキー配列)。`probabilities` は
 * この集合と **ちょうど一致**(個数と各キー)している必要がある。
 * `messages` は質問の種類ごとに文言が変わる 502 の理由(ANSWER_MESSAGES)。`keys` /
 * `values` / `choice` は必須。`answer` / `missing` / `confidence` は任意で、無ければ従来の
 * 固定文に落ちる(digit / cell の文言を1文字も変えないため。ask:"all" だけが
 * 「どのマスで落ちたか」を含む文言を渡す。Issue #48)。
 */
function validateAnswer(answer, expectedKeys, messages) {
  if (answer === null || typeof answer !== "object" || Array.isArray(answer)) {
    return messages.answer || "AIの応答が予期しない形式です";
  }

  var probabilities = answer.probabilities;
  if (
    probabilities === null ||
    typeof probabilities !== "object" ||
    Array.isArray(probabilities)
  ) {
    return messages.missing || "AIの応答にprobabilitiesがありません";
  }

  var keys = Object.keys(probabilities);
  if (keys.length !== expectedKeys.length) {
    return messages.keys;
  }
  for (var i = 0; i < expectedKeys.length; i++) {
    var expected = expectedKeys[i];
    if (!Object.prototype.hasOwnProperty.call(probabilities, expected)) {
      return messages.keys;
    }
    if (typeof probabilities[expected] !== "number" || !Number.isFinite(probabilities[expected])) {
      return messages.values;
    }
  }

  if (typeof answer.choice !== "string" || expectedKeys.indexOf(answer.choice) === -1) {
    return messages.choice;
  }

  if (typeof answer.confidence !== "number" || !Number.isFinite(answer.confidence)) {
    return messages.confidence || "AIの応答のconfidenceが数値ではありません";
  }

  return null;
}

/** マス単位の文言テンプレート(ANSWER_MESSAGES.all.cell)の {key} を、落ちたマスのキーに差し替える。 */
function allCellMessages(templates, key) {
  var messages = {};
  var names = Object.keys(templates);
  for (var i = 0; i < names.length; i++) {
    messages[names[i]] = templates[names[i]].replace("{key}", key);
  }
  return messages;
}

/** digit / all の質問に共通の criteria(1〜9)を criteria に詰める。 */
function fillDigitCriteria(criteria) {
  for (var i = 0; i < DIGITS.length; i++) {
    criteria[DIGITS[i]] = "the digit " + DIGITS[i];
  }
  return criteria;
}

/** answers のキー集合が expectedKeys とちょうど一致(個数と各キー)するか。ずれていれば message を返す。 */
function checkAnswerKeys(answers, expectedKeys, message) {
  if (Object.keys(answers).length !== expectedKeys.length) return message;
  for (var i = 0; i < expectedKeys.length; i++) {
    if (!Object.prototype.hasOwnProperty.call(answers, expectedKeys[i])) return message;
  }
  return null;
}

/**
 * ask:"all" の回答(空マスの数だけ choice の回答が並んだもの)を検証する(Issue #48)。
 * `answers` のキー集合が `expectedKeys`(空マスのキー)と **ちょうど一致**(個数と各キー)し、
 * 各回答が digit と同じ基準(`validateAnswer(answer, DIGITS, ...)`)を満たすこと。
 * 問題なければ null、不備があれば日本語の理由を返す。マス単位の不備は
 * 「どのマスで落ちたか」が分かる文言になる(ANSWER_MESSAGES.all)。
 */
function validateAllAnswers(answers, expectedKeys, messages) {
  var badKeys = checkAnswerKeys(answers, expectedKeys, messages.keys);
  if (badKeys !== null) return badKeys;
  for (var i = 0; i < expectedKeys.length; i++) {
    var expected = expectedKeys[i];
    var bad = validateAnswer(answers[expected], DIGITS, allCellMessages(messages.cell, expected));
    if (bad !== null) return bad;
  }
  return null;
}

/**
 * ask:"where" の回答(noul をマスの数だけ並べたもの)を検証する(Issue #45)。
 * `answers` のキー集合が `expectedKeys`(空マスのキー)と **ちょうど一致**(個数と各キー)し、
 * 各要素の `noul` が有限の数値であること。`type` は見ない(choice と同じく緩めに受ける)。
 * `choice` / `confidence` は noul の回答には無いので検証しない。
 * 問題なければ null、不備があれば日本語の理由(ANSWER_MESSAGES.where)を返す。
 */
function validateNoulAnswers(answers, expectedKeys, messages) {
  var badKeys = checkAnswerKeys(answers, expectedKeys, messages.keys);
  if (badKeys !== null) return badKeys;
  for (var i = 0; i < expectedKeys.length; i++) {
    var entry = answers[expectedKeys[i]];
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return messages.values;
    }
    if (typeof entry.noul !== "number" || !Number.isFinite(entry.noul)) {
      return messages.values;
    }
  }
  return null;
}

/**
 * Jev のレスポンスから `answers` オブジェクトそのものを取り出す(docs/DESIGN.md 3.4)。
 *
 * 実環境の `typesafe/jev` は AI Gateway 経由で提供されており、`env.AI.run` は
 * `{ state, result: { model, answers, usage }, gatewayMetadata }` というラッパーを返す。
 * 将来 Cloudflare が素の `{ model, answers, usage }` を返すようになっても動くよう、
 * `result.answers` を優先し、`result` がオブジェクトでなければトップレベルの
 * `answers` に落とす。
 *
 * 取り出せたら `{ answers }`、駄目なら `{ error }`(日本語の理由)を返す。
 * ask:"where"(Issue #45)は質問がマスの数だけあるので、1つの質問キーを取り出す
 * `extractAnswer` ではなくこちらを直接使う。
 */
function extractAnswers(response) {
  if (response === null || typeof response !== "object" || Array.isArray(response)) {
    return { error: "AIの応答が予期しない形式です" };
  }

  // ゲートウェイのラッパー(result 付き)で、完了以外の状態なら中身を見ずに止める。
  // ラッパーが無い素の応答は state を見ない(Jev のリクエスト側の最上位フィールド名も
  // state なので、将来それがエコーされても誤って 502 にしないため)。
  if (
    Object.prototype.hasOwnProperty.call(response, "result") &&
    response.state !== "Completed"
  ) {
    return { error: "AIの応答が完了していません" };
  }

  var inner = response.result;
  var container =
    inner !== null && typeof inner === "object" && !Array.isArray(inner) ? inner : response;

  var answers = container.answers;
  if (answers === null || typeof answers !== "object" || Array.isArray(answers)) {
    return { error: "AIの応答が予期しない形式です" };
  }

  return { answers: answers };
}

/**
 * `answers[key]`(key は "digit" または "cell")を取り出す。
 * 取り出せたら `{ answer }`、駄目なら `{ error }`(日本語の理由)を返す。
 */
function extractAnswer(response, key) {
  var extracted = extractAnswers(response);
  if (extracted.error !== undefined) return extracted;

  if (extracted.answers[key] === undefined) {
    return { error: "AIの応答が予期しない形式です" };
  }

  return { answer: extracted.answers[key] };
}

/**
 * Jev のレスポンスから `usage`(トークン使用量)を取り出す(コスト表示用。Issue「コスト
 * (ドル)を周ごと・全体で表示する」の Worker 側)。
 *
 * 取り出し元は `extractAnswers` と同じ場所: ラッパー付きなら `result.usage`、
 * 素の `{ model, answers, usage }` なら `usage`(docs/DESIGN.md 3.4)。
 *
 * 期待どおりの形でなければ `undefined` を返し、呼び出し側は 200 から `usage` ごと省略する。
 * `usage` はあくまで参考情報なので、欠けていても・壊れていても **判定結果の検証には
 * 影響させない**(502 にはしない)。片方のフィールドだけ数値、のような半端な形も
 * 単純に丸ごと省略する。
 * レート制限の使用率を返す usageOf() とは無関係(あちらは回数、こちらはトークン数)。
 */
function extractUsage(response) {
  if (response === null || typeof response !== "object" || Array.isArray(response)) {
    return undefined;
  }

  var inner = response.result;
  var container =
    inner !== null && typeof inner === "object" && !Array.isArray(inner) ? inner : response;

  var usage = container.usage;
  if (usage === null || typeof usage !== "object" || Array.isArray(usage)) return undefined;
  // 負値も「壊れている」扱いで丸ごと省略する(参考値なので有限かつ 0 以上だけ通す)
  if (typeof usage.input_tokens !== "number" || !Number.isFinite(usage.input_tokens) || usage.input_tokens < 0) {
    return undefined;
  }
  if (typeof usage.output_tokens !== "number" || !Number.isFinite(usage.output_tokens) || usage.output_tokens < 0) {
    return undefined;
  }

  return { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens };
}

function truncate(text) {
  return text.length > RAW_MAX_LENGTH ? text.slice(0, RAW_MAX_LENGTH) + "…" : text;
}

/**
 * 502 の raw に添える値。AI.run の戻り値は JSON 由来のはずだが、万一 JSON にできない値
 * (循環参照・BigInt など)が来ても 500 に化けないよう、文字列化にフォールバックする。
 */
function rawForResponse(value) {
  try {
    JSON.stringify(value);
    return value;
  } catch (err) {
    return truncate(String(value));
  }
}

/**
 * POST /api/judge(docs/DESIGN.md 3.3)。
 * 受け取った盤面だけを見て Jev に1マス分の確率を聞く。盤面も結果も保存しない。
 */
async function handleJudge(request, env) {
  // 0. content-type の検査。application/json 以外は 415。
  //    これがあるおかげで他サイトからの POST は CORS プリフライトを強いられ、
  //    CORS ヘッダーを返していない以上ブラウザに止められる(docs/DESIGN.md 7章)。
  //    メディアタイプ(";" の前)を取り出して完全一致で比べる。前方一致だと
  //    application/json-patch+json のような別のタイプまで通ってしまうため。
  var contentType = request.headers.get("content-type") || "";
  var mediaType = contentType.split(";")[0].trim().toLowerCase();
  if (mediaType !== "application/json") {
    return errorResponse("content-type は application/json である必要があります", 415);
  }

  var rate = await checkRateLimit(request, env);
  if (!rate.allowed) {
    if (rate.scope === "counter") {
      return errorResponse(rate.reason, 503, rate.headers);
    }
    return errorResponse(rate.reason, 429, rate.headers);
  }

  var body;
  try {
    body = await request.json();
  } catch (err) {
    return errorResponse("リクエストボディをJSONとして解釈できません", 400, rate.headers);
  }

  // ask(質問の種類)はここで 1 回だけ解釈し、検証にも payload 構築にも同じ値を使う。
  var ask = readAsk(body);
  var invalid = validateInput(body, ask);
  if (invalid !== null) {
    return errorResponse(invalid, 400, rate.headers);
  }

  // 質問の種類ごとに payload と「期待するキー集合」を組み立てる(Issue #38 / #45 / #48)。
  // どちらの経路でも Jev に渡すのは「今埋まっているマス」と質問文だけで、
  // 正解表に由来する情報は一切入れない(docs/DESIGN.md 9章 不変条件1)。
  var criteria = {};
  var expectedKeys = [];
  var payload;
  var cellsByKey = null;

  if (ask === ASK_ALL) {
    // 一括: 空マスごとに choice の質問を1つ作り、「そのマスに入る数字」を1回でまとめて
    // 聞く(Issue #48)。criteria は digit 経路と同じ 1〜9 で、質問ごとに同じオブジェクトを
    // 使い回す(`request` にそのまま載るので JSON にできる形のまま)。
    // target は渡さない(残りの全マスに聞く質問なので、対象マスが存在しない)。
    fillDigitCriteria(criteria);
    var allCells = emptyCells(body.puzzle);
    var allQuestions = {};
    for (var k = 0; k < allCells.length; k++) {
      var allCell = allCells[k];
      allQuestions[allCell.key] = {
        type: "choice",
        instructions: allInstructions(allCell.row, allCell.col),
        criteria: criteria,
      };
      expectedKeys.push(allCell.key);
    }
    payload = {
      state: {
        puzzle: body.puzzle,
        note: ALL_NOTE,
      },
      questions: allQuestions,
    };
  } else if (ask === ASK_WHERE) {
    // 数字ごと: 空マスごとに noul の質問を1つ作り、「このマスに digit が入るか」を
    // まとめて1回で聞く(Issue #45)。criteria は使わず、質問キーがマスのキーになる。
    // target は渡さない(盤面全体に聞く質問なので、対象マスが存在しない)。
    var whereCells = emptyCells(body.puzzle);
    var questions = {};
    for (var wi = 0; wi < whereCells.length; wi++) {
      var whereCell = whereCells[wi];
      questions[whereCell.key] = {
        type: "noul",
        instructions: whereInstructions(whereCell.row, whereCell.col, body.digit),
      };
      expectedKeys.push(whereCell.key);
    }
    payload = {
      state: {
        puzzle: body.puzzle,
        digit: body.digit,
        note: WHERE_NOTE,
      },
      questions: questions,
    };
  } else if (ask === ASK_CELL) {
    // マス選び: 空マスの一覧を criteria にして「どのマスが最も確定しやすいか」を聞く。
    // target は渡さない(盤面全体から選ばせる質問なので、対象マスが存在しない)。
    var cells = emptyCells(body.puzzle);
    cellsByKey = {};
    for (var ci = 0; ci < cells.length; ci++) {
      var cell = cells[ci];
      criteria[cell.key] = "row " + cell.row + ", column " + cell.col + " (zero-based)";
      expectedKeys.push(cell.key);
      cellsByKey[cell.key] = cell;
    }
    payload = {
      state: {
        puzzle: body.puzzle,
        note: CELL_NOTE,
      },
      questions: {
        cell: {
          type: "choice",
          instructions: CELL_INSTRUCTIONS,
          criteria: criteria,
        },
      },
    };
  } else if (ask === ASK_DIGIT) {
    fillDigitCriteria(criteria);
    for (var i = 0; i < DIGITS.length; i++) {
      expectedKeys.push(DIGITS[i]);
    }
    payload = {
      state: {
        puzzle: body.puzzle,
        target: { row: body.target.row, col: body.target.col },
        note: NOTE,
      },
      questions: {
        digit: {
          type: "choice",
          instructions: INSTRUCTIONS,
          criteria: criteria,
        },
      },
    };
  } else {
    // validateInput が弾いているので通常ここには来ない。来ても 500 にせず 400 で返す(S2)。
    return errorResponse(ASK_ERROR, 400, rate.headers);
  }

  var result;
  try {
    result = await env.AI.run("typesafe/jev", payload);
  } catch (err) {
    console.error("AI.run failed", err);
    return jsonResponse(
      {
        error: "AIの呼び出しに失敗しました",
        raw: truncate(String((err && err.message) || err)),
        // env.AI.run に渡したペイロードそのもの(Issue #34)。失敗時もフロントで
        // 「何を送って失敗したか」を確認できるように添える。
        request: payload,
      },
      502,
      rate.headers
    );
  }

  // where / all は質問が空マスの数だけあるので `answers` 全体を、digit / cell は
  // `answers[ask]` 1件を取り出して検証する。
  var answers = null;
  var answer = null;
  var badAnswer;
  if (ask === ASK_ALL) {
    var extractedAll = extractAnswers(result);
    if (extractedAll.error !== undefined) {
      badAnswer = extractedAll.error;
    } else {
      answers = extractedAll.answers;
      badAnswer = validateAllAnswers(answers, expectedKeys, ANSWER_MESSAGES[ask]);
    }
  } else if (ask === ASK_WHERE) {
    var extractedWhere = extractAnswers(result);
    if (extractedWhere.error !== undefined) {
      badAnswer = extractedWhere.error;
    } else {
      answers = extractedWhere.answers;
      badAnswer = validateNoulAnswers(answers, expectedKeys, ANSWER_MESSAGES[ask]);
    }
  } else {
    var extracted = extractAnswer(result, ask);
    if (extracted.error !== undefined) {
      badAnswer = extracted.error;
    } else {
      answer = extracted.answer;
      badAnswer = validateAnswer(answer, expectedKeys, ANSWER_MESSAGES[ask]);
    }
  }
  if (badAnswer !== null) {
    // AI.run が undefined を解決したとき、そのままだと raw のキーごと JSON から消える。
    // デバッグ用に「何が返ってきたか」を必ず残したいので null に寄せる。
    return jsonResponse(
      {
        error: badAnswer,
        raw: rawForResponse(result === undefined ? null : result),
        // env.AI.run に渡したペイロードそのもの(Issue #34)。
        request: payload,
      },
      502,
      rate.headers
    );
  }

  // Jev のトークン使用量。ask の種類によらず 200 にそのまま添える(コスト表示用)。
  // 取り出せなければ undefined で、その場合は 200 から usage ごと省略する。
  var usage = extractUsage(result);

  if (ask === ASK_ALL) {
    // マスごとに digit と同じ形({ choice, probabilities, confidence })を返す。
    // `type` は落とす(digit / cell の 200 でも返していないため)。キーは行優先。
    var cellsOut = {};
    for (var oi = 0; oi < expectedKeys.length; oi++) {
      var cellKey = expectedKeys[oi];
      var cellAnswer = answers[cellKey];
      cellsOut[cellKey] = {
        choice: cellAnswer.choice,
        probabilities: cellAnswer.probabilities,
        confidence: cellAnswer.confidence,
      };
    }
    var allBody = {
      cells: cellsOut,
      // env.AI.run に渡したペイロードそのもの(Issue #34)。
      request: payload,
    };
    if (usage !== undefined) allBody.usage = usage;
    return jsonResponse(allBody, 200, rate.headers);
  }

  if (ask === ASK_WHERE) {
    // noul には choice も confidence も無いので、マスごとの確率だけを返す(Issue #45)。
    var whereProbabilities = {};
    for (var ki = 0; ki < expectedKeys.length; ki++) {
      whereProbabilities[expectedKeys[ki]] = answers[expectedKeys[ki]].noul;
    }
    var whereBody = {
      probabilities: whereProbabilities,
      digit: body.digit,
      // env.AI.run に渡したペイロードそのもの(Issue #34)。
      request: payload,
    };
    if (usage !== undefined) whereBody.usage = usage;
    return jsonResponse(whereBody, 200, rate.headers);
  }

  var responseBody = {
    probabilities: answer.probabilities,
    choice: answer.choice,
    // Jev 独自の確信度。probabilities[choice] とは一致しない(docs/SPEC.md 4章)。
    confidence: answer.confidence,
    // env.AI.run に渡したペイロードそのもの(Issue #34)。フロントの「Jev に送った
    // プロンプト」パネルがそのまま表示する。別のオブジェクトを組み立て直さない。
    request: payload,
  };
  if (ask === ASK_CELL) {
    // choice("r0c2")を座標に分解して添える(フロントが毎回パースしなくて済むように)。
    var chosen = cellsByKey[answer.choice];
    responseBody.cell = { row: chosen.row, col: chosen.col };
  }
  if (usage !== undefined) responseBody.usage = usage;
  return jsonResponse(responseBody, 200, rate.headers);
}

// GET / と GET /compare に付けるセキュリティヘッダー(docs/DESIGN.md 7章)。
// CORS ヘッダーは付けない。CSP の frame-ancestors は 'self'(同一オリジンの
// iframe だけ許可)。比較モード(/compare、Issue #46)が同じページを iframe で
// 2枚並べて埋め込む(GET /?embed=1...)ため、'none' のままでは自分自身を
// 埋め込めない。他サイトからの埋め込みは 'self' のままなので引き続き不可。
var PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "frame-ancestors 'self'",
};

export default {
  async fetch(request, env) {
    var url = new URL(request.url);
    if (url.pathname === "/api/judge" && request.method === "POST") return handleJudge(request, env);
    if (url.pathname === "/api/status" && request.method === "GET") {
      return readRateLimitStatus(request, env);
    }
    // 比較モード(GET /compare、Issue #46)は通常ページと同じ PAGE_HTML を返す。
    // 差は「比較シェル」を描くかどうかだけで、フロント側が location.pathname を
    // 見て分岐する(docs/DESIGN.md 3.1 / 4章)。
    if ((url.pathname === "/" || url.pathname === "/compare") && request.method === "GET") {
      return new Response(PAGE_HTML, { headers: PAGE_HEADERS });
    }
    return new Response("Not found", { status: 404 });
  },
};

// ---------------------------------------------------------------------------
// ブラウザ用の一式。このテンプレートリテラルの中だけが正解表を知っている。
// テンプレート内で ${} を書く必要が出たら \${} とエスケープすること(実際には
// 使っていない。すべて文字列連結で組み立てる)。
//
// PAGE_HTML はこのファイルの最後の宣言のままにすること。閉じバッククォートが
// ファイル末尾にあることを前提に、不変条件7のテストが「テンプレートリテラルの外」を
// 機械的に切り出している(docs/DESIGN.md 3.5・10章)。この下には何も足さない。
//
// UI本体(グリッド・判定パネル・周回ロジック・速度モード)は Issue #3 で実装。
// 構成は docs/DESIGN.md 4章に対応する。
// ---------------------------------------------------------------------------
var PAGE_HTML = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>数独キャリブレーションチェック</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600&amp;family=IBM+Plex+Sans:wght@400;500;600;700&amp;display=swap" rel="stylesheet">
<style>
  :root {
    color-scheme: dark;
    --bg: #12141a;
    --panel-bg: #1a1d27;
    --panel-border: #262a36;
    --border: #2a2e3a;
    --thick-border: #545b70;
    --text: #e6e8ee;
    --muted: #9aa1b1;
    --accent: #7dd3fc;
    --correct: #4ade80;
    --correct-bg: rgba(74, 222, 128, 0.14);
    --incorrect: #f87171;
    --incorrect-bg: rgba(248, 113, 113, 0.14);
    --given: #ffffff;
    --error-bg: rgba(248, 113, 113, 0.12);
    --error-border: #f87171;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    background: var(--bg);
    color: var(--text);
    font-family: "IBM Plex Sans", "Helvetica Neue", Arial, sans-serif;
    padding: 24px 16px 48px;
  }
  #app { max-width: 960px; margin: 0 auto; }
  h1 { margin: 0 0 4px; font-size: 20px; font-weight: 600; letter-spacing: 0.02em; }
  .subtitle { margin: 0 0 8px; color: var(--muted); font-size: 13px; }
  .compare-link { margin: 0 0 20px; font-size: 12px; }
  .compare-link a, .subtitle a { color: var(--accent); }
  .layout { display: flex; flex-wrap: wrap; gap: 24px; align-items: flex-start; }
  .grid-panel { flex: 0 0 auto; }
  .side-panel { flex: 1 1 320px; min-width: 280px; display: flex; flex-direction: column; gap: 16px; }

  .grid {
    display: grid;
    grid-template-columns: repeat(9, 40px);
    grid-template-rows: repeat(9, 40px);
    width: max-content;
  }
  .cell {
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: "IBM Plex Mono", "Courier New", monospace;
    font-size: 18px;
  }

  .legend { display: flex; flex-wrap: wrap; gap: 14px; margin-top: 12px; font-size: 12px; color: var(--muted); }
  .legend-item { display: inline-flex; align-items: center; gap: 6px; }
  .swatch { width: 12px; height: 12px; border-radius: 3px; display: inline-block; }
  .swatch-correct { background: var(--correct-bg); box-shadow: inset 0 0 0 2px var(--correct); }
  .swatch-incorrect { background: var(--incorrect-bg); box-shadow: inset 0 0 0 2px var(--incorrect); }
  .swatch-focus { background: transparent; box-shadow: inset 0 0 0 2px var(--accent); }

  .panel {
    background: var(--panel-bg);
    border: 1px solid var(--panel-border);
    border-radius: 10px;
    padding: 14px 16px;
  }
  .panel-title { font-size: 12px; color: var(--muted); margin: 0 0 8px; text-transform: uppercase; letter-spacing: 0.05em; }

  .controls { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
  button {
    font-family: inherit;
    font-size: 13px;
    color: var(--text);
    background: var(--panel-bg);
    border: 1px solid var(--panel-border);
    border-radius: 6px;
    padding: 8px 14px;
    cursor: pointer;
  }
  button:hover:not(:disabled) { border-color: var(--accent); }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  #run-btn { background: var(--accent); color: #0b1220; border-color: var(--accent); font-weight: 600; }
  #speed-toggle, #difficulty-toggle, #model-toggle, #thinking-toggle, #order-toggle { display: inline-flex; border: 1px solid var(--panel-border); border-radius: 6px; overflow: hidden; }
  .speed-btn, .difficulty-btn, .model-btn, .thinking-btn, .order-btn { border: none; border-radius: 0; background: var(--panel-bg); }
  .speed-btn.active, .difficulty-btn.active, .model-btn.active, .thinking-btn.active, .order-btn.active { background: var(--accent); color: #0b1220; }
  .claude-row { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-bottom: 8px; }
  .claude-row label { font-size: 13px; color: var(--muted); }
  input[type="password"], select {
    font-family: inherit;
    font-size: 13px;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--panel-border);
    border-radius: 6px;
    padding: 7px 10px;
  }
  input[type="password"] { min-width: 220px; }
  select option { background: var(--panel-bg); color: var(--text); }
  .claude-notice { font-size: 12px; color: var(--incorrect); }
  #calib-model-filter { font-size: 12px; padding: 3px 6px; }

  #error-box.error {
    background: var(--error-bg);
    border: 1px solid var(--error-border);
    color: #ffd9d9;
    border-radius: 8px;
    padding: 10px 14px;
    margin: 12px 0;
    font-size: 13px;
  }

  /* 一時的な失敗による停止(Issue #43)の理由。「停止中」の下に添える */
  .pause-reason {
    background: var(--error-bg);
    color: var(--incorrect);
    border-radius: 6px;
    padding: 8px 10px;
    margin: 6px 0;
    font-size: 12px;
  }

  .stats { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; }
  .stat-card { background: var(--panel-bg); border: 1px solid var(--panel-border); border-radius: 8px; padding: 10px 12px; }
  .stat-label { font-size: 11px; color: var(--muted); margin-bottom: 4px; }
  .stat-value { font-size: 16px; font-weight: 600; font-family: "IBM Plex Mono", monospace; }

  .coords { font-size: 14px; margin-bottom: 10px; display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
  .confidence { font-size: 11px; color: var(--muted); }
  .bars { display: flex; flex-direction: column; gap: 6px; }
  .bar-row { display: grid; grid-template-columns: 16px 1fr 40px; align-items: center; gap: 8px; font-size: 12px; }
  .bar-label { font-family: "IBM Plex Mono", monospace; color: var(--muted); }
  .bar-track { background: var(--border); border-radius: 4px; height: 10px; overflow: hidden; }
  .bar-fill { height: 100%; border-radius: 4px; }
  .bar-pct { text-align: right; font-family: "IBM Plex Mono", monospace; color: var(--muted); }
  .muted { color: var(--muted); font-size: 13px; margin: 0; }
  .prompt-json {
    overflow: auto;
    max-height: 320px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-family: "IBM Plex Mono", "Courier New", monospace;
    font-size: 12px;
    color: var(--muted);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 10px 12px;
    margin: 0;
  }
  .prompt-details summary { color: var(--accent); font-size: 13px; cursor: pointer; margin: 4px 0; }
  .prompt-details[open] summary { margin-bottom: 8px; }

  #round-log ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; max-height: 220px; overflow-y: auto; }
  #round-log li { font-size: 12px; font-family: "IBM Plex Mono", monospace; color: var(--muted); }

  .banner { border-radius: 8px; padding: 12px 14px; font-size: 14px; font-weight: 600; margin-bottom: 14px; }
  .banner.success { background: var(--correct-bg); color: var(--correct); border: 1px solid var(--correct); }
  .banner.warning { background: var(--incorrect-bg); color: var(--incorrect); border: 1px solid var(--incorrect); }

  .calib-summary { font-size: 12px; color: var(--muted); margin: 0 0 12px; }
  .calib-charts { display: flex; flex-wrap: wrap; gap: 16px; }
  .calib-chart { flex: 1 1 220px; min-width: 260px; }
  .calib-chart-title { font-size: 11px; color: var(--muted); margin: 0 0 6px; text-align: center; }
  .calib-chart svg { width: 100%; height: auto; display: block; }
  .calib-actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 14px; }

  /* 比較モード(GET /compare、Issue #46) */
  .compare-topbar { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-bottom: 16px; }
  .compare-frames { display: flex; gap: 16px; flex-wrap: wrap; align-items: flex-start; }
  .compare-col { flex: 1 1 420px; min-width: 300px; }
  .compare-status { background: var(--panel-bg); border: 1px solid var(--panel-border); border-radius: 8px; padding: 10px 12px; margin-bottom: 8px; }
  .compare-status h2 { margin: 0 0 4px; font-size: 14px; font-family: "IBM Plex Mono", monospace; }
  .compare-meta { color: var(--muted); font-size: 12px; }
  .compare-notice { color: var(--incorrect); font-size: 12px; margin-top: 4px; }
  .compare-frame { width: 100%; height: 1100px; border: 1px solid var(--panel-border); border-radius: 10px; background: var(--panel-bg); }

  @media (max-width: 900px) {
    .compare-frames { flex-direction: column; }
    .compare-col { flex-basis: auto; width: 100%; }
  }

  @media (max-width: 640px) {
    .grid { grid-template-columns: repeat(9, 32px); grid-template-rows: repeat(9, 32px); }
    .cell { font-size: 15px; }
    .stats { grid-template-columns: 1fr 1fr; }
  }
</style>
</head>
<body>
<div id="app"></div>
<script>
  // -------------------------------------------------------------------
  // 純粋なロジック(テストから抽出しやすいよう、状態やDOM操作より先に置く)
  // -------------------------------------------------------------------

  // GIVEN + state.values(正誤問わず)から9行のスナップショットを作る。
  // 判定対象のマス(state.focusedKey)だけは "." にして送る(アンカリング回避。
  // docs/DESIGN.md 4.2 / SPEC F3)。
  function buildSnapshot() {
    var targetKey = state.focusedKey;
    var rows = [];
    for (var r = 0; r < 9; r++) {
      var line = "";
      for (var c = 0; c < 9; c++) {
        var key = r + "-" + c;
        if (key === targetKey) {
          line += ".";
          continue;
        }
        var given = GIVEN[r][c];
        if (given !== ".") {
          line += given;
          continue;
        }
        var cell = state.values[key];
        line += cell ? cell.value : ".";
      }
      rows.push(line);
    }
    return rows;
  }

  // 確信度順モード(Issue #38)のマス選びに送るスナップショット。buildSnapshot() と
  // 同じ組み立て方だが、state.focusedKey ではなく queue に入っている全マスを "." にする。
  // こうすると Worker(/api/judge の ask:"cell")が列挙する「空マス」が、この周でまだ
  // 確定していないマスとちょうど一致する(2周目以降は前の周の不正解の推測が残っているので、
  // これを消さないと候補として挙がらない。SPEC F3)。
  function buildSelectionSnapshot() {
    var emptySet = {};
    for (var qi = 0; qi < queue.length; qi++) {
      emptySet[queue[qi].r + "-" + queue[qi].c] = true;
    }
    var rows = [];
    for (var r = 0; r < 9; r++) {
      var line = "";
      for (var c = 0; c < 9; c++) {
        var key = r + "-" + c;
        if (emptySet[key]) {
          line += ".";
          continue;
        }
        var given = GIVEN[r][c];
        if (given !== ".") {
          line += given;
          continue;
        }
        var cell = state.values[key];
        line += cell ? cell.value : ".";
      }
      rows.push(line);
    }
    return rows;
  }

  // queue のマスを "r<row>c<col>" にしたもの、行優先の順(Issue #38)。Claude 経路の
  // マス選びのスキーマ(choice の enum / probabilities の required)に使う。Jev 経路は
  // Worker 側(emptyCells)が puzzle から同じ集合を同じ順序で作るので、フロントでは
  // 使わない(request の criteria をそのまま信じる)。
  function selectionKeys() {
    var cells = queue.slice().sort(function (a, b) {
      return a.r - b.r || a.c - b.c;
    });
    return cells.map(function (cell) {
      return "r" + cell.r + "c" + cell.c;
    });
  }

  // 周回ログの1行(「N周目: M中K正解 (P%)」)を組み立てる純粋関数。
  function formatRoundSummary(round, correct, total) {
    var pct = total === 0 ? 0 : Math.round((correct / total) * 100);
    return round + "周目: " + total + "中" + correct + "正解 (" + pct + "%)";
  }

  // この周で不正解だったマスから次の周の queue を作る純粋関数(SPEC F3)。
  // 元の配列は共有せず、必ず新しい配列・新しい要素を返す。
  function nextQueue(roundWrong) {
    return roundWrong.map(function (cell) {
      return { r: cell.r, c: cell.c };
    });
  }

  // 周の終わりにどうするかを決める純粋関数(SPEC F3)。
  // "solved"(不正解0で完了)/ "limit"(15周の安全弁)/ "continue"(次の周へ)。
  // MAX_ROUNDS は自由変数(テストからはクロージャで注入する)。
  function shouldStop(round, incorrectCount) {
    if (incorrectCount === 0) return "solved";
    if (round >= MAX_ROUNDS) return "limit";
    return "continue";
  }

  // 集計ビュー(SPEC F1 拡張2、docs/DESIGN.md 4.2)。records を key("pc" | "conf")の
  // 値で10%刻み10帯に振り分け、帯ごとの件数・正解数・正解率を返す純粋関数。
  // 値 v の帯は Math.min(9, Math.floor(v * 10))(1.0 は最後の帯に入る)。
  // 数値でない・NaN・有限でない値は除外する。
  function binRecords(records, key) {
    var bins = [];
    for (var i = 0; i < 10; i++) {
      bins.push({ lo: i / 10, hi: (i + 1) / 10, n: 0, correct: 0, rate: null });
    }
    var list = Array.isArray(records) ? records : [];
    for (var j = 0; j < list.length; j++) {
      var rec = list[j];
      var v = rec ? rec[key] : undefined;
      if (typeof v !== "number" || !isFinite(v)) continue;
      if (v < 0 || v > 1) continue; // 確率の範囲外(0〜1)は帯に押し込めず除外する
      var idx = Math.min(9, Math.floor(v * 10));
      bins[idx].n += 1;
      if (rec.ok) bins[idx].correct += 1;
    }
    for (var b = 0; b < 10; b++) {
      bins[b].rate = bins[b].n === 0 ? null : bins[b].correct / bins[b].n;
    }
    return bins;
  }

  // 実行世代のチェック。reset() / showError() / stop() で runToken が進むので、
  // 古い世代の fetch / setTimeout のコールバックはここで弾かれる(DESIGN 4.3)。
  function isCurrent(token) {
    return state.running && token === runToken;
  }

  // 停止中(started 後に stop() で running=false になり、done でも errorMessage
  // でもない)かどうか。renderControls() の「再開」ラベルと renderCurrentPanel() の
  // 「停止中」表示で使う(SPEC F1、Issue #32)。
  function isPaused() {
    return started && !state.running && !state.done && !state.errorMessage;
  }

  // 32bit FNV-1a。集計ビュー(SPEC F1 拡張2)の問題IDに使う簡易ハッシュ。
  // 衝突を厳密に避ける必要はない(あくまで「同じ問題をまとめる」ための目印)。
  function fnv1a32(text) {
    var hash = 0x811c9dc5;
    for (var i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
    }
    var hex = hash.toString(16);
    while (hex.length < 8) hex = "0" + hex;
    return hex;
  }

  // 現在の問題(GIVEN)のID。GIVEN の9行を結合した文字列のハッシュ。
  function puzzleId() {
    return fnv1a32(GIVEN.join(""));
  }

  // -------------------------------------------------------------------
  // 数独ジェネレーター / ソルバー(SPEC 7章 拡張1、docs/DESIGN.md 4.2)
  // 盤面は 9行の文字列配列と、81要素の数値配列(0 が空)の2つの表現を行き来する。
  // 探索は数値配列 + ビットマスクで行い、外に出すときだけ文字列に戻す。
  // -------------------------------------------------------------------

  // 3x3 の箱の番号(0〜8)
  function boxIndex(r, c) {
    return ((r / 3) | 0) * 3 + ((c / 3) | 0);
  }

  function gridToCells(grid) {
    var cells = [];
    for (var r = 0; r < 9; r++) {
      for (var c = 0; c < 9; c++) {
        var ch = grid[r][c];
        cells.push(ch === "." ? 0 : Number(ch));
      }
    }
    return cells;
  }

  function cellsToGrid(cells) {
    var rows = [];
    for (var r = 0; r < 9; r++) {
      var line = "";
      for (var c = 0; c < 9; c++) {
        var d = cells[r * 9 + c];
        line += d === 0 ? "." : String(d);
      }
      rows.push(line);
    }
    return rows;
  }

  // Fisher-Yates。元の配列は壊さない。
  function shuffled(list) {
    var a = list.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i];
      a[i] = a[j];
      a[j] = t;
    }
    return a;
  }

  /**
   * 解の個数を数える。limit 個見つかった時点で打ち切る(一意解の判定は limit=2 で足りる)。
   * found に配列を渡すと、見つけた解を9行の文字列配列として最大 limit 個まで積む。
   * 置かれている数字がすでに矛盾している盤面は 0 を返す。
   * 候補が最も少ないマスから埋める(MRV)。
   */
  function solveCount(grid, limit, found) {
    var max = typeof limit === "number" && limit > 0 ? limit : 1;
    var cells = gridToCells(grid);
    var rowMask = [];
    var colMask = [];
    var boxMask = [];
    for (var m = 0; m < 9; m++) {
      rowMask[m] = 0;
      colMask[m] = 0;
      boxMask[m] = 0;
    }
    for (var idx = 0; idx < 81; idx++) {
      var d0 = cells[idx];
      if (d0 === 0) continue;
      var r0 = (idx / 9) | 0;
      var c0 = idx % 9;
      var b0 = boxIndex(r0, c0);
      var bit0 = 1 << d0;
      // すでに同じ行・列・箱に同じ数字がある = 解なし
      if ((rowMask[r0] & bit0) || (colMask[c0] & bit0) || (boxMask[b0] & bit0)) return 0;
      rowMask[r0] |= bit0;
      colMask[c0] |= bit0;
      boxMask[b0] |= bit0;
    }

    var count = 0;

    function search() {
      // MRV: 候補が最も少ない空マスを選ぶ。候補0のマスがあればそこで行き止まり。
      var bestIdx = -1;
      var bestUsed = 0;
      var bestCount = 10;
      for (var i = 0; i < 81; i++) {
        if (cells[i] !== 0) continue;
        var r = (i / 9) | 0;
        var c = i % 9;
        var used = rowMask[r] | colMask[c] | boxMask[boxIndex(r, c)];
        var n = 0;
        for (var d = 1; d <= 9; d++) {
          if ((used & (1 << d)) === 0) n++;
        }
        if (n === 0) return;
        if (n < bestCount) {
          bestCount = n;
          bestIdx = i;
          bestUsed = used;
          if (n === 1) break;
        }
      }
      if (bestIdx === -1) {
        // 空マスが無い = 解が1つ確定
        count++;
        if (found && found.length < max) found.push(cellsToGrid(cells));
        return;
      }
      var br = (bestIdx / 9) | 0;
      var bc = bestIdx % 9;
      var bb = boxIndex(br, bc);
      for (var pick = 1; pick <= 9; pick++) {
        var bit = 1 << pick;
        if (bestUsed & bit) continue;
        cells[bestIdx] = pick;
        rowMask[br] |= bit;
        colMask[bc] |= bit;
        boxMask[bb] |= bit;
        search();
        cells[bestIdx] = 0;
        rowMask[br] &= ~bit;
        colMask[bc] &= ~bit;
        boxMask[bb] &= ~bit;
        if (count >= max) return;
      }
    }

    search();
    return count;
  }

  // 空盤面から、候補をシャッフルしながらバックトラッキングで完成盤を1つ作る。
  function generateSolvedGrid() {
    var cells = [];
    for (var i = 0; i < 81; i++) cells.push(0);
    var rowMask = [];
    var colMask = [];
    var boxMask = [];
    for (var m = 0; m < 9; m++) {
      rowMask[m] = 0;
      colMask[m] = 0;
      boxMask[m] = 0;
    }

    function fill(idx) {
      if (idx === 81) return true;
      var r = (idx / 9) | 0;
      var c = idx % 9;
      var b = boxIndex(r, c);
      var candidates = shuffled(DIGIT_NUMBERS);
      for (var k = 0; k < candidates.length; k++) {
        var d = candidates[k];
        var bit = 1 << d;
        if ((rowMask[r] | colMask[c] | boxMask[b]) & bit) continue;
        cells[idx] = d;
        rowMask[r] |= bit;
        colMask[c] |= bit;
        boxMask[b] |= bit;
        if (fill(idx + 1)) return true;
        cells[idx] = 0;
        rowMask[r] &= ~bit;
        colMask[c] &= ~bit;
        boxMask[b] &= ~bit;
      }
      return false;
    }

    if (!fill(0)) throw new Error("failed to generate a solved grid");
    return cellsToGrid(cells);
  }

  /**
   * 完成盤からマスをランダム順に消していき、消すたびに一意解のままかを確認する
   * (2つ目の解が見つかるなら戻す)。与えられた数字が targetGivens になったら打ち切り。
   * 戻り値 { given: 9行の文字列配列, solution: 9行の文字列配列 }。
   */
  function generatePuzzle(targetGivens) {
    var goal = Number.isFinite(targetGivens) ? targetGivens : DEFAULT_TARGET_GIVENS;
    if (goal < MIN_TARGET_GIVENS) goal = MIN_TARGET_GIVENS;
    if (goal > 81) goal = 81;

    var solution = generateSolvedGrid();
    var cells = gridToCells(solution);
    var order = [];
    for (var i = 0; i < 81; i++) order.push(i);
    order = shuffled(order);

    var givens = 81;
    for (var k = 0; k < order.length && givens > goal; k++) {
      var idx = order[k];
      var saved = cells[idx];
      if (saved === 0) continue;
      cells[idx] = 0;
      if (solveCount(cellsToGrid(cells), 2) === 1) {
        givens--;
      } else {
        cells[idx] = saved; // 一意解でなくなるなら元に戻す
      }
    }

    return { given: cellsToGrid(cells), solution: solution };
  }

  /**
   * generatePuzzle() をランダム順を変えて最大 GENERATE_RETRIES 回試し、目標ヒント数
   * (targetGivens)にちょうど届いた結果があればそこで打ち切って返す。「むずかしい」
   * (25)は目標ちょうどには届かず 26〜28 で止まることがある(既知。PR #15 の補足)ため、
   * 3回とも届かなければ、そのうち最もヒント数が少ない(= 最も難しい)結果を返す
   * (無限ループにはしない。docs/DESIGN.md 5章)。
   */
  function generatePuzzleWithRetry(targetGivens) {
    var best = null;
    var bestGivens = Infinity;
    for (var i = 0; i < GENERATE_RETRIES; i++) {
      var puzzle = generatePuzzle(targetGivens);
      var givens = 81 - countEmpty(puzzle.given);
      if (givens < bestGivens) {
        best = puzzle;
        bestGivens = givens;
      }
      if (givens <= targetGivens) break; // 目標に届いた(generatePuzzle の設計上、届けば必ずちょうど)
    }
    return best;
  }

  // 空マスの数(TOTAL_EMPTY の再計算に使う)。
  function countEmpty(grid) {
    var empty = 0;
    for (var r = 0; r < 9; r++) {
      for (var c = 0; c < 9; c++) {
        if (grid[r][c] === ".") empty++;
      }
    }
    return empty;
  }

  // -------------------------------------------------------------------
  // データ・状態(docs/DESIGN.md 4.1 / 5章)
  // -------------------------------------------------------------------
  var DIGITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];

  // -------------------------------------------------------------------
  // Claude(Anthropic API)経路(Issue #37、SPEC 7 章 拡張 3、docs/DESIGN.md 3.6)。
  // BYOK: 利用者自身の API キーをこのブラウザの localStorage にだけ置き、
  // api.anthropic.com への呼び出し以外には送らない。Worker は一切関与しない
  // (Worker 側の AI 呼び出しは env.AI.run("typesafe/jev") のまま)。
  // -------------------------------------------------------------------
  var ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
  var ANTHROPIC_VERSION = "2023-06-01";
  var ANTHROPIC_KEY_STORAGE_KEY = "scc.anthropic_key.v1";
  var CLAUDE_SETTINGS_STORAGE_KEY = "scc.claude_settings.v1";
  var CLAUDE_MODELS = ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"];
  var DEFAULT_CLAUDE_MODEL = "claude-opus-5";
  var CLAUDE_HAIKU_THINKING_BUDGET = 2048; // Haiku 4.5 は budget_tokens 方式(adaptive 非対応)
  var CLAUDE_ANSWER_MAX_TOKENS = 1024;     // JSON 1 件ぶん(思考なし)
  var CLAUDE_ADAPTIVE_MAX_TOKENS = 16000;  // adaptive thinking は思考トークンも max_tokens に含まれるので余裕を持たせる
  // 一括モード(Issue #48)は出力が大きい(最大64マス×9確率ぶんの JSON)ので、それぞれの
  // 最低値を大きく取る(既存の設定との Math.max で使う。docs/DESIGN.md 3.6)。
  var CLAUDE_ALL_ANSWER_MAX_TOKENS = 16000;   // 思考なしの一括の最低値
  var CLAUDE_ALL_ADAPTIVE_MAX_TOKENS = 24000; // adaptive thinking の一括の最低値
  var CLAUDE_ALL_HAIKU_MAX_TOKENS = 12000;    // Haiku(budget_tokens 方式)の一括の最低値
  var JEV_MODEL_ID = "typesafe/jev";
  // Worker が Jev に渡すのと同じルール説明・質問文(比較条件を揃える)。Worker 側の
  // 定数をテンプレートに埋め込んでいるので、二重管理にならない。
  var NOTE = ${JSON.stringify(NOTE)};
  var INSTRUCTIONS = ${JSON.stringify(INSTRUCTIONS)};
  // 確信度順モード(Issue #38)のマス選びで使う、Worker と同じ固定文。NOTE / INSTRUCTIONS と
  // 同じやり方でテンプレートに埋め込む(docs/DESIGN.md 3.5)。
  var CELL_NOTE = ${JSON.stringify(CELL_NOTE)};
  var CELL_INSTRUCTIONS = ${JSON.stringify(CELL_INSTRUCTIONS)};
  // 一括モード(Issue #48)で使う、Worker と同じ固定文。CELL_NOTE と同じやり方で埋め込む。
  // ALL_INSTRUCTIONS_TEMPLATE は空マス1つぶんの文言(Worker が questions の各 instructions に
  // 使うもの)なので、Claude 経路のユーザーメッセージには使わず、別に CLAUDE_ALL_INSTRUCTIONS
  // (全マスまとめて聞く1本の質問文)を用意する(docs/DESIGN.md 3.6)。
  var ALL_NOTE = ${JSON.stringify(ALL_NOTE)};
  var CLAUDE_SYSTEM = NOTE + " Answer with JSON only, matching the given schema: " +
    "\\"choice\\" is the digit you pick, \\"probabilities\\" gives your calibrated probability for each digit 1-9 " +
    "(they should sum to 1), and \\"confidence\\" is your overall confidence (0-1) that \\"choice\\" is correct.";
  // 確信度順のマス選び(Claude 経路)の system。CELL_NOTE をベースにした同種の文言。
  var CLAUDE_CELL_SYSTEM = CELL_NOTE + " Answer with JSON only, matching the given schema: " +
    "\\"choice\\" is the cell you pick (its key, such as \\"r0c2\\"), \\"probabilities\\" gives your calibrated " +
    "probability that each candidate cell is the one you would pick (they should sum to 1), and \\"confidence\\" " +
    "is your overall confidence (0-1) that \\"choice\\" is correct.";
  // 一括モード(Issue #48、Claude 経路)の system。ALL_NOTE をベースに、マスごとに choice /
  // probabilities / confidence の3つ組を答えることを伝える(docs/DESIGN.md 3.6)。
  var CLAUDE_ALL_SYSTEM = ALL_NOTE + " Answer with JSON only, matching the given schema: for each cell key, " +
    "\\"choice\\" is the digit you pick for that cell, \\"probabilities\\" gives your calibrated probability " +
    "for each digit 1-9 for that cell (they should sum to 1), and \\"confidence\\" is your overall confidence " +
    "(0-1) that \\"choice\\" is correct for that cell.";
  // 一括モードのユーザーメッセージの質問文。Worker の ALL_INSTRUCTIONS_TEMPLATE はマス1つぶんの
  // 文言なので、Claude には全マスまとめて聞く1本の文言を使う(スキーマの required キーが
  // 対象マスの一覧そのものなので、座標を文中に列挙し直す必要は無い)。
  var CLAUDE_ALL_INSTRUCTIONS = "Which digit from 1 to 9 belongs in each empty cell of this Sudoku grid? " +
    "Answer for every cell key required by the schema (each key is formatted as \\"r<row>c<col>\\", zero-based).";
  // structured outputs(output_config.format = json_schema)のスキーマ。Worker の
  // validateAnswer と同じ形(choice は 1〜9、probabilities は 1〜9 の 9 キー、confidence は数値)。
  var CLAUDE_OUTPUT_SCHEMA = (function () {
    var probProps = {};
    for (var i = 0; i < DIGITS.length; i++) probProps[DIGITS[i]] = { type: "number" };
    return {
      type: "object",
      properties: {
        choice: { type: "string", enum: DIGITS.slice() },
        probabilities: { type: "object", properties: probProps, required: DIGITS.slice(), additionalProperties: false },
        confidence: { type: "number" }
      },
      required: ["choice", "probabilities", "confidence"],
      additionalProperties: false
    };
  })();
  var DIGIT_NUMBERS = [1, 2, 3, 4, 5, 6, 7, 8, 9];

  // 確信度順モード(Issue #38)のマス選び用スキーマ。choice / probabilities のキーは
  // その時点の queue のマス("r<row>c<col>")。DIGITS 固定の CLAUDE_OUTPUT_SCHEMA と違い、
  // 呼び出しごとに候補が変わるので毎回組み立てる。
  function buildClaudeCellSchema(keys) {
    var probProps = {};
    for (var i = 0; i < keys.length; i++) probProps[keys[i]] = { type: "number" };
    return {
      type: "object",
      properties: {
        choice: { type: "string", enum: keys.slice() },
        probabilities: { type: "object", properties: probProps, required: keys.slice(), additionalProperties: false },
        confidence: { type: "number" }
      },
      required: ["choice", "probabilities", "confidence"],
      additionalProperties: false
    };
  }

  // 一括モード(Issue #48)のスキーマ。keys(その周の queue、行優先)ごとに、digit 判定と
  // 同じ形(choice は 1〜9、probabilities は 1〜9 の 9 キー、confidence は数値)の
  // オブジェクトを required で持つ。呼び出しのたびに候補(= queue)が変わるので毎回組み立てる
  // (buildClaudeCellSchema と同じ考え方)。
  function buildClaudeAllSchema(keys) {
    var digitProbProps = {};
    for (var d = 0; d < DIGITS.length; d++) digitProbProps[DIGITS[d]] = { type: "number" };
    var cellProps = {};
    for (var i = 0; i < keys.length; i++) {
      cellProps[keys[i]] = {
        type: "object",
        properties: {
          choice: { type: "string", enum: DIGITS.slice() },
          probabilities: { type: "object", properties: digitProbProps, required: DIGITS.slice(), additionalProperties: false },
          confidence: { type: "number" }
        },
        required: ["choice", "probabilities", "confidence"],
        additionalProperties: false
      };
    }
    return {
      type: "object",
      properties: cellProps,
      required: keys.slice(),
      additionalProperties: false
    };
  }

  // ジェネレーターが目指す「与えられた数字」の数。下限を割り込むほどは削らない
  // (削るほど生成に時間がかかり、実験としても手がかりが減りすぎる)。
  var DEFAULT_TARGET_GIVENS = 30;
  var MIN_TARGET_GIVENS = 24;

  // 難易度(SPEC F1/F4)ごとの目標ヒント数。「新しい問題」を押した時点の
  // state.difficulty に応じて newPuzzle() が generatePuzzleWithRetry() に渡す。
  var DIFFICULTY_GIVENS = { easy: 36, normal: 30, hard: 25 };
  var DEFAULT_DIFFICULTY = "normal";
  // generatePuzzleWithRetry() が目標ヒント数に届かないとき再試行する回数の上限。
  var GENERATE_RETRIES = 3;

  // 初期表示は Wikipedia の固定問題(docs/DESIGN.md 5章)。
  // 「新しい問題」を押すと generatePuzzle() の結果で丸ごと差し替える。
  var GIVEN = ["53..7....", "6..195...", ".98....6.", "8...6...3", "4..8.3..1", "7...2...6", ".6....28.", "...419..5", "....8..79"];
  var SOLUTION = ["534678912", "672195348", "198342567", "859761423", "426853791", "713924856", "961537284", "287419635", "345286179"];

  var TOTAL_EMPTY = countEmpty(GIVEN);

  // 速度モード(SPEC F4)
  var SLOW_BEFORE_COMMIT_MS = 700;
  var SLOW_AFTER_COMMIT_MS = 150;
  var SLOW_BETWEEN_ROUNDS_MS = 250;
  var FAST_BEFORE_COMMIT_MS = 0;
  var FAST_AFTER_COMMIT_MS = 20;
  var FAST_BETWEEN_ROUNDS_MS = 80;
  var MAX_ROUNDS = 15;

  // 集計ビュー(SPEC F1 拡張2、docs/DESIGN.md 4.2)。判定ごとの記録は state ではなく
  // localStorage(キー RECORDS_STORAGE_KEY)が正本。読み直しのコストを避けるため
  // モジュールスコープに recordsCache を持ち、getRecords() が初回だけ localStorage を
  // 読んで以後はそれを使い回す(PR #25 レビュー指摘 should-fix 2)。
  var RECORDS_STORAGE_KEY = "scc.records.v1";
  var RECORDS_BROKEN_STORAGE_KEY = RECORDS_STORAGE_KEY + ".broken";
  var RECORDS_MAX = 5000;
  var recordsCache = null; // null = まだ一度も読み込んでいない。読み込み後は配列(localStorageの鏡)

  var state = {
    round: 1,
    values: {}, // "r-c" -> { value: "4", status: "correct" | "incorrect" }
    focusedKey: null,
    currentProbs: null, // [{ digit, pct, isPick }, ...] 1〜9順
    roundLog: [],
    running: false,
    done: false,
    roundsToSolve: null,
    speedMode: "slow",
    difficulty: DEFAULT_DIFFICULTY, // "easy" | "normal" | "hard"(SPEC F1)。次の newPuzzle() から効く
    errorMessage: null,
    stoppedAtLimit: false,
    lastJudgment: null, // 直前に確定した1件(最速モードでも結果が見えるように残す)
    lastRequest: null, // 直近の判定で Worker が Jev に渡したペイロード(request、Issue #34)
    lastRequestFailed: false, // lastRequest が失敗した判定(502)のものなら true(Issue #34)
    modelMode: "jev",         // "jev" | "claude"。どのモデルに聞くか(Issue #37)。reset() で維持
    claudeModel: DEFAULT_CLAUDE_MODEL, // Claude 経路のモデル ID(CLAUDE_MODELS のどれか)
    claudeThinking: true,     // Claude 経路で思考(extended thinking)を使うか
    calibModelFilter: "all",  // 較正図のモデルフィルタ("all" | モデル識別子)
    orderMode: "scan",        // "scan"(左上から) | "confidence"(確信度順、Issue #38) | "all"(一括、Issue #48)。reset() で維持
    selecting: false,         // 確信度順のマス選び中か
    cellProbs: null,          // 確信度順のヒートマップ用 { "r-c": p, ... }。マス選びの直後だけ持つ
    lastSelection: null,      // 直近のマス選び1件 { r, c, confidence, candidates, p }
    lastCellRequest: null,    // 直近のマス選びでモデルに送ったリクエスト(Jev なら request、Claude なら送ったボディ)
    allFetching: false,       // 一括モード(Issue #48)の呼び出し中か(結果が届くまで座標もバーも無い)
    lastAllRequest: null,     // 直近の一括呼び出し { request, failed, count }(プロンプト枠。Issue #48)
    pauseReason: null         // 一時的な失敗による停止の理由文言(Issue #43)。手動 stop() では null のまま。
                              // run() / reset() / newPuzzle() / stop() で null に戻る
  };
  // 描画に不要な進行管理はモジュール変数(docs/DESIGN.md 4.1)
  var queue = [];
  var roundWrong = [];
  var roundTally = { correct: 0, total: 0 };
  var roundSize = TOTAL_EMPTY; // 開始前は「0 / 51」と見せる
  var started = false;
  var pendingCommit = null;
  // 一括モード(Issue #48)の今の周のキャッシュ。null = まだこの周で askAll() していない。
  // 応答が届いたら "r-c" 形式のキー → { choice, probabilities, confidence } に変換して持つ。
  // 停止/再開では保つ(再度呼ばない)。周が変わる(finalizeRound)・reset()/newPuzzle()・
  // showError() で null に戻す。
  var allResults = null;
  // 問題を生成している最中か。生成中はボタンを押せなくする。
  var generating = false;
  // 実行の世代。reset() / showError() のたびに進める。進行中の fetch や
  // setTimeout のコールバックは、捕まえた世代と一致するときだけ続行する。
  var runToken = 0;
  // 現在 in-flight の /api/judge 用 AbortController。focusNext() がリクエストの
  // たびに新しく作り直す。reset() / showError()(newPuzzle() は内部で reset() を
  // 呼ぶので実質同じ)で abort() し、リセット後に古いリクエストの結果が届いても
  // Jev への問い合わせ自体を打ち切る(runToken だけだと「結果を無視する」に留まり、
  // Worker 側は最後まで判定してしまう。Issue #19)。
  var inflightController = null;
  // 埋め込みモード(GET /?embed=1、比較モードの iframe が使う。Issue #46)。
  // true のときは render() がコントロール・Claude設定・較正図・プロンプト枠・見出しを
  // 省き、render() のたびに親(window.parent)へ status を postMessage する(4.1/4.2)。
  var embedMode = false;

  // 比較シェル(GET /compare、Issue #46)専用のモジュール変数。renderCompareShell()
  // が一度だけ DOM を組み立て、以後は sub要素への直接の innerHTML 差し替えで更新する
  // (iframe を含む app.innerHTML を丸ごと作り直すと、そのたびに両 iframe が再読み込み
  // されて進行状況が消えてしまうため。docs/DESIGN.md 8章)。
  var compareStatus = { jev: null, claude: null }; // 直近の status メッセージ(iframe ごと)
  var compareStartedAt = null; // 「実行」を押した時刻(ミリ秒)。経過秒の表示に使う
  var compareFrames = { jev: null, claude: null }; // <iframe> 要素(DOM参照)
  var compareEls = { topbar: null, statusJev: null, statusClaude: null }; // 更新対象の sub要素
  var compareGenerating = false; // 「新しい問題」で生成中か(比較シェル版)

  // -------------------------------------------------------------------
  // API呼び出し
  // -------------------------------------------------------------------
  // 判定 1 件。スナップショットはここで 1 回だけ作り(フォーカス確定後、SPEC F3)、
  // モデルトグルに応じて Jev(Worker 経由)か Claude(ブラウザ直呼び)に渡す。
  async function judgeCell(r, c, signal) {
    var puzzle = buildSnapshot();
    if (state.modelMode === "claude") return judgeCellClaude(puzzle, r, c, signal);
    return judgeCellJev(puzzle, r, c, signal);
  }

  async function judgeCellJev(puzzle, r, c, signal) {
    var res = await fetch("/api/judge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ puzzle: puzzle, target: { row: r, col: c } }),
      signal: signal
    });
    if (res.ok) return res.json();
    var message = "HTTP " + res.status;
    var data = null;
    try {
      data = await res.json();
      if (data && typeof data.error === "string") message = data.error;
    } catch (e) {
      // JSONでないボディはそのまま HTTP <status> にフォールバック
    }
    var error = new Error(message);
    // 502 には Worker が Jev に渡したペイロード(request)が付く(Issue #34)。
    // 「何を送って失敗したか」をパネルに出せるよう、エラーに載せて呼び出し元へ渡す。
    if (data && data.request && typeof data.request === "object") {
      error.request = data.request;
    }
    markJevTransientError(error, res);
    throw error;
  }

  // 一時的な失敗(Issue #43)。Jev 経路(Worker)の 429(レート制限)/ 503(カウンタ障害)は
  // pauseForTransientError() の対象になる(それ以外の 400/502 は従来どおり showError())。
  // 429 は Retry-After ヘッダーがあれば秒数を err.retryAfter に載せる
  // (pauseForTransientError() が文言に使う)。
  function markJevTransientError(error, res) {
    if (res.status !== 429 && res.status !== 503) return;
    error.transient = true;
    if (res.status === 429 && res.headers && typeof res.headers.get === "function") {
      // ヘッダーが無い(null)・空文字のときは Number() が 0 になるので、正の有限値のときだけ載せる
      var raw = res.headers.get("Retry-After");
      var retryAfter = raw === null ? NaN : Number(raw);
      if (isFinite(retryAfter) && retryAfter > 0) error.retryAfter = retryAfter;
    }
  }

  // 確信度順モード(Issue #38)のマス選び1件。スナップショットはここで1回だけ作り
  // (buildSelectionSnapshot()。queue の全マスを "." にしたもの)、モデルトグルに応じて
  // Jev / Claude に渡す。戻り値は { probabilities, choice, confidence, request, cell }。
  async function askCell(signal) {
    var puzzle = buildSelectionSnapshot();
    if (state.modelMode === "claude") return askCellClaude(puzzle, signal);
    return askCellJev(puzzle, signal);
  }

  async function askCellJev(puzzle, signal) {
    var res = await fetch("/api/judge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ puzzle: puzzle, ask: "cell" }),
      signal: signal
    });
    if (res.ok) return res.json();
    var message = "HTTP " + res.status;
    var data = null;
    try {
      data = await res.json();
      if (data && typeof data.error === "string") message = data.error;
    } catch (e) {
      // JSONでないボディはそのまま HTTP <status> にフォールバック
    }
    var error = new Error(message);
    if (data && data.request && typeof data.request === "object") {
      error.request = data.request;
    }
    markJevTransientError(error, res);
    throw error;
  }

  // 一括モード(Issue #48)の1周ぶん。スナップショットはここで1回だけ作り
  // (buildSelectionSnapshot()。queue の全マスを "." にしたもの)、モデルトグルに応じて
  // Jev / Claude に渡す。戻り値はどちらも { cells, request }(cells はマスのキー →
  // { choice, probabilities, confidence })。
  async function askAll(signal) {
    var puzzle = buildSelectionSnapshot();
    if (state.modelMode === "claude") return askAllClaude(puzzle, signal);
    return askAllJev(puzzle, signal);
  }

  async function askAllJev(puzzle, signal) {
    var res = await fetch("/api/judge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ puzzle: puzzle, ask: "all" }),
      signal: signal
    });
    if (res.ok) return res.json();
    var message = "HTTP " + res.status;
    var data = null;
    try {
      data = await res.json();
      if (data && typeof data.error === "string") message = data.error;
    } catch (e) {
      // JSONでないボディはそのまま HTTP <status> にフォールバック
    }
    var error = new Error(message);
    if (data && data.request && typeof data.request === "object") {
      error.request = data.request;
    }
    markJevTransientError(error, res);
    throw error;
  }

  // -------------------------------------------------------------------
  // Claude 経路(Issue #37、docs/DESIGN.md 3.6)。キー・設定は localStorage。
  // -------------------------------------------------------------------
  function loadAnthropicKey() {
    try {
      var key = localStorage.getItem(ANTHROPIC_KEY_STORAGE_KEY);
      return typeof key === "string" && key.length > 0 ? key : null;
    } catch (e) {
      return null;
    }
  }

  // 設定系の失敗は判定ループを止めない(showError は runToken を進めて in-flight を
  // 捨てるので、設定パネルの失敗には重すぎる。レビュー指摘 S3)。パネル内の注意書きに留める。
  var claudeKeyNotice = null;

  function saveAnthropicKey(key) {
    var trimmed = String(key || "").trim();
    if (!trimmed) {
      claudeKeyNotice = "キーが空です";
      render();
      return false;
    }
    try {
      localStorage.setItem(ANTHROPIC_KEY_STORAGE_KEY, trimmed);
      claudeKeyNotice = null;
    } catch (e) {
      claudeKeyNotice = "API キーを保存できません(localStorage が使えません)";
      render();
      return false;
    }
    render();
    return true;
  }

  function saveAnthropicKeyFromInput() {
    var el = document.getElementById("anthropic-key-input");
    if (!el) return;
    var value = el.value;
    el.value = ""; // 保存の成否にかかわらず、まず入力欄から消す(render() の実装に依存しない)
    saveAnthropicKey(value);
  }

  function clearAnthropicKey() {
    if (modelSettingsLocked()) return; // 実行中・停止中に消すと次のマスで止まる(S2)
    try {
      localStorage.removeItem(ANTHROPIC_KEY_STORAGE_KEY);
    } catch (e) {
      // 読めない・消せない localStorage は「未設定」と同じ扱い
    }
    claudeKeyNotice = null;
    render();
  }

  // 画面に出すのは末尾 4 文字だけ。キー全体は DOM にも state にも置かない。
  function anthropicKeyHint() {
    var key = loadAnthropicKey();
    if (!key) return "未設定";
    return "保存済み(末尾 …" + key.slice(-4) + ")";
  }

  function loadClaudeSettings() {
    try {
      var raw = localStorage.getItem(CLAUDE_SETTINGS_STORAGE_KEY);
      if (!raw) return;
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return;
      if (parsed.modelMode === "claude" || parsed.modelMode === "jev") state.modelMode = parsed.modelMode;
      if (CLAUDE_MODELS.indexOf(parsed.model) !== -1) state.claudeModel = parsed.model;
      if (typeof parsed.thinking === "boolean") state.claudeThinking = parsed.thinking;
    } catch (e) {
      // 壊れた設定は既定値のまま
    }
  }

  function saveClaudeSettings() {
    try {
      localStorage.setItem(CLAUDE_SETTINGS_STORAGE_KEY, JSON.stringify({
        modelMode: state.modelMode,
        model: state.claudeModel,
        thinking: state.claudeThinking
      }));
    } catch (e) {
      // 保存できなくても動作には影響しない(次回開いたときに既定値に戻るだけ)
    }
  }

  // モデルの切り替えは実行中・停止中(周の途中)には行わない。1 周の中で
  // モデルが混ざると周回ログの意味が崩れるため。
  function modelSettingsLocked() {
    return state.running || isPaused();
  }

  function setModelMode(mode) {
    if (mode !== "jev" && mode !== "claude") return;
    if (modelSettingsLocked()) return;
    state.modelMode = mode;
    saveClaudeSettings();
    render();
  }

  function setClaudeModel(model) {
    if (CLAUDE_MODELS.indexOf(model) === -1) return;
    if (modelSettingsLocked()) return;
    state.claudeModel = model;
    saveClaudeSettings();
    render();
  }

  function setClaudeThinking(on) {
    if (modelSettingsLocked()) return;
    state.claudeThinking = !!on;
    saveClaudeSettings();
    render();
  }

  // 順番トグル(左上から / 確信度順 / 一括、Issue #38・#48)。モデルトグルと同じ条件で
  // ロックする(周の途中で切り替えると、選び方が混ざって周回ログの意味が崩れるため)。
  // localStorage には保存しない(reset() / newPuzzle() をまたいで state だけで保持する)。
  function setOrderMode(mode) {
    if (mode !== "scan" && mode !== "confidence" && mode !== "all") return;
    if (modelSettingsLocked()) return;
    state.orderMode = mode;
    render();
  }

  // 記録(scc.records.v1)の m に入れるモデル識別子。Claude は思考の有無で分ける。
  function currentModelId() {
    if (state.modelMode === "claude") return state.claudeModel + (state.claudeThinking ? "+think" : "");
    return JEV_MODEL_ID;
  }

  // モデルごとの thinking 指定。Opus 5 / Sonnet 5 は adaptive / disabled、
  // Haiku 4.5 は enabled + budget_tokens(adaptive 非対応)。null なら thinking を送らない。
  function claudeThinkingConfig(model, on) {
    if (model === "claude-haiku-4-5") {
      return on ? { type: "enabled", budget_tokens: CLAUDE_HAIKU_THINKING_BUDGET } : null;
    }
    return { type: on ? "adaptive" : "disabled" };
  }

  // Claude に送るリクエストボディ。ヘッダー(キー)は含めない。これがそのまま
  // state.lastRequest(「モデルに送ったプロンプト」パネル)になる。
  // 盤面は Jev と同じ buildSnapshot()(対象マスは "."、SOLUTION 由来の情報なし)。
  function buildClaudeRequest(puzzle, r, c) {
    var body = {
      model: state.claudeModel,
      max_tokens: CLAUDE_ANSWER_MAX_TOKENS,
      system: CLAUDE_SYSTEM,
      messages: [
        {
          role: "user",
          content: INSTRUCTIONS + "\\n" + JSON.stringify({ puzzle: puzzle, target: { row: r, col: c } })
        }
      ],
      output_config: { format: { type: "json_schema", schema: CLAUDE_OUTPUT_SCHEMA } }
    };
    var thinking = claudeThinkingConfig(state.claudeModel, state.claudeThinking);
    if (thinking) {
      body.thinking = thinking;
      // 思考トークンは出力トークンとして max_tokens に含まれる。小さいままだと JSON が
      // 1 トークンも出ずに stop_reason: max_tokens で終わる(レビュー指摘 M1)。
      if (thinking.type === "adaptive") body.max_tokens = CLAUDE_ADAPTIVE_MAX_TOKENS;
      if (typeof thinking.budget_tokens === "number") body.max_tokens = thinking.budget_tokens + CLAUDE_ANSWER_MAX_TOKENS;
    }
    return body;
  }

  // 確信度順モード(Issue #38)のマス選び(Claude 経路)のリクエストボディ。
  // buildClaudeRequest と同じ組み立て方だが、system が CLAUDE_CELL_SYSTEM、
  // messages[0].content が CELL_INSTRUCTIONS + 改行 + { puzzle }(target は無い)、
  // スキーマの choice / probabilities のキーが keys(queue のマス、行優先)になる。
  function buildClaudeCellRequest(puzzle, keys) {
    var body = {
      model: state.claudeModel,
      max_tokens: CLAUDE_ANSWER_MAX_TOKENS,
      system: CLAUDE_CELL_SYSTEM,
      messages: [
        {
          role: "user",
          content: CELL_INSTRUCTIONS + "\\n" + JSON.stringify({ puzzle: puzzle })
        }
      ],
      output_config: { format: { type: "json_schema", schema: buildClaudeCellSchema(keys) } }
    };
    var thinking = claudeThinkingConfig(state.claudeModel, state.claudeThinking);
    if (thinking) {
      body.thinking = thinking;
      if (thinking.type === "adaptive") body.max_tokens = CLAUDE_ADAPTIVE_MAX_TOKENS;
      if (typeof thinking.budget_tokens === "number") body.max_tokens = thinking.budget_tokens + CLAUDE_ANSWER_MAX_TOKENS;
    }
    return body;
  }

  // 一括モード(Issue #48)のリクエストボディ(Claude 経路)。buildClaudeCellRequest と同じ
  // 組み立て方だが、system が CLAUDE_ALL_SYSTEM、messages[0].content が
  // CLAUDE_ALL_INSTRUCTIONS + 改行 + { puzzle }(target は無い)、スキーマが
  // buildClaudeAllSchema(keys)(マスごとに choice/probabilities/confidence の3つ組)。
  // max_tokens は出力が大きい(最大64マス×9確率)ので、既存の設定と一括専用の最低値の
  // 大きい方を使う(docs/DESIGN.md 3.6)。
  function buildClaudeAllRequest(puzzle, keys) {
    var body = {
      model: state.claudeModel,
      max_tokens: CLAUDE_ALL_ANSWER_MAX_TOKENS, // 思考なしの最低値
      system: CLAUDE_ALL_SYSTEM,
      messages: [
        {
          role: "user",
          content: CLAUDE_ALL_INSTRUCTIONS + "\\n" + JSON.stringify({ puzzle: puzzle })
        }
      ],
      output_config: { format: { type: "json_schema", schema: buildClaudeAllSchema(keys) } }
    };
    var thinking = claudeThinkingConfig(state.claudeModel, state.claudeThinking);
    if (thinking) {
      body.thinking = thinking;
      if (thinking.type === "adaptive") body.max_tokens = Math.max(CLAUDE_ADAPTIVE_MAX_TOKENS, CLAUDE_ALL_ADAPTIVE_MAX_TOKENS);
      if (typeof thinking.budget_tokens === "number") {
        body.max_tokens = Math.max(thinking.budget_tokens + CLAUDE_ANSWER_MAX_TOKENS, CLAUDE_ALL_HAIKU_MAX_TOKENS);
      }
    }
    return body;
  }

  // Worker の validateAnswer と同じ基準で Claude の JSON を検証する。expectedKeys は
  // choice / probabilities が取りうるキーの集合(省略時は DIGITS。確信度順のマス選び
  // (Issue #38)では queue のマスのキーを渡す)。Worker の validateAnswer と同じく
  // 一般化してある(3.3 と同じ考え方)。
  function validateClaudeAnswer(answer, expectedKeys) {
    var keys2 = expectedKeys || DIGITS;
    // digit(expectedKeys 省略)の文言は #37 のまま。cell は候補マスの文言(Worker の ANSWER_MESSAGES と同じ方針)。
    var keysMessage = expectedKeys
      ? "Claude の応答の probabilities が候補マスのキーと一致していません"
      : "Claude の応答の probabilities が 1〜9 の 9 キーになっていません";
    var choiceMessage = expectedKeys
      ? "Claude の応答の choice が候補マスのいずれかではありません"
      : "Claude の応答の choice が 1〜9 のいずれかではありません";
    if (!answer || typeof answer !== "object") return "Claude の応答が JSON オブジェクトではありません";
    var probabilities = answer.probabilities;
    if (probabilities === null || typeof probabilities !== "object" || Array.isArray(probabilities)) {
      return "Claude の応答に probabilities がありません";
    }
    var keys = Object.keys(probabilities);
    if (keys.length !== keys2.length) return keysMessage;
    for (var i = 0; i < keys2.length; i++) {
      var k = keys2[i];
      if (!Object.prototype.hasOwnProperty.call(probabilities, k)) return keysMessage;
      if (typeof probabilities[k] !== "number" || !isFinite(probabilities[k])) return "Claude の応答の probabilities に数値でない値が含まれています";
    }
    if (typeof answer.choice !== "string" || keys2.indexOf(answer.choice) === -1) return choiceMessage;
    if (typeof answer.confidence !== "number" || !isFinite(answer.confidence)) return "Claude の応答の confidence が数値ではありません";
    return null;
  }

  // Messages API の応答から stop_reason のチェックとテキストブロックの取り出しだけを行う
  // 共通部分(digit / cell / all のどの経路でも同じ)。{ text } か { error }。
  function extractClaudeText(data) {
    if (!data || typeof data !== "object") return { error: "Claude の応答が JSON ではありません" };
    if (data.stop_reason === "refusal") return { error: "Claude が応答を拒否しました(stop_reason: refusal)" };
    if (data.stop_reason === "max_tokens") return { error: "Claude の応答が max_tokens で途切れました" };
    var text = null;
    if (Array.isArray(data.content)) {
      for (var i = 0; i < data.content.length; i++) {
        var block = data.content[i];
        if (block && block.type === "text" && typeof block.text === "string") {
          text = block.text;
          break;
        }
      }
    }
    if (text === null) return { error: "Claude の応答にテキストがありません" };
    return { text: text };
  }

  // Messages API の応答から JSON 回答を取り出す。{ answer } か { error }。
  // expectedKeys は validateClaudeAnswer にそのまま渡す(省略時は DIGITS)。
  function parseClaudeAnswer(data, expectedKeys) {
    var extracted = extractClaudeText(data);
    if (extracted.error) return { error: extracted.error };
    var parsed;
    try {
      parsed = JSON.parse(extracted.text);
    } catch (e) {
      return { error: "Claude の応答を JSON として解釈できません" };
    }
    var bad = validateClaudeAnswer(parsed, expectedKeys);
    if (bad !== null) return { error: bad };
    return { answer: parsed };
  }

  // 一括モード(Issue #48)の応答の検証。answer はマスのキー(expectedKeys = queue の
  // キー一覧)をそれぞれ持つオブジェクトで、各値は digit 判定と同じ基準
  // (validateClaudeAnswer(answer[key], DIGITS))を満たす必要がある。Worker の
  // validateAllAnswers(docs/DESIGN.md 3.3)と同じ考え方で、どのマスで落ちたかが
  // わかる文言にする。
  function validateClaudeAllAnswer(answer, expectedKeys) {
    if (!answer || typeof answer !== "object" || Array.isArray(answer)) return "Claude の応答が JSON オブジェクトではありません";
    var keys = Object.keys(answer);
    if (keys.length !== expectedKeys.length) return "Claude の応答のキーが対象マスと一致していません";
    for (var i = 0; i < expectedKeys.length; i++) {
      var k = expectedKeys[i];
      if (!Object.prototype.hasOwnProperty.call(answer, k)) return "Claude の応答のキーが対象マスと一致していません";
      var bad = validateClaudeAnswer(answer[k], DIGITS);
      if (bad !== null) return k + " の応答: " + bad;
    }
    return null;
  }

  // 一括モードの応答から JSON をまとめて取り出す。{ answer } か { error }。
  // answer はマスのキー → { choice, probabilities, confidence } のオブジェクト。
  function parseClaudeAllAnswer(data, expectedKeys) {
    var extracted = extractClaudeText(data);
    if (extracted.error) return { error: extracted.error };
    var parsed;
    try {
      parsed = JSON.parse(extracted.text);
    } catch (e) {
      return { error: "Claude の応答を JSON として解釈できません" };
    }
    var bad = validateClaudeAllAnswer(parsed, expectedKeys);
    if (bad !== null) return { error: bad };
    return { answer: parsed };
  }

  // 一時的な失敗(Issue #43)。Claude 経路の 429(レート制限)/ 529(過負荷)/ 5xx は
  // pauseForTransientError() の対象になる(401 などそれ以外の非 2xx は従来どおり showError())。
  function isTransientClaudeStatus(status) {
    // 529 は 5xx の範囲に含まれるが、Anthropic の「過負荷」として個別に扱う意図を明示しておく
    return status === 429 || status === 529 || (status >= 500 && status < 600);
  }

  // ブラウザから api.anthropic.com を直接呼ぶ(CORS 対応。ブラウザからの直接呼び出しには
  // anthropic-dangerous-direct-browser-access ヘッダーが必要)。キーは x-api-key ヘッダーにだけ載せる。
  // 戻り値は judgeCellJev と同じ形 { probabilities, choice, confidence, request }。
  async function judgeCellClaude(puzzle, r, c, signal) {
    var key = loadAnthropicKey();
    if (!key) throw new Error("Claude の API キーが設定されていません(「Claude の設定」でキーを保存してください)");
    var body = buildClaudeRequest(puzzle, r, c);
    var res;
    try {
      res = await fetch(ANTHROPIC_MESSAGES_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": key,
          "anthropic-version": ANTHROPIC_VERSION,
          "anthropic-dangerous-direct-browser-access": "true"
        },
        body: JSON.stringify(body),
        signal: signal
      });
    } catch (e) {
      if (e && e.name === "AbortError") throw e;
      // ネットワーク失敗(fetch が reject)は一時的な失敗として扱う(Issue #43)。
      var netErr = new Error("Claude API に接続できません: " + (e && e.message ? e.message : String(e)));
      netErr.request = body;
      netErr.transient = true;
      throw netErr;
    }
    var data = null;
    try {
      data = await res.json();
    } catch (e) {
      if (e && e.name === "AbortError") throw e; // abort 中の reject は別のエラーに化かさない
      data = null;
    }
    if (!res.ok) {
      var message = "Claude API HTTP " + res.status;
      if (data && data.error && typeof data.error.message === "string") message += ": " + data.error.message;
      var httpErr = new Error(message);
      httpErr.request = body;
      if (isTransientClaudeStatus(res.status)) httpErr.transient = true;
      throw httpErr;
    }
    var parsed = parseClaudeAnswer(data);
    if (parsed.error) {
      var formatErr = new Error(parsed.error);
      formatErr.request = body;
      throw formatErr;
    }
    return {
      probabilities: parsed.answer.probabilities,
      choice: parsed.answer.choice,
      confidence: parsed.answer.confidence,
      request: body
    };
  }

  // 確信度順モード(Issue #38)のマス選び(Claude 経路)。judgeCellClaude と同じ組み立て。
  // 戻り値は askCellJev と同じ形 { probabilities, choice, confidence, request, cell }。
  async function askCellClaude(puzzle, signal) {
    var key = loadAnthropicKey();
    if (!key) throw new Error("Claude の API キーが設定されていません(「Claude の設定」でキーを保存してください)");
    var keys = selectionKeys();
    var body = buildClaudeCellRequest(puzzle, keys);
    var res;
    try {
      res = await fetch(ANTHROPIC_MESSAGES_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": key,
          "anthropic-version": ANTHROPIC_VERSION,
          "anthropic-dangerous-direct-browser-access": "true"
        },
        body: JSON.stringify(body),
        signal: signal
      });
    } catch (e) {
      if (e && e.name === "AbortError") throw e;
      var netErr = new Error("Claude API に接続できません: " + (e && e.message ? e.message : String(e)));
      netErr.request = body;
      netErr.transient = true;
      throw netErr;
    }
    var data = null;
    try {
      data = await res.json();
    } catch (e) {
      if (e && e.name === "AbortError") throw e;
      data = null;
    }
    if (!res.ok) {
      var message = "Claude API HTTP " + res.status;
      if (data && data.error && typeof data.error.message === "string") message += ": " + data.error.message;
      var httpErr = new Error(message);
      httpErr.request = body;
      if (isTransientClaudeStatus(res.status)) httpErr.transient = true;
      throw httpErr;
    }
    var parsed = parseClaudeAnswer(data, keys);
    if (parsed.error) {
      var formatErr = new Error(parsed.error);
      formatErr.request = body;
      throw formatErr;
    }
    var choice = parsed.answer.choice;
    var m = /^r(\\d)c(\\d)$/.exec(choice);
    if (!m) {
      var shapeErr = new Error("選ばれたマスが候補にありません: " + choice);
      shapeErr.request = body;
      throw shapeErr;
    }
    return {
      probabilities: parsed.answer.probabilities,
      choice: choice,
      confidence: parsed.answer.confidence,
      request: body,
      cell: { row: Number(m[1]), col: Number(m[2]) }
    };
  }

  // 一括モード(Issue #48)の1周ぶん(Claude 経路)。judgeCellClaude / askCellClaude と
  // 同じ組み立て。戻り値は askAllJev と同じ形 { cells, request }(cells は
  // マスのキー → { choice, probabilities, confidence })。
  async function askAllClaude(puzzle, signal) {
    var key = loadAnthropicKey();
    if (!key) throw new Error("Claude の API キーが設定されていません(「Claude の設定」でキーを保存してください)");
    var keys = selectionKeys();
    var body = buildClaudeAllRequest(puzzle, keys);
    var res;
    try {
      res = await fetch(ANTHROPIC_MESSAGES_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": key,
          "anthropic-version": ANTHROPIC_VERSION,
          "anthropic-dangerous-direct-browser-access": "true"
        },
        body: JSON.stringify(body),
        signal: signal
      });
    } catch (e) {
      if (e && e.name === "AbortError") throw e;
      var netErr = new Error("Claude API に接続できません: " + (e && e.message ? e.message : String(e)));
      netErr.request = body;
      netErr.transient = true;
      throw netErr;
    }
    var data = null;
    try {
      data = await res.json();
    } catch (e) {
      if (e && e.name === "AbortError") throw e;
      data = null;
    }
    if (!res.ok) {
      var message = "Claude API HTTP " + res.status;
      if (data && data.error && typeof data.error.message === "string") message += ": " + data.error.message;
      var httpErr = new Error(message);
      httpErr.request = body;
      if (isTransientClaudeStatus(res.status)) httpErr.transient = true;
      throw httpErr;
    }
    var parsed = parseClaudeAllAnswer(data, keys);
    if (parsed.error) {
      var formatErr = new Error(parsed.error);
      formatErr.request = body;
      throw formatErr;
    }
    return { cells: parsed.answer, request: body };
  }

  // -------------------------------------------------------------------
  // 集計ビュー: 記録の読み書き(SPEC F1 拡張2、docs/DESIGN.md 4.1 / 4.2)。
  // localStorage が無い・例外を投げる・壊れた JSON が入っている、いずれの場合も
  // 例外を外に出さない(呼び出し側の commitFocused / run() を止めないため)。
  // -------------------------------------------------------------------

  // 壊れた(パースできない・配列でない)値を退避キーに逃がしてから空で作り直す。
  // 退避そのものに失敗しても(容量超過等)、元々壊れていたデータなので諦める。
  function stashBrokenRecords(raw) {
    try {
      if (typeof localStorage === "undefined" || !localStorage) return;
      localStorage.setItem(RECORDS_BROKEN_STORAGE_KEY, raw);
    } catch (e) {
      // 退避も失敗したら諦める
    }
  }

  // localStorage から読む。戻り値は { ok, records }。
  // - ok:true, records:[]  … 何も保存されていない、または壊れていたので空で作り直した(正常系)
  // - ok:false, records:[] … localStorage が無い、または getItem が例外を投げた
  //   (= 「読めなかった」。中身が本当に空なのか分からないので、呼び出し側はこれを
  //   「空だった」と混同して上書き保存してはいけない。PR #25 レビュー指摘 should-fix 1)
  function loadRecords() {
    try {
      if (typeof localStorage === "undefined" || !localStorage) return { ok: false, records: [] };
      var raw = localStorage.getItem(RECORDS_STORAGE_KEY);
      if (!raw) return { ok: true, records: [] };
      var parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (parseErr) {
        stashBrokenRecords(raw);
        return { ok: true, records: [] };
      }
      if (!Array.isArray(parsed)) {
        stashBrokenRecords(raw);
        return { ok: true, records: [] };
      }
      return { ok: true, records: parsed };
    } catch (e) {
      // getItem 自体が例外を投げた場合。中身が読めていないので「読めなかった」として扱う。
      return { ok: false, records: [] };
    }
  }

  // records を正本(localStorage)に書き込み、キャッシュも同期する。
  function saveRecords(records) {
    recordsCache = records;
    try {
      if (typeof localStorage === "undefined" || !localStorage) return;
      localStorage.setItem(RECORDS_STORAGE_KEY, JSON.stringify(records));
    } catch (e) {
      // 保存失敗(容量超過・プライベートモード等)は無視する。記録は補助情報であり、
      // 判定ループそのものを止める理由にはしない。
    }
  }

  // render() / exportRecords() が読む窓口。初回だけ localStorage を読み、以後は
  // recordsCache を使い回す(PR #25 レビュー指摘 should-fix 2)。読み込みに失敗した
  // (ok:false)ときはキャッシュを作らず、その場限りの空配列を返す(次回また読み直しを試みる)。
  function getRecords() {
    if (recordsCache !== null) return recordsCache;
    var loaded = loadRecords();
    if (loaded.ok) recordsCache = loaded.records;
    return loaded.records;
  }

  // 1件追記する。上限 RECORDS_MAX を超えたら古いものから捨てる。
  // キャッシュが無ければ初回だけ localStorage を読むが、読めなかった(ok:false)
  // ときは中身が分からないまま upsert すると全消しになりかねないので、
  // 何もせず黙って捨てる(このレコード1件だけを諦める。PR #25 レビュー指摘 should-fix 1)。
  function appendRecord(rec) {
    // 追記のたびに localStorage を読み直す。比較モード(#46)では同一オリジンの 2 ページが
    // 同じキーに書くので、自分のキャッシュに足して丸ごと書き戻すと相手の書き込みを踏み潰す
    // (lost update。PR #49 レビュー指摘 M1)。読み取りキャッシュ(getRecords)は描画用に残し、
    // ここで最新に置き換える。1 判定 = 1 API 往復なので JSON.parse 1 回のコストは無視できる。
    var loaded = loadRecords();
    if (!loaded.ok) return; // 読めない状態を「空」と取り違えて上書きしない(PR #25)
    var records = loaded.records;
    records.push(rec);
    if (records.length > RECORDS_MAX) {
      records = records.slice(records.length - RECORDS_MAX);
    }
    saveRecords(records);
    recordsCache = records;
  }

  // -------------------------------------------------------------------
  // 進行ロジック(docs/DESIGN.md 4.3 状態遷移)
  // -------------------------------------------------------------------
  function run() {
    if (state.running || state.done || state.errorMessage) return;
    state.running = true;
    // 一時的な失敗による停止(Issue #43)からの再開。理由表示を消す
    // (手動停止からの再開では元々 null なので無害)。
    state.pauseReason = null;
    if (!started) {
      started = true;
      queue = [];
      for (var r = 0; r < 9; r++) {
        for (var c = 0; c < 9; c++) {
          if (GIVEN[r][c] === ".") queue.push({ r: r, c: c });
        }
      }
      roundSize = queue.length;
      roundTally = { correct: 0, total: 0 };
    }
    render();
    focusNext();
  }

  function focusNext() {
    if (!state.running) return;
    // この呼び出しが属する実行世代。以降のコールバックはすべてこれで判定する。
    var token = runToken;
    if (queue.length === 0) {
      finalizeRound();
      return;
    }
    // 確信度順モード(Issue #38): まずマス選び(1回目の呼び出し)。選ばれたマスが
    // queue から取り除かれてから数字判定(focusCellForDigit)に進む。
    if (state.orderMode === "confidence") {
      selectNextCell(token);
      return;
    }
    // 一括モード(Issue #48): 周の最初の呼び出しでまだ askAll() していなければ
    // (allResults === null)1回だけ呼び、以降はキャッシュから1マスずつ確定する。
    if (state.orderMode === "all") {
      focusNextAll(token);
      return;
    }
    var cell = queue.shift();
    focusCellForDigit(cell, token);
  }

  // 確信度順モード(Issue #38)のマス選び。queue の全マスを候補にして askCell() を呼び、
  // 選ばれたマスを queue から取り除いてから focusCellForDigit() に渡す(1ステップ = 2回の判定)。
  function selectNextCell(token) {
    state.selecting = true;
    state.focusedKey = null;
    state.currentProbs = null;
    state.cellProbs = null;
    pendingCommit = null;
    render();

    inflightController = new AbortController();
    askCell(inflightController.signal).then(function (result) {
      if (!isCurrent(token)) return;
      if (result.request && typeof result.request === "object") {
        state.lastCellRequest = result.request;
      }
      var chosen = result.cell;
      var idx = -1;
      if (chosen && typeof chosen.row === "number" && typeof chosen.col === "number") {
        for (var i = 0; i < queue.length; i++) {
          if (queue[i].r === chosen.row && queue[i].c === chosen.col) {
            idx = i;
            break;
          }
        }
      }
      if (idx === -1) {
        showError("選ばれたマスが候補にありません: " + JSON.stringify(result.choice));
        return;
      }
      // ヒートマップ用: "r0c2" 形式のキーを "r-c" 形式に変換する。
      var probs = result.probabilities || {};
      var cellProbs = {};
      var cellProbsMax = 0;
      var probKeys = Object.keys(probs);
      for (var k = 0; k < probKeys.length; k++) {
        var m = /^r(\\d)c(\\d)$/.exec(probKeys[k]);
        if (!m) continue;
        var v = probs[probKeys[k]];
        if (typeof v !== "number" || !isFinite(v)) continue;
        cellProbs[m[1] + "-" + m[2]] = v;
        if (v > cellProbsMax) cellProbsMax = v;
      }
      state.cellProbs = cellProbs;
      state.cellProbsMax = cellProbsMax; // ヒートマップの正規化用(マスごとに再計算しない)
      state.lastSelection = {
        r: chosen.row,
        c: chosen.col,
        confidence: result.confidence,
        candidates: probKeys.length,
        p: typeof probs[result.choice] === "number" ? probs[result.choice] : null
      };
      var cell = queue.splice(idx, 1)[0];
      state.selecting = false;
      focusCellForDigit(cell, token); // この中で render() する
    }, function (err) {
      if (!isCurrent(token)) return;
      if (err && err.name === "AbortError") return;
      if (err && err.request && typeof err.request === "object") {
        state.lastCellRequest = err.request;
      }
      // 一時的な失敗(Issue #43)は停止扱い(queue はマス選び中なので変えなくてよい。
      // pauseForTransientError() が stop() 相当の後始末をする)。それ以外は従来どおり showError()。
      if (err && err.transient) {
        pauseForTransientError(err);
        return;
      }
      showError(err && err.message ? err.message : String(err));
    }).catch(function (err) {
      if (!isCurrent(token)) return;
      showError("画面の更新に失敗しました: " + (err && err.message ? err.message : String(err)));
    });
  }

  // 1マスの数字判定(従来の focusNext() の本体そのもの)。cell を queue から取り出す
  // 部分だけが呼び出し元(focusNext / selectNextCell)側に分かれている。
  function focusCellForDigit(cell, token) {
    // 先にフォーカスを立てる。buildSnapshot() は state.focusedKey のマスを "." に
    // するので、この順序が「対象マスを空にして送る」不変条件そのもの(SPEC F3)。
    state.focusedKey = cell.r + "-" + cell.c;
    state.currentProbs = null;
    pendingCommit = null;
    render();

    // このリクエスト専用の AbortController。reset() / showError() が abort() すると
    // 下の fetch が AbortError で reject される(Issue #19)。
    inflightController = new AbortController();
    judgeCell(cell.r, cell.c, inflightController.signal).then(function (result) {
      if (!isCurrent(token)) return; // リセット後などの古い世代は捨てる
      var probs = DIGITS.map(function (d) {
        var p = result.probabilities ? result.probabilities[d] : 0;
        return { digit: d, pct: Math.round((typeof p === "number" ? p : 0) * 100), isPick: d === result.choice };
      });
      state.currentProbs = probs;
      // Worker が Jev に渡したペイロードそのもの(Issue #34)。停止中でも消さず、
      // 次の判定が確定するまで(エラー時もそのまま)残す。
      if (result.request && typeof result.request === "object") {
        state.lastRequest = result.request;
        state.lastRequestFailed = false;
      }
      pendingCommit = { r: cell.r, c: cell.c, choice: result.choice, confidence: result.confidence, probabilities: result.probabilities };
      render();
      var beforeCommitMs = state.speedMode === "slow" ? SLOW_BEFORE_COMMIT_MS : FAST_BEFORE_COMMIT_MS;
      setTimeout(function () {
        if (!isCurrent(token)) return;
        commitFocused();
        var afterCommitMs = state.speedMode === "slow" ? SLOW_AFTER_COMMIT_MS : FAST_AFTER_COMMIT_MS;
        setTimeout(function () {
          if (!isCurrent(token)) return;
          focusNext();
        }, afterCommitMs);
      }, beforeCommitMs);
    }, function (err) {
      // API 側の失敗だけをここで扱う(成功ハンドラ内の例外と混ぜない)
      if (!isCurrent(token)) return;
      // reset() / showError() による abort() が原因の AbortError はユーザーへの
      // エラー表示にしない。世代トークンの判定と同じ「古い世代は無視する」扱い(Issue #19)。
      if (err && err.name === "AbortError") return;
      // 502 に付いてきた request(Jev に渡したペイロード)は「このプロンプトで失敗」
      // としてパネルに残す(Issue #34)。request の無い 400/429/503 は直前の値のまま。
      if (err && err.request && typeof err.request === "object") {
        state.lastRequest = err.request;
        state.lastRequestFailed = true;
      }
      // 一時的な失敗(Issue #43、SPEC F5)は停止扱い(判定中のマスは queue の先頭に
      // 戻り、記録には残らない。pauseForTransientError() が stop() 相当の後始末をする)。
      // それ以外(400/401/415/502/形式不正など)は従来どおり showError()。
      if (err && err.transient) {
        pauseForTransientError(err);
        return;
      }
      showError(err && err.message ? err.message : String(err));
    }).catch(function (err) {
      // 成功ハンドラ(render など)が投げた場合。API エラーとは区別して表示する。
      if (!isCurrent(token)) return;
      showError("画面の更新に失敗しました: " + (err && err.message ? err.message : String(err)));
    });
  }

  // 一括モード(Issue #48)の周の入口。allResults(この周のキャッシュ)がまだ無ければ
  // askAllRound() で1回だけ呼び、届いたら1マスずつ focusCellFromCache() へ渡す。
  // 既にキャッシュがある(= 応答済み、または停止/再開で戻ってきた)ならすぐ次のマスへ。
  function focusNextAll(token) {
    if (queue.length === 0) {
      finalizeRound();
      return;
    }
    if (allResults === null) {
      askAllRound(token);
      return;
    }
    var cell = queue.shift();
    focusCellFromCache(cell, token);
  }

  // 一括モードの周ぶんの呼び出し。応答は "r0c2" 形式のキーで届くので "r-c" 形式に
  // 変換して allResults に持つ(state.values / focusedKey と同じキー形式に揃える)。
  function askAllRound(token) {
    state.allFetching = true;
    state.focusedKey = null;
    state.currentProbs = null;
    pendingCommit = null;
    render();

    var requestedCount = queue.length;
    inflightController = new AbortController();
    askAll(inflightController.signal).then(function (result) {
      if (!isCurrent(token)) return;
      if (result.request && typeof result.request === "object") {
        state.lastAllRequest = { request: result.request, failed: false, count: requestedCount };
      }
      var cells = result.cells;
      if (cells === null || typeof cells !== "object") {
        showError("一括の応答に cells がありません");
        return;
      }
      var converted = {};
      var keys = Object.keys(cells);
      for (var i = 0; i < keys.length; i++) {
        var m = /^r(\\d)c(\\d)$/.exec(keys[i]);
        if (!m) continue;
        converted[m[1] + "-" + m[2]] = cells[keys[i]];
      }
      // 1マスも確定する前に queue の全キーが揃っていることを確かめる(欠けを途中まで
      // appendRecord してから検出すると、壊れた応答由来の判定が記録に残ってしまうため)
      for (var qi = 0; qi < queue.length; qi++) {
        var qk = queue[qi].r + "-" + queue[qi].c;
        if (!converted[qk]) {
          showError("一括の応答に対象マスの回答がありません: " + qk);
          return;
        }
      }
      allResults = converted;
      state.allFetching = false;
      focusNextAll(token);
    }, function (err) {
      if (!isCurrent(token)) return;
      if (err && err.name === "AbortError") return;
      if (err && err.request && typeof err.request === "object") {
        state.lastAllRequest = { request: err.request, failed: true, count: requestedCount };
      }
      state.allFetching = false;
      // 一時的な失敗(Issue #43)は停止扱い(queue は変えていないので、再開は
      // 同じ周のまま askAllRound() をやり直す)。それ以外は従来どおり showError()。
      if (err && err.transient) {
        pauseForTransientError(err);
        return;
      }
      showError(err && err.message ? err.message : String(err));
    }).catch(function (err) {
      if (!isCurrent(token)) return;
      showError("画面の更新に失敗しました: " + (err && err.message ? err.message : String(err)));
    });
  }

  // 一括モードの1マスぶん。focusCellForDigit と同じ「フォーカス→バー表示→確定→次へ」の
  // 流れだが、judgeCell() を呼ばずキャッシュ(allResults)から読むだけなので fetch は
  // 発生しない(#48: 1周1回の呼び出しで済ませるのが目的)。
  function focusCellFromCache(cell, token) {
    var key = cell.r + "-" + cell.c;
    state.focusedKey = key;
    state.currentProbs = null;
    pendingCommit = null;
    render();

    var result = allResults ? allResults[key] : null;
    if (!result) {
      showError("一括の結果に対象マスがありません: " + key);
      return;
    }
    var probs = DIGITS.map(function (d) {
      var p = result.probabilities ? result.probabilities[d] : 0;
      return { digit: d, pct: Math.round((typeof p === "number" ? p : 0) * 100), isPick: d === result.choice };
    });
    state.currentProbs = probs;
    pendingCommit = { r: cell.r, c: cell.c, choice: result.choice, confidence: result.confidence, probabilities: result.probabilities };
    render();
    var beforeCommitMs = state.speedMode === "slow" ? SLOW_BEFORE_COMMIT_MS : FAST_BEFORE_COMMIT_MS;
    setTimeout(function () {
      if (!isCurrent(token)) return;
      commitFocused();
      var afterCommitMs = state.speedMode === "slow" ? SLOW_AFTER_COMMIT_MS : FAST_AFTER_COMMIT_MS;
      setTimeout(function () {
        if (!isCurrent(token)) return;
        focusNext();
      }, afterCommitMs);
    }, beforeCommitMs);
  }

  function commitFocused() {
    if (!pendingCommit) return;
    var r = pendingCommit.r;
    var c = pendingCommit.c;
    var key = r + "-" + c;
    // 確定待ちのマスが、いまフォーカスしているマスと違うなら何もしない
    if (state.focusedKey !== key) return;
    var correct = pendingCommit.choice === SOLUTION[r][c];
    state.values[key] = { value: pendingCommit.choice, status: correct ? "correct" : "incorrect" };
    roundTally.total += 1;
    if (correct) {
      roundTally.correct += 1;
    } else {
      roundWrong.push({ r: r, c: c });
    }
    // 集計ビュー用の記録(SPEC F1 拡張2)。正誤が確定したこの時点で1件追記する。
    var probs = pendingCommit.probabilities;
    var pc = probs && typeof probs[pendingCommit.choice] === "number" ? probs[pendingCommit.choice] : null;
    var conf = typeof pendingCommit.confidence === "number" ? pendingCommit.confidence : null;
    // 一括モード(Issue #48)は m を currentModelId() + "/all"(Jev なら "typesafe/jev/all"、
    // Claude なら例 "claude-opus-5+think/all")にし、o:"all" を添える(較正図で typesafe/jev/all のように
    // 別項目として絞り込めるように。SPEC 3章)。他のモードは従来どおり currentModelId()。
    var isAll = state.orderMode === "all";
    var modelId = isAll ? currentModelId() + "/all" : currentModelId();
    var record = {
      t: Date.now(),
      p: puzzleId(),
      r: r,
      c: c,
      round: state.round,
      choice: pendingCommit.choice,
      pc: pc,
      conf: conf,
      ok: correct,
      m: modelId // どのモデルの判定か(Issue #37)。無い記録は Jev 扱い
    };
    if (isAll) record.o = "all";
    appendRecord(record);
    // 次の結果が来るまで表示に残す(最速モードでも判定が見えるように)
    state.lastJudgment = {
      r: r,
      c: c,
      choice: pendingCommit.choice,
      confidence: pendingCommit.confidence,
      status: correct ? "correct" : "incorrect",
      probs: state.currentProbs
    };
    state.focusedKey = null;
    state.currentProbs = null;
    // 確信度順(Issue #38)のヒートマップは、このマスが確定したら消す
    // (次のマス選びまでヒートマップは出さない)。
    state.cellProbs = null;
    pendingCommit = null;
    render();
  }

  function finalizeRound() {
    var token = runToken;
    // 一括モード(Issue #48)のこの周のキャッシュは、周が変わるたびに空にする
    // (次の周は改めて askAllRound() で1回聞く)。
    allResults = null;
    state.roundLog.push(formatRoundSummary(state.round, roundTally.correct, roundTally.total));
    var decision = shouldStop(state.round, roundWrong.length);
    if (decision === "solved") {
      state.done = true;
      state.running = false;
      state.roundsToSolve = state.round;
      render();
      return;
    }
    if (decision === "limit") {
      state.done = true;
      state.running = false;
      state.stoppedAtLimit = true;
      render();
      return;
    }
    state.round += 1;
    queue = nextQueue(roundWrong);
    roundWrong = [];
    roundSize = queue.length;
    roundTally = { correct: 0, total: 0 };
    render();
    var betweenRoundsMs = state.speedMode === "slow" ? SLOW_BETWEEN_ROUNDS_MS : FAST_BETWEEN_ROUNDS_MS;
    setTimeout(function () {
      if (!isCurrent(token)) return;
      focusNext();
    }, betweenRoundsMs);
  }

  /**
   * 実行中の停止(SPEC F1、Issue #32)。reset() と違って盤面・周回ログ・統計を
   * 捨てない。state.values / state.round / state.roundLog / roundTally /
   * roundSize / queue / started はそのまま保ち、「実行」(= 再開)で続きから
   * 動かせるようにする(4.3、DESIGN.md 4.3 状態遷移)。
   *
   * runToken を進めて in-flight の fetch / 予約済みの setTimeout を無効化する点は
   * reset() / showError() と同じ。判定中(フォーカス中)のマスがあれば、まだ
   * commitFocused() されていない(結果待ち、または結果が確定待ちの)ものとして
   * queue の先頭に戻す。その結果は破棄し、記録(appendRecord)にも残さない。
   * 再開したら同じマスをもう一度聞く(SPEC F2)。
   *
   * 周をまたぐ待ち時間中(finalizeRound() の between-round の setTimeout 待ち)に
   * 呼ばれた場合は、finalizeRound() がそのタイマーを張る前に次の周の
   * round / queue / roundSize / roundTally を更新済みなので、focusedKey は
   * 既に null(commitFocused() で消えている)。このケースでは何もすることがなく、
   * 「実行」で押すと次の周の先頭から再開する(SPEC F3)。
   *
   * state.done / state.errorMessage のときは何もしない。両者は常に
   * running=false とセットで立つ(finalizeRound() / showError())ので、
   * running を見るだけで判定できる。
   */
  function stop() {
    haltRun(null);
  }

  /**
   * 実行を止める共通処理。stop()(手動停止、reason は null)と
   * pauseForTransientError()(一時的な失敗による停止、reason は理由文言)が使う。
   * 盤面・周回ログ・統計・queue は保ち、判定中(フォーカス中)のマスは queue の先頭に
   * 戻して記録に残さない。state.errorMessage は立てない(isPaused() が true になり、
   * 実行ボタンは「再開」になる)。
   */
  function haltRun(reason) {
    if (!state.running) return;
    // 世代を進めて、進行中の fetch / setTimeout のコールバックを無効化する
    runToken += 1;
    // in-flight の /api/judge があれば打ち切る(reset() / showError() と同じ、Issue #19)
    if (inflightController) {
      inflightController.abort();
      inflightController = null;
    }
    state.running = false;
    if (state.focusedKey) {
      var parts = state.focusedKey.split("-");
      queue.unshift({ r: Number(parts[0]), c: Number(parts[1]) });
    }
    pendingCommit = null;
    state.focusedKey = null;
    state.currentProbs = null;
    // 確信度順(Issue #38)のマス選び中に止めた場合: 選ばれたマスはまだ queue から
    // 取り除いていない(選び終わって初めて queue.splice する)ので再キューは不要。
    // 再開(run())はマス選びからやり直す。
    state.selecting = false;
    state.cellProbs = null;
    // 一括モード(Issue #48)の呼び出し中に止めた場合: in-flight は上で abort 済み。
    // queue は変えていない(askAllRound はまだ queue.shift() していない)ので再開は
    // 同じ周のまま askAllRound() をやり直す。allResults(キャッシュ)は保つ。
    state.allFetching = false;
    // 手動停止には理由が無い(null)。一時的な失敗による停止は理由文言を持つ(Issue #43)
    state.pauseReason = reason;
    render();
  }

  /**
   * 一時的な失敗による停止(Issue #43、SPEC F5)。Claude 経路の 429/529/5xx・
   * ネットワーク失敗、Jev 経路(Worker)の 429(レート制限)/503(カウンタ障害)を
   * judgeCell* / askCell* が err.transient = true で投げてきたときに使う。
   * stop() と同じ後始末(haltRun())をしたうえで、state.pauseReason に理由文言を持つ。
   * 確信度順のマス選び中の一時的な失敗も同じ扱い(queue は変えない。再開はマス選びからやり直す)。
   */
  function pauseForTransientError(err) {
    haltRun(buildPauseReason(err));
  }

  function buildPauseReason(err) {
    var message = err && err.message ? err.message : String(err);
    var reason = "一時的な失敗で停止しました: " + message;
    if (err && typeof err.retryAfter === "number" && isFinite(err.retryAfter)) {
      reason += "(" + err.retryAfter + "秒後に再試行できます)";
    }
    reason += " — 少し待って「再開」で続きから";
    return reason;
  }

  function showError(message) {
    // 世代を進めて、進行中の fetch / setTimeout のコールバックを無効化する
    runToken += 1;
    // in-flight の /api/judge があれば打ち切る(Issue #19)
    if (inflightController) {
      inflightController.abort();
      inflightController = null;
    }
    state.errorMessage = message;
    state.running = false;
    state.focusedKey = null;
    state.currentProbs = null;
    state.selecting = false;
    state.cellProbs = null;
    // エラー停止では一括モード(Issue #48)のキャッシュも捨てる(復帰はリセットのみ
    // なので、途中から再開することはない。SPEC F5)。
    state.allFetching = false;
    allResults = null;
    // errorMessage が立つとエラー停止が優先される(isPaused() は false)。以前の
    // 一時的な失敗の理由を残さない(Issue #43)。
    state.pauseReason = null;
    pendingCommit = null;
    render();
  }

  function setSpeed(mode) {
    state.speedMode = mode;
    render();
  }

  // 難易度トグル(SPEC F1)。変えただけでは盤面は変わらず、次の newPuzzle() から効く。
  function setDifficulty(mode) {
    state.difficulty = mode;
    render();
  }

  function reset() {
    // 世代を進める。進行中の fetch / setTimeout はこれで続きを実行しなくなる
    runToken += 1;
    // in-flight の /api/judge があれば打ち切る。newPuzzle() は内部で reset() を
    // 呼ぶので、これで newPuzzle() 時の abort も兼ねる(Issue #19)。
    if (inflightController) {
      inflightController.abort();
      inflightController = null;
    }
    var keepSpeed = state.speedMode;
    var keepDifficulty = state.difficulty;
    var keepModelMode = state.modelMode;
    var keepClaudeModel = state.claudeModel;
    var keepClaudeThinking = state.claudeThinking;
    var keepCalibFilter = state.calibModelFilter;
    var keepOrderMode = state.orderMode;
    state = {
      round: 1,
      values: {},
      focusedKey: null,
      currentProbs: null,
      roundLog: [],
      running: false,
      done: false,
      roundsToSolve: null,
      speedMode: keepSpeed,
      difficulty: keepDifficulty,
      errorMessage: null,
      stoppedAtLimit: false,
      lastJudgment: null,
      lastRequest: null,
      lastRequestFailed: false,
      modelMode: keepModelMode,
      claudeModel: keepClaudeModel,
      claudeThinking: keepClaudeThinking,
      calibModelFilter: keepCalibFilter,
      orderMode: keepOrderMode,
      selecting: false,
      cellProbs: null,
      lastSelection: null,
      lastCellRequest: null,
      allFetching: false,
      lastAllRequest: null,
      pauseReason: null
    };
    queue = [];
    roundWrong = [];
    roundTally = { correct: 0, total: 0 };
    roundSize = TOTAL_EMPTY;
    started = false;
    pendingCommit = null;
    allResults = null; // 一括モード(Issue #48)のキャッシュもリセット/新しい問題で捨てる
    render();
  }

  /**
   * 「新しい問題」。reset() で進行中のループを世代トークンごと無効化してから、
   * state.difficulty(reset() で維持される)に応じたヒント数で生成した盤面で
   * GIVEN / SOLUTION と派生値(TOTAL_EMPTY / roundSize)を差し替える。難易度を
   * 変えただけでは盤面は変わらず、この「新しい問題」の生成から効く。
   * 生成は同期処理(「むずかしい」で3回試行しても概ね数十ms以下)なので、いったん
   * 「生成中…」を描いてから setTimeout(0) で走らせ、画面が固まったように見えないようにする。
   */
  function newPuzzle() {
    if (generating) return;
    generating = true;
    reset(); // 世代を進めて進行中の fetch / setTimeout を無効化し、盤面表示も初期化する
    var targetGivens = DIFFICULTY_GIVENS[state.difficulty] || DEFAULT_TARGET_GIVENS;
    setTimeout(function () {
      try {
        var puzzle = generatePuzzleWithRetry(targetGivens);
        GIVEN = puzzle.given;
        SOLUTION = puzzle.solution;
        TOTAL_EMPTY = countEmpty(GIVEN);
        roundSize = TOTAL_EMPTY;
      } finally {
        generating = false;
      }
      render();
    }, 0);
  }

  // -------------------------------------------------------------------
  // URL パラメータ・埋め込みモード・比較モード(SPEC F1、Issue #46)
  // -------------------------------------------------------------------

  // location.search を最小限のクエリ文字列パーサーで読む(URLSearchParams への
  // 依存を避け、node:vm のテストハーネスに追加のグローバルを増やさないため)。
  // 同じキーが複数あれば最初の1つだけを使う。
  function parseQueryString(search) {
    var result = {};
    if (typeof search !== "string" || !search) return result;
    var qs = search.charAt(0) === "?" ? search.slice(1) : search;
    if (!qs) return result;
    var parts = qs.split("&");
    for (var i = 0; i < parts.length; i++) {
      if (!parts[i]) continue;
      var eq = parts[i].indexOf("=");
      var key = eq === -1 ? parts[i] : parts[i].slice(0, eq);
      var value = eq === -1 ? "" : parts[i].slice(eq + 1);
      try { key = decodeURIComponent(key.replace(/\\+/g, " ")); } catch (e) { continue; }
      try { value = decodeURIComponent(value.replace(/\\+/g, " ")); } catch (e) { value = ""; }
      if (!Object.prototype.hasOwnProperty.call(result, key)) result[key] = value;
    }
    return result;
  }

  // location.search を起動時に1回読む。通常ページ(GET /)の初期値の上書きに使う
  // (SPEC F1、Issue #46)。既知のキー・値以外は無視する(puzzle は形式チェックのみ
  // ここで行い、一意解の検証は applyPuzzleFromString() が行う)。
  function readUrlOptions() {
    var params = parseQueryString(typeof location !== "undefined" ? location.search : "");
    var opts = {};
    if (typeof params.puzzle === "string" && params.puzzle.length === 81) opts.puzzle = params.puzzle;
    if (params.model === "jev" || params.model === "claude") opts.model = params.model;
    if (params.order === "scan" || params.order === "confidence" || params.order === "all") opts.order = params.order;
    if (params.speed === "slow" || params.speed === "fast") opts.speed = params.speed;
    opts.embed = params.embed === "1";
    return opts;
  }

  // 81文字の文字列("1"〜"9" と "." のみ)を9行のスナップショットに分解する。
  // 形式が違えば null。
  function parsePuzzleString(str) {
    if (typeof str !== "string" || str.length !== 81 || !/^[1-9.]{81}$/.test(str)) return null;
    var rows = [];
    for (var r = 0; r < 9; r++) rows.push(str.slice(r * 9, r * 9 + 9));
    return rows;
  }

  // puzzle= パラメータ / message の newPuzzle の共通処理。一意解のときだけ
  // GIVEN / SOLUTION / TOTAL_EMPTY / roundSize を差し替えて true を返す(newPuzzle() が
  // ジェネレーターの結果を差し替えるのと同じ4項目。docs/DESIGN.md 4.2)。形式不正・
  // 非一意解はそのまま無視して false を返す(固定問題のまま)。
  function applyPuzzleFromString(str) {
    var rows = parsePuzzleString(str);
    if (!rows) return false;
    var solutions = [];
    if (solveCount(rows, 2, solutions) !== 1) return false;
    GIVEN = rows;
    SOLUTION = solutions[0];
    TOTAL_EMPTY = countEmpty(GIVEN);
    roundSize = TOTAL_EMPTY;
    return true;
  }

  // readUrlOptions() の結果を state / embedMode に適用する。localStorage には
  // 一切書き戻さない(通常ページの設定を汚さない。SPEC F1)。
  function applyUrlOptions(opts) {
    if (opts.puzzle) applyPuzzleFromString(opts.puzzle);
    if (opts.model) state.modelMode = opts.model;
    if (opts.order) state.orderMode = opts.order;
    if (opts.speed) state.speedMode = opts.speed;
    embedMode = !!opts.embed;
  }

  // state.values の中で status が "correct" の件数(累計正解数)。renderStats() と
  // postStatus() の両方が使う(重複を避けるための共通化)。
  function countCorrectValues() {
    var n = 0;
    for (var key in state.values) {
      if (Object.prototype.hasOwnProperty.call(state.values, key) && state.values[key].status === "correct") n++;
    }
    return n;
  }

  // 埋め込みモード(embed=1)の render() のたびに親(比較シェル)へ現況を知らせる
  // (SPEC F1、Issue #46)。iframe でない(window.parent === window)ときは何もしない。
  function postStatus() {
    if (!embedMode) return;
    if (typeof window === "undefined" || !window.parent || window.parent === window) return;
    var payload = {
      type: "status",
      model: currentModelId(),
      round: state.round,
      correct: countCorrectValues(),
      total: TOTAL_EMPTY,
      remaining: queue.length,
      running: state.running,
      paused: isPaused(),
      pauseReason: state.pauseReason,
      done: state.done,
      roundsToSolve: state.roundsToSolve,
      stoppedAtLimit: state.stoppedAtLimit,
      errorMessage: state.errorMessage
    };
    try {
      window.parent.postMessage(payload, location.origin);
    } catch (e) {
      // 親が受け取れなくても埋め込み表示自体は続ける
    }
  }

  // 埋め込みモードで親(比較シェル)からの操作を受け付ける(SPEC F1、Issue #46)。
  // 同一オリジンのメッセージだけを処理する(他オリジンは無視。7章)。
  function setupEmbedMessageListener() {
    window.addEventListener("message", function (event) {
      if (!event || event.origin !== location.origin) return;
      // 親(比較シェル)からのメッセージだけを受け付ける(同一オリジンの他ウィンドウは無視)
      if (event.source !== window.parent) return;
      var data = event.data;
      if (!data || typeof data !== "object") return;
      if (data.type === "run") { run(); return; }
      if (data.type === "stop") { stop(); return; }
      if (data.type === "reset") { reset(); return; }
      if (data.type === "newPuzzle" && typeof data.puzzle === "string") {
        if (applyPuzzleFromString(data.puzzle)) reset();
        return;
      }
      if (data.type === "setSpeed" && (data.mode === "slow" || data.mode === "fast")) { setSpeed(data.mode); return; }
      if (data.type === "setOrderMode" && typeof data.mode === "string") { setOrderMode(data.mode); return; }
    });
  }

  // -------------------------------------------------------------------
  // 比較シェル(GET /compare、Issue #46)。同じ PAGE_HTML を iframe で2枚並べ、
  // 親であるこのページが postMessage で同時に操作する(判定ループの state / queue /
  // 世代トークンはページに1組しかないため、2インスタンス化はしない。docs/DESIGN.md 8章)。
  // -------------------------------------------------------------------

  function compareIframeSrc(model) {
    var qs = "embed=1" +
      "&model=" + encodeURIComponent(model) +
      "&puzzle=" + encodeURIComponent(GIVEN.join("")) +
      "&speed=" + encodeURIComponent(state.speedMode) +
      "&order=" + encodeURIComponent(state.orderMode);
    return "/?" + qs;
  }

  // どちらか一方でも実行中なら「停止」を出す(片方がエラーで止まっても、もう片方を止められる
  // ように。レビュー指摘 S1)。子の stop() は止まっている側には何もしない。
  function compareEitherRunning() {
    return !!(compareStatus.jev && compareStatus.jev.running) || !!(compareStatus.claude && compareStatus.claude.running);
  }

  function compareEitherPaused() {
    return !!(compareStatus.jev && compareStatus.jev.paused) || !!(compareStatus.claude && compareStatus.claude.paused);
  }

  // 両 iframe から最初の status が届くまで(= 埋め込みページの message リスナーが用意できるまで)
  // 「実行」を押させない。押しても届かずに無言で終わるため(S3)。
  function compareFramesReady() {
    return compareStatus.jev !== null && compareStatus.claude !== null;
  }

  function compareStatusText(status) {
    if (!status) return "未実行";
    if (status.errorMessage) return "エラー: " + status.errorMessage;
    if (status.done) {
      return status.stoppedAtLimit ? "強制終了(" + MAX_ROUNDS + "周)" : "完了(" + status.roundsToSolve + "周)";
    }
    if (status.running) return "実行中";
    if (status.paused) return status.pauseReason ? "停止中(一時的な失敗)" : "停止中";
    return "未実行";
  }

  function compareElapsedSeconds() {
    if (!compareStartedAt) return 0;
    return Math.max(0, Math.floor((Date.now() - compareStartedAt) / 1000));
  }

  function renderCompareTopbarHtml() {
    var running = compareEitherRunning();
    var ready = compareFramesReady();
    var runLabel = running ? "停止" : ready ? "実行" : "読み込み中…";
    var runOnclick = running ? "compareStop()" : "compareRun()";
    var runDisabled = ready ? "" : "disabled";
    // 順番は実行中・停止中(周の途中)に変えない(子の setOrderMode と同じロック。S2)
    var orderDisabled = running || compareEitherPaused() ? "disabled" : "";
    var slowActive = state.speedMode === "slow" ? " active" : "";
    var fastActive = state.speedMode === "fast" ? " active" : "";
    var scanActive = state.orderMode === "scan" ? " active" : "";
    var confidenceActive = state.orderMode === "confidence" ? " active" : "";
    var allOrderActive = state.orderMode === "all" ? " active" : "";
    var easyActive = state.difficulty === "easy" ? " active" : "";
    var normalActive = state.difficulty === "normal" ? " active" : "";
    var hardActive = state.difficulty === "hard" ? " active" : "";
    var newDisabled = compareGenerating ? "disabled" : "";
    var newLabel = compareGenerating ? "生成中…" : "新しい問題";
    return "<div class=\\"controls\\">" +
      "<button id=\\"compare-run-btn\\" onclick=\\"" + runOnclick + "\\" " + runDisabled + ">" + runLabel + "</button>" +
      "<button id=\\"compare-reset-btn\\" onclick=\\"compareReset()\\">リセット</button>" +
      "<button id=\\"compare-new-btn\\" onclick=\\"compareNewPuzzle()\\" " + newDisabled + ">" + newLabel + "</button>" +
      "<div id=\\"speed-toggle\\">" +
      "<button class=\\"speed-btn" + slowActive + "\\" onclick=\\"compareSetSpeed('slow')\\">じっくり確認</button>" +
      "<button class=\\"speed-btn" + fastActive + "\\" onclick=\\"compareSetSpeed('fast')\\">最速</button>" +
      "</div>" +
      "<div id=\\"order-toggle\\">" +
      "<button class=\\"order-btn" + scanActive + "\\" onclick=\\"compareSetOrderMode('scan')\\" " + orderDisabled + ">左上から</button>" +
      "<button class=\\"order-btn" + confidenceActive + "\\" onclick=\\"compareSetOrderMode('confidence')\\" " + orderDisabled + ">確信度順</button>" +
      "<button class=\\"order-btn" + allOrderActive + "\\" onclick=\\"compareSetOrderMode('all')\\" " + orderDisabled + ">一括</button>" +
      "</div>" +
      "<div id=\\"difficulty-toggle\\">" +
      "<button class=\\"difficulty-btn" + easyActive + "\\" onclick=\\"compareSetDifficulty('easy')\\">やさしい</button>" +
      "<button class=\\"difficulty-btn" + normalActive + "\\" onclick=\\"compareSetDifficulty('normal')\\">ふつう</button>" +
      "<button class=\\"difficulty-btn" + hardActive + "\\" onclick=\\"compareSetDifficulty('hard')\\">むずかしい</button>" +
      "</div>" +
      "</div>";
  }

  function renderCompareStatusHtml(which) {
    var status = compareStatus[which];
    // モデル名は子が status で申告したもの(子の設定を正とする)。届く前は親の設定で仮表示。
    var modelId = status && typeof status.model === "string" ? status.model : which === "jev" ? JEV_MODEL_ID : state.claudeModel;
    var round = escapeHtml(String(status ? status.round : 1));
    var correct = escapeHtml(String(status ? status.correct : 0));
    var total = escapeHtml(String(status ? status.total : TOTAL_EMPTY));
    var notice = "";
    if (which === "claude" && loadAnthropicKey() === null) {
      notice = "<div class=\\"compare-notice\\">Claude のキー未設定(通常ページの設定パネルで保存してください)</div>";
    }
    return "<h2>" + escapeHtml(modelId) + "</h2>" +
      "<div class=\\"compare-meta\\">経過 " + compareElapsedSeconds() + "秒 ・ " + round + "周目 ・ 正解 " + correct + " / " + total + " ・ " + escapeHtml(compareStatusText(status)) + "</div>" +
      notice;
  }

  function renderCompareTopbarInPlace() {
    if (compareEls.topbar) compareEls.topbar.innerHTML = renderCompareTopbarHtml();
  }

  function renderCompareStatusInPlace(which) {
    var el = which === "jev" ? compareEls.statusJev : compareEls.statusClaude;
    if (el) el.innerHTML = renderCompareStatusHtml(which);
  }

  function comparePostToFrames(message) {
    if (compareFrames.jev && compareFrames.jev.contentWindow) {
      compareFrames.jev.contentWindow.postMessage(message, location.origin);
    }
    if (compareFrames.claude && compareFrames.claude.contentWindow) {
      compareFrames.claude.contentWindow.postMessage(message, location.origin);
    }
  }

  function compareRun() {
    if (compareEitherRunning()) { compareStop(); return; }
    if (!compareFramesReady()) return;
    compareStartedAt = Date.now();
    comparePostToFrames({ type: "run" });
    renderCompareTopbarInPlace();
  }

  function compareStop() {
    comparePostToFrames({ type: "stop" });
    renderCompareTopbarInPlace();
  }

  function compareReset() {
    compareStartedAt = null;
    compareStatus = { jev: null, claude: null };
    comparePostToFrames({ type: "reset" });
    renderCompareTopbarInPlace();
    renderCompareStatusInPlace("jev");
    renderCompareStatusInPlace("claude");
  }

  function compareSetSpeed(mode) {
    if (mode !== "slow" && mode !== "fast") return;
    state.speedMode = mode;
    comparePostToFrames({ type: "setSpeed", mode: mode });
    renderCompareTopbarInPlace();
  }

  function compareSetOrderMode(mode) {
    if (mode !== "scan" && mode !== "confidence" && mode !== "all") return;
    if (compareEitherRunning() || compareEitherPaused()) return; // 子と同じロック(S2)
    state.orderMode = mode;
    comparePostToFrames({ type: "setOrderMode", mode: mode });
    renderCompareTopbarInPlace();
  }

  function compareSetDifficulty(mode) {
    if (mode !== "easy" && mode !== "normal" && mode !== "hard") return;
    state.difficulty = mode;
    renderCompareTopbarInPlace();
  }

  // 「新しい問題」(比較シェル版)。既存の generatePuzzleWithRetry() で盤面を作り、
  // 両 iframe に newPuzzle を送る(iframe 自体は作り直さない。src の差し替えによる
  // 再読み込みをしない設計。docs/DESIGN.md 8章)。
  function compareNewPuzzle() {
    if (compareGenerating) return;
    compareGenerating = true;
    renderCompareTopbarInPlace();
    var targetGivens = DIFFICULTY_GIVENS[state.difficulty] || DEFAULT_TARGET_GIVENS;
    setTimeout(function () {
      try {
        var puzzle = generatePuzzleWithRetry(targetGivens);
        GIVEN = puzzle.given;
        SOLUTION = puzzle.solution;
        TOTAL_EMPTY = countEmpty(GIVEN);
        roundSize = TOTAL_EMPTY;
        compareStartedAt = null;
        compareStatus = { jev: null, claude: null };
        comparePostToFrames({ type: "newPuzzle", puzzle: GIVEN.join("") });
      } finally {
        compareGenerating = false;
      }
      renderCompareTopbarInPlace();
      renderCompareStatusInPlace("jev");
      renderCompareStatusInPlace("claude");
    }, 0);
  }

  function updateCompareStatus(which, status) {
    compareStatus[which] = status;
    renderCompareStatusInPlace(which);
    renderCompareTopbarInPlace();
  }

  // 子(iframe)からの status メッセージを受け取る。同一オリジンかつ、どちらの
  // iframe から届いたか(event.source)を確認してから振り分ける(7章)。
  function setupCompareMessageListener() {
    window.addEventListener("message", function (event) {
      if (!event || event.origin !== location.origin) return;
      var data = event.data;
      if (!data || typeof data !== "object" || data.type !== "status") return;
      if (compareFrames.jev && event.source === compareFrames.jev.contentWindow) { updateCompareStatus("jev", data); return; }
      if (compareFrames.claude && event.source === compareFrames.claude.contentWindow) { updateCompareStatus("claude", data); return; }
    });
  }

  // 比較シェルの初期描画。app.innerHTML を組み立てるのはここで最初の1回だけ
  // (iframe を含むため。以後の更新は renderCompareTopbarInPlace() /
  // renderCompareStatusInPlace() が sub要素だけを差し替える。docs/DESIGN.md 8章)。
  function renderCompareShell() {
    var app = document.getElementById("app");
    if (app.style) app.style.maxWidth = "1600px"; // 通常ページの 960px では 2 枚並べると窮屈(S5)
    app.innerHTML =
      "<h1>数独キャリブレーションチェック — 比較モード</h1>" +
      "<p class=\\"subtitle\\">同じ問題を Jev と Claude に同時に解かせて見比べる ・ <a href=\\"/\\">通常モードへ</a></p>" +
      "<div class=\\"compare-topbar\\">" + renderCompareTopbarHtml() + "</div>" +
      "<div class=\\"compare-frames\\">" +
      "<div class=\\"compare-col\\">" +
      "<div class=\\"compare-status\\">" + renderCompareStatusHtml("jev") + "</div>" +
      "<iframe class=\\"compare-frame\\" src=\\"" + escapeHtml(compareIframeSrc("jev")) + "\\"></iframe>" +
      "</div>" +
      "<div class=\\"compare-col\\">" +
      "<div class=\\"compare-status\\">" + renderCompareStatusHtml("claude") + "</div>" +
      "<iframe class=\\"compare-frame\\" src=\\"" + escapeHtml(compareIframeSrc("claude")) + "\\"></iframe>" +
      "</div>" +
      "</div>";
    var topbarEls = document.querySelectorAll(".compare-topbar");
    compareEls.topbar = topbarEls[0];
    var statusEls = document.querySelectorAll(".compare-status");
    compareEls.statusJev = statusEls[0];
    compareEls.statusClaude = statusEls[1];
    var frameEls = document.querySelectorAll(".compare-frame");
    compareFrames.jev = frameEls[0];
    compareFrames.claude = frameEls[1];
    setupCompareMessageListener();
  }

  // -------------------------------------------------------------------
  // 描画(docs/DESIGN.md 4.4)。state から毎回 innerHTML で作り直す。
  // -------------------------------------------------------------------
  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, function (ch) {
      if (ch === "&") return "&amp;";
      if (ch === "<") return "&lt;";
      if (ch === ">") return "&gt;";
      if (ch === "\\"") return "&quot;";
      return "&#39;";
    });
  }

  function buildCellStyle(r, c) {
    var key = r + "-" + c;
    var given = GIVEN[r][c] !== ".";
    var isFocused = state.focusedKey === key;
    var cell = isFocused ? null : state.values[key];

    var color = "var(--text)";
    var bg = "transparent";
    var fontWeight = "400";
    if (given) {
      color = "var(--given)";
      fontWeight = "700";
    } else if (cell) {
      if (cell.status === "correct") {
        color = "var(--correct)";
        bg = "var(--correct-bg)";
      } else {
        color = "var(--incorrect)";
        bg = "var(--incorrect-bg)";
      }
    } else if (!isFocused && state.cellProbs && Object.prototype.hasOwnProperty.call(state.cellProbs, key)) {
      // 確信度順モード(Issue #38)のヒートマップ: マス選びの確率が高いほど背景を濃くする。
      // 判定済み(cell あり)・フォーカス中のマスは対象外(上の分岐で既に確定しているため)。
      // 2 周目以降の候補マスは前の周の不正解値(赤背景)を持つので上の分岐に入り、
      // ヒートマップは事実上 1 周目(候補がまだ空のとき)だけ出る(SPEC F1)。
      var pmax = typeof state.cellProbsMax === "number" ? state.cellProbsMax : 0;
      if (pmax > 0) {
        // 確率が負や pmax 超え(Worker は範囲を検証しない)でも rgba の α を 0〜1 に収める。
        var alpha = Math.max(0, Math.min(1, 0.08 + 0.6 * (state.cellProbs[key] / pmax)));
        bg = "rgba(125, 211, 252, " + alpha.toFixed(3) + ")";
      }
    }

    var borderTop = r % 3 === 0 ? "3px solid var(--thick-border)" : "1px solid var(--border)";
    var borderLeft = c % 3 === 0 ? "3px solid var(--thick-border)" : "1px solid var(--border)";
    var borderRight = c === 8 ? "3px solid var(--thick-border)" : "1px solid var(--border)";
    var borderBottom = r === 8 ? "3px solid var(--thick-border)" : "1px solid var(--border)";

    var style = "border-top:" + borderTop + ";border-left:" + borderLeft +
      ";border-right:" + borderRight + ";border-bottom:" + borderBottom +
      ";color:" + color + ";background:" + bg + ";font-weight:" + fontWeight + ";";
    if (isFocused) style += "box-shadow: inset 0 0 0 3px var(--accent);";
    return style;
  }

  function renderGrid() {
    var cells = "";
    for (var r = 0; r < 9; r++) {
      for (var c = 0; c < 9; c++) {
        var key = r + "-" + c;
        var given = GIVEN[r][c];
        var display = "";
        if (given !== ".") {
          display = given;
        } else if (key !== state.focusedKey) {
          var cell = state.values[key];
          if (cell) display = cell.value;
        }
        cells += "<div class=\\"cell\\" style=\\"" + buildCellStyle(r, c) + "\\">" + escapeHtml(display) + "</div>";
      }
    }
    return "<div id=\\"grid\\" class=\\"grid\\">" + cells + "</div>";
  }

  function renderLegend() {
    var items =
      "<span class=\\"legend-item\\"><span class=\\"swatch swatch-correct\\"></span>正解</span>" +
      "<span class=\\"legend-item\\"><span class=\\"swatch swatch-incorrect\\"></span>不正解</span>" +
      "<span class=\\"legend-item\\"><span class=\\"swatch swatch-focus\\"></span>判定中</span>";
    // 確信度順モード(Issue #38)のときだけヒートマップの凡例を足す。
    if (state.orderMode === "confidence") {
      items += "<span class=\\"legend-item\\">背景の濃さ = マス選びの確率</span>";
    }
    return "<div id=\\"legend\\" class=\\"legend\\">" + items + "</div>";
  }

  function renderControls() {
    // 実行中は「実行」ボタンを「停止」に切り替える(id は run-btn のまま。Issue #32)。
    // 停止中(isPaused())はラベルを「再開」にする。実行中は無効化しない(停止できる必要がある)。
    var paused = isPaused();
    var runLabel = state.running ? "停止" : paused ? "再開" : "実行";
    var runOnclick = state.running ? "stop()" : "run()";
    var runDisabled = state.running ? "" : state.done || state.errorMessage || generating ? "disabled" : "";
    // 生成中・実行中は問題を差し替えない(実行中の差し替えは盤面と周回ログの意味を壊す)。
    // 停止中(state.running===false)は「新しい問題」を押せる(Issue #32)。
    var newDisabled = state.running || generating ? "disabled" : "";
    // リセットは進行中の判定があっても安全に行える(SPEC F5、世代トークンが古い連鎖を無効化する)。
    // 停止中も押せる(Issue #32)。生成中だけは差し替え中の盤面と衝突するので無効化する。
    var resetDisabled = generating ? "disabled" : "";
    var newLabel = generating ? "生成中…" : "新しい問題";
    var slowActive = state.speedMode === "slow" ? " active" : "";
    var fastActive = state.speedMode === "fast" ? " active" : "";
    var easyActive = state.difficulty === "easy" ? " active" : "";
    var normalActive = state.difficulty === "normal" ? " active" : "";
    var hardActive = state.difficulty === "hard" ? " active" : "";
    var jevActive = state.modelMode === "jev" ? " active" : "";
    var claudeActive = state.modelMode === "claude" ? " active" : "";
    var modelDisabled = modelSettingsLocked() ? "disabled" : "";
    // 順番トグル(左上から / 確信度順 / 一括、Issue #38・#48)。モデルトグルと同じ条件でロックする。
    var scanActive = state.orderMode === "scan" ? " active" : "";
    var confidenceActive = state.orderMode === "confidence" ? " active" : "";
    var allOrderActive = state.orderMode === "all" ? " active" : "";
    var orderDisabled = modelSettingsLocked() ? "disabled" : "";
    return "<div class=\\"controls\\">" +
      "<button id=\\"run-btn\\" onclick=\\"" + runOnclick + "\\" " + runDisabled + ">" + runLabel + "</button>" +
      "<button id=\\"reset-btn\\" onclick=\\"reset()\\" " + resetDisabled + ">リセット</button>" +
      "<button id=\\"new-puzzle-btn\\" onclick=\\"newPuzzle()\\" " + newDisabled + ">" + newLabel + "</button>" +
      "<div id=\\"speed-toggle\\">" +
      "<button class=\\"speed-btn" + slowActive + "\\" onclick=\\"setSpeed('slow')\\">じっくり確認</button>" +
      "<button class=\\"speed-btn" + fastActive + "\\" onclick=\\"setSpeed('fast')\\">最速</button>" +
      "</div>" +
      "<div id=\\"difficulty-toggle\\">" +
      "<button class=\\"difficulty-btn" + easyActive + "\\" aria-pressed=\\"" + (state.difficulty === "easy") + "\\" onclick=\\"setDifficulty('easy')\\">やさしい</button>" +
      "<button class=\\"difficulty-btn" + normalActive + "\\" aria-pressed=\\"" + (state.difficulty === "normal") + "\\" onclick=\\"setDifficulty('normal')\\">ふつう</button>" +
      "<button class=\\"difficulty-btn" + hardActive + "\\" aria-pressed=\\"" + (state.difficulty === "hard") + "\\" onclick=\\"setDifficulty('hard')\\">むずかしい</button>" +
      "</div>" +
      "<div id=\\"model-toggle\\">" +
      "<button class=\\"model-btn" + jevActive + "\\" aria-pressed=\\"" + (state.modelMode === "jev") + "\\" onclick=\\"setModelMode('jev')\\" " + modelDisabled + ">Jev</button>" +
      "<button class=\\"model-btn" + claudeActive + "\\" aria-pressed=\\"" + (state.modelMode === "claude") + "\\" onclick=\\"setModelMode('claude')\\" " + modelDisabled + ">Claude</button>" +
      "</div>" +
      "<div id=\\"order-toggle\\">" +
      "<button class=\\"order-btn" + scanActive + "\\" aria-pressed=\\"" + (state.orderMode === "scan") + "\\" onclick=\\"setOrderMode('scan')\\" " + orderDisabled + ">左上から</button>" +
      "<button class=\\"order-btn" + confidenceActive + "\\" aria-pressed=\\"" + (state.orderMode === "confidence") + "\\" onclick=\\"setOrderMode('confidence')\\" " + orderDisabled + ">確信度順</button>" +
      "<button class=\\"order-btn" + allOrderActive + "\\" aria-pressed=\\"" + (state.orderMode === "all") + "\\" onclick=\\"setOrderMode('all')\\" " + orderDisabled + ">一括</button>" +
      "</div>" +
      "</div>";
  }

  // Claude の設定パネル(Issue #37)。モデルトグルが Claude のときだけ出す。
  // キーの値そのものは DOM に出さない(末尾 4 文字のヒントだけ)。
  function renderClaudeSettings() {
    if (state.modelMode !== "claude") return "";
    var locked = modelSettingsLocked() ? "disabled" : "";
    var hasKey = loadAnthropicKey() !== null;
    var options = "";
    for (var i = 0; i < CLAUDE_MODELS.length; i++) {
      options += "<option value=\\"" + CLAUDE_MODELS[i] + "\\"" + (state.claudeModel === CLAUDE_MODELS[i] ? " selected" : "") + ">" + CLAUDE_MODELS[i] + "</option>";
    }
    var thinkOn = state.claudeThinking ? " active" : "";
    var thinkOff = state.claudeThinking ? "" : " active";
    return "<div id=\\"claude-settings\\" class=\\"panel\\">" +
      "<p class=\\"panel-title\\">Claude の設定(BYOK)</p>" +
      "<div class=\\"claude-row\\">" +
      "<label for=\\"anthropic-key-input\\">API キー</label>" +
      "<input id=\\"anthropic-key-input\\" type=\\"password\\" placeholder=\\"sk-ant-…\\" autocomplete=\\"off\\" spellcheck=\\"false\\">" +
      "<button id=\\"save-key-btn\\" onclick=\\"saveAnthropicKeyFromInput()\\">保存</button>" +
      "<button id=\\"clear-key-btn\\" onclick=\\"clearAnthropicKey()\\" " + (hasKey && !modelSettingsLocked() ? "" : "disabled") + ">キーを消す</button>" +
      "<span class=\\"muted\\">" + escapeHtml(anthropicKeyHint()) + "</span>" +
      (claudeKeyNotice ? "<span class=\\"claude-notice\\">" + escapeHtml(claudeKeyNotice) + "</span>" : "") +
      "</div>" +
      "<p class=\\"muted\\">キーはこのブラウザの localStorage にだけ保存し、api.anthropic.com への呼び出し以外には送りません(この Worker には渡りません)。利用料は自分の Anthropic アカウントに課金されます(1 問あたり約 78 回、確信度順ではその倍呼びます。この経路にレート制限はありません)。</p>" +
      "<div class=\\"claude-row\\">" +
      "<label for=\\"claude-model\\">モデル</label>" +
      "<select id=\\"claude-model\\" onchange=\\"setClaudeModel(this.value)\\" " + locked + ">" + options + "</select>" +
      "<div id=\\"thinking-toggle\\">" +
      "<button class=\\"thinking-btn" + thinkOn + "\\" aria-pressed=\\"" + state.claudeThinking + "\\" onclick=\\"setClaudeThinking(true)\\" " + locked + ">思考あり</button>" +
      "<button class=\\"thinking-btn" + thinkOff + "\\" aria-pressed=\\"" + !state.claudeThinking + "\\" onclick=\\"setClaudeThinking(false)\\" " + locked + ">思考なし</button>" +
      "</div>" +
      "</div>" +
      "</div>";
  }

  function renderErrorBox() {
    if (!state.errorMessage) return "<div id=\\"error-box\\"></div>";
    return "<div id=\\"error-box\\" class=\\"error\\">" + escapeHtml(state.errorMessage) + "</div>";
  }

  function statCard(label, value) {
    return "<div class=\\"stat-card\\"><div class=\\"stat-label\\">" + escapeHtml(label) + "</div><div class=\\"stat-value\\">" + escapeHtml(value) + "</div></div>";
  }

  function renderStats() {
    var correctCount = countCorrectValues();
    var remaining = TOTAL_EMPTY - correctCount;
    var roundPct = roundSize === 0 ? 0 : Math.round((roundTally.total / roundSize) * 100);
    return "<div id=\\"stats\\" class=\\"stats\\">" +
      statCard("現在の周", state.round + "周目") +
      statCard("残りマス", remaining + " / " + TOTAL_EMPTY) +
      statCard("累計正解", correctCount + "問") +
      statCard("この周の進捗", roundTally.total + " / " + roundSize + " (" + roundPct + "%)") +
      "</div>";
  }

  function coordLabel(r, c) {
    return (r + 1) + "行目 " + (c + 1) + "列目";
  }

  // 1〜9の確率バー。並びは常に 1〜9 の昇順(不変条件3)。choice の棒だけアクセント色。
  function renderBars(probs) {
    return probs.map(function (p) {
      var barColor = p.isPick ? "var(--accent)" : "var(--border)";
      return "<div class=\\"bar-row\\"><span class=\\"bar-label\\">" + p.digit + "</span>" +
        "<div class=\\"bar-track\\"><div class=\\"bar-fill\\" style=\\"width:" + p.pct + "%;background:" + barColor + ";\\"></div></div>" +
        "<span class=\\"bar-pct\\">" + p.pct + "%</span></div>";
    }).join("");
  }

  // 確信度順モード(Issue #38)の「マス選び: N 候補中 r行c列(p%)/ confidence q%」行。
  // state.lastSelection が無ければ何も出さない(まだ一度もマス選びをしていない)。
  function renderSelectionLine() {
    var sel = state.lastSelection;
    if (!sel) return "";
    var pctText = typeof sel.p === "number" ? Math.round(sel.p * 100) + "%" : "?";
    var confText = typeof sel.confidence === "number" ? Math.round(sel.confidence * 100) + "%" : "?";
    return "<div class=\\"coords\\">マス選び: " + sel.candidates + " 候補中 " + coordLabel(sel.r, sel.c) +
      "(" + pctText + ") / confidence " + confText + "</div>";
  }

  function renderCurrentPanel() {
    var head = "<div id=\\"current-panel\\" class=\\"panel\\"><p class=\\"panel-title\\">現在の判定</p>";
    var tail = "</div>";

    // 停止中(Issue #32): 残りマス数を示し、フォーカスの枠線は消える
    // (state.focusedKey が null なので buildCellStyle 側で自然に消える)。
    // 直前に確定した判定があれば、参考として下に残す。
    if (isPaused()) {
      var pausedBody = "<p class=\\"muted\\">停止中(残り " + queue.length + " マス)</p>";
      // 一時的な失敗による停止(Issue #43)は理由を添える。手動停止(state.pauseReason
      // が null のまま)では出ない。
      if (state.pauseReason) {
        pausedBody += "<div class=\\"pause-reason\\">" + escapeHtml(state.pauseReason) + "</div>";
      }
      var pausedLast = state.lastJudgment;
      if (pausedLast && pausedLast.probs) {
        var pausedStatusText = pausedLast.status === "correct" ? "正解" : "不正解";
        var pausedConfidence = typeof pausedLast.confidence === "number" ? " / confidence " + Math.round(pausedLast.confidence * 100) + "%" : "";
        pausedBody += "<div class=\\"coords\\"><span class=\\"confidence\\">直前: " + coordLabel(pausedLast.r, pausedLast.c) +
          " → " + escapeHtml(pausedLast.choice) + "(" + pausedStatusText + ")" + pausedConfidence + "</span></div>" +
          "<div class=\\"bars\\">" + renderBars(pausedLast.probs) + "</div>";
      }
      return head + pausedBody + tail;
    }

    // 確信度順モード(Issue #38)のマス選び中: マス選びの結果が届くまでは座標もバーも無い。
    if (state.selecting) {
      return head + "<p class=\\"muted\\">マス選び中…(候補 " + queue.length + " マス)</p>" + tail;
    }

    // 一括モード(Issue #48)の呼び出し中: 応答が届くまでは座標もバーも無い。
    if (state.allFetching) {
      return head + "<p class=\\"muted\\">一括で判定中…(" + queue.length + " マス)</p>" + tail;
    }

    // 結果が届いている最中のマス: 座標とバーをそのまま出す
    if (state.focusedKey && state.currentProbs) {
      var parts = state.focusedKey.split("-");
      var confidenceText = "";
      if (pendingCommit && typeof pendingCommit.confidence === "number") {
        confidenceText = "<span class=\\"confidence\\">confidence " + Math.round(pendingCommit.confidence * 100) + "%</span>";
      }
      var selLine1 = state.orderMode === "confidence" ? renderSelectionLine() : "";
      return head + selLine1 +
        "<div class=\\"coords\\">" + coordLabel(Number(parts[0]), Number(parts[1])) + confidenceText + "</div>" +
        "<div class=\\"bars\\">" + renderBars(state.currentProbs) + "</div>" + tail;
    }

    // 待ち時間中は「いま聞いているマス」+「直前に確定した判定」を並べる。
    // 最速モードでも結果が一瞬で消えないようにするため(DESIGN 4.4)。
    var body = "";
    if (state.focusedKey) {
      if (state.orderMode === "confidence") body += renderSelectionLine();
      var p2 = state.focusedKey.split("-");
      body += "<div class=\\"coords\\">" + coordLabel(Number(p2[0]), Number(p2[1])) +
        "<span class=\\"confidence\\">判定中…</span></div>";
    }
    var last = state.lastJudgment;
    if (last && last.probs) {
      var statusText = last.status === "correct" ? "正解" : "不正解";
      var lastConfidence = typeof last.confidence === "number" ? " / confidence " + Math.round(last.confidence * 100) + "%" : "";
      body += "<div class=\\"coords\\"><span class=\\"confidence\\">直前: " + coordLabel(last.r, last.c) +
        " → " + escapeHtml(last.choice) + "(" + statusText + ")" + lastConfidence + "</span></div>" +
        "<div class=\\"bars\\">" + renderBars(last.probs) + "</div>";
      return head + body + tail;
    }
    if (state.focusedKey) return head + body + "<p class=\\"muted\\">判定中…</p>" + tail;
    return head + "<p class=\\"muted\\">待機中</p>" + tail;
  }

  // req(request 相当のオブジェクト)1件ぶんの表示ブロック。target があれば座標を、
  // failed なら「(このプロンプトで失敗)」を添え、heading があれば見出しを出す
  // (確信度順モードの「マス選び」/「数字」の2段、Issue #38)。
  function renderRequestBlock(req, failed, heading) {
    var target = req.state && req.state.target;
    var usedFor = "";
    var failedNote = failed ? "(このプロンプトで失敗)" : "";
    if (target && typeof target.row === "number" && typeof target.col === "number") {
      usedFor = "<p class=\\"muted\\">" + escapeHtml(coordLabel(target.row, target.col)) + " の判定に使用" + failedNote + "</p>";
    } else if (failedNote) {
      usedFor = "<p class=\\"muted\\">" + failedNote + "</p>";
    }
    var headingHtml = heading ? "<p class=\\"muted\\">" + escapeHtml(heading) + "</p>" : "";
    return headingHtml + usedFor +
      "<pre class=\\"prompt-json\\">" + escapeHtml(JSON.stringify(req, null, 2)) + "</pre>";
  }

  // 一括モード(Issue #48)の「モデルに送ったプロンプト」1件ぶん。1周ぶんの request は
  // 空マスの数だけ質問を含み大きいので、「質問 N 問」の要約行 + 折りたたみ(<details>)で出す
  // (allReq = { request, failed, count })。
  function renderAllRequestBlock(allReq) {
    var failedNote = allReq.failed ? "(このプロンプトで失敗)" : "";
    var summary = "<p class=\\"muted\\">一括: 質問 " + allReq.count + " 問" + failedNote + "</p>";
    return summary + "<details class=\\"prompt-details\\"><summary>プロンプトを表示</summary>" +
      "<pre class=\\"prompt-json\\">" + escapeHtml(JSON.stringify(allReq.request, null, 2)) + "</pre></details>";
  }

  // 「モデルに送ったプロンプト」パネル(Issue #34、#37、#38)。Jev なら Worker が env.AI.run に渡した
  // ペイロード(request)をそのまま JSON で表示する。フロント側で組み立て直さない
  // (handleJudge と二重管理にしないため)。停止中・エラー時も直近の値を残す。
  // 確信度順モードでは、マス選び(state.lastCellRequest)と数字(state.lastRequest)を
  // 見出し付きで2段に並べる。左上からのときは従来どおり数字のリクエスト1つだけ。
  function renderPromptPanel() {
    var head = "<div id=\\"prompt-panel\\" class=\\"panel\\"><p class=\\"panel-title\\">モデルに送ったプロンプト</p>";
    var tail = "</div>";

    // 一括モード(Issue #48)は「一括」1段(質問N問の要約 + 折りたたみ)。
    if (state.orderMode === "all") {
      var allReq = state.lastAllRequest;
      if (!allReq) {
        return head + "<p class=\\"muted\\">まだ判定していません(実行すると直近の一括判定に使ったプロンプトが表示されます)</p>" + tail;
      }
      return head + renderAllRequestBlock(allReq) + tail;
    }

    if (state.orderMode !== "confidence") {
      var req = state.lastRequest;
      if (!req) {
        return head + "<p class=\\"muted\\">まだ判定していません(実行すると直近の判定に使ったプロンプトが表示されます)</p>" + tail;
      }
      return head + renderRequestBlock(req, state.lastRequestFailed, null) + tail;
    }

    if (!state.lastCellRequest && !state.lastRequest) {
      return head + "<p class=\\"muted\\">まだ判定していません(実行すると直近の判定に使ったプロンプトが表示されます)</p>" + tail;
    }
    var body = "";
    if (state.lastCellRequest) {
      body += renderRequestBlock(state.lastCellRequest, false, "マス選び");
    }
    if (state.lastRequest) {
      body += renderRequestBlock(state.lastRequest, state.lastRequestFailed, "数字");
    }
    return head + body + tail;
  }

  function renderRoundLog() {
    if (state.roundLog.length === 0) {
      return "<div id=\\"round-log\\" class=\\"panel\\"><p class=\\"panel-title\\">周回ログ</p><p class=\\"muted\\">まだ記録はありません</p></div>";
    }
    var items = state.roundLog.map(function (line) {
      return "<li>" + escapeHtml(line) + "</li>";
    }).join("");
    return "<div id=\\"round-log\\" class=\\"panel\\"><p class=\\"panel-title\\">周回ログ</p><ul>" + items + "</ul></div>";
  }

  function renderBanner() {
    if (state.done && state.roundsToSolve) {
      return "<div id=\\"completion-banner\\" class=\\"banner success\\">" + state.roundsToSolve + "周ですべて正解しました</div>";
    }
    if (state.done && state.stoppedAtLimit) {
      return "<div id=\\"completion-banner\\" class=\\"banner warning\\">" + MAX_ROUNDS + "周で強制終了しました(最終周の不正解 " + roundWrong.length + " マス、全マス正解には至らず)</div>";
    }
    return "<div id=\\"completion-banner\\"></div>";
  }

  // 帯1つ分の較正図(横軸=帯0〜100%、縦軸=正解率0〜100%)を描くインラインSVG。
  // 対角線(理想の較正線)は薄いグレー、棒はアクセント色(正解/不正解の色とは分ける)。
  // 件数0の帯は棒を描かない。色は PAGE_HTML の CSS 変数をそのまま使う(ライブラリ不使用)。
  function renderCalibrationChart(bins, titleText) {
    var width = 240;
    var height = 160;
    var padLeft = 28;
    var padRight = 8;
    var padTop = 10;
    var padBottom = 20;
    var plotW = width - padLeft - padRight;
    var plotH = height - padTop - padBottom;
    var barGap = 2;
    var barSlot = plotW / 10;
    var barWidth = barSlot - barGap;

    function xAt(i) {
      return padLeft + i * barSlot;
    }
    function yAt(rate) {
      return padTop + (1 - rate) * plotH;
    }

    var svg = "<svg viewBox=\\"0 0 " + width + " " + height + "\\" role=\\"img\\" aria-label=\\"" + escapeHtml(titleText) + "\\">";
    svg += "<line x1=\\"" + xAt(0) + "\\" y1=\\"" + yAt(0) + "\\" x2=\\"" + xAt(10) + "\\" y2=\\"" + yAt(1) +
      "\\" style=\\"stroke:var(--muted);stroke-width:1;stroke-dasharray:4 3;opacity:0.6;\\" />";
    svg += "<line x1=\\"" + padLeft + "\\" y1=\\"" + (padTop + plotH) + "\\" x2=\\"" + (padLeft + plotW) +
      "\\" y2=\\"" + (padTop + plotH) + "\\" style=\\"stroke:var(--border);stroke-width:1;\\" />";
    for (var i = 0; i < bins.length; i++) {
      var bin = bins[i];
      if (bin.n === 0) continue;
      // 正解率0%でも、件数>0の帯は高さ0だと n=0(未記録)の帯と見分けがつかないため、
      // 最低1pxの台座を描く(PR #25 レビュー指摘 nit)。
      var barH = Math.max(bin.rate * plotH, 1);
      var bx = xAt(i) + barGap / 2;
      var by = padTop + plotH - barH;
      svg += "<rect x=\\"" + bx + "\\" y=\\"" + by + "\\" width=\\"" + barWidth + "\\" height=\\"" + barH +
        "\\" style=\\"fill:var(--accent);\\" />";
      svg += "<text x=\\"" + (bx + barWidth / 2) + "\\" y=\\"" + Math.max(9, by - 3) +
        "\\" text-anchor=\\"middle\\" font-size=\\"8\\" style=\\"fill:var(--muted);\\">" + bin.n + "</text>";
    }
    svg += "<text x=\\"" + (padLeft - 4) + "\\" y=\\"" + (padTop + 3) + "\\" text-anchor=\\"end\\" font-size=\\"8\\" style=\\"fill:var(--muted);\\">100</text>";
    svg += "<text x=\\"" + (padLeft - 4) + "\\" y=\\"" + (padTop + plotH) + "\\" text-anchor=\\"end\\" font-size=\\"8\\" style=\\"fill:var(--muted);\\">0</text>";
    svg += "<text x=\\"" + padLeft + "\\" y=\\"" + (height - 4) + "\\" font-size=\\"8\\" style=\\"fill:var(--muted);\\">0%</text>";
    svg += "<text x=\\"" + (padLeft + plotW) + "\\" y=\\"" + (height - 4) + "\\" text-anchor=\\"end\\" font-size=\\"8\\" style=\\"fill:var(--muted);\\">100%</text>";
    svg += "</svg>";

    return "<div class=\\"calib-chart\\"><p class=\\"calib-chart-title\\">" + escapeHtml(titleText) + "</p>" + svg + "</div>";
  }

  // binRecords(pc/conf それぞれ)の結果を、件数と最終追記時刻が前回と同じなら
  // 使い回す軽いキャッシュ(PR #25 レビュー指摘 should-fix 2)。records は毎回
  // getRecords() から渡ってくるので、記録が増減・追記されていなければ計算し直さない。
  var calibBinCache = null; // { n, lastT, filter, models, total, correctCount, puzzleCount, pcBins, confBins }
  // 較正図の表示に必要なもの(モデル一覧・フィルタ後の記録・合計/正解率/問題数・帯)を
  // まとめて計算し、記録数・最終追記時刻・フィルタが前回と同じなら再計算しない
  // (render() のたびに全件をなめない。PR #25 のキャッシュ方針を維持。レビュー指摘 S5)。
  function computeCalibView(allRecords, filter) {
    var n = allRecords.length;
    var lastT = n > 0 && allRecords[n - 1] ? allRecords[n - 1].t : null;
    if (calibBinCache && calibBinCache.n === n && calibBinCache.lastT === lastT && calibBinCache.filter === filter) {
      return calibBinCache;
    }
    var modelSet = {};
    var records = [];
    var correctCount = 0;
    var puzzles = {};
    for (var i = 0; i < allRecords.length; i++) {
      var rec = allRecords[i];
      if (!rec) continue;
      var id = recordModelId(rec);
      modelSet[id] = true;
      if (filter !== "all" && id !== filter) continue;
      records.push(rec);
      if (rec.ok) correctCount++;
      if (typeof rec.p === "string") puzzles[rec.p] = true;
    }
    calibBinCache = {
      n: n,
      lastT: lastT,
      filter: filter,
      models: Object.keys(modelSet).sort(),
      total: records.length,
      correctCount: correctCount,
      puzzleCount: Object.keys(puzzles).length,
      pcBins: binRecords(records, "pc"),
      confBins: binRecords(records, "conf")
    };
    return calibBinCache;
  }

  // 集計パネル(SPEC F1 拡張2)。records は state ではなく localStorage 由来なので、
  // getRecords()(初回だけ localStorage を読み、以後はキャッシュを使う)経由で読む。
  function recordModelId(rec) {
    return typeof rec.m === "string" && rec.m ? rec.m : JEV_MODEL_ID;
  }

  function setCalibModelFilter(value) {
    state.calibModelFilter = typeof value === "string" && value ? value : "all";
    render();
  }

  function renderCalibration() {
    var allRecords = getRecords();
    var filter = state.calibModelFilter;
    var view = computeCalibView(allRecords, filter);
    // 記録に無いモデルを選んでいたら「すべて」扱いで計算し直す(state の値は保持する)。
    if (filter !== "all" && view.models.indexOf(filter) === -1) {
      filter = "all";
      view = computeCalibView(allRecords, filter);
    }
    var models = view.models;
    var total = view.total;
    var puzzleCount = view.puzzleCount;
    var pct = total === 0 ? 0 : Math.round((view.correctCount / total) * 100);
    var pcBins = view.pcBins;
    var confBins = view.confBins;

    var options = "<option value=\\"all\\"" + (filter === "all" ? " selected" : "") + ">すべて</option>";
    for (var m = 0; m < models.length; m++) {
      options += "<option value=\\"" + escapeHtml(models[m]) + "\\"" + (filter === models[m] ? " selected" : "") + ">" + escapeHtml(models[m]) + "</option>";
    }

    return "<div id=\\"calibration-panel\\" class=\\"panel\\">" +
      "<p class=\\"panel-title\\">較正図</p>" +
      "<p class=\\"calib-summary\\">合計 " + total + " 件 / 全体正解率 " + pct + "% / 記録している問題数 " + puzzleCount +
      " / モデル <select id=\\"calib-model-filter\\" onchange=\\"setCalibModelFilter(this.value)\\">" + options + "</select></p>" +
      "<div class=\\"calib-charts\\">" +
      renderCalibrationChart(pcBins, "choiceの確率(pc)による較正") +
      renderCalibrationChart(confBins, "モデルのconfidenceによる較正") +
      "</div>" +
      "<div class=\\"calib-actions\\">" +
      "<button id=\\"export-records-btn\\" onclick=\\"exportRecords()\\">JSONエクスポート</button>" +
      "<button id=\\"clear-records-btn\\" onclick=\\"clearRecords()\\">記録を消す</button>" +
      "</div>" +
      "</div>";
  }

  function pad2(n) {
    return n < 10 ? "0" + n : String(n);
  }

  // ファイル名 sudoku-calibration-YYYYMMDD-HHMMSS.json(ローカル時刻)。
  function recordsExportFileName() {
    var d = new Date();
    return "sudoku-calibration-" + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) +
      "-" + pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds()) + ".json";
  }

  function exportRecords() {
    var payload = { version: 1, exported_at: new Date().toISOString(), records: getRecords() };
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = recordsExportFileName();
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function clearRecords() {
    if (!confirm("記録した判定をすべて削除します。よろしいですか?")) return;
    saveRecords([]);
    render();
  }

  function render() {
    var app = document.getElementById("app");
    // 周回ログのスクロール位置を引き継ぐ(innerHTML を作り直すと先頭に戻るため)。
    // 末尾に居たときは末尾のままにする。
    var oldLog = document.querySelector("#round-log ul");
    var savedScroll = oldLog ? oldLog.scrollTop : 0;
    var wasAtBottom = oldLog ? oldLog.scrollHeight - oldLog.scrollTop - oldLog.clientHeight < 4 : true;
    // 一括モードのプロンプト枠の折りたたみ(<details>)の開閉も同じ理由で引き継ぐ(Issue #48)。
    // 1マスごとに render() が走るので、引き継がないと開いた直後に閉じてしまう。
    var oldDetails = document.querySelector("details.prompt-details");
    var detailsWasOpen = oldDetails ? oldDetails.open === true : false;
    if (embedMode) {
      // 埋め込みモード(比較シェルの iframe、Issue #46)。コントロール・Claude設定・
      // 較正図・プロンプト枠・見出しは描かず、グリッド・凡例・統計・現在の判定・
      // 周回ログ・エラーボックス・完了バナーだけを描く(SPEC F1)。
      // 完了/強制終了のバナーは見逃されないよう一番上に出す(オーナー要望 2026-09-22)
      app.innerHTML =
        renderBanner() +
        renderErrorBox() +
        "<div class=\\"layout\\">" +
        "<div class=\\"grid-panel\\">" + renderGrid() + renderLegend() + "</div>" +
        "<div class=\\"side-panel\\">" +
        renderStats() +
        renderCurrentPanel() +
        renderRoundLog() +
        "</div>" +
        "</div>";
    } else {
      app.innerHTML =
        "<h1>数独キャリブレーションチェック</h1>" +
        "<p class=\\"subtitle\\">Jev (typesafe/jev) または Claude に1マスずつ数字を聞き、確率の較正を目で確かめる</p>" +
        "<p class=\\"compare-link\\"><a href=\\"/compare\\">比較モード(Jev / Claude を並べて実行)</a></p>" +
        // 完了/強制終了のバナーは見逃されないよう見出しの直下(ページの一番上)に出す(オーナー要望 2026-09-22)
        renderBanner() +
        renderErrorBox() +
        "<div class=\\"layout\\">" +
        "<div class=\\"grid-panel\\">" + renderGrid() + renderLegend() + "</div>" +
        "<div class=\\"side-panel\\">" +
        renderControls() +
        renderClaudeSettings() +
        renderStats() +
        renderCurrentPanel() +
        renderPromptPanel() +
        renderRoundLog() +
        renderCalibration() +
        "</div>" +
        "</div>";
    }

    var newLog = document.querySelector("#round-log ul");
    if (newLog) newLog.scrollTop = wasAtBottom ? newLog.scrollHeight : savedScroll;
    var newDetails = document.querySelector("details.prompt-details");
    if (newDetails && detailsWasOpen) newDetails.open = true;

    if (embedMode) postStatus();
  }

  loadClaudeSettings();
  if (typeof location !== "undefined" && location.pathname === "/compare") {
    renderCompareShell();
  } else {
    applyUrlOptions(readUrlOptions());
    render();
    if (embedMode) setupEmbedMessageListener();
  }
</script>
</body>
</html>
`;
