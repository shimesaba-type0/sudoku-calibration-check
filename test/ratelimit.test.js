// レート制限(docs/DESIGN.md 3.2 / SPEC F6)。
//
// レート制限のキーにはバケット番号(現在時刻 ÷ ウィンドウ幅)が入る。テスト側で
// バケットを計算するとウィンドウ境界をまたいだ瞬間に落ちるので、シードは makeKV の
// 前方一致(`"rl:global:*"`)で行い、検証は KV が実際に読み書きしたキーから
// バケットを取り出して行う。
import { test } from "node:test";
import assert from "node:assert/strict";

import worker from "../src/index.js";
import { makeEnv, makeKV, bucketFromKey, judgeRequest, validBody } from "./helpers.js";

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
  assert.equal(res.headers.get("X-RateLimit-Remaining-IP"), null);
  assert.equal(res.headers.get("X-RateLimit-Remaining-Global"), null);
  assert.ok(Number(res.headers.get("Retry-After")) > 0);
  var body = await res.json();
  assert.ok(body.error.includes("全体"));
  assert.equal(env.aiCalls.length, 2);
});

test("全体超過時は KV に書き込まず、IP単位のキーを読みもしない", async () => {
  var kv = makeKV({ "rl:global:*": 5 });
  var env = makeEnv({ kv: kv, vars: { RATE_LIMIT_GLOBAL_MAX: 5, RATE_LIMIT_PER_IP_MAX: 30 } });

  var res = await worker.fetch(judgeRequest(validBody(), "198.51.100.9"), env);
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("X-RateLimit-Scope"), "global");
  assert.equal(kv.puts.length, 0, "全体超過なのに KV に書き込んでいる");
  assert.equal(kv.gets.length, 1, "全体超過なのに余計なキーを読んでいる: " + kv.gets.join(", "));
  assert.ok(kv.gets[0].startsWith("rl:global:"), "最初に読むのは全体のキー");
  assert.equal(env.aiCalls.length, 0);
});

test("IP単位超過時も KV に書き込まない", async () => {
  var kv = makeKV({ "rl:ip:*": 30 });
  var env = makeEnv({ kv: kv });

  var res = await worker.fetch(judgeRequest(validBody(), "198.51.100.9"), env);
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("X-RateLimit-Scope"), "ip");
  assert.equal(kv.puts.length, 0);
  assert.deepEqual(
    kv.gets.map((key) => key.split(":")[1]),
    ["global", "ip"],
    "全体 → IP の順で読んでいない"
  );
});

test("両方下回っていれば2つのキーを +1 し、TTL は windowSeconds + 60", async () => {
  var windowSeconds = 120;
  var kv = makeKV();
  var env = makeEnv({ kv: kv, vars: { RATE_LIMIT_WINDOW_SECONDS: windowSeconds } });

  var res = await worker.fetch(judgeRequest(validBody(), "198.51.100.5"), env);
  assert.equal(res.status, 200);

  assert.equal(kv.puts.length, 2);
  // 書かれたキーからバケットを取り出し、2つのキーが同じバケットを指していることを見る
  var bucket = bucketFromKey(kv.puts[0].key);
  assert.ok(Number.isInteger(bucket), "バケット番号が取れない: " + kv.puts[0].key);
  var keys = kv.puts.map((p) => p.key).sort();
  assert.deepEqual(keys, ["rl:global:" + bucket, "rl:ip:198.51.100.5:" + bucket]);
  for (var i = 0; i < kv.puts.length; i++) {
    assert.equal(kv.puts[i].value, "1");
    assert.equal(kv.puts[i].options.expirationTtl, windowSeconds + 60);
  }
});

test("Retry-After は現在のバケットが終わるまでの秒数", async () => {
  var windowSeconds = 600;
  var kv = makeKV({ "rl:global:*": 999 });
  var env = makeEnv({
    kv: kv,
    vars: { RATE_LIMIT_GLOBAL_MAX: 10, RATE_LIMIT_WINDOW_SECONDS: windowSeconds },
  });

  var res = await worker.fetch(judgeRequest(validBody(), "198.51.100.6"), env);
  assert.equal(res.status, 429);

  var bucket = bucketFromKey(kv.gets[0]);
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
  var kv = makeKV({ "rl:ip:*": 1000000 });
  var env = makeEnv({ kv: kv, vars: vars });
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

test("KV のカウンタが壊れていたら超過扱い(フェイルクローズ)", async () => {
  var brokenGlobal = makeKV({ "rl:global:*": "abc" });
  var env = makeEnv({ kv: brokenGlobal });
  var res = await worker.fetch(judgeRequest(validBody(), "192.0.2.30"), env);
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("X-RateLimit-Scope"), "global");
  assert.equal(brokenGlobal.puts.length, 0);
  assert.equal(env.aiCalls.length, 0);

  var brokenIp = makeKV({ "rl:ip:*": "９９" });
  var env2 = makeEnv({ kv: brokenIp });
  var res2 = await worker.fetch(judgeRequest(validBody(), "192.0.2.31"), env2);
  assert.equal(res2.status, 429);
  assert.equal(res2.headers.get("X-RateLimit-Scope"), "ip");
  assert.equal(env2.aiCalls.length, 0);
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

test("KV があるのに get が失敗したら 503(フェイルクローズ)", async () => {
  var kv = makeKV(null, "get");
  var env = makeEnv({ kv: kv });
  var res = await worker.fetch(judgeRequest(validBody(), "192.0.2.60"), env);
  assert.equal(res.status, 503);
  assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(res.headers.get("Retry-After"), "60");
  var body = await res.json();
  assert.equal(body.error, "レート制限の記録に失敗しました。しばらくしてから再試行してください");
  assert.equal(env.aiCalls.length, 0, "KV 障害なのに AI.run が呼ばれている");
});

test("KV があるのに put が失敗したら 503(フェイルクローズ)", async () => {
  var kv = makeKV(null, "put");
  var env = makeEnv({ kv: kv });
  var res = await worker.fetch(judgeRequest(validBody(), "192.0.2.61"), env);
  assert.equal(res.status, 503);
  assert.equal(res.headers.get("Retry-After"), "60");
  assert.equal((await res.json()).error.includes("レート制限"), true);
  assert.equal(env.aiCalls.length, 0, "KV 障害なのに AI.run が呼ばれている");
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

test("400 や 502 もレート制限の回数に数える(415 と 503 は数えない)", async () => {
  // 400
  var kv400 = makeKV();
  var env400 = makeEnv({ kv: kv400 });
  var bad = await worker.fetch(
    judgeRequest({ puzzle: "not an array", target: { row: 0, col: 2 } }, "192.0.2.70"),
    env400
  );
  assert.equal(bad.status, 400);
  assert.equal(kv400.puts.length, 2, "400 が回数に数えられていない");

  // 502
  var kv502 = makeKV();
  var env502 = makeEnv({ kv: kv502, aiError: new Error("boom") });
  var failed = await worker.fetch(judgeRequest(validBody(), "192.0.2.71"), env502);
  assert.equal(failed.status, 502);
  assert.equal(kv502.puts.length, 2, "502 が回数に数えられていない");

  // 415(レート制限より前で止まる)
  var kv415 = makeKV();
  var env415 = makeEnv({ kv: kv415 });
  var unsupported = await worker.fetch(
    judgeRequest(validBody(), "192.0.2.72", "text/plain"),
    env415
  );
  assert.equal(unsupported.status, 415);
  assert.equal(kv415.puts.length, 0, "415 が回数に数えられている");
  assert.equal(kv415.gets.length, 0, "415 なのに KV を読んでいる");
});
