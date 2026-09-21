#!/usr/bin/env node
/**
 * Playwright E2E スモークテスト(GitHub Issue #17)。
 *
 * モックモード(既定): Node の http サーバーが src/index.js の default.fetch を
 * 直接呼んで GET / を配信する。POST /api/judge は正解表を知るこのスクリプト自身が
 * モックする(SOLUTION は Worker 側に置かないという不変条件(docs/DESIGN.md 9章)には
 * 抵触しない。scripts/ は src/ の外なので判定コードから隔離されたまま)。
 *
 *   npm run e2e                      # --mode mixed(既定)
 *   npm run e2e -- --mode correct
 *   npm run e2e -- --mode ratelimit
 *
 * 本番モード: 実際にデプロイ済みの Worker を叩く。最大3判定に抑える。
 *
 *   npm run e2e -- --url https://sudoku-calibration-check.takashi-kono-rb.workers.dev
 *
 * 終了コード: 0=全項目パス(SKIPは許容) / 1=いずれかの項目が失敗 / 2=Playwrightが無い
 */

import http from "node:http";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

var __dirname = path.dirname(fileURLToPath(import.meta.url));
var repoRoot = path.resolve(__dirname, "..", "..");
var outDir = path.join(__dirname, "out");

// ---------------------------------------------------------------------------
// 固定問題(docs/DESIGN.md 5章と同じ。#5 の数独ジェネレーター/ソルバーが main に
// マージされる前を前提にしている。マージ後は「新しい問題」ボタンの有無で分岐する)
// ---------------------------------------------------------------------------
var DIGITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];
var GIVEN = ["53..7....", "6..195...", ".98....6.", "8...6...3", "4..8.3..1", "7...2...6", ".6....28.", "...419..5", "....8..79"];
var SOLUTION = ["534678912", "672195348", "198342567", "859761423", "426853791", "713924856", "961537284", "287419635", "345286179"];
var TOTAL_EMPTY = GIVEN.join("").split("").filter(function (ch) { return ch === "."; }).length; // 51
var GIVEN_COUNT = 81 - TOTAL_EMPTY; // 30

// ---------------------------------------------------------------------------
// 引数
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  var args = { mode: "mixed", url: null };
  for (var i = 0; i < argv.length; i++) {
    if (argv[i] === "--mode") args.mode = argv[++i];
    else if (argv[i] === "--url") args.url = argv[++i];
  }
  return args;
}

var args = parseArgs(process.argv.slice(2));
if (!args.url && ["mixed", "correct", "ratelimit"].indexOf(args.mode) === -1) {
  console.error("不明な --mode: " + args.mode + "(mixed / correct / ratelimit のいずれか)");
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });

// ---------------------------------------------------------------------------
// Playwright の読み込み。無ければ案内して終了コード2。
// ---------------------------------------------------------------------------
async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch (e) {
    console.error("Playwright が見つかりません。`npm install --no-save playwright` を実行してください。");
    process.exit(2);
  }
}

/**
 * この環境(PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers)にプリインストールされた
 * Chromium の実行ファイルを探す。npm 経由でインストールした playwright パッケージの
 * 期待バージョンと、プリインストール済みブラウザのリビジョンが食い違うことがあるため、
 * `chromium.launch()` に既定のブラウザ解決をさせず、実在するバイナリを明示的に渡す。
 */
