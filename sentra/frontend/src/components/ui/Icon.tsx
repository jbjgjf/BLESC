/**
 * Google Symbols (Material Symbols Rounded), self-hosted and subset to the
 * ~80 glyphs this app uses — see public/fonts/material-symbols-rounded.woff2.
 *
 * The font is variable across four axes; `fill`, `weight` and `grade` map onto
 * FILL/wght/GRAD, and `opsz` follows the rendered size so small icons keep
 * their stroke weight. Ligature names come straight from fonts.google.com/icons.
 */

export type IconName =
  | "add" | "apartment" | "arrow_back" | "arrow_forward" | "auto_awesome"
  | "bar_chart" | "bedtime" | "bookmark" | "calendar_month" | "call"
  | "campaign" | "chat_bubble" | "check" | "check_circle" | "chevron_left"
  | "chevron_right" | "close" | "dashboard" | "description" | "donut_large"
  | "edit" | "edit_note" | "error" | "escalator_warning" | "event_available"
  | "event_busy" | "event_note" | "event_repeat" | "expand_more"
  | "family_restroom" | "filter_list" | "forum" | "graphic_eq" | "grid_view"
  | "group" | "groups" | "history" | "home" | "house" | "info" | "insights"
  | "lightbulb" | "local_fire_department" | "lock" | "logout"
  | "medical_information" | "menu" | "mic" | "monitoring" | "mood"
  | "more_horiz" | "notes" | "notifications" | "notifications_active"
  | "person" | "pie_chart" | "priority_high" | "psychology" | "psychology_alt"
  | "school" | "search" | "send" | "sentiment_dissatisfied"
  | "sentiment_neutral" | "sentiment_satisfied" | "sentiment_very_dissatisfied"
  | "sentiment_very_satisfied" | "settings" | "shield" | "signpost"
  | "sports_basketball" | "star" | "summarize" | "support_agent" | "timeline"
  | "trending_down" | "trending_flat" | "trending_up" | "visibility"
  | "warning" | "waving_hand";

type IconProps = {
  name: IconName;
  size?: number;
  fill?: boolean;
  weight?: 100 | 200 | 300 | 400 | 500 | 600 | 700;
  grade?: number;
  className?: string;
  style?: React.CSSProperties;
};

export function Icon({
  name,
  size = 20,
  fill = false,
  weight = 400,
  grade = 0,
  className,
  style,
}: IconProps) {
  return (
    <span
      aria-hidden="true"
      translate="no"
      className={["blesc-icon", className].filter(Boolean).join(" ")}
      style={{
        fontSize: size,
        width: size,
        height: size,
        fontVariationSettings: `'FILL' ${fill ? 1 : 0}, 'wght' ${weight}, 'GRAD' ${grade}, 'opsz' ${Math.min(48, Math.max(20, size))}`,
        ...style,
      }}
    >
      {name}
    </span>
  );
}
