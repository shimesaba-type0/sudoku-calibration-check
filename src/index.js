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

// 固定問題の初期配置(与えられたマス)。秘密ではないので入力検証のために Worker 側にも持つ。
// 正解表はここには置かない。ブラウザ用スクリプト(PAGE_HTML の中)にだけ定義し、
// 判定コードから構造的に隔離する(docs/DESIGN.md 9章 不変条件7)。
var GIVEN = [
  "53..7....",
  "6..195...",
  ".98....6.",
  "8...6...3",
  "4..8.3..1",
  "7...2...6",
  ".6....28.",
  "...419..5",
  "....8..79",
];

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
 * 入力検証(docs/DESIGN.md 3.3 手順3)。
 * 問題なければ null、不備があれば日本語の理由を返す。
 */
function validateInput(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return "puzzle(9行の配列)とtarget({row,col})が必要です";
  }

  var puzzle = body.puzzle;
  var target = body.target;
  if (!Array.isArray(puzzle) || puzzle.length !== 9) {
    return "puzzle(9行の配列)とtarget({row,col})が必要です";
  }
  if (target === null || typeof target !== "object" || Array.isArray(target)) {
    return "puzzle(9行の配列)とtarget({row,col})が必要です";
  }

  for (var r = 0; r < 9; r++) {
    if (typeof puzzle[r] !== "string" || !CELL_PATTERN.test(puzzle[r])) {
      return "puzzleの各行は1〜9と.だけからなる9文字の文字列である必要があります";
    }
  }

  var row = target.row;
  var col = target.col;
  if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || row > 8 || col < 0 || col > 8) {
    return "target.rowとtarget.colは0〜8の整数である必要があります";
  }

  for (var gr = 0; gr < 9; gr++) {
    for (var gc = 0; gc < 9; gc++) {
      var given = GIVEN[gr][gc];
      if (given !== "." && puzzle[gr][gc] !== given) {
        return "puzzleの与えられたマスが書き換えられています";
      }
    }
  }

  if (GIVEN[row][col] !== ".") {
    return "targetは与えられたマスではなく空マスを指す必要があります";
  }

  // 再判定のときも対象マス自身は空にして送る。前回の推測を Jev に見せない(アンカリング回避)。
  if (puzzle[row][col] !== ".") {
    return "puzzleのtargetのマスは.(空)である必要があります";
  }

  return null;
}

/**
 * Jev の回答が期待した形かを検証する(docs/DESIGN.md 3.3 手順6)。
 * 形が違うものをそのまま 200 で返すとフロントが黙って壊れるので、502 にして raw を見せる。
 * 問題なければ null、不備があれば日本語の理由を返す。
 */
function validateAnswer(answer) {
  if (answer === null || typeof answer !== "object" || Array.isArray(answer)) {
    return "AIの応答が予期しない形式です";
  }

  var probabilities = answer.probabilities;
  if (
    probabilities === null ||
    typeof probabilities !== "object" ||
    Array.isArray(probabilities)
  ) {
    return "AIの応答にprobabilitiesがありません";
  }

  var keys = Object.keys(probabilities);
  if (keys.length !== DIGITS.length) {
    return "AIの応答のprobabilitiesが1〜9の9キーになっていません";
  }
  for (var i = 0; i < DIGITS.length; i++) {
    var digit = DIGITS[i];
    if (!Object.prototype.hasOwnProperty.call(probabilities, digit)) {
      return "AIの応答のprobabilitiesが1〜9の9キーになっていません";
    }
    if (typeof probabilities[digit] !== "number" || !Number.isFinite(probabilities[digit])) {
      return "AIの応答のprobabilitiesに数値でない値が含まれています";
    }
  }

  if (typeof answer.choice !== "string" || DIGITS.indexOf(answer.choice) === -1) {
    return "AIの応答のchoiceが1〜9のいずれかではありません";
  }

  if (typeof answer.confidence !== "number" || !Number.isFinite(answer.confidence)) {
    return "AIの応答のconfidenceが数値ではありません";
  }

  return null;
}

/**
 * Jev のレスポンスから `answers.digit` を取り出す(docs/DESIGN.md 3.4)。
 *
 * 実環境の `typesafe/jev` は AI Gateway 経由で提供されており、`env.AI.run` は
 * `{ state, result: { model, answers, usage }, gatewayMetadata }` というラッパーを返す。
 * 将来 Cloudflare が素の `{ model, answers, usage }` を返すようになっても動くよう、
 * `result.answers` を優先し、`result` がオブジェクトでなければトップレベルの
 * `answers` に落とす。
 *
 * 取り出せたら `{ answer }`、駄目なら `{ error }`(日本語の理由)を返す。
 */
