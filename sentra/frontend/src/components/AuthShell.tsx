"use client";

import { useEffect } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { AppHeader } from "@/components/AppHeader";

//: Routes whose page fills the area under the header and scrolls internally.
//: Chat is one because the composer is pinned to the bottom of the viewport;
//: it used to achieve that with `position: fixed; inset: 0; z-index: 60`,
//: which painted over the sticky header and took the navigation with it.
const FULL_BLEED_ROUTES = ["/chat"];

export function AuthShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const { user, isLoading } = useAuth();
  const isLoginRoute = pathname === "/login";

  useEffect(() => {
    if (isLoading) return;
    if (!user && !isLoginRoute) {
      router.replace(`/login?next=${encodeURIComponent(pathname)}`);
    }
    if (user && isLoginRoute) {
      router.replace(searchParams.get("next") || "/");
    }
  }, [isLoading, isLoginRoute, pathname, router, searchParams, user]);

  if (isLoading || (!user && !isLoginRoute) || (user && isLoginRoute)) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50">
        <Loader2 className="h-8 w-8 animate-spin text-slate-400" />
      </div>
    );
  }

  if (isLoginRoute) {
    return <>{children}</>;
  }

  // Routes that own the whole area below the header: they manage their own
  // scrolling and run edge to edge, so `main` gives them the space and adds
  // no padding of its own. The header stays — a route that needs the viewport
  // is not a route that should hide the way out of itself.
  const isFullBleed = FULL_BLEED_ROUTES.some(
    (route) => pathname === route || pathname.startsWith(`${route}/`),
  );

  return (
    <div className={isFullBleed ? "h-screen flex flex-col overflow-hidden" : "min-h-screen flex flex-col"}>
      <AppHeader />
      <main
        className={
          isFullBleed
            ? "flex-1 min-h-0 w-full"
            : "flex-1 max-w-7xl mx-auto w-full px-4 py-6"
        }
      >
        {children}
      </main>
    </div>
  );
}
