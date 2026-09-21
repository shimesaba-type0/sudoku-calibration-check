// docs/DESIGN.md 9章の不変条件1・7を機械的に確認する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import worker from "../src/index.js";
import { ANSWER_KEY, makeEnv, judgeRequest } from "./helpers.js";

var SOURCE_PATH = fileURLToPath(new URL("../src/index.js", import.meta.url));

// ここから下の期待値は src/index.js の NOTE / INSTRUCTIONS / criteria を **意図的に複製**
// している。payload に何かを足したり文面をこっそり変えたりしたら落ちるようにするため、
// 実装から import せずテスト側に固定で持つ。
var EXPECTED_NOTE =
  "puzzle is a 9x9 Sudoku grid given as 9 strings of 9 characters each, " +
  "top row first. A digit character is a cell that is already filled in; " +
  "'.' is an empty cell. target is the cell being asked about, as zero-based " +
  "row and col indices (row 0 is the first string, col 0 is its first character). " +
  "Standard Sudoku rules apply: every row, every column and every 3x3 box must " +
  "contain each of the digits 1 to 9 exactly once. Some of the digits already " +
  "placed may be wrong. Answer which digit belongs in the target cell.";

var EXPECTED_INSTRUCTIONS =
  "Which digit from 1 to 9 belongs in the target cell of this Sudoku grid?";

var EXPECTED_CRITERIA = {
  1: "the digit 1",
  2: "the digit 2",
  3: "the digit 3",
  4: "the digit 4",
  5: "the digit 5",
  6: "the digit 6",
  7: "the digit 7",
  8: "the digit 8",
  9: "the digit 9",
};

test("不変条件1: AI.run に渡る payload が期待どおりのオブジェクトと完全に一致する", async () => {
  var env = makeEnv();
  // 1周目の途中を模した盤面(過去の周の推測入り、正誤問わず)。対象マスだけは "."。
  var puzzle = [
    "53.67....",
    "6..195...",
    ".98....6.",
    "8...6...3",
    "4..8.3..1",
    "7...2...6",
    ".6....28.",
    "...419..5",
    "....8..79",
  ];
  var res = await worker.fetch(judgeRequest({ puzzle: puzzle, target: { row: 0, col: 2 } }), env);
  assert.equal(res.status, 200);
  assert.equal(env.aiCalls.length, 1);
  assert.equal(env.aiCalls[0].model, "typesafe/jev");

  assert.deepStrictEqual(env.aiCalls[0].payload, {
    state: {
      puzzle: puzzle,
      target: { row: 0, col: 2 },
      note: EXPECTED_NOTE,
    },
    questions: {
      digit: {
        type: "choice",
        instructions: EXPECTED_INSTRUCTIONS,
        criteria: EXPECTED_CRITERIA,
      },
    },
  });
});

test("不変条件1: payload に正解表の行が一切含まれない", async () => {
  var env = makeEnv();
  var puzzle = [
    "53.67....",
    "6721953.8", // わざと正解に近い推測を並べても、渡るのは送られてきた推測そのものだけ
    ".98....6.",
    "8...6...3",
    "4..8.3..1",
    "7...2...6",
    ".6....28.",
    "...419..5",
    "....8..79",
  ];
  await worker.fetch(judgeRequest({ puzzle: puzzle, target: { row: 0, col: 2 } }), env);

  var serialized = JSON.stringify(env.aiCalls[0].payload);
  for (var i = 0; i < ANSWER_KEY.length; i++) {
    assert.ok(
      !serialized.includes(ANSWER_KEY[i]),
      "payload に正解表の " + (i + 1) + " 行目が含まれている: " + ANSWER_KEY[i]
    );
  }
  assert.deepEqual(Object.keys(env.aiCalls[0].payload.state).sort(), ["note", "puzzle", "target"]);
});

test("不変条件7: 正解表の識別子は PAGE_HTML の中にしか現れない", () => {
  var source = readFileSync(SOURCE_PATH, "utf8");
  var needle = "SOLUTION";

  var declaration = source.indexOf("var PAGE_HTML = `");
  assert.ok(declaration >= 0, "PAGE_HTML のテンプレートリテラルが見つからない");
  var open = source.indexOf("`", declaration);

  // 閉じバッククォートはファイル最後のバッククォート。PAGE_HTML が最後の宣言である
  // ことを前提にしているので、その前提自体も検査する(後ろに続くのは ; と空白だけ)。
  var close = source.lastIndexOf("`");
  assert.ok(close > open, "PAGE_HTML のテンプレートリテラルが閉じていない");
  assert.match(
    source.slice(close + 1),
    /^\s*;\s*$/,
    "PAGE_HTML がファイル最後の宣言になっていない(不変条件7の検査が無効になる)"
  );

  var inside = source.slice(open + 1, close);
  assert.ok(inside.includes(needle), "PAGE_HTML の中に正解表が無い(隔離の前提が崩れている)");

  var outside = source.slice(0, open) + source.slice(close + 1);
  assert.ok(
    !outside.includes(needle),
    "PAGE_HTML の外に " + needle + " が現れている(Worker 側の判定コードから隔離されていない)"
  );
});
