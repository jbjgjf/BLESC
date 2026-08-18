"use client";

import { MOODS } from "@/lib/blesc/labels";
import { PETAL_PATH, petalTransform } from "@/lib/blesc/petal";
import type { Mood } from "@/lib/blesc/types";
import styles from "./MoodBloom.module.css";

/**
 * 気分の花 — 記録した期間そのものを 1 輪の花として見せる。
 *
 * 花びらは 5 つの気分にそのまま対応する（企画書 4-2 の 5 段階）。日数が
 * 多い気分ほど花びらが大きい。棒グラフと違って上下の並びがないので、
 * 「良い方が上」という読み方が生まれない — 企画書 10-1 の「生徒を評価・
 * 監視する印象を与えない」を、形のほうで守っている。
 *
 * 記録がまだない気分の花びらも、薄いままその場所に残す。欠けた花や枯れた
 * 花は書けなかった日を責めることになるので、つくらない。
 */

const EMPTY_SCALE = 0.42;
const MIN_SCALE = 0.6;

type MoodBloomProps = {
  counts: Record<Mood, number>;
  size?: number;
  /** 花びらの意味を読む必要がない場面（ホームの小さい表示など）では省く。 */
  legend?: boolean;
};

export function MoodBloom({ counts, size = 196, legend = true }: MoodBloomProps) {
  const values = MOODS.map((mood) => counts[mood.value] ?? 0);
  const busiest = Math.max(...values, 1);
  const total = values.reduce((sum, value) => sum + value, 0);

  return (
    <div className={styles.bloom}>
      <svg
        viewBox="0 0 100 100"
        width={size}
        height={size}
        className={styles.svg}
        role="img"
        aria-label={
          total === 0
            ? "まだ記録がありません"
            : MOODS.map((mood, index) => `${mood.label}${values[index]}日`).join("、")
        }
      >
        <g className={styles.petals}>
          {MOODS.map((mood, index) => {
            const count = values[index];
            const empty = count === 0;
            const scale = empty ? EMPTY_SCALE : MIN_SCALE + (1 - MIN_SCALE) * (count / busiest);

            return (
              <g key={mood.value} transform={petalTransform(index)}>
                <path
                  d={PETAL_PATH}
                  className={styles.petal}
                  style={
                    {
                      "--bl-petal-scale": scale,
                      animationDelay: `${index * 70}ms`,
                      fill: mood.color,
                      stroke: mood.color,
                      fillOpacity: empty ? 0.13 : 0.74,
                      strokeOpacity: empty ? 0.22 : 0.48,
                    } as React.CSSProperties
                  }
                />
              </g>
            );
          })}
        </g>

        {/* ロゴと同じ明るい芯。花びらが集まる所を締める。 */}
        <circle cx="50" cy="50" r="8" className={styles.core} />
      </svg>

      {legend && (
        <ul className={styles.legend}>
          {MOODS.map((mood, index) => (
            <li key={mood.value} className={styles.legendRow}>
              {/* 花びら 1 枚をそのまま切り出した見本。色で本体と対応させる。 */}
              <svg viewBox="31 1 38 51" width="15" height="20" aria-hidden="true" className={styles.legendPetal}>
                <path
                  d={PETAL_PATH}
                  fill={mood.color}
                  fillOpacity={values[index] === 0 ? 0.16 : 0.78}
                  stroke={mood.color}
                  strokeOpacity={values[index] === 0 ? 0.28 : 0.5}
                  strokeWidth={1.6}
                />
              </svg>
              <span className={styles.legendLabel}>{mood.label}</span>
              <span className={styles.legendCount} data-zero={values[index] === 0}>
                {values[index]}日
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
