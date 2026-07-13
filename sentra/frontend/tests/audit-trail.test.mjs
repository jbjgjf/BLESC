import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildAuditTrails } from "../src/lib/audit-trail.ts";

const extractionRun = (overrides = {}) => ({
  id: "run-extraction-1",
  artifact_type: "extraction",
  artifact_id: "entry-1",
  provider: "openai",
  model: "gpt-4.1-mini",
  prompt_version: "sentra-production-extraction-v1",
  schema_version: "sentra-entry-extraction-v1",
  pipeline_version: "next-production-research-pipeline-v1",
  temperature: 0.2,
  retrieval_config_json: { embedding_model: "text-embedding-3-small", source: "next_api_route" },
  input_provenance_json: {
    entry_id: "entry-1",
    field_names: ["journal_entry", "first_recall_30"],
    journal_text_hash: "hash-journal",
    recall_text_hash: "hash-recall",
  },
  output_hash: "hash-out",
  status: "completed",
  error_message: null,
  created_at: "2026-07-12T09:00:00.000Z",
  ...overrides,
});

const safetyRun = (overrides = {}) => ({
  id: "run-safety-1",
  artifact_type: "safety_assessment",
  artifact_id: "entry-1",
  provider: "rules",
  model: "safety-assessment-v1",
  prompt_version: "safety-assessment-v1",
  schema_version: "safety-assessment-v1",
  pipeline_version: "next-production-research-pipeline-v1",
  temperature: 0,
  retrieval_config_json: { risk_level: "none", escalation_required: false, reasons: [], policy_refs: [] },
  input_provenance_json: { entry_id: "entry-1" },
  output_hash: "hash-safety",
  status: "completed",
  error_message: null,
  created_at: "2026-07-12T09:00:05.000Z",
  ...overrides,
});

describe("buildAuditTrails", () => {
  it("returns an empty list for no runs", () => {
    assert.deepEqual(buildAuditTrails([]), []);
  });

  it("correlates extraction + safety of one reflection into a single ordered trail", () => {
    const trails = buildAuditTrails([safetyRun(), extractionRun()]);
    assert.equal(trails.length, 1);
    const trail = trails[0];
    assert.equal(trail.reflection_id, "entry-1");
    assert.equal(trail.event_count, 2);
    assert.deepEqual(trail.events.map((event) => event.stage), ["extraction", "safety_assessment"]);
    assert.equal(trail.has_safety_flag, false);
    assert.equal(trail.has_failure, false);
    const extraction = trail.events[0];
    assert.ok(extraction.evidence_refs.includes("entry_id: entry-1"));
    assert.ok(extraction.evidence_refs.some((ref) => ref.includes("journal_text_hash")));
  });

  it("surfaces a crisis safety decision and marks it suppressed", () => {
    const trails = buildAuditTrails([
      extractionRun(),
      safetyRun({
        retrieval_config_json: {
          risk_level: "crisis",
          escalation_required: true,
          reasons: ["inability_to_stay_safe"],
          policy_refs: ["safety-policy-1"],
        },
      }),
    ]);
    const trail = trails[0];
    assert.equal(trail.has_safety_flag, true);
    const safety = trail.events.find((event) => event.stage === "safety_assessment");
    assert.equal(safety.status, "suppressed");
    assert.equal(safety.safety_decision.risk_level, "crisis");
    assert.equal(safety.safety_decision.escalation_required, true);
    assert.deepEqual(safety.safety_decision.reasons, ["inability_to_stay_safe"]);
  });

  it("keeps failed extractions visible instead of dropping them", () => {
    const trails = buildAuditTrails([
      extractionRun({ status: "failed", error_message: "provider timeout", output_hash: null }),
    ]);
    const trail = trails[0];
    assert.equal(trail.has_failure, true);
    assert.equal(trail.events[0].status, "failed");
    assert.equal(trail.events[0].error_message, "provider timeout");
  });

  it("orders trails by most recent activity first", () => {
    const older = extractionRun({ id: "run-a", artifact_id: "entry-a", input_provenance_json: { entry_id: "entry-a" }, created_at: "2026-07-10T09:00:00.000Z" });
    const newer = extractionRun({ id: "run-b", artifact_id: "entry-b", input_provenance_json: { entry_id: "entry-b" }, created_at: "2026-07-12T09:00:00.000Z" });
    const trails = buildAuditTrails([older, newer]);
    assert.deepEqual(trails.map((trail) => trail.reflection_id), ["entry-b", "entry-a"]);
  });

  it("redacts secrets and raw content from evidence refs (adversarial input)", () => {
    const trails = buildAuditTrails([
      extractionRun({
        input_provenance_json: {
          entry_id: "entry-1",
          journal_text_hash: "hash-journal",
          api_key: "sk-live-should-never-appear",
          authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.secret.payload",
          raw_journal_text: "I feel unsafe and my secret token is sk-abcdef123456",
        },
      }),
    ]);
    const refs = trails[0].events[0].evidence_refs.join(" | ");
    assert.doesNotMatch(refs, /sk-live/);
    assert.doesNotMatch(refs, /Bearer|eyJ/);
    assert.doesNotMatch(refs, /raw_journal_text|unsafe/);
    assert.match(refs, /entry_id: entry-1/);
    assert.match(refs, /journal_text_hash/);
  });
});
