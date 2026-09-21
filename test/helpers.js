// テスト用のモック env とヘルパー(docs/DESIGN.md 10章)。
// node --test は test/ 配下のファイルをすべてテストファイルとして読み込むため、
// このファイルにはテストを書かない(0件で成功扱いになる)。

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

// docs/DESIGN.md 3.4 の形の固定レスポンス
export function jevResponse() {
  return {
    model: "jev-1.13.0",
    answers: {
      digit: {
        type: "choice",
        choice: "4",
        confidence: 0.61,
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
      },
    },
    usage: { input_tokens: 380, output_tokens: 45 },
  };
}

/** Map ベースの KV スタブ。put の expirationTtl も記録する。 */
export function makeKV(initial) {
  var store = new Map();
  if (initial) {
    for (var key in initial) store.set(key, String(initial[key]));
  }
  var puts = [];
  return {
    store: store,
    puts: puts,
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value, options) {
      puts.push({ key: key, value: value, options: options });
      store.set(key, String(value));
    },
  };
}

/**
 * モック env を作る。
 * options: { kv, vars, aiResult, aiError }
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
  if (opts.kv !== null) env.RATE_LIMIT_KV = opts.kv || makeKV();
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

export function judgeRequest(body, ip) {
  return new Request("https://example.com/api/judge", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "CF-Connecting-IP": ip || "203.0.113.1",
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