function resolveChromiumExecutable() {
  var base = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!base) return undefined;
  var directSymlink = path.join(base, "chromium");
  if (fs.existsSync(directSymlink)) return directSymlink;
  try {
    var entries = fs.readdirSync(base);
    var dir = entries.find(function (e) {
      return /^chromium-\d+$/.test(e);
    });
    if (dir) {
      var candidate = path.join(base, dir, "chrome-linux", "chrome");
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch (e) {
    // 見つからなければ既定の解決に任せる
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// モックサーバー(モックモードのみ)
// ---------------------------------------------------------------------------
async function startMockServer(mode) {
  var workerModule = await import(path.join(repoRoot, "src", "index.js"));
  var worker = workerModule.default;
  var requestCount = 0;

  var server = http.createServer(async function (req, res) {
    try {
      var url = new URL(req.url, "http://localhost");

      if (req.method === "POST" && url.pathname === "/api/judge") {
        var chunks = [];
        for await (var chunk of req) chunks.push(chunk);
        var bodyText = Buffer.concat(chunks).toString("utf8");
        var body = null;
        try {
          body = JSON.parse(bodyText);
        } catch (e) {
          // 無効な JSON は下の 400 に落ちる
        }

        requestCount += 1;

        if (mode === "ratelimit" && requestCount >= 3) {
          var rlPayload = JSON.stringify({ error: "アクセス元(IP)ごとのレート制限を超えました(モック)" });
          res.writeHead(429, { "content-type": "application/json; charset=utf-8", "retry-after": "60" });
          res.end(rlPayload);
          return;
        }

        if (!body || !body.target || typeof body.target.row !== "number" || typeof body.target.col !== "number") {
          res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ error: "target が不正です(モック)" }));
          return;
        }

        var row = body.target.row;
        var col = body.target.col;
        var correctDigit = SOLUTION[row][col];
        var choice = correctDigit;
        if (mode === "mixed" && Math.random() >= 0.7) {
          var others = DIGITS.filter(function (d) { return d !== correctDigit; });
          choice = others[Math.floor(Math.random() * others.length)];
        }

        var probabilities = {};
        DIGITS.forEach(function (d) {
          probabilities[d] = d === choice ? 0.9 : 0.0125;
        });

        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ probabilities: probabilities, choice: choice, confidence: 0.5 }));
        return;
      }

      // それ以外(GET / など)は Worker 本体にそのまま委譲する
      var headers = new Headers();
      for (var key in req.headers) {
        var value = req.headers[key];
        if (value === undefined) continue;
        headers.set(key, Array.isArray(value) ? value.join(", ") : value);
      }
      var init = { method: req.method, headers: headers };
      if (req.method !== "GET" && req.method !== "HEAD") {
        var bodyChunks = [];
        for await (var c of req) bodyChunks.push(c);
        init.body = Buffer.concat(bodyChunks);
      }
      var request = new Request("http://localhost" + req.url, init);
      var response = await worker.fetch(request, {});
      var resHeaders = {};
      response.headers.forEach(function (v, k) {
        resHeaders[k] = v;
      });
      res.writeHead(response.status, resHeaders);
      var buf = Buffer.from(await response.arrayBuffer());
      res.end(buf);
    } catch (err) {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end("mock server error: " + (err && err.stack ? err.stack : String(err)));
    }
  });

  await new Promise(function (resolve) {
    server.listen(0, "127.0.0.1", resolve);
  });
  var address = server.address();
  return { server: server, baseUrl: "http://127.0.0.1:" + address.port };
}

// ---------------------------------------------------------------------------
// レポーティング
// ---------------------------------------------------------------------------
// fn の中から throw new Skip("理由") すると、その項目は FAIL ではなく SKIP として
// 記録される(モードに合わない・対象の要素が無い、などの想定内のスキップ用)。
class Skip extends Error {}

var results = [];
function report(num, name, status, detail) {
  var line = "[" + num + "] " + name + ": " + status + (detail ? " (" + detail + ")" : "");
  console.log(line);
  results.push({ num: num, name: name, status: status });
}

async function runCheck(num, name, fn) {
  try {
    var detail = await fn();
    report(num, name, "PASS", detail);
  } catch (err) {
    if (err instanceof Skip) {
      report(num, name, "SKIP", err.message);
    } else {
      report(num, name, "FAIL", err && err.message ? err.message : String(err));
    }
  }
}

