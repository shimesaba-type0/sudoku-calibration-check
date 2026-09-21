/**
 * sudoku-calibration-check — Cloudflare Worker 本体
 *
 * GET  /           … フロントエンド一式(PAGE_HTML)
 * POST /api/judge  … 盤面と対象マスを受け取り、typesafe/jev に1マス分の確率を聞いて返す
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

// KV 障害(フェイルクローズ)時に返す待ち時間(秒)
var KV_FAILURE_RETRY_AFTER = 60;

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
 * KV に入っているカウンタの読み取り。キーが無ければ 0。
 * 10進整数として読めない値(壊れている・改ざんされた)は「上限超過」として扱う
 * = フェイルクローズ。カウントできないまま AI を呼ぶよりは止める。
 */
function readCount(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value !== "string" || !/^\d+$/.test(value)) return Number.POSITIVE_INFINITY;
  var parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return Number.POSITIVE_INFINITY;
  return parsed;
}

/**
 * IP単位・全体の2段構えの固定ウィンドウ・レート制限(docs/DESIGN.md 3.2)。
 *
 * 全体 → IP単位 の順に見て、どちらか超過していれば書き込まずに拒否する。
 * 両方下回っていたときだけ2つのカウンタを +1 する。
 *
 * バインディングの有無で挙動が変わる:
 * - RATE_LIMIT_KV が無い       → フェイルオープン(制限なしで通す。ローカル開発の利便性)
 * - RATE_LIMIT_KV が例外を投げる → フェイルクローズ(scope:"kv" で拒否。handleJudge が 503)
 */
