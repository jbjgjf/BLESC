import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  MIN_BASELINE_DAYS,
  MIN_STD,
  PERSIST_ANOMALY_SCORE,
  RAMP_UP_DAYS,
  aggregateDailyFeatures,
  baselineProvenance,
  checkRules,
  combineHybridScore,
  computeZScores,
  degenerateFeatures,
  estimateBaseline,
  evaluateBaseline,
  getEffectiveBaseline,
  protectiveDecline,
  scoreBaselineDeviation,
  topFeatures,
} from "../src/lib/baseline.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTRACT = JSON.parse(
  readFileSync(resolve(HERE, "../../shared/baseline_conformance.json"), "utf8"),
);

/** Python's round() is banker's; JavaScript's is not. Only an exact half at the
 *  fourth decimal separates them, and the difference carries no meaning. */
const TOLERANCE = 1e-9;

function assertClose(actual, expected, what) {
  assert.ok(
    Math.abs(actual - expected) < TOLERANCE,
    `${what}: expected ${expected}, got ${actual} (delta ${Math.abs(actual - expected)})`,
  );
}

describe("baseline — shared contract", () => {
  it("the fixture file is the one both implementations use", () => {
    assert.equal(CONTRACT.contract, "baseline");
    assert.ok(CONTRACT.cases.length >= 10);
    assert.equal(CONTRACT.ramp_up_days, RAMP_UP_DAYS);
    assert.equal(CONTRACT.min_baseline_days, MIN_BASELINE_DAYS);
  });

  for (const testCase of CONTRACT.cases) {
    it(`${testCase.name}: ${testCase.why.split(".")[0]}`, () => {
      const outcome = evaluateBaseline(testCase.today, testCase.history);
      const expected = testCase.expected;

      assert.equal(outcome.status, expected.status);
      assert.equal(outcome.observedDays, expected.observed_days);
      assert.deepEqual(outcome.provenance, expected.baseline_provenance);

      for (const [feature, value] of Object.entries(expected.feature_vector)) {
        assertClose(outcome.featureVector[feature], value, `feature_vector.${feature}`);
      }

      if (expected.status === "not_enough_data") {
        assert.equal(outcome.requiredDays, expected.required_days);
        assert.ok(!("zScores" in outcome), "a refusal must carry no z-scores");
        return;
      }

      assert.equal(outcome.baselineType, expected.baseline_type);
      assert.deepEqual(
        Object.keys(outcome.zScores).sort(),
        Object.keys(expected.z_scores).sort(),
        "the two implementations must produce z-scores for the same feature set",
      );
      for (const [feature, value] of Object.entries(expected.z_scores)) {
        assertClose(outcome.zScores[feature], value, `z_scores.${feature}`);
      }
      assertClose(outcome.deviationScore, expected.deviation_score, "deviation_score");
    });
  }
});

describe("baseline — the cold start is a refusal, not a zero", () => {
  const contractCase = (name) => CONTRACT.cases.find((testCase) => testCase.name === name);

  it("produces nothing at all on a student's first day", () => {
    const outcome = evaluateBaseline(contractCase("cold_start_day_one").today, []);
    assert.equal(outcome.status, "not_enough_data");
    assert.equal(outcome.provenance.days_remaining, RAMP_UP_DAYS);
    assert.ok(outcome.provenance.is_provisional);
  });

  it("still refuses one day short of the ramp", () => {
    // The boundary is the entire decision. An off-by-one here would ship a
    // reading built on thirteen days while claiming the fourteen-day contract.
    const day = contractCase("cold_start_day_one").today;
    const thirteen = Array.from({ length: RAMP_UP_DAYS - 1 }, () => day);
    assert.equal(evaluateBaseline(day, thirteen).status, "not_enough_data");
    assert.equal(evaluateBaseline(day, [...thirteen, day]).status, "ok");
  });

  it("flips is_provisional exactly when the baseline becomes the student's own", () => {
    assert.ok(baselineProvenance("none", 13).is_provisional);
    assert.equal(baselineProvenance("user", 14).is_provisional, false);
    assert.equal(baselineProvenance("user", 14).days_remaining, 0);
    // Past the ramp the counter does not go negative and read as a countdown.
    assert.equal(baselineProvenance("user", 90).days_remaining, 0);
  });

  it("never invents statistics to fill the ramp", () => {
    // #91: the population baseline was deleted rather than measured. If a
    // future change reintroduces a fallback, this goes red.
    for (let days = 0; days < RAMP_UP_DAYS; days += 1) {
      const history = Array.from({ length: days }, () => contractCase("cold_start_day_one").today);
      const outcome = evaluateBaseline(contractCase("cold_start_day_one").today, history);
      assert.equal(outcome.status, "not_enough_data", `${days} days must not produce a reading`);
      assert.equal(outcome.baselineType, "none");
    }
    assert.equal(getEffectiveBaseline([]).stats, null);
  });
});

