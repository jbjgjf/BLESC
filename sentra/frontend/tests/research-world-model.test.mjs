import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  disabledCapabilities,
  enabledCapabilities,
  failedChecks,
  formatNumber,
  metricInterval,
  metricValue,
  seriesForFeature,
  sortedEdges,
  toRunState,
} from "../src/lib/research/worldModel.ts";
import { t } from "../src/lib/i18n/index.ts";

/**
 * The research screen (#151, #152) has to render every state the run API can
 * be in, and it has to render an absent number as an absence.
 *
 * The fixtures are a shared contract file generated from a real
 * `research_engine.cli smoke` run, not hand-written payloads. A schema change
 * on the backend therefore breaks these tests rather than leaving the screen
 * quietly rendering a shape that is no longer produced.
 */

const STATES = JSON.parse(
  await readFile(
    fileURLToPath(new URL("../../shared/research_world_model_states.json", import.meta.url)),
    "utf8",
  ),
);

describe("run states", () => {
  it("covers every state the API can report", () => {
    assert.deepEqual(
      Object.keys(STATES.states).sort(),
      ["failed", "no_explanation", "queued", "running", "succeeded", "succeeded_with_failed_check"],
    );
  });

  it("maps API states onto screen states, and unknown onto unknown", () => {
    assert.equal(toRunState("queued"), "queued");
    assert.equal(toRunState("running"), "running");
    assert.equal(toRunState("succeeded"), "succeeded");
    assert.equal(toRunState("failed"), "failed");
    assert.equal(toRunState(null), "idle");
    assert.equal(toRunState("in-flight-probably"), "unknown");
  });

  it("has copy for every state, including the ones nobody demonstrates", () => {
    for (const state of ["idle", "queued", "running", "succeeded", "failed", "unknown"]) {
      assert.ok(t.worldModel.state[state], `no label for ${state}`);
      assert.ok(t.worldModel.stateNote[state], `no note for ${state}`);
    }
  });
});

describe("metrics", () => {
  const report = STATES.states.succeeded.report;

  it("renders a value only when the evaluator computed one", () => {
    const ok = report.metrics.find((metric) => metric.status === "ok");
    assert.notEqual(metricValue(ok), null);

    for (const metric of report.unsupported_metrics) {
      assert.equal(
        metricValue(metric),
        null,
        `${metric.name} must not render a number when it is ${metric.status}`,
      );
      assert.equal(metricInterval(metric), null);
      assert.ok(metric.reason_ja, `${metric.name} has no reason to show instead of a number`);
    }
  });

  it("shows 算出せず rather than a zero for an unsupported metric", () => {
    const metric = report.unsupported_metrics[0];
    const rendered = formatNumber(metricValue(metric)) ?? t.worldModel.notComputed;
    assert.equal(rendered, "算出せず");
    assert.notEqual(rendered, "0.0000");
  });

  it("keeps baselines and the new model in the same table", () => {
    const models = new Set(
      report.metrics.filter((metric) => metric.name === "mae").map((metric) => metric.model_id),
    );
    for (const baseline of report.baselines) {
      assert.ok(models.has(baseline), `${baseline} is missing from the comparison`);
    }
    assert.ok(models.has("memory_gru"));
  });

  it("reports coverage and width together", () => {
    const names = report.metrics.map((metric) => metric.name);
    if (names.includes("interval_coverage_90")) {
      assert.ok(
        names.includes("interval_width_90"),
        "coverage without width lets a wider interval read as an improvement",
      );
    }
  });
});

describe("leakage checks", () => {
  it("finds nothing red on a clean run", () => {
    assert.deepEqual(failedChecks(STATES.states.succeeded.report), []);
  });

  it("surfaces a red check on the run that has one", () => {
    const red = failedChecks(STATES.states.succeeded_with_failed_check.report);
    assert.equal(red.length, 1);
    assert.equal(red[0].name, "normalizer_fit_on_train_only");
    assert.ok(red[0].detail_ja.length > 0);
  });

  it("treats a report with no checks as nothing to show, not as passing", () => {
    assert.deepEqual(failedChecks(null), []);
  });
});

