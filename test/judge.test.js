// POST /api/judge の content-type 検査・入力検証・応答検証(docs/DESIGN.md 3.3)。
import { test } from "node:test";
import assert from "node:assert/strict";

import worker from "../src/index.js";
import {
  GIVEN,
  ANSWER_KEY,
  makeEnv,
  makeRateLimiter,
  judgeRequest,
  validBody,
  validCellBody,
  validWhereBody,
  jevResponse,
  bareJevResponse,
  jevAnswer,
  jevCellAnswer,
  jevCellResponse,
  jevWhereAnswers,
  jevWhereResponse,
  emptyCellKeys,
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

// --- ask:"cell"(マス選び。Issue #38) ---------------------------------------

// 期待値は src/index.js の CELL_NOTE / CELL_INSTRUCTIONS を **意図的に複製** している
// (不変条件1のテストと同じ流儀。文面をこっそり変えたら落ちるように実装から import しない)。
var EXPECTED_CELL_NOTE =
  "puzzle is a 9x9 Sudoku grid given as 9 strings of 9 characters each, " +
  "top row first. A digit character is a cell that is already filled in; " +
  "'.' is an empty cell. There is no target cell this time. Instead, the criteria " +
  "list every empty cell of the grid, keyed as 'r<row>c<col>' with zero-based row " +
  "and col indices (row 0 is the first string, col 0 is its first character). " +
  "Standard Sudoku rules apply: every row, every column and every 3x3 box must " +
  "contain each of the digits 1 to 9 exactly once. Some of the digits already " +
  "placed may be wrong. Answer which of those empty cells is the easiest to " +
  "determine, that is, the cell whose digit you can state with the most confidence.";

var EXPECTED_CELL_INSTRUCTIONS =
  "Which empty cell of this Sudoku grid can be filled in with the most certainty? " +
  "Pick the cell whose digit you are most confident about.";

// GIVEN の空マスのキー(行優先)。実装から import せずテスト側で作る。
var GIVEN_CELL_KEYS = emptyCellKeys(GIVEN);

/** ask:"cell" を投げ、モック AI には criteria と一致する probabilities を返させる。 */
async function judgeCell(body, choice) {
  var target = body || validCellBody();
  var keys = emptyCellKeys(target.puzzle || GIVEN);
  var env = makeEnv({ aiResult: jevCellResponse(keys, choice) });
  var res = await worker.fetch(judgeRequest(target), env);
  var payload = await res.json();
  return { res: res, body: payload, env: env, keys: keys };
}

test('ask:"cell": payload は target 無し・CELL_NOTE・空マスの criteria', async () => {
  var out = await judgeCell();
  assert.equal(out.res.status, 200);
  assert.equal(out.env.aiCalls.length, 1);
  assert.equal(out.env.aiCalls[0].model, "typesafe/jev");

  var payload = out.env.aiCalls[0].payload;
  assert.deepEqual(Object.keys(payload).sort(), ["questions", "state"]);
  // state に target は無い(盤面全体から選ばせる質問なので対象マスが存在しない)
  assert.deepEqual(Object.keys(payload.state).sort(), ["note", "puzzle"]);
  assert.equal("target" in payload.state, false);
  assert.deepEqual(payload.state.puzzle, GIVEN);
  assert.equal(payload.state.note, EXPECTED_CELL_NOTE);

  // questions は cell ひとつだけ(digit は出てこない)
  assert.deepEqual(Object.keys(payload.questions), ["cell"]);
  assert.deepEqual(Object.keys(payload.questions.cell).sort(), [
    "criteria",
    "instructions",
    "type",
  ]);
  assert.equal(payload.questions.cell.type, "choice");
  assert.equal(payload.questions.cell.instructions, EXPECTED_CELL_INSTRUCTIONS);

  // criteria のキーは空マスの一覧で、行優先の順
  assert.deepEqual(Object.keys(payload.questions.cell.criteria), GIVEN_CELL_KEYS);
  assert.equal(GIVEN_CELL_KEYS.length, 51, "固定問題の空マスは51個");
  assert.equal(payload.questions.cell.criteria.r0c2, "row 0, column 2 (zero-based)");
  assert.equal(payload.questions.cell.criteria.r8c6, "row 8, column 6 (zero-based)");
  assert.equal(payload.questions.cell.criteria.r0c0, undefined, "埋まっているマスは候補に入れない");
});

test('ask:"cell": 埋まっているマスは criteria に入らない(推測入りの盤面)', async () => {
  var guessed = GIVEN.slice();
  guessed[0] = "531175111"; // 1行目は全部埋まった状態
  var out = await judgeCell(validCellBody({ puzzle: guessed }));
  assert.equal(out.res.status, 200);
  var keys = Object.keys(out.env.aiCalls[0].payload.questions.cell.criteria);
  assert.deepEqual(keys, emptyCellKeys(guessed));
  for (var i = 0; i < keys.length; i++) {
    assert.ok(!keys[i].startsWith("r0c"), "埋まっている1行目のマスが候補に入っている: " + keys[i]);
  }
});

test('ask:"cell": 200 の形(probabilities / choice / confidence / request / cell)', async () => {
  var out = await judgeCell(undefined, "r3c5");
  assert.equal(out.res.status, 200);
  assert.equal(out.res.headers.get("content-type"), "application/json; charset=utf-8");
  assert.deepEqual(Object.keys(out.body).sort(), [
    "cell",
    "choice",
    "confidence",
    "probabilities",
    "request",
  ]);
  assert.equal(out.body.choice, "r3c5");
  // choice を座標に分解したものが cell(フロントが毎回パースしなくて済むように)
  assert.deepStrictEqual(out.body.cell, { row: 3, col: 5 });
  assert.equal(out.body.confidence, 0.42);
  assert.deepEqual(Object.keys(out.body.probabilities), GIVEN_CELL_KEYS);
  // request は env.AI.run に渡したペイロードそのもの(Issue #34)
  assert.deepStrictEqual(out.body.request, out.env.aiCalls[0].payload);
});

test('ask:"cell": choice がどの候補でも cell がその座標になる', async () => {
  var cases = ["r0c2", "r8c6", "r0c8", "r8c0"];
  for (var i = 0; i < cases.length; i++) {
    var out = await judgeCell(undefined, cases[i]);
    assert.equal(out.res.status, 200, cases[i]);
    assert.equal(out.body.choice, cases[i]);
    assert.deepStrictEqual(out.body.cell, {
      row: Number(cases[i][1]),
      col: Number(cases[i][3]),
    });
  }
});

test('ask:"cell": payload に正解表の行が一切含まれない(不変条件1)', async () => {
  var out = await judgeCell();
  var serialized = JSON.stringify(out.env.aiCalls[0].payload);
  for (var i = 0; i < ANSWER_KEY.length; i++) {
    assert.ok(
      !serialized.includes(ANSWER_KEY[i]),
      "payload に正解表の " + (i + 1) + " 行目が含まれている: " + ANSWER_KEY[i]
    );
  }
});

test('ask:"digit" を明示しても省略時とまったく同じ(従来どおり)', async () => {
  var omitted = await judge(validBody());
  var explicit = await judge(validBody({ ask: "digit" }));
  assert.equal(explicit.res.status, 200);
  assert.deepStrictEqual(explicit.env.aiCalls[0].payload, omitted.env.aiCalls[0].payload);
  assert.deepEqual(Object.keys(explicit.body).sort(), [
    "choice",
    "confidence",
    "probabilities",
    "request",
  ]);
  assert.equal("cell" in explicit.body, false, "digit の応答に cell は付けない");
});

test("400: ask が digit / cell / 省略 のいずれでもない", async () => {
  var bad = ["cells", "digits", "", "DIGIT", "Cell", null, 1, true, {}, ["cell"]];
  for (var i = 0; i < bad.length; i++) {
    await expect400("ask=" + JSON.stringify(bad[i]), validBody({ ask: bad[i] }));
  }
});

test('400: ask:"cell" に target が付いている', async () => {
  await expect400("target 付き", { puzzle: GIVEN.slice(), ask: "cell", target: { row: 0, col: 2 } });
  await expect400("target が null", { puzzle: GIVEN.slice(), ask: "cell", target: null });
  await expect400("target が空オブジェクト", { puzzle: GIVEN.slice(), ask: "cell", target: {} });
});

test('400: ask:"cell" で空マスが1つも無い(全部埋まった盤面)', async () => {
  // ANSWER_KEY は81マスすべて埋まった盤面。聞くものが無いので 400。
  await expect400("全部埋まっている", { puzzle: ANSWER_KEY.slice(), ask: "cell" });
});

test('400: ask:"cell" でも埋まっているマスが17個未満なら弾く', async () => {
  await expect400("16個", { puzzle: filledPuzzle(16), ask: "cell" });
  await expect400("0個(全部空)", { puzzle: filledPuzzle(0), ask: "cell" });
});

test('400: ask:"cell" でも puzzle の形式は従来どおり見る', async () => {
  await expect400("puzzle 欠落", { ask: "cell" });
  await expect400("8行", { puzzle: GIVEN.slice(0, 8), ask: "cell" });
  var letter = GIVEN.slice();
  letter[2] = ".98..x.6.";
  await expect400("英字を含む行", { puzzle: letter, ask: "cell" });
});

test('200: ask:"cell" で埋まっているマスが17個ちょうど', async () => {
  var out = await judgeCell(validCellBody({ puzzle: filledPuzzle(17) }));
  assert.equal(out.res.status, 200);
  assert.equal(out.env.aiCalls.length, 1);
  assert.equal(Object.keys(out.env.aiCalls[0].payload.questions.cell.criteria).length, 81 - 17);
});

test('200: ask:"cell" で空マスが1個(criteria 1件)でも動く', async () => {
  // 正解表の 1 マスだけを空にした盤面(残り 80 マス埋まり)。criteria / probabilities は 1 キー。
  var puzzle = ANSWER_KEY.slice();
  puzzle[4] = puzzle[4].slice(0, 4) + "." + puzzle[4].slice(5);
  var out = await judgeCell(validCellBody({ puzzle: puzzle }));
  assert.equal(out.res.status, 200);
  assert.deepEqual(out.keys, ["r4c4"]);
  assert.deepEqual(Object.keys(out.env.aiCalls[0].payload.questions.cell.criteria), ["r4c4"]);
  assert.deepEqual(Object.keys(out.body.probabilities), ["r4c4"]);
  assert.equal(out.body.choice, "r4c4");
  assert.deepEqual(out.body.cell, { row: 4, col: 4 });
});

test('400: ask:"cell" の puzzle 不正の文言は target に触れない(digit の文言は従来どおり)', async () => {
  var env = makeEnv();
  var res = await worker.fetch(judgeRequest({ ask: "cell" }), env);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "puzzle(9行の配列)が必要です");
  var res2 = await worker.fetch(judgeRequest({ ask: "digit" }), env);
  assert.equal(res2.status, 400);
  assert.equal((await res2.json()).error, "puzzle(9行の配列)とtarget({row,col})が必要です");
  assert.equal(env.aiCalls.length, 0);
});

