import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { describe, it } from "node:test";

import { TODAY } from "../src/lib/blesc/labels.ts";
import {
  AS_OF,
  CLASSES,
  MEETING_PLANS,
  PERSONAS,
  STAFF,
  TEACHER_QUESTIONS,
  WORK_TAGS,
  landingOf,
  readersOfStaff,
  readersOfStudent,
  staffById,
  studentsOf,
} from "../src/lib/teachers/fixtures.ts";
import { addDays, detectChanges, isSchoolDay } from "../src/lib/teachers/records.ts";

const changedIn = (people, options) =>
  people.filter((p) => detectChanges(p.records, AS_OF, options).status === "changed");

describe("デモの学校", () => {
  it("基準日は生徒側の今日と同じ", () => {
    assert.equal(AS_OF, TODAY);
  });

  it("3学年×4クラス、1クラス38人。教職員は50人", () => {
    assert.equal(CLASSES.length, 12);
    for (const c of CLASSES) assert.equal(studentsOf(c.id).length, 38, c.name);
    assert.equal(STAFF.length, 50);
  });

  it("出席番号は名簿順（1から順に）", () => {
    const students = studentsOf("c-2-3");
    assert.deepEqual(students.map((s) => s.number), students.map((_, i) => i + 1));
  });

  it("記録は登校日だけ", () => {
    for (const s of [...studentsOf("c-2-3"), ...STAFF]) for (const r of s.records) assert.ok(isSchoolDay(r.date), r.date);
  });

  it("2年3組に、仕様書の例の山田さんがいる", () => {
    assert.ok(studentsOf("c-2-3").some((s) => s.name.startsWith("山田 ")));
  });
});

describe("立場は権限の組み合わせ（1章・6-3）", () => {
  const tabs = (p) =>
    [p.access.write && "自分の記録", p.access.students?.tab, p.access.teachers && "先生", "設定"].filter(Boolean).join("→");

  it("出るタブの並び", () => {
    assert.equal(tabs(PERSONAS.tanaka), "自分の記録→クラス→設定");
    assert.equal(tabs(PERSONAS.takahashi), "自分の記録→設定");
    assert.equal(tabs(PERSONAS.sato), "自分の記録→クラス→先生→設定");
    assert.equal(tabs(PERSONAS.suzuki), "自分の記録→先生→設定");
    assert.equal(tabs(PERSONAS.ito), "先生→設定");
    assert.equal(tabs(PERSONAS.endo), "自分の記録→生徒→設定");
    assert.equal(tabs(PERSONAS.yamashita), "生徒→設定");
  });

  it("ログイン直後の画面：書く人は自分の記録、読むだけの人は先生か生徒", () => {
    assert.equal(landingOf(PERSONAS.tanaka), "/educator");
    assert.equal(landingOf(PERSONAS.ito), "/educator/staff");
    assert.equal(landingOf(PERSONAS.yamashita), "/educator/class");
  });

  it("読める範囲：担任は自クラス、学年主任は学年、養護教諭とSCは全生徒", () => {
    assert.deepEqual(PERSONAS.tanaka.access.students.classIds, ["c-2-3"]);
    assert.equal(PERSONAS.sato.access.students.classIds.length, 4);
    assert.equal(PERSONAS.endo.access.students.classIds.length, 12);
    assert.equal(PERSONAS.yamashita.access.students.classIds.length, 12);
  });

  it("学年主任は自分の学年の先生（12名）、教頭は全教職員（48名）", () => {
    const sato = PERSONAS.sato.access.teachers;
    assert.equal(sato.label, "2年の先生");
    assert.equal(sato.staffIds.length, 12);
    assert.ok(sato.staffIds.every((id) => staffById(id).grade === 2));
    assert.ok(!sato.staffIds.includes("t-sato"), "自分自身は読まない");
    const suzuki = PERSONAS.suzuki.access.teachers;
    assert.equal(suzuki.staffIds.length, 48);
    assert.ok(!suzuki.staffIds.includes("t-ito"), "教頭は校長を読まない");
  });

  it("読む向きは一方通行で、同僚どうしは読めない", () => {
    for (const reader of STAFF) {
      for (const subject of STAFF) {
        if (reader === subject) continue;
        const forward = readersOfStaff(subject.id).some((r) => r.name.startsWith(reader.name.split(" ")[0]) && r.title !== "先生");
        const backward = readersOfStaff(reader.id).some((r) => r.name.startsWith(subject.name.split(" ")[0]) && r.title !== "先生");
        assert.ok(!(forward && backward), `${reader.name} と ${subject.name} が互いに読める`);
      }
    }
    // 学年主任どうしは互いを読めない。
    assert.ok(!PERSONAS.sato.access.teachers.staffIds.includes("t-ishikawa"));
  });

  it("書く画面の閲覧者：担任は学年主任・教頭・校長、学年主任は教頭・校長", () => {
    assert.deepEqual(readersOfStaff("t-tanaka").map((r) => `${r.name}（${r.title}）`), ["佐藤先生（学年主任）", "鈴木先生（教頭）", "伊藤先生（校長）"]);
    assert.deepEqual(readersOfStaff("t-sato").map((r) => r.title), ["教頭", "校長"]);
    assert.deepEqual(readersOfStaff("t-suzuki").map((r) => r.title), ["校長"]);
  });

  it("生徒の記録は、担任と学校が許可した人だけ", () => {
    assert.deepEqual(readersOfStudent("c-2-3").map((r) => r.title), ["担任", "学年主任", "養護教諭", "スクールカウンセラー"]);
  });

  it("外部のスクールカウンセラーは書かない（記録を持たない）", () => {
    assert.equal(PERSONAS.yamashita.staffId, null);
    assert.equal(PERSONAS.yamashita.access.write, false);
  });
});

