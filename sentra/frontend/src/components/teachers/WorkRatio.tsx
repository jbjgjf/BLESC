"use client";

/**
 * 業務タグの比率（C-1）。本人が選んだタグを数えただけのもの。
 *
 * 色は業務の種類を見分けるためだけに使う。どれが多いと良い・悪い、という
 * 読み方をさせないよう、同じ明るさの寒色で揃えてある。
 */

import { WORK_TAGS } from "@/lib/teachers/fixtures";
import type { SelfRecord, WorkTag } from "@/lib/teachers/types";
import { styles } from "./parts";

export const WORK_COLORS: Record<WorkTag, string> = {
  lesson: "hsl(206 46% 58%)",
  admin: "hsl(226 30% 64%)",
  students: "hsl(186 38% 52%)",
  club: "hsl(250 26% 66%)",
  parents: "hsl(198 24% 70%)",
  other: "hsl(210 10% 76%)",
};

export function workShares(records: ReadonlyArray<SelfRecord<WorkTag>>) {
  const counts = new Map<WorkTag, number>();
  for (const record of records) for (const tag of record.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  return WORK_TAGS.map((t) => ({ ...t, count: counts.get(t.value) ?? 0, share: total === 0 ? 0 : (counts.get(t.value) ?? 0) / total }));
}

export function WorkRatio({ records, label }: { records: ReadonlyArray<SelfRecord<WorkTag>>; label: string }) {
  const shares = workShares(records).filter((s) => s.count > 0);
  if (shares.length === 0) return <span className={styles.muted}>タグなし</span>;
  return (
    <span
      className={styles.ratio}
      role="img"
      aria-label={`${label}の業務タグ：${shares.map((s) => `${s.label}${Math.round(s.share * 100)}%`).join("、")}`}
    >
      {shares.map((s) => (
        <span key={s.value} style={{ width: `${s.share * 100}%`, background: WORK_COLORS[s.value] }} />
      ))}
    </span>
  );
}

export function WorkLegend() {
  return (
    <span className={styles.legend}>
      {WORK_TAGS.map((t) => (
        <span key={t.value}>
          <span className={styles.swatch} style={{ background: WORK_COLORS[t.value] }} />
          {t.label}
        </span>
      ))}
    </span>
  );
}
