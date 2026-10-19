/**
 * The frontend half of the Japanese safety-corpus measurement.
 *
 * `sentra/shared/safety_corpus/corpus.json` is a synthetic corpus of crisis
 * expressions in the spellings a student actually types (kana, katakana,
 * half-width, masking, slang, euphemism) and of harmless sentences the lexicon
 * can hit (negation, quotation, hyperbole). This suite runs `assessSafety` over
 * it and compares the result with `baseline.json`.
 *
 * It is built so that it cannot be what stops the lexicon fix (#388) from
 * merging:
 *
 *   - Items missed today are known gaps in the baseline, each with the issue
 *     that tracks it. A known gap that starts being caught produces a
 *     diagnostic naming the entries to delete. It never fails.
 *   - The suite fails only when something gets worse: an item caught at the
 *     baseline is no longer caught, an expected-crisis item loses its `crisis`
 *     grade (and with it `escalation_required`), or a harmless item becomes —
 *     or becomes more of — a false positive.
 *
 * The comparison rules are the same as `app/evaluation/safety_corpus.py` on the
 * backend; the two read one baseline file, so they must agree on what it means.
 *
 * Expected verdicts are a model's draft (`reviewed: false` on every item). The
 * rates printed here are agreement with that draft, not coverage.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { assessSafety } from "../src/lib/safety-assessment.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const CORPUS_DIR = resolve(HERE, "../../shared/safety_corpus");
const CORPUS = JSON.parse(readFileSync(resolve(CORPUS_DIR, "corpus.json"), "utf8"));
const BASELINE = JSON.parse(readFileSync(resolve(CORPUS_DIR, "baseline.json"), "utf8"));
const DETECTOR = "frontend.assessSafety";
const ENTRY = BASELINE.detectors[DETECTOR];

const VERDICTS = ["none", "caution", "crisis"];
const POSITIVE = new Set(["caution", "crisis"]);
/** `low` is distress with no danger signal; it drives no intervention. */
const RISK_TO_VERDICT = { none: "none", low: "none", elevated: "caution", crisis: "crisis" };
// #290: 「今日」 stopped being an imminence term (option A), which deliberately
// moved kc-010 「今日、あいつを殺してやりたいと思った。」 from crisis to caution.
const TRACKING_REFS = new Set(["#388", "#392", "#374", "#290", "unfiled"]);

const isFlagged = (verdict) => verdict !== "none";
const level = (verdict) => VERDICTS.indexOf(verdict);

function observe(run) {
  return Object.fromEntries(CORPUS.items.map((item) => [item.id, run(item.text)]));
}

const runAssessSafety = (text) => RISK_TO_VERDICT[assessSafety(text).risk_level];

/** Every difference from the baseline, sorted into failures and notices. */
function compare(observations, entry) {
  const gaps = entry.known_gaps ?? {};
  const under = entry.known_under_graded ?? {};
  const falsePositives = entry.known_false_positives ?? {};
  const drift = {
    regressions: [], lost_crisis_grade: [], new_false_positives: [], escalated_false_positives: [],
    closed_gaps: [], regained_crisis_grade: [], cleared_false_positives: [],
  };
  for (const item of CORPUS.items) {
    const verdict = observations[item.id];
    if (POSITIVE.has(item.expected)) {
      if (!isFlagged(verdict)) {
        if (!(item.id in gaps)) drift.regressions.push(item.id);
        continue;
      }
      if (item.id in gaps) drift.closed_gaps.push(item.id);
      if (item.expected === "crisis") {
        if (verdict === "crisis" && item.id in under) drift.regained_crisis_grade.push(item.id);
        else if (verdict !== "crisis" && !(item.id in under) && !(item.id in gaps)) drift.lost_crisis_grade.push(item.id);
      }
    } else {
      const recorded = falsePositives[item.id];
      if (isFlagged(verdict)) {
        if (!recorded) drift.new_false_positives.push(item.id);
        else if (level(verdict) > level(recorded.observed)) drift.escalated_false_positives.push(item.id);
      } else if (recorded) {
        drift.cleared_false_positives.push(item.id);
      }
    }
  }
  const pick = (keys) => Object.fromEntries(keys.filter((key) => drift[key].length).map((key) => [key, drift[key]]));
  return {
    ...drift,
    failures: pick(["regressions", "lost_crisis_grade", "new_false_positives", "escalated_false_positives"]),
    notices: pick(["closed_gaps", "regained_crisis_grade", "cleared_false_positives"]),
  };
}

