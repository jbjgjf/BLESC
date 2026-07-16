import { randomBytes } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { SYNTHETIC_ACCOUNTS, type EvalEnv } from "./config.ts";

export interface ProvisionedAccounts {
  /** email -> password. Held ONLY in runner memory; never persisted or logged. */
  passwords: Map<string, string>;
  orgId: string;
  studentParticipants: Map<string, string>; // email -> participant_id
}

function freshPassword(): string {
  return `Ev!${randomBytes(18).toString("base64url")}`;
}

export function adminClient(env: EvalEnv): SupabaseClient {
  if (!env.serviceRoleKey) throw new Error("EVAL_SUPABASE_SERVICE_ROLE_KEY is not configured");
  return createClient(env.supabaseUrl, env.serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function ensureUser(admin: SupabaseClient, email: string, password: string): Promise<string> {
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.data.user) return created.data.user.id;
  // Already exists: find it and rotate the password to this run's value.
  const list = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const existing = list.data.users.find((user) => user.email === email);
  if (!existing) throw new Error(`could not create or find synthetic account ${email}`);
  const updated = await admin.auth.admin.updateUserById(existing.id, { password, email_confirm: true });
  if (updated.error) throw new Error(`password rotation failed for ${email}: ${updated.error.message}`);
  return existing.id;
}

/**
 * Provision the full synthetic cohort with real, confirmed Supabase Auth
 * accounts: 20 students, 4 counselors, 1 reviewer, the "BLESC Evaluation
 * Lab" org, roster links, and reviewer evaluation access. Passwords are
 * generated fresh per run and returned in memory only.
 */
export async function provisionAccounts(env: EvalEnv): Promise<ProvisionedAccounts> {
  const admin = adminClient(env);
  const passwords = new Map<string, string>();
  const allEmails = [...SYNTHETIC_ACCOUNTS.students, ...SYNTHETIC_ACCOUNTS.counselors, SYNTHETIC_ACCOUNTS.reviewer];
  const idsByEmail = new Map<string, string>();
  for (const email of allEmails) {
    const password = freshPassword();
    passwords.set(email, password);
    idsByEmail.set(email, await ensureUser(admin, email, password));
  }

  // Profiles + participants for students (mirrors the app's ensureParticipant).
  const studentParticipants = new Map<string, string>();
  for (const email of SYNTHETIC_ACCOUNTS.students) {
    const userId = idsByEmail.get(email)!;
    await admin.from("profiles").upsert({ id: userId, owner_user_id: userId, email, display_name: email.split("@")[0] });
    const code = `SYN_${email.slice(8, 10)}`;
    const existing = await admin.from("participants").select("id").eq("owner_user_id", userId).limit(1).maybeSingle();
    if (existing.data) {
      studentParticipants.set(email, existing.data.id);
    } else {
      const inserted = await admin.from("participants")
        .insert({ owner_user_id: userId, code, display_name: `Synthetic ${code}` })
        .select("id").single();
      if (inserted.error) throw new Error(`participant for ${email}: ${inserted.error.message}`);
      studentParticipants.set(email, inserted.data.id);
    }
  }

  // Evaluation Lab org: counselors as educator members, students rostered.
  const orgName = SYNTHETIC_ACCOUNTS.orgName;
  const orgExisting = await admin.from("organizations").select("id").eq("name", orgName).limit(1).maybeSingle();
  let orgId = orgExisting.data?.id as string | undefined;
  if (!orgId) {
    const firstCounselor = idsByEmail.get(SYNTHETIC_ACCOUNTS.counselors[0])!;
    const created = await admin.from("organizations").insert({ name: orgName, created_by: firstCounselor }).select("id").single();
    if (created.error) throw new Error(`org: ${created.error.message}`);
    orgId = created.data.id;
  }
  for (const email of SYNTHETIC_ACCOUNTS.counselors) {
    const userId = idsByEmail.get(email)!;
    await admin.from("profiles").upsert({ id: userId, owner_user_id: userId, email, display_name: email.split("@")[0] });
    await admin.from("organization_members")
      .upsert({ org_id: orgId, member_user_id: userId, role: "educator", status: "active" }, { onConflict: "org_id,member_user_id" });
  }
  const counselorIds = SYNTHETIC_ACCOUNTS.counselors.map((email) => idsByEmail.get(email)!);
  let counselorCursor = 0;
  for (const email of SYNTHETIC_ACCOUNTS.students) {
    const participantId = studentParticipants.get(email)!;
    const ownerId = idsByEmail.get(email)!;
    const counselorId = counselorIds[counselorCursor++ % counselorIds.length];
    await admin.from("oversight_roster").upsert(
      { org_id: orgId, educator_user_id: counselorId, participant_id: participantId, owner_user_id: ownerId, status: "active" },
      { onConflict: "org_id,educator_user_id,participant_id" },
    );
  }

  // Reviewer read grant for the evaluation dashboard.
  await admin.from("evaluation_access").upsert(
    { user_id: idsByEmail.get(SYNTHETIC_ACCOUNTS.reviewer)!, role: "reviewer", status: "active", granted_by: "provisioner" },
    { onConflict: "user_id,role" },
  );

  return { passwords, orgId: orgId!, studentParticipants };
}

/**
 * Reset isolation: wipe synthetic-account content between runs without
 * touching anything else. Deletes derived + raw rows owned by synthetic
 * accounts only (guarded by the .invalid domain), then their consents and
 * shares. Auth accounts and the Lab org stay.
 */
export async function resetSyntheticData(env: EvalEnv): Promise<{ wipedUsers: number }> {
  const admin = adminClient(env);
  const list = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const synthetic = list.data.users.filter((user) => user.email?.endsWith("@synthetic.blesc.invalid"));
  for (const user of synthetic) {
    for (const table of [
      "shared_support_summaries", "oversight_consents", "educator_access_log",
      "model_runs", "insights", "graph_snapshots", "entries", "chat_messages", "chat_sessions",
    ]) {
      const del = await admin.from(table).delete().eq("owner_user_id", user.id);
      if (del.error && !/does not exist|schema cache/i.test(del.error.message)) {
        throw new Error(`reset ${table} for synthetic user failed: ${del.error.message}`);
      }
    }
  }
  return { wipedUsers: synthetic.length };
}