async function checkRateLimit(request, env) {
  var kv = env && env.RATE_LIMIT_KV;
  if (!kv) return { allowed: true, headers: {} };

  var windowSeconds = readLimit(env.RATE_LIMIT_WINDOW_SECONDS, DEFAULT_WINDOW_SECONDS);
  var perIpMax = readLimit(env.RATE_LIMIT_PER_IP_MAX, DEFAULT_PER_IP_MAX);
  var globalMax = readLimit(env.RATE_LIMIT_GLOBAL_MAX, DEFAULT_GLOBAL_MAX);

  var nowSeconds = Math.floor(Date.now() / 1000);
  var bucket = Math.floor(nowSeconds / windowSeconds);
  // 今のバケットが終わるまでの秒数
  var retryAfter = (bucket + 1) * windowSeconds - nowSeconds;

  var ip = request.headers.get("CF-Connecting-IP") || "unknown";
  var globalKey = "rl:global:" + bucket;
  var ipKey = "rl:ip:" + ip + ":" + bucket;

  try {
    // 先に全体。超過していれば IP 単位を読む意味も書き込む意味も無い。
    var globalCount = readCount(await kv.get(globalKey));
    if (globalCount >= globalMax) {
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

    var ipCount = readCount(await kv.get(ipKey));
    if (ipCount >= perIpMax) {
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

    // ウィンドウ幅より60秒長い TTL。次のバケットと多少重なっても古いキーは自然に消える。
    var options = { expirationTtl: windowSeconds + 60 };
    await Promise.all([
      kv.put(globalKey, String(globalCount + 1), options),
      kv.put(ipKey, String(ipCount + 1), options),
    ]);

    return {
      allowed: true,
      headers: {
        "X-RateLimit-Remaining-IP": String(Math.max(0, perIpMax - (ipCount + 1))),
        "X-RateLimit-Remaining-Global": String(Math.max(0, globalMax - (globalCount + 1))),
      },
    };
  } catch (err) {
    // バインディングはあるのに KV が使えない。回数を数えられないので通さない。
    console.error("rate limit KV error", err);
    return {
      allowed: false,
      scope: "kv",
      reason: "レート制限の記録に失敗しました。しばらくしてから再試行してください",
      headers: { "Retry-After": String(KV_FAILURE_RETRY_AFTER) },
    };
  }
}

var CELL_PATTERN = /^[1-9.]{9}$/;

/**
 * 入力検証(docs/DESIGN.md 3.3 step 2)。
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
 * Jev の回答が期待した形かを検証する(docs/DESIGN.md 3.3 step 5)。
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

function truncate(text) {
  return text.length > RAW_MAX_LENGTH ? text.slice(0, RAW_MAX_LENGTH) + "…" : text;
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
    if (rate.scope === "kv") {
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

  var answer = result && result.answers && result.answers.digit;
  var badAnswer = answer === undefined ? "AIの応答が予期しない形式です" : validateAnswer(answer);
  if (badAnswer !== null) {
    return jsonResponse({ error: badAnswer, raw: result }, 502, rate.headers);
  }

  return jsonResponse(
    {
      probabilities: answer.probabilities,
      choice: answer.choice,
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
    if (url.pathname === "/" && request.method === "GET") {
      return new Response(PAGE_HTML, { headers: PAGE_HEADERS });
    }
    return new Response("Not found", { status: 404 });
  },
};

// ---------------------------------------------------------------------------
// ブラウザ用の一式。このテンプレートリテラルの中だけが正解表を知っている。
// テンプレート内で ${} を書く必要が出たら \${} とエスケープすること
// (このページのフロントJSはテンプレートリテラルを使わず文字列連結で書いているので、
// 実際にはこのエスケープは登場しない)。
//
// PAGE_HTML はこのファイルの最後の宣言のままにすること。閉じバッククォートが
// ファイル末尾にあることを前提に、不変条件7のテストが「テンプレートリテラルの外」を
// 機械的に切り出している(docs/DESIGN.md 3.5・10章)。この下には何も足さない。
//
// 画面構成・状態遷移は docs/SPEC.md 3章(F1〜F5)・docs/DESIGN.md 4章に対応する。
// ---------------------------------------------------------------------------
var PAGE_HTML = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>数独キャリブレーションチェック</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root {
    color-scheme: dark;
    --bg: #12141a;
    --surface: #1b1e27;
    --surface-2: #20242f;
    --border: #2a2d38;
    --border-strong: #4a4f5e;
    --text: #e6e8ee;
    --text-muted: #9aa1b1;
    --accent: #4fd1ff;
    --green: #34d058;
    --green-bg: rgba(52, 199, 89, 0.16);
    --red: #ff6b6b;
    --red-bg: rgba(255, 69, 58, 0.18);
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
  #app { max-width: 980px; margin: 0 auto; display: flex; flex-direction: column; gap: 18px; }
  h1 { margin: 0; font-size: 22px; font-weight: 700; letter-spacing: 0.01em; }
  .subtitle { margin: 4px 0 0; color: var(--text-muted); font-size: 13px; }
  .topbar {
    display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px;
    background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px;
  }
  .controls { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
  .speed-toggle { display: inline-flex; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
  .speed-toggle button {
    border: none; background: var(--surface-2); color: var(--text-muted); padding: 8px 12px;
    font: inherit; font-size: 13px; cursor: pointer;
  }
  .speed-toggle button.active { background: var(--accent); color: #06222b; font-weight: 600; }
  .btn {
    border: 1px solid var(--border-strong); background: var(--surface-2); color: var(--text);
    padding: 8px 16px; border-radius: 8px; font: inherit; font-size: 13px; font-weight: 600; cursor: pointer;
  }
  .btn.primary { background: var(--accent); color: #06222b; border-color: var(--accent); }
  .btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .error-box {
    background: var(--red-bg); border: 1px solid var(--red); color: #ffd7d3;
    border-radius: 10px; padding: 12px 16px; font-size: 13px; line-height: 1.5;
  }
  .error-box strong { color: var(--red); }
  .banner {
    background: var(--green-bg); border: 1px solid var(--green); color: #d8ffe4;
    border-radius: 10px; padding: 12px 16px; font-size: 14px; font-weight: 600;
  }
  .layout { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 18px; align-items: start; }
  @media (max-width: 760px) { .layout { grid-template-columns: 1fr; } }
  .board-wrap {
    background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 16px;
    display: flex; justify-content: center;
  }
  .board {
    display: grid; grid-template-columns: repeat(9, minmax(0, 1fr)); width: 100%; max-width: 460px;
    aspect-ratio: 1 / 1; border: 3px solid var(--border-strong); border-radius: 4px; overflow: hidden;
    background: var(--surface-2);
  }
  .cell {
    display: flex; align-items: center; justify-content: center;
    font-family: "IBM Plex Mono", monospace; font-size: clamp(14px, 3.4vw, 22px);
    transition: background-color 0.15s ease, color 0.15s ease;
  }
  .panel {
    background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 16px;
    display: flex; flex-direction: column; gap: 12px;
  }
  .panel h2 {
    margin: 0; font-size: 12px; font-weight: 600; color: var(--text-muted);
    text-transform: uppercase; letter-spacing: 0.04em;
  }
  .panel-coord { font-family: "IBM Plex Mono", monospace; font-size: 16px; font-weight: 600; }
  .panel-choice { font-size: 12px; color: var(--text-muted); }
  .panel-choice b { color: var(--accent); font-family: "IBM Plex Mono", monospace; }
  .bars { display: flex; flex-direction: column; gap: 6px; }
  .bar-row { display: grid; grid-template-columns: 16px 1fr 40px; align-items: center; gap: 8px; }
  .bar-label { font-family: "IBM Plex Mono", monospace; font-size: 12px; color: var(--text-muted); text-align: center; }
  .bar-track { background: var(--surface-2); border-radius: 4px; height: 14px; overflow: hidden; }
  .bar-fill { height: 100%; background: var(--border-strong); border-radius: 4px; transition: width 0.2s ease; }
  .bar-fill.pick { background: var(--accent); }
  .bar-pct { font-family: "IBM Plex Mono", monospace; font-size: 11px; color: var(--text-muted); text-align: right; }
  .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
  @media (max-width: 560px) { .stats { grid-template-columns: repeat(2, 1fr); } }
  .stat-card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; }
  .stat-card .label { font-size: 11px; color: var(--text-muted); }
  .stat-card .value { font-family: "IBM Plex Mono", monospace; font-size: 20px; font-weight: 600; margin-top: 4px; }
  .legend { display: flex; flex-wrap: wrap; gap: 16px; font-size: 12px; color: var(--text-muted); }
  .legend-item { display: flex; align-items: center; gap: 6px; }
  .legend-swatch { width: 14px; height: 14px; border-radius: 4px; display: inline-block; }
  .log {
    background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 12px 16px;
    max-height: 220px; overflow-y: auto; display: flex; flex-direction: column; gap: 4px;
    font-family: "IBM Plex Mono", monospace; font-size: 13px;
  }
  .log .empty { color: var(--text-muted); font-family: "IBM Plex Sans", sans-serif; }
</style>
</head>
<body>
<div id="app"></div>
<script>
(function () {
  "use strict";

  // 固定問題(docs/DESIGN.md 5章)。GIVEN は Worker 側にもあるが SOLUTION はここにしか無い。
  var GIVEN = ["53..7....", "6..195...", ".98....6.", "8...6...3", "4..8.3..1", "7...2...6", ".6....28.", "...419..5", "....8..79"];
  var SOLUTION = ["534678912", "672195348", "198342567", "859761423", "426853791", "713924856", "961537284", "287419635", "345286179"];
  var DIGITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];
  var MAX_ROUNDS = 15;

  var totalBlanks = 0;
  for (var gr = 0; gr < 9; gr++) {
    for (var gc = 0; gc < 9; gc++) {
      if (GIVEN[gr][gc] === ".") totalBlanks += 1;
    }
  }

  // docs/DESIGN.md 4.1 の state。描画に必要なものはここに、進行管理だけの値は下のモジュール変数に置く。
  var state = {
    round: 1,
    values: {},
    focusedKey: null,
    currentProbs: null,
    confidence: null,
    roundLog: [],
    running: false,
    done: false,
    roundsToSolve: null,
    speedMode: "slow",
    error: null,
    stopped: null
  };

  var queue = [];
  var roundWrong = [];
  var roundTally = { correct: 0, total: 0 };
  var roundTotalCells = totalBlanks;
  var started = false;
  var pendingCommit = null;

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  // SPEC F4 の待ち時間表
  function delays() {
    if (state.speedMode === "fast") return { pre: 0, post: 20, between: 80 };
    return { pre: 700, post: 150, between: 250 };
  }

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function buildInitialQueue() {
    var cells = [];
    for (var r = 0; r < 9; r++) {
      for (var c = 0; c < 9; c++) {
        if (GIVEN[r][c] === ".") cells.push({ r: r, c: c });
      }
    }
    return cells;
  }

  // GIVEN + state.values(正誤問わず)から9行のスナップショットを作る。
  // excludeKey(これから判定するマス自身)は "." にして送る(アンカリング回避)。
  function buildSnapshot(excludeKey) {
    var rows = GIVEN.slice();
    for (var key in state.values) {
      if (key === excludeKey) continue;
      var parts = key.split("-");
      var r = Number(parts[0]);
      var c = Number(parts[1]);
      var row = rows[r];
      rows[r] = row.slice(0, c) + state.values[key].value + row.slice(c + 1);
    }
    return rows;
  }

  // POST /api/judge。非2xx・JSONでない・probabilities が無いのいずれも例外にして呼び出し側で扱う(SPEC F5)。
  async function judgeCell(r, c) {
    var key = r + "-" + c;
    var puzzle = buildSnapshot(key);
    var res;
    try {
      res = await fetch("/api/judge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ puzzle: puzzle, target: { row: r, col: c } })
      });
    } catch (networkErr) {
      throw new Error("APIへの接続に失敗しました");
    }
    var data = null;
    try {
      data = await res.json();
    } catch (parseErr) {
      throw new Error("APIの応答をJSONとして解釈できませんでした(status " + res.status + ")");
    }
    if (!res.ok) {
      var reason = data && typeof data.error === "string" && data.error ? data.error : "APIエラー(status " + res.status + ")";
      throw new Error(reason);
    }
    if (!data || typeof data.probabilities !== "object" || data.probabilities === null) {
      throw new Error("AIの応答にprobabilitiesがありません");
    }
    return data;
  }

  function showError(message) {
    state.error = message;
    state.running = false;
  }

  // pendingCommit を state.values に反映し、roundTally / roundWrong を更新する。
  function commitFocused() {
    if (!pendingCommit) return;
    var key = pendingCommit.key;
    var r = pendingCommit.r;
    var c = pendingCommit.c;
    var value = pendingCommit.value;
    var correct = SOLUTION[r][c] === value;
    state.values[key] = { value: value, status: correct ? "correct" : "incorrect" };
    roundTally.total += 1;
    if (correct) {
      roundTally.correct += 1;
    } else {
      roundWrong.push({ r: r, c: c });
    }
    pendingCommit = null;
    state.focusedKey = null;
  }

  // 周回ログに追記し、不正解が0なら完了、そうでなければ次の周へ(SPEC F3)。
  function finalizeRound() {
    var pct = roundTotalCells > 0 ? Math.round((roundTally.correct / roundTotalCells) * 100) : 100;
    state.roundLog.push(state.round + "周目: " + roundTotalCells + "中" + roundTally.correct + "正解 (" + pct + "%)");

    if (roundWrong.length === 0) {
      state.done = true;
      state.running = false;
      state.roundsToSolve = state.round;
      render();
      return;
    }

    if (state.round >= MAX_ROUNDS) {
      state.running = false;
      state.stopped = MAX_ROUNDS + "周に達したため終了しました(" + roundWrong.length + "マスが不正解のまま残っています)";
      render();
      return;
    }

    state.round += 1;
    queue = roundWrong.slice();
    roundWrong = [];
    roundTotalCells = queue.length;
    roundTally = { correct: 0, total: 0 };
    render();

    var d = delays();
    sleep(d.between).then(function () {
      if (state.running) focusNext();
    });
  }

  // 1マス分の判定フロー(SPEC F2 / docs/DESIGN.md 4.3)。
  async function focusNext() {
    if (queue.length === 0) {
      finalizeRound();
      return;
    }
    var cell = queue.shift();
    var key = cell.r + "-" + cell.c;
    state.focusedKey = key;
    state.currentProbs = null;
    state.confidence = null;
    pendingCommit = null;
    render();

    var data;
    try {
      data = await judgeCell(cell.r, cell.c);
    } catch (err) {
      showError(err && err.message ? err.message : String(err));
      state.focusedKey = null;
      render();
      return;
    }

    // probabilities は確率順ではなく 1〜9 の順で表示する(docs/DESIGN.md 9章 不変条件3)。
    var probs = [];
    for (var i = 0; i < DIGITS.length; i++) {
      var digit = DIGITS[i];
      var p = Number(data.probabilities[digit]);
      if (!Number.isFinite(p)) p = 0;
      probs.push({ digit: digit, pct: Math.round(p * 100), isPick: digit === data.choice });
    }
    state.currentProbs = probs;
    state.confidence = data.confidence;
    pendingCommit = { key: key, r: cell.r, c: cell.c, value: data.choice };
    render();

    var d = delays();
    await sleep(d.pre);
    commitFocused();
    render();
    await sleep(d.post);

    if (!state.running) return;
    focusNext();
  }

  // 初回のみ queue を全空マスで初期化して開始する。
  function run() {
    if (started) return;
    started = true;
    state.error = null;
    state.stopped = null;
    state.running = true;
    queue = buildInitialQueue();
    roundTotalCells = queue.length;
    roundTally = { correct: 0, total: 0 };
    render();
    focusNext();
  }

  // 進行管理と state を初期化する。speedMode は維持する。
  function reset() {
    state.round = 1;
    state.values = {};
    state.focusedKey = null;
    state.currentProbs = null;
    state.confidence = null;
    state.roundLog = [];
    state.running = false;
    state.done = false;
    state.roundsToSolve = null;
    state.error = null;
    state.stopped = null;
    queue = [];
    roundWrong = [];
    roundTally = { correct: 0, total: 0 };
    roundTotalCells = totalBlanks;
    started = false;
    pendingCommit = null;
    render();
  }

  function setSpeed(mode) {
    state.speedMode = mode === "fast" ? "fast" : "slow";
    render();
  }

  // マスの状態(given/pending/correct/incorrect + focused)からインラインstyle文字列を返す。
  function buildCellStyle(given, entry, focused) {
    var bg = "transparent";
    var color = "var(--text)";
    var weight = "400";
    if (given) {
      color = "#ffffff";
      weight = "700";
    } else if (entry) {
      if (entry.status === "correct") {
        bg = "var(--green-bg)";
        color = "var(--green)";
        weight = "600";
      } else {
        bg = "var(--red-bg)";
        color = "var(--red)";
        weight = "600";
      }
    }
    var style = "background:" + bg + ";color:" + color + ";font-weight:" + weight + ";";
    if (focused) style += "box-shadow: inset 0 0 0 3px var(--accent);";
    return style;
  }

  function buildBoardHtml() {
    var out = ['<div class="board">'];
    for (var r = 0; r < 9; r++) {
      for (var c = 0; c < 9; c++) {
        var given = GIVEN[r][c] !== ".";
        var key = r + "-" + c;
        var entry = state.values[key];
        var focused = state.focusedKey === key;
        var text = given ? GIVEN[r][c] : (entry ? entry.value : "");
        var borderRight = c === 8
          ? "border-right:none;"
          : (c % 3 === 2 ? "border-right:3px solid var(--border-strong);" : "border-right:1px solid var(--border);");
        var borderBottom = r === 8
          ? "border-bottom:none;"
          : (r % 3 === 2 ? "border-bottom:3px solid var(--border-strong);" : "border-bottom:1px solid var(--border);");
        var style = buildCellStyle(given, entry, focused) + borderRight + borderBottom;
        out.push('<div class="cell" style="' + style + '">' + escapeHtml(text) + "</div>");
      }
    }
    out.push("</div>");
    return out.join("");
  }

  function buildStatsHtml() {
    var correctCount = 0;
    for (var key in state.values) {
      if (state.values[key].status === "correct") correctCount += 1;
    }
    var remaining = totalBlanks - correctCount;
    var cards = [
      { label: "現在の周", value: state.round + "周" },
      { label: "残りマス", value: remaining + "マス" },
      { label: "累計正解", value: String(correctCount) },
      { label: "この周の進捗", value: roundTally.total + "/" + roundTotalCells }
    ];
    var out = ['<div class="stats">'];
    for (var i = 0; i < cards.length; i++) {
      out.push(
        '<div class="stat-card"><div class="label">' + escapeHtml(cards[i].label) +
        '</div><div class="value">' + escapeHtml(cards[i].value) + "</div></div>"
      );
    }
    out.push("</div>");
    return out.join("");
  }

  function buildPanelHtml() {
    var coordText = "待機中";
    if (state.focusedKey) {
      var parts = state.focusedKey.split("-");
      coordText = (Number(parts[0]) + 1) + "行目 " + (Number(parts[1]) + 1) + "列目";
    }

    var choiceText = "";
    if (state.currentProbs) {
      var pick = null;
      for (var i = 0; i < state.currentProbs.length; i++) {
        if (state.currentProbs[i].isPick) { pick = state.currentProbs[i]; break; }
      }
      if (pick) {
        var confidenceText = typeof state.confidence === "number" ? Math.round(state.confidence * 100) + "%" : "-";
        choiceText =
          '<div class="panel-choice">choice: <b>' + escapeHtml(pick.digit) + "</b>(確率 " + pick.pct + "%) " +
          "／ confidence: " + confidenceText + "</div>";
      }
    }

    var bars = ['<div class="bars">'];
    for (var d = 0; d < DIGITS.length; d++) {
      var digit = DIGITS[d];
      var found = null;
      if (state.currentProbs) {
        for (var j = 0; j < state.currentProbs.length; j++) {
          if (state.currentProbs[j].digit === digit) { found = state.currentProbs[j]; break; }
        }
      }
      var pct = found ? found.pct : 0;
      var pick2 = found ? found.isPick : false;
      bars.push(
        '<div class="bar-row"><div class="bar-label">' + digit + '</div>' +
        '<div class="bar-track"><div class="bar-fill' + (pick2 ? " pick" : "") + '" style="width:' + pct + '%;"></div></div>' +
        '<div class="bar-pct">' + pct + "%</div></div>"
      );
    }
    bars.push("</div>");

    return (
      '<div class="panel"><h2>判定パネル</h2><div class="panel-coord">' + escapeHtml(coordText) + "</div>" +
      choiceText + bars.join("") + "</div>"
    );
  }

  function buildLegendHtml() {
    return (
      '<div class="legend">' +
      '<div class="legend-item"><span class="legend-swatch" style="background:var(--green-bg);border:1px solid var(--green);"></span>正解</div>' +
      '<div class="legend-item"><span class="legend-swatch" style="background:var(--red-bg);border:1px solid var(--red);"></span>不正解</div>' +
      '<div class="legend-item"><span class="legend-swatch" style="background:transparent;border:3px solid var(--accent);"></span>判定中</div>' +
      "</div>"
    );
  }

  function buildLogHtml() {
    if (state.roundLog.length === 0 && !state.stopped) {
      return '<div class="log"><div class="empty">まだ周回は完了していません</div></div>';
    }
    var out = ['<div class="log">'];
    for (var i = 0; i < state.roundLog.length; i++) {
      out.push('<div class="log-item">' + escapeHtml(state.roundLog[i]) + "</div>");
    }
    if (state.stopped) out.push('<div class="log-item">' + escapeHtml(state.stopped) + "</div>");
    out.push("</div>");
    return out.join("");
  }

  function buildTopbarHtml() {
    var runDisabled = started ? " disabled" : "";
    return (
      '<div class="topbar">' +
      '<div><h1>数独キャリブレーションチェック</h1>' +
      '<p class="subtitle">Jev(typesafe/jev)の較正された確率を、数独の答え合わせで検証する</p></div>' +
      '<div class="controls">' +
      '<div class="speed-toggle">' +
      '<button type="button" data-action="speed" data-speed="slow" class="' +
      (state.speedMode === "slow" ? "active" : "") + '">じっくり確認</button>' +
      '<button type="button" data-action="speed" data-speed="fast" class="' +
      (state.speedMode === "fast" ? "active" : "") + '">最速</button>' +
      "</div>" +
      '<button type="button" class="btn primary" data-action="run"' + runDisabled + ">実行</button>" +
      '<button type="button" class="btn" data-action="reset">リセット</button>' +
      "</div>" +
      "</div>"
    );
  }

  function buildAppHtml() {
    var parts = [];
    parts.push(buildTopbarHtml());
    if (state.error) {
      parts.push(
        '<div class="error-box"><strong>エラー:</strong> ' + escapeHtml(state.error) +
        "(リセットで再開できます)</div>"
      );
    }
    if (state.done) {
      parts.push('<div class="banner">' + state.roundsToSolve + "周ですべて正解しました</div>");
    }
    parts.push(buildStatsHtml());
    parts.push('<div class="layout"><div class="board-wrap">' + buildBoardHtml() + "</div>" + buildPanelHtml() + "</div>");
    parts.push(buildLegendHtml());
    parts.push(buildLogHtml());
    return parts.join("");
  }

  // state から DOM を全部 innerHTML で再生成する(docs/DESIGN.md 4.4)。
  function render() {
    var app = document.getElementById("app");
    if (app) app.innerHTML = buildAppHtml();
  }

  // #app の innerHTML は毎回作り直すので、クリックは document に委譲して一度だけ登録する。
  document.addEventListener("click", function (e) {
    var target = e.target && e.target.closest ? e.target.closest("[data-action]") : null;
    if (!target) return;
    var action = target.getAttribute("data-action");
    if (action === "run") run();
    else if (action === "reset") reset();
    else if (action === "speed") setSpeed(target.getAttribute("data-speed"));
  });

  render();
})();
</script>
</body>
</html>
`;
