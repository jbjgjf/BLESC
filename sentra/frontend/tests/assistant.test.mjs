import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DESTINATIONS,
  INTENT_WORDS,
  normalize,
  routeIntent,
  SUGGESTIONS,
} from "../src/lib/assistant/intents.ts";
import {
  applyBlink,
  bodyPath,
  eyePaths,
  EXPRESSIONS,
  PEBBLE_VIEWBOX,
  PHASE_SWAY,
} from "../src/lib/assistant/pebble.ts";
import { assessSafety } from "../src/lib/safety-assessment.ts";

const settings = { text: "m", line: "normal", contrast: "normal", motion: "system", face: "default" };

/** 実際の使われ方どおり、安全判定を通してから文脈を組む。 */
const context = (text, overrides = {}) => ({
  pathname: "/",
  settings,
  pilot: { elapsed: 7, remaining: 24, phase: "during" },
  safety: assessSafety(text),
  turn: 0,
  ...overrides,
});

const ask = (text, overrides = {}) => routeIntent(text, context(text, overrides));

const navigated = (reply) => reply.actions.find((action) => action.kind === "navigate")?.href ?? null;
const patched = (reply) => reply.actions.find((action) => action.kind === "display")?.patch ?? null;

describe("normalize", () => {
  it("カタカナとひらがなを同じものとして扱う", () => {
    assert.equal(normalize("ニッキ"), normalize("にっき"));
  });

  it("全角と半角、記号と空白をならす", () => {
    assert.equal(normalize("ＡＩの記録！"), "aiの記録");
    assert.equal(normalize("あと 何日？"), "あと何日");
  });
});

describe("routeIntent — 移動", () => {
  const cases = [
    ["日記を書きたい", "/journal"],
    ["にっき", "/journal"],
    ["今日のことを記録したい", "/journal"],
    ["振り返りを見せて", "/reflect"],
    ["グラフ", "/reflect"],
    ["相談したい", "/chat"],
    ["話したいことがある", "/chat"],
    ["誰が見られるの？", "/sharing"],
    ["先生に見られますか", "/sharing"],
    ["タイムライン", "/timeline"],
  ];

  for (const [text, href] of cases) {
    it(`「${text}」→ ${href}`, () => {
      assert.equal(navigated(ask(text)), href);
    });
  }

  it("行き先はすべて定数表から出る（入力から組み立てない）", () => {
    const allowed = new Set(Object.values(DESTINATIONS).map((destination) => destination.href));
    for (const [text] of cases) {
      const reply = ask(text);
      for (const action of [...reply.actions, ...reply.offers.map((offer) => offer.action)]) {
        if (action.kind === "navigate") assert.ok(allowed.has(action.href), `${text}: ${action.href}`);
      }
    }
  });

  it("すでにそのページにいるときは動かさず、そう伝える", () => {
    const reply = ask("日記", { pathname: "/journal" });
    assert.equal(navigated(reply), null);
    assert.match(reply.say, /日記/);
  });
});

describe("routeIntent — 表示", () => {
  it("文字を大きくする", () => {
    assert.deepEqual(patched(ask("文字を大きくして")), { text: "l" });
  });

  it("文字を小さくする", () => {
    assert.deepEqual(patched(ask("文字を小さく")), { text: "s" });
  });

  it("「字が小さい」は大きくする側に寄せる", () => {
    assert.deepEqual(patched(ask("字が小さい")), { text: "l" });
  });

  it("上限では変えずに、別の手を出す", () => {
    const reply = ask("もっと大きく", { settings: { ...settings, text: "xl" } });
    assert.equal(patched(reply), null);
    assert.ok(reply.offers.length > 0);
  });

  it("変更には必ず取り消しが付く", () => {
    const reply = ask("読みにくい");
    const undo = reply.offers.find((offer) => offer.label === "元に戻す");
    assert.ok(undo, "元に戻す が無い");
    assert.deepEqual(undo.action.patch, { text: "m" });
  });

  it("入っている設定はもう一度言うと戻る", () => {
    assert.deepEqual(patched(ask("動きを止めて", { settings: { ...settings, motion: "reduced" } })), { motion: "system" });
    assert.deepEqual(patched(ask("動きを止めて")), { motion: "reduced" });
  });

  it("リセットは既定値を書き写さず、専用の動作に任せる", () => {
    assert.equal(ask("設定をリセット").actions[0].kind, "reset-display");
  });

  it("表示設定を開く", () => {
    assert.equal(ask("表示設定").actions[0].kind, "open-settings");
  });
});

