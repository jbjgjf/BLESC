/**
 * The graph adapter's relation handling (#303).
 *
 * `src/components/graph/` had no tests, which is how a module that drops every
 * relation of every snapshot the extractor produces read as working. These
 * tests are written against both relation shapes the adapter actually receives:
 *
 *   - `source_node_id` / `target_node_id` — what `llm_adapter.py`'s response
 *     schema requires, what its prompt asks for, and therefore what
 *     `relations_json` holds for an entry that went through extraction;
 *   - `source_id` / `target_id` — what `ExtractionRelation` declares, what
 *     `buildConceptGraphData` writes back out, and what the research
 *     pipeline's explanation payload carries.
 *
 * Both have to work. A test for only one of them is how this happened.
 */

import assert from "node:assert/strict";
import { register } from "node:module";
import { describe, it } from "node:test";

register("./helpers/alias-hook.mjs", import.meta.url);

const {
  buildConceptGraphData,
  buildGraphViewerData,
  buildNodeSelection,
  relationSourceId,
  relationTargetId,
  relationType,
  resolveRelationStyle,
} = await import("../src/components/graph/graphAdapter.ts");
const { t } = await import("../src/lib/i18n/index.ts");

const NODES = [
  { id: "deadline_pressure", label: "締切のプレッシャー", category: "Trigger", intensity: 0.7, confidence: 0.9 },
  { id: "anxiety", label: "不安", category: "State", intensity: 0.8, confidence: 0.9 },
  { id: "social_support", label: "友人の支え", category: "Protective", intensity: 0.5, confidence: 0.8 },
];

/** The shape `llm_adapter.py` asks the model for, and the one that reaches the DB. */
const extractorRelations = [
  { source_node_id: "deadline_pressure", target_node_id: "anxiety", type: "escalates", confidence: 0.85 },
  { source_node_id: "social_support", target_node_id: "anxiety", type: "buffers", confidence: 0.8 },
];

/** The shape `ExtractionRelation` declares. */
const declaredRelations = [
  { source_id: "deadline_pressure", target_id: "anxiety", type: "escalates", confidence: 0.85 },
  { source_id: "social_support", target_id: "anxiety", type: "buffers", confidence: 0.8 },
];

function snapshot(id, day, relations, extra = {}) {
  return {
    id,
    day,
    nodes_json: NODES,
    relations_json: relations,
    graph_summary_json: null,
    temporal_diff_json: null,
    ...extra,
  };
}

describe("relation endpoints are read under either field name", () => {
  it("reads the extractor's names", () => {
    const relation = extractorRelations[0];
    assert.equal(relationSourceId(relation), "deadline_pressure");
    assert.equal(relationTargetId(relation), "anxiety");
    assert.equal(relationType(relation), "escalates");
  });

  it("reads the declared names", () => {
    const relation = declaredRelations[0];
    assert.equal(relationSourceId(relation), "deadline_pressure");
    assert.equal(relationTargetId(relation), "anxiety");
  });

  it("prefers the declared name when a relation somehow carries both", () => {
    const relation = { source_id: "anxiety", source_node_id: "deadline_pressure" };
    assert.equal(relationSourceId(relation), "anxiety");
  });

  it("reports an endpoint it cannot find rather than inventing one", () => {
    assert.equal(relationSourceId({ type: "causes" }), undefined);
    assert.equal(relationTargetId({}), undefined);
  });

  it("falls back to the weakest relation when the type is missing", () => {
    assert.equal(relationType({ source_id: "a", target_id: "b" }), "co_occurs");
    assert.equal(resolveRelationStyle(relationType({})), resolveRelationStyle("co_occurs"));
  });
});

