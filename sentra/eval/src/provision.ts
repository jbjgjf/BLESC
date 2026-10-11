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
 * accounts: 28 students (20 English-writing, 8 Japanese-writing), 4
 * counselors, 1 reviewer, the "BLESC Evaluation Lab" org, roster links, and
 * reviewer evaluation access. Passwords are generated fresh per run and
 * returned in memory only.
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
 * Every table with an `owner_user_id` column that a reset empties for the
 * synthetic accounts, in deletion order.
 *
 * This was a hand-kept list of nine tables from July. Nothing the pilot added
 * was on it, and what entries' cascade does not reach stayed behind between
 * runs. The worst of it was `safety_escalations`: its dedupe key is
 * (participant, level, surface, UTC hour), participants are never deleted, so a
 * second run in the same hour hit the unique index, `recordEscalation` returned
 * null by design, and no escalation row, delivery or ops alert was created —
 * while the case graded as a pass on the reply text alone (#375).
 *
 * The list is the complement of RESET_EXCLUSIONS within "tables with
 * owner_user_id", and tests/provision.test.ts derives that set from
 * sentra/supabase/migrations: a new owner-scoped table fails the test until it
 * is added here or excluded with a reason. The same test checks the order
 * against every foreign key that does not cascade (insights → graph_snapshots
 * → entries are the ones that matter today).
 */
export const RESET_TABLES = [
  "shared_support_summaries", "oversight_consents",
  "safety_escalations",
  "pilot_crisis_reviews", "pilot_pii_reviews", "pilot_self_reports",
  "submission_failures", "followup_responses",
  "conversation_memory_objects", "conversation_recall_summaries",
  "graph_change_events", "graph_edges", "graph_nodes",
  "insights", "graph_snapshots", "graph_versions",
  "longitudinal_patterns", "longitudinal_features",
  "retrieval_events", "interaction_events",
  "writing_features", "cognitive_probe_features",
  "entry_embeddings", "entry_fields", "entry_research_links", "extractions",
  "eval_examples", "export_jobs",
  "model_runs",
  "entries", "entry_sessions",
  "chat_messages", "chat_sessions",
] as const;

/** Owner-scoped tables a reset leaves alone, and why. */
export const RESET_EXCLUSIONS: Readonly<Record<string, string>> = {
  participants: "kept on purpose: one per synthetic account, created by provision; consents, roster and every content row hang off it",
  profiles: "kept on purpose: the account's profile, upserted by provision",
  oversight_roster: "kept on purpose: provisioning state (which counselor sees which student), upserted by provision",
  consent_records: "account-level research consent the harness does not re-create; deleting it would close the research-consent gate (#138) for every synthetic student",
  pilot_enrollments: "account-level enrollment state the harness does not re-create, and its event log below is append-only, so deleting an enrollment with history raises",
  pilot_guardian_verifications: "part of the enrollment state above (cascades from pilot_enrollments)",
  pilot_enrollment_events: "append-only: a trigger rejects every DELETE (20260906010000_pilot_enrollment.sql)",
  educator_access_log: "append-only audit of educator views: service_role has no DELETE (20260927000000_viewer_logs_survive_account_deletion.sql)",
};

/**
 * Account rows that are not owner-scoped but do carry over between runs, so a
 * reset reports them rather than implying they were wiped.
 */
export const RESET_NOT_RESETTABLE: Readonly<Record<string, string>> = {
  legal_acceptances: "keyed by user_id and append-only for service_role (20260927010000): once a synthetic account accepts the terms, later runs start already accepted, so the /legal acceptance path is exercised only on an account's first run",
};

export interface ResetReport {
  wipedUsers: number;
  /** Tables emptied for the synthetic accounts, with the rows removed. */
  deleted: Array<{ table: string; rows: number | null }>;
  /** Tables in RESET_TABLES the target database does not have. Nothing to wipe — but the schema is behind. */
  missing: string[];
  /** Tables deliberately left alone, with the reason. */
  excluded: Array<{ table: string; reason: string }>;
}

export class ResetFailed extends Error {
  readonly report: ResetReport;
  readonly failures: Array<{ table: string; error: string }>;

  constructor(report: ResetReport, failures: Array<{ table: string; error: string }>) {
    super(`reset could not empty ${failures.length} table(s) for the synthetic accounts: `
      + failures.map((failure) => `${failure.table} (${failure.error})`).join("; "));
    this.report = report;
    this.failures = failures;
  }
}

/**
 * Reset isolation: wipe synthetic-account content between runs without
 * touching anything else. Deletes rows owned by synthetic accounts only
 * (guarded by the .invalid domain) from every table in RESET_TABLES. Auth
 * accounts, the Lab org and the exclusions above stay.
 *
 * Says what it did. A table that is missing from the target is reported, not
 * swallowed; any other failure is collected and thrown after every table has
 * been tried, because a run that starts on unreset data is the defect this
 * exists to prevent.
 */
export async function resetSyntheticData(admin: SupabaseClient): Promise<ResetReport> {
  const list = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (list.error) throw new Error(`reset: could not list accounts: ${list.error.message}`);
  const synthetic = list.data.users.filter((user) => user.email?.endsWith("@synthetic.blesc.invalid"));
  const report: ResetReport = {
    wipedUsers: synthetic.length,
    deleted: [],
    missing: [],
    excluded: [...Object.entries(RESET_EXCLUSIONS), ...Object.entries(RESET_NOT_RESETTABLE)]
      .map(([table, reason]) => ({ table, reason })),
  };
  if (!synthetic.length) return report;
  const ids = synthetic.map((user) => user.id);
  const failures: Array<{ table: string; error: string }> = [];
  for (const table of RESET_TABLES) {
    const del = await admin.from(table).delete({ count: "exact" }).in("owner_user_id", ids);
    if (!del.error) {
      report.deleted.push({ table, rows: del.count ?? null });
    } else if (/does not exist|schema cache/i.test(del.error.message)) {
      report.missing.push(table);
    } else {
      failures.push({ table, error: del.error.message });
    }
  }
  if (failures.length) throw new ResetFailed(report, failures);
  return report;
}