function extractAnswer(response) {
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

  if (answers.digit === undefined) {
    return { error: "AIの応答が予期しない形式です" };
  }

  return { answer: answers.digit };
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

  var invalid = validateInput(body);
  if (invalid !== null) {
    return errorResponse(invalid, 400, rate.headers);
  }

  var criteria = {};
  for (var i = 0; i < DIGITS.length; i++) {
    criteria[DIGITS[i]] = "the digit " + DIGITS[i];
  }

  // Jev に渡すのは「今埋まっているマス」と「対象座標」とルール説明だけ。
  // 正解表に由来する情報は一切入れない(docs/DESIGN.md 9章 不変条件1)。
  var payload = {
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

  var result;
  try {
    result = await env.AI.run("typesafe/jev", payload);
  } catch (err) {
    console.error("AI.run failed", err);
    return jsonResponse(
      {
        error: "AIの呼び出しに失敗しました",
        raw: truncate(String((err && err.message) || err)),
      },
      502,
      rate.headers
    );
  }

  var extracted = extractAnswer(result);
  var badAnswer =
    extracted.error !== undefined ? extracted.error : validateAnswer(extracted.answer);
  if (badAnswer !== null) {
    // AI.run が undefined を解決したとき、そのままだと raw のキーごと JSON から消える。
    // デバッグ用に「何が返ってきたか」を必ず残したいので null に寄せる。
    return jsonResponse(
      { error: badAnswer, raw: rawForResponse(result === undefined ? null : result) },
      502,
      rate.headers
    );
  }

  var answer = extracted.answer;
  return jsonResponse(
    {
      probabilities: answer.probabilities,
      choice: answer.choice,
      // Jev 独自の確信度。probabilities[choice] とは一致しない(docs/SPEC.md 4章)。
      confidence: answer.confidence,
    },
    200,
    rate.headers
  );
}

// GET / に付けるセキュリティヘッダー(docs/DESIGN.md 7章)。CORS ヘッダーは付けない。
var PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "frame-ancestors 'none'",
};

