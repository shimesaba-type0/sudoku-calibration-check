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
 *   エクスポート(`<a download>`)用の createElement / body.appendChild / removeChild
 * - setTimeout: 待ち時間を無視して即座に実行する(テストを速く・決定的にする)
 * - fetch: 呼び出しを記録するスタブ(既定では呼ばれたら失敗させる)
 * - localStorage: 既定では makeLocalStorage()(Map ベース)。opts.localStorage で
 *   差し替えられる(未指定 = undefined を渡すテストは「localStorage が無い環境」)
 * - confirm / Blob / URL: 「記録を消す」「JSONエクスポート」用の最小スタブ
 */
function runScript(html, options) {
  var opts = options || {};
  var app = { innerHTML: "" };
  var bodyChildren = [];
  var createdBlobs = [];
  var context = {
    console: console,
    document: {
      getElementById: function (id) {
        return id === "app" ? app : null;
      },
      querySelector: function () {
        return null;
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
    },
    setTimeout: function (fn) {
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
  context.appElement = app;
  context.bodyChildren = bodyChildren;
  context.createdBlobs = createdBlobs;
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

test("focusNext は判定を投げる前に state.focusedKey を立てる(対象マスを空にして送る)", async () => {
  var html = await getPageHtml();
  var script = extractScript(html);
  var src = stripLineComments(extractFunctionSource(script, "focusNext"));

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

test("focusNext と finalizeRound の非同期コールバックはすべて世代トークンで守られている", async () => {
  var html = await getPageHtml();
  var script = extractScript(html);

  var focusSrc = extractFunctionSource(script, "focusNext");
  assert.ok(/var token = runToken;/.test(focusSrc), "focusNext が世代を捕まえていない");
  // then(成功)・then(失敗)・commit前 setTimeout・commit後 setTimeout の4か所
  var guards = focusSrc.match(/if \(!isCurrent\(token\)\) return;/g) || [];
  assert.ok(guards.length >= 4, "focusNext の世代ガードが足りない: " + guards.length);
  assert.ok(!/if \(!state\.running\) return;\s*\n\s*var probs/.test(focusSrc), "state.running だけのチェックが残っている");
  // setTimeout のコールバックは必ず先頭でガードする
  var timeoutBodies = focusSrc.match(/setTimeout\(function \(\) \{\s*([^\n]*)/g) || [];
  assert.ok(timeoutBodies.length >= 2, "setTimeout が2か所ない");
  timeoutBodies.forEach(function (body) {
    assert.ok(body.includes("if (!isCurrent(token)) return;"), "setTimeout の先頭に世代ガードが無い: " + body);
  });

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

test("リセットは実行中でも押せる(SPEC F5)。生成中だけ無効化される", async () => {
  var ctx = runScript(await getPageHtml());

  function resetButtonHtml() {
    var html = ctx.renderControls();
    var m = html.match(/<button id="reset-btn"[^>]*>/);
    assert.ok(m, "reset-btn が見つからない");
    return m[0];
  }
  function runButtonHtml() {
    var html = ctx.renderControls();
    var m = html.match(/<button id="run-btn"[^>]*>/);
    assert.ok(m, "run-btn が見つからない");
    return m[0];
  }
  function newPuzzleButtonHtml() {
    var html = ctx.renderControls();
    var m = html.match(/<button id="new-puzzle-btn"[^>]*>/);
    assert.ok(m, "new-puzzle-btn が見つからない");
    return m[0];
  }

  // 初期状態: どれも無効化されていない
  assert.ok(!resetButtonHtml().includes("disabled"), "初期状態で reset-btn が無効化されている");

  // 実行中: リセットは押せる。実行/新しい問題は押せない
  ctx.state.running = true;
  assert.ok(!resetButtonHtml().includes("disabled"), "実行中に reset-btn が無効化されている(SPEC F5違反)");
  assert.ok(runButtonHtml().includes("disabled"), "実行中に run-btn が無効化されていない");
  assert.ok(newPuzzleButtonHtml().includes("disabled"), "実行中に new-puzzle-btn が無効化されていない");
  ctx.state.running = false;

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

/** 正解をそのまま返す /api/judge のレスポンス(常に正解 ⇒ 1周で完了する)。 */
function makeCorrectResponse(ctx, row, col) {
  var digit = ctx.SOLUTION[row][col];
  var probabilities = {};
  for (var d = 1; d <= 9; d++) probabilities[String(d)] = String(d) === digit ? 0.9 : 0.0125;
  return {
    ok: true,
    json: async function () {
      return { probabilities: probabilities, choice: digit, confidence: 0.5 };
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
      item.resolve(makeCorrectResponse(ctx, body.target.row, body.target.col));
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
