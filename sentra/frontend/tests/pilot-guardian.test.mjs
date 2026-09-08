import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  GUARDIAN_REVIEWABLE_GRANTS,
  GUARDIAN_TOKEN_TTL_HOURS,
  canRequestGuardianVerification,
  guardianConsentGrant,
  guardianRequired,
  guardianTokenUsable,
  guardianVerificationStatus,
  normalizeRequestedGrants,
  participantConsentGrant,
} from "../src/lib/guardianVerification.ts";
import { NO_CONSENT } from "../src/lib/consent.ts";

const MIGRATION = fileURLToPath(
  new URL("../../supabase/migrations/20260908000000_pilot_guardian_verification.sql", import.meta.url),
);
const CONSENT_ROUTE = fileURLToPath(new URL("../src/app/api/consent/route.ts", import.meta.url));
const CONSENT_PAGE = fileURLToPath(new URL("../src/app/consent/page.tsx", import.meta.url));
const API_DIR = fileURLToPath(new URL("../src/app/api", import.meta.url));

const minor = (state) => ({ state, is_minor: true });
const adult = (state) => ({ state, is_minor: false });

const hoursFromNow = (hours) => new Date(Date.now() + hours * 3600 * 1000).toISOString();

const row = (overrides = {}) => ({
  expires_at: hoursFromNow(24),
  claimed_at: null,
  decision: null,
  decided_at: null,
  revoked_at: null,
  ...overrides,
});

describe("who needs a guardian", () => {
  it("asks for one for a minor and not for an adult", () => {
    assert.equal(guardianRequired(minor("participant_assented")), true);
    assert.equal(guardianRequired(adult("participant_assented")), false);
  });

  it("issues a link only once the participant has assented themselves", () => {
    assert.equal(canRequestGuardianVerification(minor("account_bound")), false);
    assert.equal(canRequestGuardianVerification(minor("information_read")), false);
    assert.equal(canRequestGuardianVerification(minor("participant_assented")), true);
    // Already answered: a second link would ask a question that is settled.
    assert.equal(canRequestGuardianVerification(minor("guardian_verified")), false);
    assert.equal(canRequestGuardianVerification(minor("enrolled")), false);
  });

  it("never issues one for an adult, in any state", () => {
    for (const state of ["information_read", "participant_assented", "enrolled", "collecting"]) {
      assert.equal(canRequestGuardianVerification(adult(state)), false);
    }
  });
});

describe("guardianVerificationStatus", () => {
  it("reads an absent row as nothing asked yet", () => {
    assert.equal(guardianVerificationStatus(null), "none");
  });

  it("reads a live unanswered row as pending", () => {
    assert.equal(guardianVerificationStatus(row()), "pending");
    assert.equal(guardianTokenUsable(row()), true);
  });

  it("reads a passed expiry as expired", () => {
    assert.equal(guardianVerificationStatus(row({ expires_at: hoursFromNow(-1) })), "expired");
    assert.equal(guardianTokenUsable(row({ expires_at: hoursFromNow(-1) })), false);
  });

  it("keeps a decision that was made before the expiry", () => {
    // The ordering that matters: a guardian who confirmed in the last hour of
    // the window confirmed, and reporting "expired" afterwards would lose a
    // consent that was actually given.
    const confirmed = row({ expires_at: hoursFromNow(-1), decision: "confirmed", decided_at: hoursFromNow(-2) });
    assert.equal(guardianVerificationStatus(confirmed), "confirmed");
  });

  it("keeps a decision that was made before the row was superseded", () => {
    const declined = row({ decision: "declined", decided_at: hoursFromNow(-1), revoked_at: hoursFromNow(-0.5) });
    assert.equal(guardianVerificationStatus(declined), "declined");
  });

  it("reads a superseded, unanswered row as revoked and unusable", () => {
    assert.equal(guardianVerificationStatus(row({ revoked_at: hoursFromNow(-1) })), "revoked");
    assert.equal(guardianTokenUsable(row({ revoked_at: hoursFromNow(-1) })), false);
  });
});

describe("participantConsentGrant", () => {
  const asked = {
    app_use: true,
    research_analysis: true,
    anonymized_export: true,
    raw_text_retention: true,
    future_fine_tuning: true,
    minor_assent: true,
    guardian_consent: true,
  };

  it("drops guardian_consent even when the request asserts it", () => {
    const grant = participantConsentGrant(asked, { guardianRequired: true, guardianConfirmed: false });
    assert.equal(grant.guardian_consent, false);
  });

  it("drops guardian_consent for an adult too, where nothing required it", () => {
    // The rule has no exception. An adult's own session asserting a guardian's
    // consent is still a session asserting someone else's decision.
    const grant = participantConsentGrant(asked, { guardianRequired: false, guardianConfirmed: false });
    assert.equal(grant.guardian_consent, false);
  });

  it("holds research use back until a guardian has confirmed", () => {
    const grant = participantConsentGrant(asked, { guardianRequired: true, guardianConfirmed: false });
    assert.equal(grant.research_analysis, false);
    assert.equal(grant.anonymized_export, false);
    assert.equal(grant.raw_text_retention, false);
    assert.equal(grant.future_fine_tuning, false);
    // The participant's own half is recorded — it was really given.
    assert.equal(grant.minor_assent, true);
    assert.equal(grant.app_use, true);
  });

  it("lets research use through once the stored record carries a guardian", () => {
    const grant = participantConsentGrant(asked, { guardianRequired: true, guardianConfirmed: true });
    assert.equal(grant.research_analysis, true);
    assert.equal(grant.raw_text_retention, true);
    assert.equal(grant.guardian_consent, true);
  });

  it("lets an adult through with no guardian at all", () => {
    const grant = participantConsentGrant(asked, { guardianRequired: false, guardianConfirmed: false });
    assert.equal(grant.research_analysis, true);
  });

  it("reads an omitted grant as a refusal, never as an inherited yes", () => {
    const grant = participantConsentGrant({ app_use: true }, { guardianRequired: false, guardianConfirmed: false });
    assert.equal(grant.research_analysis, false);
    assert.equal(grant.minor_assent, false);
    assert.equal(grant.future_fine_tuning, false);
  });

  it("only accepts a literal true", () => {
    const grant = participantConsentGrant(
      { app_use: "yes", research_analysis: 1, minor_assent: "true" },
      { guardianRequired: false, guardianConfirmed: false },
    );
    assert.equal(grant.app_use, false);
    assert.equal(grant.research_analysis, false);
    assert.equal(grant.minor_assent, false);
  });
});

