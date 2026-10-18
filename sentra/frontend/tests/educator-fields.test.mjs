import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { DEMO_PARTICIPANT_ID, demoCohortRoster, demoStudentOverview } from "../src/lib/blesc/demoApi.ts";
import {
  byNewestObservation,
  compareByClassAndNumber,
  hasShowableObservation,
  studentIdentity,
} from "../src/lib/educatorIdentity.ts";
import { t } from "../src/lib/i18n/index.ts";

/**
 * What an educator is shown about a student is exactly what blesc.jp promises
 * (#466):
 *
 *   「先生に表示されるのは、クラス、出席番号、観測された表現の種類、時刻だけです。」
 *
 * and the site's educator mock adds the input source (ジャーナル／チャット／音声)
 * and the evidence line 「根拠: 記述との一致 / 推論なし」, newest first.
 *
 * Until #466 the product showed the student's name and 「繰り返し見られる話題」
 * counted from their diary. These tests hold the fix at every layer it was
 * made in — the database function, the API type, the client reads, the demo,
 * and the screens — because `educator_display_policy.md` records twice what
 * happens to a rule enforced in one of two places.
 *
 * Like `educator-display-policy.test.mjs`, the source checks match names, not
 * meaning. A name smuggled back under another field name would pass; that is
 * what the exact-key assertions on the type and the demo payload are for.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const read = (path) => readFileSync(resolve(ROOT, path), "utf8");

/** Comments removed — every removal in #466 left a comment naming what went. */
function code(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

/** Field names of an `export interface X { ... }` in models.ts. */
function interfaceFields(source, name) {
  const start = source.indexOf(`export interface ${name} {`);
  assert.notEqual(start, -1, `${name} not found in models.ts`);
  let depth = 0;
  let end = start;
  for (let i = source.indexOf("{", start); i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    if (source[i] === "}") depth -= 1;
    if (depth === 0) { end = i; break; }
  }
  const body = code(source.slice(source.indexOf("{", start) + 1, end));
  return [...body.matchAll(/^\s*([a-z_]+)\??:/gm)].map((match) => match[1]).sort();
}

function methodBody(source, name) {
  const start = source.indexOf(`static async ${name}(`);
  assert.notEqual(start, -1, `${name} not found in client.ts`);
  const next = source.indexOf("\n  static ", start + 10);
  return code(source.slice(start, next === -1 ? undefined : next));
}

/** Keys that route, log or key alerts. Never rendered on an educator screen. */
const INTERNAL_KEYS = ["code", "org_id", "owner_user_id", "participant_id"];
/** The promised fields: class, number, and the observation (kind, time, source). */
const PROMISED_KEYS = [
  "attendance_number",
  "class_label",
  "safety_at",
  "safety_level",
  "safety_reasons",
  "safety_surface",
];
/** Feeds the suppressed 7-day count on the overview only; see models.ts. */
const AGGREGATE_KEYS = ["last_active_day"];

const STUDENT_KEYS = [...INTERNAL_KEYS, ...PROMISED_KEYS, ...AGGREGATE_KEYS].sort();

/** Things #466 took away from the educator, by every name they went by. */
const REMOVED = ["display_name", "themes", "recurringThemes", "signals", "baseline_is_provisional", "baseline_type", "baseline_days_remaining"];

describe("the educator payload (#466)", () => {
  const models = read("src/api/models.ts");

  it("EducatorStudentStatus carries exactly the agreed keys and no name", () => {
    assert.deepEqual(interfaceFields(models, "EducatorStudentStatus"), STUDENT_KEYS);
  });

  it("the student overview is the roster row and observations, nothing else", () => {
    assert.deepEqual(interfaceFields(models, "EducatorStudentOverview"), ["observations", "student"]);
    assert.deepEqual(interfaceFields(models, "EducatorObservation"), ["level", "occurred_at", "reasons", "surface"]);
  });

  it("the client reads neither the name nor the diary-derived themes", () => {
    const client = read("src/api/client.ts");
    const roster = methodBody(client, "getCohortRoster");
    const overview = methodBody(client, "getStudentOverviewForEducator");
    for (const body of [roster, overview]) {
      for (const removed of REMOVED) assert.ok(!body.includes(removed), `${removed} is read again`);
    }
    // Themes were counted from the diary graph; the overview no longer reads it.
    assert.ok(!overview.includes("graph_summary_json"), "the overview reads the diary graph again");
    assert.ok(!overview.includes('"insights"'), "the overview reads insights again");
    assert.ok(!code(client).includes("educatorThemes"), "the theme counter is imported again");
  });

  it("the roster function in the database no longer returns display_name", () => {
    // The latest migration that defines it is the one in force.
    const dir = resolve(ROOT, "../supabase/migrations");
    const defining = readdirSync(dir)
      .filter((name) => name.endsWith(".sql"))
      .sort()
      .filter((name) => /create (or replace )?function public\.overseen_participants\(\)/.test(readFileSync(join(dir, name), "utf8")));
    assert.ok(defining.length > 0);
    const latest = readFileSync(join(dir, defining.at(-1)), "utf8");
    const definition = latest.slice(latest.search(/create (or replace )?function public\.overseen_participants\(\)/));
    const returns = definition.slice(0, definition.indexOf("language sql"));
    assert.doesNotMatch(returns, /display_name/);
    assert.match(returns, /class_label text/);
    assert.match(returns, /attendance_number integer/);
  });

  it("the demo returns the same shape, with no name and no themes", () => {
    const roster = demoCohortRoster();
    assert.ok(roster.length > 3);
    for (const student of roster) {
      assert.deepEqual(Object.keys(student).sort(), STUDENT_KEYS, `${student.participant_id} has other keys`);
      assert.equal(typeof student.class_label, "string");
      assert.equal(typeof student.attendance_number, "number");
    }
    const overview = demoStudentOverview(DEMO_PARTICIPANT_ID);
    assert.ok(overview);
    assert.deepEqual(Object.keys(overview).sort(), ["observations", "student"]);
  });

  it("the demo never gives two students the same class and number", () => {
    const labels = demoCohortRoster().map((student) => studentIdentity(student));
    assert.equal(new Set(labels).size, labels.length);
  });
});

describe("what the screens read (#466)", () => {
  const SCREENS = [
    "src/app/educator/page.tsx",
    "src/app/educator/roster/page.tsx",
    "src/app/educator/student/[participantId]/page.tsx",
    "src/components/educator/StatusChips.tsx",
  ];

  it("reads only the promised fields of a student (plus the link target)", () => {
    const allowed = new Set([...PROMISED_KEYS, "participant_id"]);
    const offences = [];
    for (const path of SCREENS) {
      const source = code(read(path));
      for (const match of source.matchAll(/(?<![.\w])(?:student|selectedStudent|a|b)\.([A-Za-z_]+)/g)) {
        const field = match[1];
        if (allowed.has(field)) continue;
        // The overview's 7-day count, which is suppressed for small cohorts.
        if (path === "src/app/educator/page.tsx" && AGGREGATE_KEYS.includes(field)) continue;
        offences.push(`${path}: student.${field}`);
      }
    }
    assert.deepEqual(offences, [], `an educator screen reads a field outside the promise:\n${offences.join("\n")}`);
  });

  it("renders no name, code, themes or days written", () => {
    const offences = [];
    for (const path of SCREENS) {
      const source = code(read(path));
      for (const removed of [...REMOVED, ".code", "lastEntry", "noThemes", "themesNote", "recentSignals"]) {
        if (source.includes(removed)) offences.push(`${path}: ${removed}`);
      }
    }
    assert.deepEqual(offences, [], offences.join("\n"));
  });

  it("states the evidence in the words the site uses", () => {
    assert.equal(t.safety.observationBasis, "└ 根拠: 記述との一致 / 推論なし");
    assert.equal(t.safety.surface.journal, "ジャーナル");
    assert.equal(t.safety.surface.chat, "チャット");
    assert.equal(t.safety.surface.voice, "音声");
  });

  it("has no copy left for the removed sections", () => {
    const student = t.educator.student;
    for (const key of ["recurringThemes", "noThemes", "themesNote", "recentSignals"]) {
      assert.ok(!(key in student), `t.educator.student.${key} is back`);
    }
    assert.ok(!("baseline" in t.educator), "the baseline copy is back");
  });
});

describe("naming a student without their name (#466)", () => {
  const base = { participant_id: "p", class_label: null, attendance_number: null };

  it("shows class and number", () => {
    assert.equal(studentIdentity({ ...base, class_label: "2-3", attendance_number: 12 }), "2-3 12番");
  });

  it("shows a neutral placeholder when the school has not set them", () => {
    assert.equal(studentIdentity(base), "クラス未設定");
    assert.equal(studentIdentity({ ...base, class_label: "  " }), "クラス未設定");
    assert.equal(studentIdentity({ ...base, class_label: "2-3" }), "2-3 出席番号未設定");
    assert.equal(studentIdentity({ ...base, attendance_number: 5 }), "クラス未設定 5番");
  });

  it("never falls back to the name or the code", () => {
    const withName = { ...base, display_name: "山田 太郎", code: "research_user_01" };
    const shown = studentIdentity(withName);
    assert.ok(!shown.includes("山田"));
    assert.ok(!shown.includes("research_user_01"));
  });
});

describe("ordering (#466)", () => {
  function row(id, overrides = {}) {
    return {
      participant_id: id,
      org_id: "o",
      owner_user_id: `u-${id}`,
      code: id,
      class_label: "2-3",
      attendance_number: 1,
      last_active_day: null,
      safety_level: null,
      safety_at: null,
      safety_reasons: [],
      safety_surface: null,
      ...overrides,
    };
  }
  const observed = (at, level = "elevated") => ({
    safety_level: level,
    safety_at: at,
    safety_reasons: ["distress_without_explicit_danger"],
    safety_surface: "journal",
  });

  it("puts the newest observation first, then everyone else by class and number", () => {
    const students = [
      row("quiet-b", { class_label: "2-3", attendance_number: 9 }),
      row("old", { ...observed("2026-10-10T08:00:00Z", "crisis"), attendance_number: 30 }),
      row("unset", { class_label: null, attendance_number: null }),
      row("new", { ...observed("2026-10-17T21:00:00Z"), attendance_number: 2 }),
      row("quiet-a", { class_label: "2-1", attendance_number: 4 }),
      row("quiet-c", { class_label: "2-10", attendance_number: 1 }),
    ];
    const order = [...students].sort(byNewestObservation).map((student) => student.participant_id);
    assert.deepEqual(order, ["new", "old", "quiet-a", "quiet-b", "quiet-c", "unset"]);
  });

  it("does not let an observation without reasons jump the queue", () => {
    const unexplained = row("unexplained", { ...observed("2026-10-18T00:00:00Z"), safety_reasons: [] });
    assert.equal(hasShowableObservation(unexplained), false);
    const order = [unexplained, row("explained", observed("2026-10-01T00:00:00Z"))].sort(byNewestObservation);
    assert.equal(order[0].participant_id, "explained");
  });

  it("orders class labels numerically, not as text", () => {
    assert.ok(compareByClassAndNumber(row("a", { class_label: "2-2" }), row("b", { class_label: "2-10" })) < 0);
  });

  it("orders the student screen's observations newest first", () => {
    const overview = demoStudentOverview(DEMO_PARTICIPANT_ID);
    const times = overview.observations.map((observation) => observation.occurred_at);
    assert.deepEqual(times, [...times].sort().reverse());
    for (const observation of overview.observations) {
      assert.ok(observation.reasons.length > 0);
      assert.ok(["journal", "chat", "voice"].includes(observation.surface));
    }
  });
});
