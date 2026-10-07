import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CHANGE_RULE,
  buildSummary,
  compareRecentWindows,
  summaryViolations,
  textLength,
  topTags,
} from "../src/lib/teachers/records.ts";

/**
 * Blesc for Teachers の「変化あり」と面談前サマリー。
 *
 * 決め方そのもの（4週と前の4週、数値のしきい値）を固定する。ここが
 * ぶれると、画面の「変化あり」が実質的なリスク検知に変わっていく。
 */

const AS_OF = "2026-08-07";
const DAY = 86_400_000;
const back = (days) => new Date(Date.parse(`${AS_OF}T00:00:00Z`) - days * DAY).toISOString().slice(0, 10);

/** asOf から数えて、前の4週（28〜55日前）と直近4週（0〜27日前）に記録を置く。 */
function records({ previous, recent }) {
  const make = (offsetStart, list) =>
    list.map((r, i) => ({ date: back(offsetStart + i), mood: r.mood ?? "good", text: r.text ?? "部活で走った。", tags: r.tags ?? ["club"] }));
  return [...make(28, previous), ...make(0, recent)];
}
const many = (n, record = {}) => Array.from({ length: n }, () => ({ ...record }));

describe("変化あり — 4週と前の4週を比べる", () => {
  it("比べる期間は28日、記録は各期間4件から", () => {
    assert.equal(CHANGE_RULE.windowDays, 28);
    assert.equal(CHANGE_RULE.minRecords, 4);
  });

  it("前の4週に記録が4件未満なら、判定しない（比べる元が無い）", () => {
    const result = compareRecentWindows(records({ previous: many(3), recent: many(12) }), AS_OF);
    assert.equal(result.status, "insufficient");
  });

  it("同じような記録が続いていれば、変化なし", () => {
    const result = compareRecentWindows(records({ previous: many(16), recent: many(15) }), AS_OF);
    assert.equal(result.status, "steady");
  });

  it("気分の平均が1段階以上動けば、変化あり — 上がっても下がっても同じ札", () => {
    const down = compareRecentWindows(records({ previous: many(14, { mood: "good" }), recent: many(14, { mood: "neutral" }) }), AS_OF);
    const up = compareRecentWindows(records({ previous: many(14, { mood: "neutral" }), recent: many(14, { mood: "good" }) }), AS_OF);
    for (const result of [down, up]) {
      assert.equal(result.status, "changed");
      assert.ok(result.signals.some((s) => s.kind === "mood"));
    }
  });

  it("気分の差が1段階に届かなければ、変化なし", () => {
    // 4.0 → 3.5（半分が「ふつう」）
    const recent = [...many(7, { mood: "good" }), ...many(7, { mood: "neutral" })];
    const result = compareRecentWindows(records({ previous: many(14, { mood: "good" }), recent }), AS_OF);
    assert.equal(result.status, "steady");
  });

  it("記録した日数が半分以下になり、差が3日以上なら、変化あり", () => {
    const result = compareRecentWindows(records({ previous: many(16), recent: many(6) }), AS_OF);
    assert.equal(result.status, "changed");
    assert.deepEqual(result.signals.find((s) => s.kind === "frequency"), { kind: "frequency", before: 16, after: 6 });
  });

  it("直近の記録が少なくても、減ったこと自体は変化として出す", () => {
    const result = compareRecentWindows(records({ previous: many(14), recent: many(1) }), AS_OF);
    assert.equal(result.status, "changed");
    assert.deepEqual(result.signals.map((s) => s.kind), ["frequency"], "直近が少ないときは日数だけを比べる");
  });

  it("差が3日に届かない増減は、比が大きくても変化にしない（数が少ないときのぶれ）", () => {
    const result = compareRecentWindows(records({ previous: many(4), recent: many(2) }), AS_OF);
    assert.notEqual(result.status, "changed");
  });

  it("1件あたりの文字数が半分以下になり、差が40字以上なら、変化あり", () => {
    const long = "今日は部活のあとに友だちと帰って、明日の小テストのことを話した。".repeat(3);
    const result = compareRecentWindows(
      records({ previous: many(12, { text: long }), recent: many(12, { text: "疲れた。" }) }),
      AS_OF,
    );
    assert.ok(result.status === "changed" && result.signals.some((s) => s.kind === "length"));
  });

  it("よく選ぶ話題の上位3つのうち2つ以上が入れ替われば、変化あり", () => {
    const before = [...many(6, { tags: ["club"] }), ...many(5, { tags: ["friends"] }), ...many(4, { tags: ["study"] })];
    const after = [...many(6, { tags: ["family"] }), ...many(5, { tags: ["health"] }), ...many(4, { tags: ["club"] })];
    const result = compareRecentWindows(records({ previous: before, recent: after }), AS_OF);
    assert.ok(result.status === "changed" && result.signals.some((s) => s.kind === "tags"));
  });

  it("結果は3つのどれかだけ。重さの段階は持たない", () => {
    const result = compareRecentWindows(records({ previous: many(16, { mood: "very_good" }), recent: many(6, { mood: "hard" }) }), AS_OF);
    assert.ok(["insufficient", "steady", "changed"].includes(result.status));
    for (const key of Object.keys(result)) {
      assert.ok(!/severity|level|risk|score|band/i.test(key), `結果に段階を表す項目がある: ${key}`);
    }
  });

  it("文字数は空白を数えない。上位の話題は、同数なら先に出た順", () => {
    assert.equal(textLength("今日は\n  よく 寝た。"), 8);
    assert.deepEqual(topTags([{ tags: ["b"] }, { tags: ["a"] }, { tags: ["c", "a"] }]), ["a", "b", "c"]);
  });
});