test('502: ask:"cell" なのに answers.cell が無い', async () => {
  var shapes = [
    jevResponse(), // answers.digit しか無い(digit 用の応答が返ってきた)
    { state: "Completed", result: { model: "jev-1.13.0", answers: {} } },
    { state: "Completed", result: { model: "jev-1.13.0", answers: { other: { choice: "r0c2" } } } },
    { model: "jev-1.13.0", answers: {} },
  ];
  for (var i = 0; i < shapes.length; i++) {
    var env = makeEnv({ aiResult: shapes[i] });
    var res = await worker.fetch(judgeRequest(validCellBody()), env);
    assert.equal(res.status, 502, "shape #" + i + ": 502 を期待したが " + res.status);
    var body = await res.json();
    assert.equal(body.error, "AIの応答が予期しない形式です");
    assert.ok("raw" in body, "shape #" + i + ": raw が無い");
    assert.deepStrictEqual(body.request, env.aiCalls[0].payload);
  }
});

/** GIVEN の空マスに対する正常な answers.cell を作り、差し替えて返す。 */
function withCell(cell) {
  var response = jevCellResponse(GIVEN_CELL_KEYS);
  response.result.answers.cell = cell;
  return response;
}

test('502: ask:"cell" で probabilities のキーが criteria と一致しない', async () => {
  var good = jevCellAnswer(GIVEN_CELL_KEYS);

  var extra = jevCellAnswer(GIVEN_CELL_KEYS);
  extra.probabilities.r0c0 = 0.1; // 埋まっているマス(候補外)が増えている

  var missing = jevCellAnswer(GIVEN_CELL_KEYS);
  delete missing.probabilities[GIVEN_CELL_KEYS[GIVEN_CELL_KEYS.length - 1]];

  var renamed = jevCellAnswer(GIVEN_CELL_KEYS);
  renamed.probabilities["0-2"] = renamed.probabilities.r0c2; // 個数は同じだがキーが違う
  delete renamed.probabilities.r0c2;

  var digits = jevCellAnswer(GIVEN_CELL_KEYS);
  digits.probabilities = { 1: 0.1, 2: 0.1, 3: 0.1, 4: 0.1, 5: 0.1, 6: 0.1, 7: 0.1, 8: 0.1, 9: 0.2 };

  var cases = {
    "候補外のキーが増えている": extra,
    "キーが1つ欠けている": missing,
    "キー名が違う(個数は同じ)": renamed,
    "1〜9 のキーになっている": digits,
  };
  for (var label in cases) {
    var env = makeEnv({ aiResult: withCell(cases[label]) });
    var res = await worker.fetch(judgeRequest(validCellBody()), env);
    assert.equal(res.status, 502, label + ": 502 を期待したが " + res.status);
    var body = await res.json();
    assert.equal(body.error, "AIの応答のprobabilitiesが候補マスのキーと一致していません");
    assert.ok("raw" in body, label + ": raw が無い");
    assert.deepStrictEqual(body.request, env.aiCalls[0].payload);
  }

  // 参考: 手を加えていない good はちゃんと 200 になる(上の 502 がキー以外の理由でないこと)
  var okEnv = makeEnv({ aiResult: withCell(good) });
  var okRes = await worker.fetch(judgeRequest(validCellBody()), okEnv);
  assert.equal(okRes.status, 200);
});

