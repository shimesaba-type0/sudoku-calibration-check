// POST /api/judge の content-type 検査・入力検証・応答検証(docs/DESIGN.md 3.3)。
import { test } from "node:test";
import assert from "node:assert/strict";

import worker from "../src/index.js";
import {
  GIVEN,
  makeEnv,
  makeRateLimiter,
  judgeRequest,
  validBody,
  jevResponse,
  bareJevResponse,
  jevAnswer,
} from "./helpers.js";

async function judge(body, envOptions) {
  var env = makeEnv(envOptions);
  var res = await worker.fetch(judgeRequest(body), env);
  var payload = await res.json();
  return { res: res, body: payload, env: env };
}

/**
 * 「埋まっているマスがちょうど count 個」の盤面を作る。行・列・箱の矛盾は気にしない
 * (Worker は矛盾を検証しない)。skip のマスだけは必ず空にする(target 用)。
 */
function filledPuzzle(count, skip) {
  var rows = [];
  var placed = 0;
  for (var r = 0; r < 9; r++) {
    var line = "";
    for (var c = 0; c < 9; c++) {
      var isSkip = skip && skip.row === r && skip.col === c;
      if (!isSkip && placed < count) {
        line += String((c % 9) + 1);
        placed++;
      } else {
        line += ".";
      }
    }
    rows.push(line);
  }
  return rows;
}

