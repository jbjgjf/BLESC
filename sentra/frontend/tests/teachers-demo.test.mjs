import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  AS_OF,
  CLASS_STUDENTS,
  DEFAULT_SETTINGS,
  MY_RECORDS,
  PROMPTS,
  STAFF,
  USAGE_REPORT,
  readersOfStudentRecords,
  readersOfTeacherRecords,
} from "../src/lib/teachers/fixtures.ts";
import { FORBIDDEN_IN_SUMMARY, compareRecentWindows } from "../src/lib/teachers/records.ts";

/**
 * デモのデータが、仕様の見せたいところを全部見せられるか。
 * ここが崩れると、デモで「変化あり」の理由の一部が二度と出てこなくなる。
 */

const statusOf = (records) => compareRecentWindows(records, AS_OF);

describe("Blesc for Teachers のデモデータ", () => {
  it("日付の基準は生徒側と同じ日", () => {
    const labels = readFileSync("src/lib/blesc/labels.ts", "utf8");
    assert.match(labels, new RegExp(`export const TODAY = "${AS_OF}"`));
  });

  it("クラスには「変化あり」の4つの理由が、それぞれ見られる生徒がいる", () => {
    const kinds = new Set(
      CLASS_STUDENTS.flatMap((s) => {
        const result = statusOf(s.records);
        return result.status === "changed" ? result.signals.map((signal) => signal.kind) : [];
      }),
    );
    assert.deepEqual([...kinds].sort(), ["frequency", "length", "mood", "tags"]);
  });

  it("気分が上がった生徒にも、同じ「変化あり」が付く", () => {
    const up = CLASS_STUDENTS.find((s) => {
      const result = statusOf(s.records);
      return result.status === "changed" && result.signals.some((x) => x.kind === "mood" && x.after > x.before);
    });
    assert.ok(up, "上向きの変化の例が無い");
  });

  it("比べる元が無い生徒（転入）は、判定しない", () => {
    assert.ok(CLASS_STUDENTS.some((s) => statusOf(s.records).status === "insufficient"));
  });

  it("ほとんどの生徒は「変化なし」（札が並ぶ一覧は、それだけで警告に見える）", () => {
    const changed = CLASS_STUDENTS.filter((s) => statusOf(s.records).status === "changed").length;
    assert.ok(changed <= 6, `${changed}人に変化あり — 多すぎる`);
  });

  it("出席番号は1から順に並んでいる", () => {
    assert.deepEqual(CLASS_STUDENTS.map((s) => s.number), CLASS_STUDENTS.map((_, i) => i + 1));
  });

  it("教職員にも、変化ありと判定なしの例がある", () => {
    const statuses = STAFF.map((m) => statusOf(m.records).status);
    assert.ok(statuses.includes("changed"));
    assert.ok(statuses.includes("insufficient"));
  });

  it("山本先生は、今日の記録をまだ書いていない（書く画面から見せられる）", () => {
    assert.equal(MY_RECORDS.some((r) => r.date === AS_OF), false);
    assert.ok(MY_RECORDS.length > 20);
  });

  it("質問プロンプトに、評価や診断の言い回しは無い", () => {
    for (const prompt of PROMPTS) {
      for (const { pattern } of FORBIDDEN_IN_SUMMARY) assert.ok(!pattern.test(prompt.text), `「${prompt.text}」`);
    }
  });
});

describe("閲覧者の表示（A-5 / D-1）", () => {
  it("既定では、先生の記録を読むのは教頭だけ", () => {
    assert.deepEqual(readersOfTeacherRecords(DEFAULT_SETTINGS).map((r) => r.title), ["教頭"]);
  });

  it("設定を変えると、読める人の表示も変わる", () => {
    const settings = { ...DEFAULT_SETTINGS, staffReaders: { gradeHead: true, vicePrincipal: true, principal: false } };
    assert.deepEqual(readersOfTeacherRecords(settings).map((r) => r.title), ["2年 学年主任", "教頭"]);
  });

  it("生徒の記録は、既定では担任だけが読む", () => {
    assert.deepEqual(readersOfStudentRecords(DEFAULT_SETTINGS).map((r) => r.title), ["担任"]);
  });

  it("先生の面談メモは、既定では異動先へ引き継がない（C-4）", () => {
    assert.equal(DEFAULT_SETTINGS.staffMemoHandover, false);
  });
});

describe("利用状況（D-5）", () => {
  it("クラスはクラスの順のまま。記録率で並べ替えない（順位にしない）", () => {
    for (const term of USAGE_REPORT.terms) {
      const names = term.classes.map((c) => c.name);
      assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b, "ja")));
    }
  });

  it("先生の記録率は、全体の集計値ひとつだけ（個人別は持たない）", () => {
    for (const term of USAGE_REPORT.terms) assert.equal(typeof term.teachers, "number");
  });
});
