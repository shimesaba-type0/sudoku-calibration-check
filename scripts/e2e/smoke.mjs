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

// exclude(消去法。Issue #61・#63)を引いた残りの数字。フロントが送ってくる exclude
// (digit は配列、all はマスのキーごとの配列)をそのまま尊重し、本番の Worker と同じく
// 残りの数字だけを probabilities / choice の候補にする(exclude が無ければ 1〜9 のまま)。
function remainingDigitsMock(exclude) {
  if (!Array.isArray(exclude) || exclude.length === 0) return DIGITS.slice();
  return DIGITS.filter(function (d) { return exclude.indexOf(d) === -1; });
}

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

        // ask:"cell"(確信度順のマス選び、Issue #38)。body.puzzle の空マスから先頭
        // (行優先で最初)を選び、probabilities を空マス全体に配って返す。
        if (body && body.ask === "cell") {
          var emptyCells = [];
          for (var er = 0; er < 9; er++) {
            for (var ec = 0; ec < 9; ec++) {
              if (body.puzzle && body.puzzle[er] && body.puzzle[er][ec] === ".") {
                emptyCells.push({ key: "r" + er + "c" + ec, row: er, col: ec });
              }
            }
          }
          if (emptyCells.length === 0) {
            res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ error: "空マスがありません(モック)" }));
            return;
          }
          var chosenCell = emptyCells[0];
          var cellProbabilities = {};
          emptyCells.forEach(function (cell) {
            cellProbabilities[cell.key] = cell.key === chosenCell.key ? 0.5 : 0.5 / Math.max(1, emptyCells.length - 1);
          });
          var cellCriteria = {};
          emptyCells.forEach(function (cell) {
            cellCriteria[cell.key] = "row " + cell.row + ", column " + cell.col + " (zero-based)";
          });
          var cellRequest = {
            state: { puzzle: body.puzzle, note: "puzzle is a 9x9 Sudoku grid, no target this time (mock)" },
            questions: { cell: { type: "choice", instructions: "Which empty cell of this Sudoku grid can be filled in with the most certainty?", criteria: cellCriteria } },
          };
          res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          // usage(トークン使用量、Issue #55・#56)。本番の Worker が 200 に添えるのと同じ形。
          res.end(JSON.stringify({
            probabilities: cellProbabilities,
            choice: chosenCell.key,
            confidence: 0.4,
            cell: { row: chosenCell.row, col: chosenCell.col },
            request: cellRequest,
            usage: { input_tokens: 700, output_tokens: 90 },
          }));
          return;
        }

        // ask:"all"(一括モード、Issue #48)。body.puzzle の空マス全部について choice を
        // まとめて返す(1呼び出しで1周ぶん)。
        if (body && body.ask === "all") {
          var allEmptyCells = [];
          for (var ar = 0; ar < 9; ar++) {
            for (var ac = 0; ac < 9; ac++) {
              if (body.puzzle && body.puzzle[ar] && body.puzzle[ar][ac] === ".") {
                allEmptyCells.push({ key: "r" + ar + "c" + ac, row: ar, col: ac });
              }
            }
          }
          if (allEmptyCells.length === 0) {
            res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ error: "空マスがありません(モック)" }));
            return;
          }
          // exclude(消去法。Issue #61・#63)はマスのキーごとの配列(readExcludeMap と同じ形)
          var allExcludeByKey = (body.exclude && typeof body.exclude === "object" && !Array.isArray(body.exclude)) ? body.exclude : {};
          var allCriteria = {};
          DIGITS.forEach(function (d) { allCriteria[d] = "the digit " + d; });
          var allCells = {};
          var allQuestions = {};
          allEmptyCells.forEach(function (cell) {
            var correctDigit = SOLUTION[cell.row][cell.col];
            var cellDigits = remainingDigitsMock(allExcludeByKey[cell.key]);
            var choice = correctDigit; // ルール候補で必ず残っているはずの正解(#63 の性質)
            if (mode === "mixed" && Math.random() >= 0.7) {
              var others = cellDigits.filter(function (d) { return d !== correctDigit; });
              if (others.length > 0) choice = others[Math.floor(Math.random() * others.length)];
            }
            var probabilities = {};
            cellDigits.forEach(function (d) { probabilities[d] = d === choice ? 0.9 : 0.0125 * 9 / cellDigits.length; });
            allCells[cell.key] = { choice: choice, probabilities: probabilities, confidence: 0.5 };
            allQuestions[cell.key] = {
              type: "choice",
              instructions: "Which digit from 1 to 9 belongs in the empty cell at row " + cell.row + ", column " + cell.col + " (zero-based)?",
              criteria: cellDigits.length < DIGITS.length ? (function () {
                var c = {};
                cellDigits.forEach(function (d) { c[d] = "the digit " + d; });
                return c;
              })() : allCriteria,
            };
          });
          var allRequest = {
            state: { puzzle: body.puzzle, note: "puzzle is a 9x9 Sudoku grid, no target this time (mock, all)" },
            questions: allQuestions,
          };
          res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          // usage(Issue #55・#56)。一括は1回で全マスぶんなので、実測(docs/DESIGN.md 3.4)に近い規模で固定値を返す。
          res.end(JSON.stringify({ cells: allCells, request: allRequest, usage: { input_tokens: 9000, output_tokens: 4000 } }));
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
        // exclude(消去法。Issue #61・#63)は "1"〜"9" の配列。残りの数字だけを候補にする。
        var digits = remainingDigitsMock(body.exclude);
        var choice = correctDigit; // ルール候補で必ず残っているはずの正解(#63 の性質)
        if (mode === "mixed" && Math.random() >= 0.7) {
          var others = digits.filter(function (d) { return d !== correctDigit; });
          if (others.length > 0) choice = others[Math.floor(Math.random() * others.length)];
        }

        var probabilities = {};
        digits.forEach(function (d) {
          probabilities[d] = d === choice ? 0.9 : 0.0125 * 9 / digits.length;
        });

        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        // Worker の契約(SPEC 4章)に合わせて request(Jev に渡したペイロード)も返す(Issue #34)。
        // note / instructions の文言は本番の Worker と同じである必要はなく、形だけ揃える。
        var criteria = {};
        digits.forEach(function (d) { criteria[d] = "the digit " + d; });
        var request = {
          state: { puzzle: body.puzzle, target: body.target, note: "puzzle is a 9x9 Sudoku grid (mock)" },
          questions: { digit: { type: "choice", instructions: "Which digit from 1 to 9 belongs in the target cell of this Sudoku grid?", criteria: criteria } },
        };
        // usage(トークン使用量、Issue #55・#56)。本番の Worker が 200 に添えるのと同じ形。
        res.end(JSON.stringify({
          probabilities: probabilities,
          choice: choice,
          confidence: 0.5,
          request: request,
          usage: { input_tokens: 700, output_tokens: 90 },
        }));
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
/**
 * ブラウザ起動オプション。E2E_PROXY(例: http://127.0.0.1:8080)が指定されていれば
 * そのプロキシを経由する(クラウドセッションのように egress がプロキシ経由の環境向け)。
 */