describe("guardianConsentGrant", () => {
  it("carries the participant's assent rather than asserting it", () => {
    const grant = guardianConsentGrant(
      normalizeRequestedGrants({ raw_text_retention: true }, "doc-v1"),
      { ...NO_CONSENT, app_use: true, minor_assent: true },
    );
    assert.equal(grant.minor_assent, true);
    assert.equal(grant.guardian_consent, true);
    assert.equal(grant.research_analysis, true);
    assert.equal(grant.raw_text_retention, true);
    assert.equal(grant.anonymized_export, false);
  });

  it("produces a record the enrollment gate will refuse when the assent is missing", () => {
    // A guardian confirming for a participant who never assented is a state the
    // flow should not reach. If it does, the record says so rather than
    // inventing the missing half.
    const grant = guardianConsentGrant(normalizeRequestedGrants({}, "doc-v1"), { ...NO_CONSENT });
    assert.equal(grant.minor_assent, false);
    assert.equal(grant.guardian_consent, true);
  });

  it("cannot be talked into a grant the participant did not ask for", () => {
    const grant = guardianConsentGrant(
      normalizeRequestedGrants({ future_fine_tuning: false }, "doc-v1"),
      { ...NO_CONSENT, minor_assent: true, future_fine_tuning: true },
    );
    // The token says what was asked. The stored record's own optional flags do
    // not leak into the guardian's answer.
    assert.equal(grant.future_fine_tuning, false);
  });
});

describe("normalizeRequestedGrants", () => {
  it("defaults every reviewable grant to false", () => {
    const grants = normalizeRequestedGrants(null, "doc-v9");
    for (const key of GUARDIAN_REVIEWABLE_GRANTS) assert.equal(grants[key], false);
    assert.equal(grants.document_version, "doc-v9");
  });

  it("keeps the document version the participant was shown", () => {
    const grants = normalizeRequestedGrants({ document_version: "doc-v1" }, "doc-v9");
    assert.equal(grants.document_version, "doc-v1");
  });
});

describe("the routes that may write a guardian's consent", () => {
  it("is only the confirm route", () => {
    // The regression this guards: `guardian_consent: true` appearing anywhere
    // a signed-in participant's request reaches. If a new route needs it, that
    // is a decision to make deliberately, not one to make by adding a field.
    const offenders = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
          walk(path);
          continue;
        }
        if (!entry.name.endsWith(".ts")) continue;
        if (path.includes("/pilot/guardian/")) continue;
        if (/guardian_consent\s*:\s*true/.test(readFileSync(path, "utf8"))) offenders.push(path);
      }
    };
    walk(API_DIR);
    assert.deepEqual(offenders, []);
  });

  it("does not accept guardian_consent from the consent route's body", () => {
    const source = readFileSync(CONSENT_ROUTE, "utf8");
    // The field is typed `never`, and the grant is built by the shared helper
    // rather than spread from the body.
    assert.match(source, /guardian_consent\?:\s*never/);
    assert.match(source, /participantConsentGrant\(/);
    assert.doesNotMatch(source, /recordConsent\([^)]*\bbody\b\s*,/);
  });

  it("gives the student no control that claims a guardian agreed", () => {
    const source = readFileSync(CONSENT_PAGE, "utf8");
    // There is no input bound to guardian consent on the participant's screen.
    assert.doesNotMatch(source, /onChange=\{\(event\) => setGuardian\(/);
    assert.doesNotMatch(source, /guardian_consent:\s*guardian/);
  });
});

describe("the migration", () => {
  const sql = readFileSync(MIGRATION, "utf8");

  it("widens the actor vocabulary so a guardian is recorded as one", () => {
    assert.match(sql, /actor in \('participant', 'operator', 'system', 'guardian'\)/);
  });

  it("gives the browser no access to the verification table", () => {
    assert.match(sql, /revoke all on public\.pilot_guardian_verifications from public, anon, authenticated/);
    assert.doesNotMatch(sql, /grant [^;]*on public\.pilot_guardian_verifications to (anon|authenticated)/);
  });

  it("keeps a decision and its timestamp together", () => {
    assert.match(sql, /check \(\(decision is null\) = \(decided_at is null\)\)/);
  });

  it("does not let the research role read the token hash", () => {
    const grant = sql.match(/grant select \(([^)]*)\)\s*\n\s*on public\.pilot_guardian_verifications to research_reader/);
    assert.ok(grant, "expected a column-level grant to research_reader");
    assert.doesNotMatch(grant[1], /token_hash/);
  });
});

describe("the token", () => {
  it("gives a guardian long enough to answer without leaving a link live for weeks", () => {
    assert.equal(GUARDIAN_TOKEN_TTL_HOURS, 72);
  });
});
