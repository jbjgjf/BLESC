/**
 * Withdrawal is one act, and it finishes (#263).
 *
 * There were two withdrawals. `/pilot/join`「参加をやめる」 moved the enrollment
 * and left the consent granting research use, with the retained journal text
 * waiting out its expiry and nobody having asked the participant about it.
 * `/consent`「同意を撤回する」 revoked and purged and left the enrollment
 * `collecting`, so the journal stayed open and the dashboard kept counting the
 * participant as one while reporting `withdrawn: 0`.
 *
 * Neither screen could finish what its button said. `withdrawal.ts` is the
 * whole act; this is what it has to guarantee.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  purgedRawTextCount,
  withdrawParticipation,
  withdrawalMessage,
} from "../src/lib/server/withdrawal.ts";

const read = (relative) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

/** Comments state the rules, so a naive grep finds a rule inside its rationale. */
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

const CONSENT_ROW = {
  app_use: true,
  research_analysis: false,
  anonymized_export: false,
  raw_text_retention: false,
  model_training_use: false,
  minor_assent: false,
  guardian_consent: false,
  consent_version: "v1",
  document_version: "d1",
  status: "revoked",
  granted_at: "2026-09-27T00:00:00.000Z",
  revoked_at: "2026-09-27T00:00:00.000Z",
  created_at: "2026-09-27T00:00:00.000Z",
};

/**
 * A Supabase double, built around what this module actually calls.
 *
 * Every call is recorded, because half of what is being asserted is *that a
 * step was attempted* — the old defect was steps quietly not happening, which
 * a return value alone cannot show.
 */
function makeService({
  enrollments = [],
  consentError = null,
  transitions = {},
  purgeError = null,
  purgeData = 0,
} = {}) {
  const calls = { consentInserts: [], transitions: [], rpc: [] };

  const service = {
    calls,
    from(table) {
      const state = { table, op: "select" };
      const builder = {
        select: () => builder,
        insert(row) {
          state.op = "insert";
          state.row = row;
          return builder;
        },
        eq: () => builder,
        not: () => builder,
        order: () => builder,
        limit: () => builder,
        maybeSingle: () => Promise.resolve(resolve(state, "maybeSingle")),
        single: () => Promise.resolve(resolve(state, "single")),
        then: (onFulfilled, onRejected) =>
          Promise.resolve(resolve(state, "list")).then(onFulfilled, onRejected),
      };
      return builder;
    },
    rpc(name, args) {
      calls.rpc.push({ name, args });
      if (name === "advance_pilot_enrollment") {
        calls.transitions.push(args);
        const outcome = transitions[args.p_enrollment_id] ?? "ok";
        return Promise.resolve({
          data: [{ state: outcome === "ok" ? "withdrawn" : "collecting", outcome }],
          error: null,
        });
      }
      if (name === "purge_raw_text_for_participant") {
        return Promise.resolve({ data: purgeError ? null : purgeData, error: purgeError });
      }
      throw new Error(`unexpected rpc ${name}`);
    },
  };

  function resolve(state, terminal) {
    if (state.table === "consent_records" && state.op === "insert") {
      calls.consentInserts.push(state.row);
      return consentError
        ? { data: null, error: { message: consentError } }
        : { data: { ...CONSENT_ROW }, error: null };
    }
    if (state.table === "pilot_enrollments") {
      // `maybeSingle` is the ownership check inside `advanceEnrollment`; the
      // awaited builder is the list of live enrollments.
      if (terminal === "maybeSingle") return { data: { id: "owned" }, error: null };
      return { data: enrollments, error: null };
    }
    throw new Error(`unexpected read of ${state.table}`);
  }

  return service;
}

const live = (id, state = "collecting") => ({ id, state, is_minor: true });

const params = (overrides = {}) => ({
  ownerUserId: "user-1",
  participantId: "participant-1",
  disposition: "delete",
  actor: "participant",
  source: "test",
  ...overrides,
});

