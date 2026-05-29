"use client";

import { useEffect } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { AppHeader } from "@/components/AppHeader";

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

  return (
    <div className="min-h-screen flex flex-col">
      <AppHeader />
      <main className="flex-1 max-w-7xl mx-auto w-full px-4 py-6">
        {children}
      </main>
    </div>
  );
}
