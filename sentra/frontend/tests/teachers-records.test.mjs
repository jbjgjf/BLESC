import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CHANGE_RULE,
  SUMMARY_RULE,
  addDays,
  buildSummary,
  describeChange,
  detectChanges,
  isSchoolDay,
  missedSchoolDays,
  schoolDaysUntil,
  summaryViolations,
  weekStart,
} from "../src/lib/teachers/records.ts";

const AS_OF = "2026-08-07"; // 金曜日

/** 登校日ごとに記録を作る。make(ago, i) が null を返した日は書かない。 */
function series(make, span = 42) {
  const records = [];
  for (let ago = span - 1; ago >= 0; ago -= 1) {
    const date = addDays(AS_OF, -ago);
    if (!isSchoolDay(date)) continue;
    const record = make(ago, records.length);
    if (record) records.push({ date, time: "16:30", mood: "good", tags: ["study"], text: "今日はふつうの一日だった。", ...record });
  }
  return records;
}

const steady = () => series(() => ({}));
const label = (tag) => ({ study: "授業・勉強", club: "部活動", workload: "業務量", parents: "保護者対応" })[tag] ?? tag;

describe("日付", () => {
  it("土日は登校日に数えない", () => {
    assert.equal(isSchoolDay("2026-08-07"), true);
    assert.equal(isSchoolDay("2026-08-08"), false);
    assert.equal(isSchoolDay("2026-08-09"), false);
  });

  it("登校日だけをさかのぼって並べる（古い順）", () => {
    assert.deepEqual(schoolDaysUntil(AS_OF, 7), ["2026-07-30", "2026-07-31", "2026-08-03", "2026-08-04", "2026-08-05", "2026-08-06", "2026-08-07"]);
  });

  it("週の区切りは月曜日", () => {
    assert.equal(weekStart(AS_OF), "2026-08-03");
    assert.equal(weekStart("2026-08-03"), "2026-08-03");
    assert.equal(weekStart("2026-08-09"), "2026-08-03");
  });

  it("記録の空いた登校日を数える（今日と土日は数えない）", () => {
    const records = series((ago) => (ago <= 6 ? null : {}));
    assert.equal(missedSchoolDays(records, AS_OF), 4);
  });
});

describe("変化があった（直近2週間 対 それまで）", () => {
  it("ふだんどおりなら変化なし", () => {
    assert.equal(detectChanges(steady(), AS_OF).status, "steady");
  });

  it("比べる元が足りなければ判定しない", () => {
    const records = series((ago) => (ago > 9 ? null : {}));
    assert.equal(detectChanges(records, AS_OF).status, "insufficient");
  });

  it("記録の間は、比べる元が足りなくても言える", () => {
    const records = series((ago) => (ago > 20 || ago <= 6 ? null : {}));
    const result = detectChanges(records, AS_OF);
    assert.equal(result.status, "changed");
    assert.deepEqual(result.changes, [{ kind: "gap", days: 4 }]);
  });

  it("記録の間は、登校日で3日から", () => {
    // 今日（金）はまだ書いていない。最後が火曜なら水・木の2日、月曜なら3日。
    const two = series((ago) => (ago <= 2 ? null : {}));
    assert.equal(missedSchoolDays(two, AS_OF), 2);
    assert.equal(detectChanges(two, AS_OF).status, "steady", "2日の間は変化にしない");
    const three = series((ago) => (ago <= 3 ? null : {}));
    assert.deepEqual(detectChanges(three, AS_OF).changes?.[0], { kind: "gap", days: 3 });
  });

  it("気分が下がった・上がった（どちらも同じ扱い）", () => {
    const down = series((ago) => ({ mood: ago < CHANGE_RULE.recentDays ? "low" : "good" }));
    assert.deepEqual(detectChanges(down, AS_OF).changes, [{ kind: "mood", direction: "down" }]);
    const up = series((ago) => ({ mood: ago < CHANGE_RULE.recentDays ? "very_good" : "neutral" }));
    assert.deepEqual(detectChanges(up, AS_OF).changes, [{ kind: "mood", direction: "up" }]);
  });

  it("気分の小さな揺れは変化にしない", () => {
    const records = series((ago, i) => ({ mood: ago < CHANGE_RULE.recentDays ? (i % 2 ? "good" : "neutral") : "good" }));
    assert.equal(detectChanges(records, AS_OF).status, "steady");
  });

  it("それまで少なかった話題が、直近で半分以上になった", () => {
    const records = series((ago, i) => ({ tags: ago < CHANGE_RULE.recentDays && i % 3 !== 0 ? ["club"] : ["study"] }));
    assert.deepEqual(detectChanges(records, AS_OF).changes, [{ kind: "topic", tag: "club" }]);
  });

  it("いつも多い話題が少し増えただけでは変化にしない", () => {
    const records = series((ago, i) => ({ tags: i % 2 === 0 || ago < CHANGE_RULE.recentDays ? ["club"] : ["study"] }));
    assert.ok(!detectChanges(records, AS_OF).changes?.some((c) => c.kind === "topic"));
  });

  it("同じ話題が続いている", () => {
    const records = series((ago) => ({ tags: ago < 8 ? ["parents", "study"] : ["study"] }));
    assert.deepEqual(detectChanges(records, AS_OF).changes, [{ kind: "streak", tag: "parents" }]);
  });

  it("記述が短くなった・長くなった", () => {
    const long = "今日は授業で発表した。緊張したけど、言いたいことはだいたい言えたと思う。";
    const shorter = series((ago) => ({ text: ago < CHANGE_RULE.recentDays ? "ふつう。" : long }));
    assert.deepEqual(detectChanges(shorter, AS_OF).changes, [{ kind: "length", direction: "shorter" }]);
    const longer = series((ago) => ({ text: ago < CHANGE_RULE.recentDays ? long : "ふつう。" }));
    assert.deepEqual(detectChanges(longer, AS_OF).changes, [{ kind: "length", direction: "longer" }]);
  });

  it("記録の時間は、先生の記録のときだけ見る", () => {
    const records = series((ago) => ({ time: ago < CHANGE_RULE.recentDays ? "19:10" : "16:20" }));
    assert.equal(detectChanges(records, AS_OF).status, "steady");
    assert.deepEqual(detectChanges(records, AS_OF, { time: true }).changes, [{ kind: "time", direction: "later" }]);
  });

  it("段階・点数・順位を持たない", () => {
    const result = detectChanges(series((ago) => ({ mood: ago < 14 ? "hard" : "good" })), AS_OF);
    for (const change of result.changes) {
      for (const key of Object.keys(change)) assert.ok(!/score|level|severity|rank|risk/i.test(key), key);
    }
  });

  it("一文にする（先生の話題は『』で括る）", () => {
    assert.equal(describeChange({ kind: "topic", tag: "club" }, label, "student"), "部活動の話題が増えています");
    assert.equal(describeChange({ kind: "topic", tag: "workload" }, label, "teacher"), "『業務量』の話題が増えています");
    assert.equal(describeChange({ kind: "streak", tag: "parents" }, label, "teacher"), "『保護者対応』が続いています");
    assert.equal(describeChange({ kind: "gap", days: 4 }, label, "student"), "記録が4日空いています");
    assert.equal(describeChange({ kind: "time", direction: "later" }, label, "teacher"), "記録の時間が遅くなっています");
    assert.equal(describeChange({ kind: "mood", direction: "down" }, label, "student"), "この2週間、気分が下がり気味です");
  });
});

