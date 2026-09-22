// ルーティングと GET / のヘッダー(docs/DESIGN.md 3.1 / 7章)。
import { test } from "node:test";
import assert from "node:assert/strict";

import worker from "../src/index.js";
import { makeEnv, judgeRequest, validBody } from "./helpers.js";

function get(path, method) {
  return new Request("https://example.com" + path, { method: method || "GET" });
}

test("GET / は HTML をセキュリティヘッダー付きで返す", async () => {
  var env = makeEnv();
  var res = await worker.fetch(get("/"), env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(res.headers.get("Referrer-Policy"), "no-referrer");
  // 比較モード(/compare、Issue #46)が同じページを iframe で2枚埋め込むため、
  // 'none' から 'self'(同一オリジンのみ)に変わった。他サイトからの埋め込みは
  // 引き続き不可(docs/DESIGN.md 7章)。
  assert.equal(res.headers.get("Content-Security-Policy"), "frame-ancestors 'self'");
  assert.equal(res.headers.get("access-control-allow-origin"), null);

  var html = await res.text();
  assert.ok(html.includes("数独キャリブレーションチェック"));
  // 実UIのマーカー(グリッドと実行ボタン)。判定ループが依存するDOMは page.test.js で検査する
  assert.ok(html.includes('id=\\"grid\\"'), "グリッドの id が無い");
  assert.ok(html.includes('id=\\"run-btn\\"'), "実行ボタンの id が無い");
  assert.ok(html.includes("var GIVEN ="));
  assert.equal(env.aiCalls.length, 0);
});

test("GET /compare は通常ページと同じ HTML をセキュリティヘッダー付きで返す(Issue #46)", async () => {
  var env = makeEnv();
  var res = await worker.fetch(get("/compare"), env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(res.headers.get("Referrer-Policy"), "no-referrer");
  assert.equal(res.headers.get("Content-Security-Policy"), "frame-ancestors 'self'");
  assert.equal(res.headers.get("access-control-allow-origin"), null);

  var html = await res.text();
  assert.ok(html.includes("var GIVEN ="), "/compare も同じ PAGE_HTML(判定ループのスクリプト)を返すはず");
  assert.equal(env.aiCalls.length, 0);
});

test("POST /compare は 404", async () => {
  var env = makeEnv();
  var res = await worker.fetch(get("/compare", "POST"), env);
  assert.equal(res.status, 404);
});

test("その他のパスは 404", async () => {
  var env = makeEnv();
  var paths = ["/index.html", "/api", "/api/judge/", "/favicon.ico", "/health"];
  for (var i = 0; i < paths.length; i++) {
    var res = await worker.fetch(get(paths[i]), env);
    assert.equal(res.status, 404, paths[i] + " は 404 のはず");
  }
});

test("メソッド違いは 404(GET /api/judge、POST /)", async () => {
  var env = makeEnv();
  assert.equal((await worker.fetch(get("/api/judge", "GET"), env)).status, 404);
  assert.equal((await worker.fetch(get("/", "POST"), env)).status, 404);
  assert.equal(env.aiCalls.length, 0);
});

test("クエリ文字列が付いていても / は HTML を返す", async () => {
  var env = makeEnv();
  var res = await worker.fetch(get("/?speed=fast"), env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
});

test("POST /api/judge はルーティングされている", async () => {
  var env = makeEnv();
  var res = await worker.fetch(judgeRequest(validBody()), env);
  assert.equal(res.status, 200);
});