describe("all three steps happen", () => {
  it("revokes consent, withdraws every live enrollment, and purges", async () => {
    const service = makeService({ enrollments: [live("e1"), live("e2")], purgeData: 7 });

    const result = await withdrawParticipation(service, params());

    assert.equal(result.consent.outcome, "revoked");
    assert.equal(result.enrollment.outcome, "withdrawn");
    assert.deepEqual(result.enrollment.withdrawn, ["e1", "e2"]);
    assert.equal(result.raw_text.outcome, "purged");
    assert.equal(result.raw_text.purged, 7);
    assert.equal(result.complete, true);
  });

  it("withdraws every live enrollment, not just the newest", async () => {
    // One person may be enrolled in more than one study — the export already
    // assumes so. Stopping at the first row leaves the others collecting.
    const service = makeService({ enrollments: [live("e1"), live("e2"), live("e3")] });

    await withdrawParticipation(service, params());

    assert.deepEqual(
      service.calls.transitions.map((call) => call.p_enrollment_id),
      ["e1", "e2", "e3"],
    );
    for (const call of service.calls.transitions) {
      assert.equal(call.p_to_state, "withdrawn");
    }
  });

  it("records the disposition on the revocation row", async () => {
    const service = makeService({ enrollments: [live("e1")] });

    await withdrawParticipation(service, params({ disposition: "keep" }));

    assert.equal(service.calls.consentInserts[0].retained_data_disposition, "keep");
    assert.equal(service.calls.consentInserts[0].status, "revoked");
  });
});

describe("keep governs destruction only", () => {
  it("keeps the text without purging anything", async () => {
    const service = makeService({ enrollments: [live("e1")] });

    const result = await withdrawParticipation(service, params({ disposition: "keep" }));

    assert.equal(result.raw_text.outcome, "kept");
    // Zero, and said alongside `retained_data: "keep"` — `purged_raw_text: 0`
    // on its own reads as "deleted nothing", which is what a failed delete
    // also looks like.
    assert.equal(result.raw_text.purged, 0);
    assert.equal(result.retained_data, "keep");
    assert.equal(
      service.calls.rpc.some((call) => call.name === "purge_raw_text_for_participant"),
      false,
    );
  });

  it("still ends the participation", async () => {
    // The misreading this guards against is "they said keep, so we may carry
    // on". Keep is about the text, never about use.
    const service = makeService({ enrollments: [live("e1")] });

    const result = await withdrawParticipation(service, params({ disposition: "keep" }));

    assert.equal(result.enrollment.outcome, "withdrawn");
    assert.equal(service.calls.consentInserts[0].research_analysis, false);
    assert.equal(service.calls.consentInserts[0].model_training_use, false);
  });
});

describe("no step may abort the others", () => {
  it("attempts the rest when consent cannot be written", async () => {
    const service = makeService({ enrollments: [live("e1")], consentError: "consent boom" });

    const result = await withdrawParticipation(service, params());

    assert.equal(result.consent.outcome, "failed");
    // A participant who has said they want to leave is not served by a request
    // that gives up on step 1.
    assert.equal(result.enrollment.outcome, "withdrawn");
    assert.equal(result.raw_text.outcome, "purged");
    assert.equal(result.complete, false);
  });

  it("has already stopped collection when the purge fails", async () => {
    // Destruction is last precisely so that this ordering holds: the
    // irreversible step cannot leave the reversible ones undone.
    const service = makeService({
      enrollments: [live("e1")],
      purgeError: { message: "purge boom" },
    });

    const result = await withdrawParticipation(service, params());

    assert.equal(result.consent.outcome, "revoked");
    assert.equal(result.enrollment.outcome, "withdrawn");
    assert.equal(result.raw_text.outcome, "failed");
    assert.equal(result.raw_text.purged, null);
    assert.equal(result.complete, false);
  });

  it("reports a refused transition without claiming the rest failed", async () => {
    const service = makeService({
      enrollments: [live("e1"), live("e2")],
      transitions: { e2: "error" },
    });

    const result = await withdrawParticipation(service, params());

    assert.equal(result.enrollment.outcome, "failed");
    assert.deepEqual(result.enrollment.withdrawn, ["e1"]);
    assert.deepEqual(result.enrollment.failed, ["e2"]);
    assert.equal(result.complete, false);
  });
});

describe("what is not a failure", () => {
  it("no live enrollment is reported as none, and the act still completes", async () => {
    // An ordinary deployment with no study, or someone who already left.
    // Reporting "failed" would tell the participant something went wrong when
    // nothing did.
    const service = makeService({ enrollments: [] });

    const result = await withdrawParticipation(service, params());

    assert.equal(result.enrollment.outcome, "none");
    assert.equal(result.consent.outcome, "revoked");
    assert.equal(result.complete, true);
  });

  it("an enrollment that went terminal in the meantime counts as withdrawn", async () => {
    const service = makeService({ enrollments: [live("e1")], transitions: { e1: "terminal" } });

    const result = await withdrawParticipation(service, params());

    assert.equal(result.enrollment.outcome, "withdrawn");
    assert.equal(result.complete, true);
  });
});