export default {
  async fetch(request, env) {
    var url = new URL(request.url);
    if (url.pathname === "/api/judge" && request.method === "POST") return handleJudge(request, env);
    if (url.pathname === "/api/status" && request.method === "GET") {
      return readRateLimitStatus(request, env);
    }
    if (url.pathname === "/" && request.method === "GET") {
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
  .subtitle { margin: 0 0 20px; color: var(--muted); font-size: 13px; }
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
  #speed-toggle { display: inline-flex; border: 1px solid var(--panel-border); border-radius: 6px; overflow: hidden; }
  .speed-btn { border: none; border-radius: 0; background: var(--panel-bg); }
  .speed-btn.active { background: var(--accent); color: #0b1220; }

  #error-box.error {
    background: var(--error-bg);
    border: 1px solid var(--error-border);
    color: #ffd9d9;
    border-radius: 8px;
    padding: 10px 14px;
    margin: 12px 0;
    font-size: 13px;
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

  #round-log ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; max-height: 220px; overflow-y: auto; }
  #round-log li { font-size: 12px; font-family: "IBM Plex Mono", monospace; color: var(--muted); }

  .banner { border-radius: 8px; padding: 12px 14px; font-size: 14px; font-weight: 600; }
  .banner.success { background: var(--correct-bg); color: var(--correct); border: 1px solid var(--correct); }
  .banner.warning { background: var(--incorrect-bg); color: var(--incorrect); border: 1px solid var(--incorrect); }

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

  // 実行世代のチェック。reset() / showError() で runToken が進むので、
  // 古い世代の fetch / setTimeout のコールバックはここで弾かれる(DESIGN 4.3)。
  function isCurrent(token) {
    return state.running && token === runToken;
  }

  // -------------------------------------------------------------------
  // データ・状態(docs/DESIGN.md 4.1 / 5章)
  // -------------------------------------------------------------------
  var DIGITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];

  var GIVEN = ["53..7....", "6..195...", ".98....6.", "8...6...3", "4..8.3..1", "7...2...6", ".6....28.", "...419..5", "....8..79"];
  var SOLUTION = ["534678912", "672195348", "198342567", "859761423", "426853791", "713924856", "961537284", "287419635", "345286179"];

  var TOTAL_EMPTY = 0;
  for (var gr = 0; gr < 9; gr++) {
    for (var gc = 0; gc < 9; gc++) {
      if (GIVEN[gr][gc] === ".") TOTAL_EMPTY++;
    }
  }

  // 速度モード(SPEC F4)
  var SLOW_BEFORE_COMMIT_MS = 700;
  var SLOW_AFTER_COMMIT_MS = 150;
  var SLOW_BETWEEN_ROUNDS_MS = 250;
  var FAST_BEFORE_COMMIT_MS = 0;
  var FAST_AFTER_COMMIT_MS = 20;
  var FAST_BETWEEN_ROUNDS_MS = 80;
  var MAX_ROUNDS = 15;

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
    errorMessage: null,
    stoppedAtLimit: false,
    lastJudgment: null // 直前に確定した1件(最速モードでも結果が見えるように残す)
  };
  // 描画に不要な進行管理はモジュール変数(docs/DESIGN.md 4.1)
  var queue = [];
  var roundWrong = [];
  var roundTally = { correct: 0, total: 0 };
  var roundSize = TOTAL_EMPTY; // 開始前は「0 / 51」と見せる
  var started = false;
  var pendingCommit = null;
  // 実行の世代。reset() / showError() のたびに進める。進行中の fetch や
  // setTimeout のコールバックは、捕まえた世代と一致するときだけ続行する。
  var runToken = 0;

  // -------------------------------------------------------------------
  // API呼び出し
  // -------------------------------------------------------------------
  async function judgeCell(r, c) {
    var puzzle = buildSnapshot();
    var res = await fetch("/api/judge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ puzzle: puzzle, target: { row: r, col: c } })
    });
    if (res.ok) return res.json();
    var message = "HTTP " + res.status;
    try {
      var data = await res.json();
      if (data && typeof data.error === "string") message = data.error;
    } catch (e) {
      // JSONでないボディはそのまま HTTP <status> にフォールバック
    }
    throw new Error(message);
  }

  // -------------------------------------------------------------------
  // 進行ロジック(docs/DESIGN.md 4.3 状態遷移)
  // -------------------------------------------------------------------
  function run() {
    if (state.running || state.done || state.errorMessage) return;
    state.running = true;
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
    var cell = queue.shift();
    // 先にフォーカスを立てる。buildSnapshot() は state.focusedKey のマスを "." に
    // するので、この順序が「対象マスを空にして送る」不変条件そのもの(SPEC F3)。
    state.focusedKey = cell.r + "-" + cell.c;
    state.currentProbs = null;
    pendingCommit = null;
    render();

    judgeCell(cell.r, cell.c).then(function (result) {
      if (!isCurrent(token)) return; // リセット後などの古い世代は捨てる
      var probs = DIGITS.map(function (d) {
        var p = result.probabilities ? result.probabilities[d] : 0;
        return { digit: d, pct: Math.round((typeof p === "number" ? p : 0) * 100), isPick: d === result.choice };
      });
      state.currentProbs = probs;
      pendingCommit = { r: cell.r, c: cell.c, choice: result.choice, confidence: result.confidence };
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
      showError(err && err.message ? err.message : String(err));
    }).catch(function (err) {
      // 成功ハンドラ(render など)が投げた場合。API エラーとは区別して表示する。
      if (!isCurrent(token)) return;
      showError("画面の更新に失敗しました: " + (err && err.message ? err.message : String(err)));
    });
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
    pendingCommit = null;
    render();
  }

  function finalizeRound() {
    var token = runToken;
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

  function showError(message) {
    // 世代を進めて、進行中の fetch / setTimeout のコールバックを無効化する
    runToken += 1;
    state.errorMessage = message;
    state.running = false;
    state.focusedKey = null;
    state.currentProbs = null;
    pendingCommit = null;
    render();
  }

  function setSpeed(mode) {
    state.speedMode = mode;
    render();
  }

  function reset() {
    // 世代を進める。進行中の fetch / setTimeout はこれで続きを実行しなくなる
    runToken += 1;
    var keepSpeed = state.speedMode;
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
      errorMessage: null,
      stoppedAtLimit: false,
      lastJudgment: null
    };
    queue = [];
    roundWrong = [];
    roundTally = { correct: 0, total: 0 };
    roundSize = TOTAL_EMPTY;
    started = false;
    pendingCommit = null;
    render();
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
    return "<div id=\\"legend\\" class=\\"legend\\">" +
      "<span class=\\"legend-item\\"><span class=\\"swatch swatch-correct\\"></span>正解</span>" +
      "<span class=\\"legend-item\\"><span class=\\"swatch swatch-incorrect\\"></span>不正解</span>" +
      "<span class=\\"legend-item\\"><span class=\\"swatch swatch-focus\\"></span>判定中</span>" +
      "</div>";
  }

  function renderControls() {
    var runDisabled = state.running || state.done || state.errorMessage ? "disabled" : "";
    var slowActive = state.speedMode === "slow" ? " active" : "";
    var fastActive = state.speedMode === "fast" ? " active" : "";
    return "<div class=\\"controls\\">" +
      "<button id=\\"run-btn\\" onclick=\\"run()\\" " + runDisabled + ">実行</button>" +
      "<button id=\\"reset-btn\\" onclick=\\"reset()\\">リセット</button>" +
      "<div id=\\"speed-toggle\\">" +
      "<button class=\\"speed-btn" + slowActive + "\\" onclick=\\"setSpeed('slow')\\">じっくり確認</button>" +
      "<button class=\\"speed-btn" + fastActive + "\\" onclick=\\"setSpeed('fast')\\">最速</button>" +
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
    var correctCount = 0;
    for (var key in state.values) {
      if (Object.prototype.hasOwnProperty.call(state.values, key) && state.values[key].status === "correct") correctCount++;
    }
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

  function renderCurrentPanel() {
    var head = "<div id=\\"current-panel\\" class=\\"panel\\"><p class=\\"panel-title\\">現在の判定</p>";
    var tail = "</div>";

    // 結果が届いている最中のマス: 座標とバーをそのまま出す
    if (state.focusedKey && state.currentProbs) {
      var parts = state.focusedKey.split("-");
      var confidenceText = "";
      if (pendingCommit && typeof pendingCommit.confidence === "number") {
        confidenceText = "<span class=\\"confidence\\">Jev confidence " + Math.round(pendingCommit.confidence * 100) + "%</span>";
      }
      return head +
        "<div class=\\"coords\\">" + coordLabel(Number(parts[0]), Number(parts[1])) + confidenceText + "</div>" +
        "<div class=\\"bars\\">" + renderBars(state.currentProbs) + "</div>" + tail;
    }

    // 待ち時間中は「いま聞いているマス」+「直前に確定した判定」を並べる。
    // 最速モードでも結果が一瞬で消えないようにするため(DESIGN 4.4)。
    var body = "";
    if (state.focusedKey) {
      var p2 = state.focusedKey.split("-");
      body += "<div class=\\"coords\\">" + coordLabel(Number(p2[0]), Number(p2[1])) +
        "<span class=\\"confidence\\">判定中…</span></div>";
    }
    var last = state.lastJudgment;
    if (last && last.probs) {
      var statusText = last.status === "correct" ? "正解" : "不正解";
      var lastConfidence = typeof last.confidence === "number" ? " / Jev confidence " + Math.round(last.confidence * 100) + "%" : "";
      body += "<div class=\\"coords\\"><span class=\\"confidence\\">直前: " + coordLabel(last.r, last.c) +
        " → " + escapeHtml(last.choice) + "(" + statusText + ")" + lastConfidence + "</span></div>" +
        "<div class=\\"bars\\">" + renderBars(last.probs) + "</div>";
      return head + body + tail;
    }
    if (state.focusedKey) return head + body + "<p class=\\"muted\\">判定中…</p>" + tail;
    return head + "<p class=\\"muted\\">待機中</p>" + tail;
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
      return "<div id=\\"completion-banner\\" class=\\"banner warning\\">" + MAX_ROUNDS + "周で強制終了しました(全マス正解には至りませんでした)</div>";
    }
    return "<div id=\\"completion-banner\\"></div>";
  }

  function render() {
    var app = document.getElementById("app");
    // 周回ログのスクロール位置を引き継ぐ(innerHTML を作り直すと先頭に戻るため)。
    // 末尾に居たときは末尾のままにする。
    var oldLog = document.querySelector("#round-log ul");
    var savedScroll = oldLog ? oldLog.scrollTop : 0;
    var wasAtBottom = oldLog ? oldLog.scrollHeight - oldLog.scrollTop - oldLog.clientHeight < 4 : true;
    app.innerHTML =
      "<h1>数独キャリブレーションチェック</h1>" +
      "<p class=\\"subtitle\\">Jev (typesafe/jev) に1マスずつ数字を聞き、確率の較正を目で確かめる</p>" +
      renderErrorBox() +
      "<div class=\\"layout\\">" +
      "<div class=\\"grid-panel\\">" + renderGrid() + renderLegend() + "</div>" +
      "<div class=\\"side-panel\\">" +
      renderControls() +
      renderStats() +
      renderCurrentPanel() +
      renderRoundLog() +
      renderBanner() +
      "</div>" +
      "</div>";

    var newLog = document.querySelector("#round-log ul");
    if (newLog) newLog.scrollTop = wasAtBottom ? newLog.scrollHeight : savedScroll;
  }

  render();
</script>
</body>
</html>
`;
