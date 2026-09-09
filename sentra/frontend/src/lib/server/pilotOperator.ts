/**
 * Who counts as a study coordinator (#163, #164).
 *
 * An explicit allowlist of `auth.users.id`, not a role and not a claim: a role
 * is something an account can come to hold without anyone deciding it should,
 * and the two things this gate protects — minting invitation codes, and issuing
 * the link that stands for a parent's consent — are things a named person
 * should have been given deliberately.
 *
 * Lifted out of `api/pilot/admin/invitations/route.ts` when the guardian
 * issuance route needed the same rule. Two copies of an authorization check is
 * one copy too many: the second is where the 404-not-403 detail goes missing.
 */

import type { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { jsonError, requireUser } from "./api";
import { serviceRoleClient } from "./supabaseWriter";

export function authorizedOperators(): Set<string> {
  return new Set(
    (process.env.PILOT_OPERATOR_USER_IDS ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
}

export type OperatorAuth =
  | { error: NextResponse }
  | { userId: string; service: SupabaseClient };

export async function requireOperator(request: NextRequest): Promise<OperatorAuth> {
  const auth = await requireUser(request);
  if ("error" in auth) return auth;

  if (!authorizedOperators().has(auth.user.id)) {
    // 404, not 403. A signed-in student probing this path learns nothing about
    // whether an operator surface exists.
    return { error: jsonError("Not found.", 404) };
  }

  const service = serviceRoleClient();
  if (!service) return { error: jsonError("Supabase is not configured.", 503) };

  return { userId: auth.user.id, service };
}
