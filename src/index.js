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

// レート制限の既定値(wrangler.toml の [vars] が無いときだけ使う)
var DEFAULT_WINDOW_SECONDS = 3600;
var DEFAULT_PER_IP_MAX = 30;
var DEFAULT_GLOBAL_MAX = 500;

// Jev にルールを伝えるための固定文。何を聞かれているかを誤解させないための最低限の説明。
var NOTE =
  "puzzle is a 9x9 Sudoku grid given as 9 strings of 9 characters each, " +
  "top row first. A digit character is a cell that is already filled in; " +
  "'.' is an empty cell. target is the cell being asked about, as zero-based " +
  "row and col indices (row 0 is the first string, col 0 is its first character). " +
  "Standard Sudoku rules apply: every row, every column and every 3x3 box must " +
  "contain each of the digits 1 to 9 exactly once. Some of the digits already " +
  "placed may be wrong. Answer which digit belongs in the target cell.";

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
 * [vars] は文字列で渡ってくる。1以上の整数として読めなければ既定値を使う
 * (空文字やタイプミスで上限が 0 になって全部止まる、という事故を避ける)。
 */
function readLimit(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  var parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return parsed;
}

function readCount(value) {
  var parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

/**
 * IP単位・全体の2段構えの固定ウィンドウ・レート制限(docs/DESIGN.md 3.2)。
 *
 * 全体 → IP単位 の順に見て、どちらか超過していれば書き込まずに拒否する。
 * 両方下回っていたときだけ2つのカウンタを +1 する。
 * RATE_LIMIT_KV が無い環境ではフェイルオープン(制限なしで通す)。
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
  await kv.put(globalKey, String(globalCount + 1), options);
  await kv.put(ipKey, String(ipCount + 1), options);

  return {
    allowed: true,
    headers: {
      "X-RateLimit-Remaining-IP": String(Math.max(0, perIpMax - (ipCount + 1))),
      "X-RateLimit-Remaining-Global": String(Math.max(0, globalMax - (globalCount + 1))),
    },
  };
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

  return null;
}

/**
 * POST /api/judge(docs/DESIGN.md 3.3)。
 * 受け取った盤面だけを見て Jev に1マス分の確率を聞く。盤面も結果も保存しない。
 */
async function handleJudge(request, env) {
  var rate = await checkRateLimit(request, env);
  if (!rate.allowed) {
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
        instructions: "Which digit from 1 to 9 belongs in the target cell of this Sudoku grid?",
        criteria: criteria,
      },
    },
  };

  var result;
  try {
    result = await env.AI.run("typesafe/jev", payload);
  } catch (err) {
    return jsonResponse(
      {
        error: "AIの呼び出しに失敗しました",
        raw: String((err && err.message) || err),
      },
      502,
      rate.headers
    );
  }

  var answer = result && result.answers && result.answers.digit;
  if (!answer) {
    return jsonResponse(
      { error: "AIの応答が予期しない形式です", raw: result },
      502,
      rate.headers
    );
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
// テンプレート内で ${} を書く必要が出たら \${} とエスケープすること。
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
