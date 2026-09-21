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

  // CF-Connecting-IP はエッジが付けるので偽装はできないが、KV のキー長上限(512バイト)を
  // 超えて put が投げる想定外を避けるため念のため長さを抑える。
  var ip = (request.headers.get("CF-Connecting-IP") || "unknown").slice(0, 64);
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
    // 片方だけ成功して片方が失敗した場合(全体だけ +1 されて 503)は、数え過ぎ=安全側に倒れる
    // ので許容する。数え漏れは起きない。
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

  // ゲートウェイが完了以外の状態を返したら、中身を見ずに止める。
  if (Object.prototype.hasOwnProperty.call(response, "state") && response.state !== "Completed") {
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
    if (url.pathname === "/" && request.method === "GET") {
      return new Response(PAGE_HTML, { headers: PAGE_HEADERS });
    }
    return new Response("Not found", { status: 404 });
  },
};

// ---------------------------------------------------------------------------
// ブラウザ用の一式。このテンプレートリテラルの中だけが正解表を知っている。
// テンプレート内で ${} を書く必要が出たら \${} とエスケープすること。
//
// PAGE_HTML はこのファイルの最後の宣言のままにすること。閉じバッククォートが
// ファイル末尾にあることを前提に、不変条件7のテストが「テンプレートリテラルの外」を
// 機械的に切り出している(docs/DESIGN.md 3.5・10章)。この下には何も足さない。
//
// 本格的なUIは別 Issue。ここでは隔離の構造だけ先に用意しておく。
// ---------------------------------------------------------------------------
var PAGE_HTML = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>数独キャリブレーションチェック</title>
<style>
  :root { color-scheme: dark; }
  body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    background: #12141a;
    color: #e6e8ee;
    font-family: "IBM Plex Sans", "Helvetica Neue", Arial, sans-serif;
  }
  h1 { margin: 0; font-size: 20px; font-weight: 600; letter-spacing: 0.02em; }
  p  { margin: 0; color: #9aa1b1; font-size: 14px; }
</style>
</head>
<body>
<h1>数独キャリブレーションチェック</h1>
<p>実装中</p>
<script>
  var GIVEN = ["53..7....", "6..195...", ".98....6.", "8...6...3", "4..8.3..1", "7...2...6", ".6....28.", "...419..5", "....8..79"];
  var SOLUTION = ["534678912", "672195348", "198342567", "859761423", "426853791", "713924856", "961537284", "287419635", "345286179"];
</script>
</body>
</html>
`;