describe("baseline — properties the production formula violated", () => {
  const quiet = { nodes: [{ id: "worry", category: "State", label: "worry", intensity: 0.3, confidence: 0.8 }], relations: [] };
  const fortnight = Array.from({ length: 14 }, (_, index) => [{
    nodes: [
      { id: "worry", category: "State", label: "worry", intensity: 0.3, confidence: 0.8 },
      ...(index % 2 === 0 ? [{ id: "tired", category: "State", label: "tired", intensity: 0.3, confidence: 0.8 }] : []),
    ],
    relations: [],
  }]);

  it("an unchanged day scores zero deviation, not a positive constant", () => {
    // The whole defect in one assertion. The route handler returned
    // `1 + triggers*0.8 - protective*0.25 + relations*0.05`, whose floor is 1.0
    // — so a day identical to every other day still read as a signal.
    const outcome = evaluateBaseline([quiet], Array.from({ length: 14 }, () => [quiet]));
    assert.equal(outcome.status, "ok");
    assert.equal(outcome.deviationScore, 0);
  });

  it("the same day scores differently against different histories", () => {
    // The property the old formula could not have: identical input, different
    // student, different reading. Without it there is no baseline in any sense.
    const spike = [{
      nodes: [
        { id: "panic", category: "State", label: "panic", intensity: 0.9, confidence: 0.8 },
        { id: "exam", category: "Trigger", label: "exam", intensity: 0.9, confidence: 0.8 },
      ],
      relations: [],
    }];
    const calm = evaluateBaseline(spike, fortnight);
    const alreadyTense = evaluateBaseline(spike, Array.from({ length: 14 }, () => spike));
    assert.equal(calm.status, "ok");
    assert.equal(alreadyTense.status, "ok");
    assert.notEqual(calm.deviationScore, alreadyTense.deviationScore);
    assert.equal(alreadyTense.deviationScore, 0, "a student's own normal is not an anomaly");
  });

  it("clamps at zero rather than reporting a negative signal", () => {
    // protective_ratio carries the only negative weight. A day with more
    // protective structure than usual must not produce a below-zero reading.
    assert.equal(scoreBaselineDeviation({ protective_ratio: 4 }), 0);
    assert.ok(scoreBaselineDeviation({ protective_ratio: -4 }) > 0);
  });

  it("is deterministic", () => {
    const a = evaluateBaseline([quiet], fortnight);
    const b = evaluateBaseline([quiet], fortnight);
    assert.deepEqual(a, b);
  });

  it("does not crash on malformed input", () => {
    const outcome = evaluateBaseline([{ nodes: [{}], relations: [{}] }], []);
    assert.equal(outcome.status, "not_enough_data");
    assert.ok(Number.isFinite(outcome.featureVector.state_count));
  });
});