test("正常入力で 200 と9キーの probabilities が返る", async () => {
  var out = await judge(validBody());
  assert.equal(out.res.status, 200);
  assert.equal(out.res.headers.get("content-type"), "application/json; charset=utf-8");
  assert.deepEqual(Object.keys(out.body).sort(), ["choice", "confidence", "probabilities", "request"]);
  assert.deepEqual(Object.keys(out.body.probabilities), ["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
  assert.equal(out.body.choice, "4");
  assert.equal(out.body.confidence, 0.31);
});

test("200: request は env.AI.run に渡したペイロードそのもの(Issue #34)", async () => {
  var out = await judge(validBody());
  assert.equal(out.res.status, 200);
  assert.deepStrictEqual(out.env.aiCalls.length, 1);
  assert.deepStrictEqual(out.body.request, out.env.aiCalls[0].payload);
});

test("confidence は Jev の値をそのまま通す(probabilities[choice] に置き換えない)", async () => {
  var out = await judge(validBody());
  assert.equal(out.res.status, 200);
  assert.equal(out.body.confidence, jevAnswer().confidence);
  assert.notEqual(
    out.body.confidence,
    out.body.probabilities[out.body.choice],
    "confidence が probabilities[choice] に差し替えられている"
  );
});

test("ラッパーの無い素のレスポンスでも 200(ゲートウェイが外れた場合の保険)", async () => {
  var env = makeEnv({ aiResult: bareJevResponse() });
  var res = await worker.fetch(judgeRequest(validBody()), env);
  assert.equal(res.status, 200);
  var body = await res.json();
  assert.deepEqual(Object.keys(body).sort(), ["choice", "confidence", "probabilities", "request"]);
  assert.equal(body.choice, "4");
  assert.equal(body.confidence, 0.31);
  assert.deepEqual(Object.keys(body.probabilities), ["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
});

test("CORS ヘッダーは付けない", async () => {
  var env = makeEnv();
  var res = await worker.fetch(judgeRequest(validBody()), env);
  assert.equal(res.headers.get("access-control-allow-origin"), null);
});

// --- 415: content-type 検査(レート制限より前) ------------------------------

async function expect415(label, contentType) {
  var limiter = makeRateLimiter();
  var env = makeEnv({ limiter: limiter });
  var res = await worker.fetch(judgeRequest(validBody(), "203.0.113.1", contentType), env);
  assert.equal(res.status, 415, label + ": 415 を期待したが " + res.status);
  assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
  var body = await res.json();
  assert.equal(body.error, "content-type は application/json である必要があります");
  assert.equal(env.aiCalls.length, 0, label + ": AI.run が呼ばれている");
  // レート制限より前で止まるのでカウンタには一切触らない(回数にも数えない)
  assert.equal(limiter.calls.length, 0, label + ": レート制限のカウンタを呼んでいる");
}

test("415: content-type が application/json でない", async () => {
  await expect415("text/plain", "text/plain");
  await expect415("text/plain;charset=utf-8", "text/plain;charset=utf-8");
  await expect415("application/x-www-form-urlencoded", "application/x-www-form-urlencoded");
  await expect415("content-type なし", null);
  await expect415("別のメディアタイプ(前方一致で通してはいけない)", "application/json-patch+json");
  await expect415("application/jsonx", "application/jsonx");
});

test("415 にならない content-type(charset 付き・大文字)", async () => {
  var env = makeEnv();
  var withCharset = await worker.fetch(
    judgeRequest(validBody(), "203.0.113.1", "application/json; charset=utf-8"),
    env
  );
  assert.equal(withCharset.status, 200);

  var upper = await worker.fetch(
    judgeRequest(validBody(), "203.0.113.1", "Application/JSON"),
    env
  );
  assert.equal(upper.status, 200);
});

// --- 400: 入力検証 ----------------------------------------------------------

async function expect400(label, body) {
  var out = await judge(body);
  assert.equal(out.res.status, 400, label + ": 400 を期待したが " + out.res.status);
  assert.equal(out.res.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(typeof out.body.error, "string", label + ": error が文字列でない");
  assert.ok(out.body.error.length > 0, label + ": error が空");
  assert.equal(out.env.aiCalls.length, 0, label + ": 400 なのに AI.run が呼ばれている");
}

test("400: JSON として読めないボディ", async () => {
  var env = makeEnv();
  var res = await worker.fetch(judgeRequest("{これはJSONではない"), env);
  assert.equal(res.status, 400);
  var body = await res.json();
  assert.equal(typeof body.error, "string");
  assert.equal(env.aiCalls.length, 0);
});

test("400: puzzle が無い / 配列でない / 長さが9でない", async () => {
  await expect400("puzzle 欠落", { target: { row: 0, col: 2 } });
  await expect400("puzzle が文字列", { puzzle: "53..7....", target: { row: 0, col: 2 } });
  await expect400("8行", { puzzle: GIVEN.slice(0, 8), target: { row: 0, col: 2 } });
  await expect400("10行", { puzzle: GIVEN.concat(["........."]), target: { row: 0, col: 2 } });
  await expect400("ボディが配列", [1, 2, 3]);
  await expect400("ボディが数値", 42);
});

test("400: 行が9文字でない / 使えない文字が入っている", async () => {
  var short = GIVEN.slice();
  short[3] = "8...6...";
  await expect400("8文字の行", { puzzle: short, target: { row: 0, col: 2 } });

  var long = GIVEN.slice();
  long[3] = "8...6...33";
  await expect400("10文字の行", { puzzle: long, target: { row: 0, col: 2 } });

  var zero = GIVEN.slice();
  zero[2] = ".98...06."; // 0 は使えない
  await expect400("0 を含む行", { puzzle: zero, target: { row: 0, col: 2 } });

  var letter = GIVEN.slice();
  letter[2] = ".98..x.6.";
  await expect400("英字を含む行", { puzzle: letter, target: { row: 0, col: 2 } });

  var notString = GIVEN.slice();
  notString[5] = 123456789;
  await expect400("文字列でない行", { puzzle: notString, target: { row: 0, col: 2 } });
});

test("400: target が無い / 型が違う / 範囲外 / 整数でない", async () => {
  await expect400("target 欠落", { puzzle: GIVEN.slice() });
  await expect400("target が配列", { puzzle: GIVEN.slice(), target: [0, 2] });
  await expect400("row が欠落", { puzzle: GIVEN.slice(), target: { col: 2 } });
  await expect400("row が文字列", { puzzle: GIVEN.slice(), target: { row: "0", col: 2 } });
  await expect400("row が小数", { puzzle: GIVEN.slice(), target: { row: 0.5, col: 2 } });
  await expect400("row が負", { puzzle: GIVEN.slice(), target: { row: -1, col: 2 } });
  await expect400("row が 9", { puzzle: GIVEN.slice(), target: { row: 9, col: 2 } });
  await expect400("col が 9", { puzzle: GIVEN.slice(), target: { row: 0, col: 9 } });
  await expect400("col が null", { puzzle: GIVEN.slice(), target: { row: 0, col: null } });
});

test("400: 埋まっているマスが16個以下", async () => {
  // 一意解を持つ数独の最小ヒント数は17。これ未満は数独として成立しない。
  await expect400("16個", { puzzle: filledPuzzle(16, { row: 8, col: 8 }), target: { row: 8, col: 8 } });
  await expect400("1個", { puzzle: filledPuzzle(1, { row: 8, col: 8 }), target: { row: 8, col: 8 } });
  await expect400("0個(全部空)", {
    puzzle: filledPuzzle(0, { row: 8, col: 8 }),
    target: { row: 8, col: 8 },
  });
});

test("200: 埋まっているマスが17個ちょうど", async () => {
  var out = await judge({ puzzle: filledPuzzle(17, { row: 8, col: 8 }), target: { row: 8, col: 8 } });
  assert.equal(out.res.status, 200, "17個は受け付ける");
  assert.equal(out.env.aiCalls.length, 1);
});

test("200: 固定問題と無関係な別の盤面でも target が空なら通る(ジェネレーター対応)", async () => {
  // 固定問題(GIVEN)とは初期配置がまったく違う盤面。Worker はもう特定の問題を知らない。
  var other = [
    "....9..5.",
    "..24..1..",
    ".9.....42",
    "...8.7...",
    "6.......3",
    "...2.4...",
    "37.....8.",
    "..5..69..",
    ".2..3....",
  ];
  var out = await judge({ puzzle: other, target: { row: 0, col: 0 } });
  assert.equal(out.res.status, 200);
  assert.deepEqual(out.env.aiCalls[0].payload.state.puzzle, other);

  // 固定問題の given のマスを空にした盤面でも通る(「改変された」とは見なさない)
  var erased = GIVEN.slice();
  erased[0] = ".3..7....";
  var out2 = await judge({ puzzle: erased, target: { row: 0, col: 0 } });
  assert.equal(out2.res.status, 200, "GIVEN の数字を消してあっても 400 にはしない");
});

test("400: target のマスが空(.)でない", async () => {
  // 固定問題の given を指す場合も、空でない以上はこの理由で 400 になる
  await expect400("(0,0) には 5 が入っている", { puzzle: GIVEN.slice(), target: { row: 0, col: 0 } });
  await expect400("(8,8) には 9 が入っている", { puzzle: GIVEN.slice(), target: { row: 8, col: 8 } });

  // 再判定のとき、そのマスの前回の推測を消さずに送ってきたケース
  var filled = GIVEN.slice();
  filled[0] = "531.7...."; // (0,2) に前回の推測 1 が残っている
  await expect400("target に推測が残っている", { puzzle: filled, target: { row: 0, col: 2 } });
});

test("空マスに過去の周の推測が入っていても 200(対象マス以外は正誤問わず残す)", async () => {
  var guessed = GIVEN.slice();
  guessed[0] = "531175111"; // わざと矛盾した推測。与えられた 5/3/7 の位置は保つ
  guessed[2] = ".98....6."; // 対象マス (2,0) は空のまま
  var out = await judge({ puzzle: guessed, target: { row: 2, col: 0 } });
  assert.equal(out.res.status, 200);
  assert.equal(out.env.aiCalls[0].payload.state.puzzle[0], "531175111");
  assert.equal(out.env.aiCalls[0].payload.state.puzzle[2][0], ".");
});

// --- 502: AI 呼び出しの失敗と応答の形 ---------------------------------------

test("502: AI.run が例外を投げる", async () => {
  var env = makeEnv({ aiError: new Error("upstream exploded") });
  var res = await worker.fetch(judgeRequest(validBody()), env);
  assert.equal(res.status, 502);
  assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
  var body = await res.json();
  assert.equal(typeof body.error, "string");
  assert.ok("raw" in body);
  assert.ok(String(body.raw).includes("upstream exploded"));
  // 502(AI呼び出し失敗)にも request が付く(Issue #34)。
  assert.deepStrictEqual(body.request, env.aiCalls[0].payload);
});

test("502: 応答の形が不正なときも request が付く(Issue #34)", async () => {
  var env = makeEnv({ aiResult: { answers: {} } });
  var res = await worker.fetch(judgeRequest(validBody()), env);
  assert.equal(res.status, 502);
  var body = await res.json();
  assert.deepStrictEqual(body.request, env.aiCalls[0].payload);
});

test("400 には request が付かない(Issue #34、まだ payload を組み立てていない)", async () => {
  var env = makeEnv();
  var res = await worker.fetch(judgeRequest({ puzzle: validBody().puzzle }), env);
  assert.equal(res.status, 400);
  var body = await res.json();
  assert.equal("request" in body, false);
});

test("400 と 502 にも X-RateLimit-Remaining-* が付く(どちらも1回として数えるため)", async () => {
  var env = makeEnv();
  var res400 = await worker.fetch(judgeRequest({ puzzle: validBody().puzzle }), env);
  assert.equal(res400.status, 400);
  assert.equal(res400.headers.get("X-RateLimit-Remaining-IP"), "29");
  assert.equal(res400.headers.get("X-RateLimit-Remaining-Global"), "499");

  var env2 = makeEnv({ aiError: new Error("boom") });
  var res502 = await worker.fetch(judgeRequest(validBody()), env2);
  assert.equal(res502.status, 502);
  assert.equal(res502.headers.get("X-RateLimit-Remaining-IP"), "29");
  assert.equal(res502.headers.get("X-RateLimit-Remaining-Global"), "499");
});

test("502: raw は200文字で切り詰める", async () => {
  var env = makeEnv({ aiError: new Error("x".repeat(1000)) });
  var res = await worker.fetch(judgeRequest(validBody()), env);
  assert.equal(res.status, 502);
  var body = await res.json();
  assert.ok(body.raw.length <= 201, "raw が切り詰められていない: " + body.raw.length);
});

test("502: answers.digit が無い", async () => {
  var shapes = [
    {},
    { model: "jev-1.13.0", answers: {} },
    { model: "jev-1.13.0", answers: { other: { choice: "4" } } },
    null,
    undefined,
    "まさかの文字列",
    [1, 2, 3],
    // ラッパーはあるが result.answers が無い / 形が違う
    { state: "Completed", result: { model: "jev-1.13.0", usage: {} } },
    { state: "Completed", result: { model: "jev-1.13.0", answers: {} } },
    { state: "Completed", result: { model: "jev-1.13.0", answers: null } },
    { state: "Completed", result: { model: "jev-1.13.0", answers: [] } },
    { state: "Completed", result: {} },
    // result が非オブジェクトならトップレベルの answers を見るが、そこにも無い
    { state: "Completed", result: "こわれた" },
  ];
  for (var i = 0; i < shapes.length; i++) {
    var env = makeEnv({ aiResult: shapes[i] });
    var res = await worker.fetch(judgeRequest(validBody()), env);
    assert.equal(res.status, 502, "shape #" + i + ": 502 を期待");
    var body = await res.json();
    assert.equal(typeof body.error, "string");
    assert.ok("raw" in body, "shape #" + i + ": raw が無い");
  }
});

test("502: state が Completed でない", async () => {
  var states = ["Queued", "Running", "Failed", "completed", "", null, 0];
  for (var i = 0; i < states.length; i++) {
    // 中身(result.answers.digit)は完全に正常。state だけで止まることを確かめる。
    var response = jevResponse();
    response.state = states[i];
    var env = makeEnv({ aiResult: response });
    var res = await worker.fetch(judgeRequest(validBody()), env);
    assert.equal(res.status, 502, "state=" + String(states[i]) + ": 502 を期待したが " + res.status);
    var body = await res.json();
    assert.equal(body.error, "AIの応答が完了していません");
    assert.ok("raw" in body, "state=" + String(states[i]) + ": raw が無い");
  }
});

/** 既定の正常レスポンスの answers.digit を差し替えたものを返す。 */
function withDigit(digit) {
  var response = jevResponse();
  response.result.answers.digit = digit;
  return response;
}

test("502: answers.digit の形がおかしい", async () => {
  var cases = {
    "digit がオブジェクトでない": "4",
    "digit が配列": [1, 2, 3],
    "digit が null": null,
    "probabilities が無い": { type: "choice", choice: "4", confidence: 0.61 },
    "probabilities が配列": {
      choice: "4",
      confidence: 0.61,
      probabilities: [0.03, 0.05, 0.02, 0.61, 0.08, 0.07, 0.04, 0.06, 0.04],
    },
    "probabilities のキーが足りない": {
      choice: "4",
      confidence: 0.61,
      probabilities: { 1: 0.1, 2: 0.1, 3: 0.1, 4: 0.7 },
    },
    "probabilities のキーが多い": {
      choice: "4",
      confidence: 0.61,
      probabilities: { 1: 0.1, 2: 0.1, 3: 0.1, 4: 0.1, 5: 0.1, 6: 0.1, 7: 0.1, 8: 0.1, 9: 0.1, 10: 0.1 },
    },
    "probabilities のキーが 0〜8 になっている": {
      choice: "4",
      confidence: 0.61,
      probabilities: { 0: 0.1, 1: 0.1, 2: 0.1, 3: 0.1, 4: 0.1, 5: 0.1, 6: 0.1, 7: 0.1, 8: 0.2 },
    },
    "probabilities の値が文字列": {
      choice: "4",
      confidence: 0.61,
      probabilities: { 1: "0.03", 2: 0.05, 3: 0.02, 4: 0.61, 5: 0.08, 6: 0.07, 7: 0.04, 8: 0.06, 9: 0.04 },
    },
    "probabilities の値が NaN": {
      choice: "4",
      confidence: 0.61,
      probabilities: { 1: NaN, 2: 0.05, 3: 0.02, 4: 0.61, 5: 0.08, 6: 0.07, 7: 0.04, 8: 0.06, 9: 0.04 },
    },
    "choice が 1〜9 でない": {
      choice: "10",
      confidence: 0.61,
      probabilities: { 1: 0.03, 2: 0.05, 3: 0.02, 4: 0.61, 5: 0.08, 6: 0.07, 7: 0.04, 8: 0.06, 9: 0.04 },
    },
    "choice が数値": {
      choice: 4,
      confidence: 0.61,
      probabilities: { 1: 0.03, 2: 0.05, 3: 0.02, 4: 0.61, 5: 0.08, 6: 0.07, 7: 0.04, 8: 0.06, 9: 0.04 },
    },
    "confidence が無い": {
      choice: "4",
      probabilities: { 1: 0.03, 2: 0.05, 3: 0.02, 4: 0.61, 5: 0.08, 6: 0.07, 7: 0.04, 8: 0.06, 9: 0.04 },
    },
    "confidence が文字列": {
      choice: "4",
      confidence: "0.61",
      probabilities: { 1: 0.03, 2: 0.05, 3: 0.02, 4: 0.61, 5: 0.08, 6: 0.07, 7: 0.04, 8: 0.06, 9: 0.04 },
    },
  };

  for (var label in cases) {
    var env = makeEnv({ aiResult: withDigit(cases[label]) });
    var res = await worker.fetch(judgeRequest(validBody()), env);
    assert.equal(res.status, 502, label + ": 502 を期待したが " + res.status);
    var body = await res.json();
    assert.equal(typeof body.error, "string", label + ": error が無い");
    assert.ok("raw" in body, label + ": raw が無い");
  }
});

test("余計なキーが付いた answers.digit は 200(絞って返す)", async () => {
  var env = makeEnv({
    aiResult: withDigit({
      type: "choice",
      choice: "4",
      confidence: 0.61,
      probabilities: { 1: 0.03, 2: 0.05, 3: 0.02, 4: 0.61, 5: 0.08, 6: 0.07, 7: 0.04, 8: 0.06, 9: 0.04 },
      debug: "何か増えた",
    }),
  });
  var res = await worker.fetch(judgeRequest(validBody()), env);
  assert.equal(res.status, 200);
  var body = await res.json();
  assert.deepEqual(Object.keys(body).sort(), ["choice", "confidence", "probabilities", "request"]);
});
