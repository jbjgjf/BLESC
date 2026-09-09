/**
 * The collection screen's gate (#164).
 *
 * A server component, and that is the whole point. `AuthShell` decides in the
 * browser whether to redirect, which means a browser that does not run it — a
 * script, a devtools call, a tampered bundle — is not redirected. On the pilot
 * deployment the journal is the thing that produces research rows, so the
 * decision is made here, before any of it is sent.
 *
 * On every other deployment this renders its children and does nothing else:
 * `pilotGateEnforced()` is false without `PILOT_STUDY_SLUG`, so a school
 * evaluating the product, the demo walkthrough and local development are
 * untouched.
 *
 * Note what this does *not* do: it does not decide whether a submission is
 * stored. That is `api/entries`, which asks the same question again with the
 * same helper. A gate that only runs where the page runs is a gate that a POST
 * skips.
 *
 * One deployment requirement, stated here because getting it wrong is silent:
 * `PILOT_STUDY_SLUG` has to be set **at build time as well as at runtime**.
 * Without it at build time this component returns its children without reading
 * cookies, so `/journal` is prerendered as a static page and never runs the
 * gate at all. Vercel's environment variables apply to both by default; the
 * `api/entries` check runs regardless, which is what keeps the failure to a
 * screen that should not have rendered rather than data that should not have
 * been collected.
 */

import { redirect } from "next/navigation";
import { PilotModeProvider } from "@/components/PilotModeProvider";
import { SELF_REPORT_SCHEMA_ID } from "@/lib/selfReport";
import { loadEnrollmentsForUser } from "@/lib/server/pilotStore";
import { gateForUser, pilotGateEnforced, redirectFor } from "@/lib/server/pilotGate";
import { serverUser } from "@/lib/server/session";
import { serviceRoleClient } from "@/lib/server/supabaseWriter";

export default async function JournalLayout({ children }: { children: React.ReactNode }) {
  // Not a pilot deployment: render exactly as before, and do not read cookies —
  // reading them here would make `/journal` dynamic on every deployment to
  // answer a question whose answer is already known.
  if (!pilotGateEnforced()) {
    return (
      <PilotModeProvider value={{ collectionOnly: false, selfReportSchemaId: null }}>
        {children}
      </PilotModeProvider>
    );
  }

  const session = await serverUser();
  const service = serviceRoleClient();

  if (!session || !service) {
    redirect(redirectFor({ allowed: false, reason: "no_session", pending: null }) ?? "/login");
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

  const destination = redirectFor(outcome);
  if (destination) redirect(destination);

  // Reaching here means the gate allowed collection, so the screen below is
  // inside an open window: no external AI, fixed items instead of the adaptive
  // follow-up (#165).
  return (
    <PilotModeProvider value={{ collectionOnly: true, selfReportSchemaId: SELF_REPORT_SCHEMA_ID }}>
      {children}
    </PilotModeProvider>
  );
}