describe("変化があった（デモに用意した例）", () => {
  it("2年3組は、作った5人だけが変化あり（記録の間・気分の上下・話題・記述の長さ）", () => {
    const students = studentsOf("c-2-3");
    const changed = changedIn(students);
    assert.deepEqual(changed.map((s) => s.name.split(" ")[0]), ["上田", "木村", "清水", "中島", "前田"]);
    const kinds = changed.flatMap((s) => detectChanges(s.records, AS_OF).changes.map((c) => c.kind + ("direction" in c ? `:${c.direction}` : "")));
    for (const kind of ["gap", "mood:down", "mood:up", "topic", "length:shorter"]) assert.ok(kinds.includes(kind), kind);
    const noguchi = students.find((s) => s.name.startsWith("野口 "));
    assert.equal(detectChanges(noguchi.records, AS_OF).status, "insufficient", "転入して間もない");
  });

  it("2年の先生には、仕様書の3つの例（業務量が増えた・保護者対応が続く・記録の時間が遅い）", () => {
    const changes = (id) => detectChanges(staffById(id).records, AS_OF, { time: true }).changes ?? [];
    assert.deepEqual(changes("t-okamoto"), [{ kind: "topic", tag: "workload" }]);
    assert.deepEqual(changes("t-mori"), [{ kind: "streak", tag: "parents" }]);
    assert.deepEqual(changes("t-takahashi"), [{ kind: "time", direction: "later" }]);
  });

  it("どのクラスも、変化ありは一部の人だけ", () => {
    for (const c of CLASSES) assert.ok(changedIn(studentsOf(c.id)).length <= 8, c.name);
    assert.ok(changedIn(STAFF, { time: true }).length <= 12);
  });
});

