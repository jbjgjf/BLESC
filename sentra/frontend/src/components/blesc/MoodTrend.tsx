"use client";

import { MOODS, MOOD_BY_VALUE, MOOD_SCORE, formatDate } from "@/lib/blesc/labels";
import type { Mood } from "@/lib/blesc/types";
import styles from "./MoodTrend.module.css";

/**
 * 日ごとの感情の推移（企画書 4-5 / 5-3）。
 *
 * 縦軸は「とても良い」を上、「つらい」を下に置く。点の色は感情スケールの
 * 色をそのまま使い、線は本文と competing しないよう淡い青にしている。
 */

const VIEW_W = 720;
const VIEW_H = 200;
const PAD_X = 18;
const PAD_Y = 22;

export function MoodTrend({
  series,
  showLabels = true,
}: {
  series: Array<{ date: string; mood: Mood }>;
  showLabels?: boolean;
}) {
  if (series.length === 0) {
    return (
      <p className="bl-meta" style={{ padding: "18px 0" }}>
        まだ記録がありません。
      </p>
    );
  }

  const innerW = VIEW_W - PAD_X * 2;
  const innerH = VIEW_H - PAD_Y * 2;
  const step = series.length > 1 ? innerW / (series.length - 1) : 0;

  const pointAt = (index: number, mood: Mood) => ({
    x: PAD_X + step * index + (series.length === 1 ? innerW / 2 : 0),
    y: PAD_Y + (MOOD_SCORE[mood] / 4) * innerH,
  });

  const points = series.map((item, index) => pointAt(index, item.mood));
  const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");

  // 目盛りの間隔。点が多いときは端と中間だけ出す。
  const labelEvery = Math.max(1, Math.ceil(series.length / 6));

  return (
    <div className={styles.root}>
      <div className={styles.scale} aria-hidden="true">
        {MOODS.map((mood) => (
          <span key={mood.value} style={{ color: mood.color }} title={mood.label}>
            <span className={styles.scaleDot} style={{ background: mood.color }} />
            {mood.label}
          </span>
        ))}
      </div>

      <svg
        className={styles.chart}
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        role="img"
        aria-label={`感情の推移。${formatDate(series[0].date, false)}から${formatDate(series[series.length - 1].date, false)}まで、${series.length}件の記録。`}
      >
        {/* 5段階のガイド線 */}
        {MOODS.map((mood, index) => {
          const y = PAD_Y + (index / 4) * innerH;
          return (
            <line
              key={mood.value}
              x1={PAD_X}
              x2={VIEW_W - PAD_X}
              y1={y}
              y2={y}
              className={styles.guide}
            />
          );
        })}

        <path d={path} className={styles.line} />

        {/* 同じ日に複数の記録があっても壊れないよう、キーは位置で持つ */}
        {points.map((point, index) => {
          const mood = MOOD_BY_VALUE[series[index].mood];
          return (
            <g key={index}>
              <circle cx={point.x} cy={point.y} r={7.5} fill="#ffffff" />
              <circle cx={point.x} cy={point.y} r={5.5} fill={mood.color}>
                <title>{`${formatDate(series[index].date, false)} ${mood.label}`}</title>
              </circle>
            </g>
          );
        })}
      </svg>

      {showLabels && (
        <div className={styles.dates}>
          {series.map((item, index) => (
            <span key={index} data-show={index % labelEvery === 0 || index === series.length - 1}>
              {formatDate(item.date, false)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