describe("baseline — the arithmetic", () => {
  it("uses the population standard deviation, floored", () => {
    // np.std with ddof=0: for [1,2,3] that is 0.8164…, not the sample 1.0.
    const stats = estimateBaseline([{ x: 1 }, { x: 2 }, { x: 3 }]);
    assertClose(stats.x.mean, 2, "mean");
    assertClose(stats.x.std, Math.sqrt(2 / 3), "population std");
  });

  it("floors a motionless feature rather than dividing by zero", () => {
    const stats = estimateBaseline([{ x: 5 }, { x: 5 }, { x: 5 }]);
    assert.equal(stats.x.std, MIN_STD);
    assert.ok(Number.isFinite(computeZScores({ x: 6 }, stats).x));
  });

  it("takes its feature keys from the first day only", () => {
    // Faithful to the backend's `set(features_list[0].keys())`. Diverging here
    // would change which z-scores exist and put the two stores back out of
    // agreement, which is the failure this contract exists to prevent.
    const stats = estimateBaseline([{ x: 1 }, { x: 2, y: 9 }]);
    assert.deepEqual(Object.keys(stats), ["x"]);
  });

  it("counts categories independently of script", () => {
    const english = aggregateDailyFeatures([{
      nodes: [{ id: "worry", category: "State", label: "worry", intensity: 0.4, confidence: 0.8 }],
      relations: [],
    }]);
    const japanese = aggregateDailyFeatures([{
      nodes: [{ id: "眠れない", category: "State", label: "眠れない", intensity: 0.4, confidence: 0.8 }],
      relations: [],
    }]);
    assert.deepEqual(english, japanese);
  });

  it("sums across every graph recorded on the same day", () => {
    const one = { nodes: [{ id: "a", category: "State", label: "a", intensity: 0.5, confidence: 0.8 }], relations: [] };
    assert.equal(aggregateDailyFeatures([one, one]).state_count, 2);
  });

  it("ranks top features by absolute z, so a collapse ranks with a spike", () => {
    assert.deepEqual(topFeatures({ a: -9, b: 0.1, c: 4, d: -0.2, e: 0 }), ["a", "c", "d", "b"]);
  });
});

describe("baseline — features that cannot vary", () => {
  it("reports event_avg_duration as degenerate on the production path", () => {
    // The production extraction schema never asks the model for a node
    // duration, so this feature is zero on every day while carrying weight
    // 0.08. #85 was a benchmark column that could not vary being reported as a
    // measurement; this is the same shape and is labelled rather than hidden.
    const day = [{
      nodes: [{ id: "walk", category: "Event", label: "walk", intensity: 0.5, confidence: 0.8 }],
      relations: [],
    }];
    const outcome = evaluateBaseline(day, Array.from({ length: 14 }, () => day));
    assert.equal(outcome.status, "ok");
    assert.equal(outcome.featureVector.event_avg_duration, 0);
    assert.ok(outcome.degenerate.includes("event_avg_duration"));
  });

  it("uses a duration when one is present, so the backend path is unaffected", () => {
    const vector = aggregateDailyFeatures([{
      nodes: [{ id: "walk", category: "Event", label: "walk", intensity: 0.5, confidence: 0.8, duration: 30 }],
      relations: [],
    }]);
    assert.equal(vector.event_avg_duration, 30);
  });

  it("lists every motionless feature, not only the known one", () => {
    assert.deepEqual(degenerateFeatures([{ a: 1, b: 2 }, { a: 1, b: 3 }]), ["a"]);
    assert.deepEqual(degenerateFeatures([]), []);
  });
});

