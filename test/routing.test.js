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
  assert.equal(res.headers.get("Content-Security-Policy"), "frame-ancestors 'none'");
  assert.equal(res.headers.get("access-control-allow-origin"), null);

  var html = await res.text();
  assert.ok(html.includes("数独キャリブレーションチェック"));
  // Issue #3 でフロントエンド(PAGE_HTML)を実装。「実装中」のプレースホルダーの代わりに、
  // 実際のUIが返す判定パネル・実行ボタンのマーカーで存在を確認する。
  assert.ok(html.includes("判定パネル"));
  assert.ok(html.includes('data-action="run"'));
  assert.ok(html.includes("var GIVEN ="));
  assert.equal(env.aiCalls.length, 0);
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
