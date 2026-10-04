/**
 * Withdrawal is one procedure, and it lets the participant decide what happens
 * to what was collected (#224, #263).
 *
 * Two histories are locked down here.
 *
 * #224: withdrawal used to be one button that meant "withdraw, and destroy
 * the text", with no second step and no alternative. The replacement has two
 * asymmetries:
 *
 *   1. Only the exact string "keep" keeps. Anything else deletes, because a
 *      request that did not say is not a request to keep.
 *   2. "Keep" is about destruction, never about use.
 *
 * #263: there were two withdrawals and each did half. `/pilot/join` withdrew
 * the enrollment and left consent active and the text kept without asking.
 * `/consent` revoked consent and left the enrollment collecting. Both now call
 * `withdrawFromResearch` → `withdraw_from_research`, one SQL transaction. The
 * behaviour of that procedure is tested against a database in
 * `supabase/tests/withdrawal.test.sql`, and the full UI round trip from both
 * screens in `e2e/pilot-join.spec.ts`.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  parseDisposition,
  withdrawFromResearch,
  withdrawalResponseBody,
} from "../src/lib/server/withdrawal.ts";

const read = (relative) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

/** Comments state the rules, so a naive grep finds a rule inside its rationale. */
const code = (text) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");

const consentRoute = read("../src/app/api/consent/route.ts");
const enrollmentRoute = read("../src/app/api/pilot/enrollment/route.ts");
const withdrawal = read("../src/lib/server/withdrawal.ts");
const store = read("../src/lib/server/consentStore.ts");
const consentPage = read("../src/app/consent/page.tsx");
const joinPage = read("../src/app/pilot/join/page.tsx");
const choice = read("../src/components/WithdrawalChoice.tsx");
const client = read("../src/api/client.ts");
const dispositionMigration = read(
  "../../supabase/migrations/20260921020000_withdrawal_data_disposition.sql",
);
const procedureMigration = read(
  "../../supabase/migrations/20260927020000_single_withdrawal_procedure.sql",
);

/** A client that answers the one RPC this module makes. */
function fakeClient(answer) {
  const calls = [];
  return {
    calls,
    rpc: async (name, args) => {
      calls.push({ name, args });
      return answer;
    },
  };
}

const PARAMS = {
  ownerUserId: "00000000-0000-0000-0000-00000000000a",
  participantId: "00000000-0000-0000-0000-0000000000a1",
  actor: "participant",
  source: "student_ui",
};

