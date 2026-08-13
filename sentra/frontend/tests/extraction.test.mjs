import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { canonicalNodeId, normalizeExtraction, sanitizeId } from "../src/lib/extraction.ts";

/**
 * These were written first as characterisation tests, asserting the broken
 * behaviour so the fix commit would show exactly what changed. They now assert
 * the corrected behaviour; the `WAS:` comments record what each one used to
 * prove, because the failure was silent and the next person deserves to know it
 * was possible.
 */

// A realistic model response for a Japanese journal entry: the extractor is
// asked for an `id` and returns Japanese, because the content is Japanese and
// nothing in the schema says otherwise.
const japaneseExtraction = {
  nodes: [
    { id: "眠れない", category: "State", label: "眠れない", intensity: 0.7, confidence: 0.8 },
    { id: "テスト前のプレッシャー", category: "Trigger", label: "テスト前のプレッシャー", intensity: 0.8, confidence: 0.85 },
    { id: "集中できない", category: "State", label: "集中できない", intensity: 0.6, confidence: 0.75 },
    { id: "友達と話した", category: "Protective", label: "友達と話した", intensity: 0.5, confidence: 0.7 },
    { id: "部活を休んだ", category: "Behavior", label: "部活を休んだ", intensity: 0.55, confidence: 0.7 },
  ],
  relations: [
    { source_id: "テスト前のプレッシャー", target_id: "眠れない", type: "causes", confidence: 0.8 },
    { source_id: "眠れない", target_id: "集中できない", type: "causes", confidence: 0.75 },
    { source_id: "友達と話した", target_id: "眠れない", type: "buffers", confidence: 0.6 },
  ],
  temporal_summary: "テスト週の記録",
  summary: "テスト前の緊張と睡眠の乱れ",
  evidence_summaries: ["生徒の日誌"],
};

const englishExtraction = {
  nodes: [
    { id: "insomnia", category: "State", label: "Cannot sleep", intensity: 0.7, confidence: 0.8 },
    { id: "exam_pressure", category: "Trigger", label: "Exam pressure", intensity: 0.8, confidence: 0.85 },
    { id: "poor_focus", category: "State", label: "Cannot focus", intensity: 0.6, confidence: 0.75 },
    { id: "talked_to_friend", category: "Protective", label: "Talked to a friend", intensity: 0.5, confidence: 0.7 },
    { id: "skipped_club", category: "Behavior", label: "Skipped club", intensity: 0.55, confidence: 0.7 },
  ],
  relations: [
    { source_id: "exam_pressure", target_id: "insomnia", type: "causes", confidence: 0.8 },
    { source_id: "insomnia", target_id: "poor_focus", type: "causes", confidence: 0.75 },
    { source_id: "talked_to_friend", target_id: "insomnia", type: "buffers", confidence: 0.6 },
  ],
  temporal_summary: "exam week",
  summary: "exam pressure and disrupted sleep",
  evidence_summaries: ["student journal"],
};

describe("sanitizeId", () => {
  it("preserves an ASCII id", () => {
    assert.equal(sanitizeId("exam_pressure", 0), "exam_pressure");
  });

  it("WAS: collapsed any Japanese label to a positional placeholder", () => {
    // Retained to document why canonicalNodeId exists. sanitizeId is still the
    // fallback for a node with no usable label at all.
    assert.equal(sanitizeId("眠れない", 0), "node_1");
    assert.equal(sanitizeId("部活を休んだ", 0), "node_1");
  });
});

describe("canonicalNodeId", () => {
  it("keeps English ids readable and unchanged", () => {
    assert.equal(canonicalNodeId("Exam pressure"), "exam_pressure");
    assert.equal(canonicalNodeId("Cannot sleep"), "cannot_sleep");
  });

  it("gives distinct Japanese labels distinct ids", () => {
    assert.notEqual(canonicalNodeId("眠れない"), canonicalNodeId("部活を休んだ"));
    assert.equal(canonicalNodeId("眠れない"), "眠れない");
  });

  it("is stable across days for the same label — the property #95 needs", () => {
    assert.equal(canonicalNodeId("テスト前のプレッシャー"), canonicalNodeId("テスト前のプレッシャー"));
    // Position must not participate.
    assert.equal(canonicalNodeId(" テスト前のプレッシャー "), canonicalNodeId("テスト前のプレッシャー"));
  });

  it("folds width and case variants onto one node", () => {
    assert.equal(canonicalNodeId("ﾃｽﾄ"), canonicalNodeId("テスト"));
    assert.equal(canonicalNodeId("ＥＸＡＭ"), canonicalNodeId("exam"));
  });

  it("does not merge different concepts", () => {
    assert.notEqual(canonicalNodeId("眠れない"), canonicalNodeId("眠れた"));
  });
});

