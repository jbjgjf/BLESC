import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  FALLBACK_TEMPLATE_NODE_IDS,
  attributableThemes,
  isFallbackTemplateNodeId,
} from "../src/lib/educatorThemes.ts";
import { fallbackExtraction, normalizeExtraction } from "../src/lib/extraction.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * An output with no attributable observation path is not shown to an educator
 * (#100, #102). These pin that rule on 繰り返し見られる話題, the one
 * graph-derived output the real educator screen shows.
 *
 * Every row below is invented for the test. None is a real student.
 */

function row(nodes, overrides = {}) {
  return { day: "2026-09-01", entry_id: "entry-1", graph_summary_json: { key_nodes: nodes }, ...overrides };
}

function node(id, label) {
  return { id, category: "State", label, intensity: 0.5, confidence: 0.7 };
}

// Inputs chosen to reach every branch of the fallback: nothing matched, the
// English protective and load keywords, and a Japanese entry.
const FALLBACK_INPUTS = ["", "I talked to a friend and felt very anxious about the deadline", "テストが不安で眠れなかった"];

describe("the fallback template is recognised", () => {
  it("every node id fallbackExtraction can emit is a template id", () => {
    for (const text of FALLBACK_INPUTS) {
      for (const { id } of fallbackExtraction(text).nodes) {
        assert.ok(isFallbackTemplateNodeId(id), `${id} (from ${JSON.stringify(text)}) is not recognised`);
      }
    }
  });

  it("the listed ids are ones the fallback actually emits", () => {
    const emitted = new Set(FALLBACK_INPUTS.flatMap((text) => fallbackExtraction(text).nodes.map((n) => n.id)));
    for (const id of FALLBACK_TEMPLATE_NODE_IDS) {
      assert.ok(emitted.has(id), `${id} is listed but never emitted; the list has drifted`);
    }
  });

  it("a model that writes a template's label as a real label is not mistaken for the template", () => {
    const template = fallbackExtraction("").nodes.find((n) => n.id === "current_reflection");
    const extracted = normalizeExtraction(
      {
        nodes: [
          node("a", template.label),
          node("b", "テスト前のプレッシャー"),
          node("c", "眠れない"),
        ],
        relations: [],
      },
      "本文",
    );
    const real = extracted.nodes.find((n) => n.label === template.label);
    assert.ok(real);
    assert.equal(isFallbackTemplateNodeId(real.id), false);
    assert.deepEqual(attributableThemes([row([real])]).themes, [{ label: template.label, count: 1 }]);
  });
});

describe("only attributable occurrences are counted", () => {
  it("a fallback day does not become a recurring theme", () => {
    const fallbackDay = (day) => row(fallbackExtraction("").nodes, { day, entry_id: `entry-${day}` });
    const rows = [
      fallbackDay("2026-09-01"),
      fallbackDay("2026-09-02"),
      fallbackDay("2026-09-03"),
      row([node("眠れない", "眠れない")], { day: "2026-09-04", entry_id: "entry-4" }),
    ];
    const { themes, withheld } = attributableThemes(rows);

    assert.deepEqual(themes, [{ label: "眠れない", count: 1 }]);
    assert.ok(withheld.length >= 15);
    assert.ok(withheld.every((item) => item.reason === "fallback_template"));
  });

  it("the Observation N placeholder is withheld", () => {
    const { themes, withheld } = attributableThemes([row([node("observation_2", "Observation 2")])]);
    assert.deepEqual(themes, []);
    assert.deepEqual(withheld, [{ label: "Observation 2", day: "2026-09-01", reason: "placeholder_label" }]);
  });

  it("a row that names no entry or no day has no path to an observation", () => {
    const rows = [
      row([node("眠れない", "眠れない")], { entry_id: null }),
      row([node("眠れない", "眠れない")], { day: null }),
    ];
    const { themes, withheld } = attributableThemes(rows);
    assert.deepEqual(themes, []);
    assert.deepEqual(
      withheld.map((item) => item.reason),
      ["no_source_observation", "no_source_observation"],
    );
  });

  it("keeps the previous ordering and the top five", () => {
    const labels = ["f", "e", "d", "c", "b", "a"];
    const rows = labels.map((label, index) =>
      row(
        labels.slice(0, index + 1).map((l) => node(l, l)),
        { day: `2026-09-0${index + 1}`, entry_id: `entry-${index}` },
      ),
    );
    const { themes } = attributableThemes(rows);
    assert.deepEqual(
      themes.map((t) => [t.label, t.count]),
      [["f", 6], ["e", 5], ["d", 4], ["c", 3], ["b", 2]],
    );
  });

  it("rows without key nodes, and nodes without labels, are skipped rather than withheld", () => {
    const { themes, withheld } = attributableThemes([
      { day: "2026-09-01", entry_id: "entry-1", graph_summary_json: null },
      row([{ id: "x" }, null, "not a node"]),
    ]);
    assert.deepEqual(themes, []);
    assert.deepEqual(withheld, []);
  });
});

describe("the educator screen goes through the filter", () => {
  it("getStudentOverviewForEducator counts themes with attributableThemes and selects entry_id", async () => {
    const source = await readFile(join(HERE, "..", "src", "api", "client.ts"), "utf8");
    const start = source.indexOf("static async getStudentOverviewForEducator");
    const end = source.indexOf("static async", start + 1);
    const body = source.slice(start, end);

    assert.ok(start > 0, "getStudentOverviewForEducator not found");
    assert.match(body, /\.select\("day, entry_id, graph_summary_json"\)/);
    assert.match(body, /attributableThemes\(rows\)/);
    // The old inline count, which counted every label, must not come back.
    assert.doesNotMatch(body, /themeCounts/);
  });
});
