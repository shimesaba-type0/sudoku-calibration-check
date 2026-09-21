// GET /api/status(docs/SPEC.md 4章 / docs/DESIGN.md 3.1・3.2)。
//
// 残数を「読むだけ」で返すエンドポイント。ここで加算してしまうと、状態を見るたびに
// 残数が減るという本末転倒な挙動になるので、`limiter.calls` に `increment` が
// 一度も現れないことを機械的に確かめる。
// バケット番号は現在時刻依存なので、シードは makeRateLimiter の前方一致で行い、
// バケットが要る検証はスタブが受け取った呼び出し(`limiter.calls[i].bucket`)から取る。
import { test } from "node:test";
import assert from "node:assert/strict";

import worker from "../src/index.js";
import { makeEnv, makeRateLimiter } from "./helpers.js";

function statusRequest(ip, method) {
  var headers = {};
  if (ip !== null) headers["CF-Connecting-IP"] = ip || "203.0.113.1";
  return new Request("https://example.com/api/status", {
    method: method || "GET",
    headers: headers,
  });
}

/** `limiter.calls` を "<name>/<op>" の配列にする(呼び出し順の検証用)。 */
function trace(limiter) {
  return limiter.calls.map((call) => call.name + "/" + call.op);
}

test("GET /api/status は全体と IP の残数を返す", async () => {
  var limiter = makeRateLimiter({ global: 34, "ip:198.51.100.20": 6 });
  var env = makeEnv({ limiter: limiter });

  var res = await worker.fetch(statusRequest("198.51.100.20"), env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");

  var body = await res.json();
  assert.equal(body.window_seconds, 3600);
  assert.deepEqual(body.global, { max: 500, used: 34, remaining: 466 });
  assert.deepEqual(body.ip, { max: 30, used: 6, remaining: 24 });
  assert.ok(
    Number.isInteger(body.resets_in) && body.resets_in > 0 && body.resets_in <= 3600,
    "resets_in が 1〜3600 の整数でない: " + body.resets_in
  );
  assert.equal(env.aiCalls.length, 0, "状態の読み取りで AI.run が呼ばれている");
});

test("resets_in は現在のバケットが終わるまでの秒数(Retry-After と同じ式)", async () => {
  var windowSeconds = 600;
  var limiter = makeRateLimiter();
  var env = makeEnv({ limiter: limiter, vars: { RATE_LIMIT_WINDOW_SECONDS: windowSeconds } });

  var res = await worker.fetch(statusRequest("198.51.100.21"), env);
  var body = await res.json();
  assert.equal(body.window_seconds, windowSeconds);

  var bucket = limiter.calls[0].bucket;
  var now = Math.floor(Date.now() / 1000);
  var expected = (bucket + 1) * windowSeconds - now;
  assert.ok(
    Math.abs(body.resets_in - expected) <= 1,
    "resets_in が (bucket+1)*window - now と一致しない: " + body.resets_in + " vs " + expected
  );
});

test("[vars] の上限がそのまま max に出る", async () => {
  var env = makeEnv({ vars: { RATE_LIMIT_PER_IP_MAX: 5, RATE_LIMIT_GLOBAL_MAX: 40 } });
  var body = await (await worker.fetch(statusRequest("198.51.100.22"), env)).json();
  assert.equal(body.ip.max, 5);
  assert.equal(body.ip.remaining, 5);
  assert.equal(body.global.max, 40);
  assert.equal(body.global.remaining, 40);
});

test("呼び出し元の IP の分を返す(別 IP の消費は混ざらない)", async () => {
  var limiter = makeRateLimiter({ "ip:198.51.100.30": 11 });
  var env = makeEnv({ limiter: limiter });

  var mine = await (await worker.fetch(statusRequest("198.51.100.30"), env)).json();
  assert.equal(mine.ip.used, 11);
  assert.equal(mine.ip.remaining, 19);

  var other = await (await worker.fetch(statusRequest("198.51.100.31"), env)).json();
  assert.equal(other.ip.used, 0);
  assert.equal(other.ip.remaining, 30);
});

test("CF-Connecting-IP が無ければ unknown のインスタンスを読む", async () => {
  var limiter = makeRateLimiter({ "ip:unknown": 3 });
  var env = makeEnv({ limiter: limiter });

  var body = await (await worker.fetch(statusRequest(null), env)).json();
  assert.equal(body.ip.used, 3);
  assert.deepEqual(trace(limiter), ["global/peek", "ip:unknown/peek"]);
});

test("状態の読み取りは peek だけ(カウンタを加算しない)", async () => {
  var limiter = makeRateLimiter({ global: 7, "ip:198.51.100.40": 2 });
  var env = makeEnv({ limiter: limiter });

  await worker.fetch(statusRequest("198.51.100.40"), env);

  assert.deepEqual(trace(limiter), ["global/peek", "ip:198.51.100.40/peek"]);
  for (var i = 0; i < limiter.calls.length; i++) {
    assert.notEqual(limiter.calls[i].op, "increment", "状態の読み取りで加算している");
  }
  assert.equal(limiter.state.get("global").count, 7, "全体のカウンタが増えている");
  assert.equal(limiter.state.get("ip:198.51.100.40").count, 2, "IP のカウンタが増えている");
});

test("続けて2回叩いても値が変わらない", async () => {
  var limiter = makeRateLimiter({ global: 7, "ip:198.51.100.41": 2 });
  var env = makeEnv({ limiter: limiter });

  var first = await (await worker.fetch(statusRequest("198.51.100.41"), env)).json();
  var second = await (await worker.fetch(statusRequest("198.51.100.41"), env)).json();

  assert.deepEqual(second.global, first.global);
  assert.deepEqual(second.ip, first.ip);
  assert.deepEqual(second.global, { max: 500, used: 7, remaining: 493 });
  assert.equal(
    limiter.calls.filter((call) => call.op === "increment").length,
    0,
    "2回叩く間に increment が混ざっている"
  );
});

test("上限を使い切っていれば remaining は 0", async () => {
  var limiter = makeRateLimiter({ "ip:*": 30 });
  var env = makeEnv({ limiter: limiter });

  var body = await (await worker.fetch(statusRequest("198.51.100.42"), env)).json();
  assert.deepEqual(body.ip, { max: 30, used: 30, remaining: 0 });
});

test("RATE_LIMITER が無ければ rate_limit: disabled(200)", async () => {
  var env = makeEnv({ limiter: null });
  var res = await worker.fetch(statusRequest("198.51.100.50"), env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
  assert.deepEqual(await res.json(), { rate_limit: "disabled" });
});

test("カウンタが例外を投げたら 503(Retry-After: 60)", async () => {
  var limiter = makeRateLimiter(null, "throw");
  var env = makeEnv({ limiter: limiter });
  var res = await worker.fetch(statusRequest("198.51.100.60"), env);
  assert.equal(res.status, 503);
  assert.equal(res.headers.get("Retry-After"), "60");
  assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal((await res.json()).error, "レート制限の状態を取得できません");
});

test("カウンタが 500 を返しても 503", async () => {
  var limiter = makeRateLimiter(null, "500");
  var env = makeEnv({ limiter: limiter });
  var res = await worker.fetch(statusRequest("198.51.100.61"), env);
  assert.equal(res.status, 503);
  assert.equal(res.headers.get("Retry-After"), "60");
  assert.equal((await res.json()).error, "レート制限の状態を取得できません");
});

test("Cache-Control: no-store が付き、CORS ヘッダーは付かない", async () => {
  var cases = [
    makeEnv({ limiter: makeRateLimiter() }),
    makeEnv({ limiter: null }),
    makeEnv({ limiter: makeRateLimiter(null, "throw") }),
  ];
  for (var i = 0; i < cases.length; i++) {
    var res = await worker.fetch(statusRequest("198.51.100.70"), cases[i]);
    assert.equal(res.headers.get("Cache-Control"), "no-store", i + " 番目に no-store が無い");
    assert.equal(res.headers.get("access-control-allow-origin"), null);
    assert.equal(res.headers.get("access-control-allow-methods"), null);
    assert.equal(res.headers.get("access-control-allow-headers"), null);
  }
});

test("POST /api/status は 404(GET だけ)", async () => {
  var limiter = makeRateLimiter();
  var env = makeEnv({ limiter: limiter });
  var methods = ["POST", "PUT", "DELETE"];
  for (var i = 0; i < methods.length; i++) {
    var res = await worker.fetch(statusRequest("198.51.100.80", methods[i]), env);
    assert.equal(res.status, 404, methods[i] + " は 404 のはず");
  }
  assert.deepEqual(trace(limiter), [], "404 なのにカウンタを触っている");
});

test("/api/status/ や /api/status?x=1 の扱い(末尾スラッシュは 404、クエリは通る)", async () => {
  var env = makeEnv({ limiter: makeRateLimiter() });
  assert.equal(
    (await worker.fetch(new Request("https://example.com/api/status/"), env)).status,
    404
  );
  assert.equal(
    (await worker.fetch(new Request("https://example.com/api/status?x=1"), env)).status,
    200
  );
});