/** The entry with every notice applied — only ever removing or lowering. */
function prunedEntry(entry, drift, observations) {
  const expected = Object.fromEntries(CORPUS.items.map((item) => [item.id, item.expected]));
  const without = (record, ids) => Object.fromEntries(Object.entries(record ?? {}).filter(([id]) => !ids.includes(id)));
  const under = without(entry.known_under_graded, drift.regained_crisis_grade);
  for (const id of drift.closed_gaps) {
    if (expected[id] === "crisis" && observations[id] !== "crisis") {
      under[id] = { issue: entry.known_gaps[id].issue, observed: observations[id] };
    }
  }
  // Corpus order, the order baseline.json is written in.
  const position = Object.fromEntries(CORPUS.items.map((item, index) => [item.id, index]));
  const sorted = (record) => Object.fromEntries(Object.entries(record).sort(([a], [b]) => position[a] - position[b]));
  return {
    ...entry,
    known_gaps: sorted(without(entry.known_gaps, drift.closed_gaps)),
    known_under_graded: sorted(under),
    known_false_positives: sorted(without(entry.known_false_positives, drift.cleared_false_positives)),
  };
}

const rate = (numerator, denominator) => (denominator ? numerator / denominator : null);
const pct = (value) => (value === null ? "—" : `${Math.round(value * 100)}%`);

function summarize(observations) {
  const blank = () => ({ positives: 0, detected: 0, crisisExpected: 0, crisisGraded: 0, negatives: 0, falsePositives: 0 });
  const rows = Object.fromEntries([...Object.keys(CORPUS.categories), "合計"].map((key) => [key, blank()]));
  for (const item of CORPUS.items) {
    const verdict = observations[item.id];
    for (const row of [rows[item.category], rows["合計"]]) {
      if (POSITIVE.has(item.expected)) {
        row.positives += 1;
        row.detected += isFlagged(verdict) ? 1 : 0;
        if (item.expected === "crisis") {
          row.crisisExpected += 1;
          row.crisisGraded += verdict === "crisis" ? 1 : 0;
        }
      } else {
        row.negatives += 1;
        row.falsePositives += isFlagged(verdict) ? 1 : 0;
      }
    }
  }
  return rows;
}

function formatTable(rows) {
  const lines = [
    "| 区分 | 陽性 | 検知 | 検知率 | 危機の期待 | 危機と判定 | 陰性 | 偽陽性 | 偽陽性率 |",
    "| :-- | --: | --: | --: | --: | --: | --: | --: | --: |",
  ];
  for (const [key, row] of Object.entries(rows)) {
    const label = key === "合計" ? key : `${key}（${CORPUS.categories[key].split(/[（。]/)[0]}）`;
    lines.push(
      `| ${label} | ${row.positives} | ${row.detected} | ${pct(rate(row.detected, row.positives))} ` +
        `| ${row.crisisExpected} | ${row.crisisGraded} ` +
        `| ${row.negatives} | ${row.falsePositives} | ${pct(rate(row.falsePositives, row.negatives))} |`,
    );
  }
  return lines.join("\n");
}

/** Observations exactly consistent with the baseline entry. */
function baselineObservations(entry) {
  return Object.fromEntries(
    CORPUS.items.map((item) => {
      if (item.id in entry.known_gaps) return [item.id, "none"];
      if (item.id in (entry.known_under_graded ?? {})) return [item.id, entry.known_under_graded[item.id].observed];
      if (item.id in entry.known_false_positives) return [item.id, entry.known_false_positives[item.id].observed];
      return [item.id, POSITIVE.has(item.expected) ? item.expected : "none"];
    }),
  );
}

describe("safety corpus — the baseline entry for assessSafety", () => {
  it("points at real items of the right kind, each with where it is tracked", () => {
    const items = Object.fromEntries(CORPUS.items.map((item) => [item.id, item]));
    for (const [key, allowed] of [
      ["known_gaps", POSITIVE],
      ["known_under_graded", new Set(["crisis"])],
      ["known_false_positives", new Set(["none"])],
    ]) {
      for (const [id, record] of Object.entries(ENTRY[key])) {
        assert.ok(items[id], `${key}: ${id} is not in the corpus`);
        assert.ok(allowed.has(items[id].expected), `${key}: ${id} is expected ${items[id].expected}`);
        assert.ok(TRACKING_REFS.has(record.issue), `${key}: ${id} has issue ${record.issue}`);
      }
    }
    assert.ok(Object.values(ENTRY.known_gaps).some((record) => record.issue === "#388"));
  });

  it("is a fixed point of its own comparison", () => {
    const drift = compare(baselineObservations(ENTRY), ENTRY);
    assert.deepEqual(drift.failures, {});
    assert.deepEqual(drift.notices, {});
  });
});