describe("rule engine", () => {
  const noDecline = { drop_in_protective_nodes: 0, current_protective_nodes: 2, previous_protective_nodes: 2 };
  const noDiff = { added_nodes: [], removed_nodes: [], added_relations: [], removed_relations: [], changed_relations: [] };

  it("fires nothing on an ordinary day", () => {
    const hits = checkRules({ protective_ratio: 0.5, isolation_signal: 0 }, {}, { event_count: 0 }, noDiff, noDecline);
    assert.deepEqual(hits, []);
  });

  it("fires on isolation from either the z-score or the raw feature", () => {
    const byZ = checkRules({ protective_ratio: 0.5 }, { isolation_signal: 2.0 }, { event_count: 0 }, noDiff, noDecline);
    const byRaw = checkRules({ protective_ratio: 0.5, isolation_signal: 0.9 }, {}, { event_count: 0 }, noDiff, noDecline);
    assert.equal(byZ[0].rule, "isolation_spike");
    assert.equal(byRaw[0].rule, "isolation_spike");
  });

  it("fires protective_decline on a drop even when the ratio is healthy", () => {
    const decline = { drop_in_protective_nodes: 2, current_protective_nodes: 1, previous_protective_nodes: 3 };
    const hits = checkRules({ protective_ratio: 0.9 }, {}, { event_count: 0 }, noDiff, decline);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].rule, "protective_decline");
  });

  it("requires event nodes before reporting a sequencing shift", () => {
    const zScores = { event_transition_signal: 3 };
    assert.deepEqual(checkRules({ protective_ratio: 0.5 }, zScores, { event_count: 0 }, noDiff, noDecline), []);
    assert.equal(
      checkRules({ protective_ratio: 0.5 }, zScores, { event_count: 2 }, noDiff, noDecline)[0].rule,
      "event_sequence_shift",
    );
  });

  it("caps the relation_reweighting weight", () => {
    const many = { ...noDiff, changed_relations: Array.from({ length: 40 }, (_, i) => i) };
    const hit = checkRules({ protective_ratio: 0.5 }, {}, { event_count: 0 }, many, noDecline)[0];
    assert.equal(hit.weight, 0.35);
  });

  it("gives every hit a traceable evidence string", () => {
    // Rule 2 of the display policy: an observation with no reasons is not shown
    // at all. A hit with an empty evidence string would be exactly that.
    const all = checkRules(
      { protective_ratio: 0.1, isolation_signal: 0.9 },
      { state_count: 2, event_transition_signal: 2 },
      { event_count: 3 },
      { ...noDiff, changed_relations: [1] },
      { drop_in_protective_nodes: 1, current_protective_nodes: 0, previous_protective_nodes: 1 },
    );
    assert.equal(all.length, 5, "every rule fires on this input");
    for (const hit of all) assert.ok(hit.evidence.length > 20, `${hit.rule} carries no evidence`);
  });

  it("computes protective decline only against a real previous day", () => {
    const withProtective = { nodes: [{ id: "p", category: "Protective", label: "p", intensity: 0.5, confidence: 0.8 }], relations: [] };
    const without = { nodes: [], relations: [] };
    assert.equal(protectiveDecline(without, withProtective, true).drop_in_protective_nodes, 1);
    // A first entry has nothing to have declined from.
    assert.equal(protectiveDecline(without, withProtective, false).drop_in_protective_nodes, 0);
    // Gaining protective structure is not a decline.
    assert.equal(protectiveDecline(withProtective, without, true).drop_in_protective_nodes, 0);
  });
});

describe("score composition", () => {
  it("caps the final score at ten", () => {
    const hits = Array.from({ length: 20 }, () => ({ rule: "r", evidence: "e", weight: 1, signal: {} }));
    assert.equal(combineHybridScore(hits, 50, 3).final_score, 10);
  });

  it("weights the three components as the backend does", () => {
    const hits = [{ rule: "r", evidence: "e", weight: 0.5, signal: {} }];
    const breakdown = combineHybridScore(hits, 1, 2);
    assert.equal(breakdown.rule_score, 0.5);
    assertClose(breakdown.final_score, 0.5 * 2 + 1 * 1.15 + 2 * 0.85, "final_score");
  });

  it("is not persisted to insights.anomaly_score", () => {
    // docs/educator_display_policy.md, decided 2026-08-06: new writes of a risk
    // classification attached to an identifiable minor stopped. The backend
    // honoured it that day; the production path went on writing its own score
    // because it never ran this code.
    assert.equal(PERSIST_ANOMALY_SCORE, false);
  });
});
