"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { useDemoMode } from "@/lib/demo";
import { useIsHydrated } from "@/lib/hydration";

/**
 * 学校全体の統計は教員・管理職向けの画面。/educator と同じ扱いにする。
 * ここでの判定は表示上のものにすぎず、実際のアクセス制御は RLS 側にある。
 */
export default function SchoolLayout({ children }: { children: React.ReactNode }) {
  const { user, isEducator, isLoading } = useAuth();
  const router = useRouter();

  // Reads false until hydration completes; `isLoading` only clears after the
  // async session lookup, so it is settled by the time we redirect.
  const demo = useDemoMode();
  const hydrated = useIsHydrated();
  const authed = Boolean(user) || demo;
  const allowed = isEducator || demo;

  useEffect(() => {
    if (isLoading) return;
    // 未ログインのリダイレクト先は AuthShell が /login に決める。ここで
    // 同時に "/" へ飛ばすと二つが競合して遷移が終わらなくなるため、
    // ログイン済みで権限だけがない場合に限って引き取る。
    if (!authed) return;
    if (!allowed) router.replace("/");
  }, [allowed, authed, isLoading, router]);

  if (!hydrated || isLoading || !allowed) {
    return (
      <div className="bl-wrap" style={{ display: "grid", placeItems: "center", minHeight: "50vh" }}>
        <span className="bl-loader" aria-label="読み込み中" />
      </div>
    );
  }

  return <>{children}</>;
}