describe("capabilities", () => {
  const bundle = STATES.states.succeeded.explanations.explanations[0];

  it("never reports real-world causal effects or active questioning as available", () => {
    const off = disabledCapabilities(bundle.capability_flags);
    assert.ok(off.includes("real_world_causal_effects"));
    assert.ok(off.includes("active_questioning"));
  });

  it("reports what the run did do", () => {
    const on = enabledCapabilities(bundle.capability_flags);
    assert.ok(on.includes("trained_encoder"));
    assert.ok(on.includes("trained_dynamics"));
  });

  it("has Japanese copy for every flag the backend can send", () => {
    for (const name of Object.keys(bundle.capability_flags)) {
      assert.ok(t.worldModel.capability[name], `no label for capability ${name}`);
    }
  });
});

describe("the explanation graph", () => {
  const bundle = STATES.states.succeeded.explanations.explanations[0];

  it("labels every axis with what kind of thing it is", () => {
    for (const node of bundle.states) {
      assert.ok(
        t.worldModel.semanticStatus[node.semantic_status],
        `no label for semantic status ${node.semantic_status}`,
      );
      assert.notEqual(node.semantic_status, "anchored_measure");
    }
  });

  it("labels every edge as a model candidate, not as evidence", () => {
    for (const edge of bundle.candidate_edges) {
      assert.equal(edge.evidence_scope, "model_candidate");
      assert.ok(t.worldModel.evidenceScope[edge.evidence_scope]);
    }
  });

  it("names the uncertainty method next to the number", () => {
    for (const edge of bundle.candidate_edges) {
      if (edge.uncertainty === null) continue;
      assert.equal(edge.uncertainty_method, "bootstrap_frequency");
      assert.ok(
        t.worldModel.uncertaintyMethod[edge.uncertainty_method].includes("選択割合"),
        "a resample frequency must not be presented as a probability",
      );
    }
  });

  it("sorts the strongest candidates first", () => {
    const sorted = sortedEdges(bundle.candidate_edges);
    for (let index = 1; index < sorted.length; index += 1) {
      assert.ok((sorted[index - 1].uncertainty ?? 0) >= (sorted[index].uncertainty ?? 0));
    }
  });

  it("carries a residual and the assumptions that shaped the graph", () => {
    assert.ok(Object.keys(bundle.residual_summary).length > 0);
    assert.ok(bundle.assumptions.length > 0);
  });

  it("renders a run with no explanation as unsupported, not as empty", () => {
    const payload = STATES.states.no_explanation.explanations;
    assert.equal(payload.status, "unsupported");
    assert.deepEqual(payload.explanations, []);
    assert.ok(payload.reason_ja);
  });
});

describe("the forecast time series", () => {
  const preview = STATES.states.succeeded.explanations.forecast_previews[0];

  it("keeps observation, actual and forecast as separate series", () => {
    const rows = seriesForFeature(preview, 0);
    assert.ok(rows.some((row) => row.observed !== null));
    assert.ok(rows.some((row) => row.forecast !== null));

    for (const row of rows) {
      assert.ok(
        row.observed === null || row.forecast === null,
        "a point must not be both an observation and a prediction",
      );
    }
  });

  it("puts every forecast point after the cutoff", () => {
    const rows = seriesForFeature(preview, 0);
    for (const row of rows) {
      if (row.forecast !== null) assert.ok(row.at > preview.cutoff_at);
      if (row.observed !== null) assert.ok(row.at <= preview.cutoff_at);
    }
  });

  it("is ordered in time", () => {
    const rows = seriesForFeature(preview, 0);
    for (let index = 1; index < rows.length; index += 1) {
      assert.ok(rows[index - 1].at <= rows[index].at);
    }
  });

  it("draws a band only where the model reported a spread", () => {
    const rows = seriesForFeature(preview, 0);
    for (const row of rows) {
      if (row.lower !== null) {
        assert.notEqual(row.forecast, null);
        assert.ok(row.lower <= row.forecast && row.forecast <= row.upper);
      }
    }
  });

  it("shows a baseline alongside the model where one was recorded", () => {
    if (!preview.baseline_forecast) return;
    const rows = seriesForFeature(preview, 0);
    assert.ok(rows.some((row) => row.baseline !== null));
  });
});

describe("the usage figures", () => {
  it("distinguishes zero calls from an unmeasured field", () => {
    const usage = STATES.states.succeeded.report.measured_usage;
    assert.equal(usage.provider_calls, 0);
    assert.notEqual(usage.provider_calls, null);
    assert.ok(t.worldModel.usageZeroNote.includes("実測"));
  });
});