// ---------------------------------------------------------------------------
// モックモード本体
// ---------------------------------------------------------------------------
async function runMockMode(chromium, executablePath, mode) {
  var mockServer = await startMockServer(mode);
  var browser = await chromium.launch({ executablePath: executablePath, headless: true });
  var page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  try {
    await page.goto(mockServer.baseUrl + "/", { waitUntil: "load" });

    // [1] 初期表示: 統計カードと与えられた数字
    await runCheck(1, "初期表示の統計カード / 与えられた数字30マス", async function () {
      var statValues = await page.locator("#stats .stat-value").allTextContents();
      assert.equal(statValues.length, 4, "統計カードが4つない");
      assert.equal(statValues[0], "1周目", "現在の周が1周目でない: " + statValues[0]);
      assert.equal(statValues[1], TOTAL_EMPTY + " / " + TOTAL_EMPTY, "残りマスが51/51でない: " + statValues[1]);
      assert.equal(statValues[2], "0問", "累計正解が0問でない: " + statValues[2]);
      assert.equal(statValues[3], "0 / " + TOTAL_EMPTY + " (0%)", "この周の進捗が0/51(0%)でない: " + statValues[3]);

      var cellTexts = await page.locator("#grid .cell").allTextContents();
      assert.equal(cellTexts.length, 81, "マス数が81でない");
      var given = cellTexts.filter(function (t) { return t.trim() !== ""; }).length;
      assert.equal(given, GIVEN_COUNT, "与えられた数字が30マスでない: " + given);

      await page.screenshot({ path: path.join(outDir, mode + "-01-initial.png") });
      return statValues.join(" / ") + " / given=" + given;
    });

    // [2] 「最速」で実行 → 1周目のログ行
    await runCheck(2, "「最速」実行で1周目のログが出る", async function () {
      if (mode === "ratelimit") {
        // ratelimit モードは3件目で429になり round1(51マス)を完走できないため、
        // このモードでは意味を持たない([4] で別途検証する)。
        throw new Skip("ratelimit モードは3件目で429になり周を完走できない");
      }
      await page.locator("#speed-toggle button", { hasText: "最速" }).click();
      await page.click("#run-btn");
      var logItem = page.locator("#round-log li").first();
      await logItem.waitFor({ state: "visible", timeout: 30000 });
      var text = await logItem.textContent();
      assert.match(text, /^1周目:/, "1行目が「1周目:」で始まらない: " + text);
      await page.screenshot({ path: path.join(outDir, mode + "-02-round-log.png") });
      return text;
    });

    // [3] correct モードで完了バナー
    await runCheck(3, "correctモードで完了バナー", async function () {
      if (mode !== "correct") throw new Skip("--mode correct 専用");
      // completion-banner は id とクラス(banner success)が同じ要素に付く(子孫ではない)
      var banner = page.locator("#completion-banner.banner.success");
      await banner.waitFor({ state: "visible", timeout: 30000 });
      var text = await banner.textContent();
      assert.match(text, /周ですべて正解しました$/, "完了バナーの文言が違う: " + text);
      await page.screenshot({ path: path.join(outDir, mode + "-03-completion.png") });
      return text;
    });

    // 次のチェックのために一旦リセットしておく(completion 済み・round-log 途中・
    // まだ何も実行していない、のいずれでも reset は安全に効く。SPEC F5)。
    await page.click("#reset-btn");
    await page.locator("#round-log").getByText("まだ記録はありません").waitFor({ timeout: 5000 });

    // [5] 「じっくり確認」で実行 → 判定中マスの枠線とバー
    // ※ [4](ratelimit)より先に行う: モックのレート制限カウンタはスクリプト全体で
    //    共有(サーバー起動からの累計)なので、[4] で上限を使い切ってしまう前に
    //    ここで1件だけ成功レスポンスを消費しておく必要がある
    await runCheck(5, "「じっくり確認」実行で枠線とバーが出る", async function () {
      await page.locator("#speed-toggle button", { hasText: "じっくり確認" }).click();
      await page.click("#run-btn");

      var focusedCell = page.locator('#grid .cell[style*="box-shadow"]');
      await focusedCell.first().waitFor({ state: "visible", timeout: 10000 });
      var barFill = page.locator("#current-panel .bar-fill");
      await barFill.first().waitFor({ state: "visible", timeout: 10000 });
      var barCount = await barFill.count();
      assert.ok(barCount >= 1, "確率バーが出ていない");
      await page.screenshot({ path: path.join(outDir, mode + "-05-focus-bars.png") });

      await page.click("#reset-btn");
      return "bars=" + barCount;
    });

    // [6] 「新しい問題」ボタン(#5 マージ前は無い)
    await runCheck(6, "「新しい問題」ボタンで盤面が変わる", async function () {
      var newPuzzleBtn = page.locator("button", { hasText: "新しい問題" });
      var count = await newPuzzleBtn.count();
      if (count === 0) {
        throw new Skip("『新しい問題』ボタンが無い(#5 マージ前の main)");
      }
      var before = await page.locator("#grid .cell").allTextContents();
      await newPuzzleBtn.first().click();
      await page.waitForTimeout(200);
      var after = await page.locator("#grid .cell").allTextContents();
      assert.notDeepEqual(before, after, "「新しい問題」を押しても盤面が変わらない");
      await page.screenshot({ path: path.join(outDir, mode + "-06-new-puzzle.png") });
      return "changed";
    });

    // [4] ratelimit モードで赤いエラーボックス → リセットで復帰
    await runCheck(4, "ratelimitモードでエラーボックス→リセットで復帰", async function () {
      if (mode !== "ratelimit") throw new Skip("--mode ratelimit 専用");
      await page.locator("#speed-toggle button", { hasText: "最速" }).click();
      await page.click("#run-btn");
      var errorBox = page.locator("#error-box.error");
      await errorBox.waitFor({ state: "visible", timeout: 30000 });
      var message = await errorBox.textContent();
      assert.ok(message && message.trim().length > 0, "エラーメッセージが空");
      var runDisabled = await page.locator("#run-btn").getAttribute("disabled");
      assert.notEqual(runDisabled, null, "エラー後も実行ボタンが有効なまま");
      await page.screenshot({ path: path.join(outDir, mode + "-04-error.png") });

      await page.click("#reset-btn");
      await page.locator("#error-box.error").waitFor({ state: "detached", timeout: 5000 });
      var runDisabledAfterReset = await page.locator("#run-btn").getAttribute("disabled");
      assert.equal(runDisabledAfterReset, null, "リセット後も実行ボタンが無効なまま");
      await page.screenshot({ path: path.join(outDir, mode + "-04-after-reset.png") });
      return "error=\"" + message + "\"";
    });
  } finally {
    await browser.close();
    mockServer.server.close();
  }
}

