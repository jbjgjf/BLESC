/**
 * The operator endpoints, as one typed surface for `/pilot/ops` (#B2).
 *
 * Every one of these routes existed and none of them had a caller: issuing 50
 * invitation codes and 50 guardian links was a sequence of `curl` commands with
 * a bearer token pasted into a terminal. That is not a tooling complaint — the
 * codes are shown exactly once and cannot be recovered, so a mistyped `count`
 * on day 0 is 50 codes that have to be revoked and reissued while a class
 * waits.
 *
 * Authorization is `ApiClient.fetch`'s, which is the operator's own signed-in
 * session. The allowlist (`PILOT_OPERATOR_USER_IDS`) is checked server-side by
 * `requireOperator`; nothing here decides anything, and a non-operator gets a
 * 404 from every call.
 */

import { ApiClient } from "@/api/client";
import type { PilotState } from "@/lib/pilotEnrollment";

/** Exactly what `invitationUsage` returns — no code, only its 4-symbol prefix. */
export type InvitationUsageRow = {
  prefix: string;
  cohort: string;
  max: number;
  redeemed: number;
  revoked: boolean;
  expires_at: string | null;
  note: string | null;
};

export type InvitationsView = {
  study: { slug: string; title: string; status: string; protocol_version: string; is_dry_run: boolean };
  invitations: InvitationUsageRow[];
  totals: { issued: number; redeemed: number; revoked: number; available: number };
};

export type IssuedCodes = {
  status: string;
  study: string;
  codes: string[];
  warning: string;
};

export type OutstandingGuardian = {
  verification_id: string;
  research_code: string | null;
  cohort: string | null;
  status: string;
  channel: string;
  requested_at: string;
  issued_at: string | null;
  expires_at: string | null;
};

export type IssuedGuardianLink = {
  status: string;
  url: string;
  research_code: string | null;
  token_prefix: string;
  channel: string;
  expires_at: string | null;
};

export type EnrollmentRow = {
  enrollment_id: string;
  research_code: string;
  cohort: string;
  state: PilotState;
  is_minor: boolean;
  collection_started_at: string | null;
  completed_at: string | null;
  ready_for: PilotState[];
};

export type EnrollmentsView = {
  study: string;
  cohort: string | null;
  total: number;
  by_state: Record<string, number>;
  enrollments: EnrollmentRow[];
};

export type TransitionResult = {
  study: string;
  cohort: string | null;
  to: PilotState;
  considered: number;
  counts: Record<string, number>;
  results: Array<{
    enrollment_id: string;
    research_code: string;
    from: PilotState;
    outcome: string;
    state?: PilotState;
  }>;
  not_in_scope?: string[];
};

const q = (params: Record<string, string | undefined>) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) search.set(key, value);
  }
  const text = search.toString();
  return text ? `?${text}` : "";
};

export const PilotOpsApi = {
  invitations(study: string) {
    return ApiClient.fetch<InvitationsView>(`/pilot/admin/invitations${q({ study })}`);
  },

  /**
   * Issue codes.
   *
   * The response is the only time the codes exist in readable form; the
   * database holds an HMAC. The caller must show them and must not re-request
   * them, because there is nothing to re-request.
   */
  issueInvitations(input: {
    study: string;
    count: number;
    cohort?: string;
    is_minor?: boolean;
    note?: string;
  }) {
    return ApiClient.fetch<IssuedCodes>("/pilot/admin/invitations", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },

  revokeInvitations(study: string, prefix: string) {
    return ApiClient.fetch<{ status: string; count: number; prefix: string }>(
      "/pilot/admin/invitations",
      { method: "DELETE", body: JSON.stringify({ study, prefix }) },
    );
  },

  outstandingGuardians(study: string) {
    return ApiClient.fetch<{ study: string; outstanding: OutstandingGuardian[] }>(
      `/pilot/guardian/issue${q({ study })}`,
    );
  },

  issueGuardianLink(verificationId: string, channel: string) {
    return ApiClient.fetch<IssuedGuardianLink>("/pilot/guardian/issue", {
      method: "POST",
      body: JSON.stringify({ verification_id: verificationId, channel }),
    });
  },

  enrollments(study: string, cohort?: string) {
    return ApiClient.fetch<EnrollmentsView>(`/pilot/admin/enrollment${q({ study, cohort })}`);
  },

  transition(input: {
    study: string;
    to: PilotState;
    cohort?: string;
    enrollment_ids?: string[];
    reason?: string;
  }) {
    return ApiClient.fetch<TransitionResult>("/pilot/admin/enrollment", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
};
