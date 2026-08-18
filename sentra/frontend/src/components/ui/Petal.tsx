import { PETAL_PATH } from "@/lib/blesc/petal";

/**
 * 花びら 1 枚。
 *
 * 丸い点で足りるところをわざわざ花びらにするのは、生徒側の画面で
 * 「1 日 = 花びら 1 枚」を一貫させるため。積み重なると花になる、という
 * 見立てを小さい印のところから通しておく。
 */
export function Petal({
  color,
  size = 20,
  filled = true,
  title,
}: {
  color?: string;
  size?: number;
  /** false なら破線の輪郭だけ。まだ記録がない日に使う。 */
  filled?: boolean;
  title?: string;
}) {
  return (
    <svg
      viewBox="31 1 38 51"
      width={Math.round(size * 0.75)}
      height={size}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      <path
        d={PETAL_PATH}
        fill={filled && color ? color : "none"}
        fillOpacity={filled ? 0.8 : 0}
        stroke={filled ? (color ?? "var(--bl-line)") : "var(--bl-line)"}
        strokeOpacity={filled ? 0.55 : 1}
        strokeWidth={filled ? 1.6 : 2.6}
        strokeDasharray={filled ? undefined : "5 3.5"}
        strokeLinejoin="round"
      />
    </svg>
  );
}