test('502: ask:"cell" で choice が criteria に無い', async () => {
  var cases = {
    "埋まっているマスを選んだ": "r0c0",
    "範囲外のキー": "r9c9",
    "形式が違う": "0-2",
    "数字を返した": "4",
    "文字列でない": 4,
  };
  for (var label in cases) {
    var answer = jevCellAnswer(GIVEN_CELL_KEYS);
    answer.choice = cases[label];
    var env = makeEnv({ aiResult: withCell(answer) });
    var res = await worker.fetch(judgeRequest(validCellBody()), env);
    assert.equal(res.status, 502, label + ": 502 を期待したが " + res.status);
    var body = await res.json();
    assert.equal(body.error, "AIの応答のchoiceが候補マスのいずれかではありません");
    assert.ok("raw" in body, label + ": raw が無い");
  }
});

test('502: ask:"cell" の probabilities の値 / confidence が数値でない', async () => {
  var badValue = jevCellAnswer(GIVEN_CELL_KEYS);
  badValue.probabilities.r0c2 = "0.1";
  var env = makeEnv({ aiResult: withCell(badValue) });
  var res = await worker.fetch(judgeRequest(validCellBody()), env);
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error, "AIの応答のprobabilitiesに数値でない値が含まれています");

  var nan = jevCellAnswer(GIVEN_CELL_KEYS);
  nan.probabilities.r0c2 = NaN;
  var env2 = makeEnv({ aiResult: withCell(nan) });
  assert.equal((await worker.fetch(judgeRequest(validCellBody()), env2)).status, 502);

  var noConf = jevCellAnswer(GIVEN_CELL_KEYS);
  delete noConf.confidence;
  var env3 = makeEnv({ aiResult: withCell(noConf) });
  var res3 = await worker.fetch(judgeRequest(validCellBody()), env3);
  assert.equal(res3.status, 502);
  assert.equal((await res3.json()).error, "AIの応答のconfidenceが数値ではありません");
});