describe("normalizeExtraction — English", () => {
  it("keeps the model's graph structure, re-keyed onto label identity", () => {
    const result = normalizeExtraction(englishExtraction, "I could not sleep before the exam.");
    assert.equal(result.nodes.length, 5);
    assert.equal(result.relations.length, 3);
    // Ids now come from the LABEL, not from the model's `id` field, so
    // {id: "insomnia", label: "Cannot sleep"} stores as `cannot_sleep`. The
    // model's id is arbitrary and it is free to pick a different one tomorrow
    // for the same observation; the label is the observation. The edges are
    // unchanged — they are remapped, which is what was missing.
    assert.deepEqual(
      result.relations.map((relation) => `${relation.source_id}-${relation.type}->${relation.target_id}`),
      [
        "exam_pressure-causes->cannot_sleep",
        "cannot_sleep-causes->cannot_focus",
        "talked_to_a_friend-buffers->cannot_sleep",
      ],
    );
  });
});

describe("normalizeExtraction — Japanese", () => {
  const sourceText = "テスト前で眠れない。集中できないし、部活も休んだ。";
  const result = normalizeExtraction(japaneseExtraction, sourceText);

  it("WAS: rewrote every node id to its array position", () => {
    assert.deepEqual(result.nodes.map((node) => node.id),
      ["眠れない", "テスト前のプレッシャー", "集中できない", "友達と話した", "部活を休んだ"]);
    assert.equal(result.nodes[0].label, "眠れない");
  });

  it("WAS: discarded every relation the model extracted", () => {
    assert.equal(result.relations.length, 3);
    assert.deepEqual(
      result.relations.map((relation) => `${relation.source_id}-${relation.type}->${relation.target_id}`),
      [
        "テスト前のプレッシャー-causes->眠れない",
        "眠れない-causes->集中できない",
        "友達と話した-buffers->眠れない",
      ],
    );
  });

  it("WAS: substituted fallback relations pointing at nodes which do not exist", () => {
    const nodeIds = new Set(result.nodes.map((node) => node.id));
    const dangling = result.relations.filter(
      (relation) => !nodeIds.has(relation.source_id) || !nodeIds.has(relation.target_id));
    assert.deepEqual(dangling, []);
  });

  it("WAS: produced a graph with no usable edge at all", () => {
    const nodeIds = new Set(result.nodes.map((node) => node.id));
    const renderable = result.relations.filter(
      (relation) => nodeIds.has(relation.source_id) && nodeIds.has(relation.target_id));
    assert.equal(renderable.length, 3);
  });

  it("gives the same node the same id on a different day, in a different order", () => {
    // The property that makes a temporal graph possible at all (#95). Under the
    // positional scheme this assertion could not be satisfied.
    const laterDay = normalizeExtraction({
      ...japaneseExtraction,
      nodes: [...japaneseExtraction.nodes].reverse(),
    }, sourceText);
    const first = new Set(result.nodes.map((node) => node.id));
    const second = new Set(laterDay.nodes.map((node) => node.id));
    assert.deepEqual([...first].sort(), [...second].sort());
  });
});

describe("invariant: the stored graph is never internally inconsistent", () => {
  // This is the one that must never go red again. Every path through
  // normalizeExtraction — model output, fallback, partial, empty — has to
  // produce relations whose endpoints exist. The Japanese failure was exactly
  // this invariant breaking, and nothing was checking it.
  const cases = [
    ["japanese model output", japaneseExtraction, "テスト前で眠れない。"],
    ["english model output", englishExtraction, "I could not sleep before the exam."],
    ["empty candidate", {}, "何も書けなかった。"],
    ["nodes but no relations", { ...japaneseExtraction, relations: [] }, "テスト前で眠れない。"],
    ["relations referencing unknown ids", {
      ...japaneseExtraction,
      relations: [{ source_id: "存在しない", target_id: "眠れない", type: "causes", confidence: 0.8 }],
    }, "テスト前で眠れない。"],
    ["too few nodes, forcing the fallback", {
      nodes: [{ id: "a", category: "State", label: "ひとつだけ", intensity: 0.5, confidence: 0.5 }],
      relations: [],
    }, "sleep and study before the deadline"],
  ];

  for (const [name, candidate, text] of cases) {
    it(`holds for ${name}`, () => {
      const output = normalizeExtraction(candidate, text);
      const nodeIds = new Set(output.nodes.map((node) => node.id));
      for (const relation of output.relations) {
        assert.ok(nodeIds.has(relation.source_id),
          `${name}: relation source ${relation.source_id} is not a node`);
        assert.ok(nodeIds.has(relation.target_id),
          `${name}: relation target ${relation.target_id} is not a node`);
      }
      assert.ok(output.nodes.length > 0, `${name}: produced no nodes`);
      assert.equal(new Set(output.nodes.map((n) => n.id)).size, output.nodes.length,
        `${name}: duplicate node ids`);
    });
  }
});