describe("buildGraphViewerData draws the relations it was given", () => {
  for (const [name, relations] of [
    ["the extractor's names", extractorRelations],
    ["the declared names", declaredRelations],
  ]) {
    it(`builds one link per relation, given ${name}`, () => {
      const current = snapshot(1, "2026-10-01", relations);
      const data = buildGraphViewerData([current], "current", current);

      assert.equal(data.links.length, relations.length);
      assert.equal(data.unresolvedLinks, 0);
    });

    it(`resolves both endpoints to vertices, given ${name}`, () => {
      const current = snapshot(1, "2026-10-01", relations);
      const { links } = buildGraphViewerData([current], "current", current);

      const escalates = links.find((link) => link.type === "escalates");
      assert.ok(escalates, "the escalates relation was dropped");
      assert.equal(escalates.source.originalId, "deadline_pressure");
      assert.equal(escalates.target.originalId, "anxiety");
    });

    it(`carries the canonical endpoint names out, given ${name}`, () => {
      const current = snapshot(1, "2026-10-01", relations);
      const { links } = buildGraphViewerData([current], "current", current);

      // Whichever name came in, a consumer holding a GraphViewerLink reads
      // `source_id` off the type and must get a value.
      for (const link of links) {
        assert.equal(typeof link.source_id, "string");
        assert.equal(typeof link.target_id, "string");
      }
    });

    it(`sizes a vertex from the edges it actually has, given ${name}`, () => {
      const current = snapshot(1, "2026-10-01", relations);
      const { nodes } = buildGraphViewerData([current], "current", current);

      // `anxiety` is the target of both relations; `deadline_pressure` is the
      // source of one. Degree feeds the radius, so the radii must differ — if
      // degree were counted from relations that are then dropped, the drawing
      // would claim connections that are not on screen.
      const anxiety = nodes.find((node) => node.originalId === "anxiety");
      const deadline = nodes.find((node) => node.originalId === "deadline_pressure");
      assert.ok(anxiety.radius > deadline.radius);
    });
  }

  it("draws relations across every layer in temporal mode", () => {
    const first = snapshot(1, "2026-10-01", extractorRelations);
    const second = snapshot(2, "2026-10-02", extractorRelations);
    const { links } = buildGraphViewerData([first, second], "temporal", second);

    assert.equal(links.length, extractorRelations.length * 2);
    assert.deepEqual(
      [...new Set(links.map((link) => link.snapshotId))].sort(),
      [1, 2],
    );
  });

  it("counts a relation whose endpoint is not in the snapshot instead of hiding it", () => {
    const current = snapshot(1, "2026-10-01", [
      ...extractorRelations,
      { source_node_id: "anxiety", target_node_id: "not_extracted_today", type: "causes", confidence: 0.5 },
    ]);
    const data = buildGraphViewerData([current], "current", current);

    assert.equal(data.links.length, extractorRelations.length);
    assert.equal(data.unresolvedLinks, 1);
  });

  it("marks a relation the temporal diff added", () => {
    const current = snapshot(1, "2026-10-02", extractorRelations, {
      temporal_diff_json: {
        added_relations: [
          { source_node_id: "social_support", target_node_id: "anxiety", type: "buffers" },
        ],
      },
    });
    const { links } = buildGraphViewerData([current], "temporal", current);

    const buffers = links.find((link) => link.type === "buffers");
    const escalates = links.find((link) => link.type === "escalates");
    assert.notEqual(buffers.color, escalates.color, "the added relation is not distinguished");
  });

  it("survives a snapshot with no nodes or relations", () => {
    const empty = { id: 1, day: "2026-10-01", nodes_json: null, relations_json: undefined };
    const data = buildGraphViewerData([empty], "current", empty);
    assert.deepEqual(data.nodes, []);
    assert.deepEqual(data.links, []);
  });
});

describe("buildConceptGraphData merges days", () => {
  for (const [name, relations] of [
    ["the extractor's names", extractorRelations],
    ["the declared names", declaredRelations],
  ]) {
    it(`keeps one vertex per concept and counts its days, given ${name}`, () => {
      const data = buildConceptGraphData([
        snapshot(1, "2026-10-01", relations),
        snapshot(2, "2026-10-02", relations),
      ]);

      assert.equal(data.nodes.length, NODES.length);
      const anxiety = data.nodes.find((node) => node.label === "不安");
      assert.equal(anxiety.frequency, 2);
      assert.deepEqual(anxiety.allDays, ["2026-10-01", "2026-10-02"]);
    });

    it(`merges a recurring relation into one edge, given ${name}`, () => {
      const data = buildConceptGraphData([
        snapshot(1, "2026-10-01", relations),
        snapshot(2, "2026-10-02", relations),
      ]);

      assert.equal(data.links.length, relations.length);
      for (const link of data.links) assert.equal(link.frequency, 2);
    });
  }
});

describe("buildNodeSelection reads the relations a snapshot carries", () => {
  // `key_relations` and `changed_relations` are the extractor's own relation
  // dicts, passed through `build_graph_summary` and `build_temporal_graph_diff`
  // untouched, so they carry `source_node_id` too. Both badges read them.
  const vertexOf = (snap, id) =>
    buildGraphViewerData([snap], "current", snap).nodes.find((node) => node.originalId === id);

  it("says a vertex is in a key relation", () => {
    const snap = snapshot(1, "2026-10-01", extractorRelations, {
      graph_summary_json: {
        key_nodes: [],
        key_relations: [
          { source_node_id: "social_support", target_node_id: "anxiety", type: "buffers", confidence: 0.8 },
        ],
      },
    });

    const inRelation = buildNodeSelection(vertexOf(snap, "social_support"), snap);
    const notInRelation = buildNodeSelection(vertexOf(snap, "deadline_pressure"), snap);

    assert.ok(inRelation.relationSummary.includes(t.graph.role.keyRelation));
    assert.ok(!notInRelation.relationSummary.includes(t.graph.role.keyRelation));
  });

  it("says a vertex's relation shifted", () => {
    const snap = snapshot(1, "2026-10-02", extractorRelations, {
      temporal_diff_json: {
        changed_relations: [
          { source_node_id: "deadline_pressure", target_node_id: "anxiety", type: "escalates" },
        ],
      },
    });

    const shifted = buildNodeSelection(vertexOf(snap, "deadline_pressure"), snap);
    const unchanged = buildNodeSelection(vertexOf(snap, "social_support"), snap);

    assert.ok(shifted.relationSummary.includes(t.graph.role.relationShifted));
    assert.ok(!unchanged.relationSummary.includes(t.graph.role.relationShifted));
  });
});

describe("resolveRelationStyle", () => {
  it("has a style for every relation type the extractor may emit", () => {
    for (const type of ["causes", "escalates", "buffers", "avoids", "co_occurs", "precedes"]) {
      assert.ok(resolveRelationStyle(type), `no style for ${type}`);
    }
  });

  it("falls back to co_occurs for a type it does not know", () => {
    assert.deepEqual(resolveRelationStyle("invented_by_the_model"), resolveRelationStyle("co_occurs"));
  });
});