function launchOptions(executablePath) {
  var options = { executablePath: executablePath, headless: true };
  if (process.env.E2E_PROXY) options.proxy = { server: process.env.E2E_PROXY };
  return options;
}

async function runMockMode(chromium, executablePath, mode) {
  var mockServer = await startMockServer(mode);
  var browser = await chromium.launch(launchOptions(executablePath));
  var page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
    // TLS を差し替えるプロキシ経由(クラウドセッション等)では証明書エラーになるため、
    // 明示的に E2E_IGNORE_HTTPS_ERRORS=1 を指定したときだけ無視する。
    ignoreHTTPSErrors: process.env.E2E_IGNORE_HTTPS_ERRORS === "1",
  });

  try {
    await page.goto(mockServer.baseUrl + "/", { waitUntil: "load" });

    // [1] 初期表示: 統計カードと与えられた数字
    await runCheck(1, "初期表示の統計カード / 与えられた数字30マス", async function () {
      // 統計カードは5枚(Issue #60): 現在の周 / 残りマス / 累計正解 / この周の判定済み / この周の正解
      var statValues = await page.locator("#stats .stat-value").allTextContents();
      assert.equal(statValues.length, 5, "統計カードが5つない");
      assert.equal(statValues[0], "1周目", "現在の周が1周目でない: " + statValues[0]);
      assert.equal(statValues[1], TOTAL_EMPTY + " / " + TOTAL_EMPTY, "残りマスが51/51でない: " + statValues[1]);
      assert.equal(statValues[2], "0問", "累計正解が0問でない: " + statValues[2]);
      assert.equal(statValues[3], "0 / " + TOTAL_EMPTY, "この周の判定済みが0/51でない: " + statValues[3]);
      assert.equal(statValues[4], "0 / " + TOTAL_EMPTY + " (0%)", "この周の正解が0/51(0%)でない: " + statValues[4]);

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
      await page.locator("#speed-toggle").selectOption("fast");
      await page.click("#run-btn");
      var logItem = page.locator("#round-log li").first();
      await logItem.waitFor({ state: "visible", timeout: 30000 });
      var text = await logItem.textContent();
      assert.match(text, /^1周目:/, "1行目が「1周目:」で始まらない: " + text);
      // 処理時間・コスト(Issue #55・#56)。"— 1,234 ms / $0.0004" のような書式で出る。
      assert.match(text, /— [\d,]+ ms \/ \$/, "周回ログの行に ms / $ が出ていない: " + text);
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
      // 開始から終了までの所要時間が添えられる(オーナー要望 2026-09-23、Issue #76)
      assert.match(text, /周ですべて正解しました\(所要 [\d,]+ ms\)$/, "完了バナーの文言が違う: " + text);
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
      await page.locator("#speed-toggle").selectOption("slow");
      await page.click("#run-btn");

      var focusedCell = page.locator('#grid .cell[style*="box-shadow"]');
      await focusedCell.first().waitFor({ state: "visible", timeout: 10000 });
      var barFill = page.locator("#current-panel .bar-fill");
      await barFill.first().waitFor({ state: "visible", timeout: 10000 });
      var barCount = await barFill.count();
      assert.ok(barCount >= 1, "確率バーが出ていない");
      // 「Jev に送ったプロンプト」枠(Issue #34)にレスポンスの request が出ている
      var promptPanel = page.locator("#prompt-panel");
      await promptPanel.waitFor({ state: "visible", timeout: 10000 });
      var promptText = await promptPanel.innerText();
      assert.ok(promptText.includes("Which digit from 1 to 9"), "プロンプト枠に instructions が出ていない");
      assert.ok(promptText.includes("の判定に使用"), "プロンプト枠に対象マスが出ていない");
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

    // [7] 確信度順モード(Issue #38)。順番トグルを切り替えて最速で実行し、1周目の
    // ログが出ること・/api/judge の呼び出しが「マス選び(ask:cell)と数字が同数で、
    // 数字が空マス数以上」であることを確認する。総数の厳密一致にしないのは、mixed
    // モードでは1周目のログ直後に2周目のマス選びが飛ぶことがあり、タイミングで
    // 1〜2件増えるため(レビュー指摘)。ratelimit モードは3件目で429になるので対象外
    // (本番モードはこのチェック自体が呼ばれない。runMockMode 専用)。
    await runCheck(7, "確信度順で1周目のログが出る(/api/judge はマス選びと数字が同数)", async function () {
      if (mode === "ratelimit") {
        throw new Skip("ratelimit モードは3件目で429になり呼び出し数を検証できない");
      }
      var cellCalls = 0;
      var digitCalls = 0;
      var counter = function (req) {
        if (req.url().indexOf("/api/judge") === -1) return;
        var ask = "digit";
        try {
          var parsed = JSON.parse(req.postData() || "{}");
          if (parsed && parsed.ask === "cell") ask = "cell";
        } catch (e) {
          // ボディが読めなければ digit として数える(モックは常に JSON を送る)
        }
        if (ask === "cell") cellCalls += 1;
        else digitCalls += 1;
      };
      // [6] で盤面が差し替わっているので、固定問題(モックが正解を知っている盤面)に戻す
      await page.goto(mockServer.baseUrl + "/", { waitUntil: "load" });
      page.on("request", counter);
      try {
        var orderToggle = page.locator("#order-toggle");
        var orderCount = await orderToggle.count();
        if (orderCount === 0) {
          throw new Skip("順番トグルが無い(Issue #38 のフロントマージ前)");
        }
        await orderToggle.selectOption("confidence");
        await page.locator("#speed-toggle").selectOption("fast");
        await page.click("#run-btn");
        var logItem = page.locator("#round-log li").first();
        await logItem.waitFor({ state: "visible", timeout: 30000 });
        var text = await logItem.textContent();
        // assert と表示で同じ値を使う(以降もリクエストが増え続けるため、ここで固定する)
        var countedCell = cellCalls;
        var countedDigit = digitCalls;
        assert.match(text, /^1周目:/, "1行目が「1周目:」で始まらない: " + text);
        assert.match(text, /— [\d,]+ ms \/ \$/, "周回ログの行に ms / $ が出ていない: " + text);
        assert.ok(countedDigit >= TOTAL_EMPTY, "数字の判定が空マス数に満たない: " + countedDigit);
        assert.ok(
          countedCell === countedDigit || countedCell === countedDigit + 1,
          "マス選びと数字の回数が対応していない: cell=" + countedCell + " digit=" + countedDigit
        );
        await page.screenshot({ path: path.join(outDir, mode + "-07-confidence-order.png") });
        return text + " / cell=" + countedCell + " digit=" + countedDigit;
      } finally {
        page.off("request", counter);
        await page.click("#reset-btn");
        // 順番トグルは reset() をまたいで保持されるので、後続のチェックのために「左上から」に戻す
        var scanToggle = page.locator("#order-toggle");
        if ((await scanToggle.count()) > 0) await scanToggle.selectOption("scan");
      }
    });

    // [9] 一括モード(Issue #48)。順番トグルを「一括」に切り替えて最速で実行し、1周ぶんの
    // ログが出ること・/api/judge がちょうど1回(ask:"all")だけ呼ばれることを確認する。
    // モックのレート制限カウンタはスクリプト全体で共有(サーバー起動からの累計)なので、
    // ratelimit モードではここに来る前に他のチェックで既に上限(3件目)を超えていることがあり、
    // 一括の唯一の1回が429になってしまう([7] と同じ理由でこのモードでは対象外にする)。
    await runCheck(9, "一括で1周目のログが出る(/api/judge は1回)", async function () {
      if (mode === "ratelimit") {
        throw new Skip("ratelimit モードは既に上限を超えており呼び出し数を検証できない");
      }
      var judgeCalls = 0;
      var allCounter = function (req) {
        if (req.url().indexOf("/api/judge") === -1) return;
        judgeCalls += 1;
      };
      // 固定問題(モックが正解を知っている盤面)に戻す
      await page.goto(mockServer.baseUrl + "/", { waitUntil: "load" });
      page.on("request", allCounter);
      try {
        var allToggle = page.locator("#order-toggle");
        var allCount = await allToggle.count();
        if (allCount === 0) {
          throw new Skip("順番トグルに「一括」が無い(Issue #48 のフロントマージ前)");
        }
        await allToggle.selectOption("all");
        await page.locator("#speed-toggle").selectOption("fast");
        await page.click("#run-btn");
        var logItem = page.locator("#round-log li").first();
        await logItem.waitFor({ state: "visible", timeout: 30000 });
        var text = await logItem.textContent();
        var counted = judgeCalls;
        assert.match(text, /^1周目:/, "1行目が「1周目:」で始まらない: " + text);
        assert.match(text, /— [\d,]+ ms \/ \$/, "周回ログの行に ms / $ が出ていない: " + text);
        // mixed モードは1周目に不正解が出ることがあり、その場合は1周目のログが表示された
        // 直後には既に2周目ぶんの呼び出し(1回)が始まっていることがある(between-round の
        // 待ちが80msと短いため)。「1マスごとに呼んでいない(空マス数51より遥かに少ない)」
        // ことを検証できれば十分なので、上限は緩めに取る。
        // 1周1回なので、1マスごとに呼んでいれば数十回になる。mixed は 2〜3 周走るので上限は余裕を持たせる
        assert.ok(counted >= 1 && counted <= 5, "一括モードなのに /api/judge の呼び出し回数が想定と違う(1マスごとに呼んでいる?): " + counted);
        await page.screenshot({ path: path.join(outDir, mode + "-09-all-order.png") });
        return text + " / judge=" + counted;
      } finally {
        page.off("request", allCounter);
        await page.click("#reset-btn");
        // 順番トグルは reset() をまたいで保持されるので、後続のチェックのために「左上から」に戻す
        var scanToggleBack = page.locator("#order-toggle");
        if ((await scanToggleBack.count()) > 0) await scanToggleBack.selectOption("scan");
      }
    });

    // [4] ratelimit モードで停止扱い(理由が出て実行ボタンが「再開」)→ リセットで復帰
    // (Issue #43: Jev の 429/503 は一時的な失敗として停止扱いになり、エラーボックスは出ない)
    await runCheck(4, "ratelimitモードで停止扱い(理由が出て実行ボタンが「再開」)→リセットで復帰", async function () {
      if (mode !== "ratelimit") throw new Skip("--mode ratelimit 専用");
      await page.locator("#speed-toggle").selectOption("fast");
      await page.click("#run-btn");
      var pauseReasonBox = page.locator(".pause-reason");
      await pauseReasonBox.waitFor({ state: "visible", timeout: 30000 });
      var reasonText = await pauseReasonBox.textContent();
      assert.ok(reasonText && reasonText.trim().length > 0, "停止理由が空");
      assert.equal(await page.locator("#error-box.error").count(), 0, "一時的な失敗なのにエラーボックスが出ている");
      var runLabel = (await page.locator("#run-btn").textContent() || "").trim();
      assert.equal(runLabel, "再開", "実行ボタンが「再開」になっていない: " + runLabel);
      var runDisabled = await page.locator("#run-btn").getAttribute("disabled");
      assert.equal(runDisabled, null, "停止中に実行ボタン(再開)が無効化されている");
      await page.screenshot({ path: path.join(outDir, mode + "-04-paused.png") });

      await page.click("#reset-btn");
      await page.locator(".pause-reason").waitFor({ state: "detached", timeout: 5000 });
      var runLabelAfterReset = (await page.locator("#run-btn").textContent() || "").trim();
      assert.equal(runLabelAfterReset, "実行", "リセット後の実行ボタンのラベルが戻っていない: " + runLabelAfterReset);
      await page.screenshot({ path: path.join(outDir, mode + "-04-after-reset.png") });
      return "pauseReason=\"" + reasonText + "\"";
    });

    // [8] 比較モード(GET /compare、Issue #46)。左(Jev)は通常どおり判定でき、
    // 周回ログが出ること。右(Claude)はこの E2E モックにキーを持たせていないので
    // (実キーでの疎通はオーナーのブラウザで確認する。CLAUDE.md)、即エラー表示に
    // なることを確認する(「片方がエラーで止まっても他方は続く」設計。SPEC 3章F1)。
    await runCheck(8, "/compareで実行すると左(Jev)に周回ログが出る(右はキー未設定でエラー)", async function () {
      if (mode === "ratelimit") {
        throw new Skip("ratelimit モードは3件目で429になり周を完走できない");
      }
      await page.goto(mockServer.baseUrl + "/compare", { waitUntil: "load" });
      var frames = page.locator("iframe.compare-frame");
      await frames.first().waitFor({ state: "attached", timeout: 10000 });
      assert.equal(await frames.count(), 2, "iframe が2枚ない");

      // 既定は「じっくり確認」(700ms+150ms/マス)で51マスに時間がかかりすぎるため、
      // 「最速」に切り替えてから実行する(両 iframe に setSpeed が飛ぶ)。
      await page.locator("#speed-toggle button", { hasText: "最速" }).click();
      await page.click("#compare-run-btn");

      var jevFrame = page.frameLocator("iframe.compare-frame").nth(0);
      var jevLog = jevFrame.locator("#round-log li").first();
      await jevLog.waitFor({ state: "visible", timeout: 30000 });
      var jevText = await jevLog.textContent();
      assert.match(jevText, /^1周目:/, "左(Jev)の1行目が「1周目:」で始まらない: " + jevText);
      assert.match(jevText, /— [\d,]+ ms \/ \$/, "左(Jev)の周回ログの行に ms / $ が出ていない: " + jevText);

      var claudeFrame = page.frameLocator("iframe.compare-frame").nth(1);
      var claudeError = claudeFrame.locator("#error-box.error");
      await claudeError.waitFor({ state: "visible", timeout: 15000 });
      var claudeMessage = await claudeError.textContent();
      assert.ok(claudeMessage && claudeMessage.trim().length > 0, "右(Claude)のエラーメッセージが空");

      await page.screenshot({ path: path.join(outDir, mode + "-08-compare.png") });
      return "jev=\"" + jevText + "\" / claude-error=\"" + claudeMessage + "\"";
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
  var browser = await chromium.launch(launchOptions(executablePath));
  var page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
    // TLS を差し替えるプロキシ経由(クラウドセッション等)では証明書エラーになるため、
    // 明示的に E2E_IGNORE_HTTPS_ERRORS=1 を指定したときだけ無視する。
    ignoreHTTPSErrors: process.env.E2E_IGNORE_HTTPS_ERRORS === "1",
  });
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
      assert.equal(headers["content-security-policy"], "frame-ancestors 'self'", "Content-Security-Policy が無い/違う");
      return "ok";
    });

    await page.screenshot({ path: path.join(outDir, "prod-01-initial.png") });

    await runCheck("R", "最速で実行→3マス目の色付けでリセット(最大3判定)", async function () {
      await page.locator("#speed-toggle").selectOption("fast");
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
