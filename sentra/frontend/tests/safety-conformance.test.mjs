import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  SAFETY_ASSESSMENT_VERSION,
  SAFETY_RESPONSES,
  assessSafety,
  safetyLexiconCanonicalForm,
} from "../src/lib/safety-assessment.ts";

/**
 * The deterministic crisis assessment has two implementations: this one, and
 * `backend/app/services/safety.py`, which answers when NEXT_PUBLIC_API_URL is
 * set. They used to share a version string and disagree (#374). Both suites run
 * `sentra/shared/safety_assessment_conformance.json`; the backend's half is
 * `backend/tests/test_safety_conformance.py`.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const CONTRACT = JSON.parse(
  readFileSync(resolve(HERE, "../../shared/safety_assessment_conformance.json"), "utf8"),
);

describe("safety assessment conformance", () => {
  for (const expected of CONTRACT.cases) {
    it(`assesses ${JSON.stringify(expected.input)} as ${expected.risk_level}`, () => {
      const actual = assessSafety(expected.input);
      assert.equal(actual.risk_level, expected.risk_level);
      assert.equal(actual.escalation_required, expected.escalation_required);
      assert.equal(actual.confidence, expected.confidence);
      assert.deepEqual(actual.reasons, expected.reasons);
    });
  }

  it("matches the lexicon the contract was generated from", () => {
    const digest = createHash("sha256").update(safetyLexiconCanonicalForm(), "utf8").digest("hex");
    assert.equal(
      digest,
      CONTRACT.lexicon_sha256,
      "A safety term changed here. Make the same change in backend/app/services/safety.py, then regenerate lexicon_sha256 and the cases.",
    );
  });

  it("shows the student the responses the contract carries", () => {
    assert.deepEqual({ ...SAFETY_RESPONSES }, CONTRACT.responses);
    assert.equal(assessSafety("もう死にたい").safe_response, CONTRACT.responses.crisis);
    assert.equal(assessSafety("もう限界").safe_response, CONTRACT.responses.elevated);
  });

  it("writes the version the contract names", () => {
    assert.equal(SAFETY_ASSESSMENT_VERSION, CONTRACT.assessment_version);
  });
});
