// レート制限(docs/DESIGN.md 3.2 / SPEC F6)。
import { test } from "node:test";
import assert from "node:assert/strict";

import worker from "../src/index.js";
import { makeEnv, makeKV, judgeRequest, validBody } from "./helpers.js";

function bucketOf(windowSeconds) {
  return Math.floor(Math.floor(Date.now() / 1000) / windowSeconds);
}

test("IP単位の上限を超えると 429(Retry-After と X-RateLimit-Scope: ip 付き)", async () => {
  var env = makeEnv({ vars: { RATE_LIMIT_PER_IP_MAX: 2, RATE_LIMIT_GLOBAL_MAX: 500 } });

  for (var i = 0; i < 2; i++) {
    var ok = await worker.fetch(judgeRequest(validBody(), "198.51.100.7"), env);
    assert.equal(ok.status, 200, (i + 1) + "回目は通るはず");
  }

  var res = await worker.fetch(judgeRequest(validBody(), "198.51.100.7"), env);
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("X-RateLimit-Scope"), "ip");
  var retryAfter = Number(res.headers.get("Retry-After"));
  assert.ok(Number.isInteger(retryAfter) && retryAfter > 0, "Retry-After が正の整数でない");
  assert.ok(retryAfter <= 3600);
  var body = await res.json();
  assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
  assert.ok(body.error.includes("IP"), "IP 単位であることが error に出ていない");
  assert.equal(env.aiCalls.length, 2, "429 なのに AI.run が呼ばれている");
});

test("別の IP は IP単位の上限に引っかからない", async () => {
  var env = makeEnv({ vars: { RATE_LIMIT_PER_IP_MAX: 1 } });
  var first = await worker.fetch(judgeRequest(validBody(), "198.51.100.7"), env);
  assert.equal(first.status, 200);
  var blocked = await worker.fetch(judgeRequest(validBody(), "198.51.100.7"), env);
  assert.equal(blocked.status, 429);
  var other = await worker.fetch(judgeRequest(validBody(), "198.51.100.8"), env);
  assert.equal(other.status, 200);
});

test("全体の上限を超えると 429(X-RateLimit-Scope: global)", async () => {
  var env = makeEnv({ vars: { RATE_LIMIT_PER_IP_MAX: 30, RATE_LIMIT_GLOBAL_MAX: 2 } });

  assert.equal((await worker.fetch(judgeRequest(validBody(), "198.51.100.1"), env)).status, 200);
  assert.equal((await worker.fetch(judgeRequest(validBody(), "198.51.100.2"), env)).status, 200);

  // IP を変えても全体上限は逃れられない
  var res = await worker.fetch(judgeRequest(validBody(), "198.51.100.3"), env);
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("X-RateLimit-Scope"), "global");
  assert.ok(Number(res.headers.get("Retry-After")) > 0);
  var body = await res.json();
  assert.ok(body.error.includes("全体"));
  assert.equal(env.aiCalls.length, 2);
});

test("全体超過時は KV に書き込まない(IP単位のキーも触らない)", async () => {
  var windowSeconds = 3600;
  var bucket = bucketOf(windowSeconds);
  var kv = makeKV({ ["rl:global:" + bucket]: 5 });
  var env = makeEnv({
    kv: kv,
    vars: { RATE_LIMIT_GLOBAL_MAX: 5, RATE_LIMIT_PER_IP_MAX: 30, RATE_LIMIT_WINDOW_SECONDS: windowSeconds },
  });

  var res = await worker.fetch(judgeRequest(validBody(), "198.51.100.9"), env);
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("X-RateLimit-Scope"), "global");
  assert.equal(kv.puts.length, 0, "全体超過なのに KV に書き込んでいる");
  assert.equal(kv.store.get("rl:global:" + bucket), "5", "カウンタが増えている");
  assert.equal(kv.store.has("rl:ip:198.51.100.9:" + bucket), false);
});

test("IP単位超過時も KV に書き込まない", async () => {
  var windowSeconds = 3600;
  var bucket = bucketOf(windowSeconds);
  var kv = makeKV({ ["rl:ip:198.51.100.9:" + bucket]: 30 });
  var env = makeEnv({ kv: kv, vars: { RATE_LIMIT_WINDOW_SECONDS: windowSeconds } });

  var res = await worker.fetch(judgeRequest(validBody(), "198.51.100.9"), env);
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("X-RateLimit-Scope"), "ip");
  assert.equal(kv.puts.length, 0);
});