describe("routeIntent — 答えるだけ", () => {
  it("試験導入の残りを答え、動かない", () => {
    const reply = ask("あと何日？");
    assert.match(reply.say, /あと24日/);
    assert.equal(navigated(reply), null);
  });

  it("今日がまだ確定していなくても破綻しない", () => {
    const reply = ask("あと何日？", { pilot: null });
    assert.ok(reply.say.length > 0);
    assert.equal(navigated(reply), null);
  });

  it("ホーム以外ではカレンダーへの導線を出す", () => {
    const reply = ask("いつまで", { pathname: "/journal" });
    assert.equal(reply.offers[0].action.href, "/");
  });
});

describe("routeIntent — 安全", () => {
  it("つらさが混じったら、表を引かずに相談へ渡す", () => {
    const reply = ask("死にたい、日記を開いて");
    assert.equal(navigated(reply), null, "移動してはいけない");
    assert.equal(reply.calm, true);
    assert.equal(reply.expression, "steady");
    assert.equal(reply.offers[0].action.kind, "handoff");
  });

  it("返す文は監査済みのものをそのまま使う", () => {
    const text = "もう消えたい";
    assert.equal(ask(text).say, assessSafety(text).safe_response);
  });

  it("打った言葉は URL ではなく handoff が持つ", () => {
    const reply = ask("誰にも言わないで、自分を傷つけそう");
    const handoff = reply.offers.find((offer) => offer.action.kind === "handoff");
    assert.equal(handoff.action.text, "誰にも言わないで、自分を傷つけそう");
  });
});

describe("routeIntent — 拾えないとき", () => {
  it("作り話で埋めず、相談への道を出す", () => {
    const reply = ask("あしたの天気は");
    assert.equal(navigated(reply), null);
    assert.ok(reply.offers.some((offer) => offer.action.kind === "handoff"));
  });

  it("空の入力でも落ちない", () => {
    for (const text of ["", "   ", "。"]) {
      assert.ok(routeIntent(text, context(text)).say.length > 0);
    }
  });

  it("一文字では動かさない", () => {
    assert.equal(navigated(ask("日")), null);
  });
});

describe("routeIntent — 雑談", () => {
  it("あいさつに、あいさつで返す（移動はしない）", () => {
    const reply = ask("こんにちは");
    assert.match(reply.say, /^こんにちは。/);
    assert.equal(navigated(reply), null);
    assert.equal(reply.expression, "happy");
  });

  it("あいさつの種類に合わせる", () => {
    assert.match(ask("おはよう！").say, /^おはようございます。/);
    assert.match(ask("こんばんは").say, /^こんばんは。/);
    assert.match(ask("よろしく").say, /^よろしくお願いします。/);
  });

  it("あいさつと頼みごとが一緒なら、あいさつを返してから動く", () => {
    const reply = ask("こんにちは、日記を書きたい");
    assert.equal(navigated(reply), "/journal");
    assert.match(reply.say, /^こんにちは。日記のページを開きますね。/);
  });

  it("同じあいさつでも、送った回数で言い回しが変わる", () => {
    assert.notEqual(ask("こんにちは", { turn: 0 }).say, ask("こんにちは", { turn: 1 }).say);
  });

  it("気分が沈んだ言葉には明るく返さず、相談への道を出す", () => {
    for (const text of ["疲れた", "元気がない", "なんかしんどい"]) {
      const reply = ask(text);
      assert.equal(reply.calm, true, text);
      assert.equal(reply.expression, "steady", text);
      assert.equal(reply.offers.find((offer) => offer.action.kind === "handoff")?.action.text, text);
    }
  });

  it("「元気？」と「元気がない」を取り違えない", () => {
    assert.notEqual(ask("元気？").calm, true);
    assert.equal(ask("元気がない").calm, true);
  });

  it("「目が疲れた」は気分ではなく、動きを減らす頼みとして扱う", () => {
    assert.deepEqual(patched(ask("目が疲れた")), { motion: "reduced" });
  });

  it("短い相づちは、言葉全体が一致したときだけ拾う", () => {
    assert.match(ask("はい").say, /はい|わかりました/);
    assert.equal(navigated(ask("うんどう会の日記")), "/journal");
  });

  it("別れのあいさつ", () => {
    assert.equal(ask("おやすみ").say, "おやすみなさい。");
    assert.equal(ask("またね").actions.length, 0);
  });
});

