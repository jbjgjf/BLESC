/**
 * The effective consent of a minor is what the participant asked for and the
 * guardian allowed — both, item by item (#316).
 *
 * `/legal` has said this to guardians while the implementation recorded one
 * word, `confirmed`, and granted everything the participant had asked for.
 * These go through every combination of the participant's four choices and the
 * guardian's three answers and check the stored record against the rule as the
 * documents state it.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { NO_CONSENT } from "../src/lib/consent.ts";
import {
  GUARDIAN_CONSENT_ITEMS,
  guardianConsentGrant,
  guardianDecisionFor,
  normalizeGuardianGrants,
  normalizeRequestedGrants,
  participantConsentGrant,
} from "../src/lib/guardianVerification.ts";

const DOC = "research-consent-doc-v1";
const BOOLS = [false, true];

/** The participant's side: their stored record and what they asked a guardian to approve. */
function participant({ app_use = true, anonymized_export = false, raw_text_retention = false, model_training_use = false } = {}) {
  return {
    record: { ...NO_CONSENT, app_use, minor_assent: true },
    requested: normalizeRequestedGrants({ anonymized_export, raw_text_retention, model_training_use }, DOC),
  };
}
const guardian = (app_use, research_analysis, raw_text_retention) =>
  normalizeGuardianGrants({ app_use, research_analysis, raw_text_retention }, DOC);
const effective = (child, answer) => guardianConsentGrant(child.requested, child.record, answer);

describe("the cases the documents describe", () => {
  it("both allow everything: everything asked for is in effect", () => {
    const grant = effective(participant({ anonymized_export: true, raw_text_retention: true }), guardian(true, true, true));
    assert.deepEqual(
      [grant.app_use, grant.research_analysis, grant.anonymized_export, grant.raw_text_retention, grant.guardian_consent],
      [true, true, true, true, true],
    );
  });

  it("participant ON × guardian OFF: the journal text is not retained", () => {
    const grant = effective(participant({ raw_text_retention: true }), guardian(true, true, false));
    assert.equal(grant.raw_text_retention, false);
    assert.equal(grant.research_analysis, true, "declining retention must not end the participation");
    assert.equal(grant.guardian_consent, true);
  });

  it("participant OFF × guardian ON: the guardian cannot add what the participant did not ask for", () => {
    const grant = effective(participant({ raw_text_retention: false }), guardian(true, true, true));
    assert.equal(grant.raw_text_retention, false);
    assert.equal(grant.anonymized_export, false);
  });

  it("guardian allows the app but not the research: nothing is collected for the study", () => {
    const grant = effective(participant({ anonymized_export: true, raw_text_retention: true }), guardian(true, false, true));
    assert.equal(grant.app_use, true);
    assert.deepEqual(
      [grant.research_analysis, grant.anonymized_export, grant.raw_text_retention, grant.guardian_consent],
      [false, false, false, false],
    );
  });

  it("guardian allows the research but not the app: there is nowhere for it to happen", () => {
    const grant = effective(participant({ raw_text_retention: true }), guardian(false, true, true));
    assert.deepEqual(
      [grant.app_use, grant.research_analysis, grant.raw_text_retention, grant.guardian_consent],
      [false, false, false, false],
    );
  });

  it("guardian turns everything off: nothing is in effect, and that is a recorded answer", () => {
    const answer = guardian(false, false, false);
    const grant = effective(participant({ anonymized_export: true, raw_text_retention: true }), answer);
    assert.deepEqual(
      [grant.app_use, grant.research_analysis, grant.anonymized_export, grant.raw_text_retention, grant.guardian_consent],
      [false, false, false, false, false],
    );
    assert.deepEqual(answer, { app_use: false, research_analysis: false, raw_text_retention: false, document_version: DOC });
  });

  it("model training is never in effect for a minor, whoever asked", () => {
    const grant = effective(participant({ model_training_use: true }), guardian(true, true, true));
    assert.equal(grant.model_training_use, false);
  });
});