describe("one procedure, two doors (#263)", () => {
  it("both routes withdraw through withdrawFromResearch", () => {
    assert.match(code(consentRoute), /withdrawFromResearch\(/);
    assert.match(code(enrollmentRoute), /withdrawFromResearch\(/);
  });

  it("neither route does part of the job on its own", () => {
    // The half-withdrawals that caused #263: revoking only, purging only, or
    // advancing the enrollment only.
    for (const route of [code(consentRoute), code(enrollmentRoute)]) {
      assert.doesNotMatch(route, /revokeConsent\(/);
      assert.doesNotMatch(route, /purge_raw_text_for_participant/);
    }
    assert.doesNotMatch(code(store), /export async function revokeConsent/);
  });

  it("the enrollment route handles withdrawn before the state machine can", () => {
    const body = code(enrollmentRoute);
    const branch = body.indexOf('if (to === "withdrawn")');
    const advance = body.indexOf("advanceEnrollment(service");
    assert.ok(branch > 0, "no withdrawal branch");
    assert.ok(advance > branch, "advanceEnrollment must not be reachable for a withdrawal");
  });

  it("the enrollment route checks the enrollment belongs to the caller", () => {
    assert.match(code(enrollmentRoute), /target\.owner_user_id !== auth\.user\.id/);
  });

  it("the join screen no longer advances straight to withdrawn", () => {
    assert.doesNotMatch(code(joinPage), /advancePilotEnrollment\([^)]*"withdrawn"/);
    assert.match(code(joinPage), /ApiClient\.withdrawFromPilot\(/);
  });

  it("the procedure does all three things, in one function", () => {
    const fn = procedureMigration.slice(
      procedureMigration.indexOf("create or replace function public.withdraw_from_research"),
      procedureMigration.indexOf("revoke execute on function public.withdraw_from_research"),
    );
    assert.match(fn, /set state = 'withdrawn'/);
    assert.match(fn, /insert into public\.pilot_enrollment_events/);
    assert.match(fn, /insert into public\.consent_records/);
    assert.match(fn, /'revoked'/);
    assert.match(fn, /purge_raw_text_for_participant/);
  });

  it("the procedure is not callable from the browser", () => {
    assert.match(
      procedureMigration,
      /revoke execute on function public\.withdraw_from_research\([^)]*\)\s*from public, anon, authenticated/,
    );
  });

  it("rows already split by the old behaviour are repaired", () => {
    assert.match(procedureMigration, /consent was revoked on \/consent but the enrollment was not withdrawn/);
    assert.match(procedureMigration, /'withdrawal_repair'/);
  });

  it("a repaired row does not choose for the participant", () => {
    // Deleting their text, or recording "keep", would both be writing a choice
    // the participant never made. The repair leaves it unset and the join
    // screen offers deletion.
    const repair = procedureMigration.slice(procedureMigration.indexOf("-- B."));
    assert.match(repair, /'revoked', now\(\), now\(\), null, 'withdrawal_repair'/);
    assert.doesNotMatch(repair, /purge_raw_text_for_participant\(/);
    assert.match(code(joinPage), /withdraw\("delete"\)/);
  });

  it("the dashboard counts a withdrawal by the enrollment, which both doors now set", () => {
    const dashboard = code(read("../src/app/api/research/pilot-dashboard/route.ts"));
    assert.match(dashboard, /withdrawn: enrollments\.filter\(\(row\) => row\.state === "withdrawn"\)/);
  });
});

describe("the participant cannot write their own consent record", () => {
  it("authenticated keeps SELECT only on consent_records", () => {
    assert.match(procedureMigration, /drop policy if exists "consent_records_own_all"/);
    assert.match(procedureMigration, /for select to authenticated/);
    assert.match(
      procedureMigration,
      /revoke insert, update, delete, truncate, references, trigger\s+on public\.consent_records from authenticated/,
    );
  });

  it("the browser never writes consent_records directly", () => {
    const body = code(client);
    assert.doesNotMatch(body, /from\("consent_records"\)\s*\.(insert|update|upsert|delete)/);
  });
});

describe("the choice exists and is recorded", () => {
  it("the revocation row carries the disposition", () => {
    assert.match(procedureMigration, /retained_data_disposition, source/);
    assert.match(procedureMigration, /'revoked', v_now, v_now, v_disposition/);
  });

  it("the column only accepts delete or keep", () => {
    assert.match(dispositionMigration, /in \('delete', 'keep'\)/);
  });

  it("the column cannot appear on a row that is not a revocation", () => {
    // A live consent record reading "chose delete" would quietly corrupt any
    // later count of how people withdrew.
    assert.match(dispositionMigration, /or status = 'revoked'/);
  });
});

describe("silence deletes", () => {
  it("only the exact string keeps", () => {
    assert.equal(parseDisposition("keep"), "keep");
    for (const value of [undefined, null, "", "KEEP", " keep", "keep ", true, 1, {}, "delete"]) {
      assert.equal(parseDisposition(value), "delete", `${JSON.stringify(value)} must delete`);
    }
  });

  it("both routes read the choice through parseDisposition", () => {
    assert.match(code(consentRoute), /parseDisposition\(body\.retained_data\)/);
    assert.match(code(enrollmentRoute), /parseDisposition\(body\.retained_data\)/);
  });

  it("the SQL procedure applies the same rule", () => {
    assert.match(procedureMigration, /case when p_disposition = 'keep' then 'keep' else 'delete' end/);
  });

  it("the client has no default at all", () => {
    // The screen must choose deliberately; the server default is a guard
    // against malformed requests, not an API convenience.
    const body = code(client);
    assert.match(body, /retainedData: "delete" \| "keep",/);
    assert.doesNotMatch(body, /retainedData: "delete" \| "keep" =/);
  });
});

describe("keep is not permission to carry on", () => {
  it("the export gate does not read the disposition", () => {
    // If it ever does, "keep my record" silently becomes "keep using my
    // record", which is a consent nobody gave.
    const exportRoute = code(read("../src/app/api/research/export/route.ts"));
    const exportLib = code(read("../src/lib/researchExport.ts"));
    assert.doesNotMatch(exportRoute, /retained_data_disposition/);
    assert.doesNotMatch(exportLib, /retained_data_disposition/);
  });

  it("the revocation zeroes every grant, whichever disposition", () => {
    const fn = procedureMigration.slice(
      procedureMigration.indexOf("-- (2) 同意"),
      procedureMigration.indexOf("-- (3) 本文"),
    );
    // app_use, research_analysis, anonymized_export, raw_text_retention,
    // model_training_use, minor_assent, guardian_consent
    assert.match(fn, /true, false, false, false,\s+false, false, false,/);
  });

  it("the screen says so to the participant", () => {
    assert.match(choice, /研究への協力はここで終わります/);
    assert.match(choice, /研究の分析やAIの学習に使われることはありません/);
  });
});

describe("what delete removes, and what it does not, is said before choosing (#224)", () => {
  it("names what is destroyed", () => {
    assert.match(choice, /日記の本文を、すぐに消します/);
  });

  it("names what remains after a delete, and that it is not used", () => {
    assert.match(choice, /本文を削除しても残るもの/);
    assert.match(choice, /自己評定/);
    assert.match(choice, /研究の分析・研究用の書き出し・AIの学習には使われません/);
  });

  it("both screens show the same choice", () => {
    assert.match(code(consentPage), /<WithdrawalChoice/);
    assert.match(code(joinPage), /<WithdrawalChoice/);
  });
});

describe("the irreversible option is not one click away", () => {
  it("withdrawing opens a choice rather than acting, on both screens", () => {
    assert.match(code(consentPage), /onClick=\{\(\) => setWithdrawing\(true\)\}/);
    assert.match(code(joinPage), /onClick=\{\(\) => setConfirming\(true\)\}/);
  });

  it("both outcomes are offered, and so is backing out", () => {
    const body = code(choice);
    assert.match(body, /onChoose\("delete"\)/);
    assert.match(body, /onChoose\("keep"\)/);
    assert.match(body, /onClick=\{onCancel\}/);
    assert.match(code(consentPage), /onCancel=\{\(\) => setWithdrawing\(false\)\}/);
    assert.match(code(joinPage), /onCancel=\{\(\) => setConfirming\(false\)\}/);
  });

  it("tells the participant which one cannot be undone", () => {
    assert.match(choice, /元に戻せません/);
  });
});

describe("the response cannot be misread", () => {
  it("sends the choice and the versions to the procedure", async () => {
    const client = fakeClient({
      data: [{ enrollments_withdrawn: 1, disposition: "keep", purged_raw_text: 0 }],
      error: null,
    });
    const result = await withdrawFromResearch(client, { ...PARAMS, disposition: "keep" });

    assert.equal(client.calls.length, 1);
    assert.equal(client.calls[0].name, "withdraw_from_research");
    assert.equal(client.calls[0].args.p_disposition, "keep");
    assert.equal(client.calls[0].args.p_participant_id, PARAMS.participantId);
    assert.ok(client.calls[0].args.p_consent_version);
    assert.ok(client.calls[0].args.p_document_version);
    assert.deepEqual(result, {
      outcome: "withdrawn",
      enrollmentsWithdrawn: 1,
      disposition: "keep",
      purgedRawText: 0,
    });
  });

  it("keeping reports zero purged alongside an explicit keep", () => {
    // `purged_raw_text: 0` on its own reads as "deleted nothing", which is what
    // a failed delete also looks like.
    const body = withdrawalResponseBody({
      outcome: "withdrawn",
      enrollmentsWithdrawn: 1,
      disposition: "keep",
      purgedRawText: 0,
    });
    assert.equal(body.retained_data, "keep");
    assert.equal(body.purged_raw_text, 0);
    assert.deepEqual(body.steps, { enrollment: "withdrawn", consent: "revoked", raw_text: "kept" });
  });

  it("an account with no enrollment is told so, not told it withdrew one", () => {
    const body = withdrawalResponseBody({
      outcome: "withdrawn",
      enrollmentsWithdrawn: 0,
      disposition: "delete",
      purgedRawText: 2,
    });
    assert.equal(body.steps.enrollment, "none_active");
    assert.equal(body.steps.raw_text, "deleted");
  });

  it("a failure says nothing changed and never says 撤回しました", async () => {
    const client = fakeClient({ data: null, error: { message: "connection reset" } });
    const result = await withdrawFromResearch(client, { ...PARAMS, disposition: "delete" });
    assert.equal(result.outcome, "not_withdrawn");

    const body = withdrawalResponseBody(result);
    assert.equal(body.status, "not_withdrawn");
    assert.deepEqual(body.steps, { enrollment: "not_done", consent: "not_done", raw_text: "not_done" });
    assert.match(body.detail, /撤回は完了していません/);
    assert.doesNotMatch(body.detail, /撤回しました/);
  });

  it("an empty answer is a failure, not a withdrawal", async () => {
    const result = await withdrawFromResearch(fakeClient({ data: [], error: null }), {
      ...PARAMS,
      disposition: "delete",
    });
    assert.equal(result.outcome, "not_withdrawn");
  });

  it("both routes answer a failure with 502", () => {
    assert.match(code(consentRoute), /withdrawalResponseBody\(result\), \{ status: 502 \}/);
    assert.match(code(enrollmentRoute), /state: target\.state \}, \{ status: 502 \}/);
  });

  it("the procedure's result is what the success message is built from", () => {
    assert.match(code(withdrawal), /result\.disposition === "keep"/);
  });
});
