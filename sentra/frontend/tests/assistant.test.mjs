import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ASSISTANT_COPY,
  DESTINATIONS,
  EDUCATOR_DESTINATIONS,
  GLOSSARY,
  INTENT_WORDS,
  normalize,
  PAGE_GUIDES,
  routeIntent,
} from "../src/lib/assistant/intents.ts";
import {
  applyBlink,
  bodyPath,
  eyePaths,
  EXPRESSIONS,
  PEBBLE_VIEWBOX,
  PHASE_SWAY,
  shapeRoom,
  contactShadow,
  sproutPath,
  BODY_CENTER,
  SPROUT,
} from "../src/lib/assistant/pebble.ts";
import { PETAL_PATH } from "../src/lib/blesc/petal.ts";
import { bubbleShift, dwellMs, easeInOut, glideAt, glideMs, speechFor, spinFor, standingSpot } from "../src/lib/assistant/tour.ts";
import { assessSafety } from "../src/lib/safety-assessment.ts";

const settings = { text: "m", line: "normal", contrast: "normal", motion: "system", face: "default" };

/** 実際の使われ方どおり、安全判定を通してから文脈を組む。 */
const context = (text, overrides = {}) => ({
  audience: "student",
  pathname: "/",
  settings,
  pilot: { elapsed: 7, remaining: 24, phase: "during" },
  safety: assessSafety(text),
  turn: 0,
  ...overrides,
});

const ask = (text, overrides = {}) => routeIntent(text, context(text, overrides));
const teacher = (text, overrides = {}) => ask(text, { audience: "educator", pathname: "/educator", ...overrides });

const navigated = (reply) => reply.actions.find((action) => action.kind === "navigate")?.href ?? null;
const patched = (reply) => reply.actions.find((action) => action.kind === "display")?.patch ?? null;
const entry = (id) => GLOSSARY.find((item) => item.id === id);

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
    const allowed = new Set([
      ...Object.values(DESTINATIONS).map((destination) => destination.href),
      ...Object.values(EDUCATOR_DESTINATIONS).map((destination) => destination.href),
      ...GLOSSARY.map((item) => item.href).filter(Boolean),
    ]);
    const replies = [
      ...cases.map(([text]) => ask(text)),
      ...GLOSSARY.map((item) => ask(`${item.words[0]}って何？`, { audience: item.audience, pathname: "/nowhere" })),
    ];
    for (const reply of replies) {
      for (const action of [...reply.actions, ...reply.offers.map((offer) => offer.action)]) {
        if (action.kind === "navigate") assert.ok(allowed.has(action.href), action.href);
        if (action.kind === "show" && action.href) assert.ok(allowed.has(action.href), action.href);
      }
    }
  });

  it("すでにそのページにいるときは動かさず、そう伝える", () => {
    const reply = ask("日記", { pathname: "/journal" });
    assert.equal(navigated(reply), null);
    assert.match(reply.say, /日記/);
  });
});