test('ask:"cell" でもレート制限は1呼び出し=1カウント(digit と同じ)', async () => {
  var limiter = makeRateLimiter();
  var env = makeEnv({ limiter: limiter, aiResult: jevCellResponse(GIVEN_CELL_KEYS) });
  var res = await worker.fetch(judgeRequest(validCellBody()), env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("X-RateLimit-Remaining-IP"), "29");
  assert.equal(res.headers.get("X-RateLimit-Remaining-Global"), "499");
  // increment はグローバルと IP で1回ずつ(digit と同じ回数)
  var increments = limiter.calls.filter(function (call) {
    return call.op === "increment";
  });
  assert.equal(increments.length, 2);
});

// --- ask:"where"(数字ごと。Issue #45) --------------------------------------

// 期待値は src/index.js の WHERE_NOTE / WHERE_INSTRUCTIONS_TEMPLATE を **意図的に複製**
// している(cell と同じ流儀。文面をこっそり変えたら落ちるように実装から import しない)。
var EXPECTED_WHERE_NOTE =
  "puzzle is a 9x9 Sudoku grid given as 9 strings of 9 characters each, " +
  "top row first. A digit character is a cell that is already filled in; " +
  "'.' is an empty cell. There is no target cell this time. digit is the digit " +
  "being asked about. Each question is about one empty cell of the grid, keyed as " +
  "'r<row>c<col>' with zero-based row and col indices (row 0 is the first string, " +
  "col 0 is its first character), and asks whether that cell contains digit. " +
  "Standard Sudoku rules apply: every row, every column and every 3x3 box must " +
  "contain each of the digits 1 to 9 exactly once. Some of the digits already " +
  "placed may be wrong.";

