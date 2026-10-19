/**
 * The server-side page gate for the screens that produce research rows (#164,
 * #344).
 *
 * Lifted out of `app/journal/layout.tsx` when `/chat` and `/recall` needed the
 * same rule. Called from a layout — a server component — so a browser that does
 * not run `AuthShell` is still redirected. Does nothing unless
 * `pilotGateEnforced()`; see the journal layout for the build-time requirement
 * that comes with that.
 *
 * The routes behind these pages ask the same question again
 * (`api/entries`, `api/chat`, the voice routes): a gate that only runs where the
 * page runs is a gate that a POST skips.
 */

import { redirect } from "next/navigation";
import { loadEnrollmentsForUser } from "./pilotStore";
import { gateForUser, pilotGateEnforced, redirectFor } from "./pilotGate";
import { serverUser } from "./session";
import { serviceRoleClient } from "./supabaseWriter";

/** Redirects to sign-in or the join screen unless this account may collect now. */
export async function requirePilotCollection(next: string): Promise<void> {
  if (!pilotGateEnforced()) return;

  const session = await serverUser();
  const service = serviceRoleClient();

  if (!session || !service) {
    redirect(redirectFor({ allowed: false, reason: "no_session", pending: null }, next) ?? "/login");
  }

  const participant = await service
    .from("participants")
    .select("id")
    .eq("owner_user_id", session.user.id)
    .limit(1)
    .maybeSingle();

  const enrollments = await loadEnrollmentsForUser(service, session.user.id);
  const outcome = await gateForUser(
    service,
    session.user.id,
    enrollments,
    (participant.data as { id: string } | null)?.id ?? null,
  );

  const destination = redirectFor(outcome, next);
  if (destination) redirect(destination);
}
