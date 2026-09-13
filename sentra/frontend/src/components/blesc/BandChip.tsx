import { Icon } from "@/components/ui/Icon";
import { BANDS, TRENDS } from "@/lib/blesc/labels";
import type { RiskBand, Trend } from "@/lib/blesc/types";

/** data-* などを外から付けられるように。見た目の指定だけはここで持つ。 */
type ChipAttributes = Omit<React.HTMLAttributes<HTMLSpanElement>, "className" | "style">;

/** 5-1 生徒の状態。緑 安定・黄 要注意・赤 高リスク。 */
export function BandChip({ band, size = "md", ...rest }: { band: RiskBand; size?: "sm" | "md" } & ChipAttributes) {
  const meta = BANDS[band];
  return (
    <span {...rest} className={`bl-chip ${meta.chip}`} style={size === "sm" ? { padding: "4px 10px", fontSize: "0.74rem" } : undefined}>
      <Icon name={meta.icon} size={size === "sm" ? 14 : 16} fill />
      {meta.label}
    </span>
  );
}

/** リスク傾向。 */
export function TrendChip({ trend, ...rest }: { trend: Trend } & ChipAttributes) {
  const meta = TRENDS[trend];
  return (
    <span {...rest} className="bl-chip" style={{ color: meta.color, borderColor: "var(--bl-line)" }}>
      <Icon name={meta.icon} size={15} />
      {meta.label}
    </span>
  );
}
