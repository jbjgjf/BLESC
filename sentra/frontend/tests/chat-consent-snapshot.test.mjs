/**
 * The consent recorded on a conversation is the consent the participant gave
 * (#238).
 *
 * `/api/chat` and `/api/voice/turn` wrote `{ app_use: true, research_analysis:
 * true }` onto every `chat_sessions` row — the defect #134 fixed in the browser
 * writer and the entry writer, left standing in the two server routes. A
 * withdrawn participant's conversation read, to anyone checking it later, as
 * research-consented.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { chatSessionConsentSnapshot } from "../src/lib/server/consentStore.ts";

const read = (relative) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

const OWNER = "owner-1";
const PARTICIPANT = "participant-1";

/**
 * Just enough of a Supabase client to answer the one query `consentStore`
 * makes: the newest `consent_records` row for an owner and participant.
 */
function fakeClient({ rows = [], error = null } = {}) {
  return {
    from(table) {
      assert.equal(table, "consent_records");
      const filters = [];
      const chain = {
        select: () => chain,
        eq(column, value) {
          filters.push((row) => row[column] === value);
          return chain;
        },
        order: () => chain,
        limit: () => chain,
        async maybeSingle() {
          if (error) return { data: null, error };
          const matching = rows
            .filter((row) => filters.every((match) => match(row)))
            .sort((a, b) => (a.granted_at < b.granted_at ? 1 : -1));
          return { data: matching[0] ?? null, error: null };
        },
      };
      return chain;
    },
  };
}

const FULL_GRANT = {
  owner_user_id: OWNER,
  participant_id: PARTICIPANT,
  app_use: true,
  research_analysis: true,
  anonymized_export: true,
  raw_text_retention: true,
  model_training_use: false,
  minor_assent: true,
  guardian_consent: true,
  consent_version: "research-consent-v2",
  document_version: "doc-v1",
  status: "active",
  granted_at: "2026-09-01T00:00:00Z",
  revoked_at: null,
};

describe("what a conversation's consent snapshot says", () => {
  it("does not record research consent for a participant with no consent record", async () => {
    const snapshot = await chatSessionConsentSnapshot(fakeClient(), OWNER, PARTICIPANT, "student_ui");
    assert.equal(snapshot.research_analysis, false);
    assert.equal(snapshot.research_use_allowed, false);
    assert.equal(snapshot.source, "student_ui");
  });

  it("does not record research consent once the participant has withdrawn", async () => {
    const revoked = {
      ...FULL_GRANT,
      research_analysis: false,
      anonymized_export: false,
      raw_text_retention: false,
      minor_assent: false,
      guardian_consent: false,
      status: "revoked",
      granted_at: "2026-09-10T00:00:00Z",
      revoked_at: "2026-09-10T00:00:00Z",
    };
    const snapshot = await chatSessionConsentSnapshot(
      fakeClient({ rows: [FULL_GRANT, revoked] }),
      OWNER,
      PARTICIPANT,
      "student_voice",
    );
    assert.equal(snapshot.status, "revoked");
    assert.equal(snapshot.research_analysis, false);
    assert.equal(snapshot.research_use_allowed, false);
    assert.equal(snapshot.source, "student_voice");
  });

  it("records the optional grants, which the constant never carried", async () => {
    const snapshot = await chatSessionConsentSnapshot(
      fakeClient({ rows: [FULL_GRANT] }),
      OWNER,
      PARTICIPANT,
      "student_ui",
    );
    assert.equal(snapshot.research_analysis, true);
    assert.equal(snapshot.research_use_allowed, true);
    assert.equal(snapshot.raw_text_retention, true);
    assert.equal(snapshot.anonymized_export, true);
    assert.equal(snapshot.model_training_use, false);
    assert.equal(snapshot.document_version, "doc-v1");
  });

  it("keeps the research grant apart from the decision when a guardian has not consented", async () => {
    const snapshot = await chatSessionConsentSnapshot(
      fakeClient({ rows: [{ ...FULL_GRANT, guardian_consent: false }] }),
      OWNER,
      PARTICIPANT,
      "student_ui",
    );
    assert.equal(snapshot.research_analysis, true);
    assert.equal(snapshot.research_use_allowed, false);
  });

  it("says it does not know, rather than guessing, when there is no service-role client", async () => {
    const snapshot = await chatSessionConsentSnapshot(null, OWNER, PARTICIPANT, "student_ui");
    assert.equal(snapshot.status, "unknown");
    assert.equal(snapshot.unknown_reason, "consent_store_unavailable");
    assert.equal(snapshot.research_use_allowed, false);
    assert.notEqual(snapshot.research_analysis, true);
    assert.equal(snapshot.source, "student_ui");
  });

  it("says it does not know when the consent table could not be read", async () => {
    const warn = console.warn;
    console.warn = () => {};
    try {
      const snapshot = await chatSessionConsentSnapshot(
        fakeClient({ rows: [FULL_GRANT], error: { message: "connection reset" } }),
        OWNER,
        PARTICIPANT,
        "student_voice",
      );
      assert.equal(snapshot.status, "unknown");
      assert.equal(snapshot.unknown_reason, "consent_lookup_failed");
      assert.notEqual(snapshot.research_analysis, true);
      assert.equal(snapshot.research_use_allowed, false);
    } finally {
      console.warn = warn;
    }
  });
});

describe("the server routes use it", () => {
  for (const [path, source] of [
    ["../src/app/api/chat/route.ts", "student_ui"],
    ["../src/app/api/voice/turn/route.ts", "student_voice"],
  ]) {
    it(`${path} writes the stored consent, not a constant`, () => {
      const route = code(read(path));
      assert.doesNotMatch(route, /research_analysis:\s*true/);
      assert.match(route, /consent_snapshot_json:\s*await chatSessionConsentSnapshot\(/);
      assert.ok(route.includes(`"${source}"`), `${path} no longer tags its snapshot with ${source}`);
    });
  }
});