describe("面談前の要約", () => {
  const moodLabel = (m) => ({ very_good: "とても良い", good: "良い", neutral: "ふつう", low: "少しつらい", hard: "つらい" })[m];

  it("記録が5日分未満なら作らない", () => {
    const few = series((ago) => (ago < 4 ? {} : null));
    assert.ok(few.length < SUMMARY_RULE.minRecords);
    assert.equal(buildSummary(few, { asOf: AS_OF, moodLabel }), null);
  });

  it("話題は上位3つと回数", () => {
    const records = series((ago, i) => ({ tags: [["club"], ["club", "study"], ["future"], ["club"], ["family"]][i % 5] }));
    const summary = buildSummary(records, { asOf: AS_OF, moodLabel });
    assert.equal(summary.topics.length, 3);
    assert.equal(summary.topics[0].tag, "club");
    assert.ok(summary.topics.every((t, i, all) => i === 0 || all[i - 1].count >= t.count));
  });

  it("気分の流れは前半と後半の比べ方だけで、判断の言葉を持たない", () => {
    const records = series((ago) => ({ mood: ago < 14 ? "low" : "good" }));
    const summary = buildSummary(records, { asOf: AS_OF, moodLabel });
    assert.equal(summary.moodFlow, "前半は『良い』の日が多く、後半は『少しつらい』の日が多くなっています。");
    assert.deepEqual(summaryViolations(summary.moodFlow, records), []);
  });

  it("本人の言葉は、記録の本文からそのまま（新しい順に3件まで）", () => {
    const records = series((ago) => ({ text: `${ago}日前のこと。ほかにも書いた。` }));
    const summary = buildSummary(records, { asOf: AS_OF, moodLabel });
    assert.equal(summary.quotes.length, SUMMARY_RULE.quotes);
    for (const quote of summary.quotes) assert.ok(records.some((r) => r.date === quote.date && r.text.startsWith(quote.text)), quote.text);
    assert.ok(summary.quotes[0].date > summary.quotes[1].date);
  });

  it("業務に関する記述は、指定したタグの記録だけ", () => {
    const records = series((ago, i) => ({ tags: i % 2 ? ["workload"] : ["lesson"], text: i % 2 ? "仕事が終わらず、持ち帰りになった。" : "授業がうまくまとまった。" }));
    const summary = buildSummary(records, { asOf: AS_OF, moodLabel, workTags: ["workload", "admin", "parents"] });
    assert.ok(summary.work.length > 0);
    assert.ok(summary.work.every((w) => w.tags.includes("workload") && !w.tags.includes("lesson")));
    assert.deepEqual(buildSummary(records, { asOf: AS_OF, moodLabel }).work, []);
  });
});

describe("AI に書かせた要約の検査", () => {
  const records = [{ date: AS_OF, time: "16:00", mood: "low", tags: ["club"], text: "部活がつらくて、心配なことがある。" }];

  it("診断・推測・評価・助言の言い回しは止める", () => {
    for (const text of ["抑うつの傾向があります。", "ストレスを抱えている可能性があります。", "注意が必要です。", "明日、声をかけましょう。"]) {
      assert.ok(summaryViolations(text, records).some((p) => p.kind === "forbidden"), text);
    }
  });

  it("本人の言葉の中にあるぶんは止めない（書いたのは本人）", () => {
    assert.deepEqual(summaryViolations("記録には「部活がつらくて、心配なことがある。」とあります。", records), []);
  });

  it("記録に無い言葉を引用の形で書いたら出さない", () => {
    assert.deepEqual(summaryViolations("記録には「部活をやめたい」とあります。", records), [{ kind: "unfaithful-quote", quote: "部活をやめたい" }]);
  });
});
