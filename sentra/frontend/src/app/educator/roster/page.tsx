"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Icon } from "@/components/ui/Icon";
import { BandChip, TrendChip } from "@/components/blesc/BandChip";
import { CLASS_ROSTER } from "@/lib/blesc/fixtures";
import { BANDS, BAND_ORDER, STATUSES, THEMES, formatDate, relativeDays } from "@/lib/blesc/labels";
import type { RiskBand } from "@/lib/blesc/types";
import styles from "./roster.module.css";

type Filter = RiskBand | "all";

const FILTERS: Array<{ value: Filter; label: string }> = [
  { value: "all", label: "すべて" },
  { value: "alert", label: "高リスク" },
  { value: "watch", label: "要注意" },
  { value: "calm", label: "安定" },
];

export default function RosterPage() {
  const params = useSearchParams();
  const initial = (params.get("band") as Filter | null) ?? "all";
  const [filter, setFilter] = useState<Filter>(
    FILTERS.some((f) => f.value === initial) ? initial : "all",
  );
  const [query, setQuery] = useState("");

  const rows = useMemo(() => {
    const term = query.trim();
    return CLASS_ROSTER.filter((student) => {
      if (filter !== "all" && student.band !== filter) return false;
      if (term && !student.name.includes(term)) return false;
      return true;
    }).sort(
      (a, b) =>
        BAND_ORDER.indexOf(a.band) - BAND_ORDER.indexOf(b.band) ||
        b.missedDays - a.missedDays ||
        a.name.localeCompare(b.name, "ja"),
    );
  }, [filter, query]);

  return (
    <div className="bl-stack">
      <header className={styles.head}>
        <div>
          <h1 className="bl-h1">生徒一覧</h1>
          <p className="bl-meta">2年A組 ・ {CLASS_ROSTER.length}名</p>
        </div>

        <label className={styles.search}>
          <Icon name="search" size={19} />
          <input
            className={styles.searchInput}
            type="search"
            placeholder="生徒名で絞り込む"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="生徒名で絞り込む"
          />
        </label>
      </header>

      <div className={styles.filters}>
        {FILTERS.map((option) => {
          const count =
            option.value === "all"
              ? CLASS_ROSTER.length
              : CLASS_ROSTER.filter((student) => student.band === option.value).length;
          return (
            <button
              key={option.value}
              type="button"
              className="bl-choice"
              aria-pressed={filter === option.value}
              onClick={() => setFilter(option.value)}
            >
              {option.value !== "all" && <span className={`bl-dot ${BANDS[option.value].dot}`} />}
              {option.label}
              <span className={styles.filterCount}>{count}</span>
            </button>
          );
        })}
      </div>

      {/* ── 表（デスクトップ） ─────────────────────── */}
      <div className="bl-card bl-card--flush bl-rise">
        <div className={styles.tableScroll}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">生徒名</th>
                <th scope="col">状態</th>
                <th scope="col">傾向</th>
                <th scope="col">最終提出</th>
                <th scope="col">未提出</th>
                <th scope="col">AI補足</th>
                <th scope="col">主な観点</th>
                <th scope="col">対応</th>
                <th scope="col">担当</th>
                <th scope="col"><span className="sr-only">詳細</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((student) => (
                <tr key={student.id} data-band={student.band}>
                  <th scope="row">
                    <Link href={`/educator/student/${student.id}`} className={styles.name}>
                      {student.name}
                    </Link>
                    <span className={styles.klass}>
                      {student.grade}
                      {student.className}
                    </span>
                  </th>
                  <td><BandChip band={student.band} size="sm" /></td>
                  <td><TrendChip trend={student.trend} /></td>
                  <td className={styles.num}>{relativeDays(student.lastEntry)}</td>
                  <td className={styles.num}>
                    {student.missedDays > 0 ? (
                      <span className="bl-chip bl-chip--watch" style={{ padding: "3px 9px", fontSize: "0.73rem" }}>
                        {student.missedDays}日
                      </span>
                    ) : (
                      <span className="bl-micro">—</span>
                    )}
                  </td>
                  <td>
                    {student.hasFollowUp ? (
                      <span className={styles.hasFollowUp} title="対話型AIによる補足あり">
                        <Icon name="forum" size={18} fill />
                      </span>
                    ) : (
                      <span className="bl-micro">—</span>
                    )}
                  </td>
                  <td>
                    <span className={styles.themes}>
                      {student.topThemes.length === 0 ? (
                        <span className="bl-micro">—</span>
                      ) : (
                        student.topThemes.map((theme) => (
                          <span key={theme} className="bl-chip bl-chip--tint" style={{ padding: "3px 9px", fontSize: "0.72rem" }}>
                            <Icon name={THEMES[theme].icon} size={13} />
                            {THEMES[theme].label}
                          </span>
                        ))
                      )}
                    </span>
                  </td>
                  <td>
                    <span className="bl-micro" style={{ whiteSpace: "nowrap" }}>
                      {STATUSES[student.status].label}
                    </span>
                  </td>
                  <td className="bl-micro" style={{ whiteSpace: "nowrap" }}>{student.teacher}</td>
                  <td>
                    <Link
                      href={`/educator/student/${student.id}`}
                      className="bl-icon-btn"
                      aria-label={`${student.name}の詳細`}
                    >
                      <Icon name="chevron_right" size={20} />
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {rows.length === 0 && (
          <div className="bl-empty">
            <Icon name="search" size={40} />
            <p className="bl-body">該当する生徒がいません。</p>
          </div>
        )}
      </div>

      {/* ── カード（モバイル） ─────────────────────── */}
      <div className={styles.cards}>
        {rows.map((student) => (
          <Link key={student.id} href={`/educator/student/${student.id}`} className={`bl-card bl-card--link ${styles.card}`}>
            <div className="bl-row-between">
              <span className="bl-h3">{student.name}</span>
              <BandChip band={student.band} size="sm" />
            </div>
            <div className="bl-row" style={{ gap: 6, flexWrap: "wrap", marginTop: 8 }}>
              <TrendChip trend={student.trend} />
              {student.hasFollowUp && (
                <span className="bl-chip bl-chip--tint">
                  <Icon name="forum" size={14} fill />
                  AI補足
                </span>
              )}
              {student.missedDays > 0 && (
                <span className="bl-chip bl-chip--watch">
                  <Icon name="event_busy" size={14} />
                  {student.missedDays}日未提出
                </span>
              )}
            </div>
            <p className="bl-micro" style={{ marginTop: 8 }}>
              最終提出 {student.lastEntry ? formatDate(student.lastEntry, false) : "記録なし"} ・{" "}
              {STATUSES[student.status].label}
            </p>
          </Link>
        ))}
      </div>

      <p className="bl-disclaimer">
        <Icon name="shield" size={15} />
        日記の本文と対話の全文はここには表示されません。閲覧の記録は生徒側からも確認できます。
      </p>
    </div>
  );
}