describe("routeIntent — 教員の画面", () => {
  const cases = [
    ["アラート", "/educator/alerts"],
    ["生徒一覧", "/educator/roster"],
    ["クラスの生徒を見たい", "/educator/roster"],
    ["クラス", "/educator/class"],
    ["面談", "/educator/meetings"],
    ["学校全体", "/school"],
  ];

  for (const [text, href] of cases) {
    it(`「${text}」→ ${href}`, () => {
      assert.equal(navigated(teacher(text, { pathname: "/elsewhere" })), href);
    });
  }

  it("ホームは教員のホームへ", () => {
    assert.equal(navigated(teacher("ホーム", { pathname: "/educator/roster" })), "/educator");
  });

  it("生徒向けの行き先は教員の画面では拾わない", () => {
    assert.equal(navigated(teacher("日記を書きたい")), null);
    assert.equal(navigated(teacher("相談したい")), null);
  });

  it("つらさが混じった言葉には、アラートと緊急対応フローを示す（生徒向けの文や相談ページは出さない）", () => {
    const text = "生徒が死にたいと言っていた";
    const reply = teacher(text);
    assert.equal(reply.calm, true);
    assert.equal(navigated(reply), null);
    assert.match(reply.say, /緊急対応フロー/);
    assert.notEqual(reply.say, assessSafety(text).safe_response);
    assert.ok(!reply.offers.some((offer) => offer.action.kind === "handoff"));
    assert.equal(reply.offers[0].action.href, "/educator/alerts");
  });

  it("気分が沈んだ言葉は受け止めるだけで、生徒の相談ページには渡さない", () => {
    const reply = teacher("疲れた");
    assert.equal(reply.calm, true);
    assert.equal(reply.offers.length, 0);
  });

  it("あいさつの続きにはアラートを出す", () => {
    const reply = teacher("こんにちは", { pathname: "/educator" });
    assert.ok(reply.offers.some((offer) => offer.action.href === "/educator/alerts"));
  });

  it("カレンダーは教員のホームで示す", () => {
    const calendar = teacher("あと何日？", { pathname: "/educator/class" }).offers[0].action;
    assert.equal(calendar.kind, "show");
    assert.equal(calendar.href, "/educator");
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

  it("見え方の調整は教員の画面でも同じように効く", () => {
    assert.deepEqual(patched(teacher("文字を大きくして")), { text: "l" });
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

describe("routeIntent — 画面の説明", () => {
  it("「気分の内訳って何？」に、画面の定義どおりに答え、動かない", () => {
    const reply = ask("気分の内訳って何？");
    assert.equal(reply.say, entry("mood-bloom").say);
    assert.match(reply.say, /5枚の花びら/);
    assert.equal(reply.actions.length, 0);
  });

  it("ほかのページにある項目は、開いてから示す", () => {
    const offer = ask("気分の内訳って何？", { pathname: "/" }).offers[0];
    assert.equal(offer.label, "振り返りで見る");
    assert.deepEqual(offer.action, { kind: "show", heading: "気分の内訳", href: "/reflect" });
  });

  it("いまのページにある項目は、その場で示す", () => {
    const offer = ask("気分の内訳とは", { pathname: "/reflect" }).offers[0];
    assert.equal(offer.label, "画面で見る");
    assert.deepEqual(offer.action, { kind: "show", heading: "気分の内訳", href: null });
  });

  it("意味を聞いていれば、ページ名でも開かずに説明する", () => {
    assert.equal(navigated(teacher("アラート", { pathname: "/educator" })), "/educator/alerts");
    const reply = teacher("アラートって何？", { pathname: "/educator" });
    assert.equal(navigated(reply), null);
    assert.match(reply.say, /優先度の高いアラート/);
  });

  it("「この画面は何？」には、いまのページの説明と、続けて聞ける言葉を出す", () => {
    const reply = ask("この画面は何？", { pathname: "/reflect" });
    assert.match(reply.say, /気分の内訳/);
    assert.ok(reply.offers.length > 0);
    for (const offer of reply.offers) {
      assert.equal(offer.action.kind, "ask");
      assert.match(offer.action.text, /って何？$/);
    }
  });

  it("ページの名前で見方を聞かれても答える", () => {
    const reply = ask("振り返りの見方を教えて", { pathname: "/" });
    assert.equal(navigated(reply), null);
    assert.match(reply.say, /気分の移り変わり/);
  });

  it("説明を用意していない画面では、そう伝える", () => {
    assert.match(ask("この画面は何？", { pathname: "/chat" }).say, /まだ用意していません/);
  });

  it("見出しの言葉だけでも説明する", () => {
    assert.equal(teacher("日記の未提出").say, entry("missing-alerts").say);
  });

  it("生徒ごとの画面にある項目は、そこにいれば示し、いなければ生徒一覧へ", () => {
    assert.equal(teacher("AIタイムラインって何？", { pathname: "/educator/student/s1" }).offers[0].label, "画面で見る");
    const away = teacher("AIタイムラインって何？", { pathname: "/educator" }).offers[0];
    assert.deepEqual(away.action, { kind: "navigate", href: "/educator/roster" });
  });

  it("状態の区分の説明は、AIの算出した傾向で診断ではないと伝える", () => {
    const reply = teacher("高リスクって何？");
    assert.match(reply.say, /AIが算出した傾向/);
    assert.match(reply.say, /診断ではありません/);
  });

  it("生徒の画面では教員向けの言葉を説明しない（逆も同じ）", () => {
    assert.notEqual(ask("高リスクって何？").say, entry("band").say);
    assert.notEqual(teacher("気分の内訳って何？").say, entry("mood-bloom").say);
  });

  it("載っている言葉は、どれも自分の説明に着く（別の項目に吸われない）", () => {
    for (const item of GLOSSARY) {
      for (const word of item.words) {
        const reply = ask(`${word}って何？`, { audience: item.audience, pathname: "/nowhere" });
        assert.equal(reply.say, item.say, `「${word}って何？」が ${item.id} に着かない`);
      }
    }
  });

  it("画面の説明に出す言葉は、どれも実際に説明できる", () => {
    for (const guide of PAGE_GUIDES) {
      const says = new Set(GLOSSARY.filter((item) => item.audience === guide.audience).map((item) => item.say));
      for (const term of guide.terms) {
        const reply = ask(`${term}って何？`, { audience: guide.audience });
        assert.ok(says.has(reply.say), `「${term}」の説明がない（${guide.names[0]}）`);
      }
    }
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

  it("意味を聞く形でも、つらさの判定が先", () => {
    const reply = ask("死にたいって何");
    assert.equal(reply.calm, true);
    assert.equal(reply.offers[0].action.kind, "handoff");
  });
});

describe("routeIntent — 拾えないとき", () => {
  it("作り話で埋めず、相談への道を出す", () => {
    const reply = ask("あしたの天気は");
    assert.equal(navigated(reply), null);
    assert.ok(reply.offers.some((offer) => offer.action.kind === "handoff"));
  });

  it("教員の画面では、相談ではなく画面の説明への道を出す", () => {
    const reply = teacher("あしたの天気は");
    assert.ok(!reply.offers.some((offer) => offer.action.kind === "handoff"));
    assert.ok(reply.offers.some((offer) => offer.action.kind === "ask"));
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
    assert.equal(reply.expression, "bright");
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
    for (const { word, audience } of INTENT_WORDS) {
      for (const who of audience ? [audience] : ["student", "educator"]) {
        const reply = ask(word, { audience: who });
        assert.ok(
          reply.expression !== "oops" || reply.actions.length > 0,
          `「${word}」（${who}）が表に載っているのに拾われない`,
        );
      }
    }
  });

  it("出している候補はすべて実際に反応する（生徒・教員とも）", () => {
    for (const [audience, copy] of Object.entries(ASSISTANT_COPY)) {
      const home = audience === "educator" ? "/educator" : "/";
      for (const suggestion of copy.suggestions) {
        const reply = ask(suggestion.label, { audience, pathname: home });
        assert.notEqual(reply.expression, "oops", `「${suggestion.label}」（${audience}）が拾われない`);
      }
    }
  });
});

describe("pebble", () => {
  const numbersIn = (path) =>
    [...path.matchAll(/(-?\d+\.?\d*) (-?\d+\.?\d*)/g)].map(([, x, y]) => [Number(x), Number(y)]);

  /** 三次ベジェを刻んで、曲線そのものの通り道を返す。 */
  const onCurve = (path) => {
    const numbers = path.match(/-?\d+\.?\d*/g).map(Number);
    const points = [];
    let [x0, y0] = numbers;
    for (let i = 2; i + 5 < numbers.length; i += 6) {
      const [x1, y1, x2, y2, x3, y3] = numbers.slice(i, i + 6);
      for (let step = 0; step <= 10; step += 1) {
        const t = step / 10, u = 1 - t;
        points.push([
          u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
          u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3,
        ]);
      }
      [x0, y0] = [x3, y3];
    }
    return points;
  };

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

  it("芽はロゴの花びらと同じ形から作る", () => {
    // pebble.ts は写した制御点を持つ（node からブラウザ無しで読めるように）。
    // 写し間違いと、ロゴ側だけ直したときのずれを、ここで止める。
    const petal = PETAL_PATH.match(/-?\d+\.?\d*/g).map(Number);
    const sprout = numbersIn(sproutPath({ ...EXPRESSIONS.rest, rx: 0, ry: 0, lean: 0, lift: 0 })).flat();
    assert.equal(sprout.length, petal.length, "制御点の数が花びらと違う");

    // 芽は付け根の向きに合わせて回してあるので、回転と位置に依らない量
    // （点どうしの距離）で突き合わせる。大きさは SPROUT.scale で戻す。
    const spans = (values) => {
      const points = Array.from({ length: values.length / 2 }, (_, i) => [values[i * 2], values[i * 2 + 1]]);
      const out = [];
      for (let i = 0; i < points.length; i += 1)
        for (let j = i + 1; j < points.length; j += 1)
          out.push(Math.hypot(points[i][0] - points[j][0], points[i][1] - points[j][1]));
      return out;
    };
    const wanted = spans(petal);
    const got = spans(sprout).map((d) => d / SPROUT.scale);
    for (const [index, expected] of wanted.entries()) {
      assert.ok(Math.abs(got[index] - expected) < 0.5, `${index}: ${got[index].toFixed(2)} ≠ ${expected.toFixed(2)}`);
    }
  });

  it("芽は、どの表情でも跳ねても viewBox に収まる", () => {
    const [vx, vy, vw, vh] = PEBBLE_VIEWBOX.split(" ").map(Number);
    // Pebble.tsx の LIFT_LIMIT と、芽の振れ幅（WAG_LIMIT）に合わせる。
    const margin = 2.5;
    for (const [name, params] of Object.entries(EXPRESSIONS)) {
      for (const lift of [-4.5, -3.7, 0, 2]) {
        for (const phase of [-PHASE_SWAY, 0, PHASE_SWAY]) {
          for (const wag of [-9, 0, 9]) {
            // 制御点ではなく曲線そのものを辿る。制御点は曲線の外側に出るので、
            // そのまま見ると収まっているものまではみ出し扱いになる。
            for (const [x, y] of onCurve(sproutPath({ ...params, lift }, phase, wag))) {
              assert.ok(x > vx + margin && x < vx + vw - margin, `${name} lift=${lift} wag=${wag}: x=${x}`);
              assert.ok(y > vy + margin && y < vy + vh - margin, `${name} lift=${lift} wag=${wag}: y=${y}`);
            }
          }
        }
      }
    }
  });

  it("芽は体の縁から生える（つぶれても離れない）", () => {
    for (const [name, params] of Object.entries(EXPRESSIONS)) {
      const [baseX, baseY] = numbersIn(sproutPath(params))[0];
      const distance = Math.hypot(baseX - BODY_CENTER.x, baseY - (BODY_CENTER.y + params.lift));
      // その角度での輪郭までの距離。倍音で ±7% ほど動くので幅を持たせる。
      const edge = Math.hypot(params.rx * Math.cos(SPROUT.angle), params.ry * Math.sin(SPROUT.angle));
      assert.ok(distance < edge * 1.02, `${name}: 付け根が体から浮いている (${distance.toFixed(1)} > ${edge.toFixed(1)})`);
      assert.ok(
        distance > edge * 0.93 - SPROUT.sink * 1.2,
        `${name}: 付け根が体の奥に沈みすぎ (${distance.toFixed(1)}, 輪郭 ${edge.toFixed(1)})`,
      );
    }
  });

  it("影は浮くほど小さく薄くなる（置かれているものに見せる）", () => {
    const down = contactShadow({ ...EXPRESSIONS.rest, lift: 0 });
    const up = contactShadow({ ...EXPRESSIONS.rest, lift: -3.7 });
    assert.ok(up.rx < down.rx, "浮いても影が縮まない");
    assert.ok(up.alpha < down.alpha, "浮いても影が薄くならない");
    // 体の底より下にある。
    assert.ok(down.cy > 50 + EXPRESSIONS.rest.ry * 0.8);
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

  it("どの表情も笑わない（三日月の目を作らない）", () => {
    // 指しながらにこにこしていると、説明ではなく愛嬌になる。弾む体と
    // 目の開きで喜びを出し、口も三日月もつくらない。
    for (const [name, params] of Object.entries(EXPRESSIONS)) {
      for (const edge of ["upL", "downL", "upR", "downR"]) {
        assert.ok(params[edge] > 0, `${name}.${edge} が反っている（笑顔になっている）`);
      }
    }
    // できたときは、待機より目を開いて浮く。
    assert.ok(EXPRESSIONS.bright.upL > EXPRESSIONS.rest.upL);
    assert.ok(EXPRESSIONS.bright.lift < EXPRESSIONS.rest.lift);
  });

  it("落ち着いた表情は伏し目で、跳ねる余地を持たない", () => {
    assert.ok(EXPRESSIONS.steady.upL < EXPRESSIONS.steady.downL);
    assert.equal(EXPRESSIONS.steady.lift, 0);
  });

  it("伸び縮みの上限いっぱいでも、描いた曲線は線の太さごと viewBox に収まる", () => {
    const [vx, vy, vw, vh] = PEBBLE_VIEWBOX.split(" ").map(Number);
    // 曲線そのものを細かく辿る。制御点で調べると、曲線が収まっていても外に出たと判定してしまう。
    const curvePoints = (path) => {
      const numbers = path.match(/-?\d+\.?\d*/g).map(Number);
      const points = [];
      let [x0, y0] = numbers;
      for (let i = 2; i + 5 < numbers.length; i += 6) {
        const [x1, y1, x2, y2, x3, y3] = numbers.slice(i, i + 6);
        for (let step = 0; step <= 8; step += 1) {
          const t = step / 8, u = 1 - t;
          points.push([
            u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
            u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3,
          ]);
        }
        [x0, y0] = [x3, y3];
      }
      return points;
    };
    for (const size of [30, 54]) {
      const strokeHalf = (1.75 * vw) / size / 2;
      for (const lift of [-5.5, -3, -1, 0, 1, 3, 5.5]) {
        const room = shapeRoom(lift, strokeHalf);
        for (const [name, params] of Object.entries(EXPRESSIONS)) {
          // 伸ばしたうえで上限に当てる — 実際の描画と同じ順序。
          const stretched = { ...params, lift, rx: Math.min(params.rx * 1.2, room.rx), ry: Math.min(params.ry * 1.2, room.ry) };
          for (const phase of [-PHASE_SWAY, 0, PHASE_SWAY]) {
            for (const [x, y] of curvePoints(bodyPath(stretched, phase))) {
              assert.ok(x - strokeHalf >= vx && x + strokeHalf <= vx + vw, `${size}px ${name} lift=${lift}: x=${x.toFixed(2)}`);
              assert.ok(y - strokeHalf >= vy && y + strokeHalf <= vy + vh, `${size}px ${name} lift=${lift}: y=${y.toFixed(2)}`);
            }
          }
        }
      }
    }
  });

  it("上限は伸びを殺さない（飛び上がった直後の、聞いている顔が 6% 伸びられる）", () => {
    const strokeHalf = (1.75 * 82) / 54 / 2;
    const room = shapeRoom(-1.5, strokeHalf);
    assert.ok(room.ry >= EXPRESSIONS.listening.ry * 1.016 * 1.06, `ry room ${room.ry.toFixed(2)}`);
  });

  it("上限は、止まっているときの表情を削らない（呼吸で膨らんだぶんまで）", () => {
    const strokeHalf = (1.75 * 82) / 54 / 2;
    for (const [name, params] of Object.entries(EXPRESSIONS)) {
      const room = shapeRoom(Math.abs(params.lift) + 0.5, strokeHalf);
      assert.ok(params.rx * 1.012 <= room.rx, `${name}: rx ${(params.rx * 1.012).toFixed(2)} > room ${room.rx.toFixed(2)}`);
      assert.ok(params.ry * 1.016 <= room.ry, `${name}: ry ${(params.ry * 1.016).toFixed(2)} > room ${room.ry.toFixed(2)}`);
    }
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

describe("案内役が画面の中を移動する", () => {
  const view = { width: 1280, height: 800 };
  const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });
  const SIZE = 72;

  it("示す相手の左に立ち、相手のほうを見る（読む人の視線の手前）", () => {
    const target = rect(500, 300, 320, 120);
    const spot = standingSpot(target, view, SIZE);
    assert.ok(spot.x < target.left, "相手の上に乗っている");
    assert.equal(spot.look, "right");
    assert.equal(spot.bubble, "left", "吹き出しが相手にかぶる側へ出ている");
  });

  it("左に余白が無ければ右へ回る", () => {
    const target = rect(8, 300, 320, 120);
    const spot = standingSpot(target, view, SIZE);
    assert.ok(spot.x > target.right, "相手の上に乗っている");
    assert.equal(spot.look, "left");
    assert.equal(spot.bubble, "right");
  });

  it("画面幅いっぱいのカードには、左上の角に腰かける", () => {
    const target = rect(20, 400, view.width - 40, 220);
    const spot = standingSpot(target, view, SIZE);
    assert.equal(spot.look, "down");
    assert.ok(spot.x < target.left + SIZE, `左上から離れすぎ (${spot.x})`);
    assert.ok(Math.abs(spot.y - target.top) < SIZE, `上端から離れすぎ (${spot.y})`);
    // 画面の天井に張りつかない（以前はここで上へ追い出されていた）。
    assert.ok(spot.y > SIZE / 2 + 12, "天井に張りついている");
  });

  it("画面から食み出した相手には、見えている範囲を基準に立つ", () => {
    const target = rect(20, -300, view.width - 40, 900);
    const spot = standingSpot(target, view, SIZE);
    assert.ok(spot.y >= SIZE / 2, "画面の外に立っている");
    assert.ok(spot.y < view.height / 2, `見えている上のほうに立つはず (${spot.y})`);
  });

  it("吹き出しを出す余白が無ければ、下へ回す", () => {
    // 狭い画面で、相手の右に立たされたとき。横に出すと画面から出る。
    const narrow = { width: 380, height: 700 };
    const spot = standingSpot(rect(16, 200, 200, 100), narrow, 58);
    assert.equal(spot.look, "left", "右に立つはずの配置ではない");
    assert.equal(spot.bubble, "below");
  });

  it("どこに立っても画面からはみ出さない", () => {
    for (const target of [rect(0, 0, 40, 40), rect(1240, 760, 40, 40), rect(0, 0, view.width, view.height), rect(600, -200, 200, 80), rect(-500, 300, 400, 100)]) {
      const spot = standingSpot(target, view, SIZE);
      assert.ok(spot.x - SIZE / 2 >= 0 && spot.x + SIZE / 2 <= view.width, `x=${spot.x}`);
      assert.ok(spot.y - SIZE / 2 >= 0 && spot.y + SIZE / 2 <= view.height, `y=${spot.y}`);
    }
  });

  it("滑り出しと着きぎわは緩く、中ほどで速い", () => {
    assert.equal(easeInOut(0), 0);
    assert.equal(easeInOut(1), 1);
    assert.ok(Math.abs(easeInOut(0.5) - 0.5) < 0.001, "中間で半分を通らない");
    // 出だしの 10% で進む距離 < 中ほどの 10% で進む距離。
    const opening = easeInOut(0.1) - easeInOut(0);
    const middle = easeInOut(0.55) - easeInOut(0.45);
    const closing = easeInOut(1) - easeInOut(0.9);
    assert.ok(opening < middle, "出だしが速い");
    assert.ok(closing < middle, "着きぎわが速い");
    assert.ok(Math.abs(opening - closing) < 0.001, "行きと終わりの緩み方が違う");
  });

  it("移動は端から端でも1秒あまり。近くても一瞬では消えない", () => {
    const far = glideMs({ x: 1240, y: 760 }, { x: 40, y: 40 });
    const near = glideMs({ x: 400, y: 400 }, { x: 430, y: 410 });
    assert.ok(far > near);
    assert.ok(far <= 1100, `${far}ms は待たせすぎ`);
    assert.ok(near >= 420, `${near}ms は速すぎる`);
  });

  it("道すじは、始めと終わりがちょうど合う", () => {
    const from = { x: 1200, y: 700 };
    const to = { x: 220, y: 180 };
    assert.deepEqual(glideAt(from, to, 0), from);
    assert.deepEqual(glideAt(from, to, 1), to);
    // 途中は必ず両端のあいだ（行き過ぎて戻らない）。
    for (const t of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      const point = glideAt(from, to, t);
      assert.ok(point.x <= from.x && point.x >= to.x, `x=${point.x}`);
      assert.ok(point.y <= from.y && point.y >= to.y, `y=${point.y}`);
    }
  });

  it("進む向きに回り、着いたときは上を向いている", () => {
    const from = { x: 100, y: 400 };
    const right = spinFor(from, { x: 900, y: 300 });
    const left = spinFor(from, { x: 40, y: 300 });
    assert.ok(right > 0, "右へ行くのに逆回り");
    assert.ok(left < 0, "左へ行くのに逆回り");
    for (const spin of [right, left, spinFor(from, { x: 1240, y: 760 })]) {
      assert.equal(Math.abs(spin) % 360, 0, `${spin}度 — 半端に終わると傾いたまま話し始める`);
    }
    assert.ok(Math.abs(spinFor(from, { x: 1240, y: 760 })) > Math.abs(right) - 1, "遠いほど回る");
  });

  it("端に立っても、吹き出しは画面の中に収まる", () => {
    const width = 250;
    // 左端の近くに立ったとき、右へ寄る。
    assert.ok(bubbleShift(40, width, 800) > 0);
    assert.equal(40 + bubbleShift(40, width, 800) - width / 2 >= 12, true);
    // 右端の近くでは左へ。
    assert.ok(bubbleShift(770, width, 800) < 0);
    assert.equal(770 + bubbleShift(770, width, 800) + width / 2 <= 788, true);
    // 真ん中では動かさない。
    assert.equal(bubbleShift(400, width, 800), 0);
    // 画面より広い吹き出しは、寄せても入らないので触らない。
    assert.equal(bubbleShift(100, 900, 800), 0);
  });

  it("その場で話すのは、最初のひと区切りだけ", () => {
    const long =
      "これまでに記録した日の気分を、5枚の花びらで表しています。花びらは「とても良い」「良い」「ふつう」" +
      "「少しつらい」「つらい」にひとつずつ対応していて、その気分の日が多いほど大きくなります。" +
      "まだ記録のない気分は、薄く小さい花びらのまま残ります。花には上下がないので、良い・悪いの順位はつけていません。";
    const said = speechFor(long);
    assert.ok(said.length < long.length, "縮んでいない");
    assert.ok(said.endsWith("。") || said.endsWith("…"), `切り口が中途半端 (${said.slice(-12)})`);
    assert.equal(speechFor("ここです。"), "ここです。", "短い言葉まで刻まない");
  });

  it("長い説明ほど長く留まる。短くても読む間は残る", () => {
    assert.ok(dwellMs("ここです。") >= 2400);
    assert.ok(dwellMs("あ".repeat(80)) > dwellMs("ここです。"));
    assert.ok(dwellMs("あ".repeat(400)) <= 11000, "長すぎる説明でも、いつかは帰る");
  });
});
