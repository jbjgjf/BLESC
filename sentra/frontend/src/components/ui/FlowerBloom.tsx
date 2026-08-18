"use client";

import styles from "./FlowerBloom.module.css";

/**
 * ロゴの花が一枚ずつ開く演出。日記を提出できたときにだけ使う。
 *
 * 花びらを描き直すのではなく、ロゴ画像そのものを 5 つの扇形に切り分けて
 * いる。マークは 72 度ごとの回転対称なので、扇形ひとつがちょうど花びら
 * 一枚にあたる。ブランドの形を作り変えずに、開く動きだけを足せる。
 */

const PETALS = 5;
const WEDGE = 360 / PETALS;

/** 扇形が画像の隅まで確実に覆う半径（％）。 */
const RADIUS = 160;

/**
 * 中心から広がる扇形の多角形。直線で結ぶと角が欠けるので、18 度ごとに
 * 点を置いて弧を近似している。
 */
function wedgeClipPath(index: number): string {
  const from = -WEDGE / 2 + index * WEDGE;
  const points = ["50% 50%"];

  for (let step = 0; step <= 4; step += 1) {
    const radians = ((from + (WEDGE / 4) * step) * Math.PI) / 180;
    const x = 50 + RADIUS * Math.sin(radians);
    const y = 50 - RADIUS * Math.cos(radians);
    points.push(`${x.toFixed(2)}% ${y.toFixed(2)}%`);
  }

  return `polygon(${points.join(", ")})`;
}

type FlowerBloomProps = {
  size?: number;
  /** 花びらの間隔（ミリ秒）。 */
  stagger?: number;
  className?: string;
};

export function FlowerBloom({ size = 84, stagger = 85, className }: FlowerBloomProps) {
  return (
    <div
      className={`${styles.bloom} ${className ?? ""}`}
      style={{
        width: size,
        height: size,
        // 全部開き切ってから、ひと呼吸おいて全体が落ち着く。
        animationDelay: `${PETALS * stagger + 180}ms`,
      }}
      aria-hidden="true"
    >
      {Array.from({ length: PETALS }, (_, index) => (
        <span
          key={index}
          className={styles.petal}
          style={{
            clipPath: wedgeClipPath(index),
            animationDelay: `${index * stagger}ms`,
          }}
        />
      ))}
    </div>
  );
}
