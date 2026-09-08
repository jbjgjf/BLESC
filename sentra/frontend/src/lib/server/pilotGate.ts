/**
 * The gate in front of the collection screen (#164).
 *
 * The screens under `/journal` were reachable by anyone with a session: the
 * layouts that look like access control (`educator/layout.tsx` and the rest)
 * say so in their own comments — they hide things, and the real boundary is
 * RLS. For a study that is not enough. An account that was never invited must
 * not be able to type the URL and start producing rows that a research export
 * will later treat as a participant's, and "the export filters by enrollment"
 * is a promise about a query, made after the data already exists.
 *
 * So this module answers one question — *may this account be collected from
 * right now* — and answers it on the server, from the enrollment row, before
 * the page renders.
 *
 * **It is off unless the deployment is a pilot deployment.** `PILOT_STUDY_SLUG`
 * is what turns it on, and the pilot runs on its own Vercel project against its
 * own Supabase (#166). On any other deployment this returns "not enforced" and
 * nothing changes: a school evaluating the product, a demo, and local
 * development all keep working exactly as before. Wiring the gate to an
 * environment variable rather than to the presence of a `pilot_studies` row is
 * deliberate — a row appearing in a shared database should not silently lock
 * every other user out of the journal.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { isCollecting, pendingRequirement, type PilotEnrollment } from "@/lib/pilotEnrollment";
import { collectionOpen } from "./pilotStore";

/** The study this deployment collects for, or null on a normal deployment. */
export function pilotStudySlug(): string | null {
  const slug = process.env.PILOT_STUDY_SLUG?.trim();
  return slug ? slug : null;
}

/**
 * Whether the enrollment gate applies.
 *
 * Demo mode turns it off even when a study is configured. The demo reads fixed
 * data and never touches Supabase, so gating it would only mean the 5-minute
 * walkthrough in `demo_and_release_gate.md` stops at a redirect — protecting
 * nothing, since there is no participant and nothing is written.
 */
export function pilotGateEnforced(): boolean {
  if (!pilotStudySlug()) return false;
  if (process.env.NEXT_PUBLIC_DEMO_MODE === "1") return false;
  if (process.env.NODE_ENV === "development") return false;
  return true;
}

export type GateOutcome =
  | { allowed: true; reason: "not_enforced" | "collecting" }
  | { allowed: false; reason: "no_session" | "no_enrollment" | "not_collecting"; pending: string | null };

/** Where a refused visitor is sent. Never an error page: each of these is a
 *  step in the join flow, and the join screen is what explains which one. */
export function redirectFor(outcome: GateOutcome): string | null {
  if (outcome.allowed) return null;
  return outcome.reason === "no_session" ? "/login?next=%2Fjournal" : "/pilot/join";
}

/**
 * The decision, from an enrollment the caller already loaded.
 *
 * Split out from the loading so it can be tested without a database and so the
 * route handler and the layout share one rule rather than two that agree today.
 */
export function gateFromEnrollments(
  enrollments: PilotEnrollment[],
  options: { hasSession: boolean },
): GateOutcome {
  if (!pilotGateEnforced()) return { allowed: true, reason: "not_enforced" };
  if (!options.hasSession) return { allowed: false, reason: "no_session", pending: null };

  const live = enrollments.find((row) => row.state !== "withdrawn" && row.state !== "completed");
  if (!live) return { allowed: false, reason: "no_enrollment", pending: null };

  if (isCollecting(live)) return { allowed: true, reason: "collecting" };

  // `enrolled` but not yet `collecting` is the ordinary state between consent
  // and the day the window opens. It is refused here for the same reason as
  // everything else: an entry written before the baseline period starts is not
  // part of the study, and storing it would put a row into the dataset that the
  // protocol has no place for.
  return { allowed: false, reason: "not_collecting", pending: pendingRequirement(live) };
}

/**
 * The same decision, confirmed against the database.
 *
 * The structural rule above knows the enrollment is in `collecting`. It does
 * not know whether the window has since closed — `collection_ends_at` is a
 * date, and a row keeps its state past it until the scheduler moves it. So a
 * positive answer is re-asked of `pilot_collection_open`, the same SQL
 * predicate the writer and the export use, and a participant cannot be
 * collecting for the screen and not for the row it would produce.
 */
export async function gateForUser(
  service: SupabaseClient | null,
  ownerUserId: string | null,
  enrollments: PilotEnrollment[],
  participantId: string | null,
): Promise<GateOutcome> {
  if (!pilotGateEnforced()) return { allowed: true, reason: "not_enforced" };
  if (!service || !ownerUserId) return { allowed: false, reason: "no_session", pending: null };

  const structural = gateFromEnrollments(enrollments, { hasSession: true });
  if (!structural.allowed || !participantId) return structural;

  const open = await collectionOpen(service, participantId);
  return open ? structural : { allowed: false, reason: "not_collecting", pending: "collection_window" };
}
