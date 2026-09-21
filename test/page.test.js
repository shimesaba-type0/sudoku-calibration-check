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

  // 既存の routing.test.js との後方互換(SPEC F1 のUIになっても壊さない)
  assert.ok(html.includes("数独キャリブレーションチェック"));
  assert.ok(html.includes("実装中"));
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
