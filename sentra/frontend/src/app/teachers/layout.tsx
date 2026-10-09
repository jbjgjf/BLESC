"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { useDemoMode } from "@/lib/demo";
import { useIsHydrated } from "@/lib/hydration";

/**
 * Blesc for Teachers（先生自身の記録のためのサービス）の入口。
 *
 * ここでの制御は表示上のものにすぎない。実際のアクセス制御は Supabase の
 * RLS 側にあり、教員でないユーザーがこの URL に到達してもデータは返らない。
 * デモモードでは固定データしか読まないため、この判定を通す。
 *
 * 外枠（サイドバー・タブ）は components/teachers/TeacherShell が持つ。
 */
export default function TeachersLayout({ children }: { children: React.ReactNode }) {
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
      <div style={{ display: "grid", placeItems: "center", minHeight: "50vh" }}>
        <span className="bl-loader" aria-label="読み込み中" />
      </div>
    );
  }

  return <>{children}</>;
}
