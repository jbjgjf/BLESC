/**
 * Who may have a page rendered for them (#229).
 *
 * The decision `src/proxy.ts` makes before any page renders. It is kept here,
 * as a pure function with no Next or Supabase imports, so the rules can be read
 * in one place and tested without a server.
 *
 * ## What this is, and what it is not
 *
 * It is the layer in front. Before it, every page decided in the browser:
 * `AuthShell` sent a signed-out visitor to /login, and `educator/layout.tsx`
 * sent a non-educator home, after the page had already been served and the
 * educator shell (organisation bar included) had rendered.
 *
 * It is not access control over data. RLS decides what rows anyone can read,
 * and every API route checks its own caller. Nothing here is weakened because
 * this exists. A request that gets past this layer reaches exactly what it
 * reached before, no more.
 *
 * It does not decide whether someone may be collected from. That is the
 * enrollment gate (`lib/server/pilotGate.ts`), asked by `journal/layout.tsx`
 * and by `POST /api/entries`. This module only requires a session for
 * `/journal`, like any other page, so the decision about collection stays in
 * one place.
 *
 * ## Demo and local development are untouched
 *
 * `next dev` and a deployment with `NEXT_PUBLIC_DEMO_MODE=1` pass everything
 * through, as before. So does a tab that switched demo on with `?demo=1`: the
 * browser remembers that in sessionStorage, which a server cannot read, so the
 * proxy notes it in a session cookie. That cookie is not a privilege. A
 * request carrying it gets the pre-#229 behaviour, the browser-side checks and
 * RLS, and in demo mode the client reads fixtures and never Supabase. A pilot
 * deployment ignores both, as `lib/demo.ts` does.
 */

export type AccessEnv = {
  nodeEnv?: string;
  demoMode?: string;
  pilotMode?: string;
  pilotStudySlug?: string;
  operatorUserIds?: string;
  researchUserIds?: string;
};

export type AccessDecision =
  | { action: "next" }
  | { action: "redirect"; location: string }
  | { action: "not_found" };

/** Pages that must render with no session at all. Mirrors `AuthShell`. */
export const PUBLIC_ROUTES = ["/login", "/legal", "/pilot/guardian"] as const;

/**
 * Not this app's pages at all: the static demo export in `public/demo-view`
 * and its short link, mapped by rewrites in `next.config.ts`. They are clean
 * URLs with no file extension, so the matcher cannot tell them from pages. The
 * proxy runs before rewrites and before `public/`, so without this line it
 * would send a signed-out visitor to /login in front of a fixtures-only page.
 * On a pilot deployment `next.config.ts` 404s them, and that still happens
 * after this lets them through.
 */
export const STATIC_EXPORT_ROUTES = ["/demo-view", "/meet-rusk"] as const;

/**
 * Pages that need more than a session, and which rule applies.
 *
 * `educator`: an active `organization_members` row, the same fact
 * `useAuth().isEducator` reads. Refused with a redirect home, which is what
 * `educator/layout.tsx` already did in the browser. The screen's existence is
 * not a secret: every student's bundle links it in demo mode.
 *
 * `operator` and `research`: the env allowlists their API routes already
 * enforce (`requireOperator`, the world-model proxy). Refused with 404,
 * for the reason `requireOperator` gives: a signed-in student probing the path
 * learns nothing.
 */
export const ROLE_ROUTES = [
  { prefix: "/educator", role: "educator" },
  { prefix: "/pilot/triage", role: "operator" },
  { prefix: "/research", role: "research" },
] as const;

export type Role = (typeof ROLE_ROUTES)[number]["role"];

export const DEMO_COOKIE = "blesc-demo";

function under(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function isPublicRoute(pathname: string): boolean {
  return [...PUBLIC_ROUTES, ...STATIC_EXPORT_ROUTES].some((route) => under(pathname, route));
}

export function requiredRole(pathname: string): Role | null {
  return ROLE_ROUTES.find((route) => under(pathname, route.prefix))?.role ?? null;
}

function list(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function isPilotDeployment(env: AccessEnv): boolean {
  return env.pilotMode === "1" || Boolean(env.pilotStudySlug?.trim());
}

/**
 * Whether this request is allowed to run as demo.
 *
 * `demoRequested` is `?demo=1` on this request, or the cookie a previous one
 * left. `?demo=0` is the caller's job to turn into `false`.
 */
export function demoApplies(env: AccessEnv, demoRequested: boolean): boolean {
  if (isPilotDeployment(env)) return false;
  return env.demoMode === "1" || demoRequested;
}

/**
 * The decision, given what the proxy found out.
 *
 * `session` is null for no verified user. `isEducator` is only consulted for
 * `/educator`, and the proxy only looks it up there.
 */
export function decideAccess(input: {
  pathname: string;
  search?: string;
  env: AccessEnv;
  demoRequested: boolean;
  supabaseConfigured: boolean;
  session: { userId: string; isEducator?: boolean } | null;
}): AccessDecision {
  const { pathname, env } = input;

  // Local development: unchanged, whatever else is set. `pilotGate` makes the
  // same exception.
  if (env.nodeEnv === "development") return { action: "next" };
  if (isPublicRoute(pathname)) return { action: "next" };
  if (demoApplies(env, input.demoRequested)) return { action: "next" };

  // No Supabase, no sessions to verify and no data to protect: every data
  // path answers 503 on its own. Redirecting to a login that cannot work
  // would only replace one broken screen with another.
  if (!input.supabaseConfigured) return { action: "next" };

  if (!input.session) {
    const next = `${pathname}${input.search ?? ""}`;
    return { action: "redirect", location: `/login?next=${encodeURIComponent(next)}` };
  }

  const role = requiredRole(pathname);
  if (role === "educator") {
    return input.session.isEducator ? { action: "next" } : { action: "redirect", location: "/" };
  }
  if (role === "operator") {
    return list(env.operatorUserIds).has(input.session.userId) ? { action: "next" } : { action: "not_found" };
  }
  if (role === "research") {
    return list(env.researchUserIds).has(input.session.userId) ? { action: "next" } : { action: "not_found" };
  }
  return { action: "next" };
}

/** The environment, read once per request so tests can pass their own. */
export function accessEnvFromProcess(): AccessEnv {
  return {
    nodeEnv: process.env.NODE_ENV,
    demoMode: process.env.NEXT_PUBLIC_DEMO_MODE,
    pilotMode: process.env.NEXT_PUBLIC_PILOT_MODE,
    pilotStudySlug: process.env.PILOT_STUDY_SLUG,
    operatorUserIds: process.env.PILOT_OPERATOR_USER_IDS,
    researchUserIds: process.env.RESEARCH_UI_ALLOWED_USER_IDS,
  };
}