/** WHERE_INSTRUCTIONS_TEMPLATE を埋めた文言(テンプレートごとテスト側に複製している)。 */
function expectedWhereInstructions(row, col, digit) {
  return (
    "Does the empty cell at row " +
    row +
    ", column " +
    col +
    " (zero-based) contain the digit " +
    digit +
    "?"
  );
}

/** "r3c5" → { row: 3, col: 5 }(キーは1桁なので固定位置で読める)。 */
function parseCellKey(key) {
  return { row: Number(key[1]), col: Number(key[3]) };
}

/** ask:"where" を投げ、モック AI には空マスのキーと一致する noul を返させる。 */
async function judgeWhere(body) {
  var target = body || validWhereBody();
  var keys = emptyCellKeys(target.puzzle || GIVEN);
  var env = makeEnv({ aiResult: jevWhereResponse(keys) });
  var res = await worker.fetch(judgeRequest(target), env);
  var payload = await res.json();
  return { res: res, body: payload, env: env, keys: keys };
}

/** GIVEN の空マスに対する where のレスポンスの answers を差し替えて返す。 */
function withWhereAnswers(answers) {
  var response = jevWhereResponse(GIVEN_CELL_KEYS);
  response.result.answers = answers;
  return response;
}

/** 与えた AI レスポンスで ask:"where" を1回投げる。 */
async function postWhere(aiResult, body) {
  var env = makeEnv({ aiResult: aiResult });
  var res = await worker.fetch(judgeRequest(body || validWhereBody()), env);
  return { res: res, body: await res.json(), env: env };
}

test('ask:"where": payload は target 無し・digit・WHERE_NOTE・空マスごとの noul 質問', async () => {
  var out = await judgeWhere();
  assert.equal(out.res.status, 200);
  assert.equal(out.env.aiCalls.length, 1);
  assert.equal(out.env.aiCalls[0].model, "typesafe/jev");

  var payload = out.env.aiCalls[0].payload;
  assert.deepEqual(Object.keys(payload).sort(), ["questions", "state"]);
  // state は puzzle / digit / note だけ。target は無い(盤面全体に聞く質問なので)
  assert.deepEqual(Object.keys(payload.state).sort(), ["digit", "note", "puzzle"]);
  assert.equal("target" in payload.state, false);
  assert.deepEqual(payload.state.puzzle, GIVEN);
  assert.equal(payload.state.digit, "4");
  assert.equal(payload.state.note, EXPECTED_WHERE_NOTE);

  // 質問キーは空マスの一覧で、行優先の順(1マス = 1質問)
  assert.deepEqual(Object.keys(payload.questions), GIVEN_CELL_KEYS);
  assert.equal(GIVEN_CELL_KEYS.length, 51, "固定問題の空マスは51個");
  for (var i = 0; i < GIVEN_CELL_KEYS.length; i++) {
    var key = GIVEN_CELL_KEYS[i];
    var question = payload.questions[key];
    assert.deepEqual(Object.keys(question).sort(), ["instructions", "type"], key);
    assert.equal(question.type, "noul", key);
    var at = parseCellKey(key);
    assert.equal(question.instructions, expectedWhereInstructions(at.row, at.col, "4"), key);
  }
  assert.equal(payload.questions.r0c0, undefined, "埋まっているマスは質問にしない");
  assert.equal(payload.questions.where, undefined, "ask をそのまま質問キーにしない");
});

