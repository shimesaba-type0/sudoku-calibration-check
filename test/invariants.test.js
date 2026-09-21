// docs/DESIGN.md 9章の不変条件1・7を機械的に確認する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import worker from "../src/index.js";
import { ANSWER_KEY, makeEnv, judgeRequest, validBody } from "./helpers.js";

var SOURCE_PATH = fileURLToPath(new URL("../src/index.js", import.meta.url));

test("不変条件1: Jev に渡す payload に正解表の行が一切含まれない", async () => {
  var env = makeEnv();
  // 1周目の途中を模した盤面(過去の推測入り、正誤問わず)でも漏れないことを見る
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

  var payload = env.aiCalls[0].payload;
  var serialized = JSON.stringify(payload);
  for (var i = 0; i < ANSWER_KEY.length; i++) {
    assert.ok(
      !serialized.includes(ANSWER_KEY[i]),
      "payload に正解表の " + (i + 1) + " 行目が含まれている: " + ANSWER_KEY[i]
    );
  }

  assert.deepEqual(Object.keys(payload.state).sort(), ["note", "puzzle", "target"]);
});

test("不変条件1: state.puzzle は送られてきた盤面そのもの", async () => {
  var env = makeEnv();
  var body = validBody();
  await worker.fetch(judgeRequest(body), env);
  var state = env.aiCalls[0].payload.state;
  assert.deepEqual(state.puzzle, body.puzzle);
  assert.deepEqual(state.target, { row: 0, col: 2 });
  assert.equal(typeof state.note, "string");
});

test("不変条件: 呼び出すモデルは typesafe/jev だけ", async () => {
  var env = makeEnv();
  await worker.fetch(judgeRequest(validBody()), env);
  assert.equal(env.aiCalls[0].model, "typesafe/jev");
});

test("不変条件: questions.digit は choice で criteria が1〜9の9件", async () => {
  var env = makeEnv();
  await worker.fetch(judgeRequest(validBody()), env);
  var question = env.aiCalls[0].payload.questions.digit;
  assert.equal(question.type, "choice");
  assert.equal(typeof question.instructions, "string");
  assert.deepEqual(Object.keys(question.criteria), ["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
});

test("不変条件7: 正解表の識別子は PAGE_HTML の中にしか現れない", () => {
  var source = readFileSync(SOURCE_PATH, "utf8");
  var needle = "SOLUTION";

  var declaration = source.indexOf("var PAGE_HTML = `");
  assert.ok(declaration >= 0, "PAGE_HTML のテンプレートリテラルが見つからない");
  var open = source.indexOf("`", declaration);
  var close = source.indexOf("`", open + 1);
  assert.ok(close > open, "PAGE_HTML のテンプレートリテラルが閉じていない");

  var inside = source.slice(open + 1, close);
  assert.ok(inside.includes(needle), "PAGE_HTML の中に正解表が無い(隔離の前提が崩れている)");

  var outside = source.slice(0, open) + source.slice(close + 1);
  assert.ok(
    !outside.includes(needle),
    "PAGE_HTML の外に " + needle + " が現れている(Worker 側の判定コードから隔離されていない)"
  );
});
