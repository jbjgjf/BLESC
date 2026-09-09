"use client";

import { useEffect } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { useDemoMode } from "@/lib/demo";
import { contextForPath } from "@/lib/blesc/context";
import { useIsHydrated } from "@/lib/hydration";
import { Icon } from "@/components/ui/Icon";
import { AppNav } from "@/components/AppNav";
import { RouteAnnouncer } from "@/components/a11y/RouteAnnouncer";

//: Routes whose page fills the area under the header and scrolls internally.
//: Chat is one because the composer is pinned to the bottom of the viewport;
//: it used to achieve that with `position: fixed; inset: 0; z-index: 60`,
//: which painted over the sticky header and took the navigation with it.
const FULL_BLEED_ROUTES = ["/chat"];
//: Routes that must render without a session at all.
//:
//: The guardian confirmation screen (#164) is opened by a parent on their own
//: phone, from a link. They have no account and must not need one — requiring
//: a login here would push the step back onto the student's device, which is
//: the one place a guardian's consent cannot honestly come from. The token in
//: the URL is what authorises the request, and the route handler checks it.
const PUBLIC_ROUTES = ["/pilot/guardian"];

const DEMO_ONLY_ROUTES = [
  "/reflect",
  "/research",
  "/guardian",
  "/educator/alerts",
  "/educator/class",
  "/educator/meetings",
  "/school",
];

export function AuthShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const { user, isLoading } = useAuth();
  const isLoginRoute = pathname === "/login";
  const isPublicRoute = PUBLIC_ROUTES.some((route) => pathname === route || pathname.startsWith(`${route}/`));

  // Both the server and the hydrating render must show the loader: Supabase
  // fires INITIAL_SESSION early enough to clear `isLoading` mid-hydration, and
  // swapping in real content at that point would not match the server HTML.
  // `demo` likewise only reads true once hydrated, so no one is bounced to
  // /login on the strength of a not-yet-resolved flag.
  const demo = useDemoMode();
  const hydrated = useIsHydrated();
  const authed = Boolean(user) || demo;

  useEffect(() => {
    if (isLoading) return;
    if (isPublicRoute) return;
    if (!authed && !isLoginRoute) {
      router.replace(`/login?next=${encodeURIComponent(pathname)}`);
    }
    if (authed && isLoginRoute) {
      router.replace(searchParams.get("next") || "/");
    }
  }, [authed, isLoading, isLoginRoute, isPublicRoute, pathname, router, searchParams]);

  // A public route renders as soon as it is hydrated. It never waits on the
  // session lookup: a guardian who is not signed in — which is all of them —
  // would otherwise sit under a spinner until Supabase answered.
  if (isPublicRoute) {
    if (!hydrated) {
      return (
        <div
          className="bl-page"
          style={{ display: "grid", placeItems: "center" }}
          data-bl-context={contextForPath(pathname)}
        >
          <span className="bl-loader" aria-label="読み込み中" />
        </div>
      );
    }
    return <>{children}</>;
  }

  if (!hydrated || isLoading || (!authed && !isLoginRoute) || (authed && isLoginRoute)) {
    return (
      <div
        className="bl-page"
        style={{ display: "grid", placeItems: "center" }}
        data-bl-context={contextForPath(pathname)}
      >
        <span className="bl-loader" aria-label="読み込み中" />
      </div>
    );
  }

  if (isLoginRoute) return <>{children}</>;

  // Routes that own the whole area below the header: they manage their own
  // scrolling and run edge to edge, so `main` gives them the space and adds
  // no padding of its own. The header stays — a route that needs the viewport
  // is not a route that should hide the way out of itself.
  const isFullBleed = FULL_BLEED_ROUTES.some(
    (route) => pathname === route || pathname.startsWith(`${route}/`),
  );
  const isDemoOnly = !demo && DEMO_ONLY_ROUTES.some(
    (route) => pathname === route || pathname.startsWith(`${route}/`),
  );

  return (
    <div
      className={`bl-page bl-app${isFullBleed ? " bl-app--full-bleed" : ""}`}
      data-bl-context={contextForPath(pathname)}
    >
      <a className="bl-skip" href="#bl-main">本文へスキップ</a>
      <AppNav />
      <main
        id="bl-main"
        className={`bl-app__main${isFullBleed ? " bl-app__main--full-bleed" : ""}`}
        tabIndex={-1}
      >
        {isDemoOnly ? (
          <div className="bl-wrap">
            <section className="bl-card bl-empty" role="status">
              <Icon name="info" size={36} />
              <h1 className="bl-h2">この画面はデモ専用です</h1>
              <p className="bl-body">
                実データ用の API 接続が完了するまで、本番環境では固定データを表示しません。
              </p>
            </section>
          </div>
        ) : children}
      </main>
      <RouteAnnouncer />
      {demo && (
        <div className="bl-demo-badge">
          <Icon name="visibility" size={14} />
          デモデータ
        </div>
      )}
    </div>
  );
}
