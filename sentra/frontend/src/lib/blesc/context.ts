export type AppContext = "student" | "educator" | "guardian" | "teachers";

/**
 * その画面が誰のためのものか。
 *
 * 見た目の温度をここで分けている。生徒側は花と丸みのあるテーマ、教員側と
 * 保護者側は落ち着いた素のままの見た目。危機のアラートを読む画面に花びらは
 * 要らない。テーマの CSS はすべて [data-bl-context="student"] の下に置いて
 * あるので、この判定を通さない限り生徒向けの装飾は適用されない。
 *
 * "teachers" は Blesc for Teachers（/teachers）。先生自身の記録のための
 * 別のサービスで、外枠も色（ラベンダー）も生徒・教員の Blesc とは別に持つ。
 */
export function contextForPath(pathname: string): AppContext {
  if (pathname.startsWith("/educator") || pathname.startsWith("/school")) return "educator";
  if (pathname.startsWith("/teachers")) return "teachers";
  if (pathname.startsWith("/guardian")) return "guardian";
  return "student";
}
