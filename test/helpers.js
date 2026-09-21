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

// ラッパーの無い素の形式。Cloudflare が将来ゲートウェイを外しても動くことの確認に使う。
export function bareJevResponse() {
  return {
    model: "jev-1.13.0",
    answers: { digit: jevAnswer() },
    usage: { input_tokens: 665, output_tokens: 80 },
  };
}

/**
 * Map ベースの KV スタブ。
 *
 * - `gets` に読んだキー、`puts` に書いたキー・値・options を順に記録する
 *   (「全体超過なら IP のキーを読まない」「超過なら書かない」の確認に使う)
 * - `initial` のキーは末尾に `*` を付けると前方一致のシードになる。
 *   レート制限のキーにはバケット番号(現在時刻依存)が入るため、テスト側で
 *   バケットを計算すると境界をまたいだ瞬間に落ちる。`{"rl:global:*": 5}` の形で
 *   シードしておけば、どのバケットになっても同じ値が読める。
 * - `failOn` に `"get"` / `"put"` を渡すと、その操作で例外を投げる(KV 障害の再現)
 */
export function makeKV(initial, failOn) {
  var store = new Map();
  var prefixes = [];
  if (initial) {
    for (var key in initial) {
      if (key.endsWith("*")) prefixes.push({ prefix: key.slice(0, -1), value: String(initial[key]) });
      else store.set(key, String(initial[key]));
    }
  }
  var gets = [];
  var puts = [];
  return {
    store: store,
    gets: gets,
    puts: puts,
    async get(key) {
      gets.push(key);
      if (failOn === "get") throw new Error("KV get failed");
      if (store.has(key)) return store.get(key);
      for (var i = 0; i < prefixes.length; i++) {
        if (key.startsWith(prefixes[i].prefix)) return prefixes[i].value;
      }
      return null;
    },
    async put(key, value, options) {
      puts.push({ key: key, value: value, options: options });
      if (failOn === "put") throw new Error("KV put failed");
      store.set(key, String(value));
    },
  };
}

/** `rl:global:<bucket>` / `rl:ip:<ip>:<bucket>` からバケット番号を取り出す。 */
export function bucketFromKey(key) {
  return Number(key.slice(key.lastIndexOf(":") + 1));
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
