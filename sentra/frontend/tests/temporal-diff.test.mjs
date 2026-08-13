import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  CONFIDENCE_CHANGE_THRESHOLD,
  buildTemporalDiff,
  relationShiftSummary,
} from "../src/lib/temporalDiff.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTRACT = JSON.parse(
  readFileSync(resolve(HERE, "../../shared/temporal_diff_conformance.json"), "utf8"),
);

const relationKey = (relation) => `${relation.source_id}|${relation.target_id}|${relation.type}`;
const sorted = (values) => [...values].sort();

describe("temporal diff — shared contract", () => {
  it("the fixture file is the one both implementations use", () => {
    assert.equal(CONTRACT.contract, "temporal_diff");
    assert.ok(CONTRACT.cases.length >= 8);
  });

  for (const testCase of CONTRACT.cases) {
    it(`${testCase.name}: ${testCase.why.split(".")[0]}`, () => {
      const diff = buildTemporalDiff(testCase.current, testCase.previous);
      const expected = testCase.expected;

      assert.deepEqual(sorted(diff.added_nodes.map((n) => n.id)), sorted(expected.added_node_ids));
      assert.deepEqual(sorted(diff.removed_nodes.map((n) => n.id)), sorted(expected.removed_node_ids));
      assert.deepEqual(sorted(diff.added_relations.map(relationKey)), sorted(expected.added_relation_keys));
      assert.deepEqual(sorted(diff.removed_relations.map(relationKey)), sorted(expected.removed_relation_keys));
      assert.deepEqual(sorted(diff.changed_relations.map(relationKey)), sorted(expected.changed_relation_keys));
    });
  }
});

describe("temporal diff — properties the production writer violated", () => {
  const day1 = {
    nodes: [{ id: "眠れない", category: "State", label: "眠れない", intensity: 0.7, confidence: 0.8 }],
    relations: [{ source_id: "テスト前のプレッシャー", target_id: "眠れない", type: "causes", confidence: 0.8 }],
  };

  it("an unchanged day produces an EMPTY added_relations", () => {
    // The whole defect in one assertion. Production wrote
    // `added_relations: extraction.relations` unconditionally, so this array
    // was never empty and the temporal view coloured everything as new.
    const diff = buildTemporalDiff(day1, day1);
    assert.deepEqual(diff.added_relations, []);
    assert.deepEqual(diff.added_nodes, []);
  });

  it("distinguishes a real first entry from a day with nothing new", () => {
    const first = relationShiftSummary(buildTemporalDiff(day1, { nodes: [], relations: [] }), false);
    const unchanged = relationShiftSummary(buildTemporalDiff(day1, day1), true);
    assert.notEqual(first, unchanged);
    assert.match(first, /no previous day/);
  });

  it("is symmetric: what one day adds, reversing the pair removes", () => {
    const day2 = {
      nodes: [
        ...day1.nodes,
        { id: "部活を休んだ", category: "Behavior", label: "部活を休んだ", intensity: 0.5, confidence: 0.7 },
      ],
      relations: day1.relations,
    };
    const forward = buildTemporalDiff(day2, day1);
    const backward = buildTemporalDiff(day1, day2);
    assert.deepEqual(forward.added_nodes.map((n) => n.id), backward.removed_nodes.map((n) => n.id));
    assert.deepEqual(forward.removed_nodes, backward.added_nodes);
  });

  it("is deterministic", () => {
    const a = buildTemporalDiff(day1, { nodes: [], relations: [] });
    const b = buildTemporalDiff(day1, { nodes: [], relations: [] });
    assert.deepEqual(a, b);
  });

  it("threshold is exactly at the boundary, not above it", () => {
    const withConfidence = (value) => ({
      nodes: day1.nodes,
      relations: [{ source_id: "テスト前のプレッシャー", target_id: "眠れない", type: "causes", confidence: value }],
    });
    const exactly = buildTemporalDiff(withConfidence(0.5 + CONFIDENCE_CHANGE_THRESHOLD), withConfidence(0.5));
    assert.equal(exactly.changed_relations.length, 1, "a move of exactly the threshold counts as changed");
  });

  it("does not crash on malformed input", () => {
    const diff = buildTemporalDiff({ nodes: [{}], relations: [{}] }, { nodes: [], relations: [] });
    assert.ok(Array.isArray(diff.added_relations));
  });
});
