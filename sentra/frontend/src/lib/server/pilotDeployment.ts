/**
 * Whether this deployment is the pilot's deployment.
 *
 * Two environment reads, nothing else. They live in their own file because two
 * modules need them and one of those modules cannot import the other.
 *
 * `pilotGate.ts` is where these grew up and is still where the gate itself
 * lives; it re-exports both so no caller had to change. `collectionMode.ts`
 * needs the same answer — a gate that cannot reach the database has to know
 * whether it is standing in front of a study or in front of nothing (#296) —
 * but it is loaded directly by `tests/collection-mode.test.mjs` under
 * `node --experimental-strip-types`, which resolves neither the `@/` alias nor
 * an extensionless specifier for anything that is not a type-only import.
 * Importing `pilotGate.ts` from there would pull in `@/lib/pilotEnrollment`
 * and `./pilotStore` as *value* imports and break that test at load time.
 *
 * So: no imports in this file, and the two modules that need the predicate
 * import it from here with a relative specifier and its extension — the same
 * convention `pilotOps.ts` documents for the same reason.
 */

/** The study this deployment collects for, or null on a normal deployment. */
export function pilotStudySlug(): string | null {
  const slug = process.env.PILOT_STUDY_SLUG?.trim();
  return slug ? slug : null;
}

/**
 * Whether the pilot's rules apply to this deployment at all.
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