test('ask:"where": digit が変われば state と質問文の数字も変わる', async () => {
  var out = await judgeWhere(validWhereBody({ digit: "9" }));
  assert.equal(out.res.status, 200);
  var payload = out.env.aiCalls[0].payload;
  assert.equal(payload.state.digit, "9");
  assert.equal(out.body.digit, "9");
  assert.equal(payload.questions.r0c2.instructions, expectedWhereInstructions(0, 2, "9"));
  assert.equal(payload.questions.r8c6.instructions, expectedWhereInstructions(8, 6, "9"));
});

test('ask:"where": 埋まっているマスは質問に入らない(推測入りの盤面)', async () => {
  var guessed = GIVEN.slice();
  guessed[0] = "531175111"; // 1行目は全部埋まった状態
  var out = await judgeWhere(validWhereBody({ puzzle: guessed }));
  assert.equal(out.res.status, 200);
  var keys = Object.keys(out.env.aiCalls[0].payload.questions);
  assert.deepEqual(keys, emptyCellKeys(guessed));
  for (var i = 0; i < keys.length; i++) {
    assert.ok(!keys[i].startsWith("r0c"), "埋まっている1行目のマスが質問に入っている: " + keys[i]);
  }
});

test('ask:"where": payload に正解表の行が一切含まれない(不変条件1)', async () => {
  var out = await judgeWhere();
  var serialized = JSON.stringify(out.env.aiCalls[0].payload);
  for (var i = 0; i < ANSWER_KEY.length; i++) {
    assert.ok(
      !serialized.includes(ANSWER_KEY[i]),
      "payload に正解表の " + (i + 1) + " 行目が含まれている: " + ANSWER_KEY[i]
    );
  }
});

test('ask:"where": 200 の形(probabilities / digit / request のみ)', async () => {
  var out = await judgeWhere();
  assert.equal(out.res.status, 200);
  assert.equal(out.res.headers.get("content-type"), "application/json; charset=utf-8");
  assert.deepEqual(Object.keys(out.body).sort(), ["digit", "probabilities", "request"]);
  // noul には choice も confidence も無いので付けない(cell の cell も付けない)
  assert.equal("choice" in out.body, false);
  assert.equal("confidence" in out.body, false);
  assert.equal("cell" in out.body, false);

  // probabilities のキーは空マスの一覧(行優先)、値は answers の noul そのもの
  assert.deepEqual(Object.keys(out.body.probabilities), GIVEN_CELL_KEYS);
  var expected = jevWhereAnswers(GIVEN_CELL_KEYS);
  for (var i = 0; i < GIVEN_CELL_KEYS.length; i++) {
    var key = GIVEN_CELL_KEYS[i];
    assert.equal(out.body.probabilities[key], expected[key].noul, key);
  }

  // request は env.AI.run に渡したペイロードそのもの(Issue #34)
  assert.deepStrictEqual(out.body.request, out.env.aiCalls[0].payload);
});

test('200: ask:"where" で空マスが1個(質問1件)でも動く', async () => {
  var puzzle = ANSWER_KEY.slice();
  puzzle[4] = puzzle[4].slice(0, 4) + "." + puzzle[4].slice(5);
  var out = await judgeWhere(validWhereBody({ puzzle: puzzle }));
  assert.equal(out.res.status, 200);
  assert.deepEqual(out.keys, ["r4c4"]);
  assert.deepEqual(Object.keys(out.env.aiCalls[0].payload.questions), ["r4c4"]);
  assert.deepEqual(Object.keys(out.body.probabilities), ["r4c4"]);
  assert.equal(out.body.digit, "4");
});

