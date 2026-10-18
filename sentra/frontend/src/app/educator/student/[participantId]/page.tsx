"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { AlertCircle, ArrowLeft, Loader2, ShieldAlert } from "lucide-react";

import { ApiClient } from "@/api/client";
import type { EducatorStudentOverview } from "@/api/models";
import { t } from "@/lib/i18n";
import { AttentionChip, NonDiagnosticNotice, ObservationDetail, panel, studentIdentity } from "@/components/educator/StatusChips";

/*
 * 生徒一人の画面。出すのは、クラス・出席番号と、観測の記録（種類・時刻・
 * 入力元・根拠）を新しい順に並べたものだけ（#466）。
 *
 * #466 で外したもの、と理由:
 *   - 生徒の名前。blesc.jp は「先生に表示されるのは、クラス、出席番号、観測された
 *     表現の種類、時刻だけです」と約束している。API の返り値からも外した。
 *   - 「繰り返し見られる話題」。日記の内容から数えたラベルで、約束の範囲を
 *     いちばん大きく超えていた。`getStudentOverviewForEducator` はもう
 *     `insights` を読まない。
 *   - 「最近の観測」として出していた、記録した日の一覧。
 *     （その前は日ごとの異常スコアを出していて、#175 で消えている。）
 *   - 基準値の学習状況の行。
 *
 * 残したもの: 「要確認」の表示、危機の記録を担当者へつなぐ案内、閲覧が記録される
 * ことの告知、診断ではないことの告知。
 */
export default function EducatorStudentPage() {
  const params = useParams<{ participantId: string }>();
  const participantId = params.participantId;
  const [overview, setOverview] = useState<EducatorStudentOverview | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!participantId) return;
    let cancelled = false;
    ApiClient.getStudentOverviewForEducator(participantId)
      .then((next) => { if (!cancelled) setOverview(next); })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : t.educator.student.loadFailed);
      });
    return () => { cancelled = true; };
  }, [participantId]);

  if (error) {
    return <div className="flex items-center gap-2 px-6 py-4 text-sm" style={{ ...panel, color: "var(--sienna)" }}><AlertCircle className="h-4 w-4" />{error}</div>;
  }
  if (overview === undefined) {
    return <div className="flex h-48 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin" style={{ color: "var(--sandstone)" }} /></div>;
  }
  if (overview === null) {
    return (
      <section className="px-8 py-10 text-center text-sm" style={{ ...panel, color: "var(--ink-mid)" }}>
        {t.educator.student.notShared}
        <div className="mt-3"><Link href="/educator/roster" style={{ color: "var(--gold-deep)", fontWeight: 600 }}>{t.educator.student.backToRoster}</Link></div>
      </section>
    );
  }

  const { student, observations } = overview;
  const hasCrisis = observations.some((observation) => observation.level === "crisis");

  return (
    <div className="space-y-5">
      <Link href="/educator/roster" className="inline-flex items-center gap-1 text-sm" style={{ color: "var(--ink-faint)" }}>
        <ArrowLeft className="h-4 w-4" />{t.educator.student.rosterCrumb}
      </Link>

      <section className="flex flex-wrap items-center justify-between gap-3 px-7 py-5" style={panel}>
        <div>
          <div className="inscription mb-1">{t.educator.student.subtitle}</div>
          <div className="text-xl font-bold" style={{ color: "var(--ink)" }}>
            {studentIdentity(student)}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <AttentionChip student={student} />
        </div>
      </section>

      <section
        className="px-7 py-5"
        style={observations.length ? { ...panel, borderLeft: "3px solid var(--terracotta)" } : panel}
      >
        <div className="mb-2 flex items-center gap-2 font-semibold" style={{ color: observations.length ? "var(--sienna)" : "var(--ink-mid)" }}>
          <ShieldAlert className="h-4 w-4" />{t.educator.student.safetyFlags}
        </div>
        {observations.length ? (
          <ul className="space-y-2">
            {observations.map((observation) => (
              <li key={`${observation.occurred_at}-${observation.level}`}>
                <ObservationDetail observation={observation} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm italic" style={{ color: "var(--ink-faint)" }}>{t.educator.student.noObservations}</p>
        )}
        {observations.length ? (
          <p className="mt-3 text-xs" style={{ color: hasCrisis ? "var(--sienna)" : "var(--ink-faint)" }}>
            {t.educator.student.safetyRouting}
          </p>
        ) : null}
      </section>

      <p className="px-1 text-xs" style={{ color: "var(--ink-faint)" }}>
        {t.educator.student.accessLogged}
      </p>
      <NonDiagnosticNotice />
    </div>
  );
}
