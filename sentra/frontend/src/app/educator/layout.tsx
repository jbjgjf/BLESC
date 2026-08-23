"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { useDemoMode } from "@/lib/demo";
import { useIsHydrated } from "@/lib/hydration";
import { Icon } from "@/components/ui/Icon";

/**
 * 教員向け画面の入口。
 *
 * ここでの制御は表示上のものにすぎない。実際のアクセス制御は Supabase の
 * RLS 側にあり、教員でないユーザーがこの URL に到達してもデータは返らない。
 * デモモードでは固定データしか読まないため、この判定を通す。
 */
export default function EducatorLayout({ children }: { children: React.ReactNode }) {
  const { user, isEducator, isLoading, educatorMemberships } = useAuth();
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

  const orgName = educatorMemberships.map((m) => m.org_name).join(" ・ ") || "広尾学園 中学校・高等学校";

  return (
    <div className="bl-wrap bl-wrap--wide bl-stack">
      <div className="bl-orgbar">
        <span className="bl-row" style={{ gap: 9 }}>
          <Icon name="apartment" size={19} />
          <span className="bl-meta" style={{ fontWeight: 600 }}>{orgName}</span>
        </span>
        <span className="bl-disclaimer">
          <Icon name="medical_information" size={15} />
          blescは医療的な診断を行いません。最終的な判断は学校の支援体制が行います。
        </span>
      </div>

      {children}
    </div>
  );
}
