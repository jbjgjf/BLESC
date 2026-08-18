"use client";

import Link from "next/link";
import { Icon } from "@/components/ui/Icon";
import { CLASS_BREAKDOWN, CLASS_ROSTER } from "@/lib/blesc/fixtures";
import { BANDS, BAND_ORDER, THEMES } from "@/lib/blesc/labels";
import type { RiskBand } from "@/lib/blesc/types";
import styles from "./class.module.css";

export default function ClassPage() {
  const counts = CLASS_ROSTER.reduce(
    (acc, student) => ({ ...acc, [student.band]: (acc[student.band] ?? 0) + 1 }),
    {} as Record<RiskBand, number>,
  );

  const submitted = CLASS_ROSTER.filter((student) => student.missedDays === 0).length;
  const withFollowUp = CLASS_ROSTER.filter((student) => student.hasFollowUp).length;

  return (
    <div className="bl-stack">
      <header style={{ padding: "2px 2px 0" }}>
        <h1 className="bl-h1">クラス全体</h1>
        <p className="bl-meta" style={{ marginTop: 3 }}>2年A組 ・ {CLASS_ROSTER.length}名</p>
      </header>

      {/* ── 6-1 クラス全体ヒートマップ ───────────────── */}
      <section className="bl-card bl-rise">
        <div className="bl-card-head">
          <Icon name="grid_view" size={21} />
          <h2 className="bl-h2">クラス全体ヒートマップ</h2>
          <span className="bl-spacer" />
          <div className={styles.legend}>
            {BAND_ORDER.slice().reverse().map((band) => (
              <span key={band} className="bl-row" style={{ gap: 6 }}>
                <span className={`bl-dot ${BANDS[band].dot}`} />
                <span className="bl-micro">
                  {BANDS[band].label} {counts[band] ?? 0}
                </span>
              </span>
            ))}
          </div>
        </div>

        <div className={styles.heatmap}>
          {CLASS_ROSTER.map((student) => {
            const meta = BANDS[student.band];
            return (
              <Link
                key={student.id}
                href={`/educator/student/${student.id}`}
                className={styles.cell}
                style={{ background: meta.bg, borderColor: meta.line, color: meta.ink }}
                title={`${student.name} ・ ${meta.label}`}
              >
                <span className={`bl-dot ${meta.dot}`} />
                <span className={styles.cellName}>{student.name}</span>
                {student.missedDays > 0 && (
                  <span className={styles.cellBadge} title={`${student.missedDays}日未提出`}>
                    <Icon name="event_busy" size={13} />
                  </span>
                )}
              </Link>
            );
          })}
        </div>

        <p className="bl-disclaimer" style={{ marginTop: 14 }}>
          <Icon name="info" size={14} />
          色は日記と対話の内容からAIが算出した傾向です。診断ではありません。
        </p>
      </section>

      {/* ── クラスの様子 ─────────────────────────────── */}
      <section className="bl-grid bl-grid--3 bl-rise">
        <div className="bl-card">
          <span className="bl-num">{Math.round((submitted / CLASS_ROSTER.length) * 100)}%</span>
          <p className="bl-meta">昨日までに日記を提出</p>
        </div>
        <div className="bl-card">
          <span className="bl-num">{withFollowUp}<span className={styles.unit}>名</span></span>
          <p className="bl-meta">対話型AIによる補足あり</p>
        </div>
        <div className="bl-card">
          <span className="bl-num">{CLASS_ROSTER.filter((s) => s.status !== "none").length}<span className={styles.unit}>名</span></span>
          <p className="bl-meta">対応が進行中</p>
        </div>
      </section>

      {/* ── 6-2 クラス全体分析 ───────────────────────── */}
      <section className="bl-card bl-rise">
        <div className="bl-card-head">
          <Icon name="pie_chart" size={21} />
          <h2 className="bl-h2">クラス全体の傾向</h2>
        </div>

        <p className="bl-body" style={{ marginBottom: 16 }}>
          日記と対話の内容から、いま何についての記述が多いかを集計しています。
        </p>

        <div className={styles.breakdown}>
          {CLASS_BREAKDOWN.map((item) => {
            const theme = THEMES[item.theme];
            return (
              <div key={item.theme} className={styles.breakRow}>
                <span className="bl-chip bl-chip--tint" style={{ width: "9.5rem" }}>
                  <Icon name={theme.icon} size={17} />
                  {theme.label}
                </span>

                <div className="bl-bar" style={{ flex: 1 }}>
                  <span style={{ width: `${item.share * 100}%` }} />
                </div>

                <span className={styles.share}>{Math.round(item.share * 100)}%</span>

                <span className={styles.delta} data-dir={item.delta > 0 ? "up" : item.delta < 0 ? "down" : "flat"}>
                  <Icon
                    name={item.delta > 0 ? "trending_up" : item.delta < 0 ? "trending_down" : "trending_flat"}
                    size={15}
                  />
                  {item.delta === 0 ? "±0" : `${item.delta > 0 ? "+" : ""}${Math.round(item.delta * 100)}`}
                </span>
              </div>
            );
          })}
        </div>

        <p className="bl-micro" style={{ marginTop: 14 }}>
          右端の数値は先週との差（ポイント）です。
        </p>
      </section>

      <section className="bl-card bl-rise">
        <div className="bl-card-head">
          <Icon name="lightbulb" size={21} />
          <h2 className="bl-h2">学級運営のヒント</h2>
        </div>
        <ul className={styles.hints}>
          <li>学業ストレスに関する記述が先週より5ポイント増えています。課題量の偏りを確認してみてください。</li>
          <li>睡眠に関する記述が増加傾向です。保健だよりや朝の声掛けと合わせて確認できます。</li>
          <li>人間関係に関する記述はやや減少しています。</li>
        </ul>
      </section>
    </div>
  );
}