describe("a purge count that is not a count", () => {
  it("is null rather than a quiet zero", () => {
    // Same rule as `retentionPurge.purgedCount`: `Number(null)` is 0, and a
    // participant must not be told their text was deleted on the strength of a
    // call that did not say so.
    assert.equal(purgedRawTextCount(4), 4);
    assert.equal(purgedRawTextCount(0), 0);
    assert.equal(purgedRawTextCount(null), null);
    assert.equal(purgedRawTextCount(undefined), null);
    assert.equal(purgedRawTextCount("4"), null);
    assert.equal(purgedRawTextCount(Number.NaN), null);
  });

  it("travels to the result rather than being rounded off", async () => {
    const service = makeService({ enrollments: [live("e1")], purgeData: null });

    const result = await withdrawParticipation(service, params());

    assert.equal(result.raw_text.purged, null);
  });
});

describe("the participant is told what actually happened", () => {
  it("a partial withdrawal never says only that it withdrew", async () => {
    const service = makeService({
      enrollments: [live("e1")],
      purgeError: { message: "purge boom" },
    });

    const message = withdrawalMessage(await withdrawParticipation(service, params()));

    assert.match(message, /完了していません/);
    assert.match(message, /保管していた本文の削除/);
  });

  it("names every step that did not finish", async () => {
    const service = makeService({
      enrollments: [live("e1")],
      consentError: "boom",
      transitions: { e1: "error" },
      purgeError: { message: "boom" },
    });

    const message = withdrawalMessage(await withdrawParticipation(service, params()));

    assert.match(message, /同意の撤回/);
    assert.match(message, /研究への参加の停止/);
    assert.match(message, /保管していた本文の削除/);
  });

  it("distinguishes kept from deleted on the way out", async () => {
    const service = makeService({ enrollments: [live("e1")] });

    const kept = withdrawalMessage(
      await withdrawParticipation(service, params({ disposition: "keep" })),
    );
    const deleted = withdrawalMessage(await withdrawParticipation(service, params()));

    assert.match(kept, /保存期間が終わるまで残ります/);
    assert.match(deleted, /削除されました/);
    assert.notEqual(kept, deleted);
  });
});

describe("both screens reach the same act", () => {
  const consentRoute = code(read("../src/app/api/consent/route.ts"));
  const enrollmentRoute = code(read("../src/app/api/pilot/enrollment/route.ts"));
  const joinPage = code(read("../src/app/pilot/join/page.tsx"));
  const client = code(read("../src/api/client.ts"));

  it("the consent route no longer revokes on its own", () => {
    assert.match(consentRoute, /withdrawParticipation\(/);
    assert.doesNotMatch(consentRoute, /revokeConsent\(/);
  });

  it("the consent route no longer purges on its own", () => {
    // It used to call the RPC directly, which is how it came to be the only
    // path that knew about the retained text.
    assert.doesNotMatch(consentRoute, /purge_raw_text_for_participant/);
  });

  it("the enrollment route routes withdrawal through the same act", () => {
    assert.match(enrollmentRoute, /to === "withdrawn"/);
    assert.match(enrollmentRoute, /withdrawParticipation\(/);
  });

  it("both routes answer 502 on a partial withdrawal", () => {
    for (const route of [consentRoute, enrollmentRoute]) {
      assert.match(route, /complete \? 200 : 502/);
    }
  });

  it("both routes read only the exact string as keep", () => {
    for (const route of [consentRoute, enrollmentRoute]) {
      assert.match(route, /retained_data === "keep" \? "keep" : "delete"/);
    }
  });

  it("the join screen asks the same question the consent screen does", () => {
    assert.match(joinPage, /保管してある日記の本文をどうしますか/);
    assert.match(joinPage, /withdraw\("delete"\)/);
    assert.match(joinPage, /withdraw\("keep"\)/);
    assert.match(joinPage, /元に戻せません/);
  });

  it("the join screen cannot withdraw without choosing", () => {
    // The old button went straight to the transition. Nothing may reach
    // withdrawal from this screen except through the choice.
    assert.doesNotMatch(joinPage, /advancePilotEnrollment\([^)]*"withdrawn"/);
  });

  it("the transition helper will not accept withdrawal at all", () => {
    assert.match(client, /to: Exclude<PilotState, "withdrawn">/);
  });
});
