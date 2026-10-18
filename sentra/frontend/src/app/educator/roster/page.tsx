"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { AlertCircle, ArrowRight, Loader2 } from "lucide-react";

import { ApiClient } from "@/api/client";
import { t } from "@/lib/i18n";
import type { EducatorStudentStatus } from "@/api/models";
import {
  AttentionChip,
  NonDiagnosticNotice,
  ObservationLine,
  byNewestObservation,
  hasShowableObservation,
  panel,
  studentIdentity,
} from "@/components/educator/StatusChips";

/*
 * 名簿の一行に出すのは、クラス・出席番号と、観測（種類・時刻・入力元・根拠）だけ
 * （#466）。blesc.jp の約束 「先生に表示されるのは、クラス、出席番号、観測された
 * 表現の種類、時刻だけです。」 に合わせている。
 *
 * #466 で外したもの:
 *   - 生徒の名前（`display_name ?? code`）。API の返り値からも外した。
 *   - 内部コード（`code`）の併記。
 *   - 「最後の記録 YYYY/MM/DD」と「記録が途切れている」の絞り込み。どちらも
 *     生徒ごとの記録状況で、約束した表示項目の外にある。
 *   - 基準値の学習状況の行。
 */
type Filter = "all" | "flagged";

/*
 * 並び順は観測の新しい順（#466）。観測のある生徒が先に来て、その中では時刻が
 * 新しいものが上。観測のない生徒はクラス・出席番号順。
 *
 * 以前は crisis=8 / elevated=4 の重みで並べていた。危機の観測を上に出すという
 * 意図は分かるが、サイトのモックは新しい順で、並びの規則は一つのほうが教員に
 * 説明できる。危機の観測は行の右の「要確認」と、プッシュ通知
 * （docs/crisis_escalation.md）で届く。推定された帯で並べないこと
 * （educator_display_policy.md 規則 1）は変わらない。実装は
 * `lib/educatorIdentity.ts` の `byNewestObservation`。
 */

export default function EducatorRosterPage() {
  const [roster, setRoster] = useState<EducatorStudentStatus[] | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [error, setError] = useState<string | null>(null);
  const logged = useRef(false);

  useEffect(() => {
    let cancelled = false;
    ApiClient.getCohortRoster()
      .then((students) => {
        if (cancelled) return;
        setRoster(students);
        setError(null);
        if (!logged.current && students.length) {
          logged.current = true;
          void ApiClient.recordCohortAccess(students, "roster");
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : t.educator.roster.loadFailed);
      });
    return () => { cancelled = true; };
  }, []);

  const visible = useMemo(() => {
    if (!roster) return [];
    const filtered = roster.filter((student) => (filter === "all" ? true : hasShowableObservation(student)));
    return [...filtered].sort(byNewestObservation);
  }, [roster, filter]);

  if (error) {
    return <div className="flex items-center gap-2 px-6 py-4 text-sm" style={{ ...panel, color: "var(--sienna)" }}><AlertCircle className="h-4 w-4" />{error}</div>;
  }
  if (!roster) {
    return <div className="flex h-48 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin" style={{ color: "var(--sandstone)" }} /></div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {(["all", "flagged"] as Filter[]).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setFilter(option)}
            className="rounded-full px-4 py-1.5 text-xs font-semibold transition-all"
            style={{
              border: filter === option ? "1px solid transparent" : "1px solid var(--blue-base)",
              background: filter === option ? "var(--blue-base)" : "#ffffff",
              color: "var(--ink)",
              cursor: "pointer",
            }}
          >
            {option === "all" ? t.educator.roster.filterAll(roster.length) : t.educator.roster.filterFlagged}
          </button>
        ))}
        <span className="text-xs" style={{ color: "var(--ink-faint)" }}>{t.educator.roster.orderNote}</span>
      </div>

      {roster.length === 0 ? (
        <section className="px-8 py-10 text-center text-sm" style={{ ...panel, color: "var(--ink-mid)" }}>
          {t.educator.roster.emptyNoConsent}
        </section>
      ) : visible.length === 0 ? (
        <section className="px-8 py-8 text-center text-sm" style={{ ...panel, color: "var(--ink-faint)" }}>
          {t.educator.roster.emptyNoMatch}
        </section>
      ) : (
        <section style={panel}>
          {visible.map((student) => (
            <Link
              key={student.participant_id}
              href={`/educator/student/${student.participant_id}`}
              className="flex flex-wrap items-center justify-between gap-3 px-6 py-4"
              style={{ borderBottom: "1px solid var(--limestone)", textDecoration: "none" }}
            >
              <div className="min-w-0">
                <div className="font-semibold" style={{ color: "var(--ink)" }}>
                  {studentIdentity(student)}
                </div>
                <div className="mt-1.5 space-y-0.5">
                  {hasShowableObservation(student) ? (
                    <ObservationLine student={student} />
                  ) : (
                    <div className="text-xs" style={{ color: "var(--ink-faint)" }}>{t.educator.roster.noObservation}</div>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <AttentionChip student={student} />
                <ArrowRight className="h-4 w-4" style={{ color: "var(--ink-faint)" }} />
              </div>
            </Link>
          ))}
        </section>
      )}
      <NonDiagnosticNotice />
    </div>
  );
}
