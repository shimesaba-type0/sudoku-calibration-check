// フロントエンド(PAGE_HTML)のテスト(docs/DESIGN.md 4章・10章、Issue #3)。
// 実際のブラウザ DOM は使わず、GET / のレスポンステキストを検査する。
import { test } from "node:test";
import assert from "node:assert/strict";

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
