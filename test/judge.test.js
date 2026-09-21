// POST /api/judge の入力検証(docs/DESIGN.md 3.3)と 502 系。
import { test } from "node:test";
import assert from "node:assert/strict";

import worker from "../src/index.js";
import { GIVEN, makeEnv, judgeRequest, validBody } from "./helpers.js";

async function judge(body, envOptions) {
  var env = makeEnv(envOptions);
  var res = await worker.fetch(judgeRequest(body), env);
  var payload = await res.json();
  return { res: res, body: payload, env: env };
}

test("正常入力で 200 と9キーの probabilities が返る", async () => {
  var out = await judge(validBody());
  assert.equal(out.res.status, 200);
  assert.equal(out.res.headers.get("content-type"), "application/json; charset=utf-8");
  assert.deepEqual(Object.keys(out.body).sort(), ["choice", "confidence", "probabilities"]);
  assert.deepEqual(Object.keys(out.body.probabilities), ["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
  assert.equal(out.body.choice, "4");
  assert.equal(out.body.confidence, 0.61);
});

test("CORS ヘッダーは付けない", async () => {
  var env = makeEnv();
  var res = await worker.fetch(judgeRequest(validBody()), env);
  assert.equal(res.headers.get("access-control-allow-origin"), null);
});

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

test("400: 与えられたマスが書き換えられている", async () => {
  var overwritten = GIVEN.slice();
  overwritten[0] = "13..7...."; // 先頭の 5 を 1 に
  await expect400("与えられた数字の変更", { puzzle: overwritten, target: { row: 0, col: 2 } });

  var erased = GIVEN.slice();
  erased[0] = ".3..7...."; // 先頭の 5 を消した
  await expect400("与えられた数字の消去", { puzzle: erased, target: { row: 0, col: 2 } });
});

test("400: target が与えられたマスを指している", async () => {
  await expect400("(0,0) は given", { puzzle: GIVEN.slice(), target: { row: 0, col: 0 } });
  await expect400("(8,8) は given", { puzzle: GIVEN.slice(), target: { row: 8, col: 8 } });
});

test("空マスに過去の周の推測が入っていても 200(正誤問わず渡してよい)", async () => {
  var guessed = GIVEN.slice();
  guessed[0] = "531175111"; // わざと矛盾した推測を並べる。与えられた 5/3/7 の位置は保つ
  var out = await judge({ puzzle: guessed, target: { row: 1, col: 1 } });
  assert.equal(out.res.status, 200);
  assert.deepEqual(out.env.aiCalls[0].payload.state.puzzle[0], "531175111");
});

test("502: AI.run が例外を投げる", async () => {
  var env = makeEnv({ aiError: new Error("upstream exploded") });
  var res = await worker.fetch(judgeRequest(validBody()), env);
  assert.equal(res.status, 502);
  assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
  var body = await res.json();
  assert.equal(typeof body.error, "string");
  assert.ok("raw" in body);
  assert.ok(String(body.raw).includes("upstream exploded"));
});

test("502: answers.digit が無い", async () => {
  var shapes = [
    {},
    { model: "jev-1.13.0", answers: {} },
    { model: "jev-1.13.0", answers: { other: { choice: "4" } } },
    null,
    "まさかの文字列",
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