// ---------------------------------------------------------------------------
// 本番モード(最大3判定。私(オーナー)が別途実行する)
// ---------------------------------------------------------------------------
async function runProductionMode(chromium, executablePath, targetUrl) {
  var browser = await chromium.launch({ executablePath: executablePath, headless: true });
  var page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  var judgeRequests = [];
  page.on("request", function (req) {
    if (req.url().indexOf("/api/judge") !== -1) judgeRequests.push(req.url());
  });

  try {
    var response = await page.goto(targetUrl, { waitUntil: "load" });

    await runCheck("H", "GET / のセキュリティヘッダー3つ", async function () {
      var headers = response.headers();
      assert.equal(headers["x-content-type-options"], "nosniff", "X-Content-Type-Options が無い/違う");
      assert.equal(headers["referrer-policy"], "no-referrer", "Referrer-Policy が無い/違う");
      assert.equal(headers["content-security-policy"], "frame-ancestors 'none'", "Content-Security-Policy が無い/違う");
      return "ok";
    });

    await page.screenshot({ path: path.join(outDir, "prod-01-initial.png") });

    await runCheck("R", "最速で実行→3マス目の色付けでリセット(最大3判定)", async function () {
      await page.locator("#speed-toggle button", { hasText: "最速" }).click();
      await page.click("#run-btn");

      await page.waitForFunction(
        function () {
          return document.querySelectorAll(
            '#grid .cell[style*="--correct-bg"], #grid .cell[style*="--incorrect-bg"]'
          ).length >= 3;
        },
        { timeout: 60000 }
      );
      await page.screenshot({ path: path.join(outDir, "prod-02-three-cells.png") });

      await page.click("#reset-btn");
      // 直前に飛んでいたリクエストが落ち着くのを少し待つ
      await page.waitForTimeout(2000);

      assert.ok(judgeRequests.length <= 4, "想定より多くの /api/judge が呼ばれた: " + judgeRequests.length);
      return "/api/judge リクエスト数=" + judgeRequests.length;
    });
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------------------
// エントリポイント
// ---------------------------------------------------------------------------
async function main() {
  var playwright = await loadPlaywright();
  var chromium = playwright.chromium;
  var executablePath = resolveChromiumExecutable();

  if (args.url) {
    console.log("本番モード: " + args.url);
    await runProductionMode(chromium, executablePath, args.url);
  } else {
    console.log("モックモード: --mode " + args.mode);
    await runMockMode(chromium, executablePath, args.mode);
  }

  var failed = results.filter(function (r) { return r.status === "FAIL"; });
  console.log("");
  console.log(results.length + "件中 " + failed.length + "件失敗");
  if (failed.length > 0) process.exit(1);
}

main().catch(function (err) {
  console.error("スモークテストが例外で停止:", err);
  process.exit(1);
});