describe("every combination", () => {
  const cases = [];
  for (const app of BOOLS) for (const exp of BOOLS) for (const raw of BOOLS) for (const train of BOOLS) {
    for (const gApp of BOOLS) for (const gResearch of BOOLS) for (const gRaw of BOOLS) {
      cases.push({ p: { app_use: app, anonymized_export: exp, raw_text_retention: raw, model_training_use: train }, g: [gApp, gResearch, gRaw] });
    }
  }

  it("is the intersection, stated independently of the implementation", () => {
    assert.equal(cases.length, 128);
    for (const { p, g } of cases) {
      const [gApp, gResearch, gRaw] = g;
      const grant = effective(participant(p), guardian(...g));
      const label = `participant ${JSON.stringify(p)} × guardian ${JSON.stringify(g)}`;

      assert.equal(grant.app_use, p.app_use && gApp, label);
      assert.equal(grant.research_analysis, gApp && gResearch, label);
      assert.equal(grant.anonymized_export, p.anonymized_export && gApp && gResearch, label);
      assert.equal(grant.raw_text_retention, p.raw_text_retention && gRaw && gApp && gResearch, label);
      assert.equal(grant.model_training_use, false, label);
      assert.equal(grant.guardian_consent, gApp && gResearch, label);
      assert.equal(grant.minor_assent, true, label);
      assert.equal(grant.document_version, DOC, label);
    }
  });

  it("no optional grant is in effect without research, and no research without guardian consent", () => {
    for (const { p, g } of cases) {
      const grant = effective(participant(p), guardian(...g));
      if (!grant.research_analysis) {
        assert.equal(grant.anonymized_export || grant.raw_text_retention || grant.model_training_use, false);
      }
      assert.equal(grant.research_analysis, grant.guardian_consent);
    }
  });

  it("the enrollment advances exactly when the stored record carries guardian consent", () => {
    for (const { p, g } of cases) {
      const answer = guardian(...g);
      const grant = effective(participant(p), answer);
      assert.equal(guardianDecisionFor(answer) === "confirmed", grant.guardian_consent);
    }
  });
});

describe("reading a guardian's answer", () => {
  it("has three items, all off unless exactly true", () => {
    assert.deepEqual([...GUARDIAN_CONSENT_ITEMS], ["app_use", "research_analysis", "raw_text_retention"]);
    for (const value of [undefined, null, "", "garbage", 7, [], {}, { app_use: "true", research_analysis: 1, raw_text_retention: null }]) {
      assert.deepEqual(normalizeGuardianGrants(value, DOC), {
        app_use: false,
        research_analysis: false,
        raw_text_retention: false,
        document_version: DOC,
      });
    }
  });

  it("takes the document version from the server, not from the answer", () => {
    const grants = normalizeGuardianGrants({ app_use: true, document_version: "something-else", model_training_use: true }, DOC);
    assert.equal(grants.document_version, DOC);
    assert.equal("model_training_use" in grants, false, "an item a guardian is not asked about was accepted");
  });

  it("retention alone decides nothing", () => {
    assert.equal(guardianDecisionFor(guardian(true, true, false)), "confirmed");
    assert.equal(guardianDecisionFor(guardian(true, false, true)), "declined");
    assert.equal(guardianDecisionFor(guardian(false, true, true)), "declined");
  });
});

describe("after the guardian has answered", () => {
  const approved = effective(participant({ raw_text_retention: true, anonymized_export: true }), guardian(true, true, false));
  const later = (requested) =>
    participantConsentGrant(
      { app_use: true, research_analysis: true, minor_assent: true, ...requested },
      { guardianRequired: true, guardianConfirmed: true, approvedScope: approved },
    );

  it("the participant cannot turn on what the guardian turned off", () => {
    assert.equal(later({ raw_text_retention: true }).raw_text_retention, false);
    assert.equal(later({ model_training_use: true }).model_training_use, false);
  });

  it("the participant can still withdraw an item on their own", () => {
    assert.equal(later({ anonymized_export: true }).anonymized_export, true);
    assert.equal(later({ anonymized_export: false }).anonymized_export, false);
    assert.equal(later({ research_analysis: false }).research_analysis, false);
  });
});

describe("a bulk confirmation from before the answer was itemised", () => {
  it("still approves what was asked, as it did when it was given", () => {
    const child = participant({ raw_text_retention: true, model_training_use: true });
    const grant = guardianConsentGrant(child.requested, child.record);
    assert.deepEqual(
      [grant.research_analysis, grant.raw_text_retention, grant.model_training_use, grant.guardian_consent],
      [true, true, true, true],
    );
    assert.deepEqual(guardianConsentGrant(child.requested, child.record, null), grant);
  });
});
