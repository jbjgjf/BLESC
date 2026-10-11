/**
 * Prints the SQL that creates the ten dry-run invitations (#168, #384).
 *
 *   PILOT_INVITE_HMAC_KEY=... node scripts/dry-run-invitations.mjs \
 *     | psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1
 *
 * Run it after `supabase/seed/pilot_dry_run.seed.sql`, with the same
 * `PILOT_INVITE_HMAC_KEY` the deployment under test has.
 *
 * This is a script and not part of the SQL seed because the stored value is
 * HMAC-SHA256(code) under that key, and the key lives in the application's
 * environment, never in Postgres. The seed used to store a plain SHA-256 —
 * a value the redeem route never computes, so none of the ten codes could be
 * redeemed. Hashing here, with the route's own `hashInviteCode`, is what keeps
 * the two from disagreeing again. Only hashes are printed.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { hashInviteCode, inviteCodePrefix, normalizeInviteCode } from "../src/lib/server/inviteCodes.ts";
import { DRY_RUN_STUDY_ID, dryRunInviteCode } from "./dry-run-codes.mjs";

const MATRIX_PATH = fileURLToPath(
  new URL("../../../docs/pilot/dry-run/scenario-matrix.json", import.meta.url),
);

/** Account 3 is the expired-code scenario. */
const EXPIRED_ACCOUNT_ID = 3;

/** The statements, or a thrown Error naming why they cannot be produced. */
export function buildInvitationSql(matrix) {
  const rows = matrix.accounts.map((account) => {
    const code = dryRunInviteCode(account.id);
    const normalized = normalizeInviteCode(code);
    if (!normalized) throw new Error(`${code} is not a redeemable code`);

    const hash = hashInviteCode(code);
    if (!hash) {
      throw new Error(
        "PILOT_INVITE_HMAC_KEY is missing or is not base64 for at least 32 bytes; " +
          "use the key of the deployment the dry run targets",
      );
    }

    const expires =
      account.id === EXPIRED_ACCOUNT_ID ? "now() - interval '1 day'" : "now() + interval '14 days'";
    // The age band travels on the invitation (20260909000000). Left null,
    // redemption falls back to "minor" and every adult scenario stops at the
    // guardian gate.
    return (
      `  ('${DRY_RUN_STUDY_ID}', '${hash}', '${inviteCodePrefix(normalized)}', ` +
      `'${account.is_minor ? "minor" : "adult"}', ${account.is_minor}, 1, 0, ${expires}, ` +
      `'dry-run scenario ${Number(account.id)}')`
    );
  });

  return [
    "begin;",
    // Re-runnable while nothing has been redeemed. Once an enrollment points at
    // an invitation this fails on the foreign key, which is the right answer:
    // re-issuing codes mid-exercise means starting the exercise again.
    `delete from public.pilot_invitations where study_id = '${DRY_RUN_STUDY_ID}';`,
    "insert into public.pilot_invitations (",
    "  study_id, code_hash, code_prefix, cohort, is_minor, max_redemptions, redeemed_count,",
    "  expires_at, note",
    ") values",
    `${rows.join(",\n")};`,
    "commit;",
    "",
  ].join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const matrix = JSON.parse(await readFile(MATRIX_PATH, "utf8"));
    process.stdout.write(buildInvitationSql(matrix));
  } catch (error) {
    console.error(`dry-run-invitations: ${error.message}`);
    process.exit(1);
  }
}
