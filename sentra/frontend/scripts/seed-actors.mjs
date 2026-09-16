/**
 * Bulk creation of A1 (student) accounts for demos and load checks.
 *
 *   node scripts/seed-actors.mjs --count 30
 *   node scripts/seed-actors.mjs --count 30 --roster <org_id> --educator <user_id>
 *   node scripts/seed-actors.mjs --list
 *   node scripts/seed-actors.mjs --purge <run_id>
 *
 * ## Why this is not SQL
 *
 * The obvious version of this script inserts into `auth.users` and is wrong in
 * a way that only shows up at the login screen:
 *
 *   - `encrypted_password` is bcrypt, so the insert needs
 *     `crypt(pw, gen_salt('bf'))` and pgcrypto.
 *   - GoTrue authenticates against `auth.identities`, not `auth.users`. A row
 *     in `users` with no matching `identities` row (provider `email`,
 *     `provider_id` = the user id, `identity_data` carrying `sub` and `email`)
 *     produces a user that exists, is visible in the dashboard, and cannot log
 *     in. The error is "Invalid login credentials", which says nothing about
 *     the missing row.
 *   - `aud`, `role`, `instance_id` and `confirmation_token` have defaults that
 *     differ across GoTrue versions, and the auth schema is Supabase's to
 *     change under us.
 *
 * `auth.admin.createUser` writes both tables through the API that owns them.
 *
 * ## Why this does not touch the email-confirmation setting
 *
 * `email_confirm: true` marks *this* user confirmed at creation. It is a
 * per-user flag, not the project's "Confirm email" toggle — seeded accounts
 * skip the mail, every account made through `/login` still gets whatever the
 * project is configured to do. Turning the project setting off to make seeding
 * convenient would silently change the real signup path, and nothing would
 * remind anyone to turn it back on before the pilot.
 *
 * ## The gate
 *
 * `ACTOR_SEED_ALLOW_PROJECT_REF` must name the project ref this script is
 * about to write to, and the ref is read out of `SUPABASE_URL` rather than
 * supplied separately. Empty means nowhere. The two have to be set by the same
 * person in the same breath, so a service-role key left over from another
 * project cannot quietly seed it — the mismatch is reported with both refs.
 *
 * ## Consent
 *
 * `--consent` writes `oversight_consents` rows, which are normally the one
 * thing only a student may create. It is allowed here, and *only* here,
 * because these accounts are synthetic: the row records a decision made by
 * nobody, on behalf of nobody. It is refused for any account this run did not
 * create. Writing a consent row for a real participant is falsifying the
 * record that the whole oversight design rests on — do not extend this flag to
 * reach them.
 */

