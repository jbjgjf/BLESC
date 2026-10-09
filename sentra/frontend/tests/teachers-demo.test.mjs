import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { describe, it } from "node:test";

import { contextForPath } from "../src/lib/blesc/context.ts";
import { TODAY } from "../src/lib/blesc/labels.ts";
import {
  AS_OF,
  MEETING_PLANS,
  PERSONAS,
  PERSONA_ORDER,
  STAFF,
  TEACHER_QUESTIONS,
  WORK_TAGS,
  landingOf,
  readersOfStaff,
  staffById,
} from "../src/lib/teachers/fixtures.ts";
import { addDays, detectChanges, isSchoolDay } from "../src/lib/teachers/records.ts";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const files = (dir) =>
  readdirSync(new URL(`../${dir}`, import.meta.url)).flatMap((name) => {
    const path = `${dir}/${name}`;
    return statSync(new URL(`../${path}`, import.meta.url)).isDirectory() ? files(path) : [path];
  });
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

const changedIn = (people, options) =>
  people.filter((p) => detectChanges(p.records, AS_OF, options).status === "changed");

describe("Blesc for Teachers は、生徒・教員の Blesc とは別のサービス", () => {
  it("/teachers は Blesc for Teachers、/educator と /school は生徒を読む教員の画面", () => {
    assert.equal(contextForPath("/teachers"), "teachers");
    assert.equal(contextForPath("/teachers/staff"), "teachers");
    assert.equal(contextForPath("/educator"), "educator");
    assert.equal(contextForPath("/educator/roster"), "educator");
    assert.equal(contextForPath("/school"), "educator");
  });

  it("生徒の記録を読むコードを持たない（生徒は /educator で読む）", () => {
    const sources = [...files("src/app/teachers"), ...files("src/components/teachers"), ...files("src/lib/teachers")].filter((p) => /\.(tsx|ts)$/.test(p));
    for (const path of sources) assert.doesNotMatch(code(read(path)), /studentsOf|findStudent|readersOfStudent|access\.students/, path);
  });
});

describe("デモの学校", () => {
  it("基準日は生徒側の今日と同じ", () => {
    assert.equal(AS_OF, TODAY);
  });

  it("教職員は50人", () => {
    assert.equal(STAFF.length, 50);
  });

  it("記録は登校日だけ", () => {
    for (const s of STAFF) for (const r of s.records) assert.ok(isSchoolDay(r.date), r.date);
  });
});

describe("立場は権限の組み合わせ（1章・6-3）", () => {
  const tabs = (p) => [p.access.write && "自分の記録", p.access.teachers && "先生", "設定"].filter(Boolean).join("→");

  it("立場は6人（7章の例の5人と、養護教諭）。みな教職員で、生徒を読む権限は持たない", () => {
    assert.deepEqual(PERSONA_ORDER, ["tanaka", "takahashi", "sato", "suzuki", "ito", "endo"]);
    for (const persona of Object.values(PERSONAS)) {
      assert.ok(staffById(persona.staffId), persona.name);
      assert.deepEqual(Object.keys(persona.access).sort(), ["teachers", "write"], persona.name);
    }
  });

  it("出るタブの並び", () => {
    assert.equal(tabs(PERSONAS.tanaka), "自分の記録→設定");
    assert.equal(tabs(PERSONAS.takahashi), "自分の記録→設定");
    assert.equal(tabs(PERSONAS.sato), "自分の記録→先生→設定");
    assert.equal(tabs(PERSONAS.suzuki), "自分の記録→先生→設定");
    assert.equal(tabs(PERSONAS.ito), "先生→設定");
    assert.equal(tabs(PERSONAS.endo), "自分の記録→設定");
  });

  it("ログイン直後の画面：書く人は自分の記録、読むだけの人は先生", () => {
    assert.equal(landingOf(PERSONAS.tanaka), "/teachers");
    assert.equal(landingOf(PERSONAS.ito), "/teachers/staff");
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

});

describe("変化があった（デモに用意した例）", () => {
  it("2年の先生には、仕様書の3つの例（業務量が増えた・保護者対応が続く・記録の時間が遅い）", () => {
    const changes = (id) => detectChanges(staffById(id).records, AS_OF, { time: true }).changes ?? [];
    assert.deepEqual(changes("t-okamoto"), [{ kind: "topic", tag: "workload" }]);
    assert.deepEqual(changes("t-mori"), [{ kind: "streak", tag: "parents" }]);
    assert.deepEqual(changes("t-takahashi"), [{ kind: "time", direction: "later" }]);
  });

  it("変化ありは一部の人だけ", () => {
    assert.ok(changedIn(STAFF, { time: true }).length <= 12);
  });

  it("着任したばかりの先生は、比べる元がまだ無い", () => {
    assert.equal(detectChanges(staffById("t-kobayashi").records, AS_OF, { time: true }).status, "insufficient");
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

  it("岡本先生の面談は次の登校日（学年主任の佐藤先生に、前日のお知らせが出る）", () => {
    const plan = MEETING_PLANS.find((p) => p.subjectId === "t-okamoto");
    assert.equal(plan.author, "sato");
    let next = addDays(AS_OF, 1);
    while (!isSchoolDay(next)) next = addDays(next, 1);
    assert.equal(plan.date, next);
  });
});

describe("画面の言葉（仕様書の文言と、使わない言葉）", () => {
  it("書く画面は仕様書のとおりの言葉", () => {
    const page = read("src/app/teachers/page.tsx");
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
    const sources = [...files("src/app/teachers"), ...files("src/components/teachers")].filter((p) => /\.(tsx|ts)$/.test(p));
    for (const path of sources) {
      assert.doesNotMatch(code(read(path)), /リスク|要注意|アラート|危険|高リスク|深刻/, path);
    }
  });

  it("警告の色（赤・黄）を使わない", () => {
    const css = read("src/components/teachers/teachers.module.css");
    assert.doesNotMatch(css, /--bl-(alert|watch)/);
  });

  it("Blesc for Teachers はラベンダー、生徒・教員の Blesc は青（色相だけが違う）", () => {
    const css = read("src/app/blesc.css");
    assert.match(css, /:root \{\s*--bl-hue: 206;/);
    assert.match(css, /\.bl-app\[data-bl-context="teachers"\] \{\s*--bl-hue: 262;/);
    assert.doesNotMatch(read("src/components/teachers/teachers.module.css"), /#[0-9a-f]{6}.*(blue|accent|button)|t-blue/i);
    assert.ok(read("src/components/teachers/TeacherShell.tsx").includes('src="/flower-teachers.png"'));
  });
});
