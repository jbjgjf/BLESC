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
 * The rule itself lives in `lib/server/pilotPageGate.ts`, shared with `/chat`
 * and `/recall` (#344).
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

import { requirePilotCollection } from "@/lib/server/pilotPageGate";

export default async function JournalLayout({ children }: { children: React.ReactNode }) {
  await requirePilotCollection("/journal");
  return children;
}