describe("safety corpus — assessSafety against the baseline", () => {
  const observations = observe(runAssessSafety);
  const drift = compare(observations, ENTRY);

  it("prints today's per-category rates", (t) => {
    // Diagnostics, so the table is in every CI log without being a gate.
    for (const line of formatTable(summarize(observations)).split("\n")) t.diagnostic(line);
    t.diagnostic("Expected verdicts are an unreviewed model draft (reviewed: false): agreement, not coverage.");
  });

  it("reports improvements without failing", (t) => {
    if (Object.keys(drift.notices).length === 0) return;
    t.diagnostic(`NOTICE ${DETECTOR} improved: ${JSON.stringify(drift.notices)}. Nothing failed.`);
    t.diagnostic(
      `Update detectors["${DETECTOR}"] in sentra/shared/safety_corpus/baseline.json to: ` +
        JSON.stringify(prunedEntry(ENTRY, drift, observations)),
    );
  });

  it("has not got worse: no lost detection, no lost crisis grade, no new or escalated false positive", () => {
    assert.deepEqual(
      drift.failures,
      {},
      `${DETECTOR} got worse against the safety corpus. If the change is deliberate, record it by hand ` +
        `in baseline.json in the same pull request, with the reason.\n${formatTable(summarize(observations))}`,
    );
  });
});

describe("safety corpus — why a lexicon fix cannot turn this red", () => {
  it("closing every known gap and clearing every false positive is a notice, not a failure", () => {
    const fixed = Object.fromEntries(CORPUS.items.map((item) => [item.id, POSITIVE.has(item.expected) ? item.expected : "none"]));
    const drift = compare(fixed, ENTRY);
    assert.deepEqual(drift.failures, {});
    assert.deepEqual(new Set(drift.closed_gaps), new Set(Object.keys(ENTRY.known_gaps)));
    assert.deepEqual(new Set(drift.cleared_false_positives), new Set(Object.keys(ENTRY.known_false_positives)));
  });

  it("a gap closed below crisis moves to under-graded, and losing it later fails", () => {
    const items = Object.fromEntries(CORPUS.items.map((item) => [item.id, item]));
    const gap = Object.keys(ENTRY.known_gaps).find((id) => items[id].expected === "crisis");
    const observations = baselineObservations(ENTRY);
    observations[gap] = "caution";
    const drift = compare(observations, ENTRY);
    assert.deepEqual(drift.failures, {});
    assert.deepEqual(drift.closed_gaps, [gap]);
    const pruned = prunedEntry(ENTRY, drift, observations);
    assert.ok(!(gap in pruned.known_gaps));
    assert.deepEqual(pruned.known_under_graded[gap], { issue: ENTRY.known_gaps[gap].issue, observed: "caution" });
    observations[gap] = "none";
    assert.deepEqual(compare(observations, pruned).regressions, [gap]);
  });

  it("losing a detection, a crisis grade, or adding a false positive each fails", () => {
    const items = Object.fromEntries(CORPUS.items.map((item) => [item.id, item]));
    const base = baselineObservations(ENTRY);
    const crisis = Object.keys(base).find((id) => base[id] === "crisis" && items[id].expected === "crisis");
    const clean = CORPUS.items.find((item) => item.expected === "none" && base[item.id] === "none").id;
    const mild = Object.keys(ENTRY.known_false_positives).find((id) => ENTRY.known_false_positives[id].observed === "caution");

    assert.deepEqual(compare({ ...base, [crisis]: "none" }, ENTRY).failures, { regressions: [crisis] });
    assert.deepEqual(compare({ ...base, [crisis]: "caution" }, ENTRY).failures, { lost_crisis_grade: [crisis] });
    assert.deepEqual(compare({ ...base, [clean]: "caution" }, ENTRY).failures, { new_false_positives: [clean] });
    assert.deepEqual(compare({ ...base, [mild]: "crisis" }, ENTRY).failures, { escalated_false_positives: [mild] });
  });
});
