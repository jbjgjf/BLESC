import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CONSENT_VERSION,
  NO_CONSENT,
  anonymizedExportAllowed,
  consentSnapshot,
  evalDatasetAllowed,
  normalizeConsent,
  rawTextRetentionAllowed,
  researchUseAllowed,
  telemetryAllowed,
} from "../src/lib/consent.ts";

/** A fully consented participant, for tests that vary one field from it. */
const fullyConsented = (overrides = {}) => ({
  app_use: true,
  research_analysis: true,
  anonymized_export: true,
  raw_text_retention: true,
  future_fine_tuning: true,
  minor_assent: true,
  guardian_consent: true,
  consent_version: CONSENT_VERSION,
  document_version: "research-consent-doc-v1",
  status: "active",
  granted_at: "2026-09-01T00:00:00.000Z",
  revoked_at: null,
  ...overrides,
});

describe("normalizeConsent", () => {
  it("treats an absent record as no consent at all", () => {
    assert.deepEqual(normalizeConsent(undefined), NO_CONSENT);
    assert.deepEqual(normalizeConsent(null), NO_CONSENT);
    assert.deepEqual(normalizeConsent("yes"), NO_CONSENT);
    assert.deepEqual(normalizeConsent([]), NO_CONSENT);
  });

  it("reads an absent flag as false rather than inheriting a default", () => {
    // The defect (#134): `{...DEFAULT_CONSENT, ...consent}` with
    // research_analysis: true meant an empty object granted research use.
    const state = normalizeConsent({});
    assert.equal(state.research_analysis, false);
    assert.equal(state.app_use, false);
    assert.equal(state.minor_assent, false);
    assert.equal(state.guardian_consent, false);
  });

  it("only accepts a literal true — not a truthy value", () => {
    const state = normalizeConsent({ research_analysis: "true", minor_assent: 1 });
    assert.equal(state.research_analysis, false);
    assert.equal(state.minor_assent, false);
  });

  it("falls back to created_at when granted_at is absent", () => {
    const state = normalizeConsent({ created_at: "2026-08-01T00:00:00.000Z" });
    assert.equal(state.granted_at, "2026-08-01T00:00:00.000Z");
  });

  it("keeps revoked_at only on a revoked record", () => {
    const revoked = normalizeConsent({ status: "revoked", revoked_at: "2026-09-02T00:00:00.000Z" });
    assert.equal(revoked.status, "revoked");
    assert.equal(revoked.revoked_at, "2026-09-02T00:00:00.000Z");

    const active = normalizeConsent({ status: "active", revoked_at: "2026-09-02T00:00:00.000Z" });
    assert.equal(active.revoked_at, null);
  });
});

describe("researchUseAllowed", () => {
  it("allows research use only with the grant and both parties", () => {
    assert.equal(researchUseAllowed(normalizeConsent(fullyConsented())), true);
  });

  it("refuses when the participant assented but no guardian consented", () => {
    const state = normalizeConsent(fullyConsented({ guardian_consent: false }));
    assert.equal(researchUseAllowed(state), false);
  });

  it("refuses when a guardian consented but the participant did not assent", () => {
    const state = normalizeConsent(fullyConsented({ minor_assent: false }));
    assert.equal(researchUseAllowed(state), false);
  });

  it("refuses on a revoked record even with every grant set", () => {
    const state = normalizeConsent(
      fullyConsented({ status: "revoked", revoked_at: "2026-09-03T00:00:00.000Z" }),
    );
    assert.equal(researchUseAllowed(state), false);
  });

  it("refuses when only app use was granted", () => {
    const state = normalizeConsent({ app_use: true, minor_assent: true, guardian_consent: true });
    assert.equal(researchUseAllowed(state), false);
  });
});

describe("per-purpose gates", () => {
  it("keeps an unconsented participant out of every research table", () => {
    const none = normalizeConsent({});
    assert.equal(evalDatasetAllowed(none), false);
    assert.equal(telemetryAllowed(none), false);
    assert.equal(rawTextRetentionAllowed(none), false);
    assert.equal(anonymizedExportAllowed(none), false);
  });

  it("does not let research consent imply text retention", () => {
    const state = normalizeConsent(fullyConsented({ raw_text_retention: false }));
    assert.equal(researchUseAllowed(state), true);
    assert.equal(evalDatasetAllowed(state), true);
    assert.equal(rawTextRetentionAllowed(state), false);
  });

  it("does not let research consent imply anonymized export", () => {
    const state = normalizeConsent(fullyConsented({ anonymized_export: false }));
    assert.equal(researchUseAllowed(state), true);
    assert.equal(anonymizedExportAllowed(state), false);
  });

  it("refuses retention when the retention flag is set but research use is not", () => {
    const state = normalizeConsent({ raw_text_retention: true, minor_assent: true, guardian_consent: true });
    assert.equal(rawTextRetentionAllowed(state), false);
  });
});

describe("consentSnapshot", () => {
  it("carries the decision alongside the flags it was based on", () => {
    const snapshot = consentSnapshot(normalizeConsent(fullyConsented()));
    assert.equal(snapshot.research_use_allowed, true);
    assert.equal(snapshot.minor_assent, true);
    assert.equal(snapshot.guardian_consent, true);
    assert.equal(snapshot.consent_version, CONSENT_VERSION);
  });

  it("records a refusal as a refusal, not an absence", () => {
    const snapshot = consentSnapshot(normalizeConsent({}));
    assert.equal(snapshot.research_use_allowed, false);
    assert.equal(snapshot.research_analysis, false);
  });
});