import { randomUUID, randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const ALLOWED_REF = (process.env.ACTOR_SEED_ALLOW_PROJECT_REF ?? "").trim();

/** RFC 2606 reserved: cannot resolve, so a seeded address can never be mailed. */
const DOMAIN = "example.test";

/** Stamped into `user_metadata` so seeded accounts are findable and purgeable. */
const MARKER = "seed-actors";

function fail(message) {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

/** `https://abcdefgh.supabase.co` -> `abcdefgh`; a local stack -> `local`. */
function projectRef(url) {
  if (/127\.0\.0\.1|localhost/.test(url)) return "local";
  const match = /^https:\/\/([a-z0-9]+)\.supabase\.(co|in)/i.exec(url);
  return match ? match[1] : null;
}

function admin() {
  if (!SUPABASE_URL) fail("SUPABASE_URL is not set.");
  if (!SERVICE_ROLE_KEY) fail("SUPABASE_SERVICE_ROLE_KEY is not set.");

  const ref = projectRef(SUPABASE_URL);
  if (!ref) fail(`Could not read a project ref out of SUPABASE_URL (${SUPABASE_URL}).`);

  if (!ALLOWED_REF) {
    fail(
      "ACTOR_SEED_ALLOW_PROJECT_REF is not set, so this script will not write anywhere.\n" +
        `  To seed the project SUPABASE_URL points at, set it to: ${ref}`,
    );
  }
  if (ALLOWED_REF !== ref) {
    fail(
      "Refusing to seed: the key and the allowlist disagree about the target.\n" +
        `  SUPABASE_URL points at:            ${ref}\n` +
        `  ACTOR_SEED_ALLOW_PROJECT_REF says: ${ALLOWED_REF}`,
    );
  }

  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function args() {
  const argv = process.argv.slice(2);
  const read = (flag) => {
    const at = argv.indexOf(flag);
    return at === -1 ? null : argv[at + 1] ?? null;
  };
  return {
    count: Number(read("--count") ?? 10),
    prefix: read("--prefix") ?? "demo",
    roster: read("--roster"),
    educator: read("--educator"),
    consent: argv.includes("--consent"),
    list: argv.includes("--list"),
    purge: read("--purge"),
  };
}

/**
 * One password for the whole run. These accounts are handed to a room of
 * people at once; a password each is a spreadsheet nobody reads, and the
 * accounts hold nothing worth protecting from each other.
 */
function runPassword() {
  return `seed-${randomBytes(9).toString("base64url")}`;
}

async function createOne(client, email, password, runId, index) {
  const created = await client.auth.admin.createUser({
    email,
    password,
    // Per-user. Does not change the project's Confirm-email setting.
    email_confirm: true,
    user_metadata: { seeded_by: MARKER, seed_run: runId, display_name: `デモ生徒 ${index}` },
  });
  if (created.error) throw new Error(`${email}: ${created.error.message}`);
  const user = created.data.user;

  // `/login` builds these two on first sign-in (`ensureUserProfile` /
  // `ensureParticipant` in lib/auth.tsx). Seeded accounts are meant to be
  // usable before anyone logs into them — an educator roster that fills in
  // only after each student has signed in once is not a demo.
  const profile = await client.from("profiles").upsert({
    id: user.id,
    owner_user_id: user.id,
    email,
    display_name: `デモ生徒 ${index}`,
  });
  if (profile.error) throw new Error(`${email}: profiles: ${profile.error.message}`);

  const participant = await client
    .from("participants")
    .insert({ owner_user_id: user.id, code: "research_user_01", display_name: `デモ生徒 ${index}` })
    .select("id")
    .single();
  if (participant.error) throw new Error(`${email}: participants: ${participant.error.message}`);

  return { email, userId: user.id, participantId: participant.data.id };
}

async function seed({ count, prefix, roster, educator, consent }) {
  if (!Number.isInteger(count) || count < 1 || count > 500) {
    fail("--count must be a whole number between 1 and 500.");
  }
  if (consent && !roster) fail("--consent needs --roster: a consent row is scoped to an org.");
  if (roster && !educator) fail("--roster needs --educator: the roster links an educator to a student.");

  const client = admin();
  const runId = randomUUID().slice(0, 8);
  const password = runPassword();

  const made = [];
  for (let index = 1; index <= count; index += 1) {
    const email = `${prefix}-${String(index).padStart(3, "0")}-${runId}@${DOMAIN}`;
    made.push(await createOne(client, email, password, runId, index));
    process.stderr.write(`\r  created ${index}/${count}`);
  }
  process.stderr.write("\n");

  if (roster) {
    const rows = made.map((actor) => ({
      org_id: roster,
      educator_user_id: educator,
      participant_id: actor.participantId,
      owner_user_id: actor.userId,
      status: "active",
    }));
    const inserted = await client.from("oversight_roster").insert(rows);
    if (inserted.error) fail(`roster: ${inserted.error.message}`);
    console.error(`  rostered ${rows.length} to org ${roster}`);
  }

  if (consent) {
    // Only for the accounts this run created. See the header.
    const rows = made.map((actor) => ({
      participant_id: actor.participantId,
      owner_user_id: actor.userId,
      org_id: roster,
      educator_user_id: null,
      scope: "derived_signals",
      status: "active",
      consent_version: "seeded-synthetic-v1",
    }));
    const inserted = await client.from("oversight_consents").insert(rows);
    if (inserted.error) fail(`consent: ${inserted.error.message}`);
    console.error(`  consented ${rows.length} (synthetic accounts only)`);
  }

  // Printed once, to stdout, so it can be piped to a file deliberately and is
  // not left behind by a script that decided where to put it.
  console.log(`\n# run ${runId} — password for every account below: ${password}`);
  console.log("email,user_id,participant_id");
  for (const actor of made) console.log(`${actor.email},${actor.userId},${actor.participantId}`);
  console.error(`\n  To remove them: node scripts/seed-actors.mjs --purge ${runId}\n`);
}

async function listRuns() {
  const client = admin();
  const { data, error } = await client.auth.admin.listUsers({ perPage: 1000 });
  if (error) fail(error.message);

  const runs = new Map();
  for (const user of data.users) {
    if (user.user_metadata?.seeded_by !== MARKER) continue;
    const run = user.user_metadata.seed_run ?? "unknown";
    runs.set(run, (runs.get(run) ?? 0) + 1);
  }
  if (runs.size === 0) return console.log("No seeded accounts.");
  console.log("run_id\taccounts");
  for (const [run, n] of runs) console.log(`${run}\t${n}`);
}

async function purge(runId) {
  const client = admin();
  const { data, error } = await client.auth.admin.listUsers({ perPage: 1000 });
  if (error) fail(error.message);

  // Two conditions, not one. `seeded_by` alone would let a mistyped run id
  // match nothing and a missing one match everything.
  const targets = data.users.filter(
    (user) => user.user_metadata?.seeded_by === MARKER && user.user_metadata?.seed_run === runId,
  );
  if (targets.length === 0) fail(`No accounts found for run ${runId}.`);

  for (const user of targets) {
    const deleted = await client.auth.admin.deleteUser(user.id);
    if (deleted.error) console.error(`  could not delete ${user.email}: ${deleted.error.message}`);
  }
  console.log(`Deleted ${targets.length} account(s) from run ${runId}.`);
}

const options = args();
if (options.list) await listRuns();
else if (options.purge) await purge(options.purge);
else await seed(options);