describe("候補", () => {
  it("表に載っている言葉はすべて実際に一致する（死んだ見出し語を作らない）", () => {
    for (const word of INTENT_WORDS) {
      const reply = ask(word);
      assert.ok(
        reply.expression !== "oops" || reply.actions.length > 0,
        `「${word}」が表に載っているのに拾われない`,
      );
    }
  });

  it("出している候補はすべて実際に反応する", () => {
    for (const suggestion of SUGGESTIONS) {
      const reply = ask(suggestion.label);
      const acted = reply.actions.length > 0 || reply.say.includes("あと");
      assert.ok(acted, `「${suggestion.label}」が何も起こさない`);
    }
  });
});

describe("pebble", () => {
  const numbersIn = (path) =>
    [...path.matchAll(/(-?\d+\.?\d*) (-?\d+\.?\d*)/g)].map(([, x, y]) => [Number(x), Number(y)]);

  it("どの表情も viewBox からはみ出さない", () => {
    const [vx, vy, vw, vh] = PEBBLE_VIEWBOX.split(" ").map(Number);
    // ばねの行き過ぎと線幅のぶんを見込む
    const margin = 2.5;
    for (const [name, params] of Object.entries(EXPRESSIONS)) {
      for (const phase of [-PHASE_SWAY, 0, PHASE_SWAY]) {
        for (const [x, y] of numbersIn(bodyPath(params, phase))) {
          assert.ok(x > vx + margin && x < vx + vw - margin, `${name}: x=${x}`);
          assert.ok(y > vy + margin && y < vy + vh - margin, `${name}: y=${y}`);
        }
      }
    }
  });

  it("輪郭は閉じた曲線になる", () => {
    const path = bodyPath(EXPRESSIONS.rest);
    assert.match(path, /^M/);
    assert.match(path, /Z$/);
    assert.equal(path.match(/C/g).length, 20);
  });

  it("まばたきで目が閉じ、戻ると開く", () => {
    const open = EXPRESSIONS.rest;
    const shut = applyBlink(open, 1);
    assert.ok(shut.upL < 1 && shut.downL < 1);
    assert.deepEqual(applyBlink(open, 0), open);
  });

  it("笑うと下のふちが上へ反る（三日月になる）", () => {
    assert.ok(EXPRESSIONS.happy.downL < 0);
    assert.ok(EXPRESSIONS.rest.downL > 0);
  });

  it("落ち着いた表情は伏し目で、跳ねる余地を持たない", () => {
    assert.ok(EXPRESSIONS.steady.upL < EXPRESSIONS.steady.downL);
    assert.equal(EXPRESSIONS.steady.lift, 0);
  });

  it("目は左右が中心から等しく離れる", () => {
    const { left, right } = eyePaths(EXPRESSIONS.rest);
    const centre = (path) => {
      const xs = numbersIn(path).map(([x]) => x);
      return (Math.min(...xs) + Math.max(...xs)) / 2;
    };
    assert.ok(Math.abs((50 - centre(left)) - (centre(right) - 50)) < 0.01);
  });
});
