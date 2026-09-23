// フロントエンド(PAGE_HTML)のテスト(docs/DESIGN.md 4章・10章、Issue #3)。
// 実際のブラウザ DOM は使わず、GET / のレスポンステキストを検査する。
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";

import worker from "../src/index.js";
import { GIVEN, ANSWER_KEY, makeEnv } from "./helpers.js";

async function getPageHtml() {
  var env = makeEnv();
  var res = await worker.fetch(new Request("https://example.com/"), env);
  assert.equal(res.status, 200);
  return res.text();
}

/**
 * <script> の中身(ブラウザ用の生の JS ソース)だけを取り出す。
 * PAGE_HTML はテンプレートリテラルなので、ここで得られるテキストは
 * ブラウザが実際に読み込む JS ソースそのもの(エスケープは解決済み)。
 */
function extractScript(html) {
  var m = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(m, "<script> タグが見つからない");
  return m[1];
}

/**
 * 名前付き関数宣言(`function <name>(...) { ... }`)のソースを、
 * 波括弧の対応を数えて丸ごと抜き出す。文字列中に波括弧を含まない
 * 単純な関数(buildSnapshot / formatRoundSummary)にだけ使う。
 */
function extractFunctionSource(scriptText, name) {
  var marker = "function " + name + "(";
  var start = scriptText.indexOf(marker);
  assert.ok(start >= 0, "関数が見つからない: " + name);
  var braceStart = scriptText.indexOf("{", start);
  assert.ok(braceStart >= 0, "関数の開き波括弧が見つからない: " + name);
  var depth = 0;
  for (var i = braceStart; i < scriptText.length; i++) {
    var ch = scriptText[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return scriptText.slice(start, i + 1);
    }
  }
  throw new Error("関数の閉じ波括弧が見つからない: " + name);
}

/**
 * 行コメントを落とす(ソース上の出現順を検査するとき、説明コメントに書いた
 * 関数名を実際の呼び出しと取り違えないようにするため)。URL のような "//" を
 * 含む文字列リテラルがある関数には使わない。
 */
function stripLineComments(text) {
  return text
    .split("\n")
    .map(function (line) {
      var i = line.indexOf("//");
      return i >= 0 ? line.slice(0, i) : line;
    })
    .join("\n");
}

/** Map ベースの localStorage モック(集計ビューのテスト用)。 */
function makeLocalStorage() {
  var store = new Map();
  return {
    getItem: function (key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem: function (key, value) {
      store.set(key, String(value));
    },
    removeItem: function (key) {
      store.delete(key);
    },
    clear: function () {
      store.clear();
    },
  };
}

/** getItem / setItem のたびに必ず例外を投げる localStorage モック。 */
function makeThrowingLocalStorage() {
  return {
    getItem: function () {
      throw new Error("localStorage が使えない環境を模す");
    },
    setItem: function () {
      throw new Error("localStorage が使えない環境を模す");
    },
    removeItem: function () {
      throw new Error("localStorage が使えない環境を模す");
    },
  };
}

/**
 * <script> の中身を node:vm で丸ごと評価し、そのコンテキスト(= ブラウザで言う
 * グローバル)を返す。スクリプト直下の `var` / 関数宣言はコンテキストのプロパティに
 * なるので、`ctx.generatePuzzle` / `ctx.GIVEN` のように取り出して呼べる。
 *
 * ブラウザの代わりに与えるのは最低限:
 * - document: render() が触る #app、周回ログの querySelector(常に null)、
 *   エクスポート(`<a download>`)用の createElement / body.appendChild / removeChild。
 *   opts.document で丸ごと差し替えられる(比較シェルの iframe / querySelectorAll を
 *   検査するテスト用。Issue #46 X4)
 * - setTimeout: 待ち時間を無視して即座に実行する(テストを速く・決定的にする)
 * - fetch: 呼び出しを記録するスタブ(既定では呼ばれたら失敗させる)
 * - localStorage: 既定では makeLocalStorage()(Map ベース)。opts.localStorage で
 *   差し替えられる(未指定 = undefined を渡すテストは「localStorage が無い環境」)
 * - confirm / Blob / URL: 「記録を消す」「JSONエクスポート」用の最小スタブ
 * - location: 既定 { pathname: "/", search: "", origin: "https://example.com" }。
 *   opts.location で差し替えられる(URL パラメータ・/compare のテスト用。Issue #46)
 * - window: 既定は自分自身が parent の自己参照オブジェクト(トップレベルページを模す。
 *   postStatus() が window.parent === window のとき何もしないため)。opts.window で
 *   差し替えられる(embed の message 受信・比較シェルの status 受信のテスト用)
 */
function defaultWindow() {
  var win = {
    addEventListener: function () {},
    postMessage: function () {},
  };
  win.parent = win;
  return win;
}
function runScript(html, options) {
  var opts = options || {};
  var app = { innerHTML: "" };
  var bodyChildren = [];
  var createdBlobs = [];
  // 呼ばれた setTimeout の delay 引数を記録する(速度モード(#32 T5)や、停止/再開の
  // 振る舞いテスト(#32 T3)がタイマーの発火タイミングそのものを制御したいときに使う)。
  // opts.setTimeout が無ければ従来どおり setImmediate で即座に(delay を無視して)実行する。
  var setTimeoutCalls = [];
  // startElapsedTicker()(Issue #84)の setInterval/clearInterval。テストは自動で
  // 定期実行させず(vm を無限に回さない)、intervalRegistry から手動で1回ぶんの fn を
  // 呼んでティックをシミュレートする。id は setInterval の戻り値をそのまま使う。
  var intervalRegistry = {};
  var nextIntervalId = 1;
  var defaultDocument = {
    getElementById: function (id) {
      return id === "app" ? app : null;
    },
    querySelector: function () {
      return null;
    },
    querySelectorAll: function () {
      return [];
    },
    createElement: function (tag) {
      return { tagName: tag, href: "", download: "", click: function () {} };
    },
    body: {
      appendChild: function (el) {
        bodyChildren.push(el);
      },
      removeChild: function (el) {
        var idx = bodyChildren.indexOf(el);
        if (idx >= 0) bodyChildren.splice(idx, 1);
      },
    },
  };
  var context = {
    console: console,
    document: opts.document || defaultDocument,
    location: opts.location || { pathname: "/", search: "", origin: "https://example.com" },
    window: opts.window || defaultWindow(),
    setTimeout: function (fn, delay) {
      setTimeoutCalls.push(delay);
      if (opts.setTimeout) return opts.setTimeout(fn, delay);
      return setImmediate(fn);
    },
    setInterval: function (fn, delay) {
      var id = nextIntervalId++;
      intervalRegistry[id] = { fn: fn, delay: delay };
      return id;
    },
    clearInterval: function (id) {
      delete intervalRegistry[id];
    },
    // focusNext() がリクエストごとに new AbortController() する(Issue #19)。
    // vm のコンテキストには Node のグローバルが自動では見えないので明示的に渡す。
    AbortController: AbortController,
    fetch:
      opts.fetch ||
      function () {
        throw new Error("fetch を呼ばない想定のテストで fetch が呼ばれた");
      },
    localStorage: Object.prototype.hasOwnProperty.call(opts, "localStorage") ? opts.localStorage : makeLocalStorage(),
    confirm: opts.confirm || function () { return true; },
    Blob:
      opts.Blob ||
      function (parts, blobOptions) {
        var blob = { parts: parts, options: blobOptions };
        createdBlobs.push(blob);
        return blob;
      },
    URL: opts.URL || {
      createObjectURL: function (blob) {
        return "blob:mock/" + createdBlobs.indexOf(blob);
      },
      revokeObjectURL: function () {},
    },
  };
  vm.createContext(context);
  vm.runInContext(extractScript(html), context);
  // opts.document があるとき(比較シェルのテストなど)は、その document 自身の
  // getElementById("app") から appElement を取る(ローカル変数 app とは別物のため)。
  context.appElement = context.document.getElementById("app") || app;
  context.bodyChildren = bodyChildren;
  context.createdBlobs = createdBlobs;
  context.setTimeoutCalls = setTimeoutCalls;
  context.intervalRegistry = intervalRegistry;
  return context;
}

/** setImmediate 1回分だけイベントループを進める。 */
function tick() {
  return new Promise(function (resolve) {
    setImmediate(resolve);
  });
}

/** cond() が true になるまで(上限つきで)イベントループを回す。 */
async function waitFor(cond, label) {
  for (var i = 0; i < 100000; i++) {
    if (cond()) return;
    await tick();
  }
  throw new Error("待っても条件が満たされなかった: " + label);
}

/** 9行の文字列配列が数独として正しい完成盤か(行・列・箱に1〜9が1回ずつ)。 */
function assertSolvedGrid(grid, label) {
  assert.equal(grid.length, 9, label + ": 9行でない");
  var expected = "123456789";
  function sorted(chars) {
    return chars.slice().sort().join("");
  }
  for (var r = 0; r < 9; r++) {
    assert.equal(grid[r].length, 9, label + ": " + r + "行目が9文字でない");
    assert.equal(sorted(grid[r].split("")), expected, label + ": " + r + "行目に1〜9が揃っていない");
  }
  for (var c = 0; c < 9; c++) {
    var col = [];
    for (var r2 = 0; r2 < 9; r2++) col.push(grid[r2][c]);
    assert.equal(sorted(col), expected, label + ": " + c + "列目に1〜9が揃っていない");
  }
  for (var b = 0; b < 9; b++) {
    var box = [];
    var baseR = ((b / 3) | 0) * 3;
    var baseC = (b % 3) * 3;
    for (var dr = 0; dr < 3; dr++) {
      for (var dc = 0; dc < 3; dc++) box.push(grid[baseR + dr][baseC + dc]);
    }
    assert.equal(sorted(box), expected, label + ": 箱" + b + "に1〜9が揃っていない");
  }
}

/**
 * node:vm のコンテキストで作られた配列は host とは別レルダムの Array なので、
 * assert.deepEqual(= deepStrictEqual)がプロトタイプ違いで落ちる。
 * 中身(文字列)だけを host 側の配列に移し替えてから比べる。
 */
function hostRows(grid) {
  return Array.prototype.slice.call(grid).map(String);
}

/** 空マスの座標を "r-c" の配列で返す(順序は行優先)。 */
function emptyKeys(grid) {
  var keys = [];
  for (var r = 0; r < 9; r++) {
    for (var c = 0; c < 9; c++) {
      if (grid[r][c] === ".") keys.push(r + "-" + c);
    }
  }
  return keys;
}

/** 埋まっているマスの数。 */
function countFilled(grid) {
  var filled = 0;
  for (var r = 0; r < 9; r++) {
    for (var c = 0; c < 9; c++) {
      if (grid[r][c] !== ".") filled++;
    }
  }
  return filled;
}

test("GET / は判定ループが依存するDOMフック一式と /api/judge を含む", async () => {
  var html = await getPageHtml();

  // グリッド・ボタン・速度トグル・エラーボックス
  assert.ok(html.includes('id=\\"grid\\"'), "グリッドの id が無い");
  assert.ok(html.includes('id=\\"run-btn\\"'), "実行ボタンの id が無い");
  assert.ok(html.includes('id=\\"reset-btn\\"'), "リセットボタンの id が無い");
  assert.ok(html.includes('id=\\"speed-toggle\\"'), "速度トグルの id が無い");
  assert.ok(html.includes('id=\\"difficulty-toggle\\"'), "難易度トグルの id が無い");
  assert.ok(html.includes('id=\\"error-box\\"'), "エラーボックスの id が無い");
  assert.ok(html.includes('id=\\"stats\\"'), "統計カードの id が無い");
  assert.ok(html.includes('id=\\"current-panel\\"'), "現在の判定パネルの id が無い");
  assert.ok(html.includes('id=\\"round-log\\"'), "周回ログの id が無い");
  assert.ok(html.includes('id=\\"completion-banner\\"'), "完了バナーの id が無い");

  // API呼び出し先
  assert.ok(html.includes("/api/judge"), "/api/judge への言及が無い");

  assert.ok(html.includes("数独キャリブレーションチェック"));
  assert.ok(html.includes("var GIVEN ="));
});

test("GET / の <script> は GIVEN と SOLUTION を DESIGN 5章どおりに定義する", async () => {
  var html = await getPageHtml();
  var script = extractScript(html);

  var givenMatch = script.match(/var GIVEN = \[([^\]]*)\];/);
  var solutionMatch = script.match(/var SOLUTION = \[([^\]]*)\];/);
  assert.ok(givenMatch, "var GIVEN = [...]; が見つからない");
  assert.ok(solutionMatch, "var SOLUTION = [...]; が見つからない");

  function parseRows(arrayLiteral) {
    var rows = [];
    var re = /"([^"]*)"/g;
    var m;
    while ((m = re.exec(arrayLiteral)) !== null) rows.push(m[1]);
    return rows;
  }

  assert.deepEqual(parseRows(givenMatch[1]), GIVEN);
  assert.deepEqual(parseRows(solutionMatch[1]), ANSWER_KEY);
});

test("GET / の応答にエスケープされていない ${ が残っていない", async () => {
  var html = await getPageHtml();
  assert.ok(!html.includes("${"), "テンプレート展開が起きた、またはエスケープ漏れがある");
});

test("純粋関数 buildSnapshot: 判定対象マスだけを常に空にし、他は state.values を反映する", async () => {
  var html = await getPageHtml();
  var script = extractScript(html);
  var src = extractFunctionSource(script, "buildSnapshot");

  // GIVEN / state を自由変数として参照する関数を、テスト用の値を注入して評価する。
  // (docs/DESIGN.md 4.2: buildSnapshot() は引数を取らず GIVEN と state.focusedKey /
  //  state.values を直接参照するので、それらをクロージャ経由で与える)
  var factory = new Function(
    "GIVEN",
    "state",
    "var buildSnapshot = " + src + ";\nreturn buildSnapshot();"
  );

  // row0: "53..7...." → col2, col3 が空マス。target は row0,col2。
  // col3 には「前の周の推測」を入れておき、それは残ることを確認する。
  // target 自身(row0,col2)にも古い推測を入れておき、それでも "." になることを確認する
  // (アンカリング回避。対象マスは常に送信時に空にする)。
  var testState = {
    focusedKey: "0-2",
    values: {
      "0-2": { value: "6", status: "incorrect" },
      "0-3": { value: "9", status: "incorrect" },
      "8-8": { value: "9", status: "correct" },
    },
  };

  var snapshot = factory(GIVEN, testState);

  assert.equal(snapshot.length, 9);
  assert.equal(snapshot[0][2], ".", "判定対象のマスは . でなければならない(前回の推測があっても)");
  assert.equal(snapshot[0][3], "9", "対象以外の過去の推測(不正解含む)は残る");
  assert.equal(snapshot[8][8], "9", "対象以外の過去の推測(正解)も残る");
  // 与えられたマスはそのまま
  assert.equal(snapshot[0][0], "5");
  assert.equal(snapshot[0][1], "3");
  assert.equal(snapshot[0][4], "7");
  // 何も判定していない空マスは "."
  assert.equal(snapshot[1][2], ".");

  // GIVEN 自体はどの行も書き換えられていない(givenの列はGIVENのまま)
  for (var r = 0; r < 9; r++) {
    for (var c = 0; c < 9; c++) {
      if (GIVEN[r][c] !== ".") assert.equal(snapshot[r][c], GIVEN[r][c]);
    }
  }
});

test("純粋関数 buildSnapshot: 対象マス以外に何も埋まっていなければ全て空マスのまま", async () => {
  var html = await getPageHtml();
  var script = extractScript(html);
  var src = extractFunctionSource(script, "buildSnapshot");
  var factory = new Function("GIVEN", "state", "var buildSnapshot = " + src + ";\nreturn buildSnapshot();");

  var snapshot = factory(GIVEN, { focusedKey: "4-4", values: {} });
  assert.deepEqual(snapshot, GIVEN); // GIVEN はすでにすべての未確定マスが "." なので一致するはず
});

test("純粋関数 formatRoundSummary: 「N周目: M中K正解 (P%)」を組み立てる", async () => {
  var html = await getPageHtml();
  var script = extractScript(html);
  var src = extractFunctionSource(script, "formatRoundSummary");
  var formatRoundSummary = new Function("return (" + src + ");")();

  assert.equal(formatRoundSummary(1, 45, 51), "1周目: 51中45正解 (88%)");
  assert.equal(formatRoundSummary(2, 6, 6), "2周目: 6中6正解 (100%)");
  assert.equal(formatRoundSummary(3, 0, 5), "3周目: 5中0正解 (0%)");
  // 分母0(対象0件の周)を割り算エラーなく扱えること
  assert.equal(formatRoundSummary(5, 0, 0), "5周目: 0中0正解 (0%)");
});

test("純粋関数 nextQueue: 不正解マスをそのまま次の周の対象にし、元の配列と共有しない", async () => {
  var html = await getPageHtml();
  var script = extractScript(html);
  var src = extractFunctionSource(script, "nextQueue");
  var nextQueue = new Function("return (" + src + ");")();

  var roundWrong = [{ r: 0, c: 2 }, { r: 4, c: 4 }];
  var next = nextQueue(roundWrong);
  assert.deepEqual(next, [{ r: 0, c: 2 }, { r: 4, c: 4 }]);
  assert.notEqual(next, roundWrong, "同じ配列を使い回すと roundWrong = [] で次の周の対象が消える");
  assert.notEqual(next[0], roundWrong[0], "要素も共有しない");
  assert.deepEqual(nextQueue([]), []);

  // 元の配列を空にしても、取り出した queue は影響を受けない(finalizeRound の順序に依存しない)
  roundWrong.length = 0;
  assert.equal(next.length, 2);
});

test("純粋関数 shouldStop: 不正解0なら solved、上限に達したら limit、それ以外は continue", async () => {
  var html = await getPageHtml();
  var script = extractScript(html);
  var maxMatch = script.match(/var MAX_ROUNDS = (\d+);/);
  assert.ok(maxMatch, "var MAX_ROUNDS = <数値>; が見つからない");
  var maxRounds = Number(maxMatch[1]);
  assert.equal(maxRounds, 15, "安全弁は15周(SPEC F3)");

  var src = extractFunctionSource(script, "shouldStop");
  // MAX_ROUNDS は自由変数なのでクロージャで注入する(buildSnapshot と同じやり方)
  var shouldStop = new Function("MAX_ROUNDS", "var shouldStop = " + src + ";\nreturn shouldStop;")(maxRounds);

  assert.equal(shouldStop(1, 0), "solved");
  assert.equal(shouldStop(15, 0), "solved", "上限の周でも全問正解なら完了が優先される");
  assert.equal(shouldStop(1, 6), "continue");
  assert.equal(shouldStop(14, 1), "continue");
  assert.equal(shouldStop(15, 1), "limit");
  assert.equal(shouldStop(16, 1), "limit");
});

test("focusCellForDigit は判定を投げる前に state.focusedKey を立てる(対象マスを空にして送る)", async () => {
  // 1マスの数字判定は focusCellForDigit(cell, token) が担う(Issue #38。focusNext は
  // scan モードでそのまま、confidence モードでは selectNextCell 経由でここに渡す)。
  var html = await getPageHtml();
  var script = extractScript(html);
  var src = stripLineComments(extractFunctionSource(script, "focusCellForDigit"));

  var focusAssign = src.indexOf("state.focusedKey =");
  var judgeCall = src.indexOf("judgeCell(");
  assert.ok(focusAssign >= 0, "state.focusedKey への代入が無い");
  assert.ok(judgeCall >= 0, "judgeCell( の呼び出しが無い");
  assert.ok(
    focusAssign < judgeCall,
    "state.focusedKey の代入が judgeCell( より後ろにあると、対象マスの前回の推測を送ってしまう"
  );

  // buildSnapshot() は judgeCell の中で呼ばれる(= フォーカス確定後)
  assert.ok(!/buildSnapshot\(\)/.test(src.slice(0, focusAssign)), "フォーカス確定前に buildSnapshot() を呼んでいる");
  var judgeSrc = extractFunctionSource(script, "judgeCell");
  assert.ok(judgeSrc.includes("buildSnapshot()"), "judgeCell が buildSnapshot() を使っていない");

  // focusNext() は scan モードで、queue から取り出したセルをそのまま focusCellForDigit に渡す
  var focusNextSrc = extractFunctionSource(script, "focusNext");
  assert.ok(focusNextSrc.includes("focusCellForDigit("), "focusNext が focusCellForDigit を呼んでいない");
});

test("実行世代トークン: runToken を定義し、reset と showError が進める", async () => {
  var html = await getPageHtml();
  var script = extractScript(html);

  assert.ok(/var runToken = 0;/.test(script), "var runToken = 0; が無い");

  var resetSrc = extractFunctionSource(script, "reset");
  assert.ok(/runToken \+= 1;|runToken\+\+/.test(resetSrc), "reset() が runToken を進めていない");

  var showErrorSrc = extractFunctionSource(script, "showError");
  assert.ok(/runToken \+= 1;|runToken\+\+/.test(showErrorSrc), "showError() が runToken を進めていない");
});

test("純粋関数 isCurrent: 実行中かつ同じ世代のときだけ true", async () => {
  var html = await getPageHtml();
  var script = extractScript(html);
  var src = extractFunctionSource(script, "isCurrent");
  function make(running, current) {
    return new Function("state", "runToken", "var isCurrent = " + src + ";\nreturn isCurrent;")({ running: running }, current);
  }
  assert.equal(make(true, 3)(3), true);
  assert.equal(make(true, 4)(3), false, "リセット後の古い世代は続行してはいけない");
  assert.equal(make(false, 3)(3), false, "停止中は続行してはいけない");
});

test("focusNext / focusCellForDigit / finalizeRound の非同期コールバックはすべて世代トークンで守られている", async () => {
  var html = await getPageHtml();
  var script = extractScript(html);

  var focusSrc = extractFunctionSource(script, "focusNext");
  assert.ok(/var token = runToken;/.test(focusSrc), "focusNext が世代を捕まえていない");

  // 数字判定の非同期コールバック(then 成功・then 失敗・commit前 setTimeout・commit後
  // setTimeout の4か所)は focusCellForDigit にある(Issue #38 で focusNext から分離)。
  var digitSrc = extractFunctionSource(script, "focusCellForDigit");
  var guards = digitSrc.match(/if \(!isCurrent\(token\)\) return;/g) || [];
  assert.ok(guards.length >= 4, "focusCellForDigit の世代ガードが足りない: " + guards.length);
  assert.ok(!/if \(!state\.running\) return;\s*\n\s*var probs/.test(digitSrc), "state.running だけのチェックが残っている");
  // setTimeout のコールバックは必ず先頭でガードする
  var timeoutBodies = digitSrc.match(/setTimeout\(function \(\) \{\s*([^\n]*)/g) || [];
  assert.ok(timeoutBodies.length >= 2, "setTimeout が2か所ない");
  timeoutBodies.forEach(function (body) {
    assert.ok(body.includes("if (!isCurrent(token)) return;"), "setTimeout の先頭に世代ガードが無い: " + body);
  });

  // マス選び(selectNextCell、Issue #38)も同じ流儀で世代ガードされている
  var selectSrc = extractFunctionSource(script, "selectNextCell");
  var selectGuards = selectSrc.match(/if \(!isCurrent\(token\)\) return;/g) || [];
  assert.ok(selectGuards.length >= 2, "selectNextCell の世代ガードが足りない: " + selectGuards.length);

  var finalizeSrc = extractFunctionSource(script, "finalizeRound");
  assert.ok(/var token = runToken;/.test(finalizeSrc), "finalizeRound が世代を捕まえていない");
  assert.ok(/if \(!isCurrent\(token\)\) return;/.test(finalizeSrc), "周と周の間の setTimeout に世代ガードが無い");
});

test("commitFocused はフォーカス中のマスと一致しなければ何もしない", async () => {
  var html = await getPageHtml();
  var script = extractScript(html);
  // commitFocused() 本体(記録の作成・統計)は commitJudgment() に切り出されている
  // (Issue #80。一括+最速の commitAllInstant() が同じロジックを render() を挟まず
  // 呼べるようにするための refactor)。commitFocused() 側はガードと commitJudgment()
  // 呼び出しだけを持つ。
  var src = stripLineComments(extractFunctionSource(script, "commitFocused"));

  assert.ok(/if \(!pendingCommit\) return;/.test(src), "pendingCommit が無いときの early return が無い");
  var guard = src.indexOf('if (state.focusedKey !== key) return;');
  var callCommit = src.indexOf("commitJudgment(");
  assert.ok(guard >= 0, "フォーカスとのずれを見る early return が無い");
  assert.ok(callCommit >= 0, "commitFocused が commitJudgment を呼んでいない");
  assert.ok(guard < callCommit, "ガードは commitJudgment() を呼ぶ前に置く");

  var judgmentSrc = stripLineComments(extractFunctionSource(script, "commitJudgment"));
  assert.ok(/state\.values\[key\] =/.test(judgmentSrc), "commitJudgment が state.values を書き換えていない");
});

test("開始前の「この周の進捗」は 0 / 51 と読める(roundSize の初期値が TOTAL_EMPTY)", async () => {
  var html = await getPageHtml();
  var script = extractScript(html);
  assert.ok(/var roundSize = TOTAL_EMPTY;/.test(script), "roundSize の初期値が TOTAL_EMPTY でない(0 / 0 と表示されてしまう)");
  assert.ok(/roundSize = TOTAL_EMPTY;[\s\S]*function reset\(\)/.test(script) || /function reset\(\)[\s\S]*roundSize = TOTAL_EMPTY;/.test(script), "reset() 後も TOTAL_EMPTY に戻していない");
  var resetSrc = extractFunctionSource(script, "reset");
  assert.ok(/roundSize = TOTAL_EMPTY;/.test(resetSrc), "reset() が roundSize を TOTAL_EMPTY に戻していない");
});

test("直前の判定を state.lastJudgment に残す(最速モードでも結果が見える)", async () => {
  var html = await getPageHtml();
  var script = extractScript(html);
  assert.ok(/lastJudgment: null/.test(script), "state に lastJudgment が無い");
  // lastJudgment の更新は commitJudgment() 側(commitFocused() から切り出された。Issue #80)
  var commitSrc = extractFunctionSource(script, "commitJudgment");
  assert.ok(/state\.lastJudgment = \{/.test(commitSrc), "commitJudgment が lastJudgment を更新していない");
  var panelSrc = extractFunctionSource(script, "renderCurrentPanel");
  assert.ok(/state\.lastJudgment/.test(panelSrc), "現在の判定パネルが lastJudgment を表示していない");
  var resetSrc = extractFunctionSource(script, "reset");
  assert.ok(/lastJudgment: null/.test(resetSrc), "reset() が lastJudgment を消していない");
});

test("render() は周回ログのスクロール位置を引き継ぐ", async () => {
  var html = await getPageHtml();
  var script = extractScript(html);
  var src = extractFunctionSource(script, "render");
  assert.ok(/scrollTop/.test(src), "render() がスクロール位置を扱っていない");
  var save = src.indexOf("savedScroll");
  var replace = src.indexOf("app.innerHTML");
  assert.ok(save >= 0 && save < replace, "innerHTML を置き換える前にスクロール位置を保存していない");
  assert.ok(src.lastIndexOf("scrollTop") > replace, "innerHTML 置き換え後にスクロール位置を復元していない");
});

// --- 数独ジェネレーター / ソルバー(Issue #5) ------------------------------

test("solveCount: 固定問題(Wikipedia)は一意解で、その解は既知の正解と一致する", { timeout: 10000 }, async () => {
  var ctx = runScript(await getPageHtml());

  var found = [];
  assert.equal(ctx.solveCount(GIVEN, 2, found), 1, "固定問題の解は1つだけのはず");
  assert.deepEqual(hostRows(found[0]), ANSWER_KEY);

  // limit を 1 にしても 1 で打ち切られる
  assert.equal(ctx.solveCount(GIVEN, 1), 1);

  // 完成盤そのものは当然 1 通り
  assert.equal(ctx.solveCount(ANSWER_KEY, 2), 1);

  // 空盤面は解が山ほどあるので limit で打ち切られる
  var empty = [];
  for (var i = 0; i < 9; i++) empty.push(".........");
  assert.equal(ctx.solveCount(empty, 2), 2, "limit 個見つけたら打ち切る");

  // 矛盾した盤面(同じ行に 5 が2つ)は解なし
  var broken = GIVEN.slice();
  broken[0] = "53.5.....";
  assert.equal(ctx.solveCount(broken, 2), 0);

  // 1マスだけ消した完成盤も一意解
  var oneHole = ANSWER_KEY.slice();
  oneHole[4] = "4268537.1";
  assert.equal(ctx.solveCount(oneHole, 2), 1);
});

// 空盤面だけを見る専用テスト。solveCount の早期打ち切り(if (count >= max) return;)が
// 外れると空盤面の解を数え切ろうとしてハングする。timeout により、ハングでも
// スイート全体を止めずに即座に検出できる。
test("solveCount: 空盤面は limit(2)で打ち切る(早期打ち切りが無いとハングする)", { timeout: 10000 }, async () => {
  var ctx = runScript(await getPageHtml());
  var empty = [];
  for (var i = 0; i < 9; i++) empty.push(".........");
  assert.equal(ctx.solveCount(empty, 2), 2);
});

test("generateSolvedGrid: 完成盤として正しく、毎回同じではない", { timeout: 10000 }, async () => {
  var ctx = runScript(await getPageHtml());
  var first = ctx.generateSolvedGrid();
  assertSolvedGrid(first, "generateSolvedGrid");

  var differs = false;
  for (var i = 0; i < 5; i++) {
    var next = ctx.generateSolvedGrid();
    assertSolvedGrid(next, "generateSolvedGrid #" + i);
    if (next.join("") !== first.join("")) differs = true;
  }
  assert.ok(differs, "何度生成しても同じ盤面しか出てこない(シャッフルが効いていない)");
});

test("generatePuzzle を20回: 常に一意解・解が一致・与えられた数字は既定30個ちょうど", { timeout: 10000 }, async () => {
  var ctx = runScript(await getPageHtml());
  var started = Date.now();

  for (var i = 0; i < 20; i++) {
    var puzzle = ctx.generatePuzzle(30);
    var label = "#" + i;

    assert.equal(puzzle.given.length, 9, label + ": given が9行でない");
    assert.equal(puzzle.solution.length, 9, label + ": solution が9行でない");

    // solution は数独として正しい完成盤
    assertSolvedGrid(puzzle.solution, label);

    // given は solution からマスを消しただけ(残っている数字は solution と一致する)
    for (var r = 0; r < 9; r++) {
      assert.ok(/^[1-9.]{9}$/.test(puzzle.given[r]), label + ": given の文字が不正");
      for (var c = 0; c < 9; c++) {
        if (puzzle.given[r][c] !== ".") {
          assert.equal(puzzle.given[r][c], puzzle.solution[r][c], label + ": given が solution と食い違う");
        }
      }
    }

    // 一意解であり、その解が solution と一致する
    var found = [];
    assert.equal(ctx.solveCount(puzzle.given, 2, found), 1, label + ": 解が一意でない");
    assert.deepEqual(hostRows(found[0]), hostRows(puzzle.solution), label + ": solveCount の解と solution が違う");

    var filled = countFilled(puzzle.given);
    assert.equal(filled, 30, label + ": 与えられた数字が既定の30個ちょうどでない: " + filled);
  }

  var elapsed = Date.now() - started;
  // 乱数任せなので上限は緩めに。桁違いに遅くなったら気づけるようにしておく。
  assert.ok(elapsed < 20000, "generatePuzzle 20回が遅すぎる: " + elapsed + "ms");
});

// 注意: generatePuzzle(n) は「ちょうど n 個」を保証しない。実装はランダム順にマスを
// 消していき、消せなくなった時点で打ち切る(消しすぎて一意解が崩れる場合は戻す)ので、
// MIN_TARGET_GIVENS(理論上の下限。Issue #87 で24→17に変更)は「これより減らさない」
// 下限であって、常に到達できる目標ではない。ここでは MIN_TARGET_GIVENS を大きく下回る
// 目標(10)を渡し、それでも実際のアルゴリズムの到達限界(概ね22前後)より下がらない、
// 「下限を下回らない」という実際の契約だけを検証する(=== MIN_TARGET_GIVENS は書くと
// flaky になる)。
test("generatePuzzle(MIN_TARGET_GIVENSを大きく下回る目標): 下限(MIN_TARGET_GIVENS)を下回らない", { timeout: 10000 }, async () => {
  var ctx = runScript(await getPageHtml());
  for (var i = 0; i < 20; i++) {
    var puzzle = ctx.generatePuzzle(10);
    var label = "#" + i;
    assertSolvedGrid(puzzle.solution, label);
    assert.equal(ctx.solveCount(puzzle.given, 2), 1, label + ": generatePuzzle(10) が一意解でない");
    var filled = countFilled(puzzle.given);
    assert.ok(
      filled >= ctx.MIN_TARGET_GIVENS,
      label + ": 与えられた数字が下限(MIN_TARGET_GIVENS=" + ctx.MIN_TARGET_GIVENS + ")を下回った: " + filled
    );
  }
});

test("generatePuzzle(NaN): DEFAULT_TARGET_GIVENS(30)にフォールバックする", { timeout: 10000 }, async () => {
  var ctx = runScript(await getPageHtml());
  var puzzle = ctx.generatePuzzle(NaN);
  assert.equal(
    countFilled(puzzle.given),
    30,
    "targetGivens が NaN のとき DEFAULT_TARGET_GIVENS(30) にフォールバックしていない(81ヒントの「問題」を返していないか)"
  );
});

// 難易度(SPEC F1/F4)ごとの目標ヒント数: やさしい36 / ふつう30 / むずかしい25 / 上級22
// (Issue #87)。「むずかしい」「上級」は generatePuzzle 単体(再試行なしの1回勝負)では
// 目標ちょうどには届かず、それより多いヒント数で止まることがある(PR #15 の補足、
// Issue #87 のベンチマーク。下限は MIN_TARGET_GIVENS の17)。ここでは generatePuzzle(n)
// を直接呼ぶ場合の契約だけを見る(再試行は newPuzzle() 側の generatePuzzleWithRetry。
// 別テストで検証する)。上級の上限は緩め(35)に取っている: 5000回のベンチマークで
// 目標22に対し最大29まで観測されており、27を上限にすると10回中で約5%の確率で
// flaky になる(PR #88 の Opus レビューで指摘)。
test("難易度ごとの generatePuzzle: 常に一意解・解が一致し、ヒント数がやさしい36/ふつう30ちょうど、むずかしいは25〜28、上級は22以上(概ね22〜29)", { timeout: 10000 }, async () => {
  var ctx = runScript(await getPageHtml());
  // ctx.DIFFICULTY_GIVENS は vm の別レルムのオブジェクトなので、deepStrictEqual は
  // プロトタイプ違いで落ちる(hostRows と同じ事情)。値だけを個別に比較する。
  assert.equal(ctx.DIFFICULTY_GIVENS.easy, 36, "DIFFICULTY_GIVENS.easy が仕様(36)と違う");
  assert.equal(ctx.DIFFICULTY_GIVENS.normal, 30, "DIFFICULTY_GIVENS.normal が仕様(30)と違う");
  assert.equal(ctx.DIFFICULTY_GIVENS.hard, 25, "DIFFICULTY_GIVENS.hard が仕様(25)と違う");
  assert.equal(ctx.DIFFICULTY_GIVENS.expert, 22, "DIFFICULTY_GIVENS.expert が仕様(22)と違う(Issue #87)");
  assert.equal(ctx.MIN_TARGET_GIVENS, 17, "MIN_TARGET_GIVENS が仕様(17、一意解の理論上の最小値)と違う");

  var cases = [
    { difficulty: "easy", target: ctx.DIFFICULTY_GIVENS.easy, exact: true, min: 24, max: Infinity },
    { difficulty: "normal", target: ctx.DIFFICULTY_GIVENS.normal, exact: true, min: 24, max: Infinity },
    { difficulty: "hard", target: ctx.DIFFICULTY_GIVENS.hard, exact: false, min: 25, max: 28 },
    { difficulty: "expert", target: ctx.DIFFICULTY_GIVENS.expert, exact: false, min: 22, max: 35 },
  ];

  cases.forEach(function (c) {
    for (var i = 0; i < 10; i++) {
      var label = c.difficulty + " #" + i;
      var puzzle = ctx.generatePuzzle(c.target);
      assertSolvedGrid(puzzle.solution, label);

      var found = [];
      assert.equal(ctx.solveCount(puzzle.given, 2, found), 1, label + ": 解が一意でない");
      assert.deepEqual(hostRows(found[0]), hostRows(puzzle.solution), label + ": solveCount の解と solution が違う");

      var filled = countFilled(puzzle.given);
      assert.ok(filled >= ctx.MIN_TARGET_GIVENS, label + ": 与えられた数字が下限を下回った: " + filled);
      if (c.exact) {
        assert.equal(filled, c.target, label + ": ヒント数が" + c.target + "ちょうどでない: " + filled);
      } else {
        assert.ok(filled >= c.min && filled <= c.max, label + ": ヒント数が" + c.min + "〜" + c.max + "の範囲外: " + filled);
      }
    }
  });
});

test("リセットは実行中・停止中でも押せる(SPEC F5)。生成中だけ無効化される。実行中は run-btn が「停止」、停止中は「再開」になる(Issue #32)", async () => {
  var ctx = runScript(await getPageHtml());

  function resetButtonHtml() {
    var html = ctx.renderControls();
    var m = html.match(/<button id="reset-btn"[^>]*>/);
    assert.ok(m, "reset-btn が見つからない");
    return m[0];
  }
  function runButtonHtml() {
    var html = ctx.renderControls();
    var m = html.match(/<button id="run-btn"[^>]*>[^<]*<\/button>/);
    assert.ok(m, "run-btn が見つからない");
    return m[0];
  }
  function newPuzzleButtonHtml() {
    var html = ctx.renderControls();
    var m = html.match(/<button id="new-puzzle-btn"[^>]*>/);
    assert.ok(m, "new-puzzle-btn が見つからない");
    return m[0];
  }

  // 初期状態: どれも無効化されていない。ラベルは「実行」
  assert.ok(!resetButtonHtml().includes("disabled"), "初期状態で reset-btn が無効化されている");
  assert.ok(runButtonHtml().includes(">実行<"), "初期状態で run-btn のラベルが「実行」でない: " + runButtonHtml());

  // 実行中: リセットは押せる。run-btn は無効化されず「停止」になり、stop() を呼ぶ。
  // 新しい問題は押せない(実行中の差し替えは盤面と周回ログの意味を壊すため)。
  ctx.state.running = true;
  assert.ok(!resetButtonHtml().includes("disabled"), "実行中に reset-btn が無効化されている(SPEC F5違反)");
  assert.ok(!runButtonHtml().includes("disabled"), "実行中に run-btn が無効化されている(停止できなくなる。Issue #32)");
  assert.ok(runButtonHtml().includes(">停止<"), "実行中に run-btn のラベルが「停止」でない: " + runButtonHtml());
  assert.ok(runButtonHtml().includes('onclick="stop()"'), "実行中に run-btn が stop() を呼ばない: " + runButtonHtml());
  assert.ok(newPuzzleButtonHtml().includes("disabled"), "実行中に new-puzzle-btn が無効化されていない");
  ctx.state.running = false;

  // 停止中(started 済み・running=false・done/errorMessage でない): run-btn は有効で
  // ラベルが「再開」になる。リセット・新しい問題も押せる(Issue #32)。
  ctx.started = true;
  assert.ok(!resetButtonHtml().includes("disabled"), "停止中に reset-btn が無効化されている");
  assert.ok(!runButtonHtml().includes("disabled"), "停止中に run-btn が無効化されている");
  assert.ok(runButtonHtml().includes(">再開<"), "停止中に run-btn のラベルが「再開」でない: " + runButtonHtml());
  assert.ok(runButtonHtml().includes('onclick="run()"'), "停止中に run-btn が run() を呼ばない: " + runButtonHtml());
  assert.ok(!newPuzzleButtonHtml().includes("disabled"), "停止中に new-puzzle-btn が無効化されている");
  ctx.started = false;

  // 生成中: リセットも無効化される(差し替え中の盤面と衝突するため)
  ctx.generating = true;
  assert.ok(resetButtonHtml().includes("disabled"), "生成中に reset-btn が無効化されていない");
  assert.ok(runButtonHtml().includes("disabled"), "生成中に run-btn が無効化されていない");
  assert.ok(newPuzzleButtonHtml().includes("disabled"), "生成中に new-puzzle-btn が無効化されていない");
  ctx.generating = false;
});

test("「新しい問題」ボタンがヘッダにあり、生成中・実行中は押せない", async () => {
  var html = await getPageHtml();
  assert.ok(html.includes('id=\\"new-puzzle-btn\\"'), "新しい問題ボタンの id が無い");
  assert.ok(html.includes("newPuzzle()"), "newPuzzle() の呼び出しが無い");

  var script = extractScript(html);
  var controlsSrc = extractFunctionSource(script, "renderControls");
  assert.ok(/state\.running \|\| generating/.test(controlsSrc), "実行中・生成中に無効化していない");

  var newPuzzleSrc = extractFunctionSource(script, "newPuzzle");
  assert.ok(/reset\(\)/.test(newPuzzleSrc), "newPuzzle() が reset() 相当の初期化をしていない");
  assert.ok(/GIVEN = /.test(newPuzzleSrc), "newPuzzle() が GIVEN を差し替えていない");
  assert.ok(/SOLUTION = /.test(newPuzzleSrc), "newPuzzle() が SOLUTION を差し替えていない");
  assert.ok(/TOTAL_EMPTY = /.test(newPuzzleSrc), "newPuzzle() が TOTAL_EMPTY を再計算していない");
});

test("初期表示は固定問題のまま、newPuzzle() で GIVEN / SOLUTION と派生値が差し替わる", { timeout: 10000 }, async () => {
  var ctx = runScript(await getPageHtml());

  assert.deepEqual(hostRows(ctx.GIVEN), GIVEN, "初期表示は Wikipedia の固定問題");
  assert.deepEqual(hostRows(ctx.SOLUTION), ANSWER_KEY);
  assert.equal(ctx.TOTAL_EMPTY, 51);

  ctx.newPuzzle();
  await waitFor(function () {
    return ctx.generating === false;
  }, "生成の完了");

  assert.notDeepEqual(hostRows(ctx.GIVEN), GIVEN, "GIVEN が差し替わっていない");
  assert.equal(ctx.TOTAL_EMPTY, 81 - countFilled(ctx.GIVEN), "TOTAL_EMPTY が再計算されていない");
  assert.equal(ctx.roundSize, ctx.TOTAL_EMPTY, "roundSize が新しい空マス数になっていない");
  assert.equal(ctx.solveCount(ctx.GIVEN, 2), 1, "差し替わった問題が一意解でない");

  // SOLUTION は GIVEN の唯一の解
  var found = [];
  ctx.solveCount(ctx.GIVEN, 2, found);
  assert.deepEqual(hostRows(found[0]), hostRows(ctx.SOLUTION));

  // 周回・統計は初期化されている
  assert.equal(ctx.state.round, 1);
  assert.deepEqual(Object.keys(ctx.state.values), []);
  assert.equal(ctx.state.roundLog.length, 0);
  assert.equal(ctx.state.running, false);
  assert.equal(ctx.state.done, false);
});

test("難易度トグルの描画: 選択中の <option> だけに selected が付き、setDifficulty() で state.difficulty が変わり reset() 後も維持される(Issue #76 でプルダウン化)", async () => {
  var ctx = runScript(await getPageHtml());

  function difficultySelectHtml() {
    var html = ctx.renderControls();
    var m = html.match(/<select id="difficulty-toggle"[^>]*>[\s\S]*?<\/select>/);
    assert.ok(m, "difficulty-toggle が見つからない");
    return m[0];
  }
  function selectedLabels(html) {
    var re = /<option value="[a-z]+" selected>([^<]*)<\/option>/g;
    var labels = [];
    var m;
    while ((m = re.exec(html)) !== null) labels.push(m[1]);
    return labels;
  }
  function selectedState(html, label) {
    var re = new RegExp('<option value="[a-z]+"( selected)?>' + label + "</option>");
    var m = html.match(re);
    assert.ok(m, label + " の <option> が見つからない");
    return m[1] === " selected";
  }

  // 既定は「ふつう」(normal)
  assert.equal(ctx.state.difficulty, "normal", "既定の難易度が normal でない");
  var html0 = difficultySelectHtml();
  assert.deepEqual(selectedLabels(html0), ["ふつう"], "既定でふつうだけが selected になっていない");
  assert.equal(selectedState(html0, "ふつう"), true);
  assert.equal(selectedState(html0, "やさしい"), false);
  assert.equal(selectedState(html0, "むずかしい"), false);

  // setDifficulty('hard') で切り替わる
  ctx.setDifficulty("hard");
  assert.equal(ctx.state.difficulty, "hard");
  var html1 = difficultySelectHtml();
  assert.deepEqual(selectedLabels(html1), ["むずかしい"], "hard 選択後にむずかしいだけが selected になっていない");
  assert.equal(selectedState(html1, "むずかしい"), true);
  assert.equal(selectedState(html1, "ふつう"), false);

  // reset() しても難易度は維持される(speedMode と同じ扱い。DESIGN 4.1)
  ctx.reset();
  assert.equal(ctx.state.difficulty, "hard", "reset() 後に難易度が維持されていない");
});

test("newPuzzle() は state.difficulty に応じたヒント数で生成する(hard: 25〜28 / expert: 22〜27 / easy: 36)", { timeout: 10000 }, async () => {
  var ctx = runScript(await getPageHtml());

  ctx.setDifficulty("hard");
  ctx.newPuzzle();
  await waitFor(function () {
    return ctx.generating === false;
  }, "hard 生成の完了");
  var hardFilled = countFilled(ctx.GIVEN);
  assert.ok(hardFilled >= 25 && hardFilled <= 28, "hard で生成したヒント数が25〜28の範囲外: " + hardFilled);
  assert.equal(ctx.solveCount(ctx.GIVEN, 2), 1, "hard で生成した問題が一意解でない");

  ctx.setDifficulty("expert");
  ctx.newPuzzle();
  await waitFor(function () {
    return ctx.generating === false;
  }, "expert 生成の完了");
  var expertFilled = countFilled(ctx.GIVEN);
  assert.ok(expertFilled >= 22 && expertFilled <= 27, "expert で生成したヒント数が22〜27の範囲外: " + expertFilled);
  assert.equal(ctx.solveCount(ctx.GIVEN, 2), 1, "expert で生成した問題が一意解でない");

  ctx.setDifficulty("easy");
  ctx.newPuzzle();
  await waitFor(function () {
    return ctx.generating === false;
  }, "easy 生成の完了");
  var easyFilled = countFilled(ctx.GIVEN);
  assert.equal(easyFilled, 36, "easy で生成したヒント数が36ちょうどでない: " + easyFilled);
  assert.equal(ctx.solveCount(ctx.GIVEN, 2), 1, "easy で生成した問題が一意解でない");
});

test("難易度を変えただけでは盤面は変わらない(次の newPuzzle() から効く)", { timeout: 10000 }, async () => {
  var ctx = runScript(await getPageHtml());
  var beforeGiven = hostRows(ctx.GIVEN);

  ctx.setDifficulty("hard");
  assert.deepEqual(hostRows(ctx.GIVEN), beforeGiven, "setDifficulty() だけで盤面が変わってしまっている");
});

test("newPuzzle() の生成時間: むずかしいを10回で2秒以内", { timeout: 10000 }, async () => {
  var ctx = runScript(await getPageHtml());
  ctx.setDifficulty("hard");

  var started = Date.now();
  for (var i = 0; i < 10; i++) {
    ctx.newPuzzle();
    await waitFor(function () {
      return ctx.generating === false;
    }, "hard 生成 #" + i + " の完了");
  }
  var elapsed = Date.now() - started;
  assert.ok(elapsed < 2000, "hard を10回生成するのに2秒を超えた: " + elapsed + "ms");
});

test("newPuzzle() の生成時間: 上級を10回で12秒以内(Issue #87。この node:vm ハーネス経由の実測は2.5〜3.6秒程度だが、CI ランナーが遅い場合や他テストとの並行実行を見込んで余裕を持たせた上限。ブラウザ実機では1回あたり平均60ms・最悪150ms程度、docs/DESIGN.md 5章)", { timeout: 20000 }, async () => {
  var ctx = runScript(await getPageHtml());
  ctx.setDifficulty("expert");

  var started = Date.now();
  for (var i = 0; i < 10; i++) {
    ctx.newPuzzle();
    await waitFor(function () {
      return ctx.generating === false;
    }, "expert 生成 #" + i + " の完了");
  }
  var elapsed = Date.now() - started;
  assert.ok(elapsed < 12000, "expert を10回生成するのに12秒を超えた: " + elapsed + "ms");
});

test("「新しい問題」の後に run() すると、新しい GIVEN の空マス数だけ /api/judge を呼ぶ", { timeout: 10000 }, async () => {
  var calls = [];
  var ctx;
  var fetchStub = async function (url, init) {
    var body = JSON.parse(init.body);
    calls.push({ url: url, body: body });
    // 正解をそのまま返す ⇒ 1周で全マス正解になり、fetch 回数 = 空マス数になる
    var digit = ctx.SOLUTION[body.target.row][body.target.col];
    var probabilities = {};
    for (var d = 1; d <= 9; d++) probabilities[String(d)] = String(d) === digit ? 0.9 : 0.0125;
    return {
      ok: true,
      json: async function () {
        return { probabilities: probabilities, choice: digit, confidence: 0.5 };
      },
    };
  };

  ctx = runScript(await getPageHtml(), { fetch: fetchStub });
  // このテストは「puzzle と target だけが載ること」を検証するので、消去法(Issue #61・#63)の
  // exclude が混ざらないよう両トグルを切っておく(exclude 自体のテストは AB 系で行う)。
  ctx.setHistoryMode(false);
  ctx.setRuleMode(false);

  ctx.newPuzzle();
  await waitFor(function () {
    return ctx.generating === false;
  }, "生成の完了");

  var expectedKeys = emptyKeys(ctx.GIVEN);
  assert.equal(expectedKeys.length, ctx.TOTAL_EMPTY);
  // 空マスの「数」は固定問題と同じ51になることがある(生成は30ヒント固定)ので、
  // どのマスを聞いたかまで見る。
  assert.notDeepEqual(expectedKeys, emptyKeys(GIVEN), "空マスの位置が固定問題と同じでは検証にならない");

  ctx.run();
  await waitFor(function () {
    return ctx.state.done === true;
  }, "1周での完了");

  assert.equal(calls.length, expectedKeys.length, "fetch 回数が新しい GIVEN の空マス数と一致しない");
  assert.deepEqual(
    calls.map(function (call) {
      return call.body.target.row + "-" + call.body.target.col;
    }),
    expectedKeys,
    "聞いたマスが新しい GIVEN の空マス(行優先)と一致しない"
  );
  assert.equal(ctx.state.roundsToSolve, 1, "全部正解を返したので1周で終わるはず");
  assert.equal(ctx.state.roundLog.length, 1);

  // 送った盤面はすべて新しい GIVEN と矛盾せず、対象マスは必ず空
  for (var i = 0; i < calls.length; i++) {
    var body = calls[i].body;
    assert.equal(calls[i].url, "/api/judge");
    assert.equal(body.puzzle[body.target.row][body.target.col], ".", "対象マスが空でない");
    assert.equal(ctx.GIVEN[body.target.row][body.target.col], ".", "given のマスを聞いている");
  }

  // リクエストに載るのは puzzle と target だけ(正解表そのものを別キーで送っていない)。
  // 「盤面の中身が SOLUTION と一致しないこと」は検証できない点に注意: このスタブは常に
  // 正解を返すので、周の後半のスナップショットは正解表とほぼ同じ見た目になる。それは
  // 「過去の周の推測を残して送る」設計どおりの姿であって、リークではない。
  for (var j = 0; j < calls.length; j++) {
    assert.deepEqual(Object.keys(calls[j].body).sort(), ["puzzle", "target"]);
    assert.deepEqual(Object.keys(calls[j].body.target).sort(), ["col", "row"]);
  }
});

// -------------------------------------------------------------------
// 集計ビュー: 記録の localStorage 蓄積(SPEC F1 拡張2、Issue #6)
// -------------------------------------------------------------------
var RECORDS_STORAGE_KEY = "scc.records.v1";

/**
 * loadRecords() は { ok, records } を返す(PR #25 レビュー指摘 should-fix 1)。
 * records は vm コンテキストの Array(別レルム)なので deepStrictEqual は使わず、
 * 長さだけを見る。
 */
function assertEmptyRecords(ctx, message) {
  assert.equal(ctx.loadRecords().records.length, 0, message);
}

test("loadRecords/saveRecords/appendRecord: 素朴な往復", async () => {
  var ctx = runScript(await getPageHtml());
  assertEmptyRecords(ctx);

  ctx.appendRecord({ t: 1, p: "abc", r: 0, c: 0, round: 1, choice: "4", pc: 0.6, conf: 0.3, ok: true });
  var loaded = ctx.loadRecords();
  assert.equal(loaded.ok, true);
  var records = loaded.records;
  assert.equal(records.length, 1);
  assert.equal(records[0].choice, "4");
  assert.equal(records[0].ok, true);
});

test("RECORDS_MAX は既定で5000", async () => {
  var ctx = runScript(await getPageHtml());
  assert.equal(ctx.RECORDS_MAX, 5000);
});

test("appendRecord: 上限を超えたら最古が捨てられ、上限件数のまま保たれる", async () => {
  // RECORDS_MAX(既定5000)そのものは上のテストで担保済み。ここは ctx.RECORDS_MAX を
  // 5 に差し替えて境界だけを検証する(5,001件のループを回すと12秒近くかかっていた。
  // PR #25 レビュー指摘 should-fix 3)。
  var ctx = runScript(await getPageHtml());
  ctx.RECORDS_MAX = 5;
  for (var i = 1; i <= 6; i++) {
    ctx.appendRecord({ t: i, p: "p", r: 0, c: 0, round: 1, choice: "1", pc: 0.5, conf: 0.5, ok: true });
  }
  var records = ctx.loadRecords().records;
  assert.equal(records.length, 5, "上限5件を超えている");
  assert.equal(records[0].t, 2, "最古(t=1)が捨てられていない");
  assert.equal(records[records.length - 1].t, 6);
});

test("loadRecords: localStorage が無い環境では ok:false・空配列を返す(appendRecordは保存せず捨てる)", async () => {
  var ctx = runScript(await getPageHtml(), { localStorage: undefined });
  assert.equal(ctx.loadRecords().ok, false);
  assertEmptyRecords(ctx);
  // appendRecord / saveRecords も例外を出さない
  assert.doesNotThrow(function () {
    ctx.appendRecord({ t: 1, p: "x", r: 0, c: 0, round: 1, choice: "1", pc: 0.1, conf: 0.1, ok: false });
  });
  assertEmptyRecords(ctx);
});

test("loadRecords: localStorage が例外を投げたら ok:false・空配列を返す(appendRecordは保存せず捨てる)", async () => {
  var ctx = runScript(await getPageHtml(), { localStorage: makeThrowingLocalStorage() });
  assert.equal(ctx.loadRecords().ok, false);
  assertEmptyRecords(ctx);
  assert.doesNotThrow(function () {
    ctx.appendRecord({ t: 1, p: "x", r: 0, c: 0, round: 1, choice: "1", pc: 0.1, conf: 0.1, ok: false });
  });
});

test("loadRecords: 壊れたJSONが入っていても ok:true・空配列で作り直し、元の文字列を退避キーに残す", async () => {
  var storage = makeLocalStorage();
  var broken = "{not valid json";
  storage.setItem(RECORDS_STORAGE_KEY, broken);
  var ctx = runScript(await getPageHtml(), { localStorage: storage });
  var loaded = ctx.loadRecords();
  assert.equal(loaded.ok, true, "壊れたJSONは読み取り失敗ではなく、空で作り直してよい");
  assert.equal(loaded.records.length, 0);
  assert.equal(storage.getItem(RECORDS_STORAGE_KEY + ".broken"), broken, "壊れた元の文字列が退避キーに入っていない");
});

test("loadRecords: 配列でないJSON({\"a\":1})が入っていても空配列で作り直す", async () => {
  var storage = makeLocalStorage();
  storage.setItem(RECORDS_STORAGE_KEY, JSON.stringify({ a: 1 }));
  var ctx = runScript(await getPageHtml(), { localStorage: storage });
  var loaded = ctx.loadRecords();
  assert.equal(loaded.ok, true);
  assert.equal(loaded.records.length, 0);
});

test("appendRecord: 読み取りが失敗しているあいだは保存せず、既存の記録を全消ししない", async () => {
  // 20件蓄積後に getItem が一時的に throw する状況を模す。バグ版は loadRecords() が
  // 「読めなかった」を「空」と取り違え、[] + 1件で上書きして過去の記録を消していた
  // (PR #25 レビュー指摘 should-fix 1。実測: 20件蓄積 → getItem が1回throw → 1件に減っていた)。
  //
  // runScript() は末尾で render() を自動実行するので、キャッシュが未確立の最初の
  // getItem 呼び出しは render() 経由のもの(1回目)、続いて明示的に呼ぶ
  // appendRecord() 内の loadRecords()(2回目)。この2回とも読み取り失敗を模したあと、
  // 3回目以降は正常に読める状態にする。
  var storage = makeLocalStorage();
  var existing = [];
  for (var i = 1; i <= 20; i++) {
    existing.push({ t: i, p: "x", r: 0, c: 0, round: 1, choice: "1", pc: 0.5, conf: 0.5, ok: true });
  }
  storage.setItem(RECORDS_STORAGE_KEY, JSON.stringify(existing));

  var originalGetItem = storage.getItem;
  var callCount = 0;
  var throwUntilCall = 2;
  storage.getItem = function (key) {
    // 記録キー以外(Claude の設定・キー。Issue #37)は数えない。この検証は
    // 「記録の読み取り」が何回目で成功するかにだけ依存する。
    if (key !== RECORDS_STORAGE_KEY) return originalGetItem.call(storage, key);
    callCount++;
    if (callCount <= throwUntilCall) {
      throw new Error("一時的な読み取り失敗を模す");
    }
    return originalGetItem.call(storage, key);
  };

  var ctx = runScript(await getPageHtml(), { localStorage: storage });
  assert.ok(callCount >= 1, "初期描画で読み取りが試みられていない(前提が崩れている)");
  // 読み取りが失敗している状態での appendRecord。保存せず黙って捨てるはず。
  ctx.appendRecord({ t: 999, p: "y", r: 1, c: 1, round: 1, choice: "2", pc: 0.4, conf: 0.4, ok: false });

  // 読み取りが復旧したあとは、20件がそのまま残っている(21件でも1件でもない)
  var records = ctx.loadRecords().records;
  assert.equal(records.length, 20, "読み取り失敗時に保存してしまい、過去の記録が消えた(または新しい1件だけになった)");
  assert.equal(records[0].t, 1);
  assert.equal(records[19].t, 20);
});

test(
  "run()(常に正解のfetch)で判定ごとに記録が1件増え、51件になる",
  { timeout: 10000 },
  async () => {
    var fetchStub = async function (url, init) {
      var body = JSON.parse(init.body);
      var digit = ANSWER_KEY[body.target.row][body.target.col];
      var probabilities = {};
      for (var d = 1; d <= 9; d++) probabilities[String(d)] = String(d) === digit ? 0.61 : 0.0125;
      return {
        ok: true,
        json: async function () {
          return { probabilities: probabilities, choice: digit, confidence: 0.31 };
        },
      };
    };
    var ctx = runScript(await getPageHtml(), { fetch: fetchStub });

    assertEmptyRecords(ctx);
    ctx.run();
    await waitFor(function () {
      return ctx.state.done === true;
    }, "1周での完了(全問正解)");

    var records = ctx.loadRecords().records;
    assert.equal(records.length, 51, "判定した51マス分の記録がない");

    var expectedId = ctx.puzzleId();
    for (var i = 0; i < records.length; i++) {
      var rec = records[i];
      assert.equal(rec.p, expectedId, "問題IDがGIVENのハッシュと一致しない");
      assert.equal(typeof rec.pc, "number", "pc(probabilities[choice])が数値でない");
      assert.ok(rec.pc > 0.6 && rec.pc <= 1, "pcの値がおかしい: " + rec.pc);
      assert.equal(rec.conf, 0.31, "conf(Jevのconfidence)が渡っていない");
      assert.equal(rec.ok, true, "常に正解を返すfetchなのにok=trueでない");
      assert.equal(rec.choice, ANSWER_KEY[rec.r][rec.c], "choiceが採点対象と食い違う");
    }
  }
);

// -------------------------------------------------------------------
// 集計ビュー: 較正図パネル(binRecords / renderCalibration / エクスポート / 消去)
// -------------------------------------------------------------------

test("純粋関数 binRecords: 境界(0.0→帯0 / 0.1→帯1 / 0.95・1.0→帯9)と件数/正解数/正解率", async () => {
  var ctx = runScript(await getPageHtml());
  var records = [
    { pc: 0.0, ok: true },
    { pc: 0.1, ok: false },
    { pc: 0.95, ok: false },
    { pc: 1.0, ok: true },
    { pc: 1.0, ok: false },
  ];
  var bins = ctx.binRecords(records, "pc");
  assert.equal(bins.length, 10);

  assert.equal(bins[0].n, 1);
  assert.equal(bins[0].correct, 1);
  assert.equal(bins[0].rate, 1);

  assert.equal(bins[1].n, 1);
  assert.equal(bins[1].correct, 0);
  assert.equal(bins[1].rate, 0);

  // 0.95 と 1.0(2件)はどれも最後の帯(帯9)に入る
  assert.equal(bins[9].n, 3, "0.95/1.0 が帯9に集約されていない");
  assert.equal(bins[9].correct, 1);
  assert.ok(Math.abs(bins[9].rate - 1 / 3) < 1e-9);

  // 件数0の帯は rate が null
  assert.equal(bins[2].n, 0);
  assert.equal(bins[2].rate, null);
});

test("純粋関数 binRecords: 数値でない/NaN/範囲外(0〜1超え)の値を除外し、pc と conf を独立に集計する", async () => {
  var ctx = runScript(await getPageHtml());
  var records = [
    { pc: 0.25, conf: 0.85, ok: true },
    { pc: "0.5", conf: 0.15, ok: true }, // pc が文字列 → pc集計から除外
    { pc: NaN, conf: 0.15, ok: false }, // pc が NaN → pc集計から除外
    { pc: 0.25, ok: true }, // conf が無い(undefined)→ conf集計から除外
    { pc: 1.5, conf: 0.5, ok: true }, // pc が範囲外(>1)→ pc集計から除外。confは独立に集計される(nit)
    { pc: -0.5, conf: 0.5, ok: true }, // pc が範囲外(<0)→ pc集計から除外。confは独立に集計される(nit)
  ];

  var pcBins = ctx.binRecords(records, "pc");
  var pcTotal = pcBins.reduce(function (sum, b) {
    return sum + b.n;
  }, 0);
  assert.equal(pcTotal, 2, "数値でない/NaN/範囲外のpcが除外されていない");
  assert.equal(pcBins[2].n, 2, "pc=0.25(帯2)の集計が合わない");
  assert.equal(pcBins[2].rate, 1);
  assert.equal(pcBins[9].n, 0, "pc=1.5(範囲外)が帯9に紛れ込んでいる");

  var confBins = ctx.binRecords(records, "conf");
  var confTotal = confBins.reduce(function (sum, b) {
    return sum + b.n;
  }, 0);
  assert.equal(confTotal, 5, "confが無い記録の除外、またはpc範囲外でもconfが独立集計されることが崩れている");
  assert.equal(confBins[8].n, 1, "conf=0.85(帯8)の集計が合わない");
  assert.equal(confBins[1].n, 2, "conf=0.15(帯1)が2件、集計が合わない");
  assert.equal(confBins[1].rate, 0.5);
  assert.equal(confBins[5].n, 2, "conf=0.5(帯5)が2件、集計が合わない(pcが範囲外でもconfは数えるはず)");
});

test("renderCalibration: 記録が無ければ0件/0%/0問、あれば件数・正解率・SVGが出る", async () => {
  var ctx = runScript(await getPageHtml());
  ctx.render();
  var emptyHtml = ctx.appElement.innerHTML;
  assert.ok(emptyHtml.includes('id="calibration-panel"'), "集計パネルが描画されていない");
  assert.ok(emptyHtml.includes("較正図"));
  assert.ok(emptyHtml.includes("合計 0 件"));

  ctx.saveRecords([
    { t: 1, p: "x", r: 0, c: 0, round: 1, choice: "4", pc: 0.61, conf: 0.31, ok: true },
    { t: 2, p: "x", r: 0, c: 1, round: 1, choice: "2", pc: 0.2, conf: 0.1, ok: false },
  ]);
  ctx.render();
  var html = ctx.appElement.innerHTML;
  assert.ok(html.includes("合計 2 件"));
  assert.ok(html.includes('id="export-records-btn"'));
  assert.ok(html.includes('id="clear-records-btn"'));
  assert.ok(html.includes("exportRecords()"));
  assert.ok(html.includes("clearRecords()"));
  assert.ok(html.includes("<svg"), "較正図のSVGが描画されていない");
});

test("exportRecords: エクスポート内容(version/exported_at/records)がloadRecords()と一致する", async () => {
  var ctx = runScript(await getPageHtml());
  var sample = [
    { t: 1, p: "aaaa1111", r: 0, c: 0, round: 1, choice: "1", pc: 0.5, conf: 0.4, ok: true },
    { t: 2, p: "aaaa1111", r: 0, c: 1, round: 1, choice: "2", pc: 0.3, conf: 0.2, ok: false },
  ];
  ctx.saveRecords(sample);

  ctx.exportRecords();

  assert.equal(ctx.createdBlobs.length, 1, "Blob が作られていない");
  var blob = ctx.createdBlobs[0];
  assert.equal(blob.options.type, "application/json");
  var payload = JSON.parse(blob.parts[0]);
  assert.equal(payload.version, 1);
  assert.ok(typeof payload.exported_at === "string" && !isNaN(Date.parse(payload.exported_at)), "exported_at がISO文字列でない");
  assert.deepEqual(payload.records, sample);

  // <a download> が作られ、appendChild/removeChild が対になっている
  assert.equal(ctx.bodyChildren.length, 0, "<a> がbodyに残ったまま");
});

test("clearRecords: confirmがtrueなら記録が0件になり、falseなら消えない", async () => {
  var sampleRecord = { t: 1, p: "x", r: 0, c: 0, round: 1, choice: "1", pc: 0.5, conf: 0.5, ok: true };

  var ctxKeep = runScript(await getPageHtml(), {
    confirm: function () {
      return false;
    },
  });
  ctxKeep.saveRecords([sampleRecord]);
  ctxKeep.clearRecords();
  assert.equal(ctxKeep.loadRecords().records.length, 1, "confirmがfalseなのに削除された");

  var ctxClear = runScript(await getPageHtml()); // 既定の confirm は true を返す
  ctxClear.saveRecords([sampleRecord]);
  ctxClear.clearRecords();
  assert.equal(ctxClear.loadRecords().records.length, 0, "confirmがtrueなのに削除されていない");
});

test("renderCalibrationChart: 正解率0%でも件数>0の帯は1pxの台座を描く(n=0の帯と区別できる)", async () => {
  var ctx = runScript(await getPageHtml());
  var bins = ctx.binRecords([{ pc: 0.1, conf: 0.1, ok: false }], "pc");
  assert.equal(bins[1].n, 1);
  assert.equal(bins[1].rate, 0);

  var html = ctx.renderCalibrationChart(bins, "test");
  // rate=0 の帯が height="0" の矩形になると n=0(未記録)の帯と見分けがつかない(nit)。
  assert.ok(!/height="0"/.test(html), "正解率0%の帯にheight=0の矩形が描かれている(1pxの台座になっていない)");
  assert.ok(/height="1"/.test(html), "1pxの台座になっていない");
});

test("render(): 記録が蓄積済みでもrenderのたびにlocalStorageを読み直さない(キャッシュ、should-fix 2)", async () => {
  var storage = makeLocalStorage();
  var many = [];
  for (var i = 0; i < 5000; i++) {
    many.push({ t: i, p: "x", r: 0, c: 0, round: 1, choice: "1", pc: 0.5, conf: 0.5, ok: true });
  }
  storage.setItem(RECORDS_STORAGE_KEY, JSON.stringify(many));

  var getItemCalls = 0;
  var originalGetItem = storage.getItem;
  storage.getItem = function (key) {
    getItemCalls++;
    return originalGetItem.call(storage, key);
  };

  var ctx = runScript(await getPageHtml(), { localStorage: storage });
  ctx.render(); // 初回はキャッシュが無いので localStorage を読む
  var callsAfterFirstRender = getItemCalls;
  assert.ok(callsAfterFirstRender >= 1, "初回のrenderでlocalStorageを読んでいない");

  ctx.render();
  ctx.render();
  ctx.render();
  assert.equal(
    getItemCalls,
    callsAfterFirstRender,
    "2回目以降のrenderでlocalStorage.getItemが呼ばれている(キャッシュされていない)"
  );
});

// -------------------------------------------------------------------
// 周回ロジックの振る舞い: in-flight の abort(Issue #19)
//
// これまでの世代トークン(runToken)の検査は正規表現によるソース検査のみだった。
// ここでは runScript の harness で実際に run() / reset() / newPuzzle() を動かし、
// 「リセット後に古い /api/judge の結果が届いても盤面が壊れないこと」を挙動として
// 検証する。fetch モックは応答を即座に返さず、呼び出しごとに resolve/reject を
// 外側から制御できる「宙吊り」な Promise を返す(node:vm 越しでも AbortSignal の
// addEventListener("abort", ...) は素の EventTarget なのでそのまま動く)。
// -------------------------------------------------------------------

/**
 * fetch モック。呼び出しを pending に積み、resolve/reject を外側から制御できる
 * ようにする。init.signal が付いていれば abort を購読し、abort() されたら
 * AbortError で reject する(実装側の inflightController.abort() を再現する)。
 * pending の各要素は最大1回しか解決できない(settled で二重解決を防ぐ。
 * abort 済みのものを後から「解決」しようとしても無視されることを試験できるようにするため)。
 */
function makeAbortAwareFetch() {
  var pending = [];
  function fetchStub(url, init) {
    return new Promise(function (resolve, reject) {
      var entry = { url: url, init: init, settled: false };
      entry.resolve = function (value) {
        if (entry.settled) return;
        entry.settled = true;
        resolve(value);
      };
      entry.reject = function (err) {
        if (entry.settled) return;
        entry.settled = true;
        reject(err);
      };
      var signal = init && init.signal;
      if (signal) {
        if (signal.aborted) {
          entry.reject(makeAbortError());
        } else {
          signal.addEventListener("abort", function () {
            entry.reject(makeAbortError());
          });
        }
      }
      pending.push(entry);
    });
  }
  return { fetch: fetchStub, pending: pending };
}

function makeAbortError() {
  var err = new Error("The operation was aborted");
  err.name = "AbortError";
  return err;
}

/**
 * Worker が実際に env.AI.run へ渡すペイロード(src/index.js handleJudge の `payload`)
 * を模したもの。/api/judge のレスポンスに足す `request` フィールドのモック用
 * (Issue #34)。中身の一致は検証しないので puzzle は簡略化したものでよい。
 */
function makeRequestPayload(puzzle, row, col) {
  var criteria = {};
  for (var d = 1; d <= 9; d++) criteria[String(d)] = "the digit " + d;
  return {
    state: {
      puzzle: puzzle,
      target: { row: row, col: col },
      note: "puzzle is a 9x9 Sudoku grid",
    },
    questions: {
      digit: {
        type: "choice",
        instructions: "Which digit from 1 to 9 belongs in the target cell of this Sudoku grid?",
        criteria: criteria,
      },
    },
  };
}

/** 正解をそのまま返す /api/judge のレスポンス(常に正解 ⇒ 1周で完了する)。 */
function makeCorrectResponse(ctx, row, col, puzzle) {
  var digit = ctx.SOLUTION[row][col];
  var probabilities = {};
  for (var d = 1; d <= 9; d++) probabilities[String(d)] = String(d) === digit ? 0.9 : 0.0125;
  return {
    ok: true,
    json: async function () {
      return {
        probabilities: probabilities,
        choice: digit,
        confidence: 0.5,
        request: makeRequestPayload(puzzle || [], row, col),
      };
    },
  };
}

/** makeCorrectResponse の不正解版(正解が "1" なら "2"、それ以外は "1" を choice にする)。 */
function makeWrongResponse(ctx, row, col, puzzle) {
  var correctDigit = ctx.SOLUTION[row][col];
  var wrongDigit = correctDigit === "1" ? "2" : "1";
  var probabilities = {};
  for (var d = 1; d <= 9; d++) probabilities[String(d)] = String(d) === wrongDigit ? 0.9 : 0.0125;
  return {
    ok: true,
    json: async function () {
      return {
        probabilities: probabilities,
        choice: wrongDigit,
        confidence: 0.5,
        request: makeRequestPayload(puzzle || [], row, col),
      };
    },
  };
}

/**
 * pending にたまった fetch を順に「正解」で解決し、state.done になるまで流し切る。
 * すでに settled(= abort 済み)のものは resolve/reject を呼ばず、calls にも積まない
 * (abort 済みの宙吊りを再送・再処理しないことの検証そのもの)。
 */
async function driveToCompletion(ctx, pending, calls, label) {
  for (var i = 0; i < 1000; i++) {
    if (ctx.state.done) return;
    while (pending.length) {
      var item = pending.shift();
      if (item.settled) continue; // abort 済み。再送しない
      var body = JSON.parse(item.init.body);
      calls.push({ url: item.url, body: body });
      item.resolve(makeCorrectResponse(ctx, body.target.row, body.target.col, body.puzzle));
    }
    await tick();
  }
  throw new Error("待っても完了しなかった: " + label);
}

test("S1: run() 中の reset() → run() は in-flight を打ち切り、fetch を二重に送らない", { timeout: 10000 }, async () => {
  var af = makeAbortAwareFetch();
  var calls = [];
  var ctx = runScript(await getPageHtml(), { fetch: af.fetch });

  ctx.run();
  assert.equal(af.pending.length, 1, "1件目の fetch が飛んでいない");
  var firstEntry = af.pending[0];
  assert.equal(firstEntry.settled, false, "1件目がまだ宙吊りでない");

  ctx.reset();
  assert.equal(firstEntry.settled, true, "reset() で in-flight の fetch が abort されていない");

  ctx.run();
  await driveToCompletion(ctx, af.pending, calls, "S1: 1周での完了");

  assert.equal(ctx.state.done, true, "state.done が true になっていない");
  assert.equal(ctx.state.roundsToSolve, 1, "常に正解を返しているので1周で終わるはず");
  assert.ok(
    calls.length <= 51,
    "fetch 総数が 51 を超えている(abort により宙吊り分が再送された可能性): " + calls.length
  );

  var values = ctx.state.values;
  var keys = Object.keys(values);
  assert.equal(keys.length, 51, "commit 数が 51 でない: " + keys.length);
  keys.forEach(function (key) {
    assert.equal(values[key].status, "correct", key + " が不正解のまま残っている");
  });

  var remainingEmpty = 0;
  for (var r = 0; r < 9; r++) {
    for (var c = 0; c < 9; c++) {
      var key2 = r + "-" + c;
      var filled = ctx.GIVEN[r][c] !== "." || values[key2];
      if (!filled) remainingEmpty++;
    }
  }
  assert.equal(remainingEmpty, 0, "空マスが残っている");
});

test("S2: run() の in-flight 中に reset() だけした場合、古い結果は一切反映されない", { timeout: 10000 }, async () => {
  var af = makeAbortAwareFetch();
  var ctx = runScript(await getPageHtml(), { fetch: af.fetch });
  var recordsBefore = ctx.getRecords().length;

  ctx.run();
  assert.equal(af.pending.length, 1, "1件目の fetch が飛んでいない");
  var firstEntry = af.pending[0];
  var body = JSON.parse(firstEntry.init.body);

  ctx.reset();
  assert.equal(firstEntry.settled, true, "reset() で in-flight の fetch が abort されていない");

  // 「解決」しようとしても、abort 済みなので何も起きない
  firstEntry.resolve(makeCorrectResponse(ctx, body.target.row, body.target.col));
  await tick();
  await tick();
  await tick();

  assert.equal(Object.keys(ctx.state.values).length, 0, "commit されてしまっている(state.values が空でない)");
  assert.equal(ctx.state.running, false, "state.running が false になっていない");
  assert.equal(ctx.state.done, false);
  assert.equal(ctx.getRecords().length, recordsBefore, "記録(getRecords())が増えている");
});

test("S3: run() の in-flight 中に newPuzzle() した場合、古い結果は新しい盤面に commit されない", { timeout: 10000 }, async () => {
  var af = makeAbortAwareFetch();
  var ctx = runScript(await getPageHtml(), { fetch: af.fetch });

  ctx.run();
  assert.equal(af.pending.length, 1, "1件目の fetch が飛んでいない");
  var firstEntry = af.pending[0];
  var oldBody = JSON.parse(firstEntry.init.body);
  var oldGiven = hostRows(ctx.GIVEN);

  ctx.newPuzzle(); // 内部で reset() を呼ぶので、ここで in-flight が abort されるはず
  await waitFor(function () {
    return ctx.generating === false;
  }, "S3: 新しい問題の生成完了");

  assert.equal(firstEntry.settled, true, "newPuzzle() で in-flight の fetch が abort されていない");
  assert.notDeepEqual(hostRows(ctx.GIVEN), oldGiven, "GIVEN が新しい盤面に差し替わっていない");

  // 古い盤面向けの結果を「解決」しようとしても、abort 済みなので新しい盤面には効かない
  firstEntry.resolve(makeCorrectResponse(ctx, oldBody.target.row, oldBody.target.col));
  await tick();
  await tick();
  await tick();

  assert.equal(Object.keys(ctx.state.values).length, 0, "古い結果が新しい盤面に commit されている");
  assert.equal(ctx.state.running, false);
});

test("S4: reset() で fetch が AbortError で reject されても showError にならない", { timeout: 10000 }, async () => {
  var af = makeAbortAwareFetch();
  var ctx = runScript(await getPageHtml(), { fetch: af.fetch });

  ctx.run();
  assert.equal(af.pending.length, 1, "1件目の fetch が飛んでいない");
  var firstEntry = af.pending[0];

  ctx.reset();
  assert.equal(firstEntry.settled, true, "reset() で in-flight の fetch が abort(reject)されていない");

  // AbortError の reject が focusNext の then ハンドラまで伝播するのを待つ
  await tick();
  await tick();
  await tick();

  assert.equal(ctx.state.errorMessage, null, "abort が showError に流れてエラーメッセージが立っている");

  ctx.render();
  var html = ctx.appElement.innerHTML;
  assert.ok(!html.includes('class="error"'), "abort でエラーボックスが表示されている");
});

// -------------------------------------------------------------------
// 停止/再開(Issue #32、SPEC F1/F2/F3、DESIGN 4.2 stop() / 4.3 状態遷移)。
// T1・T2・T4・T5・T6 は makeAbortAwareFetch(宙吊りの fetch)を使い、S1〜S4 と
// 同じスタイルで in-flight のリクエストを外側から制御する。
//
// T3(周の切り替え待ち中の stop())だけは、setTimeout(=setImmediate)が自動発火する
// 既定の runScript() だと「between-round のタイマーが張られた直後・まだ発火していない」
// という一瞬の状態を tick() のポーリングだけで確実に捉えるのが難しい(macrotask の
// 順序に依存してしまう)。そこで opts.setTimeout に makeManualTimers() を渡し、
// setTimeout が呼ばれても自動では発火させず、テスト側が fireNext() で明示的に1つずつ
// 発火させる。これで「finalizeRound() が between-round のタイマーを張った直後・まだ
// 発火させていない」状態を確実に作れる。
// -------------------------------------------------------------------

/**
 * 手動発火のタイマー。setTimeout(fn, delay) は fn を即座には実行せず、内部の配列に
 * 積むだけ。テスト側が fireNext() で先頭から1つずつ明示的に発火させる(T3)。
 */
function makeManualTimers() {
  var scheduled = [];
  return {
    setTimeout: function (fn) {
      scheduled.push(fn);
    },
    length: function () {
      return scheduled.length;
    },
    fireNext: function () {
      if (scheduled.length === 0) throw new Error("manual timer: 発火対象が無い");
      var fn = scheduled.shift();
      fn();
    },
  };
}

test("T1: 9マス確定後、10マス目の in-flight 中に stop() すると9件で止まり、10マス目が queue の先頭に戻る", { timeout: 10000 }, async () => {
  var af = makeAbortAwareFetch();
  var ctx = runScript(await getPageHtml(), { fetch: af.fetch });

  ctx.run();
  for (var i = 0; i < 9; i++) {
    await waitFor(function () {
      return af.pending.length === 1;
    }, "T1: " + i + "件目の fetch 待ち");
    var entry = af.pending.shift();
    var body = JSON.parse(entry.init.body);
    entry.resolve(makeCorrectResponse(ctx, body.target.row, body.target.col));
    await waitFor(function () {
      return Object.keys(ctx.state.values).length === i + 1;
    }, "T1: " + i + "件目の commit 待ち");
  }

  await waitFor(function () {
    return af.pending.length === 1;
  }, "T1: 10マス目の fetch 待ち");
  var tenthEntry = af.pending[0];
  var tenthBody = JSON.parse(tenthEntry.init.body);
  var tenthCell = { r: tenthBody.target.row, c: tenthBody.target.col };
  var recordsBeforeStop = ctx.getRecords().length;

  ctx.stop();

  assert.equal(af.pending.length, 1, "stop() 後に新しい fetch が増えている");
  assert.equal(tenthEntry.settled, true, "stop() で in-flight の fetch が abort されていない");
  assert.equal(ctx.state.running, false, "state.running が false になっていない");
  assert.equal(Object.keys(ctx.state.values).length, 9, "state.values が9件でない");
  assert.equal(ctx.getRecords().length, recordsBeforeStop, "判定中だったマスが記録されてしまっている");
  assert.equal(ctx.state.focusedKey, null, "フォーカスが残っている");
  assert.equal(ctx.queue.length, 42, "queue の残り件数が42でない(51 - 9)");
  assert.equal(ctx.queue[0].r, tenthCell.r, "queue の先頭行が10マス目でない");
  assert.equal(ctx.queue[0].c, tenthCell.c, "queue の先頭列が10マス目でない");
});

test("T2: 停止中に run() で再開すると10マス目から続き、fetch 合計51件・記録51件で完了する", { timeout: 10000 }, async () => {
  var af = makeAbortAwareFetch();
  var calls = [];
  var ctx = runScript(await getPageHtml(), { fetch: af.fetch });

  ctx.run();
  for (var i = 0; i < 9; i++) {
    await waitFor(function () {
      return af.pending.length === 1;
    }, "T2: " + i + "件目の fetch 待ち");
    var entry = af.pending.shift();
    var body = JSON.parse(entry.init.body);
    calls.push(body);
    entry.resolve(makeCorrectResponse(ctx, body.target.row, body.target.col));
    await waitFor(function () {
      return Object.keys(ctx.state.values).length === i + 1;
    }, "T2: " + i + "件目の commit 待ち");
  }
  await waitFor(function () {
    return af.pending.length === 1;
  }, "T2: 10マス目の fetch 待ち");

  ctx.stop();
  assert.equal(ctx.state.running, false);

  ctx.run(); // 再開。10マス目から続き
  await driveToCompletion(ctx, af.pending, calls, "T2: 再開後の完了");

  assert.equal(ctx.state.done, true, "state.done が true になっていない");
  assert.equal(ctx.state.roundsToSolve, 1, "常に正解を返しているので1周で終わるはず");
  assert.equal(calls.length, 51, "応答に使われた fetch の合計が51でない: " + calls.length);
  assert.equal(Object.keys(ctx.state.values).length, 51, "commit 数が51でない");
  assert.equal(ctx.getRecords().length, 51, "記録が51件でない");
});

test("T3: 周の切り替え待ち中に stop() すると、run() で2周目の先頭から再開する", { timeout: 10000 }, async () => {
  var ctx;
  var wrongKey = "0-2"; // GIVEN[0] の最初の空マス(helpers.js の GIVEN と同一の固定問題)
  var askedWrongOnce = false;
  var fetchStub = async function (url, init) {
    var body = JSON.parse(init.body);
    var key = body.target.row + "-" + body.target.col;
    if (key === wrongKey && !askedWrongOnce) {
      askedWrongOnce = true;
      var correctDigit = ctx.SOLUTION[body.target.row][body.target.col];
      var wrongDigit = correctDigit === "1" ? "2" : "1";
      var probabilities = {};
      for (var d = 1; d <= 9; d++) probabilities[String(d)] = String(d) === wrongDigit ? 0.9 : 0.0125;
      return {
        ok: true,
        json: async function () {
          return { probabilities: probabilities, choice: wrongDigit, confidence: 0.5 };
        },
      };
    }
    return makeCorrectResponse(ctx, body.target.row, body.target.col);
  };
  var timers = makeManualTimers();
  ctx = runScript(await getPageHtml(), { fetch: fetchStub, setTimeout: timers.setTimeout });

  var totalCells = ctx.TOTAL_EMPTY;
  ctx.run();
  for (var i = 0; i < totalCells; i++) {
    await tick(); // fetch の Promise チェーンを流し、beforeCommit のタイマーを積ませる
    assert.equal(timers.length(), 1, "beforeCommit タイマーが積まれていない: " + i + "件目");
    timers.fireNext(); // commitFocused() を実行し、afterCommit(または周切り替え)のタイマーを積む
    assert.equal(timers.length(), 1, "afterCommit タイマーが積まれていない: " + i + "件目");
    timers.fireNext(); // 次のマスへ(最後のマスなら focusNext() → queue空 → finalizeRound())
  }

  // 1周目の全マスを処理し終えた直後。finalizeRound() は between-round の setTimeout を
  // 張る前に round / queue / roundSize / roundTally を更新済みなので、この時点で
  // すでに2周目の状態になっている。between-round のタイマーは積まれているが未発火。
  assert.equal(ctx.state.round, 2, "finalizeRound() 後に round が2になっていない");
  assert.equal(ctx.state.running, true, "周の切り替え待ち中はまだ running のはず");
  assert.equal(ctx.state.focusedKey, null);
  assert.equal(ctx.queue.length, 1, "1周目の不正解マスが2周目の queue に入っていない");
  assert.equal(ctx.queue[0].r, 0);
  assert.equal(ctx.queue[0].c, 2);
  assert.equal(timers.length(), 1, "周の切り替えタイマーが積まれていない(未発火のはず)");

  ctx.stop();
  assert.equal(ctx.state.running, false);
  assert.equal(ctx.state.round, 2, "stop() 後も周は2周目のまま");
  assert.equal(ctx.queue.length, 1);
  assert.equal(ctx.queue[0].r, 0);
  assert.equal(ctx.queue[0].c, 2);

  // stop() は runToken を進めるだけで、実ブラウザ同様に張ったままの between-round
  // タイマーそのものは残る(このテストの手動タイマーでも発火させずに積んだままにした
  // ものが1つ残っている)。実際に発火させて、isCurrent() に弾かれて無害なことを
  // 確認してから片付ける(発火しても state が変わらない)。
  assert.equal(timers.length(), 1, "stop() 後も between-round タイマーは残っているはず");
  timers.fireNext();
  assert.equal(ctx.state.round, 2, "古い世代のタイマーの発火で state が変わってしまった");
  assert.equal(timers.length(), 0);

  ctx.run(); // 再開。2周目の先頭(前の周の不正解マス)から
  await tick();
  assert.equal(timers.length(), 1, "再開後の beforeCommit タイマーが積まれていない");
  timers.fireNext(); // commitFocused()(2周目は正解を返す)
  timers.fireNext(); // focusNext() → queue空 → finalizeRound() → solved

  assert.equal(ctx.state.done, true, "state.done が true になっていない");
  assert.equal(ctx.state.roundsToSolve, 2, "2周で完了したことになっていない");
  assert.equal(ctx.state.values["0-2"].status, "correct", "2周目でマスが正解になっていない");
});

test("T4: stop() の後に reset() すると最初から(state.values が空、started === false)", { timeout: 10000 }, async () => {
  var af = makeAbortAwareFetch();
  var ctx = runScript(await getPageHtml(), { fetch: af.fetch });

  ctx.run();
  assert.equal(af.pending.length, 1, "1件目の fetch が飛んでいない");

  ctx.stop();
  assert.equal(ctx.state.running, false);
  assert.equal(ctx.started, true, "stop() 後も started が true のままのはず");

  ctx.reset();

  assert.equal(ctx.started, false, "reset() 後も started が true のまま");
  assert.equal(Object.keys(ctx.state.values).length, 0, "reset() 後も state.values が残っている");
  assert.equal(ctx.state.round, 1);
  assert.equal(ctx.queue.length, 0);
  assert.equal(ctx.state.roundLog.length, 0);
});

test("T5: 停止中に速度トグルを変えると、再開後の待ち時間(setTimeout の実引数)に反映される", { timeout: 10000 }, async () => {
  var af = makeAbortAwareFetch();
  var ctx = runScript(await getPageHtml(), { fetch: af.fetch });

  ctx.run();
  assert.equal(af.pending.length, 1, "1件目の fetch が飛んでいない");
  var firstEntry = af.pending[0];

  ctx.stop();
  assert.equal(firstEntry.settled, true, "stop() で in-flight の fetch が abort されていない");
  assert.equal(ctx.state.running, false);
  assert.equal(ctx.setTimeoutCalls.length, 0, "stop() までに setTimeout が呼ばれてしまっている");

  ctx.setSpeed("fast"); // 停止中に速度を変える

  var pendingBeforeResume = af.pending.length; // abort 済みの1件目は pending 配列に残ったまま
  ctx.run(); // 再開
  await waitFor(function () {
    return af.pending.length === pendingBeforeResume + 1;
  }, "T5: 再開後の1件目の fetch 待ち");
  var secondEntry = af.pending[af.pending.length - 1];
  var body = JSON.parse(secondEntry.init.body);
  secondEntry.resolve(makeCorrectResponse(ctx, body.target.row, body.target.col));

  await waitFor(function () {
    return ctx.setTimeoutCalls.length >= 1;
  }, "T5: 再開後の setTimeout 待ち");

  assert.equal(ctx.setTimeoutCalls[0], 0, "fast モードの確定前の待ち時間(0ms)が反映されていない: " + ctx.setTimeoutCalls[0]);
});

test("T6: 完了後(state.done)に stop() を呼んでも何も起きない", { timeout: 10000 }, async () => {
  var af = makeAbortAwareFetch();
  var calls = [];
  var ctx = runScript(await getPageHtml(), { fetch: af.fetch });

  ctx.run();
  await driveToCompletion(ctx, af.pending, calls, "T6: 完了待ち");
  assert.equal(ctx.state.done, true);

  var valuesBefore = Object.keys(ctx.state.values).length;
  var roundLogBefore = ctx.state.roundLog.length;
  var queueBefore = ctx.queue.length;
  var roundBefore = ctx.state.round;
  var runTokenBefore = ctx.runToken;

  ctx.stop();

  assert.equal(ctx.state.done, true, "done が変わってしまっている");
  assert.equal(ctx.state.running, false);
  assert.equal(Object.keys(ctx.state.values).length, valuesBefore, "state.values が変わってしまっている");
  assert.equal(ctx.state.roundLog.length, roundLogBefore, "roundLog が変わってしまっている");
  assert.equal(ctx.queue.length, queueBefore, "queue が変わってしまっている");
  assert.equal(ctx.state.round, roundBefore, "round が変わってしまっている");
  assert.equal(ctx.runToken, runTokenBefore, "runToken が進んでしまっている(stop() が何かしている)");
});

// -------------------------------------------------------------------
// 「Jev に送ったプロンプト」パネル(renderPromptPanel、Issue #34)
// -------------------------------------------------------------------

test("U1: 判定1件のあと #prompt-panel に instructions の文言と座標ラベルが表示される", { timeout: 10000 }, async () => {
  var af = makeAbortAwareFetch();
  var ctx = runScript(await getPageHtml(), { fetch: af.fetch });

  // 未実行時は「まだ判定していません」
  ctx.render();
  assert.ok(
    ctx.appElement.innerHTML.includes("まだ判定していません"),
    "未実行時の初期文言が出ていない"
  );
  assert.equal(ctx.state.lastRequest, null, "state.lastRequest の初期値が null でない");

  ctx.run();
  await waitFor(function () {
    return af.pending.length === 1;
  }, "U1: 1件目の fetch 待ち");
  var entry = af.pending.shift();
  var body = JSON.parse(entry.init.body);
  entry.resolve(makeCorrectResponse(ctx, body.target.row, body.target.col, body.puzzle));

  await waitFor(function () {
    return ctx.state.lastRequest !== null;
  }, "U1: lastRequest が設定されるまで");

  ctx.render();
  var html = ctx.appElement.innerHTML;
  assert.ok(html.includes('id="prompt-panel"'), "#prompt-panel が描画されていない");
  assert.ok(html.includes("instructions"), "instructions の文言が出ていない");
  var expectedLabel = (body.target.row + 1) + "行目 " + (body.target.col + 1) + "列目";
  assert.ok(html.includes(expectedLabel + " の判定に使用"), "座標ラベルが出ていない: " + expectedLabel);
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(ctx.state.lastRequest)),
    makeRequestPayload(body.puzzle, body.target.row, body.target.col),
    "state.lastRequest がレスポンスの request と一致しない"
  );
});

test("U2: stop() 後も #prompt-panel の内容が残る", { timeout: 10000 }, async () => {
  var af = makeAbortAwareFetch();
  var ctx = runScript(await getPageHtml(), { fetch: af.fetch });

  ctx.run();
  await waitFor(function () {
    return af.pending.length === 1;
  }, "U2: 1件目の fetch 待ち");
  var entry = af.pending.shift();
  var body = JSON.parse(entry.init.body);
  entry.resolve(makeCorrectResponse(ctx, body.target.row, body.target.col, body.puzzle));

  await waitFor(function () {
    return ctx.state.lastRequest !== null;
  }, "U2: lastRequest が設定されるまで");

  // 2件目が in-flight のうちに stop() する(判定中のマスは破棄されるが、
  // lastRequest は直前の確定分のまま残るはず)。
  await waitFor(function () {
    return af.pending.length === 1;
  }, "U2: 2件目の fetch 待ち");
  var requestBeforeStop = ctx.state.lastRequest;
  ctx.stop();

  assert.equal(ctx.state.running, false, "stop() 後も running のまま");
  assert.deepStrictEqual(
    ctx.state.lastRequest,
    requestBeforeStop,
    "stop() で lastRequest が消えている、または変わっている"
  );

  ctx.render();
  var html = ctx.appElement.innerHTML;
  assert.ok(html.includes('id="prompt-panel"'), "#prompt-panel が描画されていない");
  assert.ok(html.includes("instructions"), "stop() 後に instructions の文言が消えている");
});

test("U3: reset() で #prompt-panel が初期文言に戻る", { timeout: 10000 }, async () => {
  var af = makeAbortAwareFetch();
  var ctx = runScript(await getPageHtml(), { fetch: af.fetch });

  ctx.run();
  await waitFor(function () {
    return af.pending.length === 1;
  }, "U3: 1件目の fetch 待ち");
  var entry = af.pending.shift();
  var body = JSON.parse(entry.init.body);
  entry.resolve(makeCorrectResponse(ctx, body.target.row, body.target.col, body.puzzle));

  await waitFor(function () {
    return ctx.state.lastRequest !== null;
  }, "U3: lastRequest が設定されるまで");

  ctx.reset();

  assert.equal(ctx.state.lastRequest, null, "reset() で lastRequest が null に戻っていない");
  ctx.render();
  var html = ctx.appElement.innerHTML;
  assert.ok(
    html.includes("まだ判定していません"),
    "reset() 後に初期文言に戻っていない"
  );
  assert.ok(!html.includes("instructions"), "reset() 後も instructions の文言が残っている");
});

test("U4: 502 に付いた request は「このプロンプトで失敗」として #prompt-panel に出る(request の無いエラーは直前の値を残す)", { timeout: 10000 }, async () => {
  var af = makeAbortAwareFetch();
  var ctx = runScript(await getPageHtml(), { fetch: af.fetch });

  ctx.run();
  await waitFor(function () {
    return af.pending.length === 1;
  }, "U4: 1件目の fetch 待ち");
  var entry = af.pending.shift();
  var body = JSON.parse(entry.init.body);
  var failedRequest = makeRequestPayload(body.puzzle, body.target.row, body.target.col);
  entry.resolve({
    ok: false,
    status: 502,
    json: function () {
      return Promise.resolve({ error: "AIの呼び出しに失敗しました", raw: "boom", request: failedRequest });
    },
  });

  await waitFor(function () {
    return ctx.state.errorMessage !== null;
  }, "U4: エラー表示待ち");

  assert.equal(ctx.state.running, false, "エラー後も running のまま");
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(ctx.state.lastRequest)),
    failedRequest,
    "502 の request が state.lastRequest に入っていない"
  );
  assert.equal(ctx.state.lastRequestFailed, true, "lastRequestFailed が true になっていない");
  ctx.render();
  var html = ctx.appElement.innerHTML;
  var expectedLabel = (body.target.row + 1) + "行目 " + (body.target.col + 1) + "列目";
  assert.ok(html.includes(expectedLabel + " の判定に使用(このプロンプトで失敗)"), "失敗の注記が出ていない");
  assert.ok(html.includes("&lt;") === false, "エスケープ対象の無い JSON に &lt; が出ている");

  // request の無いエラー(400 相当)は直前の値をそのまま残す。429/503 は Issue #43 で
  // 停止扱いに変わった(showError にならない)ので、ここは非一時的な 400 で確認する
  // (429/503 が停止扱いになることは Y3 で確認する)。
  ctx.reset();
  ctx.run();
  await waitFor(function () {
    return af.pending.length === 1;
  }, "U4: 2件目の fetch 待ち");
  var entry2 = af.pending.shift();
  var body2 = JSON.parse(entry2.init.body);
  entry2.resolve(makeCorrectResponse(ctx, body2.target.row, body2.target.col, body2.puzzle));
  await waitFor(function () {
    return ctx.state.lastRequest !== null;
  }, "U4: lastRequest が設定されるまで");
  var kept = ctx.state.lastRequest;
  assert.equal(ctx.state.lastRequestFailed, false, "成功後に lastRequestFailed が false に戻っていない");
  await waitFor(function () {
    return af.pending.length === 1;
  }, "U4: 3件目の fetch 待ち");
  af.pending.shift().resolve({
    ok: false,
    status: 400,
    json: function () {
      return Promise.resolve({ error: "入力が不正です" });
    },
  });
  await waitFor(function () {
    return ctx.state.errorMessage !== null;
  }, "U4: 2回目のエラー表示待ち");
  assert.strictEqual(ctx.state.lastRequest, kept, "request の無いエラーで lastRequest が変わった");
  assert.equal(ctx.state.lastRequestFailed, false, "request の無いエラーで lastRequestFailed が立った");
});

test("U5: request に HTML 特殊文字が含まれても #prompt-panel でエスケープされる", { timeout: 10000 }, async () => {
  var af = makeAbortAwareFetch();
  var ctx = runScript(await getPageHtml(), { fetch: af.fetch });
  ctx.run();
  await waitFor(function () {
    return af.pending.length === 1;
  }, "U5: 1件目の fetch 待ち");
  var entry = af.pending.shift();
  var body = JSON.parse(entry.init.body);
  var response = makeCorrectResponse(ctx, body.target.row, body.target.col, body.puzzle);
  var payload = makeRequestPayload(body.puzzle, body.target.row, body.target.col);
  payload.state.note = "<script>alert(1)</script> & \"quoted\"";
  response.json = function () {
    return Promise.resolve({
      probabilities: (function () { var p = {}; for (var d = 1; d <= 9; d++) p[String(d)] = d === Number(ctx.SOLUTION[body.target.row][body.target.col]) ? 0.9 : 0.0125; return p; })(),
      choice: ctx.SOLUTION[body.target.row][body.target.col],
      confidence: 0.5,
      request: payload,
    });
  };
  entry.resolve(response);
  await waitFor(function () {
    return ctx.state.lastRequest !== null;
  }, "U5: lastRequest が設定されるまで");
  ctx.render();
  var pre = ctx.appElement.innerHTML.split('<pre class="prompt-json">')[1].split("</pre>")[0];
  assert.ok(!pre.includes("<script>"), "<script> がそのまま出ている");
  assert.ok(pre.includes("&lt;script&gt;"), "< > がエスケープされていない");
  assert.ok(pre.includes("&amp;"), "& がエスケープされていない");
});

// ---------------------------------------------------------------------
// Claude 経路(BYOK、ブラウザ直呼び。Issue #37、SPEC 7 章 拡張 3)
// ---------------------------------------------------------------------

var ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
var TEST_KEY = "sk-ant-test-0123456789abcdef";

/** Messages API の成功応答(structured outputs の JSON をテキストブロックで返す)を模す。 */
// digits(任意): 応答の probabilities/choice をこの数字だけに絞る(消去法。Issue #61・#63 で
// exclude されたリクエストのスキーマに合わせるため。省略時は従来どおり1〜9全部)。
function makeClaudeResponse(ctx, row, col, overrides, digits) {
  var digit = ctx.SOLUTION[row][col];
  var list = digits || ["1", "2", "3", "4", "5", "6", "7", "8", "9"];
  var probabilities = {};
  list.forEach(function (d) { probabilities[d] = d === digit ? 0.6 : 0.05; });
  var answer = Object.assign({ choice: digit, probabilities: probabilities, confidence: 0.42 }, overrides || {});
  return {
    ok: true,
    status: 200,
    json: function () {
      return Promise.resolve({
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "claude-opus-5",
        stop_reason: "end_turn",
        content: [{ type: "text", text: JSON.stringify(answer) }],
        usage: { input_tokens: 500, output_tokens: 80 },
      });
    },
  };
}

function makeClaudeErrorResponse(status, message) {
  return {
    ok: false,
    status: status,
    json: function () {
      return Promise.resolve({ type: "error", error: { type: "authentication_error", message: message } });
    },
  };
}

test("V1: Claude を選んでキー未設定のまま実行するとエラーで止まり、fetch は呼ばれない", { timeout: 10000 }, async () => {
  var af = makeAbortAwareFetch();
  var ctx = runScript(await getPageHtml(), { fetch: af.fetch });
  ctx.setModelMode("claude");
  assert.equal(ctx.state.modelMode, "claude");
  ctx.run();
  await waitFor(function () {
    return ctx.state.errorMessage !== null;
  }, "V1: エラー表示待ち");
  assert.equal(af.pending.length, 0, "キー未設定なのに fetch が呼ばれた");
  assert.equal(ctx.state.running, false);
  assert.ok(ctx.state.errorMessage.includes("API キー"), "エラー文言にキー未設定の説明が無い: " + ctx.state.errorMessage);
});

test("V2: Claude 経路はブラウザから api.anthropic.com を直接呼び、キーはヘッダーにだけ載る。結果は Jev と同じ形で処理され、記録に m が付く", { timeout: 10000 }, async () => {
  var af = makeAbortAwareFetch();
  var ctx = runScript(await getPageHtml(), { fetch: af.fetch });
  assert.equal(ctx.saveAnthropicKey(TEST_KEY), true);
  ctx.setModelMode("claude");
  ctx.run();
  await waitFor(function () {
    return af.pending.length === 1;
  }, "V2: fetch 待ち");
  var entry = af.pending.shift();
  assert.equal(entry.url, ANTHROPIC_URL, "呼び先が api.anthropic.com でない");
  assert.equal(entry.init.method, "POST");
  assert.equal(entry.init.headers["x-api-key"], TEST_KEY, "x-api-key ヘッダーにキーが無い");
  assert.equal(entry.init.headers["anthropic-version"], "2023-06-01");
  assert.equal(entry.init.headers["anthropic-dangerous-direct-browser-access"], "true", "ブラウザ直呼び用ヘッダーが無い");
  assert.equal(entry.init.headers["content-type"], "application/json");
  assert.ok(entry.init.signal, "AbortSignal が渡っていない");
  assert.ok(!entry.init.body.includes(TEST_KEY), "リクエストボディにキーが混ざっている");

  var body = JSON.parse(entry.init.body);
  assert.equal(body.model, "claude-opus-5");
  assert.deepStrictEqual(JSON.parse(JSON.stringify(body.thinking)), { type: "adaptive" }, "既定は思考あり(adaptive)");
  assert.equal(body.output_config.format.type, "json_schema");
  assert.deepStrictEqual(body.output_config.format.schema.required, ["choice", "probabilities", "confidence"]);
  assert.equal(body.max_tokens, 16000, "adaptive thinking では思考ぶんを含めて max_tokens を大きくする(レビュー M1)");
  assert.ok(typeof body.system === "string" && body.system.includes("Standard Sudoku rules"), "system にルール説明が無い");
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].role, "user");
  // 不変条件: 盤面は buildSnapshot()(対象マスは ".")で、SOLUTION 由来の情報は無い
  var content = body.messages[0].content;
  assert.ok(content.startsWith("Which digit from 1 to 9"), "質問文が先頭に無い");
  var sent = JSON.parse(content.slice(content.indexOf("\n") + 1));
  var target = sent.target;
  assert.equal(ctx.state.focusedKey, target.row + "-" + target.col, "対象マスがフォーカス中のマスと違う");
  assert.equal(sent.puzzle[target.row][target.col], ".", "対象マスが空になっていない");
  assert.deepStrictEqual(hostRows(sent.puzzle), hostRows(ctx.buildSnapshot()), "盤面が buildSnapshot() と一致しない");
  assert.ok(!content.includes("SOLUTION"), "SOLUTION が混ざっている");

  entry.resolve(makeClaudeResponse(ctx, target.row, target.col, undefined, body.output_config.format.schema.properties.choice.enum));
  await waitFor(function () {
    return ctx.state.values[target.row + "-" + target.col] !== undefined;
  }, "V2: 確定待ち");
  var recs = ctx.getRecords();
  assert.equal(recs.length, 1);
  assert.equal(recs[0].m, "claude-opus-5+think", "記録にモデル識別子が無い");
  assert.equal(recs[0].ok, true);
  assert.equal(recs[0].conf, 0.42);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(ctx.state.lastRequest)), body, "lastRequest がリクエストボディと一致しない");
  assert.equal(ctx.state.lastRequestFailed, false);

  // キーは DOM・エクスポートのどこにも出ない(末尾4文字のヒントも出さない。
  // オーナー要望 2026-09-23 でヒント表示自体を削除した)
  ctx.render();
  var html = ctx.appElement.innerHTML;
  assert.ok(!html.includes(TEST_KEY), "innerHTML にキーが出ている");
  assert.ok(!html.includes("…" + TEST_KEY.slice(-4)), "削除したはずのキー末尾ヒントがまだ出ている");
  assert.ok(html.includes('id="claude-settings"'), "Claude の設定パネルが出ていない");
  assert.ok(html.includes("API キー(設定済み)"), "折りたたみの見出しに設定済みの状態が出ていない");
  assert.ok(html.includes("claude-opus-5+think") || html.includes("claude-opus-5"), "較正図のモデルフィルタにモデルが出ていない");
  ctx.exportRecords();
  var exported = ctx.createdBlobs[0].parts.join("");
  assert.ok(!exported.includes(TEST_KEY), "エクスポート JSON にキーが出ている");
  assert.ok(exported.includes("claude-opus-5+think"), "エクスポート JSON に m が無い");
});

test("V3: thinking の指定はモデルごとに変わる(Opus/Sonnet: adaptive/disabled、Haiku: enabled+budget/省略)", async () => {
  var ctx = runScript(await getPageHtml(), {});
  ctx.setModelMode("claude");
  var puzzle = ctx.buildSnapshot();

  ctx.setClaudeThinking(false);
  var offBody = ctx.buildClaudeRequest(puzzle, 0, 2);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(offBody.thinking)), { type: "disabled" });
  assert.equal(offBody.max_tokens, 1024, "思考なしは JSON 1 件ぶんの max_tokens");

  ctx.setClaudeModel("claude-sonnet-5");
  ctx.setClaudeThinking(true);
  var sonnetBody = ctx.buildClaudeRequest(puzzle, 0, 2);
  assert.equal(sonnetBody.model, "claude-sonnet-5");
  assert.deepStrictEqual(JSON.parse(JSON.stringify(sonnetBody.thinking)), { type: "adaptive" });
  assert.equal(sonnetBody.max_tokens, 16000, "adaptive は思考ぶんを含めて 16000");

  ctx.setClaudeModel("claude-haiku-4-5");
  var haikuOn = ctx.buildClaudeRequest(puzzle, 0, 2);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(haikuOn.thinking)), { type: "enabled", budget_tokens: 2048 });
  assert.equal(haikuOn.max_tokens, 2048 + 1024, "Haiku の思考ありは budget_tokens ぶん max_tokens を上乗せする");
  ctx.setClaudeThinking(false);
  var haikuOff = ctx.buildClaudeRequest(puzzle, 0, 2);
  assert.ok(!("thinking" in haikuOff), "Haiku の思考なしは thinking を送らない");
  assert.equal(haikuOff.max_tokens, 1024);

  ctx.setClaudeModel("gpt-5"); // 対象外のモデルは無視
  assert.equal(ctx.state.claudeModel, "claude-haiku-4-5");
  assert.equal(ctx.currentModelId(), "claude-haiku-4-5");
  ctx.setClaudeThinking(true);
  assert.equal(ctx.currentModelId(), "claude-haiku-4-5+think");
  ctx.setModelMode("jev");
  assert.equal(ctx.currentModelId(), "typesafe/jev");
});

test("V4: Claude API のエラー(401 / refusal / JSON 不正)はエラーボックスに出て止まり、失敗したリクエストがパネルに残る。ネットワーク失敗は一時的な失敗として停止扱い(Issue #43)", { timeout: 10000 }, async () => {
  // opts.transient: true ならネットワーク失敗など一時的な失敗(Issue #43)として、
  // showError() ではなく pauseForTransientError() での停止(isPaused())を待つ。
  async function runOnce(respond, opts) {
    var transient = opts && opts.transient;
    var af = makeAbortAwareFetch();
    var ctx = runScript(await getPageHtml(), { fetch: af.fetch });
    ctx.saveAnthropicKey(TEST_KEY);
    ctx.setModelMode("claude");
    ctx.run();
    await waitFor(function () {
      return af.pending.length === 1;
    }, "V4: fetch 待ち");
    var entry = af.pending.shift();
    var body = JSON.parse(entry.init.body);
    respond(entry, ctx, body);
    if (transient) {
      await waitFor(function () {
        return ctx.isPaused();
      }, "V4: 一時的な失敗での停止待ち");
      assert.equal(ctx.state.errorMessage, null, "一時的な失敗でエラーボックスが立った");
    } else {
      await waitFor(function () {
        return ctx.state.errorMessage !== null;
      }, "V4: エラー表示待ち");
    }
    assert.equal(ctx.state.running, false);
    assert.equal(af.pending.length, 0, "エラー後に次の fetch が飛んだ");
    assert.deepStrictEqual(JSON.parse(JSON.stringify(ctx.state.lastRequest)), body, "失敗したリクエストが lastRequest に無い");
    assert.equal(ctx.state.lastRequestFailed, true);
    ctx.render();
    assert.ok(ctx.appElement.innerHTML.includes("(このプロンプトで失敗)"));
    assert.ok(!ctx.appElement.innerHTML.includes(TEST_KEY));
    return transient ? ctx.state.pauseReason : ctx.state.errorMessage;
  }

  var msg401 = await runOnce(function (entry) {
    entry.resolve(makeClaudeErrorResponse(401, "invalid x-api-key"));
  });
  assert.ok(msg401.includes("401") && msg401.includes("invalid x-api-key"), "401 の文言: " + msg401);

  var msgRefusal = await runOnce(function (entry, ctx, body) {
    var target = JSON.parse(body.messages[0].content.split("\n")[1]).target;
    var res = makeClaudeResponse(ctx, target.row, target.col);
    var orig = res.json;
    res.json = function () {
      return orig().then(function (data) {
        data.stop_reason = "refusal";
        data.content = [];
        return data;
      });
    };
    entry.resolve(res);
  });
  assert.ok(msgRefusal.includes("refusal"), "refusal の文言: " + msgRefusal);

  var msgBad = await runOnce(function (entry) {
    entry.resolve({
      ok: true,
      status: 200,
      json: function () {
        return Promise.resolve({ stop_reason: "end_turn", content: [{ type: "text", text: "{\"choice\":\"4\"}" }] });
      },
    });
  });
  assert.ok(msgBad.includes("probabilities"), "形式不正の文言: " + msgBad);

  // ネットワーク失敗(fetch が TypeError で reject)は一時的な失敗(Issue #43)。
  var msgNet = await runOnce(function (entry) {
    entry.reject(new TypeError("Failed to fetch"));
  }, { transient: true });
  assert.ok(msgNet.includes("接続できません"), "ネットワークエラーの文言: " + msgNet);
  assert.ok(msgNet.includes("一時的な失敗で停止しました"), "停止理由の文言になっていない: " + msgNet);
});

test("V5: モデル設定は実行中・停止中に変えられず、reset() をまたいで保持され、localStorage から復元される", { timeout: 10000 }, async () => {
  var storage = makeLocalStorage();
  var af = makeAbortAwareFetch();
  var ctx = runScript(await getPageHtml(), { fetch: af.fetch, localStorage: storage });
  ctx.saveAnthropicKey(TEST_KEY);
  ctx.setModelMode("claude");
  ctx.setClaudeModel("claude-sonnet-5");
  ctx.setClaudeThinking(false);
  ctx.run();
  await waitFor(function () {
    return af.pending.length === 1;
  }, "V5: fetch 待ち");
  ctx.setModelMode("jev");
  ctx.setClaudeModel("claude-opus-5");
  ctx.setClaudeThinking(true);
  assert.equal(ctx.state.modelMode, "claude", "実行中にモデルが切り替わった");
  assert.equal(ctx.state.claudeModel, "claude-sonnet-5");
  assert.equal(ctx.state.claudeThinking, false);
  ctx.render();
  assert.ok(/<select id="model-toggle"[^>]*disabled/.test(ctx.appElement.innerHTML), "実行中にモデルトグルが無効化されていない");

  ctx.stop();
  ctx.setModelMode("jev");
  assert.equal(ctx.state.modelMode, "claude", "停止中(周の途中)にモデルが切り替わった");

  ctx.reset();
  assert.equal(ctx.state.modelMode, "claude", "reset() でモデル設定が消えた");
  assert.equal(ctx.state.claudeModel, "claude-sonnet-5");
  ctx.setModelMode("jev");
  assert.equal(ctx.state.modelMode, "jev");
  ctx.setModelMode("claude");

  // 別のページ読み込み(同じ localStorage)で復元される
  var ctx2 = runScript(await getPageHtml(), { localStorage: storage });
  assert.equal(ctx2.state.modelMode, "claude");
  assert.equal(ctx2.state.claudeModel, "claude-sonnet-5");
  assert.equal(ctx2.state.claudeThinking, false);
  assert.equal(ctx2.loadAnthropicKey(), TEST_KEY);
  ctx2.clearAnthropicKey();
  assert.equal(ctx2.loadAnthropicKey(), null);
  assert.equal(storage.getItem("scc.anthropic_key.v1"), null);
  ctx2.render();
  assert.ok(ctx2.appElement.innerHTML.includes("未設定"));
});

test("V6: 較正図のモデルフィルタ: m の無い記録は Jev、選んだモデルの記録だけを集計し、記録に無いモデルは「すべて」扱い", async () => {
  var storage = makeLocalStorage();
  var records = [
    { t: 1, p: "x", r: 0, c: 0, round: 1, choice: "1", pc: 0.5, conf: 0.5, ok: true },
    { t: 2, p: "x", r: 0, c: 1, round: 1, choice: "2", pc: 0.5, conf: 0.5, ok: false, m: "typesafe/jev" },
    { t: 3, p: "y", r: 0, c: 2, round: 1, choice: "3", pc: 0.9, conf: 0.9, ok: true, m: "claude-opus-5+think" },
    { t: 4, p: "y", r: 0, c: 3, round: 1, choice: "4", pc: 0.9, conf: 0.9, ok: true, m: "claude-opus-5+think" },
    { t: 5, p: "z", r: 0, c: 4, round: 1, choice: "5", pc: 0.1, conf: 0.1, ok: false, m: "claude-opus-5+think" },
  ];
  storage.setItem(RECORDS_STORAGE_KEY, JSON.stringify(records));
  var ctx = runScript(await getPageHtml(), { localStorage: storage });
  var html = ctx.appElement.innerHTML;
  assert.ok(html.includes("合計 5 件 / 全体正解率 60%"), "すべて: " + html.match(/合計[^<]*/)[0]);
  assert.ok(html.includes('<option value="claude-opus-5+think"'), "Claude の選択肢が無い");
  assert.ok(html.includes('<option value="typesafe/jev"'), "Jev の選択肢が無い");

  ctx.setCalibModelFilter("claude-opus-5+think");
  html = ctx.appElement.innerHTML;
  assert.ok(html.includes("合計 3 件 / 全体正解率 67% / 記録している問題数 2"), "Claude だけ: " + html.match(/合計[^<]*/)[0]);
  assert.ok(html.includes('<option value="claude-opus-5+think" selected'), "選択状態が反映されていない");

  ctx.setCalibModelFilter("typesafe/jev");
  html = ctx.appElement.innerHTML;
  assert.ok(html.includes("合計 2 件 / 全体正解率 50% / 記録している問題数 1"), "Jev だけ: " + html.match(/合計[^<]*/)[0]);

  ctx.setCalibModelFilter("claude-haiku-4-5");
  html = ctx.appElement.innerHTML;
  assert.ok(html.includes("合計 5 件"), "記録に無いモデルは「すべて」扱いになっていない");
  assert.ok(html.includes('<option value="all" selected'));

  ctx.reset();
  assert.equal(ctx.state.calibModelFilter, "claude-haiku-4-5", "reset() でフィルタが消えた");
});

test("V7: ページ内の NOTE / INSTRUCTIONS は Worker が Jev に渡す文言と同一で、Claude の system はそれを含む", async () => {
  var html = await getPageHtml();
  var ctx = runScript(html, {});
  // Worker 側の定数は export されていないので、AI.run に渡った payload から取る
  var env = makeEnv();
  var req = new Request("https://example.com/api/judge", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ puzzle: hostRows(ctx.buildSnapshot()), target: { row: 0, col: 2 } }),
  });
  var res = await worker.fetch(req, env);
  assert.equal(res.status, 200);
  var data = await res.json();
  assert.equal(ctx.NOTE, data.request.state.note, "ページの NOTE が Worker の note と違う");
  assert.equal(ctx.INSTRUCTIONS, data.request.questions.digit.instructions, "ページの INSTRUCTIONS が Worker の instructions と違う");
  assert.ok(ctx.CLAUDE_SYSTEM.startsWith(ctx.NOTE), "CLAUDE_SYSTEM が NOTE で始まっていない");
});

test("V8: stop_reason が max_tokens ならエラー、content の先頭が thinking ブロックでも text ブロックから JSON を取る", { timeout: 10000 }, async () => {
  async function runOnce(mutate) {
    var af = makeAbortAwareFetch();
    var ctx = runScript(await getPageHtml(), { fetch: af.fetch });
    ctx.saveAnthropicKey(TEST_KEY);
    ctx.setModelMode("claude");
    ctx.run();
    await waitFor(function () {
      return af.pending.length === 1;
    }, "V8: fetch 待ち");
    var entry = af.pending.shift();
    var body = JSON.parse(entry.init.body);
    var target = JSON.parse(body.messages[0].content.split("\n")[1]).target;
    var res = makeClaudeResponse(ctx, target.row, target.col, undefined, body.output_config.format.schema.properties.choice.enum);
    var orig = res.json;
    res.json = function () {
      return orig().then(mutate);
    };
    entry.resolve(res);
    await waitFor(function () {
      return ctx.state.errorMessage !== null || ctx.state.values[target.row + "-" + target.col] !== undefined;
    }, "V8: 結果待ち");
    return ctx;
  }

  var ctxMax = await runOnce(function (data) {
    data.stop_reason = "max_tokens";
    data.content = [{ type: "thinking", thinking: "…", signature: "x" }];
    return data;
  });
  assert.ok(ctxMax.state.errorMessage && ctxMax.state.errorMessage.includes("max_tokens"), "max_tokens の文言: " + ctxMax.state.errorMessage);
  assert.equal(ctxMax.state.running, false);

  var ctxThink = await runOnce(function (data) {
    data.content = [{ type: "thinking", thinking: "…", signature: "x" }].concat(data.content);
    return data;
  });
  assert.equal(ctxThink.state.errorMessage, null, "thinking ブロック付きの応答でエラーになった: " + ctxThink.state.errorMessage);
  assert.equal(ctxThink.getRecords().length, 1, "thinking ブロック付きの応答が確定していない");
});

test("V9: Claude 経路でも reset() が in-flight の fetch を abort し、AbortError はエラー表示にならない", { timeout: 10000 }, async () => {
  var af = makeAbortAwareFetch();
  var ctx = runScript(await getPageHtml(), { fetch: af.fetch });
  ctx.saveAnthropicKey(TEST_KEY);
  ctx.setModelMode("claude");
  ctx.run();
  await waitFor(function () {
    return af.pending.length === 1;
  }, "V9: fetch 待ち");
  var entry = af.pending[0];
  var aborted = false;
  entry.init.signal.addEventListener("abort", function () {
    aborted = true;
  });
  ctx.reset();
  assert.equal(aborted, true, "reset() で Claude 経路の fetch が abort されていない");
  for (var i = 0; i < 20; i++) await tick();
  assert.equal(ctx.state.errorMessage, null, "AbortError がエラー表示に流れた");
  assert.equal(ctx.state.running, false);
  assert.equal(ctx.state.modelMode, "claude", "reset() でモデル設定が消えた");
});

test("V10: 入力欄からの保存は先に入力欄を空にし、キー保存の失敗は判定ループを止めずパネルの注意書きに出る。実行中は「キーを消す」が無効", { timeout: 10000 }, async () => {
  var storage = makeLocalStorage();
  var af = makeAbortAwareFetch();
  var ctx = runScript(await getPageHtml(), { fetch: af.fetch, localStorage: storage });
  ctx.setModelMode("claude");
  var fakeInput = { value: TEST_KEY };
  ctx.document.getElementById = function (id) {
    if (id === "app") return ctx.appElement;
    if (id === "anthropic-key-input") return fakeInput;
    return null;
  };
  ctx.saveAnthropicKeyFromInput();
  assert.equal(fakeInput.value, "", "保存後に入力欄が空になっていない");
  assert.equal(storage.getItem("scc.anthropic_key.v1"), TEST_KEY, "localStorage に保存されていない");
  assert.ok(!ctx.appElement.innerHTML.includes(TEST_KEY));

  // 空の入力は保存しない(注意書きだけ)
  fakeInput.value = "   ";
  ctx.saveAnthropicKeyFromInput();
  assert.equal(storage.getItem("scc.anthropic_key.v1"), TEST_KEY, "空の入力で既存のキーが消えた");
  assert.ok(ctx.appElement.innerHTML.includes("キーが空です"), "空入力の注意書きが出ていない");

  // 実行中に保存が失敗しても判定ループは止まらない
  ctx.run();
  await waitFor(function () {
    return af.pending.length === 1;
  }, "V10: fetch 待ち");
  var originalSetItem = storage.setItem;
  storage.setItem = function (key, value) {
    if (key === "scc.anthropic_key.v1") throw new Error("QuotaExceededError を模す");
    return originalSetItem.call(storage, key, value);
  };
  fakeInput.value = "sk-ant-new-0000000000000000";
  ctx.saveAnthropicKeyFromInput();
  assert.equal(fakeInput.value, "", "失敗時も入力欄は空にする");
  assert.equal(ctx.state.running, true, "キー保存の失敗で判定ループが止まった");
  assert.equal(ctx.state.errorMessage, null, "キー保存の失敗がエラーボックスに出た");
  assert.equal(af.pending.length, 1, "in-flight の fetch が捨てられた");
  assert.ok(ctx.appElement.innerHTML.includes("API キーを保存できません"), "保存失敗の注意書きが出ていない");
  assert.equal(storage.getItem("scc.anthropic_key.v1"), TEST_KEY, "古いキーが消えた");
  storage.setItem = originalSetItem;

  // 実行中は「キーを消す」が無効で、呼んでも消えない
  assert.ok(/id="clear-key-btn"[^>]*disabled/.test(ctx.appElement.innerHTML), "実行中に「キーを消す」が無効化されていない");
  ctx.clearAnthropicKey();
  assert.equal(storage.getItem("scc.anthropic_key.v1"), TEST_KEY, "実行中にキーが消えた");
  ctx.reset();
  ctx.clearAnthropicKey();
  assert.equal(storage.getItem("scc.anthropic_key.v1"), null, "停止後に「キーを消す」が効かない");
});

// -------------------------------------------------------------------
// 確信度順モード(順番トグル、Issue #38)
// -------------------------------------------------------------------

/**
 * ask:"cell"(マス選び)の /api/judge レスポンスのモック。probabilities は keys 全体に
 * 配り、chosenKey の確率をいちばん高くする。request / cell は本物の Worker の形に揃える。
 */
function makeCellResponse(puzzle, keys, chosenKey, overrides) {
  var probabilities = {};
  var criteria = {};
  for (var i = 0; i < keys.length; i++) {
    probabilities[keys[i]] = keys[i] === chosenKey ? 0.5 : 0.5 / Math.max(1, keys.length - 1);
    var m = /^r(\d)c(\d)$/.exec(keys[i]);
    criteria[keys[i]] = "row " + m[1] + ", column " + m[2] + " (zero-based)";
  }
  var cm = /^r(\d)c(\d)$/.exec(chosenKey);
  var body = Object.assign(
    {
      probabilities: probabilities,
      choice: chosenKey,
      confidence: 0.4,
      cell: { row: Number(cm[1]), col: Number(cm[2]) },
      request: {
        state: { puzzle: puzzle, note: "puzzle is a 9x9 Sudoku grid, no target this time (mock)" },
        questions: { cell: { type: "choice", instructions: "Which empty cell...", criteria: criteria } },
      },
    },
    overrides || {}
  );
  return {
    ok: true,
    json: async function () {
      return body;
    },
  };
}

/** Claude 経路のマス選び(askCellClaude)の応答モック。V2 の makeClaudeResponse のマス選び版。 */
function makeClaudeCellResponse(keys, chosenKey, overrides) {
  var probabilities = {};
  for (var i = 0; i < keys.length; i++) {
    probabilities[keys[i]] = keys[i] === chosenKey ? 0.6 : 0.4 / Math.max(1, keys.length - 1);
  }
  var answer = Object.assign({ choice: chosenKey, probabilities: probabilities, confidence: 0.5 }, overrides || {});
  return {
    ok: true,
    status: 200,
    json: function () {
      return Promise.resolve({
        id: "msg_test_cell",
        type: "message",
        role: "assistant",
        model: "claude-opus-5",
        stop_reason: "end_turn",
        content: [{ type: "text", text: JSON.stringify(answer) }],
        usage: { input_tokens: 500, output_tokens: 80 },
      });
    },
  };
}

test("W1: 左上からは従来どおり(1マス1フェッチ、ask を送らない)", { timeout: 10000 }, async () => {
  var af = makeAbortAwareFetch();
  var ctx = runScript(await getPageHtml(), { fetch: af.fetch });
  assert.equal(ctx.state.orderMode, "scan", "既定は左上から");

  ctx.run();
  await waitFor(function () {
    return af.pending.length === 1;
  }, "W1: fetch 待ち");
  var entry = af.pending.shift();
  var body = JSON.parse(entry.init.body);
  assert.equal(body.ask, undefined, "scan モードで ask を送っている");
  assert.ok(body.target, "target が無い(scan モードでは digit を聞くはず)");
  entry.resolve(makeCorrectResponse(ctx, body.target.row, body.target.col, body.puzzle));

  await waitFor(function () {
    return Object.keys(ctx.state.values).length === 1;
  }, "W1: commit 待ち");
  assert.equal(af.pending.length, 0, "scan モードで余計な fetch が飛んでいる(マス選びをしていないはず)");
  assert.equal(ctx.state.selecting, false);
  assert.equal(ctx.state.cellProbs, null);
});

test("W2: 確信度順の1ステップは2フェッチ(マス選び→数字)", { timeout: 10000 }, async () => {
  var af = makeAbortAwareFetch();
  var ctx = runScript(await getPageHtml(), { fetch: af.fetch });
  ctx.setOrderMode("confidence");
  assert.equal(ctx.state.orderMode, "confidence");

  ctx.run();
  await waitFor(function () {
    return af.pending.length === 1;
  }, "W2: マス選びの fetch 待ち");
  assert.equal(ctx.state.selecting, true, "state.selecting が立っていない");
  var selectEntry = af.pending.shift();
  var selectBody = JSON.parse(selectEntry.init.body);
  assert.equal(selectBody.ask, "cell", "1つ目のリクエストが ask:cell でない");
  assert.equal(selectBody.target, undefined, "ask:cell では target を送らない");
  // queue の全マス(1周目なので空マス全部 = TOTAL_EMPTY)が "." になっている
  var emptyCount = selectBody.puzzle.join("").split("").filter(function (ch) {
    return ch === ".";
  }).length;
  assert.equal(emptyCount, ctx.TOTAL_EMPTY, "queue の全マスが . になっていない");

  var keys = ctx.selectionKeys();
  assert.equal(keys.length, ctx.TOTAL_EMPTY);
  var chosenKey = keys[0];
  selectEntry.resolve(makeCellResponse(selectBody.puzzle, keys, chosenKey));

  await waitFor(function () {
    return ctx.state.selecting === false && af.pending.length === 1;
  }, "W2: 数字判定の fetch 待ち");
  assert.ok(ctx.state.cellProbs, "state.cellProbs が入っていない(ヒートマップ用)");
  assert.equal(ctx.state.lastSelection.candidates, ctx.TOTAL_EMPTY);

  var cm = /^r(\d)c(\d)$/.exec(chosenKey);
  var chosenRow = Number(cm[1]);
  var chosenCol = Number(cm[2]);
  assert.equal(ctx.state.focusedKey, chosenRow + "-" + chosenCol, "選ばれたマスにフォーカスが立っていない");
  assert.equal(ctx.queue.length, ctx.TOTAL_EMPTY - 1, "選ばれたマスが queue から取り除かれていない");

  var digitEntry = af.pending.shift();
  var digitBody = JSON.parse(digitEntry.init.body);
  assert.equal(digitBody.ask, undefined, "2つ目のリクエストは digit(ask 省略)のはず");
  assert.deepEqual(digitBody.target, { row: chosenRow, col: chosenCol }, "2つ目のリクエストの target が選ばれたマスでない");
  assert.equal(digitBody.puzzle[chosenRow][chosenCol], ".", "対象マスが空になっていない");
  // 1周目なので他の queue のマスにも前回の推測は無く、まだ全部空のまま
  for (var i = 0; i < ctx.queue.length; i++) {
    var qc = ctx.queue[i];
    assert.equal(digitBody.puzzle[qc.r][qc.c], ".", "1周目なのに他の queue のマスが埋まっている");
  }

  digitEntry.resolve(makeCorrectResponse(ctx, chosenRow, chosenCol, digitBody.puzzle));
  await waitFor(function () {
    return ctx.state.values[chosenRow + "-" + chosenCol] !== undefined;
  }, "W2: commit 待ち");
  assert.equal(ctx.state.cellProbs, null, "commitFocused 後も cellProbs が残っている");
});

test("W3: マス選びの応答の cell が queue に無ければエラーで停止する", { timeout: 10000 }, async () => {
  var af = makeAbortAwareFetch();
  var ctx = runScript(await getPageHtml(), { fetch: af.fetch });
  ctx.setOrderMode("confidence");
  ctx.run();
  await waitFor(function () {
    return af.pending.length === 1;
  }, "W3: fetch 待ち");
  var entry = af.pending.shift();
  var body = JSON.parse(entry.init.body);
  var keys = ctx.selectionKeys();
  var response = makeCellResponse(body.puzzle, keys, keys[0]);
  var raw = await response.json();
  // GIVEN で埋まっているマス(queue に無い)を choice として返す、壊れた応答を模す
  raw.choice = "r0c0";
  raw.cell = { row: 0, col: 0 };
  entry.resolve({
    ok: true,
    json: async function () {
      return raw;
    },
  });

  await waitFor(function () {
    return ctx.state.errorMessage !== null;
  }, "W3: エラー表示待ち");
  assert.ok(
    ctx.state.errorMessage.indexOf("選ばれたマスが候補にありません") === 0,
    "エラー文言が違う: " + ctx.state.errorMessage
  );
  assert.equal(ctx.state.running, false);
  assert.equal(af.pending.length, 0, "エラー後に余計な fetch が残っている");
});

test("W4: マス選び中の stop() は queue の長さを変えず再開はマス選びからやり直す。数字判定中の停止は従来どおり再キュー", { timeout: 10000 }, async () => {
  var af = makeAbortAwareFetch();
  var ctx = runScript(await getPageHtml(), { fetch: af.fetch });
  ctx.setOrderMode("confidence");
  ctx.run();
  await waitFor(function () {
    return af.pending.length === 1;
  }, "W4: マス選びの fetch 待ち");
  var entry = af.pending.shift();
  var queueLenBefore = ctx.queue.length;

  ctx.stop();
  assert.equal(entry.settled, true, "stop() で in-flight の fetch が abort されていない");
  assert.equal(ctx.state.running, false);
  assert.equal(ctx.state.selecting, false, "state.selecting がリセットされていない");
  assert.equal(ctx.state.cellProbs, null, "state.cellProbs がリセットされていない");
  assert.equal(ctx.queue.length, queueLenBefore, "マス選び中の停止で queue の長さが変わっている");

  ctx.run(); // 再開: マス選びからやり直す
  await waitFor(function () {
    return af.pending.length === 1;
  }, "W4: 再開後のマス選びの fetch 待ち");
  var resumedEntry = af.pending[0];
  var resumedBody = JSON.parse(resumedEntry.init.body);
  assert.equal(resumedBody.ask, "cell", "再開後もマス選びから始まっていない");
  assert.equal(ctx.state.selecting, true);

  // マス選びを解決して数字判定フェーズへ進み、そこで stop() すると従来どおり再キューされる
  var keys = ctx.selectionKeys();
  var chosenKey = keys[0];
  resumedEntry.resolve(makeCellResponse(resumedBody.puzzle, keys, chosenKey));
  await waitFor(function () {
    return ctx.state.focusedKey !== null;
  }, "W4: 数字判定フェーズ待ち");
  var digitEntry = af.pending[0];
  var beforeDigitQueueLen = ctx.queue.length;
  var cm = /^r(\d)c(\d)$/.exec(chosenKey);

  ctx.stop();
  assert.equal(digitEntry.settled, true, "数字判定中の stop() で fetch が abort されていない");
  assert.equal(ctx.queue.length, beforeDigitQueueLen + 1, "数字判定中の停止で queue の先頭に戻っていない");
  assert.equal(ctx.queue[0].r, Number(cm[1]));
  assert.equal(ctx.queue[0].c, Number(cm[2]));
});

test("W5: 2周目のマス選びの候補は不正解マスだけで、それらだけが空マスとして送られる", { timeout: 20000 }, async () => {
  var ctx;
  var wrongKey = "0-2"; // GIVEN[0] の最初の空マス(helpers.js の GIVEN と同一の固定問題)
  var askedWrongOnce = false;
  var selectCalls = [];
  var fetchStub = async function (url, init) {
    var body = JSON.parse(init.body);
    if (body.ask === "cell") {
      selectCalls.push(body);
      var keys = ctx.selectionKeys();
      return makeCellResponse(body.puzzle, keys, keys[0]);
    }
    var key = body.target.row + "-" + body.target.col;
    if (key === wrongKey && !askedWrongOnce) {
      askedWrongOnce = true;
      var correctDigit = ctx.SOLUTION[body.target.row][body.target.col];
      var wrongDigit = correctDigit === "1" ? "2" : "1";
      var probabilities = {};
      for (var d = 1; d <= 9; d++) probabilities[String(d)] = String(d) === wrongDigit ? 0.9 : 0.0125;
      return {
        ok: true,
        json: async function () {
          return { probabilities: probabilities, choice: wrongDigit, confidence: 0.5 };
        },
      };
    }
    return makeCorrectResponse(ctx, body.target.row, body.target.col, body.puzzle);
  };
  ctx = runScript(await getPageHtml(), { fetch: fetchStub });
  ctx.setOrderMode("confidence");
  ctx.setSpeed("fast");

  ctx.run();
  await waitFor(function () {
    return ctx.state.done === true;
  }, "W5: 完了待ち");

  assert.equal(ctx.state.roundsToSolve, 2, "2周で完了したことになっていない");
  assert.equal(selectCalls.length, ctx.TOTAL_EMPTY + 1, "マス選びの回数が想定(1周目51回+2周目1回)と違う: " + selectCalls.length);

  var round2Select = selectCalls[ctx.TOTAL_EMPTY]; // 0-indexed: 1周目ぶんの次が2周目の1回
  var dots = [];
  for (var r = 0; r < 9; r++) {
    for (var c = 0; c < 9; c++) {
      if (round2Select.puzzle[r][c] === ".") dots.push(r + "-" + c);
    }
  }
  assert.deepEqual(dots, [wrongKey], "2周目のマス選びの候補が不正解マスだけになっていない: " + JSON.stringify(dots));

  // 周回ログは round/correct/total の集計自体は従来どおり(表示は Issue #55 で
  // { round, correct, total, ms, cost, m } の構造体に変わった。AA2 で書式を検証する)
  assert.equal(ctx.state.roundLog.length, 2, "周回ログが2行でない");
  assert.equal(ctx.state.roundLog[0].round, 1);
  assert.equal(ctx.state.roundLog[0].correct, 50);
  assert.equal(ctx.state.roundLog[0].total, 51);
  assert.match(ctx.formatRoundLogLine(ctx.state.roundLog[0]), /^1周目: 51中50正解 \(98%\) — /, "1周目のログ形式が違う: " + ctx.formatRoundLogLine(ctx.state.roundLog[0]));
  assert.equal(ctx.state.roundLog[1].round, 2);
  assert.equal(ctx.state.roundLog[1].correct, 1);
  assert.equal(ctx.state.roundLog[1].total, 1);
  assert.match(ctx.formatRoundLogLine(ctx.state.roundLog[1]), /^2周目: 1中1正解 \(100%\) — /, "2周目のログ形式が違う: " + ctx.formatRoundLogLine(ctx.state.roundLog[1]));
});

test("W6: Claude 経路の確信度順マス選び(スキーマの候補キーと system の CELL_NOTE)", { timeout: 10000 }, async () => {
  var af = makeAbortAwareFetch();
  var ctx = runScript(await getPageHtml(), { fetch: af.fetch });
  assert.equal(ctx.saveAnthropicKey(TEST_KEY), true);
  ctx.setModelMode("claude");
  ctx.setOrderMode("confidence");

  ctx.run();
  await waitFor(function () {
    return af.pending.length === 1;
  }, "W6: マス選びの fetch 待ち");
  var entry = af.pending.shift();
  assert.equal(entry.url, ANTHROPIC_URL, "呼び先が api.anthropic.com でない");
  var body = JSON.parse(entry.init.body);
  var keys = ctx.selectionKeys();
  // ctx.selectionKeys() は vm レルムの配列を返すので、host 側の配列に移し替えてから比較する
  // (hostRows と同じ理由。test/page.test.js の runScript のコメント参照)。
  var hostKeys = Array.prototype.slice.call(keys).map(String);
  assert.deepStrictEqual(body.output_config.format.schema.properties.choice.enum, hostKeys, "スキーマの choice.enum が候補キーと一致しない");
  assert.deepStrictEqual(body.output_config.format.schema.properties.probabilities.required, hostKeys, "スキーマの probabilities.required が候補キーと一致しない");
  assert.ok(typeof body.system === "string" && body.system.indexOf("no target cell this time") !== -1, "system が CELL_NOTE を含んでいない");
  var content = body.messages[0].content;
  var sent = JSON.parse(content.slice(content.indexOf("\n") + 1));
  assert.ok(!Object.prototype.hasOwnProperty.call(sent, "target"), "ask:cell 相当なのに target を送っている");
  assert.deepStrictEqual(hostRows(sent.puzzle), hostRows(ctx.buildSelectionSnapshot()), "盤面が buildSelectionSnapshot() と一致しない");

  var chosenKey = keys[0];
  entry.resolve(makeClaudeCellResponse(keys, chosenKey));
  await waitFor(function () {
    return ctx.state.focusedKey !== null;
  }, "W6: 選択後のフォーカス待ち");
  var cm = /^r(\d)c(\d)$/.exec(chosenKey);
  assert.equal(ctx.state.focusedKey, Number(cm[1]) + "-" + Number(cm[2]), "選ばれたマスにフォーカスが立っていない(Claude 経路)");
});

test("W7: 確信度順でヒートマップの背景と『マス選び: N候補中』がパネルに出る。順番トグルは実行中ロックされる", { timeout: 10000 }, async () => {
  var af = makeAbortAwareFetch();
  var ctx = runScript(await getPageHtml(), { fetch: af.fetch });
  ctx.setOrderMode("confidence");

  ctx.run();
  await waitFor(function () {
    return af.pending.length === 1;
  }, "W7: マス選びの fetch 待ち");
  var entry = af.pending.shift();
  var body = JSON.parse(entry.init.body);
  var keys = ctx.selectionKeys();
  var chosenKey = keys[0];
  entry.resolve(makeCellResponse(body.puzzle, keys, chosenKey));

  await waitFor(function () {
    return ctx.state.focusedKey !== null;
  }, "W7: 選択後のフォーカス待ち");
  ctx.render();
  var html = ctx.appElement.innerHTML;
  assert.ok(html.indexOf("rgba(125, 211, 252") !== -1, "ヒートマップの背景が出ていない");
  assert.ok(html.indexOf("マス選び:") !== -1 && html.indexOf("候補") !== -1, "『マス選び: N候補中』がパネルに出ていない");
  assert.ok(html.indexOf("背景の濃さ") !== -1, "凡例にヒートマップの説明が出ていない");

  // 実行中は順番トグルが無効(Issue #76 でプルダウン化。select 自体に disabled が付く)
  var orderToggleMatch = html.match(/<select id="order-toggle"[^>]*>/);
  assert.ok(orderToggleMatch, "order-toggle が描画されていない");
  assert.ok(orderToggleMatch[0].indexOf("disabled") !== -1, "実行中に順番トグルが無効化されていない");
});

test("W8: プロンプト枠は「マス選び」「数字」の2段で、マス選びの失敗(502 の request / abort)を正しく扱う", { timeout: 10000 }, async () => {
  // 2段表示と lastCellRequest
  var af = makeAbortAwareFetch();
  var ctx = runScript(await getPageHtml(), { fetch: af.fetch });
  ctx.setOrderMode("confidence");
  ctx.run();
  await waitFor(function () {
    return af.pending.length === 1;
  }, "W8: マス選びの fetch 待ち");
  var selectEntry = af.pending.shift();
  var selectBody = JSON.parse(selectEntry.init.body);
  var keys = ctx.selectionKeys();
  var cellRes = makeCellResponse(selectBody.puzzle, keys, keys[0]);
  var cellJson = await cellRes.json();
  selectEntry.resolve(makeCellResponse(selectBody.puzzle, keys, keys[0]));
  await waitFor(function () {
    return ctx.state.selecting === false && af.pending.length === 1;
  }, "W8: 数字判定の fetch 待ち");
  assert.deepStrictEqual(JSON.parse(JSON.stringify(ctx.state.lastCellRequest)), JSON.parse(JSON.stringify(cellJson.request)), "lastCellRequest がマス選びの request と一致しない");
  var digitEntry = af.pending.shift();
  var digitBody = JSON.parse(digitEntry.init.body);
  digitEntry.resolve(makeCorrectResponse(ctx, digitBody.target.row, digitBody.target.col, digitBody.puzzle));
  await waitFor(function () {
    return ctx.state.lastRequest !== null;
  }, "W8: lastRequest 待ち");
  ctx.render();
  var html = ctx.appElement.innerHTML;
  // プロンプト枠は周回ログの後ろに回した(Issue #76)ので、次の較正パネルまでで区切る
  var panel = html.slice(html.indexOf('id="prompt-panel"'), html.indexOf('id="calibration-panel"'));
  assert.ok(panel.indexOf("マス選び") !== -1 && panel.indexOf("数字") !== -1, "プロンプト枠に「マス選び」「数字」の見出しが無い");
  assert.equal((panel.match(/<pre class="prompt-json">/g) || []).length, 2, "プロンプト枠の <pre> が2つでない");
  assert.ok(panel.indexOf("Which empty cell") !== -1, "マス選びの instructions が出ていない");
  assert.ok(panel.indexOf("Which digit from 1 to 9") !== -1, "数字の instructions が出ていない");

  // マス選びの 502: request がパネルに残り、エラーで止まる
  var af2 = makeAbortAwareFetch();
  var ctx2 = runScript(await getPageHtml(), { fetch: af2.fetch });
  ctx2.setOrderMode("confidence");
  ctx2.run();
  await waitFor(function () {
    return af2.pending.length === 1;
  }, "W8: 2回目のマス選びの fetch 待ち");
  var failedRequest = { state: { puzzle: ["........."], note: "x" }, questions: { cell: { type: "choice", instructions: "y", criteria: {} } } };
  af2.pending.shift().resolve({
    ok: false,
    status: 502,
    json: function () {
      return Promise.resolve({ error: "AIの呼び出しに失敗しました", raw: "boom", request: failedRequest });
    },
  });
  await waitFor(function () {
    return ctx2.state.errorMessage !== null;
  }, "W8: エラー表示待ち");
  assert.equal(ctx2.state.running, false);
  assert.equal(ctx2.state.selecting, false, "エラー後も selecting が立ったまま");
  assert.deepStrictEqual(JSON.parse(JSON.stringify(ctx2.state.lastCellRequest)), failedRequest, "失敗したマス選びの request が残っていない");
  assert.equal(ctx2.queue.length, ctx2.TOTAL_EMPTY, "エラー時に queue が変わった");

  // マス選び中の reset(): abort され、AbortError はエラー表示にならない
  var af3 = makeAbortAwareFetch();
  var ctx3 = runScript(await getPageHtml(), { fetch: af3.fetch });
  ctx3.setOrderMode("confidence");
  ctx3.run();
  await waitFor(function () {
    return af3.pending.length === 1;
  }, "W8: 3回目のマス選びの fetch 待ち");
  var entry3 = af3.pending[0];
  ctx3.reset();
  assert.equal(entry3.settled, true, "reset() でマス選びの fetch が abort されていない");
  for (var i = 0; i < 20; i++) await tick();
  assert.equal(ctx3.state.errorMessage, null, "AbortError がエラー表示に流れた");
  assert.equal(ctx3.state.selecting, false);
  assert.equal(ctx3.state.cellProbs, null);
});

test("W9: 2周目の数字判定はフォーカスのマスだけ空で、他の候補(前の周の不正解)は推測を残したまま送る(確信度順)", { timeout: 20000 }, async () => {
  var ctx;
  var wrongKeys = { "0-2": true, "0-3": true };
  var wrongAsked = {};
  var wrongDigits = {};
  var digitBodies = [];
  var fetchStub = async function (url, init) {
    var body = JSON.parse(init.body);
    if (body.ask === "cell") {
      var keys = [];
      for (var r = 0; r < 9; r++) for (var c = 0; c < 9; c++) if (body.puzzle[r][c] === ".") keys.push("r" + r + "c" + c);
      return makeCellResponse(body.puzzle, keys, keys[0]);
    }
    var key = body.target.row + "-" + body.target.col;
    digitBodies.push({ key: key, puzzle: body.puzzle.slice(), round: ctx.state.round });
    if (wrongKeys[key] && !wrongAsked[key]) {
      wrongAsked[key] = true;
      var correctDigit = ctx.SOLUTION[body.target.row][body.target.col];
      var wrongDigit = correctDigit === "1" ? "2" : "1";
      wrongDigits[key] = wrongDigit;
      var probabilities = {};
      for (var d = 1; d <= 9; d++) probabilities[String(d)] = String(d) === wrongDigit ? 0.9 : 0.0125;
      return { ok: true, json: async function () { return { probabilities: probabilities, choice: wrongDigit, confidence: 0.5 }; } };
    }
    return makeCorrectResponse(ctx, body.target.row, body.target.col, body.puzzle);
  };
  ctx = runScript(await getPageHtml(), { fetch: fetchStub });
  ctx.setOrderMode("confidence");
  ctx.setSpeed("fast");
  ctx.run();
  await waitFor(function () {
    return ctx.state.done === true;
  }, "W9: 完了待ち");
  assert.equal(ctx.state.roundsToSolve, 2);
  // 2周目の最初の数字判定(候補は 0-2 と 0-3。マス選びは先頭 r0c2 を選ぶ)
  var round2 = digitBodies.filter(function (b) { return b.round === 2; });
  assert.equal(round2.length, 2, "2周目の数字判定が2回でない: " + round2.length);
  assert.equal(round2[0].key, "0-2");
  assert.equal(round2[0].puzzle[0][2], ".", "フォーカスのマスが空でない");
  assert.equal(round2[0].puzzle[0][3], wrongDigits["0-3"], "フォーカス外の候補マスに前の周の推測が残っていない(SPEC F3)");
  // 2周目の2回目(0-3)のときは 0-2 は既に正解で埋まっている
  assert.equal(round2[1].key, "0-3");
  assert.equal(round2[1].puzzle[0][3], ".");
  assert.equal(round2[1].puzzle[0][2], ctx.SOLUTION[0][2]);
});

test("W10: 順番トグルは停止中もロックされ、reset() / newPuzzle() をまたいで保持される", { timeout: 10000 }, async () => {
  var af = makeAbortAwareFetch();
  var ctx = runScript(await getPageHtml(), { fetch: af.fetch });
  ctx.setOrderMode("confidence");
  ctx.run();
  await waitFor(function () {
    return af.pending.length === 1;
  }, "W10: fetch 待ち");
  ctx.stop();
  assert.equal(ctx.isPaused(), true);
  ctx.setOrderMode("scan");
  assert.equal(ctx.state.orderMode, "confidence", "停止中に順番が切り替わった");
  ctx.render();
  assert.ok(/<select id="order-toggle"[^>]*disabled/.test(ctx.appElement.innerHTML), "停止中に順番トグルが無効化されていない");
  ctx.reset();
  assert.equal(ctx.state.orderMode, "confidence", "reset() で順番が消えた");
  ctx.newPuzzle();
  await waitFor(function () {
    return ctx.generating === false;
  }, "W10: 生成待ち");
  assert.equal(ctx.state.orderMode, "confidence", "newPuzzle() で順番が消えた");
  ctx.setOrderMode("scan");
  assert.equal(ctx.state.orderMode, "scan");
});

// -------------------------------------------------------------------
// 一時的な失敗 → 停止(Issue #43、SPEC F5)。Claude 経路の 429/529/5xx・
// ネットワーク失敗、Jev 経路(Worker)の 429/503 は showError() ではなく
// pauseForTransientError() で停止扱いになり、盤面・周回ログ・queue を保ったまま
// isPaused() が true になって run() で再開できる。
// -------------------------------------------------------------------

test("Y1: Claude の 429 は停止扱いになる(errorMessage は立たず、盤面/queue/記録が保たれ、run() で再開すると同じマスをもう一度聞く)", { timeout: 10000 }, async () => {
  var af = makeAbortAwareFetch();
  var ctx = runScript(await getPageHtml(), { fetch: af.fetch });
  ctx.saveAnthropicKey(TEST_KEY);
  ctx.setModelMode("claude");
  ctx.run();
  // 先に 3 マスを正常に確定させてから 429 にする(「途中まで埋まった盤面・統計・記録が
  // 捨てられない」ことを空でない状態で検証するため。レビュー S2)
  for (var i = 0; i < 3; i++) {
    await waitFor(function () {
      return af.pending.length === 1;
    }, "Y1: " + (i + 1) + "マス目の fetch 待ち");
    var okEntry = af.pending.shift();
    var okBody = JSON.parse(okEntry.init.body);
    var okContent = okBody.messages[0].content;
    var okTarget = JSON.parse(okContent.slice(okContent.indexOf("\n") + 1)).target;
    okEntry.resolve(makeClaudeResponse(ctx, okTarget.row, okTarget.col, undefined, okBody.output_config.format.schema.properties.choice.enum));
    await waitFor(function () {
      return ctx.state.values[okTarget.row + "-" + okTarget.col] !== undefined;
    }, "Y1: " + (i + 1) + "マス目の確定待ち");
  }
  await waitFor(function () {
    return af.pending.length === 1;
  }, "Y1: fetch 待ち");
  var entry = af.pending.shift();
  var body = JSON.parse(entry.init.body);
  var content = body.messages[0].content;
  var sent = JSON.parse(content.slice(content.indexOf("\n") + 1));
  var target = sent.target;
  var recordsBefore = ctx.getRecords().length;
  var roundLogBefore = ctx.state.roundLog.slice();
  var valuesBefore = Object.keys(ctx.state.values).length;
  var roundBefore = ctx.state.round;
  var roundTallyBefore = JSON.parse(JSON.stringify(ctx.roundTally));
  var queueLenBefore = ctx.queue.length;
  assert.equal(valuesBefore, 3, "前提: 3 マス確定している");
  assert.equal(recordsBefore, 3, "前提: 記録が 3 件ある");

  entry.resolve({
    ok: false,
    status: 429,
    json: function () {
      return Promise.resolve({ type: "error", error: { type: "rate_limit_error", message: "Number of request tokens has exceeded your per-minute rate limit" } });
    },
  });

  await waitFor(function () {
    return ctx.isPaused();
  }, "Y1: 停止待ち");
  assert.equal(ctx.state.errorMessage, null, "429 でエラーボックスが立った");
  assert.equal(ctx.state.running, false);
  assert.ok(ctx.state.pauseReason && ctx.state.pauseReason.indexOf("429") !== -1, "pauseReason に 429 が含まれない: " + ctx.state.pauseReason);
  assert.equal(af.pending.length, 0, "停止後に次の fetch が飛んだ");

  // 盤面・周回ログ・queue・記録は保たれ、判定中だったマスが queue の先頭に戻る
  assert.equal(Object.keys(ctx.state.values).length, valuesBefore, "state.values が変わった");
  assert.deepStrictEqual(ctx.state.roundLog, roundLogBefore, "roundLog が変わった");
  assert.equal(ctx.state.round, roundBefore, "state.round が変わった");
  assert.deepStrictEqual(JSON.parse(JSON.stringify(ctx.roundTally)), roundTallyBefore, "roundTally が変わった");
  assert.equal(ctx.getRecords().length, recordsBefore, "判定が確定していないのに記録が増えた");
  assert.equal(ctx.queue.length, queueLenBefore + 1, "判定中だったマスが queue に戻っていない");
  assert.equal(ctx.queue[0].r, target.row, "queue の先頭行が判定中のマスでない");
  assert.equal(ctx.queue[0].c, target.col, "queue の先頭列が判定中のマスでない");
  assert.equal(ctx.state.focusedKey, null);
  assert.equal(ctx.state.lastRequestFailed, true, "lastRequestFailed が true になっていない");
  assert.deepStrictEqual(JSON.parse(JSON.stringify(ctx.state.lastRequest)), body);

  // run() で再開すると pauseReason が消え、同じマスの fetch がもう一度飛ぶ
  ctx.run();
  assert.equal(ctx.state.pauseReason, null, "run() で pauseReason が消えていない");
  await waitFor(function () {
    return af.pending.length === 1;
  }, "Y1: 再開後の fetch 待ち");
  var resumedBody = JSON.parse(af.pending[0].init.body);
  var resumedContent = resumedBody.messages[0].content;
  var resumedSent = JSON.parse(resumedContent.slice(resumedContent.indexOf("\n") + 1));
  assert.equal(resumedSent.target.row, target.row, "再開後に別のマスを聞いている(行)");
  assert.equal(resumedSent.target.col, target.col, "再開後に別のマスを聞いている(列)");
});

test("Y2: Claude の 529/500 は停止扱い(429/ネットワーク失敗は Y1/V4 で確認済み)。401/refusal/形式不正は従来どおりエラー(V4)", { timeout: 10000 }, async () => {
  async function runOnceTransient(status) {
    var af = makeAbortAwareFetch();
    var ctx = runScript(await getPageHtml(), { fetch: af.fetch });
    ctx.saveAnthropicKey(TEST_KEY);
    ctx.setModelMode("claude");
    ctx.run();
    await waitFor(function () {
      return af.pending.length === 1;
    }, "Y2: fetch 待ち(" + status + ")");
    af.pending.shift().resolve(makeClaudeErrorResponse(status, "overloaded"));
    await waitFor(function () {
      return ctx.isPaused();
    }, "Y2: 停止待ち(" + status + ")");
    assert.equal(ctx.state.errorMessage, null, status + " でエラーボックスが立った");
    assert.ok(ctx.state.pauseReason && ctx.state.pauseReason.indexOf(String(status)) !== -1, status + ": pauseReason に含まれない: " + ctx.state.pauseReason);
  }
  await runOnceTransient(529);
  await runOnceTransient(500);
});

test("Y3: Jev の 429(Retry-After ヘッダー)/503 は停止扱い。400/502 は従来どおりエラー", { timeout: 10000 }, async () => {
  var af = makeAbortAwareFetch();
  var ctx = runScript(await getPageHtml(), { fetch: af.fetch });
  ctx.run();
  await waitFor(function () {
    return af.pending.length === 1;
  }, "Y3: fetch 待ち(429)");
  af.pending.shift().resolve({
    ok: false,
    status: 429,
    headers: { get: function (name) { return name === "Retry-After" ? "30" : null; } },
    json: function () {
      return Promise.resolve({ error: "アクセス元(IP)ごとのレート制限(120回/3600秒)を超えました" });
    },
  });
  await waitFor(function () {
    return ctx.isPaused();
  }, "Y3: 429 の停止待ち");
  assert.equal(ctx.state.errorMessage, null, "429 でエラーボックスが立った");
  assert.ok(ctx.state.pauseReason && ctx.state.pauseReason.indexOf("30") !== -1, "pauseReason に Retry-After の秒数(30)が含まれない: " + ctx.state.pauseReason);

  // 503(カウンタ障害)も停止扱い
  var af2 = makeAbortAwareFetch();
  var ctx2 = runScript(await getPageHtml(), { fetch: af2.fetch });
  ctx2.run();
  await waitFor(function () {
    return af2.pending.length === 1;
  }, "Y3: fetch 待ち(503)");
  af2.pending.shift().resolve({
    ok: false,
    status: 503,
    headers: { get: function () { return "60"; } },
    json: function () {
      return Promise.resolve({ error: "レート制限の記録に失敗しました。しばらくしてから再試行してください" });
    },
  });
  await waitFor(function () {
    return ctx2.isPaused();
  }, "Y3: 503 の停止待ち");
  assert.equal(ctx2.state.errorMessage, null, "503 でエラーボックスが立った");
  assert.ok(ctx2.state.pauseReason, "503 で pauseReason が立っていない");

  // 400(request 無し)は従来どおりエラー
  var af3 = makeAbortAwareFetch();
  var ctx3 = runScript(await getPageHtml(), { fetch: af3.fetch });
  ctx3.run();
  await waitFor(function () {
    return af3.pending.length === 1;
  }, "Y3: fetch 待ち(400)");
  af3.pending.shift().resolve({
    ok: false,
    status: 400,
    json: function () {
      return Promise.resolve({ error: "入力が不正です" });
    },
  });
  await waitFor(function () {
    return ctx3.state.errorMessage !== null;
  }, "Y3: 400 のエラー待ち");
  assert.equal(ctx3.isPaused(), false, "400 が停止扱いになった");

  // 502(request 付き)も従来どおりエラー
  var af4 = makeAbortAwareFetch();
  var ctx4 = runScript(await getPageHtml(), { fetch: af4.fetch });
  ctx4.run();
  await waitFor(function () {
    return af4.pending.length === 1;
  }, "Y3: fetch 待ち(502)");
  af4.pending.shift().resolve({
    ok: false,
    status: 502,
    json: function () {
      return Promise.resolve({ error: "AIの呼び出しに失敗しました", raw: "boom" });
    },
  });
  await waitFor(function () {
    return ctx4.state.errorMessage !== null;
  }, "Y3: 502 のエラー待ち");
  assert.equal(ctx4.isPaused(), false, "502 が停止扱いになった");
});

test("Y4: 確信度順のマス選び中の Jev 429 も停止扱い(queue は変わらず、再開はマス選びからやり直す)", { timeout: 10000 }, async () => {
  var af = makeAbortAwareFetch();
  var ctx = runScript(await getPageHtml(), { fetch: af.fetch });
  ctx.setOrderMode("confidence");
  ctx.run();
  await waitFor(function () {
    return af.pending.length === 1;
  }, "Y4: マス選びの fetch 待ち");
  var entry = af.pending.shift();
  var queueLenBefore = ctx.queue.length;

  entry.resolve({
    ok: false,
    status: 429,
    headers: { get: function (name) { return name === "Retry-After" ? "15" : null; } },
    json: function () {
      return Promise.resolve({ error: "アクセス元(IP)ごとのレート制限(120回/3600秒)を超えました" });
    },
  });

  await waitFor(function () {
    return ctx.isPaused();
  }, "Y4: 停止待ち");
  assert.equal(ctx.state.errorMessage, null, "429 でエラーボックスが立った");
  assert.ok(ctx.state.pauseReason && ctx.state.pauseReason.indexOf("15") !== -1, "pauseReason に Retry-After の秒数(15)が含まれない: " + ctx.state.pauseReason);
  assert.equal(ctx.state.selecting, false, "state.selecting がリセットされていない");
  assert.equal(ctx.state.cellProbs, null, "state.cellProbs がリセットされていない");
  assert.equal(ctx.queue.length, queueLenBefore, "マス選び中の一時的な失敗で queue の長さが変わった");

  // run() で再開するとマス選びからやり直す
  ctx.run();
  await waitFor(function () {
    return af.pending.length === 1;
  }, "Y4: 再開後のマス選びの fetch 待ち");
  var resumedBody = JSON.parse(af.pending[0].init.body);
  assert.equal(resumedBody.ask, "cell", "再開後もマス選びから始まっていない");
  assert.equal(ctx.state.selecting, true);
  assert.equal(ctx.state.pauseReason, null);
});

test("Y5: renderCurrentPanel() は一時的な失敗の理由を pause-reason の箱で出し、手動 stop() では出ない。postStatus() にも pauseReason が乗る", { timeout: 10000 }, async () => {
  var af = makeAbortAwareFetch();
  var ctx = runScript(await getPageHtml(), { fetch: af.fetch });

  // 手動停止では理由が出ない
  ctx.run();
  await waitFor(function () {
    return af.pending.length === 1;
  }, "Y5: fetch 待ち");
  ctx.stop();
  assert.equal(ctx.isPaused(), true);
  assert.equal(ctx.state.pauseReason, null);
  ctx.render();
  var htmlManual = ctx.appElement.innerHTML;
  assert.ok(htmlManual.indexOf("停止中(残り") !== -1, "停止中の表示が無い");
  assert.ok(htmlManual.indexOf('class="pause-reason"') === -1, "手動停止で pause-reason の箱が出ている");
  af.pending.shift(); // stop() で abort 済み(settled)の1件目を片付ける

  // 一時的な失敗による停止では理由が出る
  ctx.run();
  await waitFor(function () {
    return af.pending.length === 1;
  }, "Y5: 再開後の fetch 待ち");
  af.pending.shift().resolve({
    ok: false,
    status: 429,
    headers: { get: function (name) { return name === "Retry-After" ? "42" : null; } },
    json: function () {
      return Promise.resolve({ error: "アクセス元(IP)ごとのレート制限(120回/3600秒)を超えました" });
    },
  });
  await waitFor(function () {
    return ctx.isPaused() && ctx.state.pauseReason !== null;
  }, "Y5: 一時的な失敗での停止待ち");
  ctx.render();
  var htmlTransient = ctx.appElement.innerHTML;
  assert.ok(htmlTransient.indexOf('class="pause-reason"') !== -1, "pause-reason の箱が出ていない");
  assert.ok(htmlTransient.indexOf("42") !== -1, "pause-reason の中身(42秒)が出ていない");

  // postStatus(): embed モードなら status に pauseReason が乗る
  var parentCalls = [];
  var fakeParent = { postMessage: function (data) { parentCalls.push(data); } };
  var fakeWindow = { parent: fakeParent, addEventListener: function () {}, postMessage: function () {} };
  var ctxEmbed = runScript(await getPageHtml(), {
    fetch: af.fetch,
    location: { pathname: "/", search: "?embed=1", origin: "https://example.com" },
    window: fakeWindow,
  });
  ctxEmbed.state.pauseReason = "一時的な失敗で停止しました: テスト";
  ctxEmbed.render();
  var lastStatus = parentCalls[parentCalls.length - 1];
  assert.equal(lastStatus.type, "status");
  assert.equal(lastStatus.pauseReason, "一時的な失敗で停止しました: テスト", "postStatus() に pauseReason が乗っていない");

  // 比較シェルの見出し(compareStatusText): paused && pauseReason なら「停止中(一時的な失敗)」
  assert.equal(ctx.compareStatusText({ paused: true, pauseReason: "x" }), "停止中(一時的な失敗)");
  assert.equal(ctx.compareStatusText({ paused: true, pauseReason: null }), "停止中");
});

test("Y6: Jev の 429 で Retry-After が無い・空文字のときは秒数を出さない(0秒後と出ない)", { timeout: 10000 }, async () => {
  var cases = [
    { name: "ヘッダー無し", headers: { get: function () { return null; } } },
    { name: "空文字", headers: { get: function (name) { return name === "Retry-After" ? "" : null; } } },
    { name: "HTTP 日付", headers: { get: function (name) { return name === "Retry-After" ? "Wed, 21 Oct 2026 07:28:00 GMT" : null; } } },
    { name: "headers 無し", headers: undefined },
  ];
  for (var i = 0; i < cases.length; i++) {
    var af = makeAbortAwareFetch();
    var ctx = runScript(await getPageHtml(), { fetch: af.fetch });
    ctx.run();
    await waitFor(function () {
      return af.pending.length === 1;
    }, "Y6: fetch 待ち(" + cases[i].name + ")");
    var res = {
      ok: false,
      status: 429,
      json: function () {
        return Promise.resolve({ error: "アクセス元(IP)ごとのレート制限(120回/3600秒)を超えました" });
      },
    };
    if (cases[i].headers) res.headers = cases[i].headers;
    af.pending.shift().resolve(res);
    await waitFor(function () {
      return ctx.isPaused();
    }, "Y6: 停止待ち(" + cases[i].name + ")");
    assert.equal(ctx.state.errorMessage, null, cases[i].name + ": エラーボックスが立った");
    assert.ok(ctx.state.pauseReason && ctx.state.pauseReason.indexOf("レート制限") !== -1, cases[i].name + ": pauseReason に理由が無い: " + ctx.state.pauseReason);
    assert.ok(ctx.state.pauseReason.indexOf("秒後") === -1, cases[i].name + ": Retry-After が無いのに秒数が出ている: " + ctx.state.pauseReason);
  }
});

test("Y7: 確信度順でマス選びは成功し数字判定が 429 のときも停止扱い。選ばれたマスは queue に戻り、再開はマス選びからやり直す", { timeout: 10000 }, async () => {
  var af = makeAbortAwareFetch();
  var ctx = runScript(await getPageHtml(), { fetch: af.fetch });
  ctx.setOrderMode("confidence");
  ctx.run();
  await waitFor(function () {
    return af.pending.length === 1;
  }, "Y7: マス選びの fetch 待ち");
  var selectEntry = af.pending.shift();
  var selectBody = JSON.parse(selectEntry.init.body);
  var keys = ctx.selectionKeys();
  var chosenKey = keys[0];
  var queueLenBefore = ctx.queue.length;
  selectEntry.resolve(makeCellResponse(selectBody.puzzle, keys, chosenKey));

  await waitFor(function () {
    return ctx.state.selecting === false && af.pending.length === 1;
  }, "Y7: 数字判定の fetch 待ち");
  assert.equal(ctx.queue.length, queueLenBefore - 1, "選ばれたマスが queue から取り除かれていない");
  var cm = /^r(\d)c(\d)$/.exec(chosenKey);
  var chosenRow = Number(cm[1]);
  var chosenCol = Number(cm[2]);
  assert.equal(ctx.state.focusedKey, chosenRow + "-" + chosenCol);

  af.pending.shift().resolve({
    ok: false,
    status: 429,
    headers: { get: function (name) { return name === "Retry-After" ? "30" : null; } },
    json: function () {
      return Promise.resolve({ error: "アクセス元(IP)ごとのレート制限(120回/3600秒)を超えました" });
    },
  });
  await waitFor(function () {
    return ctx.isPaused();
  }, "Y7: 停止待ち");
  assert.equal(ctx.state.errorMessage, null, "429 でエラーボックスが立った");
  assert.ok(ctx.state.pauseReason && ctx.state.pauseReason.indexOf("30") !== -1, "pauseReason に Retry-After の秒数(30)が無い: " + ctx.state.pauseReason);
  assert.equal(ctx.state.focusedKey, null);
  assert.equal(ctx.state.cellProbs, null, "state.cellProbs がリセットされていない");
  assert.equal(ctx.queue.length, queueLenBefore, "判定中だったマスが queue に戻っていない");
  assert.equal(ctx.queue[0].r, chosenRow, "queue の先頭が判定中だったマスでない(行)");
  assert.equal(ctx.queue[0].c, chosenCol, "queue の先頭が判定中だったマスでない(列)");
  assert.equal(ctx.state.values[chosenRow + "-" + chosenCol], undefined, "確定していないのに盤面に値が入った");
  assert.equal(ctx.getRecords().length, 0, "確定していないのに記録が増えた");

  // 再開はマス選びからやり直し、戻したマスも候補("."、キーに含まれる)に入る
  ctx.run();
  await waitFor(function () {
    return af.pending.length === 1;
  }, "Y7: 再開後のマス選びの fetch 待ち");
  var resumedBody = JSON.parse(af.pending[0].init.body);
  assert.equal(resumedBody.ask, "cell", "再開後にマス選びから始まっていない");
  assert.equal(resumedBody.puzzle[chosenRow][chosenCol], ".", "戻したマスが候補として空になっていない");
  assert.ok(Array.prototype.slice.call(ctx.selectionKeys()).indexOf(chosenKey) !== -1, "戻したマスが候補キーに無い");
  assert.equal(ctx.state.pauseReason, null);
});

test("Y8: Claude 経路の確信度順マス選び(askCellClaude)の 529 も停止扱い(queue は変わらず、再開はマス選びからやり直す)", { timeout: 10000 }, async () => {
  var af = makeAbortAwareFetch();
  var ctx = runScript(await getPageHtml(), { fetch: af.fetch });
  assert.equal(ctx.saveAnthropicKey(TEST_KEY), true);
  ctx.setModelMode("claude");
  ctx.setOrderMode("confidence");
  ctx.run();
  await waitFor(function () {
    return af.pending.length === 1;
  }, "Y8: マス選びの fetch 待ち");
  var entry = af.pending.shift();
  assert.equal(entry.url, ANTHROPIC_URL);
  var body = JSON.parse(entry.init.body);
  var queueLenBefore = ctx.queue.length;
  entry.resolve({
    ok: false,
    status: 529,
    json: function () {
      return Promise.resolve({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } });
    },
  });
  await waitFor(function () {
    return ctx.isPaused();
  }, "Y8: 停止待ち");
  assert.equal(ctx.state.errorMessage, null, "529 でエラーボックスが立った");
  assert.ok(ctx.state.pauseReason && ctx.state.pauseReason.indexOf("529") !== -1, "pauseReason に 529 が無い: " + ctx.state.pauseReason);
  assert.equal(ctx.state.selecting, false);
  assert.equal(ctx.state.cellProbs, null);
  assert.equal(ctx.queue.length, queueLenBefore, "マス選び中の一時的な失敗で queue の長さが変わった");
  assert.deepStrictEqual(JSON.parse(JSON.stringify(ctx.state.lastCellRequest)), body, "lastCellRequest が送ったボディと一致しない");
  ctx.render();
  assert.ok(!ctx.appElement.innerHTML.includes(TEST_KEY), "innerHTML にキーが出ている");

  ctx.run();
  await waitFor(function () {
    return af.pending.length === 1;
  }, "Y8: 再開後のマス選びの fetch 待ち");
  assert.equal(af.pending[0].url, ANTHROPIC_URL);
  var resumedBody = JSON.parse(af.pending[0].init.body);
  assert.ok(typeof resumedBody.system === "string" && resumedBody.system.indexOf("no target cell this time") !== -1, "再開後にマス選びから始まっていない");
  assert.equal(ctx.state.selecting, true);
  assert.equal(ctx.state.pauseReason, null);
});

// -------------------------------------------------------------------
// 比較モード(SPEC F1、docs/DESIGN.md 4章、Issue #46)。
// X1/X2: 通常ページ(GET /)の URL パラメータ。X3: 埋め込みモード(embed=1)。
// X4: 比較シェル(GET /compare)。
// -------------------------------------------------------------------

test("X1: URL パラメータ puzzle= で盤面と SOLUTION が差し替わる。非一意・不正な puzzle は無視される", async () => {
  var html = await getPageHtml();

  // ANSWER_KEY(既知の正解)の1マスだけ空けた、一意解を持つ盤面
  var custom = ANSWER_KEY.slice();
  custom[0] = "." + custom[0].slice(1);
  var puzzleParam = custom.join("");
  assert.equal(puzzleParam.length, 81);

  var ctx = runScript(html, {
    location: { pathname: "/", search: "?puzzle=" + puzzleParam, origin: "https://example.com" },
  });
  assert.deepEqual(hostRows(ctx.GIVEN), custom, "puzzle= の盤面が反映されていない");
  assert.deepEqual(hostRows(ctx.SOLUTION), ANSWER_KEY, "SOLUTION がソルバーで求め直されていない");
  assert.equal(ctx.TOTAL_EMPTY, 1, "TOTAL_EMPTY が空マス数(1)になっていない");

  // 非一意(というよりここでは矛盾していて解無し = 0)な puzzle は無視され、固定問題のまま
  var conflicting = "1".repeat(81);
  var ctxConflict = runScript(html, {
    location: { pathname: "/", search: "?puzzle=" + conflicting, origin: "https://example.com" },
  });
  assert.deepEqual(hostRows(ctxConflict.GIVEN), GIVEN, "矛盾した puzzle が採用されてしまった");
  assert.equal(ctxConflict.TOTAL_EMPTY, GIVEN.join("").split("").filter(function (ch) { return ch === "."; }).length);

  // 形式不正(長さが81でない)も無視される
  var ctxShort = runScript(html, {
    location: { pathname: "/", search: "?puzzle=123", origin: "https://example.com" },
  });
  assert.deepEqual(hostRows(ctxShort.GIVEN), GIVEN, "不正な形式の puzzle が採用されてしまった");
});

test("X2: URL パラメータ model/order/speed で初期 state が変わり、localStorage には書き戻されない", async () => {
  var html = await getPageHtml();
  var storage = makeLocalStorage();
  var ctx = runScript(html, {
    location: { pathname: "/", search: "?model=claude&order=confidence&speed=fast", origin: "https://example.com" },
    localStorage: storage,
  });
  assert.equal(ctx.state.modelMode, "claude");
  assert.equal(ctx.state.orderMode, "confidence");
  assert.equal(ctx.state.speedMode, "fast");
  // 通常ページの設定(scc.claude_settings.v1)は汚さない
  assert.equal(storage.getItem("scc.claude_settings.v1"), null, "URL パラメータが localStorage に書き戻ってしまった");

  // location.pathname === "/" 、search === "" の既定では今までどおり(jev/scan/slow)
  var ctxDefault = runScript(html);
  assert.equal(ctxDefault.state.modelMode, "jev");
  assert.equal(ctxDefault.state.orderMode, "scan");
  assert.equal(ctxDefault.state.speedMode, "slow");
});

test(
  "X3: embed=1 はコントロール等を隠しグリッド/統計だけを描く。message の run/stop/reset/newPuzzle が効き、他オリジンは無視。status が window.parent.postMessage に飛ぶ",
  { timeout: 10000 },
  async () => {
    var html = await getPageHtml();
    var messageHandlers = [];
    var parentCalls = [];
    var fakeParent = {
      postMessage: function (data, origin) {
        parentCalls.push({ data: data, origin: origin });
      },
    };
    var fakeWindow = {
      parent: fakeParent,
      addEventListener: function (type, handler) {
        if (type === "message") messageHandlers.push(handler);
      },
      postMessage: function () {},
    };
    var fetchStub = async function (url, init) {
      var body = JSON.parse(init.body);
      var digit = ANSWER_KEY[body.target.row][body.target.col];
      var probabilities = {};
      for (var d = 1; d <= 9; d++) probabilities[String(d)] = String(d) === digit ? 0.61 : 0.0125;
      return { ok: true, json: async function () { return { probabilities: probabilities, choice: digit, confidence: 0.31 }; } };
    };
    var ctx = runScript(html, {
      location: { pathname: "/", search: "?embed=1", origin: "https://example.com" },
      window: fakeWindow,
      fetch: fetchStub,
    });

    var out = ctx.appElement.innerHTML;
    assert.equal(out.indexOf('id="run-btn"'), -1, "実行ボタン(コントロール)が embed で描かれている");
    assert.equal(out.indexOf('id="speed-toggle"'), -1, "速度トグルが embed で描かれている");
    assert.equal(out.indexOf("較正図"), -1, "較正図が embed で描かれている");
    assert.equal(out.indexOf("モデルに送ったプロンプト"), -1, "プロンプト枠が embed で描かれている");
    assert.equal(out.indexOf("<h1>"), -1, "見出し(h1)が embed で描かれている");
    assert.ok(out.indexOf('id="grid"') !== -1, "グリッドが描かれていない");
    assert.ok(out.indexOf('id="stats"') !== -1, "統計カードが描かれていない");

    assert.equal(messageHandlers.length, 1, "message リスナーが1つ登録されていない");

    // 他オリジンのメッセージは無視される
    messageHandlers[0]({ origin: "https://evil.example", source: fakeParent, data: { type: "run" } });
    // 同一オリジンでも親以外のウィンドウからは無視(N2)
    messageHandlers[0]({ origin: "https://example.com", source: {}, data: { type: "run" } });
    assert.equal(ctx.state.running, false, "親以外からの run が効いてしまった");
    // 未知の type や、隠したパネルの関数名は message から呼べない(N9)
    ctx.appendRecord({ t: 1, p: "x", r: 0, c: 0, round: 1, choice: "1", pc: 0.5, conf: 0.5, ok: true });
    messageHandlers[0]({ origin: "https://example.com", source: fakeParent, data: { type: "clearRecords" } });
    messageHandlers[0]({ origin: "https://example.com", source: fakeParent, data: { type: "setSpeed", mode: "warp" } });
    assert.equal(ctx.getRecords().length, 1, "未知の type で記録が消えた");
    assert.equal(ctx.state.speedMode, "slow", "不正な setSpeed が通った");
    assert.equal(ctx.state.running, false, "他オリジンの run が実行されてしまった");

    // 同一オリジンの run は効く
    messageHandlers[0]({ origin: "https://example.com", source: fakeParent, data: { type: "run" } });
    assert.equal(ctx.state.running, true, "同一オリジンの run が効かない");

    // render() のたびに status が親へ postMessage される(第2引数が origin)
    assert.ok(parentCalls.length > 0, "status が postMessage されていない");
    var lastRunning = parentCalls[parentCalls.length - 1];
    assert.equal(lastRunning.data.type, "status");
    assert.equal(lastRunning.origin, "https://example.com");
    assert.equal(lastRunning.data.running, true);

    // stop で running が false になる(in-flight の判定を打ち切る。既存の stop() の挙動)
    messageHandlers[0]({ origin: "https://example.com", source: fakeParent, data: { type: "stop" } });
    assert.equal(ctx.state.running, false, "同一オリジンの stop が効かない");

    // reset で最初から
    messageHandlers[0]({ origin: "https://example.com", source: fakeParent, data: { type: "reset" } });
    assert.equal(Object.keys(ctx.state.values).length, 0, "reset で values が空にならない");
    assert.equal(ctx.state.round, 1);

    // newPuzzle(検証は puzzle= と同じ: 一意解のときだけ差し替わる)
    var custom = ANSWER_KEY.slice();
    custom[0] = "." + custom[0].slice(1);
    messageHandlers[0]({ origin: "https://example.com", source: fakeParent, data: { type: "newPuzzle", puzzle: custom.join("") } });
    assert.deepEqual(hostRows(ctx.GIVEN), custom, "message の newPuzzle が効いていない");

    // 完了まで走らせて、done の status も飛ぶことを確認する
    messageHandlers[0]({ origin: "https://example.com", source: fakeParent, data: { type: "run" } });
    await waitFor(function () {
      return ctx.state.done === true;
    }, "X3: 完了待ち");
    var lastDone = parentCalls[parentCalls.length - 1];
    assert.equal(lastDone.data.done, true);
  }
);

/**
 * 比較シェル(GET /compare、Issue #46)のテスト用 document モック。
 * 実ブラウザでは app.innerHTML への代入がその場で DOM を組み立て、以後
 * querySelector(All) で見つけられる。この vm ハーネスにはパーサーが無いので、
 * querySelectorAll(".compare-frame" 等) が呼ばれた最初の1回だけ、スタブ要素を
 * 作って以後使い回す(renderCompareShell() は一度しか呼ばないため、これで足りる)。
 * iframe のスタブは contentWindow.postMessage の呼び出しを記録する。
 */
function makeCompareDocument() {
  var app = { innerHTML: "" };
  var topbarEl = { innerHTML: "" };
  var statusEls = [{ innerHTML: "" }, { innerHTML: "" }];
  var frameEls = null;
  function makeFrame() {
    var calls = [];
    return {
      tagName: "iframe",
      src: "",
      contentWindow: {
        postMessage: function (msg, origin) {
          calls.push({ msg: msg, origin: origin });
        },
      },
      postMessageCalls: calls,
    };
  }
  return {
    getElementById: function (id) {
      return id === "app" ? app : null;
    },
    querySelector: function () {
      return null;
    },
    querySelectorAll: function (sel) {
      if (sel === ".compare-topbar") return [topbarEl];
      if (sel === ".compare-status") return statusEls;
      if (sel === ".compare-frame") {
        if (!frameEls) frameEls = [makeFrame(), makeFrame()];
        return frameEls;
      }
      return [];
    },
    createElement: function (tag) {
      return { tagName: tag, href: "", download: "", click: function () {} };
    },
    body: {
      appendChild: function () {},
      removeChild: function () {},
    },
  };
}

test("X4: /compare は2つの iframe(jev/claude)と上部バーを描き、「実行」で両方に postMessage する。status で見出しが更新される", async () => {
  var html = await getPageHtml();
  var fakeDoc = makeCompareDocument();
  var messageHandlers = [];
  var fakeWindow = {
    parent: null,
    addEventListener: function (type, handler) {
      if (type === "message") messageHandlers.push(handler);
    },
    postMessage: function () {},
  };
  fakeWindow.parent = fakeWindow;

  var ctx = runScript(html, {
    location: { pathname: "/compare", search: "", origin: "https://example.com" },
    document: fakeDoc,
    window: fakeWindow,
  });

  var out = ctx.appElement.innerHTML;
  assert.ok(out.indexOf("model=jev") !== -1, "Jev 側の iframe src が無い");
  assert.ok(out.indexOf("model=claude") !== -1, "Claude 側の iframe src が無い");
  assert.ok(out.indexOf("新しい問題") !== -1, "上部バーが描かれていない");
  assert.ok(out.indexOf("typesafe/jev") !== -1, "Jev のモデル名見出しが無い");

  // 両 iframe から最初の status が届くまで「実行」は押せない(読み込み中…)(S3)
  // 初期描画(app.innerHTML)の上部バーは「読み込み中…」(compareEls.topbar は in-place 更新用のスタブなので初期は空)
  assert.ok(ctx.appElement.innerHTML.indexOf("読み込み中") !== -1, "読み込み中の表示が無い");
  ctx.compareRun();
  assert.equal(ctx.compareFrames.jev.postMessageCalls.length, 0, "読み込み前に run が送られた");
  assert.equal(messageHandlers.length, 1, "status 用の message リスナーが1つ登録されていない");
  var initialStatus = { type: "status", model: "typesafe/jev", round: 1, correct: 0, total: 51, remaining: 51, running: false, paused: false, done: false };
  messageHandlers[0]({ origin: "https://example.com", source: ctx.compareFrames.jev.contentWindow, data: initialStatus });
  messageHandlers[0]({ origin: "https://example.com", source: ctx.compareFrames.claude.contentWindow, data: Object.assign({}, initialStatus, { model: "claude-opus-5+think" }) });
  assert.ok(ctx.compareEls.topbar.innerHTML.indexOf("読み込み中") === -1, "status 受信後も読み込み中のまま");
  assert.ok(ctx.compareEls.statusClaude.innerHTML.indexOf("claude-opus-5+think") !== -1, "Claude 側のモデル名が status の model になっていない(N5)");

  // 「実行」を押すと両 iframe に run が送られる
  ctx.compareRun();
  assert.equal(ctx.compareFrames.jev.postMessageCalls.length, 1);
  assert.equal(ctx.compareFrames.jev.postMessageCalls[0].msg.type, "run");
  assert.equal(ctx.compareFrames.jev.postMessageCalls[0].origin, "https://example.com");
  assert.equal(ctx.compareFrames.claude.postMessageCalls.length, 1);
  assert.equal(ctx.compareFrames.claude.postMessageCalls[0].msg.type, "run");

  // 子(iframe)からの status メッセージで見出しが更新される
  messageHandlers[0]({
    origin: "https://example.com",
    source: ctx.compareFrames.jev.contentWindow,
    data: { type: "status", model: "typesafe/jev", round: 2, correct: 5, total: 51, remaining: 40, running: true, paused: false, done: false },
  });
  assert.ok(ctx.compareEls.statusJev.innerHTML.indexOf("2周目") !== -1, "Jev 側の見出しが status で更新されていない");
  assert.ok(ctx.compareEls.statusJev.innerHTML.indexOf("正解 5 / 51") !== -1, "Jev 側の正解数が status で更新されていない");

  // 他オリジンの status は無視される
  ctx.compareEls.statusJev.innerHTML = "__untouched__";
  messageHandlers[0]({
    origin: "https://evil.example",
    source: ctx.compareFrames.jev.contentWindow,
    data: { type: "status", round: 9 },
  });
  assert.equal(ctx.compareEls.statusJev.innerHTML, "__untouched__", "他オリジンの status で更新されてしまった");
});

test("X5: /compare の上部バーで Claude のモデルを選べる。両 iframe に postMessage・localStorage にも保存され、実行中・停止中はロックされる(Issue #90)", async () => {
  var html = await getPageHtml();
  var fakeDoc = makeCompareDocument();
  var messageHandlers = [];
  var fakeWindow = {
    parent: null,
    addEventListener: function (type, handler) {
      if (type === "message") messageHandlers.push(handler);
    },
    postMessage: function () {},
  };
  fakeWindow.parent = fakeWindow;
  var storage = makeLocalStorage();

  var ctx = runScript(html, {
    location: { pathname: "/compare", search: "", origin: "https://example.com" },
    document: fakeDoc,
    window: fakeWindow,
    localStorage: storage,
  });

  var initialTopbar = ctx.appElement.innerHTML;
  ctx.CLAUDE_MODELS.forEach(function (m) {
    assert.ok(initialTopbar.indexOf(m) !== -1, "Claude モデルの選択肢が無い: " + m);
  });
  assert.equal(ctx.state.claudeModel, ctx.DEFAULT_CLAUDE_MODEL, "初期状態の claudeModel が既定値でない");

  // 選ぶと state・localStorage が更新され、両 iframe に setClaudeModel が飛ぶ
  var otherModel = ctx.CLAUDE_MODELS[1];
  ctx.compareSetClaudeModel(otherModel);
  assert.equal(ctx.state.claudeModel, otherModel, "compareSetClaudeModel で state.claudeModel が変わらない");
  assert.equal(ctx.compareFrames.jev.postMessageCalls.length, 1, "Jev 側 iframe に setClaudeModel が飛んでいない");
  assert.equal(ctx.compareFrames.jev.postMessageCalls[0].msg.type, "setClaudeModel");
  assert.equal(ctx.compareFrames.jev.postMessageCalls[0].msg.model, otherModel);
  assert.equal(ctx.compareFrames.claude.postMessageCalls.length, 1, "Claude 側 iframe に setClaudeModel が飛んでいない");
  assert.equal(ctx.compareFrames.claude.postMessageCalls[0].msg.model, otherModel);
  var saved = JSON.parse(storage.getItem("scc.claude_settings.v1"));
  assert.equal(saved.model, otherModel, "localStorage に選んだモデルが保存されていない");
  assert.ok(ctx.compareEls.topbar.innerHTML.indexOf(otherModel) !== -1, "上部バーの再描画に選んだモデルが出ていない");

  // 不正なモデル名は無視される
  ctx.compareSetClaudeModel("not-a-real-model");
  assert.equal(ctx.state.claudeModel, otherModel, "不正なモデル名で state が変わってしまった");

  // 実行中は両 iframe から status(running:true)が届いた状態を模す。ロックされて無視される
  messageHandlers[0]({
    origin: "https://example.com",
    source: ctx.compareFrames.jev.contentWindow,
    data: { type: "status", model: "typesafe/jev", round: 1, correct: 0, total: 51, remaining: 51, running: true, paused: false, done: false },
  });
  var callsBefore = ctx.compareFrames.claude.postMessageCalls.length;
  ctx.compareSetClaudeModel(ctx.CLAUDE_MODELS[2]);
  assert.equal(ctx.state.claudeModel, otherModel, "実行中なのに compareSetClaudeModel が効いてしまった");
  assert.equal(ctx.compareFrames.claude.postMessageCalls.length, callsBefore, "実行中なのに setClaudeModel が飛んでしまった");
});

test("X6: 埋め込みモード(iframe 側)が setClaudeModel を受け取っても localStorage には保存しない(通常ページの設定を汚さない)。実行中はロックされ state も変わらない(Issue #90 レビュー)", async () => {
  var html = await getPageHtml();
  var storage = makeLocalStorage();
  // 通常ページで既に保存済みの設定(modelMode:"jev")を模す
  storage.setItem("scc.claude_settings.v1", JSON.stringify({ modelMode: "jev", model: "claude-opus-5", thinking: true }));
  var fakeParent = { postMessage: function () {} };

  function makeEmbedWindow() {
    var handlers = [];
    return {
      window: {
        parent: fakeParent,
        addEventListener: function (type, handler) {
          if (type === "message") handlers.push(handler);
        },
        postMessage: function () {},
      },
      handlers: handlers,
    };
  }

  // model=jev の iframe(比較シェルの左カラム相当)。setClaudeModel は受け取れるが
  // 自身では使わない値で、以前は saveClaudeSettings() が modelMode:"jev" を書き戻していた。
  var jevWin = makeEmbedWindow();
  var ctxJev = runScript(html, {
    location: { pathname: "/", search: "?embed=1&model=jev", origin: "https://example.com" },
    window: jevWin.window,
    localStorage: storage,
  });
  assert.equal(ctxJev.state.modelMode, "jev");
  jevWin.handlers[0]({ origin: "https://example.com", source: fakeParent, data: { type: "setClaudeModel", model: "claude-haiku-4-5" } });
  assert.equal(ctxJev.state.claudeModel, "claude-haiku-4-5", "埋め込み側(jev)の state.claudeModel が更新されない");
  var savedAfterJev = JSON.parse(storage.getItem("scc.claude_settings.v1"));
  assert.equal(savedAfterJev.modelMode, "jev", "jev 側 iframe の setClaudeModel で通常ページの modelMode が書き変わってしまった");
  assert.equal(savedAfterJev.model, "claude-opus-5", "jev 側 iframe の setClaudeModel で通常ページの保存済みモデルが書き変わってしまった");

  // model=claude の iframe(右カラム相当)。実行中はロックされ state すら変わらない。
  var claudeWin = makeEmbedWindow();
  var ctxClaude = runScript(html, {
    location: { pathname: "/", search: "?embed=1&model=claude", origin: "https://example.com" },
    window: claudeWin.window,
    localStorage: storage,
  });
  assert.equal(ctxClaude.state.claudeModel, "claude-opus-5", "保存済みの claudeModel が読み込まれていない");
  ctxClaude.state.running = true;
  claudeWin.handlers[0]({ origin: "https://example.com", source: fakeParent, data: { type: "setClaudeModel", model: "claude-sonnet-5" } });
  assert.equal(ctxClaude.state.claudeModel, "claude-opus-5", "実行中なのに埋め込み側(claude)の setClaudeModel が効いてしまった");
  var savedAfterClaudeLocked = JSON.parse(storage.getItem("scc.claude_settings.v1"));
  assert.equal(savedAfterClaudeLocked.modelMode, "jev", "実行中の埋め込み側からの取りこぼしで通常ページの modelMode が変わってしまった");

  // ロックが外れていれば state は更新されるが、それでも localStorage は変わらない
  ctxClaude.state.running = false;
  claudeWin.handlers[0]({ origin: "https://example.com", source: fakeParent, data: { type: "setClaudeModel", model: "claude-sonnet-5" } });
  assert.equal(ctxClaude.state.claudeModel, "claude-sonnet-5", "非実行中の埋め込み側(claude)で state.claudeModel が更新されない");
  var savedAfterClaude = JSON.parse(storage.getItem("scc.claude_settings.v1"));
  assert.equal(savedAfterClaude.modelMode, "jev", "claude 側 iframe の setClaudeModel で通常ページの modelMode が書き変わってしまった");
  assert.equal(savedAfterClaude.model, "claude-opus-5", "claude 側 iframe の setClaudeModel で通常ページの保存済みモデルが書き変わってしまった");
});

// ---------------------------------------------------------------------------
// 一括モード(Issue #48、SPEC 3章 F1・F3)。S/T/W/Y 系と同じ runScript /
// makeAbortAwareFetch / waitFor / makeManualTimers を使う。
// ---------------------------------------------------------------------------

/**
 * /api/judge の ask:"all" 応答モック(Jev 経路)。keys(queue のキー、"r0c2" 形式)の
 * 全部に choice/probabilities/confidence を作る。wrongKeys に挙げたキーだけ不正解の
 * 数字を返す(W5 の makeCellResponse と同じ考え方)。
 */
function makeAllResponse(ctx, puzzle, keys, wrongKeys) {
  var wrongSet = {};
  (wrongKeys || []).forEach(function (k) {
    wrongSet[k] = true;
  });
  var criteria = {};
  for (var d = 1; d <= 9; d++) criteria[String(d)] = "the digit " + d;
  var cells = {};
  var questions = {};
  keys.forEach(function (key) {
    var m = /^r(\d)c(\d)$/.exec(key);
    var row = Number(m[1]);
    var col = Number(m[2]);
    var correctDigit = ctx.SOLUTION[row][col];
    var choice = correctDigit;
    if (wrongSet[key]) {
      var others = ["1", "2", "3", "4", "5", "6", "7", "8", "9"].filter(function (dd) {
        return dd !== correctDigit;
      });
      choice = others[0];
    }
    var probabilities = {};
    for (var d2 = 1; d2 <= 9; d2++) probabilities[String(d2)] = String(d2) === choice ? 0.9 : 0.0125;
    cells[key] = { choice: choice, probabilities: probabilities, confidence: 0.5 };
    questions[key] = {
      type: "choice",
      instructions: "Which digit from 1 to 9 belongs in the empty cell at row " + row + ", column " + col + " (zero-based)?",
      criteria: criteria,
    };
  });
  var body = {
    cells: cells,
    request: {
      state: { puzzle: puzzle, note: "puzzle is a 9x9 Sudoku grid, no target this time (mock, all)" },
      questions: questions,
    },
  };
  return {
    ok: true,
    json: async function () {
      return body;
    },
  };
}

test("Z1: 一括の1周は fetch 1回(ask:\"all\")、盤面は buildSelectionSnapshot() と一致し SOLUTION を含まない", { timeout: 10000 }, async () => {
  var af = makeAbortAwareFetch();
  var ctx = runScript(await getPageHtml(), { fetch: af.fetch });
  ctx.setOrderMode("all");
  assert.equal(ctx.state.orderMode, "all");

  ctx.run();
  await waitFor(function () {
    return af.pending.length === 1;
  }, "Z1: fetch 待ち");
  assert.equal(ctx.state.allFetching, true, "state.allFetching が立っていない");
  var entry = af.pending.shift();
  var body = JSON.parse(entry.init.body);
  assert.equal(body.ask, "all", "ask:\"all\" を送っていない");
  assert.equal(body.target, undefined, "ask:\"all\" で target を送っている");
  assert.equal(body.digit, undefined, "ask:\"all\" で digit を送っている");
  assert.deepStrictEqual(hostRows(body.puzzle), hostRows(ctx.buildSelectionSnapshot()), "盤面が buildSelectionSnapshot() と一致しない");
  var bodyText = JSON.stringify(body);
  hostRows(ctx.SOLUTION).forEach(function (row) {
    assert.ok(bodyText.indexOf(row) === -1, "SOLUTION の行が送信盤面に含まれている: " + row);
  });
  assert.equal(af.pending.length, 0, "一括なのに複数回 fetch している");

  var keys = ctx.selectionKeys();
  entry.resolve(makeAllResponse(ctx, body.puzzle, keys));
  await waitFor(function () {
    return ctx.state.done === true;
  }, "Z1: 完了待ち");
  assert.equal(af.pending.length, 0, "1周(51マス)の完走に複数回 fetch している");
});

test("Z2: 一括の応答後に全マスが順に確定し、記録の m が \"typesafe/jev/all\"・o が \"all\" になる", { timeout: 10000 }, async () => {
  var af = makeAbortAwareFetch();
  var ctx = runScript(await getPageHtml(), { fetch: af.fetch });
  ctx.setOrderMode("all");
  ctx.setSpeed("fast");

  ctx.run();
  await waitFor(function () {
    return af.pending.length === 1;
  }, "Z2: fetch 待ち");
  var entry = af.pending.shift();
  var body = JSON.parse(entry.init.body);
  var keys = ctx.selectionKeys();
  entry.resolve(makeAllResponse(ctx, body.puzzle, keys));

  await waitFor(function () {
    return ctx.state.done === true;
  }, "Z2: 完了待ち");
  assert.equal(Object.keys(ctx.state.values).length, ctx.TOTAL_EMPTY, "全マスが確定していない");
  var records = ctx.getRecords();
  assert.equal(records.length, ctx.TOTAL_EMPTY, "記録の件数が空マス数と一致しない");
  records.forEach(function (rec) {
    assert.equal(rec.m, "typesafe/jev/all", "記録の m が typesafe/jev/all でない: " + rec.m);
    assert.equal(rec.o, "all", "記録の o が all でない: " + rec.o);
  });
  assert.equal(af.pending.length, 0, "一括なのに複数回 fetch している");
});

test(
  "Z3: 一括の呼び出し中の stop() は再開で呼び直し、確定途中の stop() は再開でキャッシュから続き fetch しない",
  { timeout: 10000 },
  async () => {
    var af = makeAbortAwareFetch();
    var timers = makeManualTimers();
    var ctx = runScript(await getPageHtml(), { fetch: af.fetch, setTimeout: timers.setTimeout });
    ctx.setOrderMode("all");

    ctx.run();
    await waitFor(function () {
      return af.pending.length === 1;
    }, "Z3: 1回目の fetch 待ち");
    var entry1 = af.pending.shift();
    var queueLenBefore = ctx.queue.length;
    ctx.stop();
    assert.equal(entry1.settled, true, "呼び出し中の stop() で fetch が abort されていない");
    assert.equal(ctx.state.allFetching, false, "stop() 後も一括の呼び出し中表示が残っている");
    assert.equal(ctx.isPaused(), true);
    assert.equal(ctx.queue.length, queueLenBefore, "呼び出し中の stop() で queue の長さが変わった");

    ctx.run();
    await waitFor(function () {
      return af.pending.length === 1;
    }, "Z3: 再開後にもう一度 fetch する(呼び直す)のを待つ");
    var entry2 = af.pending.shift();
    var body2 = JSON.parse(entry2.init.body);
    var keys = ctx.selectionKeys();
    entry2.resolve(makeAllResponse(ctx, body2.puzzle, keys));

    await waitFor(function () {
      return ctx.state.focusedKey !== null;
    }, "Z3: 応答後の最初のマスへのフォーカス待ち");
    assert.equal(af.pending.length, 0, "一括の応答後にキャッシュから確定するはずが余計な fetch をしている");
    var firstFocused = ctx.state.focusedKey;
    assert.equal(timers.length(), 1, "確定前の待ちタイマーが積まれていない");

    // 確定途中(beforeCommit の待ち)で stop()
    ctx.stop();
    assert.equal(ctx.state.running, false);
    assert.equal(ctx.queue[0].r + "-" + ctx.queue[0].c, firstFocused, "確定途中のマスが queue の先頭に戻っていない");
    assert.equal(af.pending.length, 0, "確定途中の stop() で余計な fetch が飛んだ");

    // 再開。allResults(キャッシュ)にまだ結果があるので、fetch せずキャッシュから続く
    ctx.run();
    assert.equal(af.pending.length, 0, "確定途中からの再開で fetch し直している(キャッシュを使っていない)");
    assert.equal(ctx.state.focusedKey, firstFocused, "再開後に同じマスへフォーカスしていない");

    // 残りは手動タイマーを進めて完走させる(この周は最初に成功した1回の fetch だけで済むはず)
    for (var i = 0; i < 1000 && !ctx.state.done; i++) {
      if (timers.length() === 0) throw new Error("Z3: 進めるタイマーが無い(スタック)");
      timers.fireNext();
    }
    assert.equal(ctx.state.done, true, "一括モードの1周が完走しなかった");
    assert.equal(af.pending.length, 0, "完走までに余計な fetch が飛んだ(一括なのに複数回呼んでいる)");
    assert.equal(Object.keys(ctx.state.values).length, ctx.TOTAL_EMPTY);
  }
);

test("Z4: 一括モードで Jev の 429 は停止扱いになる(queue は変わらず、再開は呼び直す)", { timeout: 10000 }, async () => {
  var af = makeAbortAwareFetch();
  var ctx = runScript(await getPageHtml(), { fetch: af.fetch });
  ctx.setOrderMode("all");
  ctx.run();
  await waitFor(function () {
    return af.pending.length === 1;
  }, "Z4: fetch 待ち");
  var entry = af.pending.shift();
  entry.resolve({
    ok: false,
    status: 429,
    headers: {
      get: function (name) {
        return name === "Retry-After" ? "45" : null;
      },
    },
    json: function () {
      return Promise.resolve({ error: "アクセス元(IP)ごとのレート制限を超えました" });
    },
  });
  await waitFor(function () {
    return ctx.isPaused();
  }, "Z4: 429 の停止待ち");
  assert.equal(ctx.state.errorMessage, null, "429 でエラーボックスが立った");
  assert.ok(ctx.state.pauseReason && ctx.state.pauseReason.indexOf("45") !== -1, "pauseReason に Retry-After の秒数が含まれない: " + ctx.state.pauseReason);
  assert.equal(ctx.queue.length, ctx.TOTAL_EMPTY, "429 の停止で queue の長さが変わった");
  assert.equal(ctx.state.allFetching, false, "429 の停止後も一括の呼び出し中表示が残っている");

  ctx.run();
  await waitFor(function () {
    return af.pending.length === 1;
  }, "Z4: 再開後にもう一度 fetch する");
  var entry2 = af.pending.shift();
  var body2 = JSON.parse(entry2.init.body);
  assert.equal(body2.ask, "all", "再開後の呼び出しが ask:\"all\" でない");
});

test(
  "Z5: 一括モードの Claude 経路(スキーマの required キー・system の ALL_NOTE・max_tokens の下限)と応答検証(キー欠け→エラー)",
  { timeout: 10000 },
  async () => {
    var ctx = runScript(await getPageHtml(), {});
    ctx.setModelMode("claude");
    var puzzle = ctx.buildSnapshot();
    var keys = ["r0c0", "r0c1", "r1c0"];

    // max_tokens の下限(既存の設定との Math.max。docs/DESIGN.md 3.6)
    ctx.setClaudeThinking(false);
    var offBody = ctx.buildClaudeAllRequest(puzzle, keys);
    assert.equal(offBody.max_tokens, 16000, "思考なしの一括の最低値が16000になっていない");

    ctx.setClaudeThinking(true); // 既定モデル(opus)は adaptive
    var adaptiveBody = ctx.buildClaudeAllRequest(puzzle, keys);
    assert.equal(adaptiveBody.max_tokens, 24000, "adaptive の一括の最低値が24000になっていない");

    ctx.setClaudeModel("claude-haiku-4-5");
    var haikuBody = ctx.buildClaudeAllRequest(puzzle, keys);
    assert.equal(haikuBody.max_tokens, 12000, "Haiku(budget 2048)の一括の最低値が12000になっていない");

    // スキーマ: 候補キーがそれぞれ required で、各値は digit 判定と同じ形
    var schema = offBody.output_config.format.schema;
    assert.deepStrictEqual(Object.keys(schema.properties).sort(), keys.slice().sort(), "スキーマの properties が候補キーと一致しない");
    assert.deepStrictEqual(Array.from(schema.required).sort(), keys.slice().sort(), "スキーマの required が候補キーと一致しない");
    assert.equal(schema.additionalProperties, false);
    var cellSchema = schema.properties[keys[0]];
    // schema.required 等は vm レルムの配列なので、host 側の配列に移し替えてから比較する
    // (hostRows と同じ理由。W6 のコメント参照)。
    assert.deepStrictEqual(Array.from(cellSchema.required), ["choice", "probabilities", "confidence"]);
    assert.deepStrictEqual(Array.from(cellSchema.properties.choice.enum).sort(), ["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
    assert.deepStrictEqual(Array.from(cellSchema.properties.probabilities.required).sort(), ["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
    assert.equal(cellSchema.additionalProperties, false);

    assert.ok(typeof offBody.system === "string" && offBody.system.indexOf("Each question is about one empty cell") !== -1, "system が ALL_NOTE を含んでいない");
    var content = offBody.messages[0].content;
    var sent = JSON.parse(content.slice(content.indexOf("\n") + 1));
    assert.ok(!Object.prototype.hasOwnProperty.call(sent, "target"), "一括なのに target を送っている");

    // 応答検証(純粋関数): キーが1つ欠けていればエラー、揃っていれば通る
    var badAnswer = {};
    keys.forEach(function (k, i) {
      if (i === 0) return;
      badAnswer[k] = { choice: "1", probabilities: { "1": 1, "2": 0, "3": 0, "4": 0, "5": 0, "6": 0, "7": 0, "8": 0, "9": 0 }, confidence: 0.5 };
    });
    assert.ok(ctx.validateClaudeAllAnswer(badAnswer, keys) !== null, "キー欠けの応答が検証を通ってしまった");
    var goodAnswer = {};
    keys.forEach(function (k) {
      goodAnswer[k] = { choice: "1", probabilities: { "1": 1, "2": 0, "3": 0, "4": 0, "5": 0, "6": 0, "7": 0, "8": 0, "9": 0 }, confidence: 0.5 };
    });
    assert.equal(ctx.validateClaudeAllAnswer(goodAnswer, keys), null, "揃っている応答が検証で弾かれた");

    // run() 経由でも同じ検証が効く(キー欠けの応答はエラーで停止する)。マス数が多いと
    // スキーマサイズの都合でチャンク分割される(CLAUDE_ALL_CHUNK_SIZE 件ずつ、Issue #74)ので、
    // チャンクの数だけ届くのを待ってから全部さばく。
    var af = makeAbortAwareFetch();
    var ctx2 = runScript(await getPageHtml(), { fetch: af.fetch });
    assert.equal(ctx2.saveAnthropicKey(TEST_KEY), true);
    ctx2.setModelMode("claude");
    ctx2.setOrderMode("all");
    ctx2.run();
    var liveKeys = Array.prototype.slice.call(ctx2.selectionKeys()).map(String);
    var expectedChunks = Math.ceil(liveKeys.length / ctx2.CLAUDE_ALL_CHUNK_SIZE);
    await waitFor(function () {
      return af.pending.length === expectedChunks;
    }, "Z5: run() 経由の fetch 待ち(チャンク分割ぶん)");
    var entries = af.pending.splice(0, af.pending.length);
    var allSchemaKeys = [];
    entries.forEach(function (entry) {
      assert.equal(entry.url, ANTHROPIC_URL, "呼び先が api.anthropic.com でない");
      var body = JSON.parse(entry.init.body);
      allSchemaKeys = allSchemaKeys.concat(Object.keys(body.output_config.format.schema.properties));
      // Claude 経路の送信ボディにも SOLUTION の行が含まれない(不変条件1。チャンク全部を確認)
      hostRows(ctx2.SOLUTION).forEach(function (row) {
        assert.ok(entry.init.body.indexOf(row) === -1, "SOLUTION の行が Claude への送信ボディに含まれている: " + row);
      });
      assert.ok(entry.init.body.indexOf(TEST_KEY) === -1, "API キーがボディに混ざっている");
    });
    assert.deepStrictEqual(allSchemaKeys.sort(), liveKeys.slice().sort(), "チャンク全部のスキーマ properties を合わせても queue のキーと一致しない(live)");
    var firstBody = JSON.parse(entries[0].init.body);
    var liveSent = JSON.parse(firstBody.messages[0].content.slice(firstBody.messages[0].content.indexOf("\n") + 1));
    assert.deepStrictEqual(hostRows(liveSent.puzzle), hostRows(ctx2.buildSelectionSnapshot()), "盤面が buildSelectionSnapshot() と一致しない(live)");

    // 先頭チャンクの先頭キーだけ欠かした応答を返し、Promise.all がまとめてエラーになることを確認する
    entries.forEach(function (entry, i) {
      var chunkBody = JSON.parse(entry.init.body);
      var chunkKeys = Object.keys(chunkBody.output_config.format.schema.properties);
      var answer = {};
      chunkKeys.forEach(function (k, ki) {
        if (i === 0 && ki === 0) return; // 先頭チャンクの先頭キーだけ欠かす
        answer[k] = { choice: "1", probabilities: { "1": 1, "2": 0, "3": 0, "4": 0, "5": 0, "6": 0, "7": 0, "8": 0, "9": 0 }, confidence: 0.5 };
      });
      entry.resolve({
        ok: true,
        status: 200,
        json: function () {
          return Promise.resolve({
            id: "msg_z5",
            type: "message",
            role: "assistant",
            model: "claude-opus-5",
            stop_reason: "end_turn",
            content: [{ type: "text", text: JSON.stringify(answer) }],
            usage: { input_tokens: 900, output_tokens: 400 },
          });
        },
      });
    });
    await waitFor(function () {
      return ctx2.state.errorMessage !== null;
    }, "Z5: キー欠けでエラー待ち");
    assert.equal(ctx2.state.running, false);
  }
);

test("Z6: 一括モードの2周目は不正解マスだけを聞く(候補が不正解マス1つだけになる)", { timeout: 20000 }, async () => {
  var ctx;
  var wrongKey = "r0c2"; // GIVEN の最初の空マス(helpers.js の GIVEN と同一の固定問題)
  var allCalls = [];
  var round = 0;
  var fetchStub = async function (url, init) {
    var body = JSON.parse(init.body);
    assert.equal(body.ask, "all", "一括モードなのに ask:\"all\" 以外のリクエストが飛んだ");
    allCalls.push(body);
    round += 1;
    var keys = ctx.selectionKeys();
    var wrongKeys = round === 1 ? [wrongKey] : [];
    return makeAllResponse(ctx, body.puzzle, keys, wrongKeys);
  };
  ctx = runScript(await getPageHtml(), { fetch: fetchStub });
  ctx.setOrderMode("all");
  ctx.setSpeed("fast");

  ctx.run();
  await waitFor(function () {
    return ctx.state.done === true;
  }, "Z6: 完了待ち");

  assert.equal(ctx.state.roundsToSolve, 2, "2周で完了したことになっていない");
  assert.equal(allCalls.length, 2, "一括の呼び出しが2回(1周目+2周目)でない: " + allCalls.length);

  var round2Body = allCalls[1];
  var dots = [];
  for (var r = 0; r < 9; r++) {
    for (var c = 0; c < 9; c++) {
      if (round2Body.puzzle[r][c] === ".") dots.push("r" + r + "c" + c);
    }
  }
  assert.deepEqual(dots, [wrongKey], "2周目の一括の候補が不正解マスだけになっていない: " + JSON.stringify(dots));

  assert.equal(ctx.state.roundLog.length, 2, "周回ログが2行でない");
  assert.equal(ctx.state.roundLog[0].round, 1);
  assert.equal(ctx.state.roundLog[0].correct, 50);
  assert.equal(ctx.state.roundLog[0].total, 51);
  assert.match(ctx.formatRoundLogLine(ctx.state.roundLog[0]), /^1周目: 51中50正解 \(98%\) — /, "1周目のログ形式が違う: " + ctx.formatRoundLogLine(ctx.state.roundLog[0]));
  assert.equal(ctx.state.roundLog[1].round, 2);
  assert.equal(ctx.state.roundLog[1].correct, 1);
  assert.equal(ctx.state.roundLog[1].total, 1);
  assert.match(ctx.formatRoundLogLine(ctx.state.roundLog[1]), /^2周目: 1中1正解 \(100%\) — /, "2周目のログ形式が違う: " + ctx.formatRoundLogLine(ctx.state.roundLog[1]));
});

test("Z7: URL パラメータ order=all、setOrderMode(\"all\")、比較シェルの順番トグルとURL組み立てに「一括」がある", async () => {
  var html = await getPageHtml();
  var ctx = runScript(html, {
    location: { pathname: "/", search: "?order=all", origin: "https://example.com" },
  });
  assert.equal(ctx.state.orderMode, "all", "order=all が反映されていない");

  var ctx2 = runScript(html);
  assert.equal(ctx2.state.orderMode, "scan");
  ctx2.setOrderMode("all");
  assert.equal(ctx2.state.orderMode, "all", "setOrderMode(\"all\") が効かない");
  ctx2.render();
  // Issue #76 でプルダウン化(<select id="order-toggle"> + <option>)
  var orderToggleMatch = ctx2.appElement.innerHTML.match(/<select id="order-toggle"[^>]*>([\s\S]*?)<\/select>/);
  assert.ok(orderToggleMatch, "order-toggle が描画されていない");
  assert.ok(orderToggleMatch[1].indexOf("一括") !== -1, "順番トグルに「一括」の選択肢が無い");
  assert.ok(orderToggleMatch[1].indexOf('<option value="all" selected>') !== -1, "「一括」が選択済みになっていない");

  // 比較シェル(/compare、Issue #46)の順番トグルにも「一括」がある
  var fakeDoc = makeCompareDocument();
  var ctxCompare = runScript(html, {
    location: { pathname: "/compare", search: "", origin: "https://example.com" },
    document: fakeDoc,
  });
  assert.ok(ctxCompare.appElement.innerHTML.indexOf("compareSetOrderMode('all')") !== -1, "比較シェルの順番トグルに「一括」が無い");
  ctxCompare.compareSetOrderMode("all");
  assert.equal(ctxCompare.state.orderMode, "all", "比較シェルの compareSetOrderMode('all') が効かない");
  assert.ok(ctxCompare.compareIframeSrc("jev").indexOf("order=all") !== -1, "比較シェルの iframe URL 組み立てに order=all が反映されない");
});

test("Z8: 一括モードの Claude 経路で全マスが確定し、記録の m が \"claude-opus-5+think/all\"・o が \"all\" になる。応答に対象マスが欠けていれば1マスも確定・記録しない", { timeout: 10000 }, async () => {
  // schemaProps(任意): body.output_config.format.schema.properties。渡すとキーごとに
  // そのマスのスキーマの enum(消去法。Issue #61・#63 で絞られた残りの数字)だけを
  // probabilities/choice に使う(省略時は従来どおり1〜9全部)。
  function claudeAllResponse(ctx, keys, omitFirst, schemaProps) {
    var answer = {};
    keys.forEach(function (k, i) {
      if (omitFirst && i === 0) return;
      var m = /^r(\d)c(\d)$/.exec(k);
      var digit = ctx.SOLUTION[Number(m[1])][Number(m[2])];
      var list = (schemaProps && schemaProps[k] && schemaProps[k].properties.choice.enum) || ["1", "2", "3", "4", "5", "6", "7", "8", "9"];
      var probabilities = {};
      list.forEach(function (d) { probabilities[d] = d === digit ? 0.6 : 0.05; });
      answer[k] = { choice: digit, probabilities: probabilities, confidence: 0.4 };
    });
    return {
      ok: true,
      status: 200,
      json: function () {
        return Promise.resolve({
          id: "msg_z8",
          type: "message",
          role: "assistant",
          model: "claude-opus-5",
          stop_reason: "end_turn",
          content: [{ type: "text", text: JSON.stringify(answer) }],
          usage: { input_tokens: 9000, output_tokens: 4000 },
        });
      },
    };
  }

  // マス数が多いとスキーマサイズの都合でチャンク分割される(CLAUDE_ALL_CHUNK_SIZE 件ずつ、
  // Issue #74)ので、チャンクの数だけ届くのを待ってから、チャンクごとの応答をまとめて返す。
  var af = makeAbortAwareFetch();
  var ctx = runScript(await getPageHtml(), { fetch: af.fetch });
  assert.equal(ctx.saveAnthropicKey(TEST_KEY), true);
  ctx.setModelMode("claude");
  ctx.setOrderMode("all");
  ctx.setSpeed("fast");
  ctx.run();
  var keys = Array.prototype.slice.call(ctx.selectionKeys()).map(String);
  var expectedChunks = Math.ceil(keys.length / ctx.CLAUDE_ALL_CHUNK_SIZE);
  await waitFor(function () {
    return af.pending.length === expectedChunks;
  }, "Z8: fetch 待ち(チャンク分割ぶん)");
  var entries = af.pending.splice(0, af.pending.length);
  entries.forEach(function (entry) {
    var entryBody = JSON.parse(entry.init.body);
    var chunkKeys = Object.keys(entryBody.output_config.format.schema.properties);
    entry.resolve(claudeAllResponse(ctx, chunkKeys, false, entryBody.output_config.format.schema.properties));
  });
  await waitFor(function () {
    return ctx.state.done === true;
  }, "Z8: 完了待ち");
  var records = ctx.getRecords();
  assert.equal(records.length, ctx.TOTAL_EMPTY, "記録の件数が空マス数と一致しない");
  records.forEach(function (rec) {
    assert.equal(rec.m, "claude-opus-5+think/all", "記録の m が claude-opus-5+think/all でない: " + rec.m);
    assert.equal(rec.o, "all", "記録の o が all でない: " + rec.o);
  });
  assert.equal(af.pending.length, 0, "1周ぶんのチャンク以外に余計に fetch している");
  ctx.render();
  assert.ok(!ctx.appElement.innerHTML.includes(TEST_KEY), "innerHTML にキーが出ている");

  // Jev 経路でも、cells に対象マスが欠けていれば 1 マスも確定・記録せずエラーになる(レビュー S2)
  var af2 = makeAbortAwareFetch();
  var ctx2 = runScript(await getPageHtml(), { fetch: af2.fetch });
  ctx2.setOrderMode("all");
  ctx2.run();
  await waitFor(function () {
    return af2.pending.length === 1;
  }, "Z8: Jev の fetch 待ち");
  var entry2 = af2.pending.shift();
  var body2 = JSON.parse(entry2.init.body);
  var keys2 = ctx2.selectionKeys();
  var res2 = makeAllResponse(ctx2, body2.puzzle, keys2);
  var payload2 = await res2.json();
  delete payload2.cells[String(keys2[keys2.length - 1])]; // 末尾のマスを欠かす
  entry2.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(payload2); } });
  await waitFor(function () {
    return ctx2.state.errorMessage !== null;
  }, "Z8: 欠けでエラー待ち");
  assert.ok(ctx2.state.errorMessage.indexOf("対象マスの回答がありません") !== -1, "文言が違う: " + ctx2.state.errorMessage);
  assert.equal(Object.keys(ctx2.state.values).length, 0, "欠けた応答なのにマスが確定した");
  assert.equal(ctx2.getRecords().length, 0, "欠けた応答なのに記録が増えた");
  assert.equal(ctx2.queue.length, ctx2.TOTAL_EMPTY, "欠けた応答なのに queue が減った");
});

test("Z9: 一括モード(Claude 経路)は CLAUDE_ALL_CHUNK_SIZE 件ずつチャンク分割し、usage を合算する(Issue #74)", { timeout: 10000 }, async () => {
  var ctx = runScript(await getPageHtml());

  // chunkArray(): 境界(割り切れる・余りが出る・空・要素1個)
  function toHostChunks(chunks) {
    return Array.prototype.slice.call(chunks).map(function (c) { return Array.prototype.slice.call(c); });
  }
  assert.deepStrictEqual(toHostChunks(ctx.chunkArray([1, 2, 3, 4, 5], 2)), [[1, 2], [3, 4], [5]]);
  assert.deepStrictEqual(toHostChunks(ctx.chunkArray([1, 2, 3, 4], 2)), [[1, 2], [3, 4]]);
  assert.deepStrictEqual(toHostChunks(ctx.chunkArray([], 2)), []);
  assert.deepStrictEqual(toHostChunks(ctx.chunkArray([1], 5)), [[1]]);

  // combineClaudeUsage(): 片方 undefined・両方あり・cache_read の合算
  // (戻り値は vm レルムのオブジェクトなので、プロトタイプ違いで deepStrictEqual が
  // 落ちないよう Object.assign で host 側にコピーしてから比べる。hostRows と同じ理由)
  function hostObj(o) { return o ? Object.assign({}, o) : o; }
  assert.equal(ctx.combineClaudeUsage(undefined, undefined), undefined);
  assert.deepStrictEqual(hostObj(ctx.combineClaudeUsage({ input_tokens: 10, output_tokens: 5 }, undefined)), { input_tokens: 10, output_tokens: 5 });
  assert.deepStrictEqual(
    hostObj(ctx.combineClaudeUsage({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2 }, { input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 1 })),
    { input_tokens: 13, output_tokens: 6, cache_read_input_tokens: 3 }
  );

  // 固定問題(51マス、ctx.TOTAL_EMPTY)なら CLAUDE_ALL_CHUNK_SIZE=10 で6チャンクになる
  // (queue は run() 前は空なので selectionKeys() ではなく TOTAL_EMPTY を使う。この定数を
  // 変えたらここも要更新)
  var expectedChunks = Math.ceil(ctx.TOTAL_EMPTY / ctx.CLAUDE_ALL_CHUNK_SIZE);
  assert.equal(expectedChunks, 6, "既定の固定問題(51マス)で6チャンクにならない(CLAUDE_ALL_CHUNK_SIZE が変わっていないか確認)");

  // 実際の実行フロー: チャンクごとに違う usage を返し、合算されて周の先頭1件の記録にだけ
  // 付くこと(二重計上しない)。プロンプト枠にも分割の注記が出ること。
  var af = makeAbortAwareFetch();
  var ctx2 = runScript(await getPageHtml(), { fetch: af.fetch });
  assert.equal(ctx2.saveAnthropicKey(TEST_KEY), true);
  ctx2.setModelMode("claude");
  ctx2.setOrderMode("all");
  ctx2.setSpeed("fast");
  ctx2.run();
  await waitFor(function () { return af.pending.length === expectedChunks; }, "Z9: fetch 待ち(チャンク分割ぶん)");
  var entries = af.pending.splice(0, af.pending.length);
  var expectedInput = 0;
  var expectedOutput = 0;
  entries.forEach(function (entry, i) {
    var body = JSON.parse(entry.init.body);
    var schemaProps = body.output_config.format.schema.properties;
    var chunkKeys = Object.keys(schemaProps);
    var answer = {};
    chunkKeys.forEach(function (k) {
      var m = /^r(\d)c(\d)$/.exec(k);
      var digit = ctx2.SOLUTION[Number(m[1])][Number(m[2])];
      // 消去法(既定あり)でスキーマの候補が絞られていることがあるので、そのマスの
      // choice.enum(= 残りの数字)だけを probabilities に使う(Z8 と同じやり方)。
      var list = Array.prototype.slice.call(schemaProps[k].properties.choice.enum).map(String);
      var probabilities = {};
      var rest = list.length > 1 ? 0.4 / (list.length - 1) : 0;
      list.forEach(function (d) { probabilities[d] = d === digit ? 0.6 : rest; });
      answer[k] = { choice: digit, probabilities: probabilities, confidence: 0.4 };
    });
    var inputTokens = 100 + i; // チャンクごとに違う値にして合算を検証する
    var outputTokens = 50 + i;
    expectedInput += inputTokens;
    expectedOutput += outputTokens;
    entry.resolve({
      ok: true,
      status: 200,
      json: function () {
        return Promise.resolve({
          id: "msg_z9_" + i,
          type: "message",
          role: "assistant",
          model: "claude-opus-5",
          stop_reason: "end_turn",
          content: [{ type: "text", text: JSON.stringify(answer) }],
          usage: { input_tokens: inputTokens, output_tokens: outputTokens },
        });
      },
    });
  });
  await waitFor(function () { return ctx2.state.done === true; }, "Z9: 完了待ち");
  var records = ctx2.getRecords();
  assert.equal(records.length, ctx2.TOTAL_EMPTY, "記録の件数が空マス数と一致しない");
  assert.equal(records[0].u.i, expectedInput, "先頭の記録の入力トークンがチャンク合算になっていない");
  assert.equal(records[0].u.o, expectedOutput, "先頭の記録の出力トークンがチャンク合算になっていない");
  for (var ri = 1; ri < records.length; ri++) {
    assert.ok(!records[ri].u, "2件目以降の記録に usage が付いている(二重計上): " + JSON.stringify(records[ri]));
  }

  ctx2.render();
  assert.ok(
    ctx2.appElement.innerHTML.indexOf("(" + expectedChunks + "回に分割。先頭の1回だけ表示)") !== -1,
    "プロンプト枠にチャンク分割の注記が出ていない"
  );
});

test("Z10: 一括モード(Claude 経路)でチャンクの一部だけ失敗しても、成功していたチャンクぶんの usage を失わない(PR #75 レビュー S1)", { timeout: 10000 }, async () => {
  var af = makeAbortAwareFetch();
  var ctx = runScript(await getPageHtml(), { fetch: af.fetch });
  assert.equal(ctx.saveAnthropicKey(TEST_KEY), true);
  ctx.setModelMode("claude");
  ctx.setOrderMode("all");
  ctx.setSpeed("fast");
  ctx.run();
  var expectedChunks = Math.ceil(ctx.TOTAL_EMPTY / ctx.CLAUDE_ALL_CHUNK_SIZE);
  await waitFor(function () { return af.pending.length === expectedChunks; }, "Z10: fetch 待ち(チャンク分割ぶん)");
  var entries = af.pending.splice(0, af.pending.length);

  // 先頭以外の全チャンクは成功させ、先頭チャンクだけ 429(一時的な失敗)にする。
  var expectedPartialInput = 0;
  var expectedPartialOutput = 0;
  entries.forEach(function (entry, i) {
    if (i === 0) {
      entry.resolve({
        ok: false,
        status: 429,
        headers: { get: function () { return null; } },
        json: function () { return Promise.resolve({ error: { message: "rate limited" } }); },
      });
      return;
    }
    var body = JSON.parse(entry.init.body);
    var schemaProps = body.output_config.format.schema.properties;
    var chunkKeys = Object.keys(schemaProps);
    var answer = {};
    chunkKeys.forEach(function (k) {
      var m = /^r(\d)c(\d)$/.exec(k);
      var digit = ctx.SOLUTION[Number(m[1])][Number(m[2])];
      var list = Array.prototype.slice.call(schemaProps[k].properties.choice.enum).map(String);
      var probabilities = {};
      var rest = list.length > 1 ? 0.4 / (list.length - 1) : 0;
      list.forEach(function (d) { probabilities[d] = d === digit ? 0.6 : rest; });
      answer[k] = { choice: digit, probabilities: probabilities, confidence: 0.4 };
    });
    var inputTokens = 100 + i;
    var outputTokens = 50 + i;
    expectedPartialInput += inputTokens;
    expectedPartialOutput += outputTokens;
    entry.resolve({
      ok: true,
      status: 200,
      json: function () {
        return Promise.resolve({
          id: "msg_z10_" + i,
          type: "message",
          role: "assistant",
          model: "claude-opus-5",
          stop_reason: "end_turn",
          content: [{ type: "text", text: JSON.stringify(answer) }],
          usage: { input_tokens: inputTokens, output_tokens: outputTokens },
        });
      },
    });
  });

  await waitFor(function () { return ctx.isPaused() && ctx.state.pauseReason !== null; }, "Z10: 一時的な失敗での停止待ち");
  assert.ok(ctx.carryUsage, "成功していたチャンクぶんの usage が carryUsage に積まれていない");
  assert.equal(ctx.carryUsage.usage.i, expectedPartialInput, "carryUsage の入力トークンが成功したチャンクの合計と一致しない");
  assert.equal(ctx.carryUsage.usage.o, expectedPartialOutput, "carryUsage の出力トークンが成功したチャンクの合計と一致しない");

  // プロンプト枠には「失敗した1回を表示」の注記が出る(先頭チャンクではなく実際に失敗したチャンク)
  ctx.render();
  assert.ok(
    ctx.appElement.innerHTML.indexOf("(" + expectedChunks + "回に分割。失敗した1回を表示)") !== -1,
    "プロンプト枠に失敗チャンクの注記が出ていない"
  );

  // 再開すると、その周をもう一度最初から呼び直す(全チャンク再送信)。今度は全部成功させる。
  ctx.run();
  await waitFor(function () { return af.pending.length === expectedChunks; }, "Z10: 再開後の fetch 待ち(チャンク分割ぶん)");
  var retryEntries = af.pending.splice(0, af.pending.length);
  var expectedRetryInput = 0;
  var expectedRetryOutput = 0;
  retryEntries.forEach(function (entry, i) {
    var body = JSON.parse(entry.init.body);
    var schemaProps = body.output_config.format.schema.properties;
    var chunkKeys = Object.keys(schemaProps);
    var answer = {};
    chunkKeys.forEach(function (k) {
      var m = /^r(\d)c(\d)$/.exec(k);
      var digit = ctx.SOLUTION[Number(m[1])][Number(m[2])];
      var list = Array.prototype.slice.call(schemaProps[k].properties.choice.enum).map(String);
      var probabilities = {};
      var rest = list.length > 1 ? 0.4 / (list.length - 1) : 0;
      list.forEach(function (d) { probabilities[d] = d === digit ? 0.6 : rest; });
      answer[k] = { choice: digit, probabilities: probabilities, confidence: 0.4 };
    });
    var inputTokens = 10 + i;
    var outputTokens = 5 + i;
    expectedRetryInput += inputTokens;
    expectedRetryOutput += outputTokens;
    entry.resolve({
      ok: true,
      status: 200,
      json: function () {
        return Promise.resolve({
          id: "msg_z10r_" + i,
          type: "message",
          role: "assistant",
          model: "claude-opus-5",
          stop_reason: "end_turn",
          content: [{ type: "text", text: JSON.stringify(answer) }],
          usage: { input_tokens: inputTokens, output_tokens: outputTokens },
        });
      },
    });
  });
  await waitFor(function () { return ctx.state.done === true; }, "Z10: 完了待ち");
  var records = ctx.getRecords();
  assert.equal(records.length, ctx.TOTAL_EMPTY, "記録の件数が空マス数と一致しない");
  // 先頭の記録には、失敗した周の成功ぶん(carryUsage)+ 再開後の周ぶんが両方乗る
  assert.equal(records[0].u.i, expectedPartialInput + expectedRetryInput, "先頭の記録の入力トークンに carryUsage が合算されていない");
  assert.equal(records[0].u.o, expectedPartialOutput + expectedRetryOutput, "先頭の記録の出力トークンに carryUsage が合算されていない");
});

// ---------------------------------------------------------------------------
// 計時・コスト(Issue #55・#56、SPEC 3章 F1・F1'・5章)。S/T/W/Y/Z 系と同じ
// runScript / makeAbortAwareFetch / waitFor を使う。nowMs() を差し替えて
// Date.now() に頼らず決定的に検証する。
// ---------------------------------------------------------------------------

/** ANSWER_KEY(完成盤)の指定セルだけを "." にした81文字の盤面文字列を作る。 */
function blankCells(solved, cells) {
  var rows = solved.map(function (r) { return r.split(""); });
  cells.forEach(function (rc) { rows[rc[0]][rc[1]] = "."; });
  return rows.map(function (r) { return r.join(""); }).join("");
}

/** 数値の近似比較(浮動小数点の丸め誤差を許容する)。 */
function approxEqual(actual, expected, label) {
  assert.ok(Math.abs(actual - expected) < 1e-9, (label || "") + ": " + actual + " !== " + expected);
}

test("AA1: 周の処理時間は nowMs() の差し替えで確定値になり、停止中を数えない(停止→時間経過→再開→完了)", { timeout: 10000 }, async () => {
  var af = makeAbortAwareFetch();
  var ctx = runScript(await getPageHtml(), { fetch: af.fetch });

  // 空マス2つ(離れた位置)だけの小さい盤面に差し替える。一意解(ANSWER_KEY に戻るはず)。
  var puzzleStr = blankCells(ANSWER_KEY, [[0, 0], [4, 4]]);
  assert.ok(ctx.applyPuzzleFromString(puzzleStr), "テスト用の小さい盤面の適用に失敗した(一意解でない?)");
  assert.equal(ctx.TOTAL_EMPTY, 2);

  var fakeNow = 1000;
  ctx.nowMs = function () { return fakeNow; };

  ctx.run();
  assert.equal(ctx.runningSince, 1000, "run() で runningSince が立っていない");

  // 1マス目: 300ms かけて応答が返る想定
  await waitFor(function () { return af.pending.length === 1; }, "AA1: 1マス目の fetch 待ち");
  var e1 = af.pending.shift();
  var b1 = JSON.parse(e1.init.body);
  fakeNow = 1300;
  e1.resolve(makeCorrectResponse(ctx, b1.target.row, b1.target.col, b1.puzzle));
  await waitFor(function () { return Object.keys(ctx.state.values).length === 1; }, "AA1: 1マス目の確定待ち");

  // 2マス目: in-flight のまま 100ms 進めて stop()
  await waitFor(function () { return af.pending.length === 1; }, "AA1: 2マス目の fetch 待ち");
  fakeNow = 1400;
  ctx.stop();
  var stale = af.pending.shift();
  assert.equal(stale.settled, true, "stop() で in-flight の fetch が abort されていない");
  assert.equal(ctx.state.running, false);
  assert.equal(ctx.runningSince, null, "停止したのに runningSince が残っている");
  assert.equal(ctx.totalElapsedMs, 400, "停止時点の累計が 400ms でない: " + ctx.totalElapsedMs);
  assert.equal(ctx.roundElapsedMs, 400, "停止時点の周の累計が 400ms でない: " + ctx.roundElapsedMs);

  // 停止中に 3600ms 経過(数えないはず)
  fakeNow = 5000;

  // 再開。2マス目からやり直す
  ctx.run();
  assert.equal(ctx.runningSince, 5000, "run() で runningSince が再アンカーされていない");
  await waitFor(function () { return af.pending.length === 1; }, "AA1: 再開後の2マス目の fetch 待ち");
  var e2 = af.pending.shift();
  var b2 = JSON.parse(e2.init.body);
  fakeNow = 5200;
  e2.resolve(makeCorrectResponse(ctx, b2.target.row, b2.target.col, b2.puzzle));

  await waitFor(function () { return ctx.state.done === true; }, "AA1: 完了待ち");

  assert.equal(ctx.state.roundsToSolve, 1);
  assert.equal(ctx.state.roundLog.length, 1);
  // 停止中の 3600ms(1400 → 5000)は数えない: 400(1000〜1400) + 200(5000〜5200) = 600ms
  assert.equal(ctx.state.roundLog[0].ms, 600, "周の処理時間が停止中を除いた 600ms になっていない: " + ctx.state.roundLog[0].ms);
  assert.equal(ctx.totalElapsedMs, 600, "全体の処理時間も 600ms のはず(この実行は1周だけなので)");
  assert.equal(ctx.roundElapsedMs, 0, "完了後は次周のために周の積算が0に戻っているはず");
});

test("AA2: 周回ログの行と合計行の書式(formatRoundLogLine/formatTotalSummary/formatMs/formatUsd)", async () => {
  var ctx = runScript(await getPageHtml());

  assert.equal(ctx.formatMs(0), "0 ms");
  assert.equal(ctx.formatMs(3214), "3,214 ms");
  assert.equal(ctx.formatMs(12345), "12,345 ms");
  assert.equal(ctx.formatMs(-5), "0 ms", "負値は0扱いのはず");

  assert.equal(ctx.formatUsd(0), "$0");
  assert.equal(ctx.formatUsd(0.00003), "$0.00003");
  assert.equal(ctx.formatUsd(0.0004), "$0.0004");
  assert.equal(ctx.formatUsd(0.012), "$0.012");
  assert.equal(ctx.formatUsd(0.0012), "$0.0012");
  assert.equal(ctx.formatUsd(0.01), "$0.01");

  var entry = { round: 1, correct: 12, total: 51, ms: 3214, cost: 0.0004, m: "typesafe/jev" };
  assert.equal(
    ctx.formatRoundLogLine(entry),
    "1周目: 51中12正解 (24%) — 3,214 ms / $0.0004",
    "周回ログの1行の書式が違う: " + ctx.formatRoundLogLine(entry)
  );

  ctx.state.roundLog = [entry, entry, entry];
  ctx.totalElapsedMs = 12345;
  ctx.totalCostUsd = 0.0012;
  assert.equal(
    ctx.formatTotalSummary(),
    "合計 12,345 ms / $0.0012(3周)",
    "合計行の書式が違う: " + ctx.formatTotalSummary()
  );
});

test("AA3: 記録に u/t が付く。一括モードは周の先頭1件だけ、確信度順はマス選び+数字の合算", { timeout: 10000 }, async () => {
  // (a) 左上から(Jev): その呼び出しの usage がそのまま record.u に載り、t(レイテンシ)も付く
  {
    var af = makeAbortAwareFetch();
    var ctx = runScript(await getPageHtml(), { fetch: af.fetch });
    ctx.applyPuzzleFromString(blankCells(ANSWER_KEY, [[0, 0]]));
    ctx.run();
    await waitFor(function () { return af.pending.length === 1; }, "AA3a: fetch 待ち");
    var e = af.pending.shift();
    var b = JSON.parse(e.init.body);
    var res = await makeCorrectResponse(ctx, b.target.row, b.target.col, b.puzzle).json();
    res.usage = { input_tokens: 700, output_tokens: 90 };
    e.resolve({ ok: true, json: function () { return Promise.resolve(res); } });
    await waitFor(function () { return ctx.state.done === true; }, "AA3a: 完了待ち");
    var records = ctx.getRecords();
    assert.equal(records.length, 1);
    // records[0].u は vm レルムのオブジェクトなので deepEqual ではなく値で比較する(hostRows と同じ理由)
    assert.equal(records[0].u.i, 700, "usage が record.u に載っていない: " + JSON.stringify(records[0].u));
    assert.equal(records[0].u.o, 90);
    assert.equal(typeof records[0].t, "number", "t(レイテンシ)が付いていない");
    assert.ok(records[0].t >= 0);
  }

  // (b) 確信度順(Jev): マス選び + 数字の usage を合算して1件に付ける
  {
    var af2 = makeAbortAwareFetch();
    var ctx2 = runScript(await getPageHtml(), { fetch: af2.fetch });
    ctx2.applyPuzzleFromString(blankCells(ANSWER_KEY, [[0, 0]]));
    ctx2.setOrderMode("confidence");
    ctx2.run();
    await waitFor(function () { return af2.pending.length === 1; }, "AA3b: マス選びの fetch 待ち");
    var selEntry = af2.pending.shift();
    var selBody = JSON.parse(selEntry.init.body);
    var keys = ctx2.selectionKeys();
    var selRes = await makeCellResponse(selBody.puzzle, keys, keys[0]).json();
    selRes.usage = { input_tokens: 300, output_tokens: 20 };
    selEntry.resolve({ ok: true, json: function () { return Promise.resolve(selRes); } });

    await waitFor(function () { return af2.pending.length === 1; }, "AA3b: 数字判定の fetch 待ち");
    var digitEntry = af2.pending.shift();
    var digitBody = JSON.parse(digitEntry.init.body);
    var digitRes = await makeCorrectResponse(ctx2, digitBody.target.row, digitBody.target.col, digitBody.puzzle).json();
    digitRes.usage = { input_tokens: 700, output_tokens: 90 };
    digitEntry.resolve({ ok: true, json: function () { return Promise.resolve(digitRes); } });

    await waitFor(function () { return ctx2.state.done === true; }, "AA3b: 完了待ち");
    var records2 = ctx2.getRecords();
    assert.equal(records2.length, 1);
    assert.equal(records2[0].u.i, 1000, "マス選び+数字の usage が合算されていない: " + JSON.stringify(records2[0].u));
    assert.equal(records2[0].u.o, 110);
    assert.equal(typeof records2[0].t, "number");
  }

  // (c) 一括(Jev): 周の先頭1件だけに u/t が付く(2件目以降は付かない=二重計上しない)
  {
    var af3 = makeAbortAwareFetch();
    var ctx3 = runScript(await getPageHtml(), { fetch: af3.fetch });
    ctx3.applyPuzzleFromString(blankCells(ANSWER_KEY, [[0, 0], [4, 4]]));
    ctx3.setOrderMode("all");
    ctx3.run();
    await waitFor(function () { return af3.pending.length === 1; }, "AA3c: 一括の fetch 待ち");
    var allEntry = af3.pending.shift();
    var allBody = JSON.parse(allEntry.init.body);
    var allKeys = ctx3.selectionKeys();
    var allRes = await makeAllResponse(ctx3, allBody.puzzle, allKeys, []).json();
    allRes.usage = { input_tokens: 9000, output_tokens: 4000 };
    allEntry.resolve({ ok: true, json: function () { return Promise.resolve(allRes); } });
    await waitFor(function () { return ctx3.state.done === true; }, "AA3c: 完了待ち");
    var records3 = ctx3.getRecords();
    assert.equal(records3.length, 2);
    assert.equal(records3[0].u.i, 9000, "一括の先頭レコードに usage が付いていない");
    assert.equal(records3[0].u.o, 4000);
    assert.equal(records3[1].u, undefined, "一括の2件目以降にも usage が付いている(二重計上)");
    assert.equal(typeof records3[0].t, "number");
    assert.equal(records3[1].t, undefined, "一括の2件目にも t が付いている");
  }
});

test("AA4: costOf() と formatUsd()(Jev出力無料・Claudeの入力/出力単価・+think/allの剥がし・未知モデル)", async () => {
  var ctx = runScript(await getPageHtml());

  // Jev: 入力 0.042 / 100万トークン、出力無料
  approxEqual(ctx.costOf({ m: "typesafe/jev", u: { i: 1000000, o: 1000000 } }), 0.042, "Jev の入力単価");
  // "/all" を剥がして typesafe/jev の単価を引く
  approxEqual(ctx.costOf({ m: "typesafe/jev/all", u: { i: 1000000, o: 0 } }), 0.042, "typesafe/jev/all");
  // Claude opus(+think を剥がす。入力5・出力25)
  approxEqual(ctx.costOf({ m: "claude-opus-5+think", u: { i: 1000000, o: 1000000 } }), 30, "claude-opus-5+think");
  // "+think" と "/all" の両方を剥がす
  approxEqual(ctx.costOf({ m: "claude-opus-5+think/all", u: { i: 1000000, o: 0 } }), 5, "claude-opus-5+think/all");
  // cache_read_input_tokens(ci)は入力単価の10%
  approxEqual(ctx.costOf({ m: "claude-sonnet-5", u: { i: 0, o: 0 }, ci: 1000000 }), 0.2, "ci(キャッシュ読み)は入力単価の10%");

  // 単価未設定のモデルは 0 扱い
  assert.equal(ctx.costOf({ m: "some-unknown-model", u: { i: 1000000, o: 1000000 } }), 0);
  assert.equal(ctx.isPricedModel("some-unknown-model"), false);
  assert.equal(ctx.isPricedModel("typesafe/jev"), true);

  // usage の無い記録は 0
  assert.equal(ctx.costOf({ m: "typesafe/jev" }), 0);
  assert.equal(ctx.costOf(null), 0);

  // formatUsd: $0.01以上は小数4桁まで(末尾0は削る)、それ未満は有効数字2桁程度
  assert.equal(ctx.formatUsd(0), "$0");
  assert.equal(ctx.formatUsd(0.00003), "$0.00003");
  assert.equal(ctx.formatUsd(0.0004), "$0.0004");
  assert.equal(ctx.formatUsd(0.012), "$0.012");
  assert.equal(ctx.formatUsd(0.01), "$0.01");
  assert.equal(ctx.formatUsd(1), "$1");

  // formatUsdForModel: 単価未設定なら「(単価未設定)」が付く
  assert.ok(ctx.formatUsdForModel(0, "some-unknown-model").indexOf("単価未設定") !== -1);
  assert.equal(ctx.formatUsdForModel(0.042, "typesafe/jev"), "$0.042");
});

test("AA5: 単価の読み込みは既定値、壊れた/不正な localStorage は既定値にフォールバックする(Issue #76: 編集 UI は削除、読み込みだけ残す)", async () => {
  var ctx = runScript(await getPageHtml());
  var defaults = ctx.defaultPrices();
  assert.deepEqual(ctx.getPrices(), defaults);

  // 単価を編集する UI(単価パネル)は Issue #76 で削除した。setPrice()/resetPrices() も
  // それに伴って削除済み(呼び出し元が無くなったため)。loadPrices() 自体は、この変更より
  // 前にパネルから保存された localStorage の値をそのまま尊重するので、読み込みの経路だけ
  // 残して検証する。

  // 壊れた localStorage は既定値にフォールバックする
  ctx.localStorage.setItem("scc.prices.v1", "not json");
  assert.deepEqual(ctx.loadPrices(), defaults, "壊れたJSONで既定値に戻っていない");
  ctx.localStorage.setItem("scc.prices.v1", JSON.stringify([1, 2, 3]));
  assert.deepEqual(ctx.loadPrices(), defaults, "配列(オブジェクトでない)で既定値に戻っていない");
  ctx.localStorage.setItem("scc.prices.v1", JSON.stringify({ "typesafe/jev": { in: -1, out: 0 } }));
  assert.equal(
    ctx.loadPrices()["typesafe/jev"].in,
    defaults["typesafe/jev"].in,
    "不正なエントリ(負値)が採用されてしまった"
  );

  // 以前のパネルが保存した正当な値は、削除後もそのまま読み込まれる(読み込み専用の後方互換)
  ctx.localStorage.setItem("scc.prices.v1", JSON.stringify({ "typesafe/jev": { in: 0.1, out: 0 } }));
  assert.equal(ctx.loadPrices()["typesafe/jev"].in, 0.1, "旧パネルが保存した値が読み込まれない");
});

test("AA6: postStatus() に elapsedMs/costUsd が乗り、比較シェルの見出しに ms と $ が出る", async () => {
  var posted = [];
  var fakeWindow = {
    parent: {
      postMessage: function (payload, origin) { posted.push({ payload: payload, origin: origin }); },
    },
    addEventListener: function () {},
  };
  var ctx = runScript(await getPageHtml(), {
    location: { pathname: "/", search: "embed=1", origin: "https://example.com" },
    window: fakeWindow,
  });
  ctx.render();
  assert.ok(posted.length > 0, "postMessage が呼ばれていない(embed=1 なのに)");
  var last = posted[posted.length - 1];
  assert.equal(typeof last.payload.elapsedMs, "number", "elapsedMs が status に乗っていない");
  assert.equal(typeof last.payload.costUsd, "number", "costUsd が status に乗っていない");

  // 比較シェル: renderCompareStatusHtml が status.elapsedMs / costUsd を ms / $ で表示する
  var compareCtx = runScript(await getPageHtml(), {
    location: { pathname: "/compare", search: "", origin: "https://example.com" },
  });
  compareCtx.compareStatus.jev = {
    type: "status", model: "typesafe/jev", round: 2, correct: 5, total: 51, remaining: 40,
    running: true, paused: false, done: false, elapsedMs: 12345, costUsd: 0.0012,
  };
  var html = compareCtx.renderCompareStatusHtml("jev");
  assert.ok(html.indexOf("12,345 ms") !== -1, "比較シェルの見出しに ms 表記が出ていない: " + html);
  assert.ok(html.indexOf("$0.0012") !== -1, "比較シェルの見出しに $ 表記が出ていない: " + html);
});

test("AA7: #55 より前の記録(t がエポックミリ秒)は読み込み時に t → at に付け替え、新しい記録の t(レイテンシ)はそのまま", async () => {
  var legacy = [
    { t: 1758500000000, p: "x", r: 0, c: 2, round: 1, choice: "4", pc: 0.6, conf: 0.3, ok: true, m: "typesafe/jev" },
    { at: 1758500001000, t: 1234, u: { i: 665, o: 80 }, p: "x", r: 0, c: 3, round: 1, choice: "6", pc: 0.5, conf: 0.2, ok: true, m: "typesafe/jev" },
  ];
  var store = {};
  store["scc.records.v1"] = JSON.stringify(legacy);
  var ctx = runScript(await getPageHtml(), {
    localStorage: {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
      setItem: function (k, v) { store[k] = String(v); },
      removeItem: function (k) { delete store[k]; },
    },
  });
  var recs = ctx.getRecords();
  assert.equal(recs.length, 2);
  assert.equal(recs[0].at, 1758500000000, "古い記録の t が at に移っていない");
  assert.equal(recs[0].t, undefined, "古い記録の t(時刻)がレイテンシとして残っている");
  assert.equal(recs[1].at, 1758500001000);
  assert.equal(recs[1].t, 1234, "新しい記録の t(レイテンシ)が変わった");
});

test("AA8: 一括モードで周の先頭マスの確定待ち中に stop() → run() しても、先頭の記録に u/t が付く(PR #67 レビュー M1)", { timeout: 10000 }, async () => {
  var af = makeAbortAwareFetch();
  var timers = makeManualTimers();
  var ctx = runScript(await getPageHtml(), { fetch: af.fetch, setTimeout: timers.setTimeout });
  ctx.applyPuzzleFromString(blankCells(ANSWER_KEY, [[0, 0], [4, 4]]));
  ctx.setOrderMode("all");
  ctx.run();
  await waitFor(function () { return af.pending.length === 1; }, "AA8: 一括の fetch 待ち");
  var entry = af.pending.shift();
  var body = JSON.parse(entry.init.body);
  var res = await makeAllResponse(ctx, body.puzzle, ctx.selectionKeys(), []).json();
  res.usage = { input_tokens: 9000, output_tokens: 4000 };
  entry.resolve({ ok: true, json: function () { return Promise.resolve(res); } });
  // 先頭マスがフォーカスされ、確定のタイマーが積まれた状態で停止する
  await waitFor(function () { return ctx.state.focusedKey !== null && timers.length() > 0; }, "AA8: 先頭マスの確定待ち");
  ctx.stop();
  assert.equal(ctx.state.running, false);
  assert.equal(ctx.getRecords().length, 0, "停止で確定していないのに記録がある");
  // 再開: キャッシュから同じマスを確定する(fetch は飛ばない)
  ctx.run();
  while (!ctx.state.done) {
    await waitFor(function () { return ctx.state.done || timers.length() > 0; }, "AA8: タイマー待ち");
    if (!ctx.state.done) timers.fireNext();
  }
  assert.equal(af.pending.length, 0, "再開で一括を呼び直している");
  var records = ctx.getRecords();
  assert.equal(records.length, 2);
  assert.equal(records[0].u && records[0].u.i, 9000, "停止 → 再開で先頭の記録の usage が消えた: " + JSON.stringify(records[0].u));
  assert.equal(records[0].u.o, 4000);
  assert.equal(typeof records[0].t, "number");
  assert.equal(records[1].u, undefined, "2件目にも usage が付いている");
  assert.ok(ctx.totalCostUsd > 0, "累計コストが 0 のまま");
});

test("AA9: 確信度順で数字判定の in-flight 中に stop() → run() すると、届いていたマス選びぶんの usage が持ち越される(PR #67 レビュー S2)", { timeout: 10000 }, async () => {
  var af = makeAbortAwareFetch();
  var ctx = runScript(await getPageHtml(), { fetch: af.fetch });
  ctx.applyPuzzleFromString(blankCells(ANSWER_KEY, [[0, 0], [4, 4]]));
  ctx.setOrderMode("confidence");
  ctx.setSpeed("fast");
  ctx.run();

  // 1回目のマス選び(usage 100/10)
  await waitFor(function () { return af.pending.length === 1; }, "AA9: マス選び1の fetch 待ち");
  var sel1 = af.pending.shift();
  var selBody1 = JSON.parse(sel1.init.body);
  var keys = ctx.selectionKeys();
  var selRes1 = await makeCellResponse(selBody1.puzzle, keys, keys[0]).json();
  selRes1.usage = { input_tokens: 100, output_tokens: 10 };
  sel1.resolve({ ok: true, json: function () { return Promise.resolve(selRes1); } });

  // 数字判定が in-flight のまま停止(この呼び出しぶんは測れない)
  await waitFor(function () { return af.pending.length === 1 && ctx.state.focusedKey !== null; }, "AA9: 数字判定の fetch 待ち");
  ctx.stop();
  af.pending.shift();
  assert.equal(ctx.getRecords().length, 0);

  // 再開: マス選びからやり直す(usage 200/20)→ 数字(usage 700/80)
  ctx.run();
  await waitFor(function () { return af.pending.length === 1; }, "AA9: マス選び2の fetch 待ち");
  var sel2 = af.pending.shift();
  var selBody2 = JSON.parse(sel2.init.body);
  assert.equal(selBody2.ask, "cell");
  var selRes2 = await makeCellResponse(selBody2.puzzle, keys, keys[0]).json();
  selRes2.usage = { input_tokens: 200, output_tokens: 20 };
  sel2.resolve({ ok: true, json: function () { return Promise.resolve(selRes2); } });
  await waitFor(function () { return af.pending.length === 1 && ctx.state.focusedKey !== null; }, "AA9: 数字判定2の fetch 待ち");
  var dig = af.pending.shift();
  var digBody = JSON.parse(dig.init.body);
  var digRes = await makeCorrectResponse(ctx, digBody.target.row, digBody.target.col, digBody.puzzle).json();
  digRes.usage = { input_tokens: 700, output_tokens: 80 };
  dig.resolve({ ok: true, json: function () { return Promise.resolve(digRes); } });
  await waitFor(function () { return ctx.getRecords().length === 1; }, "AA9: 確定待ち");
  var rec = ctx.getRecords()[0];
  assert.equal(rec.u.i, 1000, "マス選び2回 + 数字1回の入力トークンが合算されていない: " + JSON.stringify(rec.u));
  assert.equal(rec.u.o, 110);
});

test("AA10: 一時的な失敗の停止でも計時が止まる。reset() で計時とコストが 0 に戻る。周をまたぐ待ちは次の周の ms に入らない", { timeout: 10000 }, async () => {
  // (a) 429 の停止で時計が止まる
  var af = makeAbortAwareFetch();
  var ctx = runScript(await getPageHtml(), { fetch: af.fetch });
  var fakeNow = 1000;
  ctx.nowMs = function () { return fakeNow; };
  ctx.run();
  await waitFor(function () { return af.pending.length === 1; }, "AA10a: fetch 待ち");
  fakeNow = 1100;
  af.pending.shift().resolve({
    ok: false,
    status: 429,
    headers: { get: function (name) { return name === "Retry-After" ? "30" : null; } },
    json: function () { return Promise.resolve({ error: "レート制限(モック)" }); },
  });
  await waitFor(function () { return ctx.isPaused(); }, "AA10a: 停止待ち");
  assert.equal(ctx.runningSince, null, "一時的な失敗の停止で時計が止まっていない");
  assert.equal(ctx.totalElapsedMs, 100);
  assert.equal(ctx.roundElapsedMs, 100);
  // (b) reset() で 0 に戻る
  ctx.reset();
  assert.equal(ctx.totalElapsedMs, 0);
  assert.equal(ctx.roundElapsedMs, 0);
  assert.equal(ctx.totalCostUsd, 0);
  assert.equal(ctx.roundCostUsd, 0);
  assert.equal(ctx.runningSince, null);

  // (c) 周をまたぐ待ち時間は全体にだけ入り、次の周の ms には入らない
  var af2 = makeAbortAwareFetch();
  var timers = makeManualTimers();
  var ctx2 = runScript(await getPageHtml(), { fetch: af2.fetch, setTimeout: timers.setTimeout });
  ctx2.applyPuzzleFromString(blankCells(ANSWER_KEY, [[0, 0], [4, 4]]));
  ctx2.setSpeed("fast");
  var now2 = 10000;
  ctx2.nowMs = function () { return now2; };
  ctx2.run();
  // 1周目: 1マス目は正解、2マス目は不正解(2周目が要る)
  for (var i = 0; i < 2; i++) {
    await waitFor(function () { return af2.pending.length === 1; }, "AA10c: 1周目 " + (i + 1) + "マス目の fetch 待ち");
    var e = af2.pending.shift();
    var b = JSON.parse(e.init.body);
    now2 += 100;
    if (i === 0) e.resolve(makeCorrectResponse(ctx2, b.target.row, b.target.col, b.puzzle));
    else e.resolve(makeWrongResponse(ctx2, b.target.row, b.target.col, b.puzzle));
    // バー表示 → 確定 → 次へ のタイマーを進める
    await waitFor(function () { return timers.length() > 0; }, "AA10c: 確定タイマー待ち");
    timers.fireNext(); // 確定
    await waitFor(function () { return timers.length() > 0; }, "AA10c: 次へタイマー待ち");
    timers.fireNext(); // 次へ(2マス目の fetch、または finalizeRound)
  }
  await waitFor(function () { return ctx2.state.roundLog.length === 1; }, "AA10c: 1周目の周回ログ待ち");
  assert.equal(ctx2.state.roundLog[0].ms, 200, "1周目の ms が 200 でない: " + ctx2.state.roundLog[0].ms);
  // 周をまたぐ待ち(between-round のタイマー)中に 5000ms 経過
  now2 += 5000;
  await waitFor(function () { return timers.length() > 0; }, "AA10c: 周またぎタイマー待ち");
  timers.fireNext(); // 2周目の最初の fetch
  await waitFor(function () { return af2.pending.length === 1; }, "AA10c: 2周目の fetch 待ち");
  var e2 = af2.pending.shift();
  var b2 = JSON.parse(e2.init.body);
  now2 += 300;
  e2.resolve(makeCorrectResponse(ctx2, b2.target.row, b2.target.col, b2.puzzle));
  await waitFor(function () { return timers.length() > 0; }, "AA10c: 2周目の確定タイマー待ち");
  timers.fireNext();
  await waitFor(function () { return timers.length() > 0; }, "AA10c: 2周目の次へタイマー待ち");
  timers.fireNext();
  await waitFor(function () { return ctx2.state.done === true; }, "AA10c: 完了待ち");
  assert.equal(ctx2.state.roundLog[1].ms, 300, "2周目の ms に周またぎの待ちが入っている: " + ctx2.state.roundLog[1].ms);
  assert.equal(ctx2.totalElapsedMs, 5500, "全体の ms が 200 + 5000 + 300 でない: " + ctx2.totalElapsedMs);
});

test("AA11: 「この実行の消費」パネルに累計トークン・コスト・TPSが出る(単価パネルとは別、オーナー要望 2026-09-23)。速度(tok/s)は「最速」モードのときだけ出る", { timeout: 10000 }, async () => {
  var af = makeAbortAwareFetch();
  var ctx = runScript(await getPageHtml(), { fetch: af.fetch });
  ctx.setSpeed("fast"); // 速度の行は「最速」だけに出す(オーナー追加要望 2026-09-23)
  var fakeNow = 1000;
  ctx.nowMs = function () { return fakeNow; };

  ctx.run();
  await waitFor(function () { return af.pending.length === 1; }, "AA11: fetch 待ち");
  var entry = af.pending.shift();
  var body = JSON.parse(entry.init.body);
  var res = await makeCorrectResponse(ctx, body.target.row, body.target.col, body.puzzle).json();
  res.usage = { input_tokens: 665, output_tokens: 80 };
  fakeNow = 2000; // 1000ms かけて応答
  entry.resolve({ ok: true, json: function () { return Promise.resolve(res); } });
  await waitFor(function () { return ctx.getRecords().length === 1; }, "AA11: 確定待ち");

  assert.equal(ctx.totalTokensIn, 665, "totalTokensIn が積算されていない");
  assert.equal(ctx.totalTokensOut, 80, "totalTokensOut が積算されていない");
  assert.equal(ctx.totalLatencyMs, 1000, "totalLatencyMs(API待ち時間)が積算されていない");
  assert.ok(ctx.totalCostUsd > 0, "totalCostUsd が積算されていない");

  ctx.render();
  var html = ctx.appElement.innerHTML;
  assert.ok(html.indexOf('id="usage-panel"') !== -1, "usage-panel が描画されていない");
  assert.ok(html.indexOf("この実行の消費") !== -1);
  assert.ok(html.indexOf("入力 665") !== -1, "トークン数が表示に出ていない: " + html);
  assert.ok(html.indexOf("出力 80") !== -1);
  // formatTps(745, totalLatencyMs=1000) = 745 tok/s(演出待ちではなく API 待ち時間が分母。レビュー S1)
  assert.ok(html.indexOf("745 tok/s") !== -1, "TPS が出ていない: " + html);
  assert.ok(html.indexOf("演出の待ちは含まない") !== -1, "速度の注記が出ていない");
  // 単価パネル(単価の設定)は Issue #76 で画面から削除した。消費量だけが見える
  assert.equal(html.indexOf("単価の設定"), -1, "単価パネルが削除されずに残っている");
  assert.equal(html.indexOf('id="prices-panel"'), -1, "prices-panel が削除されずに残っている");

  // reset() でトークン累計・API待ち時間も0に戻る
  ctx.reset();
  assert.equal(ctx.totalTokensIn, 0);
  assert.equal(ctx.totalTokensOut, 0);
  assert.equal(ctx.totalLatencyMs, 0);

  // 「じっくり確認」(既定)では速度の行を出さない(トークン・コストは出す)
  var af2 = makeAbortAwareFetch();
  var ctx2 = runScript(await getPageHtml(), { fetch: af2.fetch });
  assert.equal(ctx2.state.speedMode, "slow", "既定はじっくり確認のはず");
  ctx2.run();
  await waitFor(function () { return af2.pending.length === 1; }, "AA11: じっくり確認の fetch 待ち");
  var entry2 = af2.pending.shift();
  var body2 = JSON.parse(entry2.init.body);
  var res2 = await makeCorrectResponse(ctx2, body2.target.row, body2.target.col, body2.puzzle).json();
  res2.usage = { input_tokens: 100, output_tokens: 10 };
  entry2.resolve({ ok: true, json: function () { return Promise.resolve(res2); } });
  await waitFor(function () { return ctx2.getRecords().length === 1; }, "AA11: じっくり確認の確定待ち");
  ctx2.render();
  var html2 = ctx2.appElement.innerHTML;
  assert.ok(html2.indexOf("入力 100") !== -1, "じっくり確認でもトークン数は出るはず: " + html2);
  assert.equal(html2.indexOf("tok/s"), -1, "じっくり確認モードなのに速度(tok/s)の行が出ている: " + html2);
});

test("AA13: 一括モードでも totalTokensIn/totalTokensOut/totalLatencyMs は周の先頭1件ぶんだけ積算される(二重計上しない、レビュー N4)", { timeout: 10000 }, async () => {
  var af = makeAbortAwareFetch();
  var ctx = runScript(await getPageHtml(), { fetch: af.fetch });
  ctx.applyPuzzleFromString(blankCells(ANSWER_KEY, [[0, 0], [4, 4]]));
  ctx.setOrderMode("all");
  ctx.setSpeed("fast");
  var fakeNow = 1000;
  ctx.nowMs = function () { return fakeNow; };

  ctx.run();
  await waitFor(function () { return af.pending.length === 1; }, "AA13: 一括の fetch 待ち");
  var entry = af.pending.shift();
  var body = JSON.parse(entry.init.body);
  var res = await makeAllResponse(ctx, body.puzzle, ctx.selectionKeys(), []).json();
  res.usage = { input_tokens: 9000, output_tokens: 4000 };
  fakeNow = 1800; // 800ms かけて応答
  entry.resolve({ ok: true, json: function () { return Promise.resolve(res); } });
  await waitFor(function () { return ctx.state.done === true; }, "AA13: 完了待ち");

  var records = ctx.getRecords();
  assert.equal(records.length, 2, "空マス2つのはずなのに記録が2件でない");
  assert.equal(records[0].u.i, 9000);
  assert.equal(records[1].u, undefined, "2件目にも usage が付いている(二重計上)");
  assert.equal(ctx.totalTokensIn, 9000, "totalTokensIn が二重計上されている: " + ctx.totalTokensIn);
  assert.equal(ctx.totalTokensOut, 4000, "totalTokensOut が二重計上されている: " + ctx.totalTokensOut);
  assert.equal(ctx.totalLatencyMs, 800, "totalLatencyMs が二重計上されている: " + ctx.totalLatencyMs);
});

test("AA12: formatTps() はトークンが無い・経過が短すぎる・非有限のとき「—」を返す", async () => {
  var ctx = runScript(await getPageHtml(), {});
  assert.equal(ctx.formatTps(0, 5000), "—");
  assert.equal(ctx.formatTps(100, 0), "—");
  assert.equal(ctx.formatTps(100, 199), "—");
  assert.equal(ctx.formatTps(1000, 1000), "1,000 tok/s");
  assert.equal(ctx.formatTps(745, 1000), "745 tok/s");
  assert.equal(ctx.formatTps(100, 200), "500 tok/s", "200ms ちょうどの境界");
  assert.equal(ctx.formatTps(-5, 1000), "—", "負のトークン数");
  assert.equal(ctx.formatTps(NaN, 1000), "—", "トークン数が NaN");
  assert.equal(ctx.formatTps(100, NaN), "—", "経過が NaN");
  assert.equal(ctx.formatTps(Infinity, 1000), "—", "トークン数が Infinity(崩れた文字列にならないこと)");
  assert.equal(ctx.formatTps(100, Infinity), "—", "経過が Infinity");
});

// ---------------------------------------------------------------------------
// 消去法(履歴 Issue #61・ルール候補 Issue #63)と統計カード(Issue #60)。
// S/T/W/Y/Z/AA 系と同じ runScript / makeAbortAwareFetch / waitFor / blankCells を使う。
// ---------------------------------------------------------------------------

test("AB1: ruleExclusions は固定問題の r0c2 で行・列・ブロックの数字を返す", async () => {
  var ctx = runScript(await getPageHtml());
  // GIVEN の r0c2 は空マス。行(5,3,7)・列(8)・ブロック(5,3,6,9,8)の和集合。
  var result = hostRows(ctx.ruleExclusions(0, 2));
  assert.deepEqual(result, ["3", "5", "6", "7", "8", "9"], "r0c2 のルール候補が期待どおりでない: " + result);

  // 与えられたマス(GIVEN が "." でない)は元々聞かれないが、関数自体は同じ規則で動く
  var r1 = hostRows(ctx.ruleExclusions(1, 1)); // row1 col1 は "." (6..195...)
  // row1: 6,.,.,1,9,5,.,.,. → {6,1,9,5} / col1: row0=3,row2=9,row3=.,row4=.,row5=.,row6=6,row7=.,row8=. → {3,9,6}
  // block(rows0-2,cols0-2) excluding self: (0,0)=5,(0,1)=3,(0,2)=.,(1,0)=6,(2,0)=.,(2,1)=9,(2,2)=8 → {5,3,6,9,8}
  assert.deepEqual(r1, ["1", "3", "5", "6", "8", "9"], "r1c1 のルール候補が期待どおりでない: " + r1);
});

test("AB2: excludeFor は1周目がルール由来だけ、2周目は不正解マスの履歴が足される(fetch ボディで確認)", async () => {
  var capturedBody = null;
  var ctx = runScript(await getPageHtml(), {
    fetch: function (url, init) {
      capturedBody = JSON.parse(init.body);
      return Promise.resolve({
        ok: true,
        json: async function () {
          return { probabilities: { "4": 0.9 }, choice: "4", confidence: 0.5, request: {} };
        },
      });
    },
  });

  // 1周目相当: まだ何も判定していないので wrongDigits は空 → exclude はルール由来だけ
  var round1Exclude = ctx.excludeFor(0, 2);
  assert.deepEqual(hostRows(round1Exclude), ["3", "5", "6", "7", "8", "9"]);
  await ctx.judgeCellJev(ctx.GIVEN, 0, 2, round1Exclude, null);
  assert.deepEqual(hostRows(capturedBody.exclude).sort(), ["3", "5", "6", "7", "8", "9"], "1周目の exclude がルール由来と一致しない");

  // 2周目相当: 前の周に (0,2) を "1" で外した(履歴)ことにする
  ctx.wrongDigits["0-2"] = ["1"];
  var round2Exclude = ctx.excludeFor(0, 2);
  var round2Sorted = hostRows(round2Exclude).slice().sort();
  assert.deepEqual(round2Sorted, ["1", "3", "5", "6", "7", "8", "9"], "2周目の exclude に履歴の数字が足されていない");
  await ctx.judgeCellJev(ctx.GIVEN, 0, 2, round2Exclude, null);
  assert.deepEqual(hostRows(capturedBody.exclude).sort(), round2Sorted, "2周目の fetch ボディの exclude が履歴込みになっていない");
});

test("AB3: 一括の exclude はマスごとのマップで、外す数字が無いマスは省く", async () => {
  var capturedBody = null;
  var ctx = runScript(await getPageHtml(), {
    fetch: function (url, init) {
      capturedBody = JSON.parse(init.body);
      return Promise.resolve({ ok: true, json: async function () { return { cells: {}, request: {} }; } });
    },
  });
  // ルール候補を切っておくと、履歴の無いマスは excludeFor が空配列になり判定しやすい(S1)
  ctx.setRuleMode(false);
  ctx.queue.push({ r: 0, c: 2 }, { r: 0, c: 3 });
  ctx.wrongDigits["0-2"] = ["1", "5"];

  var map = ctx.excludeMapForQueue();
  assert.deepEqual(Object.keys(map), ["r0c2"], "空マス(r0c3)が省かれていない、または r0c2 が無い");
  assert.deepEqual(hostRows(map.r0c2).sort(), ["1", "5"]);

  await ctx.askAll(null);
  assert.deepEqual(Object.keys(capturedBody.exclude), ["r0c2"], "一括の fetch ボディの exclude マップに空マスが残っている");
  assert.deepEqual(hostRows(capturedBody.exclude.r0c2).sort(), ["1", "5"]);
});

test("AB4: 履歴・ルール候補ともに「なし」なら exclude が付かない(従来どおり)", async () => {
  var capturedBody = null;
  var ctx = runScript(await getPageHtml(), {
    fetch: function (url, init) {
      capturedBody = JSON.parse(init.body);
      return Promise.resolve({
        ok: true,
        json: async function () {
          return { probabilities: { "4": 0.9 }, choice: "4", confidence: 0.5, request: {} };
        },
      });
    },
  });
  ctx.setHistoryMode(false);
  ctx.setRuleMode(false);
  assert.deepEqual(hostRows(ctx.excludeFor(0, 2)), [], "両トグルなしで excludeFor が空にならない");

  await ctx.judgeCellJev(ctx.GIVEN, 0, 2, ctx.excludeFor(0, 2), null);
  assert.equal(capturedBody.exclude, undefined, "両トグルなしなのに exclude が付いている");
  assert.deepEqual(Object.keys(capturedBody).sort(), ["puzzle", "target"], "従来どおりの payload と形が違う");

  // Claude 経路も従来どおり(9択のまま、EXCLUDE_NOTE も付かない)
  var body = ctx.buildClaudeRequest(ctx.GIVEN, 0, 2, ctx.excludeFor(0, 2));
  var schema = body.output_config.format.schema;
  assert.deepEqual(hostRows(schema.properties.choice.enum).sort(), ["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
  assert.equal(body.system.indexOf("Digits already ruled out"), -1, "exclude が無いのに system に注記が付いている");

  // 一括モードも exclude マップが空なら付かない
  var capturedAllBody = null;
  var ctxAll = runScript(await getPageHtml(), {
    fetch: function (url, init) {
      capturedAllBody = JSON.parse(init.body);
      return Promise.resolve({ ok: true, json: async function () { return { cells: {}, request: {} }; } });
    },
  });
  ctxAll.setHistoryMode(false);
  ctxAll.setRuleMode(false);
  ctxAll.queue.push({ r: 0, c: 2 });
  await ctxAll.askAll(null);
  assert.equal(capturedAllBody.exclude, undefined, "一括で両トグルなしなのに exclude が付いている");
});

test("AB5: Claude のスキーマは残りの数字だけ、system に1文、応答検証も残りの数字で行う", async () => {
  var ctx = runScript(await getPageHtml());
  var exclude = ["3", "5", "6", "7", "8", "9"]; // r0c2 のルール由来(正解は "4")
  var remaining = ["1", "2", "4"];

  // digit 判定(Issue #61・#63)
  var body = ctx.buildClaudeRequest(ctx.GIVEN, 0, 2, exclude);
  var schema = body.output_config.format.schema;
  assert.deepEqual(hostRows(schema.properties.choice.enum).sort(), remaining);
  assert.deepEqual(hostRows(schema.properties.probabilities.required).sort(), remaining);
  assert.deepEqual(Object.keys(schema.properties.probabilities.properties).sort(), remaining);
  assert.ok(body.system.indexOf("Digits already ruled out") !== -1, "system に EXCLUDE_NOTE が無い");

  // 応答検証: 残りの数字だけを満たす応答は OK
  var goodData = {
    content: [{ type: "text", text: JSON.stringify({ choice: "4", probabilities: { "1": 0.1, "2": 0.1, "4": 0.8 }, confidence: 0.5 }) }],
  };
  var goodParsed = ctx.parseClaudeDigitAnswer(goodData, remaining);
  assert.equal(goodParsed.error, undefined, "残りの数字だけの正しい応答が検証に落ちた: " + goodParsed.error);

  // 除外した数字(exclude 後は候補にない "3")を choice にすると 502 相当のエラーになる
  var badData = {
    content: [{ type: "text", text: JSON.stringify({ choice: "3", probabilities: { "1": 0.1, "2": 0.1, "3": 0.8 }, confidence: 0.5 }) }],
  };
  var badParsed = ctx.parseClaudeDigitAnswer(badData, remaining);
  assert.ok(badParsed.error && badParsed.error.indexOf("exclude後") !== -1, "除外した数字を choice にした応答が検証を通ってしまった");

  // 一括モード(Issue #48)のスキーマ・system・応答検証
  var keys = ["r0c2", "r0c3"];
  var excludeByKey = { "r0c2": exclude };
  var allBody = ctx.buildClaudeAllRequest(ctx.GIVEN, keys, excludeByKey);
  var allSchema = allBody.output_config.format.schema;
  assert.deepEqual(hostRows(allSchema.properties.r0c2.properties.choice.enum).sort(), remaining, "一括の r0c2 の enum が残りの数字だけでない");
  assert.deepEqual(
    hostRows(allSchema.properties.r0c3.properties.choice.enum).sort(),
    ["1", "2", "3", "4", "5", "6", "7", "8", "9"],
    "exclude の無い r0c3 まで絞られている"
  );
  assert.ok(allBody.system.indexOf("Digits already ruled out") !== -1, "一括の system に EXCLUDE_NOTE が無い");

  var allGoodAnswer = {
    r0c2: { choice: "4", probabilities: { "1": 0.1, "2": 0.1, "4": 0.8 }, confidence: 0.5 },
    r0c3: { choice: "9", probabilities: (function () {
      var p = {};
      ["1", "2", "3", "4", "5", "6", "7", "8", "9"].forEach(function (d) { p[d] = d === "9" ? 0.9 : 0.0125; });
      return p;
    })(), confidence: 0.5 },
  };
  assert.equal(ctx.validateClaudeAllAnswer(allGoodAnswer, keys, excludeByKey), null, "一括の正しい応答が検証に落ちた");

  var allBadAnswer = {
    r0c2: { choice: "3", probabilities: { "1": 0.1, "2": 0.1, "3": 0.8 }, confidence: 0.5 },
    r0c3: allGoodAnswer.r0c3,
  };
  var allBad = ctx.validateClaudeAllAnswer(allBadAnswer, keys, excludeByKey);
  assert.ok(allBad && allBad.indexOf("r0c2") !== -1 && allBad.indexOf("exclude後") !== -1, "一括で除外した数字を choice にした応答が検証を通ってしまった");
});

test("AB6: 記録に n(候補数)・e(履歴トグル)・rc(ルール候補トグル)が付く", async () => {
  var ctx = runScript(await getPageHtml());

  // 両トグルありで候補3個の判定(SOLUTION[0][2] === "4")
  ctx.state.focusedKey = "0-2";
  ctx.pendingCommit = {
    r: 0,
    c: 2,
    choice: "4",
    confidence: 0.5,
    probabilities: { "1": 0.05, "2": 0.05, "4": 0.9 },
  };
  ctx.commitFocused();
  var rec1 = ctx.getRecords()[0];
  assert.equal(rec1.ok, true);
  assert.equal(rec1.n, 3, "候補3個の記録の n が3でない: " + rec1.n);
  assert.equal(rec1.e, true, "履歴トグルの記録が true でない");
  assert.equal(rec1.rc, true, "ルール候補トグルの記録が true でない");

  // 両トグルなしで候補9個の判定(SOLUTION[0][3] === "6")
  ctx.setHistoryMode(false);
  ctx.setRuleMode(false);
  ctx.state.focusedKey = "0-3";
  ctx.pendingCommit = {
    r: 0,
    c: 3,
    choice: "6",
    confidence: 0.5,
    probabilities: (function () {
      var p = {};
      ["1", "2", "3", "4", "5", "6", "7", "8", "9"].forEach(function (d) { p[d] = d === "6" ? 0.9 : 0.0125; });
      return p;
    })(),
  };
  ctx.commitFocused();
  var rec2 = ctx.getRecords()[1];
  assert.equal(rec2.n, 9, "候補9個の記録の n が9でない: " + rec2.n);
  assert.equal(rec2.e, false);
  assert.equal(rec2.rc, false);
});

test("AB7: reset() / newPuzzle() で wrongDigits が消え、停止/再開では保たれる", { timeout: 10000 }, async () => {
  var ctx = runScript(await getPageHtml());

  ctx.wrongDigits["0-2"] = ["1"];
  ctx.reset();
  assert.deepEqual(Object.keys(ctx.wrongDigits), [], "reset() で wrongDigits が消えていない");

  // 停止(stop())では保たれる
  ctx.wrongDigits["0-2"] = ["1"];
  ctx.state.running = true;
  ctx.started = true;
  ctx.stop();
  assert.deepEqual(hostRows(ctx.wrongDigits["0-2"]), ["1"], "停止で wrongDigits が消えてしまった");

  // newPuzzle() でも消える
  ctx.newPuzzle();
  assert.deepEqual(Object.keys(ctx.wrongDigits), [], "newPuzzle() で wrongDigits が消えていない");
  await waitFor(function () { return ctx.generating === false; }, "AB7: 新しい問題の生成完了待ち");
});

test("AB8: URL パラメータ history=0|1 / rules=0|1(不正値は無視)。比較シェルにも同じトグルがある", async () => {
  var html = await getPageHtml();

  var ctxOff = runScript(html, { location: { pathname: "/", search: "?history=0&rules=0", origin: "https://example.com" } });
  assert.equal(ctxOff.state.historyMode, false, "history=0 が反映されていない");
  assert.equal(ctxOff.state.ruleMode, false, "rules=0 が反映されていない");

  var ctxOn = runScript(html, { location: { pathname: "/", search: "?history=1&rules=1", origin: "https://example.com" } });
  assert.equal(ctxOn.state.historyMode, true);
  assert.equal(ctxOn.state.ruleMode, true);

  // 不正値(0/1以外)は無視され、既定(あり)のまま
  var ctxBad = runScript(html, { location: { pathname: "/", search: "?history=yes&rules=nope", origin: "https://example.com" } });
  assert.equal(ctxBad.state.historyMode, true, "不正な history パラメータが既定を上書きしてしまった");
  assert.equal(ctxBad.state.ruleMode, true, "不正な rules パラメータが既定を上書きしてしまった");

  // 比較シェル(/compare)の上部バーにも同じ2トグルがあり、両 iframe に postMessage する
  var fakeDoc = makeCompareDocument();
  var messageHandlers = [];
  var fakeWindow = {
    parent: null,
    addEventListener: function (type, handler) {
      if (type === "message") messageHandlers.push(handler);
    },
    postMessage: function () {},
  };
  fakeWindow.parent = fakeWindow;
  var ctxCompare = runScript(html, {
    location: { pathname: "/compare", search: "", origin: "https://example.com" },
    document: fakeDoc,
    window: fakeWindow,
  });
  var out = ctxCompare.appElement.innerHTML;
  assert.ok(out.indexOf('id="history-toggle"') !== -1, "比較シェルに履歴トグルが無い");
  assert.ok(out.indexOf('id="rules-toggle"') !== -1, "比較シェルにルール候補トグルが無い");

  ctxCompare.compareSetHistoryMode(false);
  assert.equal(ctxCompare.state.historyMode, false);
  assert.equal(ctxCompare.compareFrames.jev.postMessageCalls[0].msg.type, "setHistoryMode");
  assert.equal(ctxCompare.compareFrames.jev.postMessageCalls[0].msg.on, false);
  assert.equal(ctxCompare.compareFrames.claude.postMessageCalls[0].msg.type, "setHistoryMode");

  ctxCompare.compareSetRuleMode(false);
  assert.equal(ctxCompare.state.ruleMode, false);
  assert.equal(ctxCompare.compareFrames.jev.postMessageCalls[1].msg.type, "setRuleMode");
  assert.equal(ctxCompare.compareFrames.jev.postMessageCalls[1].msg.on, false);
});

test("AB9: 統計カードは「この周の判定済み」「この周の正解」の2枚に分かれ、強制終了時は周回ログに専用の行が出る", { timeout: 10000 }, async () => {
  var af = makeAbortAwareFetch();
  var ctx = runScript(await getPageHtml(), { fetch: af.fetch });
  // 消去法は無関係にするため両トグルを切り、候補が枯渇しないようにする
  ctx.setHistoryMode(false);
  ctx.setRuleMode(false);
  var puzzleStr = blankCells(ANSWER_KEY, [[0, 0]]);
  assert.ok(ctx.applyPuzzleFromString(puzzleStr), "1マス盤面の適用に失敗した(一意解でない?)");
  assert.equal(ctx.TOTAL_EMPTY, 1);
  ctx.MAX_ROUNDS = 2; // 2周とも不正解にして、2周で強制終了させる

  ctx.run();
  for (var i = 0; i < 1000 && !ctx.state.done; i++) {
    while (af.pending.length) {
      var item = af.pending.shift();
      if (item.settled) continue;
      var body = JSON.parse(item.init.body);
      assert.equal(body.exclude, undefined, "AB9: 両トグルなしで exclude が付いている");
      var correctDigit = ctx.SOLUTION[body.target.row][body.target.col];
      var wrongDigit = correctDigit === "1" ? "2" : "1";
      var probabilities = {};
      ["1", "2", "3", "4", "5", "6", "7", "8", "9"].forEach(function (d) { probabilities[d] = d === wrongDigit ? 0.9 : 0.0125; });
      item.resolve({
        ok: true,
        json: async function () {
          return { probabilities: probabilities, choice: wrongDigit, confidence: 0.5, request: {} };
        },
      });
    }
    await tick();
  }
  assert.equal(ctx.state.done, true, "AB9: 2周で完了しなかった");
  assert.equal(ctx.state.stoppedAtLimit, true, "AB9: 強制終了扱いになっていない");

  ctx.render();
  var html = ctx.appElement.innerHTML;
  assert.ok(html.indexOf("この周の判定済み") !== -1, "「この周の判定済み」カードが無い");
  assert.ok(html.indexOf("この周の正解") !== -1, "「この周の正解」カードが無い");
  assert.equal(html.indexOf("この周の進捗"), -1, "旧ラベル「この周の進捗」が残っている");

  var limitEntry = ctx.state.roundLog[ctx.state.roundLog.length - 1];
  assert.equal(limitEntry.limit, true, "roundLog の末尾が強制終了の行になっていない");
  assert.equal(limitEntry.wrong, 1, "強制終了の行の不正解数が1でない: " + limitEntry.wrong);
  assert.ok(html.indexOf("2周で強制終了(最終周の不正解 1 マス)") !== -1, "強制終了の行の文言が周回ログに出ていない");
});

test("AB10: 現在の判定のバーは除外した数字を0%でなく「×」(bar excluded)で表示する", async () => {
  var ctx = runScript(await getPageHtml());
  var probs = ctx.buildDigitBars({ "1": 0.1, "2": 0.1, "4": 0.8 }, "4");
  assert.equal(probs.length, 9, "buildDigitBars が1〜9ぶん返していない");
  var excludedDigits = hostRows(probs.filter(function (p) { return p.excluded; }).map(function (p) { return p.digit; }));
  assert.deepEqual(excludedDigits.sort(), ["3", "5", "6", "7", "8", "9"]);

  var html = ctx.renderBars(probs);
  var excludedCount = (html.match(/class="bar excluded"/g) || []).length;
  assert.equal(excludedCount, 6, "除外バーの数が6個でない: " + excludedCount);
  assert.ok(html.indexOf("×") !== -1, "除外したバーに × が出ていない");
  assert.ok(html.indexOf("80%") !== -1, "choice(4)のバーが80%になっていない");
});



// ---------------------------------------------------------------------------
// M1(PR #72 レビュー、Opus): ruleExclusions() が state.values を正誤問わず参照すると、
// 誤った推測が先に確定しただけで、後から聞く別マスの「正解」まで候補から消えてしまう
// (ルール上「もう埋まっている数字」として扱われるため)。実測(固定問題): r0c2 の正解は
// 4、r0c3 の正解は 6(ruleExclusions(0,3) の素の候補は {2,6})。修正: settledKeys(前の周
// までに正解して確定したマスだけ)を周の開始時点で1回だけスナップショットし、
// ruleExclusions() はそれだけを見る。この周の推測(正誤問わず、確定していても)は
// 次の周まで反映されない。
// ---------------------------------------------------------------------------

test("AB11: 同じ周内で先に不正解が確定しても、別マスのルール候補に混ざらない(M1、純粋関数で直接確認)", async () => {
  var ctx = runScript(await getPageHtml());
  var baseline = hostRows(ctx.ruleExclusions(0, 3));
  assert.deepEqual(baseline, ["1", "3", "4", "5", "7", "8", "9"], "素の候補が前提と違う(テストの前提が崩れている)");
  assert.equal(ctx.SOLUTION[0][3], "6", "r0c3 の正解が前提と違う");

  // r0c2(正解 4)にたまたま r0c3 の正解と同じ "6" を「不正解」として確定させる
  // (settledKeys を更新せず、まだこの周の途中であることをシミュレートする)。
  ctx.state.values["0-2"] = { value: "6", status: "incorrect" };
  var afterMidRoundGuess = hostRows(ctx.ruleExclusions(0, 3));
  assert.equal(
    afterMidRoundGuess.indexOf("6"),
    -1,
    "同じ周内の(不正解だった)推測により r0c3 の正解(6)がルール候補から消えている: " + JSON.stringify(afterMidRoundGuess)
  );
  assert.deepEqual(afterMidRoundGuess, baseline, "settledKeys を更新していないのに結果が変わっている");
});

test("AB12: 前の周に正解して確定したマスは、次の周のルール候補に正しく反映される(settledKeys の伝播)", async () => {
  var ctx = runScript(await getPageHtml());
  var baseline = hostRows(ctx.ruleExclusions(0, 3));
  assert.equal(baseline.indexOf("2"), -1, "テストの前提(2 がまだ除外されていない)が崩れている: " + JSON.stringify(baseline));
  assert.equal(ctx.GIVEN[0][8], ".", "r0c8 が空マスであるという前提が崩れている");
  assert.equal(ctx.SOLUTION[0][8], "2", "r0c8 の正解が前提と違う");

  // r0c8(行0の仲間)が前の周までに正解して確定した状態をシミュレートする。
  ctx.state.values["0-8"] = { value: ctx.SOLUTION[0][8], status: "correct" };
  ctx.settledKeys = { "0-8": true };
  var afterSettled = hostRows(ctx.ruleExclusions(0, 3));
  assert.ok(
    afterSettled.indexOf("2") !== -1,
    "前の周に確定した r0c8(正解 2)がルール候補に反映されていない: " + JSON.stringify(afterSettled)
  );
  // 元の {2,6} の2択から naked single(6だけ)に絞り込まれる
  assert.deepEqual(afterSettled.sort(), baseline.concat(["2"]).sort());
});

test("AB13: excludeFor() の防御(和集合が9個になったら履歴を捨ててルール側だけにする)", async () => {
  var ctx = runScript(await getPageHtml());
  var key = "0-2";
  var rule = ctx.ruleExclusions(0, 2); // ["3","5","6","7","8","9"](固定問題での実測値)
  var ruleHost = hostRows(rule);
  var digits = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];
  var missing = digits.filter(function (d) { return ruleHost.indexOf(d) === -1; }); // ["1","2","4"]
  missing.forEach(function (d) { ctx.addWrongDigit(key, d); });
  ctx.state.historyMode = true;
  ctx.state.ruleMode = true;
  var combined = hostRows(ctx.excludeFor(0, 2));
  assert.ok(combined.length < 9, "9個全部を exclude してしまっている(Worker の400を踏む): " + JSON.stringify(combined));
  assert.deepEqual(combined.sort(), ruleHost.slice().sort(), "9個になったときにルール側だけへ倒れていない: " + JSON.stringify(combined));
});

test("AB14: 実際の実行フロー(run())でも、同じ周内の不正解が別マスへの exclude に漏れない(M1、統合テスト)", { timeout: 10000 }, async () => {
  var af = makeAbortAwareFetch();
  var ctx = runScript(await getPageHtml(), { fetch: af.fetch });
  ctx.setOrderMode("scan"); // 左上から(既定)

  ctx.run();
  await waitFor(function () { return af.pending.length === 1; }, "AB14: r0c2 の fetch 待ち");
  var e1 = af.pending.shift();
  var b1 = JSON.parse(e1.init.body);
  assert.deepEqual(b1.target, { row: 0, col: 2 });
  // r0c2 に、r0c3 の正解(6)を「不正解」として答えさせる
  var wrongDigit = ctx.SOLUTION[0][3];
  assert.notEqual(wrongDigit, ctx.SOLUTION[0][2], "テストの前提(r0c2とr0c3の正解が違う)が崩れている");
  var probabilities1 = {};
  for (var d = 1; d <= 9; d++) probabilities1[String(d)] = String(d) === wrongDigit ? 0.9 : 0.0125;
  e1.resolve({
    ok: true,
    json: async function () {
      return { probabilities: probabilities1, choice: wrongDigit, confidence: 0.5, request: b1 };
    },
  });
  await waitFor(function () { return Object.keys(ctx.state.values).length === 1; }, "AB14: r0c2 の確定待ち");
  assert.equal(ctx.state.values["0-2"].status, "incorrect");

  await waitFor(function () { return af.pending.length === 1; }, "AB14: r0c3 の fetch 待ち");
  var e2 = af.pending.shift();
  var b2 = JSON.parse(e2.init.body);
  assert.deepEqual(b2.target, { row: 0, col: 3 });
  var exclude2 = hostRows(b2.exclude || []);
  assert.equal(
    exclude2.indexOf(ctx.SOLUTION[0][3]),
    -1,
    "実際の実行フローで r0c3 の正解が exclude に混ざっている: " + JSON.stringify(exclude2)
  );

  // 完了まで進める(r0c2 は2周目に回るはず)
  var probabilities2 = {};
  for (var d2 = 1; d2 <= 9; d2++) probabilities2[String(d2)] = String(d2) === ctx.SOLUTION[0][3] ? 0.9 : 0.0125;
  e2.resolve({
    ok: true,
    json: async function () {
      return { probabilities: probabilities2, choice: ctx.SOLUTION[0][3], confidence: 0.5, request: b2 };
    },
  });
  await waitFor(function () { return af.pending.length === 1; }, "AB14: 残りマスの fetch 待ち");
  // 残りの空マス(r0c2 の再挑戦を含む)を正解で埋めて完走する
  while (!ctx.state.done) {
    var e = af.pending.shift();
    var b = JSON.parse(e.init.body);
    e.resolve(makeCorrectResponse(ctx, b.target.row, b.target.col, b.puzzle));
    await waitFor(function () { return ctx.state.done === true || af.pending.length === 1; }, "AB14: 完走ループ");
  }
});

// ---------------------------------------------------------------------------
// UI レイアウト刷新(Issue #76、オーナー要望 2026-09-23)。
// ---------------------------------------------------------------------------

test("AC1: 完了/強制終了バナーに開始から終了までの所要時間(totalElapsedMs)が出る", async () => {
  var ctx = runScript(await getPageHtml());

  ctx.totalElapsedMs = 12345;
  ctx.state.done = true;
  ctx.state.roundsToSolve = 3;
  var completionHtml = ctx.renderBanner();
  assert.ok(completionHtml.indexOf("3周ですべて正解しました") !== -1, "完了バナーの本文が無い: " + completionHtml);
  assert.ok(completionHtml.indexOf("(所要 " + ctx.formatMs(12345) + ")") !== -1, "完了バナーに所要時間が出ていない: " + completionHtml);

  ctx.state.roundsToSolve = null;
  ctx.state.stoppedAtLimit = true;
  ctx.roundWrong = [{ r: 0, c: 0 }, { r: 0, c: 1 }];
  var limitHtml = ctx.renderBanner();
  assert.ok(limitHtml.indexOf("強制終了しました") !== -1, "強制終了バナーの本文が無い: " + limitHtml);
  assert.ok(limitHtml.indexOf("所要 " + ctx.formatMs(12345)) !== -1, "強制終了バナーに所要時間が出ていない: " + limitHtml);

  // 未完了のときは所要時間を出さない(バナー自体が空になる)
  ctx.state.done = false;
  ctx.state.stoppedAtLimit = false;
  assert.equal(ctx.renderBanner(), '<div id="completion-banner"></div>');
});

test("AC2: 速度/難易度の <select> にフォーカスがあるあいだ render() は再描画を止め、フォーカスが外れると反映する(Opus レビュー S1、PR #78)", { timeout: 10000 }, async () => {
  var af = makeAbortAwareFetch();
  var app = { innerHTML: "" };
  var fakeDoc = {
    activeElement: null,
    getElementById: function (id) { return id === "app" ? app : null; },
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    createElement: function (tag) { return { tagName: tag, href: "", download: "", click: function () {} }; },
    body: { appendChild: function () {}, removeChild: function () {} },
  };
  var ctx = runScript(await getPageHtml(), { fetch: af.fetch, document: fakeDoc });
  ctx.setSpeed("fast");
  ctx.run();
  await waitFor(function () { return af.pending.length === 1; }, "AC2: fetch 待ち");

  var beforeFocusHtml = app.innerHTML;
  assert.ok(beforeFocusHtml.length > 0, "テストの前提(直前の render() で描画されている)が崩れている");

  // 速度セレクトにフォーカスがある間は、他の状態が変わっていても再描画されない
  fakeDoc.activeElement = { tagName: "SELECT", id: "speed-toggle" };
  ctx.setDifficulty("hard"); // render() を呼ぶがフォーカス中なので innerHTML は変わらないはず
  assert.equal(app.innerHTML, beforeFocusHtml, "select にフォーカスがある間に render() が innerHTML を書き換えてしまった");
  assert.equal(ctx.state.difficulty, "hard", "state 自体は render() を止めても更新されているはず");

  // select 以外の要素にフォーカスがあるとき(例: グリッドの外側をクリックした状態)は対象外
  fakeDoc.activeElement = { tagName: "BUTTON", id: "run-btn" };
  ctx.render();
  assert.notEqual(app.innerHTML, beforeFocusHtml, "select 以外にフォーカスがあるのに再描画がガードされている");

  // フォーカスが外れれば、次の render() で通常どおり反映される
  var beforeBlurHtml = app.innerHTML;
  fakeDoc.activeElement = null;
  ctx.setDifficulty("easy");
  assert.notEqual(app.innerHTML, beforeBlurHtml, "フォーカスが外れたのに再描画されない");
  assert.ok(app.innerHTML.indexOf('<option value="easy" selected>') !== -1, "最新の state が反映されていない: " + app.innerHTML);
});

// ---------------------------------------------------------------------------
// Issue #80(オーナー要望 2026-09-23): 一括+最速の描画省略トグル、「現在の判定」
// 見出し行の経過時間、比較モードのプロンプト可視化。
// ---------------------------------------------------------------------------

test("AD1: 一括+最速+描画省略(instantMode)は、1回の応答後に render() を挟まず一気に確定し、usage は先頭1件だけに付く(Issue #80)", { timeout: 10000 }, async () => {
  var af = makeAbortAwareFetch();
  var renderCount = 0;
  var htmlValue = "";
  var app = {
    get innerHTML() { return htmlValue; },
    set innerHTML(v) { htmlValue = v; renderCount++; },
  };
  var fakeDoc = {
    activeElement: null,
    getElementById: function (id) { return id === "app" ? app : null; },
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    createElement: function (tag) { return { tagName: tag, href: "", download: "", click: function () {} }; },
    body: { appendChild: function () {}, removeChild: function () {} },
  };
  var ctx = runScript(await getPageHtml(), { fetch: af.fetch, document: fakeDoc });
  ctx.applyPuzzleFromString(blankCells(ANSWER_KEY, [[0, 0], [4, 4]]));
  ctx.setOrderMode("all");
  ctx.setSpeed("fast");
  ctx.setInstantMode(true);
  assert.equal(ctx.state.instantMode, true, "setInstantMode(true) が state に反映されていない");

  ctx.run();
  await waitFor(function () { return af.pending.length === 1; }, "AD1: fetch 待ち");
  var entry = af.pending.shift();
  var body = JSON.parse(entry.init.body);
  var keys = ctx.selectionKeys();
  var allRes = await makeAllResponse(ctx, body.puzzle, keys).json();
  allRes.usage = { input_tokens: 9000, output_tokens: 4000 };

  var beforeResolveCount = renderCount;
  entry.resolve({ ok: true, json: function () { return Promise.resolve(allRes); } });

  await waitFor(function () { return ctx.state.done === true; }, "AD1: 完了待ち");

  // 通常の一括モード(Z1/Z2)は1マスごとに render() を複数回挟む(フォーカス→バー表示→確定)。
  // 描画省略が効いていれば、応答が届いてから完了までの render() はごく少数で済むはず。
  var rendersAfterResolve = renderCount - beforeResolveCount;
  assert.ok(rendersAfterResolve <= 2, "描画省略のはずが1マスずつ render() している(" + rendersAfterResolve + "回)");

  assert.equal(Object.keys(ctx.state.values).length, 2, "全マスが確定していない");
  var records = ctx.getRecords();
  assert.equal(records.length, 2, "記録の件数が空マス数と一致しない");
  records.forEach(function (rec) {
    assert.equal(rec.m, "typesafe/jev/all", "記録の m が typesafe/jev/all でない: " + rec.m);
    assert.equal(rec.o, "all", "記録の o が all でない: " + rec.o);
  });
  assert.equal(records[0].u.i, 9000, "先頭レコードに usage が付いていない");
  assert.equal(records[0].u.o, 4000);
  assert.equal(records[1].u, undefined, "2件目にも usage が付いている(二重計上)");
  assert.equal(af.pending.length, 0, "一括なのに複数回 fetch している");
});

test("AD2: 描画省略トグル(instant-toggle)は一括+最速のときだけ有効。それ以外・実行中はロックされる(Issue #80)", async () => {
  var ctx = runScript(await getPageHtml());

  function instantSelectHtml() {
    var html = ctx.renderControls();
    var m = html.match(/<select id="instant-toggle"[^>]*>/);
    assert.ok(m, "instant-toggle が見つからない: " + html);
    return m[0];
  }

  // 既定(左上から + じっくり確認)では無効
  assert.ok(instantSelectHtml().includes("disabled"), "scan+slow で無効化されていない: " + instantSelectHtml());

  ctx.setOrderMode("all");
  assert.ok(instantSelectHtml().includes("disabled"), "一括+じっくりで無効化されていない: " + instantSelectHtml());

  ctx.setSpeed("fast");
  assert.ok(!instantSelectHtml().includes("disabled"), "一括+最速で無効化されたまま: " + instantSelectHtml());

  // 実行中・停止中は他のトグルと同じ条件でロックされる(modelSettingsLocked())
  ctx.state.running = true;
  assert.ok(instantSelectHtml().includes("disabled"), "実行中に無効化されていない: " + instantSelectHtml());

  // setInstantMode() 自体もロック中は無視する(直接呼ばれても安全なように)
  ctx.state.instantMode = false;
  ctx.setInstantMode(true);
  assert.equal(ctx.state.instantMode, false, "実行中に setInstantMode が効いてしまった");
  ctx.state.running = false;

  // 選択肢のラベル
  var full = ctx.renderControls();
  assert.ok(full.indexOf(">毎回表示</option>") !== -1, "「毎回表示」の選択肢が無い: " + full);
  assert.ok(full.indexOf(">省略(最速)</option>") !== -1, "「省略(最速)」の選択肢が無い: " + full);
});

test("AD3: 描画省略が立っていても、一括+じっくり確認のときは従来どおり1マスずつ表示する(orderMode/speedMode の実行時チェック、Issue #80)", { timeout: 10000 }, async () => {
  var af = makeAbortAwareFetch();
  var ctx = runScript(await getPageHtml(), { fetch: af.fetch });
  ctx.applyPuzzleFromString(blankCells(ANSWER_KEY, [[0, 0], [4, 4]]));
  ctx.setOrderMode("all");
  ctx.setSpeed("slow");
  ctx.setInstantMode(true); // UI 上は無効化される組み合わせだが、state を直接立てても安全か確認する
  assert.equal(ctx.state.instantMode, true);

  ctx.run();
  await waitFor(function () { return af.pending.length === 1; }, "AD3: fetch 待ち");
  var entry = af.pending.shift();
  var body = JSON.parse(entry.init.body);
  var keys = ctx.selectionKeys();
  entry.resolve(makeAllResponse(ctx, body.puzzle, keys));

  // 描画省略が誤って発動していれば、この時点で2マスとも即確定して state.done になってしまう。
  // 一括+じっくりでは従来どおり1マスずつフォーカスするはずなので、まだ完了していない。
  await waitFor(function () { return ctx.state.focusedKey !== null; }, "AD3: 1マス目のフォーカス待ち");
  assert.equal(ctx.state.done, false, "一括+じっくりなのに即座に完了した(描画省略が誤って発動した)");
  assert.equal(Object.keys(ctx.state.values).length, 0, "1マス目の確定待ちのはずが、もう値が入っている");

  await waitFor(function () { return ctx.state.done === true; }, "AD3: 完了待ち");
  assert.equal(Object.keys(ctx.state.values).length, 2);
});

test("AD4: 「現在の判定」パネルの見出し行に経過時間(ミリ秒)が出る。重複していたコスト表示は消えた(Issue #80)", async () => {
  var ctx = runScript(await getPageHtml());

  // 未実行: 0ms
  var idleHtml = ctx.renderCurrentPanel();
  assert.ok(idleHtml.indexOf('class="panel-title-row"') !== -1, "見出し行のラッパーが無い: " + idleHtml);
  assert.ok(idleHtml.indexOf('class="panel-title-elapsed"') !== -1, "経過時間の span が無い: " + idleHtml);
  assert.ok(idleHtml.indexOf(ctx.formatMs(0)) !== -1, "未実行時に 0 ms が出ていない: " + idleHtml);

  // 実行中: currentTotalElapsedMs() をライブに反映する
  ctx.totalElapsedMs = 0;
  ctx.runningSince = 1000;
  ctx.nowMs = function () { return 4234; };
  var runningHtml = ctx.renderCurrentPanel();
  assert.ok(runningHtml.indexOf(ctx.formatMs(3234)) !== -1, "実行中の経過時間(ミリ秒)が出ていない: " + runningHtml);
  assert.ok(runningHtml.indexOf("$") === -1, "現在の判定パネルにコスト表示が残っている(この実行の消費パネルと重複、Issue #80)");

  // 停止後は最後の値のまま(currentTotalElapsedMs() が totalElapsedMs をそのまま返す。DESIGN 4.4)
  ctx.runningSince = null;
  ctx.totalElapsedMs = 3234;
  var stoppedHtml = ctx.renderCurrentPanel();
  assert.ok(stoppedHtml.indexOf(ctx.formatMs(3234)) !== -1, "停止後に最後の経過時間が残っていない: " + stoppedHtml);
});

test("AD5: 比較モードで「Claude が動いているか分からない」問題への対応。postStatus() に lastRequest 系が乗り、比較シェルが各カラムに同じ内容を出す(Issue #80)", async () => {
  // (a) postStatus() の payload に orderMode/lastAllRequest が乗る
  var posted = [];
  var fakeWindow = {
    parent: { postMessage: function (payload, origin) { posted.push({ payload: payload, origin: origin }); } },
    addEventListener: function () {},
  };
  var ctx = runScript(await getPageHtml(), {
    location: { pathname: "/", search: "embed=1&order=all", origin: "https://example.com" },
    window: fakeWindow,
  });
  ctx.state.lastAllRequest = { request: { hello: "world" }, failed: false, count: 51, chunkCount: 1 };
  ctx.render();
  var last = posted[posted.length - 1];
  assert.equal(last.payload.orderMode, "all", "orderMode が status に乗っていない");
  assert.ok(last.payload.lastAllRequest && last.payload.lastAllRequest.count === 51, "lastAllRequest が status に乗っていない");

  // (b) 比較シェル: status 未着時は「まだ判定していません」(プロンプト欄のラッパーは出る)
  var compareCtx = runScript(await getPageHtml(), {
    location: { pathname: "/compare", search: "", origin: "https://example.com" },
  });
  var emptyHtml = compareCtx.renderCompareStatusHtml("jev");
  assert.ok(emptyHtml.indexOf("まだ判定していません") !== -1, "status 未着時の空表示が出ていない: " + emptyHtml);
  assert.ok(emptyHtml.indexOf('class="compare-prompt"') !== -1, "プロンプト欄のラッパーが無い: " + emptyHtml);

  // (c) 一括モード: 子から届いた lastAllRequest がそのまま出る(質問数の要約 + 折りたたみ)
  compareCtx.compareStatus.claude = {
    type: "status", model: "claude-opus-5+think", round: 1, correct: 0, total: 51, remaining: 51,
    running: true, paused: false, done: false, elapsedMs: 100, costUsd: 0,
    orderMode: "all", lastAllRequest: { request: { hello: "claude" }, failed: false, count: 51, chunkCount: 6 },
  };
  var claudeHtml = compareCtx.renderCompareStatusHtml("claude");
  assert.ok(claudeHtml.indexOf("質問 51 問") !== -1, "一括モードの質問数要約が出ていない: " + claudeHtml);
  assert.ok(claudeHtml.indexOf("6回に分割") !== -1, "チャンク分割の注記が出ていない: " + claudeHtml);
  assert.ok(claudeHtml.indexOf("prompt-details") !== -1, "折りたたみが出ていない: " + claudeHtml);

  // (d) 左上からモード: 数字のリクエストがそのまま出る
  compareCtx.compareStatus.jev = {
    type: "status", model: "typesafe/jev", round: 1, correct: 0, total: 51, remaining: 51,
    running: true, paused: false, done: false, elapsedMs: 50, costUsd: 0,
    orderMode: "scan", lastRequest: { state: { puzzle: "x", target: { row: 0, col: 2 } } }, lastRequestFailed: false,
  };
  var jevHtml = compareCtx.renderCompareStatusHtml("jev");
  assert.ok(jevHtml.indexOf("の判定に使用") !== -1, "scan モードのリクエスト要約が出ていない: " + jevHtml);
  // (e) 左上から/確信度順モードの生の <pre> は比較シェルだけ折りたたむ(縦幅がそろわず
  // iframe がずれる問題への対応、Opus レビュー S1)。一括モード(c)は自前の折りたたみを
  // 持つので二重に包まれないこと、未送信(b)は折りたたまないことも確認する。
  assert.ok(jevHtml.indexOf('<details class="prompt-details">') !== -1, "scan モードの比較シェル表示が折りたたまれていない(レビュー S1): " + jevHtml);
  assert.equal((claudeHtml.match(/<details class="prompt-details">/g) || []).length, 1, "一括モードが二重に折りたたまれている(レビュー S1): " + claudeHtml);
  assert.ok(emptyHtml.indexOf("<details") === -1, "未送信の空表示まで折りたたまれている: " + emptyHtml);
});

test("AD6: 実行前に select を渡り歩くだけでも instant-toggle の有効/無効が反映される(select は選んだあともフォーカスを保つブラウザの挙動でも render() が止まらないこと、Opus レビューM1)", async () => {
  var app = { innerHTML: "" };
  var fakeDoc = {
    activeElement: null,
    getElementById: function (id) { return id === "app" ? app : null; },
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    createElement: function (tag) { return { tagName: tag, href: "", download: "", click: function () {} }; },
    body: { appendChild: function () {}, removeChild: function () {} },
  };
  var ctx = runScript(await getPageHtml(), { document: fakeDoc });

  // 実行前(state.running===false)は順番トグルもロックされないので選べる
  ctx.setOrderMode("all");
  assert.ok(/<select id="instant-toggle"[^>]*disabled/.test(app.innerHTML), "前提: 一括だけ(速度はまだ slow)では instant-toggle は無効のはず: " + app.innerHTML);

  // 速度セレクトにフォーカスがある状態で「最速」を選ぶ(select は選択後もフォーカスを
  // 保つブラウザの挙動を模している。isControlSelectFocused() が真になる)
  fakeDoc.activeElement = { tagName: "SELECT", id: "speed-toggle" };
  ctx.setSpeed("fast");
  assert.ok(!/<select id="instant-toggle"[^>]*disabled/.test(app.innerHTML),
    "実行中でもないのに select にフォーカスがあるという理由だけで render() が止まり、instant-toggle が無効のままになっている(M1)");
});

test("AD7: 「現在の判定」の経過時間は render() を待たずに setInterval でリアルタイム更新され、停止/完了で止まる(オーナー追加要望)", { timeout: 10000 }, async () => {
  var af = makeAbortAwareFetch();
  var app = { innerHTML: "" };
  var elapsedEl = { textContent: "" };
  var fakeDoc = {
    activeElement: null,
    getElementById: function (id) {
      if (id === "app") return app;
      if (id === "current-elapsed") return elapsedEl;
      return null;
    },
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    createElement: function (tag) { return { tagName: tag, href: "", download: "", click: function () {} }; },
    body: { appendChild: function () {}, removeChild: function () {} },
  };
  var ctx = runScript(await getPageHtml(), { fetch: af.fetch, document: fakeDoc });
  assert.ok(ctx.applyPuzzleFromString(blankCells(ANSWER_KEY, [[0, 0]])), "テスト用の1マスだけの盤面の適用に失敗した");

  var fakeNow = 1000;
  ctx.nowMs = function () { return fakeNow; };
  ctx.run();
  await waitFor(function () { return af.pending.length === 1; }, "AD7: fetch 待ち");

  // run() が startElapsedTicker() で setInterval を1つ登録しているはず(100ms間隔)
  var ids = Object.keys(ctx.intervalRegistry);
  assert.equal(ids.length, 1, "run() が setInterval を1つ登録していない");
  var entry = ctx.intervalRegistry[ids[0]];
  assert.equal(entry.delay, 100, "ティック間隔(ELAPSED_TICK_MS)が想定と違う: " + entry.delay);

  // fetch が in-flight のまま(render() は挟まらない)時間を進めて、手動でティックを1回発火する
  fakeNow = 4234;
  entry.fn();
  assert.equal(elapsedEl.textContent, ctx.formatMs(3234),
    "render() を挟まない手動ティックで #current-elapsed の textContent が更新されていない: " + elapsedEl.textContent);

  // そのまま応答を返して完了させると、setInterval がクリアされ、以後は動かなくなる
  var entryReq = af.pending.shift();
  var body = JSON.parse(entryReq.init.body);
  entryReq.resolve(makeCorrectResponse(ctx, body.target.row, body.target.col, body.puzzle));
  await waitFor(function () { return ctx.state.done === true; }, "AD7: 完了待ち");
  assert.equal(Object.keys(ctx.intervalRegistry).length, 0, "完了後も setInterval が残っている(止まって見えるはずが動き続ける)");
});

test("AD8: Claude 設定はモデル選択と API キー入力を分け、キー入力は既定で折りたたむ。末尾ヒント表示は削除した(オーナー要望 2026-09-23)", async () => {
  var ctx = runScript(await getPageHtml(), {});
  ctx.setModelMode("claude");
  ctx.saveAnthropicKey(TEST_KEY);

  var html = ctx.appElement.innerHTML;
  var detailsStart = html.indexOf('<details class="claude-key-details">');
  assert.ok(detailsStart !== -1, "API キーの折りたたみ(<details>)が無い: " + html);

  // モデル選択・思考トグルは折りたたみの外(常に見える位置)にある
  var modelSelectIdx = html.indexOf('id="claude-model"');
  assert.ok(modelSelectIdx !== -1 && modelSelectIdx < detailsStart, "モデル選択が折りたたみの外にない(常に見えるはず)");
  var thinkingIdx = html.indexOf('id="thinking-toggle"');
  assert.ok(thinkingIdx !== -1 && thinkingIdx < detailsStart, "思考トグルが折りたたみの外にない(常に見えるはず)");

  // API キーの入力欄・保存/削除ボタンは折りたたみの中
  var keyInputIdx = html.indexOf('id="anthropic-key-input"');
  assert.ok(keyInputIdx > detailsStart, "API キー入力欄が折りたたみの中にない");

  // <details> に open は付かない(既定で閉じている)
  assert.ok(!/<details class="claude-key-details"\s+open/.test(html), "API キー設定が既定で開いている");

  // 末尾4文字のヒント表示は削除済み。折りたたみの見出しには状態(設定済み/未設定)だけ残す
  assert.ok(!html.includes("保存済み(末尾"), "削除したはずの「保存済み(末尾…)」表示がまだ出ている");
  assert.ok(!html.includes("…" + TEST_KEY.slice(-4)), "削除したはずのキー末尾ヒントがまだ出ている");
  assert.ok(html.includes("API キー(設定済み)"), "折りたたみの見出しに設定済みの状態が出ていない: " + html);

  ctx.clearAnthropicKey();
  assert.ok(ctx.appElement.innerHTML.includes("API キー(未設定)"), "キーを消したのに見出しが未設定にならない");
});

test("AD9: API キー設定の折りたたみは render() をまたいで開閉状態を引き継ぐ(保存/削除のボタンが render() を呼んでも閉じない、オーナー要望 2026-09-23)", async () => {
  var htmlValue = "";
  var keyDetailsEl = { open: false };
  var app = {
    get innerHTML() { return htmlValue; },
    set innerHTML(v) {
      htmlValue = v;
      // 実ブラウザでは innerHTML の丸ごと差し替えでノードが作り直され、open は既定の
      // false に戻る(render() 側が明示的に true を書き戻さない限り閉じたままになる)。
      keyDetailsEl.open = false;
    },
  };
  var fakeDoc = {
    activeElement: null,
    getElementById: function (id) { return id === "app" ? app : null; },
    querySelector: function (sel) {
      if (sel === "details.claude-key-details") return keyDetailsEl;
      return null;
    },
    querySelectorAll: function () { return []; },
    createElement: function (tag) { return { tagName: tag, href: "", download: "", click: function () {} }; },
    body: { appendChild: function () {}, removeChild: function () {} },
  };
  var ctx = runScript(await getPageHtml(), { document: fakeDoc });
  ctx.setModelMode("claude");
  ctx.saveAnthropicKey(TEST_KEY);

  // ユーザーが開いた状態を模してから、実際の保存ボタンの経路(saveAnthropicKeyFromInput()。
  // 中で render() を呼ぶ)で空の入力を保存させ、失敗の注意書き(claudeKeyNotice)が
  // ちゃんと出る・かつ折りたたみが閉じないことを確認する(レビュー N4: このテストが
  // 防ぎたい回帰そのもの — 開いたまま保存に失敗すると、以前は render() で閉じてしまい
  // 注意書きが見えなくなっていた)
  keyDetailsEl.open = true;
  var fakeInput = { value: "   " };
  fakeDoc.getElementById = function (id) {
    if (id === "app") return app;
    if (id === "anthropic-key-input") return fakeInput;
    return null;
  };
  ctx.saveAnthropicKeyFromInput();
  assert.equal(keyDetailsEl.open, true, "開いていた API キー設定が render() で閉じてしまった(保存失敗の注意書きが見えなくなる)");
  assert.ok(htmlValue.includes("キーが空です"), "開いたままのはずなのに保存失敗の注意書きが出ていない: " + htmlValue);

  keyDetailsEl.open = false;
  ctx.render();
  assert.equal(keyDetailsEl.open, false, "閉じていたのに render() で勝手に開いた");
});

test("AD10: 経過時間の setInterval は停止・一時的な失敗・エラー停止・強制終了・リセットのどの経路でも確実に止まる(Opus レビュー S1)", { timeout: 20000 }, async () => {
  function activeIntervalCount(ctx) {
    return Object.keys(ctx.intervalRegistry).length;
  }

  // (a) 手動 stop()(haltRun 経由)
  {
    var af = makeAbortAwareFetch();
    var ctx = runScript(await getPageHtml(), { fetch: af.fetch });
    ctx.run();
    await waitFor(function () { return af.pending.length === 1; }, "AD10a: fetch 待ち");
    assert.equal(activeIntervalCount(ctx), 1, "run() 直後に setInterval が1つ登録されていない");
    ctx.stop();
    assert.equal(activeIntervalCount(ctx), 0, "手動 stop() 後も setInterval が残っている(haltRun 経由)");
  }

  // (b) 一時的な失敗(429)による停止(pauseForTransientError → haltRun 経由)
  {
    var af = makeAbortAwareFetch();
    var ctx = runScript(await getPageHtml(), { fetch: af.fetch });
    ctx.run();
    await waitFor(function () { return af.pending.length === 1; }, "AD10b: fetch 待ち");
    assert.equal(activeIntervalCount(ctx), 1);
    af.pending.shift().resolve({
      ok: false,
      status: 429,
      json: function () { return Promise.resolve({ error: "レート制限" }); },
    });
    await waitFor(function () { return ctx.isPaused(); }, "AD10b: 一時的な失敗の停止待ち");
    assert.equal(activeIntervalCount(ctx), 0, "一時的な失敗の停止後も setInterval が残っている(haltRun 経由)");
  }

  // (c) エラー停止(400、showError 経由)
  {
    var af = makeAbortAwareFetch();
    var ctx = runScript(await getPageHtml(), { fetch: af.fetch });
    ctx.run();
    await waitFor(function () { return af.pending.length === 1; }, "AD10c: fetch 待ち");
    assert.equal(activeIntervalCount(ctx), 1);
    af.pending.shift().resolve({
      ok: false,
      status: 400,
      json: function () { return Promise.resolve({ error: "入力が不正です" }); },
    });
    await waitFor(function () { return ctx.state.errorMessage !== null; }, "AD10c: エラー停止待ち");
    assert.equal(activeIntervalCount(ctx), 0, "エラー停止後も setInterval が残っている(showError 経由)");
  }

  // (d) 強制終了(finalizeRound の limit 分岐)。MAX_ROUNDS を縮めてすぐ再現する
  {
    var af = makeAbortAwareFetch();
    var ctx = runScript(await getPageHtml(), { fetch: af.fetch });
    assert.ok(ctx.applyPuzzleFromString(blankCells(ANSWER_KEY, [[0, 0]])), "AD10d: 1マス盤面の適用に失敗した");
    ctx.MAX_ROUNDS = 2; // 2周とも不正解にして、2周で強制終了させる
    ctx.run();
    for (var i = 0; i < 1000 && !ctx.state.done; i++) {
      while (af.pending.length) {
        var item = af.pending.shift();
        if (item.settled) continue;
        var body = JSON.parse(item.init.body);
        var correctDigit = ctx.SOLUTION[body.target.row][body.target.col];
        var wrongDigit = correctDigit === "1" ? "2" : "1";
        var probabilities = {};
        ["1", "2", "3", "4", "5", "6", "7", "8", "9"].forEach(function (d) { probabilities[d] = d === wrongDigit ? 0.9 : 0.0125; });
        item.resolve({ ok: true, json: async function () { return { probabilities: probabilities, choice: wrongDigit, confidence: 0.5, request: {} }; } });
      }
      await tick();
    }
    assert.equal(ctx.state.stoppedAtLimit, true, "AD10d: 前提(強制終了)が崩れている");
    assert.equal(activeIntervalCount(ctx), 0, "強制終了後も setInterval が残っている(finalizeRound の limit 分岐)");
  }

  // (e) 実行中の reset()(SPEC F5: 実行中でも押せる)
  {
    var af = makeAbortAwareFetch();
    var ctx = runScript(await getPageHtml(), { fetch: af.fetch });
    ctx.run();
    await waitFor(function () { return af.pending.length === 1; }, "AD10e: fetch 待ち");
    assert.equal(activeIntervalCount(ctx), 1);
    ctx.reset();
    assert.equal(activeIntervalCount(ctx), 0, "実行中の reset() 後も setInterval が残っている");
  }
});

test("AD11: 埋め込みモードでは経過時間のティックが10回に1回 postStatus() も送る(Opus レビュー S3: 比較シェルの経過時間表示が一括モードの応答待ち中に止まって見える問題への対応)", { timeout: 10000 }, async () => {
  var af = makeAbortAwareFetch();
  var posted = [];
  var fakeWindow = {
    parent: { postMessage: function (payload, origin) { posted.push({ payload: payload, origin: origin }); } },
    addEventListener: function () {},
  };
  var ctx = runScript(await getPageHtml(), {
    fetch: af.fetch,
    location: { pathname: "/", search: "embed=1", origin: "https://example.com" },
    window: fakeWindow,
  });
  ctx.run();
  await waitFor(function () { return af.pending.length === 1; }, "AD11: fetch 待ち");

  var ids = Object.keys(ctx.intervalRegistry);
  assert.equal(ids.length, 1, "run() が setInterval を1つ登録していない");
  var tickFn = ctx.intervalRegistry[ids[0]].fn;

  var postsBeforeTicks = posted.length; // render() 自体も postStatus() を送るので、ここを基準にする
  for (var i = 1; i <= 9; i++) tickFn();
  assert.equal(posted.length, postsBeforeTicks, "10回未満のティックで postStatus() が送られてしまった: " + posted.length);
  tickFn(); // 10回目
  assert.ok(posted.length > postsBeforeTicks, "10回目のティックで postStatus() が送られていない(比較シェルの数字が止まって見える)");
  var last = posted[posted.length - 1];
  assert.equal(typeof last.payload.elapsedMs, "number", "ティック経由の postStatus() の payload に elapsedMs が無い");
});
