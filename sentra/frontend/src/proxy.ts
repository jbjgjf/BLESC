/**
 * The server-side page gate (#229).
 *
 * `middleware.ts` in the issue: Next.js 16 renamed the convention to
 * `proxy.ts` and deprecated the old name (see
 * `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md`).
 * It runs on the Node.js runtime, before any page renders.
 *
 * The rules are in `lib/routeAccess.ts`. This file only finds out what those
 * rules need: whether the cookie session is a real one (`getUser`, which asks
 * Supabase, not `getSession`, which believes the cookie), and, for
 * `/educator` only, whether that user has an active organisation membership.
 *
 * API routes are excluded by the matcher. They answer for themselves, with
 * 401/404 in JSON, and a redirect to an HTML login page would be the wrong
 * answer for a fetch.
 */

import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { DEMO_COOKIE, accessEnvFromProcess, decideAccess, requiredRole } from "@/lib/routeAccess";

const NOT_FOUND_HTML =
  '<!doctype html><html lang="ja"><meta charset="utf-8"><title>ページが見つかりません</title>' +
  '<p style="font-family:sans-serif;padding:2rem">ページが見つかりません。<a href="/">ホームへ戻る</a></p></html>';

export async function proxy(request: NextRequest) {
  const env = accessEnvFromProcess();
  const { pathname, search, searchParams } = request.nextUrl;

  // `?demo=1` is remembered by the browser in sessionStorage, which this
  // cannot read. Remember it here too, in a session cookie, so that the next
  // client navigation (an RSC request with no query string) is not sent to
  // /login halfway through a demo. `?demo=0` forgets it.
  const demoParam = searchParams.get("demo");
  const demoRequested =
    demoParam === "1" || (demoParam !== "0" && request.cookies.get(DEMO_COOKIE)?.value === "1");

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const supabaseConfigured = Boolean(url && anonKey);

  // Decide once without a session. Most requests (public pages, demo, local
  // development) are settled here, and settling them without a round trip to
  // Supabase keeps those pages as fast as they were.
  const withoutSession = decideAccess({
    pathname,
    search,
    env,
    demoRequested,
    supabaseConfigured,
    session: null,
  });

  let response = NextResponse.next({ request });
  let decision = withoutSession;

  if (withoutSession.action !== "next" && supabaseConfigured) {
    // The standard @supabase/ssr adapter: a refreshed token is written to
    // both the forwarded request and the response, so the page renders with
    // the same session the browser will hold afterwards.
    const supabase = createServerClient(url!, anonKey!, {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        },
      },
    });

    const { data } = await supabase.auth.getUser();
    const user = data.user;

    let isEducator = false;
    if (user && requiredRole(pathname) === "educator") {
      // Read with the user's own client, so RLS answers the question the
      // browser used to ask (`loadEducatorMemberships`). A failed read counts
      // as not an educator: the safe direction for a gate.
      const memberships = await supabase
        .from("organization_members")
        .select("org_id")
        .eq("member_user_id", user.id)
        .eq("status", "active")
        .limit(1);
      isEducator = !memberships.error && (memberships.data?.length ?? 0) > 0;
    }

    decision = decideAccess({
      pathname,
      search,
      env,
      demoRequested,
      supabaseConfigured,
      session: user ? { userId: user.id, isEducator } : null,
    });
  }

  if (decision.action === "redirect") {
    response = NextResponse.redirect(new URL(decision.location, request.url));
  } else if (decision.action === "not_found") {
    response = new NextResponse(NOT_FOUND_HTML, {
      status: 404,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  if (demoParam === "1") {
    response.cookies.set(DEMO_COOKIE, "1", { path: "/", sameSite: "lax", httpOnly: true });
  } else if (demoParam === "0") {
    response.cookies.delete(DEMO_COOKIE);
  }
  return response;
}

export const config = {
  matcher: [
    // Pages only. Not API routes (they answer for themselves), not build
    // output, and not files with an extension (icons, images, fonts).
    "/((?!api/|_next/static|_next/image|.*\\.[a-zA-Z0-9]+$).*)",
  ],
};
