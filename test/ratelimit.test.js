// レート制限(docs/DESIGN.md 3.2 / SPEC F6)。
//
// カウンタは Durable Object(`RateLimitCounter`)に入っている。ウィンドウのバケット番号は
// 現在時刻依存なので、テスト側でバケットを計算するとウィンドウ境界をまたいだ瞬間に落ちる。
// シードは makeRateLimiter の前方一致(`"ip:*"`)で行い、バケットが要る検証は
// スタブが実際に受け取った呼び出し(`limiter.calls[i].bucket`)から取り出して行う。
import { test } from "node:test";
import assert from "node:assert/strict";

import worker, { RateLimitCounter } from "../src/index.js";
import {
  makeEnv,
  makeRateLimiter,
  makeStorageCtx,
  counterRequest,
  judgeRequest,
  validBody,
} from "./helpers.js";

/** `limiter.calls` を "<name>/<op>" の配列にして順序を見やすくする。 */
function trace(limiter) {
  return limiter.calls.map((call) => call.name + "/" + call.op);
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
  // 拒否応答には残数ヘッダーを付けない
  assert.equal(res.headers.get("X-RateLimit-Remaining-IP"), null);
  assert.equal(res.headers.get("X-RateLimit-Remaining-Global"), null);
  var retryAfter = Number(res.headers.get("Retry-After"));
  assert.ok(Number.isInteger(retryAfter) && retryAfter > 0, "Retry-After が正の整数でない");
  assert.ok(retryAfter <= 3600);
  assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
  var body = await res.json();
  assert.ok(body.error.includes("IP"), "IP 単位であることが error に出ていない");
  assert.equal(env.aiCalls.length, 2, "429 なのに AI.run が呼ばれている");
});

test("別の IP は IP単位の上限に引っかからない(インスタンスが分かれている)", async () => {
  var limiter = makeRateLimiter();
  var env = makeEnv({ limiter: limiter, vars: { RATE_LIMIT_PER_IP_MAX: 1 } });
  var first = await worker.fetch(judgeRequest(validBody(), "198.51.100.7"), env);
  assert.equal(first.status, 200);
  var blocked = await worker.fetch(judgeRequest(validBody(), "198.51.100.7"), env);
  assert.equal(blocked.status, 429);
  var other = await worker.fetch(judgeRequest(validBody(), "198.51.100.8"), env);
  assert.equal(other.status, 200);

  assert.ok(limiter.state.has("ip:198.51.100.7"), "IP ごとのインスタンス名になっていない");
  assert.ok(limiter.state.has("ip:198.51.100.8"));
});

test("全体の上限を超えると 429(X-RateLimit-Scope: global)", async () => {
  var env = makeEnv({ vars: { RATE_LIMIT_PER_IP_MAX: 30, RATE_LIMIT_GLOBAL_MAX: 2 } });

  assert.equal((await worker.fetch(judgeRequest(validBody(), "198.51.100.1"), env)).status, 200);
  assert.equal((await worker.fetch(judgeRequest(validBody(), "198.51.100.2"), env)).status, 200);

  // IP を変えても全体上限は逃れられない
  var res = await worker.fetch(judgeRequest(validBody(), "198.51.100.3"), env);
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("X-RateLimit-Scope"), "global");
  assert.equal(res.headers.get("X-RateLimit-Remaining-IP"), null);
  assert.equal(res.headers.get("X-RateLimit-Remaining-Global"), null);
  assert.ok(Number(res.headers.get("Retry-After")) > 0);
  var body = await res.json();
  assert.ok(body.error.includes("全体"));
  assert.equal(env.aiCalls.length, 2);
});

test("全体超過時は全体を peek するだけで、IP 側のインスタンスを呼ばない", async () => {
  var limiter = makeRateLimiter({ global: 5 });
  var env = makeEnv({
    limiter: limiter,
    vars: { RATE_LIMIT_GLOBAL_MAX: 5, RATE_LIMIT_PER_IP_MAX: 30 },
  });

  var res = await worker.fetch(judgeRequest(validBody(), "198.51.100.9"), env);
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("X-RateLimit-Scope"), "global");
  assert.deepEqual(trace(limiter), ["global/peek"], "全体超過なのに余計な呼び出しをしている");
  assert.equal(limiter.state.get("global").count, 5, "全体超過なのに加算されている");
  assert.equal(env.aiCalls.length, 0);
});

