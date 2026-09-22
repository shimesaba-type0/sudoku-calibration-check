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
  var src = stripLineComments(extractFunctionSource(script, "commitFocused"));

  assert.ok(/if \(!pendingCommit\) return;/.test(src), "pendingCommit が無いときの early return が無い");
  var guard = src.indexOf('if (state.focusedKey !== key) return;');
  var mutate = src.indexOf("state.values[key] =");
  assert.ok(guard >= 0, "フォーカスとのずれを見る early return が無い");
  assert.ok(guard < mutate, "ガードは state.values を書き換える前に置く");
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
  var commitSrc = extractFunctionSource(script, "commitFocused");
  assert.ok(/state\.lastJudgment = \{/.test(commitSrc), "commitFocused が lastJudgment を更新していない");
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

// 注意: generatePuzzle(24) は「ちょうど24個」を保証しない。実装はランダム順にマスを
// 消していき、消せなくなった時点で打ち切る(消しすぎて一意解が崩れる場合は戻す)ので、
// 24(MIN_TARGET_GIVENS)は「これより減らさない」下限であって、常に到達できる目標ではない。
// 実測(1000回)では 24 に到達するのは約6割で、25〜28個で止まることもある。
// ここでは「下限を下回らない」という実際の契約だけを検証する(=== 24 は書くとflakyになる)。
test("generatePuzzle(24): 下限(MIN_TARGET_GIVENS)を下回らない", { timeout: 10000 }, async () => {
  var ctx = runScript(await getPageHtml());
  for (var i = 0; i < 20; i++) {
    var puzzle = ctx.generatePuzzle(24);
    var label = "#" + i;
    assertSolvedGrid(puzzle.solution, label);
    assert.equal(ctx.solveCount(puzzle.given, 2), 1, label + ": generatePuzzle(24) が一意解でない");
    var filled = countFilled(puzzle.given);
    assert.ok(filled >= 24, label + ": 与えられた数字が下限24を下回った: " + filled);
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

// 難易度(SPEC F1/F4)ごとの目標ヒント数: やさしい36 / ふつう30 / むずかしい25。
// 「むずかしい」は generatePuzzle 単体では 25 ちょうどに届かず 26〜28 で止まることが
// ある(PR #15 の補足。下限は MIN_TARGET_GIVENS の24)。ここでは generatePuzzle(n) を
// 直接呼ぶ場合の契約だけを見る(再試行は newPuzzle() 側の generatePuzzleWithRetry。
// 別テストで検証する)。
test("難易度ごとの generatePuzzle: 常に一意解・解が一致し、ヒント数がやさしい36/ふつう30ちょうど、むずかしいは25〜28(下限24以上)", { timeout: 10000 }, async () => {
  var ctx = runScript(await getPageHtml());
  // ctx.DIFFICULTY_GIVENS は vm の別レルムのオブジェクトなので、deepStrictEqual は
  // プロトタイプ違いで落ちる(hostRows と同じ事情)。値だけを個別に比較する。
  assert.equal(ctx.DIFFICULTY_GIVENS.easy, 36, "DIFFICULTY_GIVENS.easy が仕様(36)と違う");
  assert.equal(ctx.DIFFICULTY_GIVENS.normal, 30, "DIFFICULTY_GIVENS.normal が仕様(30)と違う");
  assert.equal(ctx.DIFFICULTY_GIVENS.hard, 25, "DIFFICULTY_GIVENS.hard が仕様(25)と違う");

  var cases = [
    { difficulty: "easy", target: ctx.DIFFICULTY_GIVENS.easy, exact: true },
    { difficulty: "normal", target: ctx.DIFFICULTY_GIVENS.normal, exact: true },
    { difficulty: "hard", target: ctx.DIFFICULTY_GIVENS.hard, exact: false },
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
      assert.ok(filled >= 24, label + ": 与えられた数字が下限24を下回った: " + filled);
      if (c.exact) {
        assert.equal(filled, c.target, label + ": ヒント数が" + c.target + "ちょうどでない: " + filled);
      } else {
        assert.ok(filled >= 25 && filled <= 28, label + ": ヒント数が25〜28の範囲外: " + filled);
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

test("難易度トグルの描画: 選択中のボタンだけにアクセントが付き、setDifficulty() で state.difficulty が変わり reset() 後も維持される", async () => {
  var ctx = runScript(await getPageHtml());

  function difficultyToggleHtml() {
    var html = ctx.renderControls();
    var m = html.match(/<div id="difficulty-toggle">[\s\S]*?<\/div>/);
    assert.ok(m, "difficulty-toggle が見つからない");
    return m[0];
  }
  function activeLabels(html) {
    var re = /<button class="difficulty-btn active"[^>]*>([^<]*)<\/button>/g;
    var labels = [];
    var m;
    while ((m = re.exec(html)) !== null) labels.push(m[1]);
    return labels;
  }
  function pressedState(html, label) {
    var re = new RegExp('aria-pressed="(true|false)"[^>]*>' + label + "</button>");
    var m = html.match(re);
    assert.ok(m, label + " ボタンの aria-pressed が見つからない");
    return m[1];
  }

  // 既定は「ふつう」(normal)
  assert.equal(ctx.state.difficulty, "normal", "既定の難易度が normal でない");
  var html0 = difficultyToggleHtml();
  assert.deepEqual(activeLabels(html0), ["ふつう"], "既定でふつうだけがアクセントになっていない");
  assert.equal(pressedState(html0, "ふつう"), "true");
  assert.equal(pressedState(html0, "やさしい"), "false");
  assert.equal(pressedState(html0, "むずかしい"), "false");

  // setDifficulty('hard') で切り替わる
  ctx.setDifficulty("hard");
  assert.equal(ctx.state.difficulty, "hard");
  var html1 = difficultyToggleHtml();
  assert.deepEqual(activeLabels(html1), ["むずかしい"], "hard 選択後にむずかしいだけがアクセントになっていない");
  assert.equal(pressedState(html1, "むずかしい"), "true");
  assert.equal(pressedState(html1, "ふつう"), "false");

  // reset() しても難易度は維持される(speedMode と同じ扱い。DESIGN 4.1)
  ctx.reset();
  assert.equal(ctx.state.difficulty, "hard", "reset() 後に難易度が維持されていない");
});

test("newPuzzle() は state.difficulty に応じたヒント数で生成する(hard: 25〜28 / easy: 36)", { timeout: 10000 }, async () => {
  var ctx = runScript(await getPageHtml());

  ctx.setDifficulty("hard");
  ctx.newPuzzle();
  await waitFor(function () {
    return ctx.generating === false;
  }, "hard 生成の完了");
  var hardFilled = countFilled(ctx.GIVEN);
  assert.ok(hardFilled >= 25 && hardFilled <= 28, "hard で生成したヒント数が25〜28の範囲外: " + hardFilled);
  assert.equal(ctx.solveCount(ctx.GIVEN, 2), 1, "hard で生成した問題が一意解でない");

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

  // request の無いエラー(429 相当)は直前の値をそのまま残す
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
    status: 429,
    json: function () {
      return Promise.resolve({ error: "レート制限" });
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
function makeClaudeResponse(ctx, row, col, overrides) {
  var digit = ctx.SOLUTION[row][col];
  var probabilities = {};
  for (var d = 1; d <= 9; d++) probabilities[String(d)] = String(d) === digit ? 0.6 : 0.05;
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

  entry.resolve(makeClaudeResponse(ctx, target.row, target.col));
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

  // キーは DOM・エクスポートのどこにも出ない(末尾 4 文字のヒントだけ)
  ctx.render();
  var html = ctx.appElement.innerHTML;
  assert.ok(!html.includes(TEST_KEY), "innerHTML にキーが出ている");
  assert.ok(html.includes("…" + TEST_KEY.slice(-4)), "キーの末尾ヒントが出ていない");
  assert.ok(html.includes('id="claude-settings"'), "Claude の設定パネルが出ていない");
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

test("V4: Claude API のエラー(401 / refusal / JSON 不正)はエラーボックスに出て止まり、失敗したリクエストがパネルに残る", { timeout: 10000 }, async () => {
  async function runOnce(respond) {
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
    await waitFor(function () {
      return ctx.state.errorMessage !== null;
    }, "V4: エラー表示待ち");
    assert.equal(ctx.state.running, false);
    assert.equal(af.pending.length, 0, "エラー後に次の fetch が飛んだ");
    assert.deepStrictEqual(JSON.parse(JSON.stringify(ctx.state.lastRequest)), body, "失敗したリクエストが lastRequest に無い");
    assert.equal(ctx.state.lastRequestFailed, true);
    ctx.render();
    assert.ok(ctx.appElement.innerHTML.includes("(このプロンプトで失敗)"));
    assert.ok(!ctx.appElement.innerHTML.includes(TEST_KEY));
    return ctx.state.errorMessage;
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

  var msgNet = await runOnce(function (entry) {
    entry.reject(new TypeError("Failed to fetch"));
  });
  assert.ok(msgNet.includes("接続できません"), "ネットワークエラーの文言: " + msgNet);
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
  assert.ok(/id="model-toggle">\s*<button[^>]*disabled/.test(ctx.appElement.innerHTML), "実行中にモデルトグルが無効化されていない");

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
    var res = makeClaudeResponse(ctx, target.row, target.col);
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

  // 周回ログの形式は従来どおり
  assert.equal(ctx.state.roundLog.length, 2, "周回ログが2行でない");
  assert.match(ctx.state.roundLog[0], /^1周目: 51中50正解 \(98%\)$/, "1周目のログ形式が違う: " + ctx.state.roundLog[0]);
  assert.match(ctx.state.roundLog[1], /^2周目: 1中1正解 \(100%\)$/, "2周目のログ形式が違う: " + ctx.state.roundLog[1]);
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

  // 実行中は順番トグルが無効
  var orderToggleMatch = html.match(/<div id="order-toggle">([\s\S]*?)<\/div>/);
  assert.ok(orderToggleMatch, "order-toggle が描画されていない");
  assert.ok(orderToggleMatch[1].indexOf("disabled") !== -1, "実行中に順番トグルが無効化されていない");
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
  var panel = html.slice(html.indexOf('id="prompt-panel"'), html.indexOf('id="round-log"'));
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
  assert.ok(/id="order-toggle">\s*<button[^>]*disabled/.test(ctx.appElement.innerHTML), "停止中に順番トグルが無効化されていない");
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
    messageHandlers[0]({ origin: "https://evil.example", data: { type: "run" } });
    assert.equal(ctx.state.running, false, "他オリジンの run が実行されてしまった");

    // 同一オリジンの run は効く
    messageHandlers[0]({ origin: "https://example.com", data: { type: "run" } });
    assert.equal(ctx.state.running, true, "同一オリジンの run が効かない");

    // render() のたびに status が親へ postMessage される(第2引数が origin)
    assert.ok(parentCalls.length > 0, "status が postMessage されていない");
    var lastRunning = parentCalls[parentCalls.length - 1];
    assert.equal(lastRunning.data.type, "status");
    assert.equal(lastRunning.origin, "https://example.com");
    assert.equal(lastRunning.data.running, true);

    // stop で running が false になる(in-flight の判定を打ち切る。既存の stop() の挙動)
    messageHandlers[0]({ origin: "https://example.com", data: { type: "stop" } });
    assert.equal(ctx.state.running, false, "同一オリジンの stop が効かない");

    // reset で最初から
    messageHandlers[0]({ origin: "https://example.com", data: { type: "reset" } });
    assert.equal(Object.keys(ctx.state.values).length, 0, "reset で values が空にならない");
    assert.equal(ctx.state.round, 1);

    // newPuzzle(検証は puzzle= と同じ: 一意解のときだけ差し替わる)
    var custom = ANSWER_KEY.slice();
    custom[0] = "." + custom[0].slice(1);
    messageHandlers[0]({ origin: "https://example.com", data: { type: "newPuzzle", puzzle: custom.join("") } });
    assert.deepEqual(hostRows(ctx.GIVEN), custom, "message の newPuzzle が効いていない");

    // 完了まで走らせて、done の status も飛ぶことを確認する
    messageHandlers[0]({ origin: "https://example.com", data: { type: "run" } });
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

  // 「実行」を押すと両 iframe に run が送られる
  ctx.compareRun();
  assert.equal(ctx.compareFrames.jev.postMessageCalls.length, 1);
  assert.equal(ctx.compareFrames.jev.postMessageCalls[0].msg.type, "run");
  assert.equal(ctx.compareFrames.jev.postMessageCalls[0].origin, "https://example.com");
  assert.equal(ctx.compareFrames.claude.postMessageCalls.length, 1);
  assert.equal(ctx.compareFrames.claude.postMessageCalls[0].msg.type, "run");

  // 子(iframe)からの status メッセージで見出しが更新される
  assert.equal(messageHandlers.length, 1, "status 用の message リスナーが1つ登録されていない");
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