test('200: ask:"where" で埋まっているマスが17個ちょうど', async () => {
  var out = await judgeWhere(validWhereBody({ puzzle: filledPuzzle(17) }));
  assert.equal(out.res.status, 200);
  assert.equal(out.env.aiCalls.length, 1);
  assert.equal(Object.keys(out.env.aiCalls[0].payload.questions).length, 81 - 17);
});

test('400: ask:"where" に target が付いている', async () => {
  await expect400("target 付き", validWhereBody({ target: { row: 0, col: 2 } }));
  await expect400("target が null", validWhereBody({ target: null }));
  await expect400("target が空オブジェクト", validWhereBody({ target: {} }));
});

test('400: ask:"where" の digit が 1〜9 の文字列でない', async () => {
  var bad = [undefined, null, 4, "0", "10", "", "４", " 4", "a", ["4"], { digit: "4" }, true];
  for (var i = 0; i < bad.length; i++) {
    await expect400("digit=" + JSON.stringify(bad[i]), validWhereBody({ digit: bad[i] }));
  }
  // digit キーごと無いときも 400
  await expect400("digit 欠落", { puzzle: GIVEN.slice(), ask: "where" });
});

test('400: ask:"where" の digit / target の文言', async () => {
  var env = makeEnv();
  var res = await worker.fetch(judgeRequest({ puzzle: GIVEN.slice(), ask: "where" }), env);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "ask:whereではdigitに1〜9の文字列を指定してください");

  var res2 = await worker.fetch(judgeRequest(validWhereBody({ target: { row: 0, col: 2 } })), env);
  assert.equal(res2.status, 400);
  assert.equal(
    (await res2.json()).error,
    "ask:whereではtargetを指定できません(盤面全体に聞くため)"
  );
  assert.equal(env.aiCalls.length, 0);
});

test('400: ask:"where" で空マスが1つも無い(全部埋まった盤面)', async () => {
  await expect400("全部埋まっている", validWhereBody({ puzzle: ANSWER_KEY.slice() }));
});

test('400: ask:"where" でも埋まっているマスが17個未満なら弾く', async () => {
  await expect400("16個", validWhereBody({ puzzle: filledPuzzle(16) }));
  await expect400("0個(全部空)", validWhereBody({ puzzle: filledPuzzle(0) }));
});

test('400: ask:"where" でも puzzle の形式は従来どおり見る(文言は target に触れない)', async () => {
  await expect400("8行", validWhereBody({ puzzle: GIVEN.slice(0, 8) }));
  await expect400("puzzle が文字列", validWhereBody({ puzzle: "53..7...." }));
  var letter = GIVEN.slice();
  letter[2] = ".98..x.6.";
  await expect400("英字を含む行", validWhereBody({ puzzle: letter }));

  var env = makeEnv();
  var res = await worker.fetch(judgeRequest({ ask: "where", digit: "4" }), env);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "puzzle(9行の配列)が必要です");
});

test('502: ask:"where" で answers が取り出せない', async () => {
  var shapes = [
    { state: "Completed", result: { model: "jev-1.13.0" } },
    { state: "Completed", result: { model: "jev-1.13.0", answers: null } },
    { state: "Completed", result: { model: "jev-1.13.0", answers: [] } },
    { model: "jev-1.13.0" },
  ];
  for (var i = 0; i < shapes.length; i++) {
    var out = await postWhere(shapes[i]);
    assert.equal(out.res.status, 502, "shape #" + i + ": 502 を期待したが " + out.res.status);
    assert.equal(out.body.error, "AIの応答が予期しない形式です");
    assert.ok("raw" in out.body, "shape #" + i + ": raw が無い");
    assert.deepStrictEqual(out.body.request, out.env.aiCalls[0].payload);
  }
});

test('502: ask:"where" で state が Completed でない', async () => {
  var response = jevWhereResponse(GIVEN_CELL_KEYS);
  response.state = "Failed";
  var out = await postWhere(response);
  assert.equal(out.res.status, 502);
  assert.equal(out.body.error, "AIの応答が完了していません");
  assert.deepStrictEqual(out.body.request, out.env.aiCalls[0].payload);
});