test("IP単位超過時は全体を +1 しない(全体は peek だけ)", async () => {
  var limiter = makeRateLimiter({ "ip:*": 30 });
  var env = makeEnv({ limiter: limiter });

  var res = await worker.fetch(judgeRequest(validBody(), "198.51.100.9"), env);
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("X-RateLimit-Scope"), "ip");
  assert.deepEqual(
    trace(limiter),
    ["global/peek", "ip:198.51.100.9/increment"],
    "全体 peek → IP increment の順になっていない"
  );
  assert.equal(limiter.state.get("global").count, 0, "IP 超過なのに全体が加算されている");
  assert.equal(limiter.state.get("ip:198.51.100.9").count, 30, "拒否したのに加算されている");
});

test("両方下回っていれば 全体peek → IP+1 → 全体+1 の順で呼ぶ", async () => {
  var limiter = makeRateLimiter();
  var env = makeEnv({ limiter: limiter, vars: { RATE_LIMIT_WINDOW_SECONDS: 120 } });

  var res = await worker.fetch(judgeRequest(validBody(), "198.51.100.5"), env);
  assert.equal(res.status, 200);

  assert.deepEqual(trace(limiter), [
    "global/peek",
    "ip:198.51.100.5/increment",
    "global/increment",
  ]);
  // 3回とも同じバケット番号(= 同じウィンドウ)を指している
  var bucket = limiter.calls[0].bucket;
  assert.ok(Number.isSafeInteger(bucket), "バケット番号が整数でない: " + bucket);
  for (var i = 0; i < limiter.calls.length; i++) {
    assert.equal(limiter.calls[i].bucket, bucket);
  }
  // 上限は [vars] 由来の値がそのまま渡る
  assert.equal(limiter.calls[0].max, 500);
  assert.equal(limiter.calls[1].max, 30);
  assert.equal(limiter.state.get("global").count, 1);
  assert.equal(limiter.state.get("ip:198.51.100.5").count, 1);
});

