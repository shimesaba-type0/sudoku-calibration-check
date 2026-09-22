// テスト用のモック env とヘルパー(docs/DESIGN.md 10章)。
// `npm test` は `node --test "test/**/*.test.js"` なので、このファイル自体は
// テストファイルとしては拾われない(各 *.test.js から import して使う)。

export var GIVEN = [
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

// 採点用の正解表。テストからは「これが Jev に渡っていないこと」の確認にだけ使う。
export var ANSWER_KEY = [
  "534678912",
  "672195348",
  "198342567",
  "859761423",
  "426853791",
  "713924856",
  "961537284",
  "287419635",
  "345286179",
];

// docs/DESIGN.md 3.4 の `answers.digit`。
// `confidence` は Jev 独自の確信度で、`probabilities[choice]`(0.61)とは **わざと** 別の値に
// してある。2026-09-21 の実測でも両者は一致しなかった(0.10 対 0.20 など)。
export function jevAnswer() {
  return {
    type: "choice",
    choice: "4",
    probabilities: {
      1: 0.03,
      2: 0.05,
      3: 0.02,
      4: 0.61,
      5: 0.08,
      6: 0.07,
      7: 0.04,
      8: 0.06,
      9: 0.04,
    },
    confidence: 0.31,
  };
}

// 実環境(AI Gateway 経由)で返ってくるラッパー形式。docs/DESIGN.md 3.4。
export function jevResponse() {
  return {
    state: "Completed",
    result: {
      model: "jev-1.13.0",
      answers: { digit: jevAnswer() },
      usage: { input_tokens: 665, output_tokens: 80 },
    },
    gatewayMetadata: { keySource: "Unified" },
  };
}

/**
 * 盤面の空マス(".")のキー("r{row}c{col}")を行優先で列挙する。
 * src/index.js の `emptyCells` を **意図的に複製** したもの(実装から import しない)。
 */
export function emptyCellKeys(puzzle) {
  var keys = [];
  for (var r = 0; r < 9; r++) {
    for (var c = 0; c < 9; c++) {
      if (puzzle[r][c] === ".") keys.push("r" + r + "c" + c);
    }
  }
  return keys;
}

/**
 * ask:"cell" 用の `answers.cell`(Issue #38)。`probabilities` のキーは criteria の
 * キー集合とちょうど一致させる。`confidence` は digit と同じく probabilities[choice] とは
 * 別の値にしてある。
 */
export function jevCellAnswer(keys, choice) {
  var probabilities = {};
  for (var i = 0; i < keys.length; i++) {
    probabilities[keys[i]] = Number((1 / keys.length).toFixed(6));
  }
  return {
    type: "choice",
    choice: choice === undefined ? keys[0] : choice,
    probabilities: probabilities,
    confidence: 0.42,
  };
}

/** ask:"cell" のラッパー付きレスポンス(docs/DESIGN.md 3.4 と同じ形)。 */
export function jevCellResponse(keys, choice) {
  return {
    state: "Completed",
    result: {
      model: "jev-1.13.0",
      answers: { cell: jevCellAnswer(keys, choice) },
      usage: { input_tokens: 700, output_tokens: 90 },
    },
    gatewayMetadata: { keySource: "Unified" },
  };
}

/**
 * ask:"where" 用の `answers`(Issue #45)。空マスのキーごとに noul の回答を1つ作る。
 * 値はキーごとに変えてある(取り違えが起きたらテストが落ちるように)。
 */
export function jevWhereAnswers(keys) {
  var answers = {};
  for (var i = 0; i < keys.length; i++) {
    answers[keys[i]] = { type: "noul", noul: Number((0.01 * ((i % 90) + 1)).toFixed(4)) };
  }
  return answers;
}

/**
 * ask:"where" のラッパー付きレスポンス(docs/DESIGN.md 3.4 と同じ形)。
 * usage は 2026-09-22 に 51 個の noul 質問を1回で投げたときの実測値。
 */
export function jevWhereResponse(keys) {
  return {
    state: "Completed",
    result: {
      model: "jev-1.13.0",
      answers: jevWhereAnswers(keys),
      usage: { input_tokens: 1948, output_tokens: 973 },
    },
    gatewayMetadata: { keySource: "Unified" },
  };
}

/**
 * ask:"all" 用の `answers`(Issue #48)。空マスのキーごとに digit と同じ形の choice の
 * 回答を1つ作る。`choice` と `confidence` はキーごとに変えてある(取り違えが起きたら
 * テストが落ちるように)。`confidence` は digit / cell と同じく probabilities[choice] とは
 * 別の値になる。
 */
export function jevAllAnswers(keys) {
  var answers = {};
  for (var i = 0; i < keys.length; i++) {
    var choice = String((i % 9) + 1);
    var probabilities = {};
    for (var d = 1; d <= 9; d++) {
      probabilities[String(d)] = String(d) === choice ? 0.6 : 0.05;
    }
    answers[keys[i]] = {
      type: "choice",
      choice: choice,
      probabilities: probabilities,
      confidence: Number((0.01 * ((i % 90) + 1)).toFixed(4)),
    };
  }
  return answers;
}

/**
 * ask:"all" のラッパー付きレスポンス(docs/DESIGN.md 3.4 と同じ形)。
 * usage は 2026-09-22 に choice の質問51個を1回で投げたときの実測値。
 */
export function jevAllResponse(keys) {
  return {
    state: "Completed",
    result: {
      model: "jev-1.13.0",
      answers: jevAllAnswers(keys),
      usage: { input_tokens: 9483, output_tokens: 4083 },
    },
    gatewayMetadata: { keySource: "Unified" },
  };
}

// ラッパーの無い素の形式。Cloudflare が将来ゲートウェイを外しても動くことの確認に使う。
export function bareJevResponse() {
  return {
    model: "jev-1.13.0",
    answers: { digit: jevAnswer() },
    usage: { input_tokens: 665, output_tokens: 80 },
  };
}

/**
 * Map ベースの Durable Object(RateLimitCounter)スタブ。
 *
 * 本物と同じ形で使えるようにしてある: `idFromName(name)` で ID を作り、`get(id)` で
 * 返ってきたスタブの `fetch(request)` を呼ぶ。中身は `src/index.js` の
 * `RateLimitCounter` と同じ意味論(`peek` は読むだけ、`increment` は上限未満のときだけ
 * +1、バケットが変われば数え直し)を Map で再現する。
 *
 * - `calls` に `{ name, op, bucket, max }` を順に記録する
 *   (「全体超過なら IP 側のインスタンスを呼ばない」の確認に使う)
 * - `initial` はインスタンス名 → カウントのシード。名前の末尾に `*` を付けると
 *   前方一致になる(`{"ip:*": 30}` で全 IP をシードできる)。シードは最初に来た
 *   バケットに対して適用されるので、ウィンドウ境界をまたいでも落ちない
 * - `failOn` に `"throw"` を渡すと fetch が例外を投げ、`"500"` を渡すと 500 を返す
 *   (Durable Object 障害の再現)
 */
export function makeRateLimiter(initial, failOn) {
  var exact = new Map();
  var prefixes = [];
  if (initial) {
    for (var key in initial) {
      if (key.endsWith("*")) prefixes.push({ prefix: key.slice(0, -1), value: Number(initial[key]) });
      else exact.set(key, Number(initial[key]));
    }
  }
  function seedFor(name) {
    if (exact.has(name)) return exact.get(name);
    for (var i = 0; i < prefixes.length; i++) {
      if (name.startsWith(prefixes[i].prefix)) return prefixes[i].value;
    }
    return 0;
  }

  // name -> { bucket, count }。本物の Durable Object インスタンスに相当する。
  var state = new Map();
  var calls = [];

  function counterResponse(allowed, count) {
    return new Response(JSON.stringify({ allowed: allowed, count: count }), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  return {
    state: state,
    calls: calls,
    idFromName(name) {
      return { name: name, toString: () => name };
    },
    get(id) {
      var name = id.name;
      return {
        async fetch(request) {
          var body = await request.json();
          calls.push({ name: name, op: body.op, bucket: body.bucket, max: body.max });
          if (failOn === "throw") throw new Error("durable object unavailable");
          if (failOn === "500") return new Response("boom", { status: 500 });

          var entry = state.get(name);
          if (!entry || entry.bucket !== body.bucket) {
            entry = { bucket: body.bucket, count: seedFor(name) };
            state.set(name, entry);
          }

          if (body.op === "peek") return counterResponse(entry.count < body.max, entry.count);
          if (entry.count >= body.max) return counterResponse(false, entry.count);
          entry.count += 1;
          return counterResponse(true, entry.count);
        },
      };
    },
  };
}

/**
 * `RateLimitCounter` の単体テスト用の `ctx` モック。`ctx.storage` の
 * `get` / `put` / `delete` を Map で提供する(本物は SQLite バックエンド)。
 */
export function makeStorageCtx(initial) {
  var store = new Map();
  if (initial) {
    for (var key in initial) store.set(key, initial[key]);
  }
  return {
    store: store,
    storage: {
      async get(key) {
        return store.has(key) ? store.get(key) : undefined;
      },
      async put(key, value) {
        store.set(key, value);
      },
      async delete(key) {
        return store.delete(key);
      },
    },
  };
}

/** `RateLimitCounter` に投げるリクエストを組み立てる。 */
export function counterRequest(op, bucket, max) {
  return new Request("https://rate-limiter.invalid/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ op: op, bucket: bucket, max: max }),
  });
}

/**
 * モック env を作る。
 * options: { limiter, vars, aiResult, aiError }(limiter に null を渡すとバインディング無し)
 * aiResult に関数を渡すと呼び出しごとに評価される。
 */
export function makeEnv(options) {
  var opts = options || {};
  var calls = [];
  var env = {
    AI: {
      async run(model, payload) {
        calls.push({ model: model, payload: payload });
        if (opts.aiError) throw opts.aiError;
        if (typeof opts.aiResult === "function") return opts.aiResult(calls.length);
        if ("aiResult" in opts) return opts.aiResult;
        return jevResponse();
      },
    },
    aiCalls: calls,
  };
  if (opts.limiter !== null) env.RATE_LIMITER = opts.limiter || makeRateLimiter();
  // [vars] は文字列として渡ってくる
  var vars = opts.vars || {};
  for (var name in vars) env[name] = String(vars[name]);
  return env;
}

/** 既定の有効な盤面(GIVEN そのまま)と対象マス。 */
export function validBody(overrides) {
  var body = { puzzle: GIVEN.slice(), target: { row: 0, col: 2 } };
  if (overrides) {
    for (var key in overrides) body[key] = overrides[key];
  }
  return body;
}

/** ask:"cell"(マス選び)の既定の有効なボディ。target は付けない。 */
export function validCellBody(overrides) {
  var body = { puzzle: GIVEN.slice(), ask: "cell" };
  if (overrides) {
    for (var key in overrides) body[key] = overrides[key];
  }
  return body;
}

/** ask:"all"(一括)の既定の有効なボディ。target も digit も付けない。 */
export function validAllBody(overrides) {
  var body = { puzzle: GIVEN.slice(), ask: "all" };
  if (overrides) {
    for (var key in overrides) body[key] = overrides[key];
  }
  return body;
}

/** ask:"where"(数字ごと)の既定の有効なボディ。target は付けず、digit が必須。 */
export function validWhereBody(overrides) {
  var body = { puzzle: GIVEN.slice(), ask: "where", digit: "4" };
  if (overrides) {
    for (var key in overrides) body[key] = overrides[key];
  }
  return body;
}

/**
 * POST /api/judge のリクエストを組み立てる。
 * contentType に null を渡すと content-type ヘッダーの無いリクエストになる
 * (文字列ボディだと fetch 仕様で text/plain が自動で付くので Blob を使う)。
 */
export function judgeRequest(body, ip, contentType) {
  var serialized = typeof body === "string" ? body : JSON.stringify(body);
  var headers = { "CF-Connecting-IP": ip || "203.0.113.1" };
  if (contentType !== null) headers["content-type"] = contentType || "application/json";
  return new Request("https://example.com/api/judge", {
    method: "POST",
    headers: headers,
    body: contentType === null ? new Blob([serialized]) : serialized,
  });
}