test('502: ask:"where" で answers のキーが空マスと一致しない', async () => {
  var extra = jevWhereAnswers(GIVEN_CELL_KEYS);
  extra.r0c0 = { type: "noul", noul: 0.5 }; // 埋まっているマス(質問していない)が増えている

  var missing = jevWhereAnswers(GIVEN_CELL_KEYS);
  delete missing[GIVEN_CELL_KEYS[GIVEN_CELL_KEYS.length - 1]];

  var renamed = jevWhereAnswers(GIVEN_CELL_KEYS);
  renamed["0-2"] = renamed.r0c2; // 個数は同じだがキーが違う
  delete renamed.r0c2;

  var cases = {
    "質問していないキーが増えている": extra,
    "キーが1つ欠けている": missing,
    "キー名が違う(個数は同じ)": renamed,
    "空の answers": {},
    "digit 用の応答が返ってきた": { digit: jevAnswer() },
  };
  for (var label in cases) {
    var out = await postWhere(withWhereAnswers(cases[label]));
    assert.equal(out.res.status, 502, label + ": 502 を期待したが " + out.res.status);
    assert.equal(out.body.error, "AIの応答のanswersが候補マスのキーと一致していません");
    assert.ok("raw" in out.body, label + ": raw が無い");
    assert.deepStrictEqual(out.body.request, out.env.aiCalls[0].payload);
  }

  // 参考: 手を加えていない answers はちゃんと 200 になる(上の 502 がキー以外の理由でないこと)
  var ok = await postWhere(withWhereAnswers(jevWhereAnswers(GIVEN_CELL_KEYS)));
  assert.equal(ok.res.status, 200);
});

test('502: ask:"where" で noul が有限の数値でない', async () => {
  var cases = {
    文字列: "0.5",
    NaN: NaN,
    Infinity: Infinity,
    真偽値: true,
    配列: [0.5],
  };
  for (var label in cases) {
    var answers = jevWhereAnswers(GIVEN_CELL_KEYS);
    answers.r0c2 = { type: "noul", noul: cases[label] };
    var out = await postWhere(withWhereAnswers(answers));
    assert.equal(out.res.status, 502, label + ": 502 を期待したが " + out.res.status);
    assert.equal(out.body.error, "AIの応答のnoulに数値でない値が含まれています");
  }

  // noul キーごと無い / 回答がオブジェクトでない場合も同じ扱い
  var noNoul = jevWhereAnswers(GIVEN_CELL_KEYS);
  noNoul.r0c2 = { type: "noul" };
  var out2 = await postWhere(withWhereAnswers(noNoul));
  assert.equal(out2.res.status, 502);
  assert.equal(out2.body.error, "AIの応答のnoulに数値でない値が含まれています");

  var bare = jevWhereAnswers(GIVEN_CELL_KEYS);
  bare.r0c2 = 0.5; // 数値だけが返ってきた(オブジェクトでない)
  var out3 = await postWhere(withWhereAnswers(bare));
  assert.equal(out3.res.status, 502);
  assert.equal(out3.body.error, "AIの応答のnoulに数値でない値が含まれています");

  var nulled = jevWhereAnswers(GIVEN_CELL_KEYS);
  nulled.r0c2 = null;
  var out4 = await postWhere(withWhereAnswers(nulled));
  assert.equal(out4.res.status, 502);
  assert.equal(out4.body.error, "AIの応答のnoulに数値でない値が含まれています");
});

test('ask:"where" でもレート制限は1呼び出し=1カウント(digit / cell と同じ)', async () => {
  var limiter = makeRateLimiter();
  var env = makeEnv({ limiter: limiter, aiResult: jevWhereResponse(GIVEN_CELL_KEYS) });
  var res = await worker.fetch(judgeRequest(validWhereBody()), env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("X-RateLimit-Remaining-IP"), "29");
  assert.equal(res.headers.get("X-RateLimit-Remaining-Global"), "499");
  // 51マス分をまとめて1回で聞くので、increment はグローバルと IP で1回ずつ
  var increments = limiter.calls.filter(function (call) {
    return call.op === "increment";
  });
  assert.equal(increments.length, 2);
});

test("400: where を足したあとも未知の ask は 400", async () => {
  var bad = ["wheres", "WHERE", "Where", " where", "noul"];
  for (var i = 0; i < bad.length; i++) {
    await expect400("ask=" + JSON.stringify(bad[i]), validBody({ ask: bad[i] }));
  }
});