test("Retry-After は現在のバケットが終わるまでの秒数", async () => {
  var windowSeconds = 600;
  var limiter = makeRateLimiter({ global: 999 });
  var env = makeEnv({
    limiter: limiter,
    vars: { RATE_LIMIT_GLOBAL_MAX: 10, RATE_LIMIT_WINDOW_SECONDS: windowSeconds },
  });

  var res = await worker.fetch(judgeRequest(validBody(), "198.51.100.6"), env);
  assert.equal(res.status, 429);

  var bucket = limiter.calls[0].bucket;
  var now = Math.floor(Date.now() / 1000);
  var expected = (bucket + 1) * windowSeconds - now;
  var actual = Number(res.headers.get("Retry-After"));
  assert.ok(
    Math.abs(actual - expected) <= 1,
    "Retry-After が (bucket+1)*window - now と一致しない: " + actual + " vs " + expected
  );
  assert.ok(actual > 0 && actual <= windowSeconds);
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

test("[vars] 未設定なら既定値(IP 30回 / 3600秒)が使われる", async () => {
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

/** 上限を使い切った状態を作り、429 の文面から「実際に使われた上限とウィンドウ」を読む。 */
async function limitsInUse(vars) {
  var limiter = makeRateLimiter({ "ip:*": 1000000 });
  var env = makeEnv({ limiter: limiter, vars: vars });
  var res = await worker.fetch(judgeRequest(validBody(), "192.0.2.77"), env);
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("X-RateLimit-Scope"), "ip");
  return (await res.json()).error;
}

test("[vars] は10進整数の文字列だけ採用し、紛らわしい表記は既定値に落とす", async () => {
  var bad = ["", " 30 ", "1e3", "0x10", "0", "-5", "abc", "12.0", "+7", "٣٠"];
  for (var i = 0; i < bad.length; i++) {
    var message = await limitsInUse({
      RATE_LIMIT_PER_IP_MAX: bad[i],
      RATE_LIMIT_WINDOW_SECONDS: bad[i],
    });
    assert.ok(
      message.includes("30回/3600秒"),
      JSON.stringify(bad[i]) + " が既定値に落ちていない: " + message
    );
  }

  var good = await limitsInUse({ RATE_LIMIT_PER_IP_MAX: "16", RATE_LIMIT_WINDOW_SECONDS: "120" });
  assert.ok(good.includes("16回/120秒"), "正しい値が使われていない: " + good);
});

test("RATE_LIMITER が無ければフェイルオープン(制限なしで通る)", async () => {
  var env = makeEnv({ limiter: null, vars: { RATE_LIMIT_PER_IP_MAX: 1 } });
  assert.equal(env.RATE_LIMITER, undefined);
  for (var i = 0; i < 5; i++) {
    var res = await worker.fetch(judgeRequest(validBody(), "192.0.2.50"), env);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("X-RateLimit-Remaining-IP"), null);
    assert.equal(res.headers.get("X-RateLimit-Remaining-Global"), null);
  }
  assert.equal(env.aiCalls.length, 5);
});

test("Durable Object の呼び出しが例外を投げたら 503(フェイルクローズ)", async () => {
  var limiter = makeRateLimiter(null, "throw");
  var env = makeEnv({ limiter: limiter });
  var res = await worker.fetch(judgeRequest(validBody(), "192.0.2.60"), env);
  assert.equal(res.status, 503);
  assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(res.headers.get("Retry-After"), "60");
  assert.equal(res.headers.get("X-RateLimit-Scope"), null);
  assert.equal(res.headers.get("X-RateLimit-Remaining-Global"), null);
  var body = await res.json();
  assert.equal(body.error, "レート制限の記録に失敗しました。しばらくしてから再試行してください");
  assert.equal(env.aiCalls.length, 0, "カウンタ障害なのに AI.run が呼ばれている");
});

test("Durable Object が 500 を返したら 503(フェイルクローズ)", async () => {
  var limiter = makeRateLimiter(null, "500");
  var env = makeEnv({ limiter: limiter });
  var res = await worker.fetch(judgeRequest(validBody(), "192.0.2.61"), env);
  assert.equal(res.status, 503);
  assert.equal(res.headers.get("Retry-After"), "60");
  assert.equal((await res.json()).error.includes("レート制限"), true);
  assert.equal(env.aiCalls.length, 0, "カウンタ障害なのに AI.run が呼ばれている");
});

test("CF-Connecting-IP が無いリクエストもまとめて数える", async () => {
  var limiter = makeRateLimiter();
  var env = makeEnv({ limiter: limiter, vars: { RATE_LIMIT_PER_IP_MAX: 1 } });
  var request = () =>
    new Request("https://example.com/api/judge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody()),
    });
  assert.equal((await worker.fetch(request(), env)).status, 200);
  assert.equal((await worker.fetch(request(), env)).status, 429);
  assert.ok(limiter.state.has("ip:unknown"), "IP 不明ぶんが1つのインスタンスにまとまっていない");
});

test("400 や 502 もレート制限の回数に数える(415 と 503 は数えない)", async () => {
  function increments(limiter) {
    return limiter.calls.filter((call) => call.op === "increment").length;
  }

  // 400
  var limiter400 = makeRateLimiter();
  var env400 = makeEnv({ limiter: limiter400 });
  var bad = await worker.fetch(
    judgeRequest({ puzzle: "not an array", target: { row: 0, col: 2 } }, "192.0.2.70"),
    env400
  );
  assert.equal(bad.status, 400);
  assert.equal(increments(limiter400), 2, "400 が回数に数えられていない");
  assert.equal(bad.headers.get("X-RateLimit-Remaining-IP"), "29");
  assert.equal(bad.headers.get("X-RateLimit-Remaining-Global"), "499");

  // 502
  var limiter502 = makeRateLimiter();
  var env502 = makeEnv({ limiter: limiter502, aiError: new Error("boom") });
  var failed = await worker.fetch(judgeRequest(validBody(), "192.0.2.71"), env502);
  assert.equal(failed.status, 502);
  assert.equal(increments(limiter502), 2, "502 が回数に数えられていない");
  assert.equal(failed.headers.get("X-RateLimit-Remaining-IP"), "29");
  assert.equal(failed.headers.get("X-RateLimit-Remaining-Global"), "499");

  // 415(レート制限より前で止まる)
  var limiter415 = makeRateLimiter();
  var env415 = makeEnv({ limiter: limiter415 });
  var unsupported = await worker.fetch(
    judgeRequest(validBody(), "192.0.2.72", "text/plain"),
    env415
  );
  assert.equal(unsupported.status, 415);
  assert.equal(limiter415.calls.length, 0, "415 なのにカウンタを呼んでいる");
});

// --- RateLimitCounter 単体(Durable Object の中身) ---------------------------

var BUCKET_KEY = "bucket";
var COUNT_KEY = "count:";

async function callCounter(ctx, op, bucket, max) {
  var counter = new RateLimitCounter(ctx, {});
  var res = await counter.fetch(counterRequest(op, bucket, max));
  assert.equal(res.status, 200);
  return await res.json();
}

test("RateLimitCounter: increment は上限未満のときだけ +1 する", async () => {
  // max-1 まで埋まっている → 通り、ちょうど max になる
  var ctx = makeStorageCtx({ bucket: 7, "count:7": 4 });
  assert.deepEqual(await callCounter(ctx, "increment", 7, 5), { allowed: true, count: 5 });
  assert.equal(ctx.store.get("count:7"), 5);

  // ちょうど max → 加算せずに拒否
  assert.deepEqual(await callCounter(ctx, "increment", 7, 5), { allowed: false, count: 5 });
  assert.equal(ctx.store.get("count:7"), 5, "拒否したのに加算されている");

  // 未設定のバケットは 0 から
  var fresh = makeStorageCtx();
  assert.deepEqual(await callCounter(fresh, "increment", 1, 2), { allowed: true, count: 1 });
  assert.equal(fresh.store.get(COUNT_KEY + 1), 1);
  assert.equal(fresh.store.get(BUCKET_KEY), 1);
});

test("RateLimitCounter: peek は読むだけで加算しない", async () => {
  var ctx = makeStorageCtx({ bucket: 3, "count:3": 2 });
  assert.deepEqual(await callCounter(ctx, "peek", 3, 5), { allowed: true, count: 2 });
  assert.deepEqual(await callCounter(ctx, "peek", 3, 2), { allowed: false, count: 2 });
  assert.equal(ctx.store.get("count:3"), 2, "peek で加算されている");
});

test("RateLimitCounter: バケットが変われば数え直し、古いバケットのキーを消す", async () => {
  var ctx = makeStorageCtx({ bucket: 10, "count:10": 5 });

  // 別バケットは独立してゼロから
  assert.deepEqual(await callCounter(ctx, "increment", 11, 5), { allowed: true, count: 1 });
  assert.equal(ctx.store.has("count:10"), false, "古いバケットのキーが残っている");
  assert.equal(ctx.store.get("count:11"), 1);
  assert.equal(ctx.store.get(BUCKET_KEY), 11);

  // さらに次のバケットへ。残るカウンタのキーは常に1つだけ。
  assert.deepEqual(await callCounter(ctx, "increment", 12, 5), { allowed: true, count: 1 });
  assert.equal(ctx.store.has("count:11"), false);
  assert.deepEqual([...ctx.store.keys()].sort(), ["bucket", "count:12"]);
});

test("RateLimitCounter: カウンタが壊れていたら超過扱い(フェイルクローズ)", async () => {
  var broken = ["abc", 1.5, -1, {}, Number.POSITIVE_INFINITY];
  for (var i = 0; i < broken.length; i++) {
    var ctx = makeStorageCtx({ bucket: 4, "count:4": broken[i] });
    assert.deepEqual(
      await callCounter(ctx, "increment", 4, 5),
      { allowed: false, count: 5 },
      String(broken[i]) + " が超過扱いになっていない"
    );
    assert.deepEqual(await callCounter(ctx, "peek", 4, 5), { allowed: false, count: 5 });
  }
});