describe("面談前サマリー", () => {
  const from = back(20);
  const to = AS_OF;
  const data = [
    { date: back(19), mood: "good", text: "部活で新しいメニューをやった。きつかったけど楽しかった。", tags: ["club"] },
    { date: back(12), mood: "neutral", text: "", tags: ["study"] },
    { date: back(5), mood: "low", text: "テストの点が思ったより低くて落ちこんだ。", tags: ["study", "club"] },
    { date: back(1), mood: "neutral", text: "友だちに相談したら少し楽になった。", tags: ["friends"] },
  ];

  it("話題・気分の推移・本人の記述の抜粋を、記録から集計する", () => {
    const summary = buildSummary(data, { from, to });
    assert.deepEqual(summary.topics[0], { tag: "club", count: 2 });
    assert.deepEqual(summary.moods.map((m) => m.date), [back(19), back(12), back(5), back(1)], "気分は古い順");
    assert.equal(summary.excerpts[0].date, back(1), "抜粋は新しい順");
    assert.equal(summary.excerpts.length, 3, "本文の無い記録は抜粋にしない");
    for (const excerpt of summary.excerpts) {
      const source = data.find((r) => r.date === excerpt.date);
      assert.ok(source.text.startsWith(excerpt.text.replace(/…$/, "")), "抜粋は言葉を変えない");
    }
  });

  describe("AI に書かせた要約の検査", () => {
    const ok = "この期間は部活動と勉強の話題が多く書かれています。最近の記録には「友だちに相談したら少し楽になった」とあります。";

    it("引用があり、評価や推測の言い回しが無ければ通る", () => {
      assert.deepEqual(summaryViolations(ok, data), []);
    });

    it("診断・推測・評価の言い回しは止める", () => {
      for (const phrase of ["勉強に不安を抱える傾向があります。", "少し心配です。", "抑うつの可能性があります。", "疲れていると思われます。"]) {
        const problems = summaryViolations(`${phrase}「友だちに相談したら少し楽になった」`, data);
        assert.ok(problems.some((p) => p.kind === "forbidden"), `通ってしまった: ${phrase}`);
      }
    });

    it("本人の言葉の中にあるぶんは止めない（書いたのは本人）", () => {
      const quoting = [...data, { date: back(0), mood: "hard", text: "最近ずっと心配で眠れない。", tags: ["health"] }];
      assert.deepEqual(summaryViolations("最近の記録には「最近ずっと心配で眠れない」とあります。", quoting), []);
    });

    it("引用が1つも無ければ出さない", () => {
      assert.ok(summaryViolations("部活動の話題が多い期間でした。", data).some((p) => p.kind === "no-quote"));
    });

    it("記録に無い言葉を引用の形で書いたら出さない", () => {
      const problems = summaryViolations("記録には「毎日がつらい」とあります。", data);
      assert.ok(problems.some((p) => p.kind === "unfaithful-quote" && p.quote === "毎日がつらい"));
    });
  });
});
