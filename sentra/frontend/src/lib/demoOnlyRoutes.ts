/**
 * Which routes render fixed data, and therefore must not render outside demo
 * mode (#226).
 *
 * The rule this list encodes is narrow: **a route belongs here when its page
 * reads `lib/blesc/fixtures` and has no `useDemoMode()` branch of its own.**
 * Such a page has nothing else to draw — outside the demo it would show a
 * fabricated student, a fabricated class and a fabricated mood series to
 * whoever opened it. `AuthShell` replaces it with a card that says so.
 *
 * It is not a permission boundary and must never be used as one. Access
 * control is RLS, plus the collection gate in `lib/server/pilotGate.ts`. This
 * only answers "is there real data behind this screen yet".
 *
 * ## Why it is a module rather than two arrays inside `AuthShell`
 *
 * It held `/research` — a screen with no fixture import at all, which calls
 * `ApiClient` and Supabase directly. Every deployment that is not a demo
 * answered `/research` with "この画面はデモ専用です", including the account-menu
 * link that `AppNav` shows to every signed-in user. The list was kept correct
 * by a second list of exceptions (`/research/world-model`, matched exactly
 * while the first matched by prefix), so `/research` itself, and any route
 * added under it, fell through.
 *
 * Exceptions are gone. A prefix here now means every route under it is fixed
 * data, and `tests/demo-only-routes.test.mjs` checks that claim against the
 * page sources rather than trusting this comment.
 */

/**
 * Prefixes whose pages render fixed data.
 *
 * `/educator` is deliberately absent: the educator home, the roster and the
 * per-student screen are real. The fixed-data educator screens
 * (`/educator/alerts`, `/educator/class`, `/educator/meetings`) and `/school`
 * were deleted outright rather than gated.
 */
export const DEMO_ONLY_ROUTES = [
  "/reflect",
  "/guardian",
] as const;

/**
 * Whether `pathname` is one of them.
 *
 * Segment-wise, so `/schoolyard` is not `/school` with something appended. A
 * prefix match on the raw string would make adding a sibling route a silent
 * way to hide it.
 */
export function isDemoOnlyRoute(pathname: string): boolean {
  return DEMO_ONLY_ROUTES.some(
    (route) => pathname === route || pathname.startsWith(`${route}/`),
  );
}