test("両方下回っていれば2つのキーを +1 し、TTL は windowSeconds + 60", async () => {
  var windowSeconds = 120;
  var bucket = bucketOf(windowSeconds);
  var kv = makeKV();
  var env = makeEnv({ kv: kv, vars: { RATE_LIMIT_WINDOW_SECONDS: windowSeconds } });

  var res = await worker.fetch(judgeRequest(validBody(), "198.51.100.5"), env);
  assert.equal(res.status, 200);

  assert.equal(kv.puts.length, 2);
  var keys = kv.puts.map((p) => p.key).sort();
  assert.deepEqual(keys, ["rl:global:" + bucket, "rl:ip:198.51.100.5:" + bucket]);
  for (var i = 0; i < kv.puts.length; i++) {
    assert.equal(kv.puts[i].value, "1");
    assert.equal(kv.puts[i].options.expirationTtl, windowSeconds + 60);
  }
});

test("成功時は残り回数のヘッダーが付く", async () => {
  var env = makeEnv({ vars: { RATE_LIMIT_PER_IP_MAX: 3, RATE_LIMIT_GLOBAL_MAX: 10 } });
  var first = await worker.fetch(judgeRequest(validBody(), "198.51.100.4"), env);
  assert.equal(first.headers.get("X-RateLimit-Remaining-IP"), "2");
  assert.equal(first.headers.get("X-RateLimit-Remaining-Global"), "9");

  var second = await worker.fetch(judgeRequest(validBody(), "198.51.100.4"), env);
  assert.equal(second.headers.get("X-RateLimit-Remaining-IP"), "1");
  assert.equal(second.headers.get("X-RateLimit-Remaining-Global"), "8");
});

test("[vars] を変えれば上限が変わる(コードを触らずに調整できる)", async () => {
  var loose = makeEnv({ vars: { RATE_LIMIT_PER_IP_MAX: 4 } });
  for (var i = 0; i < 4; i++) {
    assert.equal((await worker.fetch(judgeRequest(validBody(), "192.0.2.1"), loose)).status, 200);
  }
  assert.equal((await worker.fetch(judgeRequest(validBody(), "192.0.2.1"), loose)).status, 429);

  var tight = makeEnv({ vars: { RATE_LIMIT_PER_IP_MAX: 1 } });
  assert.equal((await worker.fetch(judgeRequest(validBody(), "192.0.2.1"), tight)).status, 200);
  assert.equal((await worker.fetch(judgeRequest(validBody(), "192.0.2.1"), tight)).status, 429);
});

test("[vars] 未設定なら既定値(IP 30回)が使われる", async () => {
  var env = makeEnv();
  for (var i = 0; i < 30; i++) {
    assert.equal(
      (await worker.fetch(judgeRequest(validBody(), "192.0.2.9"), env)).status,
      200,
      (i + 1) + "回目"
    );
  }
  var res = await worker.fetch(judgeRequest(validBody(), "192.0.2.9"), env);
  assert.equal(res.status, 429);
  assert.ok((await res.json()).error.includes("30回/3600秒"));
});

test("RATE_LIMIT_KV が無ければフェイルオープン(制限なしで通る)", async () => {
  var env = makeEnv({ kv: null, vars: { RATE_LIMIT_PER_IP_MAX: 1 } });
  assert.equal(env.RATE_LIMIT_KV, undefined);
  for (var i = 0; i < 5; i++) {
    var res = await worker.fetch(judgeRequest(validBody(), "192.0.2.50"), env);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("X-RateLimit-Remaining-IP"), null);
  }
  assert.equal(env.aiCalls.length, 5);
});

test("CF-Connecting-IP が無いリクエストもまとめて数える", async () => {
  var env = makeEnv({ vars: { RATE_LIMIT_PER_IP_MAX: 1 } });
  var request = () =>
    new Request("https://example.com/api/judge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody()),
    });
  assert.equal((await worker.fetch(request(), env)).status, 200);
  assert.equal((await worker.fetch(request(), env)).status, 429);
});
