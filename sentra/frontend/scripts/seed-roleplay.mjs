/**
 * Accounts for the four-person internal role-play: one teacher, three students.
 *
 *   node scripts/seed-roleplay.mjs \
 *     --teacher teacher@example.org \
 *     --students a@example.org,b@example.org,c@example.org \
 *     [--names 生徒A,生徒B,生徒C] [--org "BLESC ロールプレイ"]
 *
 *   node scripts/seed-roleplay.mjs --reset-password a@example.org
 *
 * `--reset-password` issues a new password for one account (the app has no
 * reset flow) and prints it once. It only touches accounts this script created
 * (`user_metadata.seeded_by`), never anyone else's.
 *
 * What it does, in order, and idempotently (a second run changes nothing):
 *
 *   1. Creates any of the four accounts that do not exist yet, through
 *      `auth.admin.createUser` (see `seed-actors.mjs` for why not SQL), marked
 *      confirmed so no mail is needed. A generated password is printed **once**
 *      for each account it creates; existing accounts keep their password.
 *   2. Creates each student's `participants` row with a distinct code and name
 *      before their first login. The app only creates the row when none exists
 *      and otherwise gives every student the same `research_user_01` /
 *      「研究参加者 01」, which leaves the teacher unable to tell them apart.
 *   3. Creates the organization (the teacher becomes its `org_admin` through the
 *      `bootstrap_org_admin` trigger), adds the teacher as `educator`, and links
 *      each student to the teacher with an **active** roster row.
 *
 * What it deliberately does not do: write `oversight_consents`. A roster link
 * alone shows the teacher nothing (default-deny). Each student turns sharing on
 * themselves on /sharing — that step is part of what the role-play checks, and
 * a consent row written by a script records a decision nobody made.
 *
 * ## The gate
 *
 * Same rule as `seed-actors.mjs`: `ROLEPLAY_SEED_ALLOW_PROJECT_REF` must equal
 * the project ref read out of `SUPABASE_URL` (`local` for a local stack), so a
 * service-role key left over from another project cannot quietly write to it.
 */

import { randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const ALLOWED_REF = (process.env.ROLEPLAY_SEED_ALLOW_PROJECT_REF ?? "").trim();
const MARKER = "seed-roleplay";

function fail(message) {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

/** `https://abcdefgh.supabase.co` -> `abcdefgh`; a local stack -> `local`. */
export function projectRef(url) {
  if (/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(url)) return "local";
  const match = /^https:\/\/([a-z0-9]+)\.supabase\.(co|in)(\/|$)/i.exec(url);
  return match ? match[1] : null;
}

export function parseArgs(argv) {
  const read = (flag) => {
    const at = argv.indexOf(flag);
    return at >= 0 ? argv[at + 1] : undefined;
  };
  const list = (value) => (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  const teacher = (read("--teacher") ?? "").trim().toLowerCase();
  const students = list(read("--students")).map((email) => email.toLowerCase());
  const names = list(read("--names"));
  const org = (read("--org") ?? "BLESC ロールプレイ").trim();
  const problems = [];
  if (!teacher.includes("@")) problems.push("--teacher <email> is required.");
  if (students.length !== 3 || students.some((email) => !email.includes("@"))) {
    problems.push("--students needs exactly three comma-separated emails.");
  }
  if (new Set([teacher, ...students]).size !== 4) problems.push("The four emails must be different.");
  if (names.length && names.length !== students.length) problems.push("--names needs one name per student.");
  return {
    problems,
    teacher,
    students: students.map((email, index) => ({
      email,
      name: names[index] ?? `生徒${String.fromCharCode(65 + index)}`,
      code: `rp_student_${String.fromCharCode(97 + index)}`,
    })),
    org,
  };
}

function client() {
  if (!SUPABASE_URL) fail("SUPABASE_URL is not set.");
  if (!SERVICE_ROLE_KEY) fail("SUPABASE_SERVICE_ROLE_KEY is not set.");
  const ref = projectRef(SUPABASE_URL);
  if (!ref) fail(`Could not read a project ref out of SUPABASE_URL (${SUPABASE_URL}).`);
  if (!ALLOWED_REF) {
    fail(
      "ROLEPLAY_SEED_ALLOW_PROJECT_REF is not set, so this script will not write anywhere.\n" +
        `  To write to the project SUPABASE_URL points at, set it to: ${ref}`,
    );
  }
  if (ALLOWED_REF !== ref) {
    fail(`Refusing: SUPABASE_URL points at ${ref}, ROLEPLAY_SEED_ALLOW_PROJECT_REF says ${ALLOWED_REF}.`);
  }
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function findUserIds(admin, emails) {
  const wanted = new Set(emails);
  const found = new Map();
  for (let page = 1; page <= 50 && found.size < wanted.size; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) fail(`listUsers: ${error.message}`);
    for (const user of data.users) {
      const email = (user.email ?? "").toLowerCase();
      if (wanted.has(email)) found.set(email, user.id);
    }
    if (data.users.length < 200) break;
  }
  return found;
}

async function ensureUser(admin, ids, email, displayName, created) {
  if (ids.has(email)) return ids.get(email);
  const password = randomBytes(12).toString("base64url");
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { display_name: displayName, seeded_by: MARKER },
  });
  if (error) fail(`createUser ${email}: ${error.message}`);
  created.push({ email, password });
  ids.set(email, data.user.id);
  return data.user.id;
}

function must(result, what) {
  if (result.error) fail(`${what}: ${result.error.message}`);
  return result.data;
}

async function resetPassword(email) {
  const admin = client();
  const ids = await findUserIds(admin, [email]);
  const userId = ids.get(email);
  if (!userId) fail(`No account for ${email}.`);
  const { data, error } = await admin.auth.admin.getUserById(userId);
  if (error) fail(`getUserById: ${error.message}`);
  if (data.user.user_metadata?.seeded_by !== MARKER) {
    fail(`Refusing: ${email} was not created by this script.`);
  }
  const password = randomBytes(12).toString("base64url");
  const updated = await admin.auth.admin.updateUserById(userId, { password });
  if (updated.error) fail(`updateUserById: ${updated.error.message}`);
  console.log(`\nNew password for ${email} (shown once): ${password}\n`);
}

async function main() {
  const argv = process.argv.slice(2);
  const resetAt = argv.indexOf("--reset-password");
  if (resetAt >= 0) return resetPassword((argv[resetAt + 1] ?? "").trim().toLowerCase());
  const options = parseArgs(argv);
  if (options.problems.length) fail(options.problems.join("\n  "));
  const admin = client();

  const ids = await findUserIds(admin, [options.teacher, ...options.students.map((s) => s.email)]);
  const created = [];
  const teacherId = await ensureUser(admin, ids, options.teacher, "先生", created);
  must(
    await admin.from("profiles").upsert({ id: teacherId, owner_user_id: teacherId, email: options.teacher, display_name: "先生" }),
    "teacher profile",
  );

  const participants = [];
  for (const student of options.students) {
    const userId = await ensureUser(admin, ids, student.email, student.name, created);
    must(
      await admin.from("profiles").upsert({ id: userId, owner_user_id: userId, email: student.email, display_name: student.name }),
      `profile ${student.email}`,
    );
    const existing = must(
      await admin.from("participants").select("id, code, display_name").eq("owner_user_id", userId)
        .order("created_at", { ascending: true }).limit(1).maybeSingle(),
      `participant lookup ${student.email}`,
    );
    let participant = existing;
    if (!participant) {
      participant = must(
        await admin.from("participants").insert({ owner_user_id: userId, code: student.code, display_name: student.name })
          .select("id, code, display_name").single(),
        `participant ${student.email}`,
      );
    } else if (participant.code === "research_user_01") {
      // Created by the app on an earlier login, with the shared default.
      participant = must(
        await admin.from("participants").update({ code: student.code, display_name: student.name })
          .eq("id", participant.id).select("id, code, display_name").single(),
        `participant rename ${student.email}`,
      );
    }
    participants.push({ ...student, userId, participantId: participant.id, shownAs: participant.display_name });
  }

  let org = must(
    await admin.from("organizations").select("id").eq("name", options.org).eq("created_by", teacherId).limit(1).maybeSingle(),
    "org lookup",
  );
  if (!org) {
    org = must(await admin.from("organizations").insert({ name: options.org, created_by: teacherId }).select("id").single(), "org");
  }
  // The trigger made the teacher org_admin; the educator views need the
  // educator role. One membership row per (org, member), so it is updated.
  must(
    await admin.from("organization_members").upsert(
      { org_id: org.id, member_user_id: teacherId, role: "educator", status: "active" },
      { onConflict: "org_id,member_user_id" },
    ),
    "teacher membership",
  );
  for (const student of participants) {
    must(
      await admin.from("oversight_roster").upsert(
        { org_id: org.id, educator_user_id: teacherId, participant_id: student.participantId, owner_user_id: student.userId, status: "active" },
        { onConflict: "org_id,educator_user_id,participant_id" },
      ),
      `roster ${student.email}`,
    );
  }

  console.log(`\nOrganization: ${options.org} (${org.id})`);
  console.log(`Teacher:      ${options.teacher}`);
  for (const student of participants) console.log(`Student:      ${student.email} → ${student.shownAs} [${student.participantId}]`);
  if (created.length) {
    console.log("\nNew accounts (shown once — hand each password to its owner privately):");
    for (const account of created) console.log(`  ${account.email}  ${account.password}`);
  } else {
    console.log("\nNo new accounts; existing passwords were left as they were.");
  }
  console.log("\nNext: each student signs in and turns sharing on at /sharing. Until then the teacher sees nothing.\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
}
