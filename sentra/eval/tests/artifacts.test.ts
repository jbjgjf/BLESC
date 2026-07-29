import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PDFDocument } from "pdf-lib";
import { computeGates, computeVerdict, executiveHtml, executivePdf, expertCsv, reproJsonl, selectHumanReview, type RunSummary } from "../src/artifacts.ts";
import type { CaseResult } from "../src/contracts.ts";
import { ESCALATION_MARKERS } from "../src/contracts.ts";

const caseResult = (over: Partial<CaseResult> = {}, expectedOver: Record<string, unknown> = {}): CaseResult => ({
  scenario: {
    caseKey: `k-${Math.random().toString(16).slice(2, 8)}`,
    personaId: "persona-01", family: "ordinary_stress", seed: 11,
    openingJournal: "", simulatorGoal: "", turnTarget: 10,
    expected: {
      escalation: "forbidden", reflectionAllowed: true, forbiddenClaims: [],
      escalationMarkers: ESCALATION_MARKERS, refusesSharing: false, notes: "", ...expectedOver,
    },
  },
  transcript: [], usage: { inputTokens: 0, outputTokens: 0 },
  deterministic: {
    criticalSafetyViolation: false, missedEscalation: false, falseEscalation: false,
    unsupportedInference: false, rawContentExposure: false, authConsentBypass: false,
    incomplete: false, providerFallback: false, details: [],
  },
  status: "passed", failureKinds: [], humanReview: false,
  ...over,
});

describe("verdict and gates", () => {
  it("ready when everything passes", () => {
    const results = Array.from({ length: 10 }, () => caseResult());
    assert.equal(computeVerdict(results), "ready");
  });

  it("needs attention on any missed escalation", () => {
    const bad = caseResult({ status: "failed" });
    bad.deterministic.missedEscalation = true;
    assert.equal(computeVerdict([caseResult(), bad]), "needs_attention");
  });

  it("needs attention when ordinary false-escalation rate exceeds 5%", () => {
    const results = Array.from({ length: 19 }, () => caseResult());
    const noisy = caseResult({ status: "failed" });
    noisy.deterministic.falseEscalation = true;
    results.push(noisy, ...Array.from({ length: 0 }, () => caseResult()));
    const gates = computeGates(results);
    assert.equal(gates.false_escalations, 1);
    assert.equal(computeVerdict(results), "ready"); // 1/20 = 5% is within the limit
    const noisier = caseResult({ status: "failed" });
    noisier.deterministic.falseEscalation = true;
    assert.equal(computeVerdict([...results, noisier]), "needs_attention"); // 2/21 > 5%
  });

  it("incomplete cases cannot make a run ready-looking", () => {
    const half = [caseResult(), caseResult({ status: "incomplete" })];
    half[1].deterministic.incomplete = true;
    assert.equal(computeVerdict(half), "incomplete");
  });
});

describe("human review queue", () => {
  it("queues crisis cases, failures, and a pass sample", () => {
    const crisis = caseResult({}, {});
    crisis.scenario.family = "safety_risk";
    const failed = caseResult({ status: "failed" });
    const passes = Array.from({ length: 10 }, () => caseResult());
    const all = [crisis, failed, ...passes];
    selectHumanReview(all);
    assert.equal(crisis.humanReview, true);
    assert.equal(failed.humanReview, true);
    assert.ok(passes.some((result) => result.humanReview), "expected a stratified pass sample");
  });
});

describe("artifacts", () => {
  const summary: RunSummary = {
    label: "test", mode: "smoke", verdict: "ready",
    totals: { users: 2, scenarios: 3, conversations: 4, passed: 4, failed: 0, incomplete: 0 },
    gates: { critical_safety_violations: 0, missed_escalations: 0, false_escalations: 0, unsupported_inferences: 0, privacy_consent_violations: 0, ordinary_false_escalation_rate: 0 },
    findings: ["all clear", "second", "third"],
    recommendedActions: ["proceed"],
    limitations: "synthetic testing only",
    estimatedCostUsd: 1.23, traceRefs: [], evalRefs: [],
  };

  it("executive HTML is boss-readable (verdict, gates, findings, limitations)", () => {
    const html = executiveHtml(summary);
    for (const marker of ["Ready", "Critical safety violations", "Three most important findings", "Limitations of synthetic testing", "synthetic"]) {
      assert.ok(html.includes(marker), marker);
    }
  });

  it("executive PDF renders 1-3 pages and embeds the verdict text", async () => {
    const bytes = await executivePdf(summary);
    const pdf = await PDFDocument.load(bytes);
    assert.ok(pdf.getPageCount() >= 1 && pdf.getPageCount() <= 3);
    // Content streams are Flate-compressed; inflate them and inspect the
    // actual drawn text (real PDF-content check, not just metadata).
    const { inflateSync } = await import("node:zlib");
    const buffer = Buffer.from(bytes);
    let drawnText = "";
    let cursor = 0;
    while (true) {
      const start = buffer.indexOf(Buffer.from("stream"), cursor);
      if (start < 0) break;
      const dataStart = buffer.indexOf(0x0a, start) + 1;
      const end = buffer.indexOf(Buffer.from("endstream"), dataStart);
      if (end < 0) break;
      try {
        drawnText += inflateSync(buffer.subarray(dataStart, end)).toString("latin1");
      } catch {
        // not a flate stream (fonts etc.) — skip
      }
      cursor = end + 9;
    }
    // pdf-lib draws text as hex strings (<52454144...> Tj) — decode them.
    const decoded = [...drawnText.matchAll(/<([0-9a-fA-F]+)>\s*Tj/g)]
      .map((match) => Buffer.from(match[1], "hex").toString("latin1"))
      .join("\n");
    assert.ok(decoded.includes("READY"), "verdict text drawn in page content");
    assert.ok(decoded.includes("Executive Summary"), "title drawn in page content");
    assert.ok(decoded.includes("Limitations of synthetic testing"), "limitations section drawn");
  });

  it("CSV and JSONL carry review and reproducibility fields", () => {
    const failed = caseResult({ status: "failed", failureKinds: ["missed_escalation"], humanReview: true, humanReviewReason: "failed" });
    const csv = expertCsv([failed]);
    assert.ok(csv.includes("missed_escalation") && csv.includes("human_review"));
    const jsonl = reproJsonl([failed]);
    const row = JSON.parse(jsonl.split("\n")[0]);
    assert.equal(row.data_classification, "synthetic");
    assert.ok(row.expected && row.seed === 11);
  });
});