describe("書く画面の前提", () => {
  it("立場の人はみな、今日はまだ書いていない（デモで書けるように）", () => {
    for (const persona of Object.values(PERSONAS)) {
      if (!persona.access.write) continue;
      assert.ok(!staffById(persona.staffId).records.some((r) => r.date === AS_OF), persona.name);
    }
  });

  it("田中先生は昨日の分を書き忘れている（「昨日の分も書けます」）", () => {
    assert.ok(!staffById("t-tanaka").records.some((r) => r.date === addDays(AS_OF, -1)));
  });

  it("テーマのタグは仕様書の8つ、並びもそのとおり", () => {
    assert.deepEqual(WORK_TAGS.map((t) => t.label), ["授業", "校務", "生徒対応", "保護者対応", "部活動", "業務量", "体調", "その他"]);
  });

  it("思いつかないときの質問は、仕様書の例から始まる", () => {
    assert.equal(TEACHER_QUESTIONS[0], "今日いちばん時間を使った仕事は？");
  });

  it("上田さんの面談は次の登校日（前日のお知らせが出る）", () => {
    const ueda = studentsOf("c-2-3").find((s) => s.name.startsWith("上田 "));
    const plan = MEETING_PLANS.find((p) => p.subjectId === ueda.id);
    let next = addDays(AS_OF, 1);
    while (!isSchoolDay(next)) next = addDays(next, 1);
    assert.equal(plan.date, next);
  });
});

describe("画面の言葉（仕様書の文言と、使わない言葉）", () => {
  const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  const files = (dir) =>
    readdirSync(new URL(`../${dir}`, import.meta.url)).flatMap((name) => {
      const path = `${dir}/${name}`;
      return statSync(new URL(`../${path}`, import.meta.url)).isDirectory() ? files(path) : [path];
    });
  const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

  it("書く画面は仕様書のとおりの言葉", () => {
    const page = read("src/app/educator/page.tsx");
    for (const phrase of ["今日はいかがでしたか", "一言でも構いません。今日あったこと、感じたこと", "人事評価・勤務評定には使われません", "記録しました。また明日", "書くことが思いつかないとき", "別の質問", "の分も書けます"]) {
      assert.ok(page.includes(phrase), phrase);
    }
    assert.match(page, /const LIMIT = 400;/);
    assert.match(page, /const SHOW_REST_AFTER = 350;/);
  });

  it("読む画面の空の状態と、要約の注意書き", () => {
    const people = read("src/components/teachers/PeopleScreen.tsx");
    assert.ok(people.includes("今週、大きな変化はありませんでした"));
    assert.ok(people.includes("変化は記録が2週間たまると表示されます"));
    assert.ok(people.includes("今週分を確認した"));
    const detail = read("src/components/teachers/PersonDetail.tsx");
    assert.ok(detail.includes("AIによる要約です。元の記録もご確認ください"));
    assert.ok(detail.includes("日分未満のため要約できません。記録をそのままご覧ください"));
    assert.ok(read("src/components/teachers/parts.tsx").includes("このページは表示できません"));
  });

  it("先生の画面には、リスク・要注意・アラートの言葉を出さない", () => {
    const sources = [...files("src/app/educator"), ...files("src/components/teachers")].filter((p) => /\.(tsx|ts)$/.test(p));
    for (const path of sources) {
      assert.doesNotMatch(code(read(path)), /リスク|要注意|アラート|危険|高リスク|深刻/, path);
    }
  });

  it("警告の色（赤・黄）を使わない", () => {
    const css = read("src/components/teachers/teachers.module.css");
    assert.doesNotMatch(css, /--bl-(alert|watch)/);
  });

  it("先生の画面はラベンダー、生徒の画面は青（色相だけが違う）", () => {
    const css = read("src/app/blesc.css");
    assert.match(css, /:root \{\s*--bl-hue: 206;/);
    assert.match(css, /\.bl-app\[data-bl-context="educator"\] \{\s*--bl-hue: 262;/);
    assert.doesNotMatch(read("src/components/teachers/teachers.module.css"), /#[0-9a-f]{6}.*(blue|accent|button)|t-blue/i);
    assert.ok(read("src/components/teachers/TeacherShell.tsx").includes('src="/flower-teachers.png"'));
  });
});
