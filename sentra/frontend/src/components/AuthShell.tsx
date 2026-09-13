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
import { Assistant } from "@/components/assistant/Assistant";

export function AuthShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const { user, isLoading } = useAuth();
  const isLoginRoute = pathname === "/login";

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
    if (!authed && !isLoginRoute) {
      router.replace(`/login?next=${encodeURIComponent(pathname)}`);
    }
    if (authed && isLoginRoute) {
      router.replace(searchParams.get("next") || "/");
    }
  }, [authed, isLoading, isLoginRoute, pathname, router, searchParams]);

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

  // The chat surface is full-bleed and brings its own header.
  if (pathname === "/chat") return <>{children}</>;

  const context = contextForPath(pathname);

  return (
    <div className="bl-page bl-app" data-bl-context={context}>
      <a className="bl-skip" href="#bl-main">本文へスキップ</a>
      <AppNav />
      <main id="bl-main" className="bl-app__main" tabIndex={-1}>
        {children}
      </main>
      <RouteAnnouncer />
      {/* 案内役は生徒の画面にだけ置く。危機のアラートを読んでいる教員の
          横で、表情の付いた小石がまばたきしているべきではない。 */}
      {context === "student" && <Assistant />}
      {demo && (
        <div className="bl-demo-badge">
          <Icon name="visibility" size={14} />
          デモデータ
        </div>
      )}
    </div>
  );
}
