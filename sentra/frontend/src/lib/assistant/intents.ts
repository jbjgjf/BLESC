import type { A11ySettings, TextSize } from "@/lib/a11y";
import type { AppContext } from "@/lib/blesc/context";
import type { PilotProgress } from "@/lib/blesc/pilot";
import type { TeacherRole } from "@/lib/teachers/types";
import type { IconName } from "@/components/ui/Icon";
import type { SafetyAssessment } from "@/api/models";
import type { Expression } from "./pebble";

/**
 * 言葉から「何をするか」を決める部分。
 *
 * ここに言語モデルは置いていない。理由は 3 つある。
 *
 *  1. 読み上げや拡大表示を使っている人にとって、これは移動手段であって
 *     会話相手ではない。「日記」と言って 9 割の確率で日記に着くようでは
 *     道具にならない。表を引くだけなら毎回同じ場所に着く。
 *  2. 往復で数秒かかる案内は、自分で押したほうが速い。
 *  3. ここに打った言葉は端末から出ない。相談の中身は /chat が
 *     同意と監査の仕組みごと引き受ける — その手前に、記録の外側で
 *     悩みを聞く 2 つ目の窓口を作らない。
 *
 * 画面に出ている言葉の説明（後半の GLOSSARY）も同じ理由で表から引く。
 * 説明はどれも、その画面にすでに書いてある文言と、データの定義
 * （lib/blesc/types.ts・labels.ts）から起こしてある。もっともらしい
 * 作文で埋めると、教員が「変化あり」の意味を取り違えることになる。
 *
 * 表で拾えない言葉は無理に答えない。生徒の画面では、気持ちの話だと
 * 分かった時点で相談ページへ渡す。
 */

/** 誰の画面か。保護者の画面にはまだ置いていない。 */
export type Audience = Exclude<AppContext, "guardian">;

/** 行き先。href はすべてここに書いた定数で、入力から組み立てることはない。 */
export type Destination = {
  href: string;
  label: string;
  icon: IconName;
  /** 教員の画面で、そのページを開ける立場。省くとだれでも開ける。 */
  roles?: readonly TeacherRole[];
};

export const DESTINATIONS = {
  home:     { href: "/",               label: "今日",           icon: "home" },
  journal:  { href: "/journal",        label: "日記",           icon: "edit_note" },
  reflect:  { href: "/reflect",        label: "振り返り",       icon: "insights" },
  chat:     { href: "/chat",           label: "相談",           icon: "chat_bubble" },
  sharing:  { href: "/sharing",        label: "共有の設定",     icon: "shield" },
  audit:    { href: "/audit",          label: "AI処理の記録",   icon: "history" },
  timeline: { href: "/timeline",       label: "タイムライン",   icon: "timeline" },
  summary:  { href: "/support-summary", label: "支援サマリー",  icon: "summarize" },
} as const satisfies Record<string, Destination>;

/**
 * 教員の行き先。roles はナビ（components/AppNav.tsx）の立場ごとの並びと
 * 揃えてある。開けない立場で頼まれたら、動かずにそう伝える — 開いても
 * 「この画面は開けません」が出るだけなので。
 */
export const EDUCATOR_DESTINATIONS = {
  today:    { href: "/educator",            label: "今日の記録", icon: "edit_note",  roles: ["homeroom", "manager"] },
  records:  { href: "/educator/my-records", label: "振り返り",   icon: "insights",   roles: ["homeroom", "manager"] },
  class:    { href: "/educator/class",      label: "クラス",     icon: "groups",     roles: ["homeroom"] },
  staff:    { href: "/educator/staff",      label: "教職員",     icon: "group",      roles: ["manager"] },
  meetings: { href: "/educator/meetings",   label: "面談メモ",   icon: "event_note", roles: ["homeroom", "manager"] },
  settings: { href: "/educator/settings",   label: "学校の設定", icon: "settings",   roles: ["admin"] },
  usage:    { href: "/educator/usage",      label: "利用状況",   icon: "bar_chart",  roles: ["admin"] },
} as const satisfies Record<string, Destination>;

/** 立場の呼び名。components/teachers/parts.tsx の ROLE_NAME と同じ。 */
const ROLE_NAME: Record<TeacherRole, string> = { homeroom: "担任", manager: "管理職", admin: "学校管理者" };

/**
 * 立場ごとの入口。first は最初の画面（ナビの先頭）、greet はあいさつの
 * 続きに出す言葉、featured はその立場にしかない画面、term は「〜って何？」
 * の例に出す言葉。
 */
const ROLE_ENTRY: Record<TeacherRole, { first: Destination; greet: string; featured: Destination; term: string }> = {
  homeroom: { first: EDUCATOR_DESTINATIONS.today,    greet: "今日の記録を書く", featured: EDUCATOR_DESTINATIONS.class, term: "変化あり" },
  manager:  { first: EDUCATOR_DESTINATIONS.today,    greet: "今日の記録を書く", featured: EDUCATOR_DESTINATIONS.staff, term: "変化あり" },
  admin:    { first: EDUCATOR_DESTINATIONS.settings, greet: "学校の設定を開く", featured: EDUCATOR_DESTINATIONS.usage, term: "記録率" },
};

/** 「〜で見る」に出すページの呼び名。 */
const PAGE_LABELS: Record<string, string> = {
  "/": "ホーム",
  "/reflect": "振り返り",
  "/journal": "日記",
  "/sharing": "共有の設定",
  "/timeline": "タイムライン",
  "/insights": "変化の内訳",
  "/audit": "AI処理の記録",
  "/support-summary": "支援サマリー",
  "/educator": "今日の記録",
  "/educator/my-records": "振り返り",
  "/educator/class": "クラス",
  "/educator/staff": "教職員",
  "/educator/meetings": "面談メモ",
  "/educator/settings": "学校の設定",
  "/educator/usage": "利用状況",
};

export type AssistantAction =
  | { kind: "navigate"; href: string }
  | { kind: "display"; patch: Partial<A11ySettings> }
  | { kind: "open-settings" }
  /** 表示をすべて既定に戻す。既定値そのものは lib/a11y.ts が持つ。 */
  | { kind: "reset-display" }
  /** できることの説明を出す。 */
  | { kind: "help" }
  /** 相談ページへ渡す。text は下書きとして持っていく。 */
  | { kind: "handoff"; text: string }
  /**
   * 画面の中の場所を示す。heading はそこに書いてある見出しの文字。
   * href がいまのページと違うときは、先にそのページを開いてから示す。
   */
  | { kind: "show"; heading: string; href: string | null }
  /** 本人がそう打ったのと同じように扱う。続けて聞ける言葉のボタンに使う。 */
  | { kind: "ask"; text: string };

export type AssistantOffer = {
  label: string;
  icon: IconName;
  action: AssistantAction;
};

export type AssistantReply = {
  /** 画面と読み上げに出す文。 */
  say: string;
  expression: Expression;
  /** すぐ実行するもの。 */
  actions: AssistantAction[];
  /** 本人が押して初めて動くもの。 */
  offers: AssistantOffer[];
  /**
   * 安全に関わる応答。跳ねる動きを止め、見た目も落ち着かせる。
   * 生徒への文は lib/safety-assessment.ts の監査済みの文をそのまま使う。
   */
  calm?: boolean;
};

export type AssistantContext = {
  audience: Audience;
  pathname: string;
  settings: A11ySettings;
  /** 試験導入期間の進み具合。未確定（ハイドレーション前）は null。 */
  pilot: PilotProgress | null;
  /** lib/safety-assessment.ts の判定結果。 */
  safety: SafetyAssessment;
  /** これまでに送った回数。雑談の返事を毎回同じ言い回しにしないために使う。 */
  turn: number;
  /**
   * 教員の画面での立場（担任・管理職・学校管理者）。開ける画面が立場で
   * 違う。生徒の画面では使わない。
   */
  role?: TeacherRole;
};

/** 小さい順。a11y.ts の TextSize を大小で並べたもの。 */
const TEXT_ORDER = ["s", "m", "l", "xl"] as const satisfies ReadonlyArray<TextSize>;

/**
 * 表記ゆれをならす。
 *
 * 全角英数と半角、大文字小文字、そしてカタカナとひらがなを同じものとして
 * 扱う。学校の端末では入力途中の変換がそのまま送られることが多く、
 * 「モジ」と「もじ」で挙動が変わるのは理由の説明がつかない。
 */
export function normalize(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[ァ-ヶ]/g, (kana) => String.fromCharCode(kana.charCodeAt(0) - 0x60))
    .replace(/[\s、。，．!！?？「」『』()（）]/g, "");
}

type Said = { text: string; raw: string };

type Intent = {
  id: string;
  /** 省くと、生徒と教員のどちらの画面でも拾う。 */
  audience?: Audience;
  words: readonly string[];
  /**
   * 入力全体がこの語と同じときだけ拾う。「はい」「うん」のような短い相づちは、
   * 部分一致にすると「うんどう会」のような別の言葉に紛れ込む。
   */
  exact?: readonly string[];
  /** 雑談。操作を頼む言葉と一緒に来たら、操作のほうを優先する。 */
  chat?: boolean;
  reply: (context: AssistantContext, said: Said) => AssistantReply;
};

/** 言い回しを送った回数で回す。乱数にしないのは、試験で再現できるように。 */
const pick = (lines: readonly string[], turn: number) => lines[turn % lines.length];

/** 立場。省いたときは担任（lib/teachers/store.ts の既定と同じ）。 */
const roleOf = (context: AssistantContext): TeacherRole => context.role ?? "homeroom";

/** 生徒・先生ひとりずつの画面。面談前サマリーと面談メモは、ここのタブにある。 */
const onStudentDetail = (pathname: string) => pathname.startsWith("/educator/student/");
const onStaffDetail = (pathname: string) => pathname.startsWith("/educator/staff/");
const onPersonDetail = (pathname: string) => onStudentDetail(pathname) || onStaffDetail(pathname);

/** 相手のあいさつに合わせて返す。 */
function greetingFor(text: string): string {
  if (text.includes("おはよう")) return "おはようございます。";
  if (text.includes("こんばんは") || text.includes("こんばんわ")) return "こんばんは。";
  if (text.includes("はじめまして")) return "はじめまして。";
  if (text.includes("よろしく")) return "よろしくお願いします。";
  return "こんにちは。";
}

const goTo = (destination: Destination, context: AssistantContext, say: string): AssistantReply => {
  const role = roleOf(context);
  if (context.audience === "educator" && destination.roles && !destination.roles.includes(role)) {
    return {
      say: `${destination.label}は、${destination.roles.map((r) => ROLE_NAME[r]).join("・")}の立場で開く画面です。いまは${ROLE_NAME[role]}の立場で見ています。`,
      expression: "listening",
      actions: [],
      offers: [],
    };
  }
  if (context.pathname === destination.href) {
    return {
      say: `いま開いているのが${destination.label}のページです。`,
      expression: "bright",
      actions: [],
      offers: [],
    };
  }
  return {
    say,
    expression: "bright",
    actions: [{ kind: "navigate", href: destination.href }],
    offers: [],
  };
};

/** 表示を変えたときの返事。取り消せることを必ず添える。 */
const changed = (say: string, patch: Partial<A11ySettings>, previous: Partial<A11ySettings>): AssistantReply => ({
  say,
  expression: "bright",
  actions: [{ kind: "display", patch }],
  offers: [
    { label: "元に戻す", icon: "arrow_back", action: { kind: "display", patch: previous } },
    { label: "表示設定を開く", icon: "settings", action: { kind: "open-settings" } },
  ],
});

const ABOUT_THIS_PAGE: AssistantOffer = { label: "この画面について", icon: "info", action: { kind: "ask", text: "この画面は何？" } };

/** いまの画面の中の場所を、押せば示せるようにして返す。 */
const pointHere = (heading: string, say: string): AssistantReply => ({
  say,
  expression: "bright",
  actions: [],
  offers: [{ label: "画面で見る", icon: "visibility", action: { kind: "show", heading, href: null } }],
});

/** 教員の画面での「使い方」。例に出す画面と言葉は、立場で開けるものにする。 */
const educatorHelp = (entry: (typeof ROLE_ENTRY)[TeacherRole]): AssistantReply => ({
  say: `画面を開いたり、文字の大きさや色を変えたりできます。「${entry.featured.label}」のような画面の名前のほか、「${entry.term}って何？」のように、画面に出ている言葉の意味も聞けます。`,
  expression: "listening",
  actions: [],
  offers: [
    { label: entry.featured.label, icon: entry.featured.icon, action: { kind: "navigate", href: entry.featured.href } },
    ABOUT_THIS_PAGE,
    { label: "文字を大きく", icon: "add", action: { kind: "display", patch: { text: "l" } } },
    { label: "表示設定を開く", icon: "settings", action: { kind: "open-settings" } },
  ],
});

const INTENTS: readonly Intent[] = [
  // ── 移動（生徒） ─────────────────────────────────────────
  {
    id: "journal",
    audience: "student",
    words: ["日記", "にっき", "今日のこと", "書きたい", "記録したい", "入力"],
    reply: (context) => goTo(DESTINATIONS.journal, context, "日記のページを開きますね。"),
  },
  {
    id: "reflect",
    audience: "student",
    words: ["振り返り", "ふりかえり", "グラフ", "変化", "傾向", "これまで", "先週"],
    reply: (context) => goTo(DESTINATIONS.reflect, context, "振り返りのページを開きますね。"),
  },
  {
    id: "chat",
    audience: "student",
    words: ["相談", "話したい", "聞いてほしい", "聞いて", "悩み", "はなしたい"],
    reply: (context) => goTo(DESTINATIONS.chat, context, "相談のページを開きますね。ゆっくりで大丈夫です。"),
  },
  {
    id: "home",
    audience: "student",
    words: ["ホーム", "最初の画面", "トップ", "さいしょ"],
    reply: (context) => goTo(DESTINATIONS.home, context, "ホームに戻りますね。"),
  },
  {
    id: "sharing",
    audience: "student",
    words: ["共有", "だれが見", "誰が見", "先生に見", "見られ", "プライバシー", "公開範囲"],
    reply: (context) =>
      goTo(DESTINATIONS.sharing, context, "誰に何が伝わるかは、共有の設定で確かめられます。開きますね。"),
  },
  {
    id: "audit",
    audience: "student",
    words: ["aiの記録", "どう使われ", "処理の記録", "履歴"],
    reply: (context) => goTo(DESTINATIONS.audit, context, "AI処理の記録を開きますね。"),
  },
  {
    id: "timeline",
    audience: "student",
    words: ["タイムライン", "たいむらいん"],
    reply: (context) => goTo(DESTINATIONS.timeline, context, "タイムラインを開きますね。"),
  },
  {
    id: "summary",
    audience: "student",
    words: ["支援サマリー", "サマリー", "まとめ"],
    reply: (context) => goTo(DESTINATIONS.summary, context, "支援サマリーを開きますね。"),
  },

  // ── 移動（教員） ─────────────────────────────────────────
  // 開ける画面は立場で違う。開けない画面を頼まれたら、goTo がそう答える。
  {
    id: "educator-home",
    audience: "educator",
    words: ["ホーム", "ダッシュボード", "トップ", "最初の画面", "さいしょ"],
    reply: (context) => goTo(ROLE_ENTRY[roleOf(context)].first, context, "最初の画面に戻りますね。"),
  },
  {
    id: "today",
    audience: "educator",
    words: ["今日の記録", "記録を書", "記録したい", "記録する"],
    reply: (context) => goTo(EDUCATOR_DESTINATIONS.today, context, "今日の記録を開きますね。"),
  },
  {
    id: "my-records",
    audience: "educator",
    words: ["振り返り", "ふりかえり", "過去の記録", "これまでの記録", "自分の記録", "カレンダー"],
    reply: (context) => goTo(EDUCATOR_DESTINATIONS.records, context, "振り返りを開きますね。"),
  },
  {
    id: "class",
    audience: "educator",
    words: ["クラス", "学級", "生徒一覧", "生徒の一覧", "生徒"],
    reply: (context) => goTo(EDUCATOR_DESTINATIONS.class, context, "クラスの一覧を開きますね。"),
  },
  {
    id: "staff",
    audience: "educator",
    words: ["教職員", "先生の一覧", "先生一覧", "職員"],
    reply: (context) => goTo(EDUCATOR_DESTINATIONS.staff, context, "教職員の一覧を開きますね。"),
  },
  {
    id: "meetings",
    audience: "educator",
    words: ["面談メモ", "面談", "めんだん", "面接", "メモ"],
    reply: (context) =>
      // ひとりずつの画面では、その人の面談メモを示す。一覧の画面ではメモを書けない。
      onPersonDetail(context.pathname)
        ? pointHere("面談メモ", "面談メモは、この画面のタブから読み書きできます。")
        : goTo(EDUCATOR_DESTINATIONS.meetings, context, "面談メモの一覧を開きますね。"),
  },
  {
    id: "summary",
    audience: "educator",
    words: ["面談前サマリー", "サマリー", "要約"],
    reply: (context) => {
      if (onPersonDetail(context.pathname)) return pointHere("面談前サマリー", "面談前サマリーは、この画面のタブから開けます。");
      const list = roleOf(context) === "manager" ? EDUCATOR_DESTINATIONS.staff : EDUCATOR_DESTINATIONS.class;
      return goTo(list, context, `面談前サマリーは、ひとりずつの画面にあります。${list.label}の一覧から選んでください。`);
    },
  },
  {
    id: "school-settings",
    audience: "educator",
    words: ["学校の設定", "学校設定"],
    reply: (context) => goTo(EDUCATOR_DESTINATIONS.settings, context, "学校の設定を開きますね。"),
  },
  {
    id: "usage",
    audience: "educator",
    words: ["利用状況", "利用率"],
    reply: (context) => goTo(EDUCATOR_DESTINATIONS.usage, context, "利用状況を開きますね。"),
  },

  // ── 表示 ───────────────────────────────────────────────
  {
    id: "text-up",
    words: ["大きく", "大きい", "おおきく", "拡大", "字が小さ", "文字が小さ", "見えにく", "見にく", "読みにく", "小さすぎ", "見づらい", "見ずらい"],
    reply: (context) => {
      const index = TEXT_ORDER.indexOf(context.settings.text);
      if (index >= TEXT_ORDER.length - 1) {
        return {
          say: "文字はすでに一番大きい設定です。行間を広げると、もう少し読みやすくなるかもしれません。",
          expression: "oops",
          actions: [],
          offers: [
            { label: "行間を広げる", icon: "notes", action: { kind: "display", patch: { line: "relaxed" } } },
            { label: "表示設定を開く", icon: "settings", action: { kind: "open-settings" } },
          ],
        };
      }
      return changed("文字を大きくしました。", { text: TEXT_ORDER[index + 1] }, { text: context.settings.text });
    },
  },
  {
    id: "text-down",
    words: ["小さく", "ちいさく", "縮小", "大きすぎ"],
    reply: (context) => {
      const index = TEXT_ORDER.indexOf(context.settings.text);
      if (index <= 0) {
        return {
          say: "文字はすでに一番小さい設定です。",
          expression: "oops",
          actions: [],
          offers: [{ label: "表示設定を開く", icon: "settings", action: { kind: "open-settings" } }],
        };
      }
      return changed("文字を小さくしました。", { text: TEXT_ORDER[index - 1] }, { text: context.settings.text });
    },
  },
  {
    id: "line",
    words: ["行間", "ぎょうかん", "ゆったり", "詰まって", "行がくっつ"],
    reply: (context) =>
      context.settings.line === "relaxed"
        ? changed("行間を元の広さに戻しました。", { line: "normal" }, { line: "relaxed" })
        : changed("行間を広げました。", { line: "relaxed" }, { line: "normal" }),
  },
  {
    id: "contrast",
    words: ["コントラスト", "はっきり", "色を濃く", "薄くて", "うすくて", "まぶしい"],
    reply: (context) =>
      context.settings.contrast === "high"
        ? changed("コントラストを元に戻しました。", { contrast: "normal" }, { contrast: "high" })
        : changed("文字と背景の差を強くしました。", { contrast: "high" }, { contrast: "normal" }),
  },
  {
    id: "motion",
    words: ["動きを", "うごきを", "アニメ", "揺れ", "ゆれ", "動くのが", "目が疲れ", "酔う", "ちらつ"],
    reply: (context) =>
      context.settings.motion === "reduced"
        ? changed("動きを元に戻しました。", { motion: "system" }, { motion: "reduced" })
        : changed("画面の動きを減らしました。", { motion: "reduced" }, { motion: "system" }),
  },
  {
    id: "face",
    words: ["フォント", "書体", "ふぉんと", "読みやすい字", "ud", "字の形"],
    reply: (context) =>
      context.settings.face === "ud"
        ? changed("書体を元に戻しました。", { face: "default" }, { face: "ud" })
        : changed("読みやすさを重視した書体に変えました。", { face: "ud" }, { face: "default" }),
  },
  {
    id: "reset",
    words: ["元に戻", "もとに戻", "リセット", "初期", "既定", "戻して"],
    reply: () => ({
      say: "表示の設定をすべて最初の状態に戻しました。",
      expression: "bright",
      actions: [{ kind: "reset-display" }],
      offers: [{ label: "表示設定を開く", icon: "settings", action: { kind: "open-settings" } }],
    }),
  },
  {
    id: "settings",
    words: ["表示設定", "設定", "せってい"],
    reply: () => ({
      say: "表示設定を開きますね。",
      expression: "bright",
      actions: [{ kind: "open-settings" }],
      offers: [],
    }),
  },

  // ── 答えるだけ ─────────────────────────────────────────
  {
    id: "pilot",
    words: ["あと何日", "何日", "いつまで", "期間", "残り", "終わる", "試験導入", "パイロット", "お試し"],
    reply: (context) => {
      // カレンダーは生徒のホームにだけある。教員の画面では日数だけを答える。
      const educator = context.audience === "educator";
      const offers: AssistantOffer[] = educator
        ? []
        : [{ label: "カレンダーを見る", icon: "calendar_month", action: { kind: "show", heading: "試験導入期間", href: DESTINATIONS.home.href } }];
      if (!context.pilot) {
        return {
          say: educator
            ? "いまは日付を確かめられませんでした。少ししてから、もう一度聞いてください。"
            : "試験導入の残りは、ホームのカレンダーで確かめられます。",
          expression: "rest",
          actions: [],
          offers,
        };
      }
      const say =
        context.pilot.phase === "before"
          ? "試験導入はまだ始まっていません。"
          : context.pilot.phase === "after"
            ? "試験導入の期間は終わっています。"
            : `試験導入は、今日を入れてあと${context.pilot.remaining}日です。`;
      return { say, expression: "rest", actions: [], offers };
    },
  },
  {
    id: "help",
    words: ["使い方", "つかいかた", "何ができる", "なにができる", "ヘルプ", "できること", "help"],
    reply: (context) =>
      context.audience === "educator"
        ? educatorHelp(ROLE_ENTRY[roleOf(context)])
        : {
            say: "ページを開いたり、文字の大きさや色を変えたりできます。「日記」「文字を大きく」のほか、「気分の内訳って何？」のように、画面に出ている言葉の意味も聞けます。",
            expression: "listening",
            actions: [],
            offers: [
              { label: "日記", icon: DESTINATIONS.journal.icon, action: { kind: "navigate", href: DESTINATIONS.journal.href } },
              ABOUT_THIS_PAGE,
              { label: "文字を大きく", icon: "add", action: { kind: "display", patch: { text: "l" } } },
              { label: "表示設定を開く", icon: "settings", action: { kind: "open-settings" } },
            ],
          },
  },
  {
    id: "identity",
    words: ["だれ", "誰な", "誰で", "あなたは", "きみは", "君は", "名前", "何者", "ラスク", "らすく"],
    reply: (context) =>
      context.audience === "educator"
        ? {
            say: "blescの案内役、ラスクです。画面の移動と、見え方の調整、画面に出ている言葉の説明を手伝います。",
            expression: "listening",
            actions: [],
            offers: [],
          }
        : {
            say: "blescの案内役、ラスクです。ページの移動と、見え方の調整、画面に出ている言葉の説明を手伝います。気持ちの話は、相談のページでちゃんと聞きます。",
            expression: "listening",
            actions: [],
            offers: [{ label: "相談へ", icon: DESTINATIONS.chat.icon, action: { kind: "navigate", href: DESTINATIONS.chat.href } }],
          },
  },

  // ── 雑談 ─────────────────────────────────────────────
  // 気分が沈んだ言葉を先に置く。「すごい疲れた」のように同じ強さで並んだとき、
  // 明るい返事のほうを選ばないように。
  {
    id: "low",
    chat: true,
    words: ["つらい", "辛い", "しんどい", "疲れた", "つかれた", "元気がない", "元気ない", "落ち込", "だるい", "さみしい", "寂しい", "不安"],
    reply: (context, said) =>
      context.audience === "educator"
        ? {
            // 教員には生徒向けの相談ページを勧めない。受け止めるだけにする。
            say: "お疲れさまです。" + pick(["無理のない範囲で。", "少し休めるときに、休んでください。"], context.turn),
            expression: "steady",
            calm: true,
            actions: [],
            offers: [],
          }
        : {
            say: pick(["話してくれてありがとうございます。", "そういう日もありますよね。"], context.turn)
              + "相談のページでは、ゆっくり話を聞けます。",
            expression: "steady",
            calm: true,
            actions: [],
            offers: [
              { label: "相談のページで話す", icon: DESTINATIONS.chat.icon, action: { kind: "handoff", text: said.raw } },
              { label: "日記に書く", icon: DESTINATIONS.journal.icon, action: { kind: "navigate", href: DESTINATIONS.journal.href } },
            ],
          },
  },
  {
    id: "greeting",
    chat: true,
    words: ["こんにちは", "こんにちわ", "こんばんは", "こんばんわ", "おはよう", "はじめまして", "やあ", "hello", "よろしく"],
    reply: (context, said) => {
      const educator = context.audience === "educator";
      const next = educator
        ? { destination: ROLE_ENTRY[roleOf(context)].first, label: ROLE_ENTRY[roleOf(context)].greet }
        : { destination: DESTINATIONS.journal, label: "日記を書く" };
      return {
        say: said.text.includes("はじめまして")
          ? "はじめまして。ラスクといいます。ページの移動と、見え方の調整、画面の見方の説明を手伝います。"
          : greetingFor(said.text)
            + pick(
                educator
                  ? ["今日はどうしますか。", "開きたい画面や、画面に出ている言葉の意味があれば聞いてください。"]
                  : ["今日はどうしますか。", "行きたいページや、見えにくいところがあれば言ってください。"],
                context.turn,
              ),
        expression: "bright",
        actions: [],
        offers: [
          ...(context.pathname === next.destination.href
            ? []
            : [{ label: next.label, icon: next.destination.icon, action: { kind: "navigate", href: next.destination.href } } as const]),
          { label: "できることを見る", icon: "lightbulb", action: { kind: "help" } },
        ],
      };
    },
  },
  {
    id: "how-are-you",
    chat: true,
    words: ["元気", "げんき", "調子どう", "調子は", "最近どう", "how are you"],
    reply: (context, said) => ({
      say: /元気(だ|です|よ)/.test(said.text)
        ? "よかったです。"
        : pick(["小石なので、だいたいいつも元気です。", "元気です。今日も画面の隅にいます。"], context.turn),
      expression: "bright",
      actions: [],
      offers: [],
    }),
  },
  {
    id: "bye",
    chat: true,
    words: ["またね", "さようなら", "さよなら", "バイバイ", "おやすみ", "じゃあね", "また明日", "bye"],
    reply: (context, said) => ({
      say: said.text.includes("おやすみ") ? "おやすみなさい。" : pick(["またね。", "またいつでもどうぞ。"], context.turn),
      expression: "bright",
      actions: [],
      offers: [],
    }),
  },
  {
    id: "sorry",
    chat: true,
    words: ["ごめん", "すみません", "すいません"],
    reply: () => ({ say: "気にしないでください。", expression: "bright", actions: [], offers: [] }),
  },
  {
    id: "praise",
    chat: true,
    words: ["かわいい", "可愛い", "すごい", "いいね", "えらい"],
    reply: (context) => ({
      say: pick(["ありがとうございます。うれしいです。", "そう言ってもらえると、うれしいです。"], context.turn),
      expression: "bright",
      actions: [],
      offers: [],
    }),
  },
  {
    id: "filler",
    chat: true,
    words: [],
    exact: ["はい", "うん", "ok", "おk", "おけ", "了解", "りょうかい", "わかった", "なるほど", "そっか", "へー", "ふーん"],
    reply: (context) => ({
      say: pick(["はい。ほかにも何かあれば言ってください。", "わかりました。"], context.turn),
      expression: "rest",
      actions: [],
      offers: [],
    }),
  },
  {
    id: "thanks",
    chat: true,
    words: ["ありがとう", "ありがと", "thanks", "助かった"],
    reply: () => ({ say: "どういたしまして。", expression: "bright", actions: [], offers: [] }),
  },
];

/* ════════════════════════════════════════════════════════════
   画面に出ている言葉の説明
   say はどれも、その画面にすでに書いてある文言か、データの定義から
   起こしてある。書き足すときも、画面とずれた説明にしないこと。
   ════════════════════════════════════════════════════════════ */

export type GlossaryEntry = {
  id: string;
  audience: Audience;
  /** 画面に書いてある見出し。「画面で見る」ではこの文字を探す。 */
  heading: string;
  /** 聞かれ方。見出しそのものも含める。 */
  words: readonly string[];
  /**
   * その見出しがあるページ。教員の画面で立場によって違うときは、立場ごとに
   * 書く（開けない立場の分は書かない）。ひとりずつの画面のように、決まった
   * URL が無いものは null。
   */
  href: string | null | Partial<Record<TeacherRole, string>>;
  /** href のほかにも見出しがあるページ（または href で表せないページ）に、いまいるか。 */
  where?: (pathname: string) => boolean;
  /** ひとりずつの画面にある項目。いまその画面にいないとき、その人を選ぶ一覧。 */
  pick?: Partial<Record<TeacherRole, string>>;
  say: string;
};

/** 生徒の一覧・先生の一覧のどちらにもある項目。 */
const LIST: Partial<Record<TeacherRole, string>> = { homeroom: "/educator/class", manager: "/educator/staff" };
/** 先生自身の記録の画面（学校管理者は記録しない）。 */
const OWN = (href: string): Partial<Record<TeacherRole, string>> => ({ homeroom: href, manager: href });

export const GLOSSARY: readonly GlossaryEntry[] = [
  // ── 生徒 ───────────────────────────────────────────────
  {
    id: "mood-bloom",
    audience: "student",
    heading: "気分の内訳",
    words: ["気分の内訳", "気分の花", "花びら"],
    href: "/reflect",
    say: "これまでに記録した日の気分を、5枚の花びらで表しています。花びらは「とても良い」「良い」「ふつう」「少しつらい」「つらい」にひとつずつ対応していて、その気分の日が多いほど大きくなります。まだ記録のない気分は、薄く小さい花びらのまま残ります。花には上下がないので、良い・悪いの順位はつけていません。気分ごとの日数は、花の下の一覧で確かめられます。",
  },
  {
    id: "mood-trend",
    audience: "student",
    heading: "気分の移り変わり",
    words: ["気分の移り変わり", "移り変わり", "気分のグラフ"],
    href: "/reflect",
    say: "記録した日ごとの気分を、日付の順に線でつないだグラフです。上が「とても良い」、下が「つらい」です。",
  },
  {
    id: "categories",
    audience: "student",
    heading: "よく書いている出来事",
    words: ["よく書いている出来事", "よく書いている"],
    href: "/reflect",
    say: "日記で選んだ出来事（授業・勉強、友人関係、部活動、家庭、進路、健康・睡眠、その他）を、選んだ回数が多い順に並べています。",
  },
  {
    id: "continuity",
    audience: "student",
    heading: "記録のつづき",
    words: ["記録のつづき"],
    href: "/",
    say: "日記を提出してきた記録です。連続提出日数・今週の提出・今月の提出率と、直近7日間の提出状況（右端が今日）が並んでいます。",
  },
  {
    id: "streak",
    audience: "student",
    heading: "連続提出日数",
    words: ["連続提出日数", "連続提出"],
    href: "/",
    say: "日記を毎日続けて提出している日数です。",
  },
  {
    id: "week-count",
    audience: "student",
    heading: "今週の提出",
    words: ["今週の提出"],
    href: "/",
    say: "今週、日記を提出した回数です。",
  },
  {
    id: "month-rate",
    audience: "student",
    heading: "今月の提出率",
    words: ["今月の提出率", "提出率"],
    href: "/",
    say: "今月、日記を提出できた日の割合です。",
  },
  {
    id: "student-pilot",
    audience: "student",
    heading: "試験導入期間",
    words: ["試験導入期間", "試験導入"],
    href: "/",
    say: "blescを試しに使っている期間です。カレンダーで、始まりから終わりまでの日と今日の位置、残りの日数を確かめられます。",
  },
  {
    id: "recent",
    audience: "student",
    heading: "最近の日記",
    words: ["最近の日記"],
    href: "/",
    say: "最近提出した日記を、新しい順に3日分まで表示しています。",
  },
  {
    id: "shared-summary",
    audience: "student",
    heading: "共有されるのは、状態のまとめだけです",
    words: ["状態のまとめ", "何が共有", "なにが共有", "共有されるもの", "共有されるの"],
    href: "/sharing",
    say: "学校や団体に共有されるのは、状態のまとめ（状態の区分・傾向・安全に関する記録）だけで、日記の本文は含まれません。あなたが「はい」と言うまで何も共有されず、共有はいつでも止められます。",
  },
  {
    id: "who-viewed",
    audience: "student",
    heading: "だれが見たか",
    words: ["だれが見たか", "誰が見たか", "閲覧の記録"],
    href: "/sharing",
    say: "共有した情報を、いつ、どこが見たかの記録です。閲覧はすべて記録されます。",
  },
  {
    id: "anomaly-timeline",
    audience: "student",
    heading: "変化のタイムライン",
    words: ["変化のタイムライン", "日ごとの変化"],
    href: "/timeline",
    say: "その人自身のふだんの状態と比べて、どれくらい変化があったかを日ごとに表したグラフです。",
  },
  {
    id: "insights",
    audience: "student",
    heading: "変化の内訳",
    words: ["変化の内訳", "変化の大きさ"],
    href: "/insights",
    say: "タイムラインの値が、どんな要素から出てきたのかを分解したものです。ルールの反応、ふだんとの差、日ごとの移り変わりをまとめた値で、診断ではありません。",
  },
  {
    id: "audit",
    audience: "student",
    heading: "AI処理の記録",
    words: ["ai処理の記録", "処理履歴"],
    href: "/audit",
    say: "AIがどう応答を作ったかを、あとから確認できる記録です。感情の抽出、安全性の判定、根拠の参照、使用したモデルの情報が見られます。表示されるのはハッシュと構造化された情報だけで、日記の本文は含まれません。",
  },
  {
    id: "support-summary",
    audience: "student",
    heading: "支援サマリー",
    words: ["支援サマリー"],
    href: "/support-summary",
    say: "最近の日記の構造化された項目から作る、相談のときに使える短いまとめです。日記の本文は含まれず、作っただけでは誰にも共有されません。",
  },

  // ── 教員 ───────────────────────────────────────────────
  // Blesc for Teachers の画面の言葉。どれも本人が書いた・選んだ記録を
  // 数えて並べたもので、判定や段階を表す言葉は画面にも表にも置かない。
  {
    id: "readers",
    audience: "educator",
    heading: "記録を読める人",
    words: ["記録を読める人", "読める人", "だれが読める", "誰が読める", "閲覧者"],
    href: { homeroom: "/educator", manager: "/educator", admin: "/educator/settings" },
    where: (pathname) =>
      ["/educator", "/educator/my-records", "/educator/class", "/educator/settings"].includes(pathname) || onStudentDetail(pathname),
    say: "その記録を読める人の表示です。記録する本人の画面には、いつも出しています。読める人は学校の設定で決まり、設定が変わるとこの表示もすぐに変わります。だれも読まない設定のときは「あなただけ」と出ます。",
  },
  {
    id: "today-mood",
    audience: "educator",
    heading: "今日の気分",
    words: ["今日の気分", "気分の段階", "5段階"],
    href: OWN("/educator"),
    say: "その日の気分を、とても良い・良い・ふつう・少しつらい・つらいの5段階から選びます。記録に必要なのはこれだけで、気分を選ぶだけでも保存できます。",
  },
  {
    id: "today-text",
    audience: "educator",
    heading: "今日のこと",
    words: ["今日のこと", "別の質問", "質問"],
    href: OWN("/educator"),
    say: "その日のことを書く欄です。書かなくても保存でき、書くときは1,000字までです。何を書くか思いつかないときのために質問を1つ出していて、「別の質問にする」で替えられます。質問に答えて書いた記録は、その質問への回答として残ります。",
  },
  {
    id: "work-tags",
    audience: "educator",
    heading: "今日の業務",
    words: ["今日の業務", "業務を選", "業務"],
    href: OWN("/educator"),
    say: "その日に関わった業務を、授業・校務・生徒対応・部活動・保護者対応・その他から選びます。いくつ選んでも、選ばなくても構いません。選んだ業務は、管理職が業務の偏りを本人の申告どおりに見るためだけに使い、自動で分類はしません。",
  },
  {
    id: "reminder",
    audience: "educator",
    heading: "お知らせ",
    words: ["お知らせ", "リマインド", "通知", "帰りのHR"],
    href: OWN("/educator"),
    say: "帰りのHRの時間に、1日1回だけ記録のお知らせを出します。時刻と、お知らせを出すかどうかは学校の設定で決まります。記録しない日が続いても、管理職に知らせることはありません。",
  },
  {
    id: "history",
    audience: "educator",
    heading: "記録",
    words: ["書き直し", "書き直せ", "編集履歴", "履歴"],
    href: OWN("/educator/my-records"),
    say: "記録は、その日のうちなら書き直せます。翌日からは読むだけになり、書き直した記録には、保存した時刻と書き直した時刻が残ります。",
  },
  {
    id: "change",
    audience: "educator",
    heading: "変化",
    words: ["変化あり", "変化の札", "変化"],
    href: LIST,
    say: "直近4週とその前の4週の記録を比べて、決めてある数値を超える動きがあったときに付く札です。比べるのは本人が書いた・選んだものだけで、気分の平均、記録した日数、1件あたりの文字数、よく選ぶタグの4つです。上がる向きの変化にも同じ札が付き、重さの段階や順位はありません。決め方の数値は、一覧の上に書いてあります。",
  },
  {
    id: "insufficient",
    audience: "educator",
    heading: "変化",
    words: ["判定なし", "判定しない", "判定されない"],
    href: LIST,
    say: "前の4週の記録が4件未満で、比べる元が足りないときの表示です。この場合は、変化を判定しません。",
  },
  {
    id: "change-detail",
    audience: "educator",
    heading: "直近4週の変化",
    words: ["直近4週の変化", "4週の変化", "前の4週"],
    href: null,
    where: onPersonDetail,
    pick: LIST,
    say: "「変化あり」が付いた理由を、数字のまま並べたものです。前の4週と直近4週で、気分の平均・記録した日数・1件あたりの文字数・よく選ぶタグのうち、どれがどう動いたかを表示します。良し悪しや重さは判定していません。札が付いていないときは、その理由を表示します。",
  },
  {
    id: "sparkline",
    audience: "educator",
    heading: "気分（8週）",
    words: ["気分（8週）", "8週", "小さいグラフ"],
    href: LIST,
    say: "直近8週の気分を、週ごとの平均で線にしたものです。上が「とても良い」、下が「つらい」です。記録の無い週は飛ばして、前後の週をつないでいます。",
  },
  {
    id: "mood-trend",
    audience: "educator",
    heading: "気分の推移",
    words: ["気分の推移", "気分のグラフ"],
    href: OWN("/educator/my-records"),
    where: (pathname) => pathname === "/educator/my-records" || onPersonDetail(pathname),
    say: "記録した日ごとの気分を、日付の順に線でつないだグラフです。上が「とても良い」、下が「つらい」です。",
  },
  {
    id: "last-record",
    audience: "educator",
    heading: "直近の記録",
    words: ["直近の記録", "最後の記録", "記録なし"],
    href: LIST,
    say: "最後に記録した日と、今日から何日前かです。まだ記録が無い人には「記録なし」と出ます。",
  },
  {
    id: "sort",
    audience: "educator",
    heading: "並び",
    words: ["出席番号順", "五十音順", "並び順", "並べ替え", "並び", "危険度", "リスク"],
    href: LIST,
    say: "一覧は、生徒は出席番号順、先生は五十音順に並べています。ほかに選べるのは「直近の記録日が新しい順」だけで、気分や「変化あり」の順には並べ替えられません。順位を付けないためです。",
  },
  {
    id: "search",
    audience: "educator",
    heading: "記録を探す",
    words: ["記録を探す", "検索", "絞り込み", "絞りこみ", "探したい"],
    href: { homeroom: "/educator/class" },
    say: "担当クラスの記録を、期間・気分・話題・本文に含む言葉で絞りこめます。探せるのは、担当しているクラスの記録だけです。",
  },
  {
    id: "topic-trend",
    audience: "educator",
    heading: "話題の推移",
    words: ["話題の推移", "話題のタグ", "話題"],
    href: null,
    where: onStudentDetail,
    pick: { homeroom: "/educator/class" },
    say: "生徒が記録のときに選んだ話題のタグを、週ごとに数えたものです（直近8週）。色が濃いほど、その週に選んだ回数が多いことを表します。本人が選んだタグを数えただけで、内容から自動で分類したものではありません。",
  },
  {
    id: "work-ratio",
    audience: "educator",
    heading: "業務タグ（本人の申告）",
    words: ["業務タグ", "業務の割合", "業務の比率", "業務の偏り"],
    href: { manager: "/educator/staff" },
    say: "先生が記録のときに選んだ業務タグを数えて、割合で並べたものです。本人の申告をそのまま数えただけで、自動で分類はしていません。色は業務の種類を見分けるためだけのもので、多い・少ないの良し悪しは表していません。",
  },
  {
    id: "work-trend",
    audience: "educator",
    heading: "業務タグの推移",
    words: ["業務タグの推移"],
    href: null,
    where: onStaffDetail,
    pick: { manager: "/educator/staff" },
    say: "先生が記録のときに選んだ業務タグを、週ごとに数えたものです（直近8週）。色が濃いほど、その週に選んだ回数が多いことを表します。",
  },
  {
    id: "summary",
    audience: "educator",
    heading: "面談前サマリー",
    words: ["面談前サマリー", "サマリー"],
    href: null,
    where: onPersonDetail,
    pick: LIST,
    say: "選んだ期間（直近1か月・2か月）の記録から、よく出てくる話題・気分の推移・本人の記述の抜粋を並べたものです。ここまでは記録を数えて並べただけで、解釈は入っていません。",
  },
  {
    id: "ai-summary",
    audience: "educator",
    heading: "AIによる要約",
    words: ["AIによる要約", "AIの要約", "AI要約", "要約"],
    href: null,
    where: onPersonDetail,
    pick: LIST,
    say: "記録をもとにAIが書く短い要約です。診断・推測・評価の言い回しを使わず、本人の記述からの引用を必ず含めたものだけを表示し、条件に合わない要約は表示しません。判断の材料は、要約ではなく記録そのものです。このデモでは、AIの代わりに定型文を表示しています。",
  },
  {
    id: "excerpts",
    audience: "educator",
    heading: "本人の記述の抜粋",
    words: ["本人の記述の抜粋", "抜粋", "引用"],
    href: null,
    where: onPersonDetail,
    pick: LIST,
    say: "期間内の、本文のある記録から新しい順に4件までを、本人が書いたとおりに載せています。長い記述は途中で切っています。",
  },
  {
    id: "frequent-topics",
    audience: "educator",
    heading: "よく出てくる話題",
    words: ["よく出てくる話題"],
    href: null,
    where: onPersonDetail,
    pick: LIST,
    say: "期間内の記録で、本人が選んだタグを回数の多い順に並べたものです。",
  },
  {
    id: "memo",
    audience: "educator",
    heading: "面談メモ",
    words: ["面談メモ", "メモ"],
    href: OWN("/educator/meetings"),
    where: (pathname) => pathname === "/educator/meetings" || onPersonDetail(pathname),
    say: "面談の日付・内容・次回確かめたいことを残すメモです。読めるのは書いた人だけで、生徒（先生）本人には表示されません。担任が替わるときや先生が異動するときに引き継ぐかどうかは、学校の設定で決まります。",
  },
  {
    id: "next-check",
    audience: "educator",
    heading: "面談メモ",
    words: ["次回確かめたいこと", "次回確かめたい", "次回"],
    href: OWN("/educator/meetings"),
    where: (pathname) => pathname === "/educator/meetings" || onPersonDetail(pathname),
    say: "次の面談で確かめたいことを、メモと一緒に残しておく欄です。面談メモの一覧にも並ぶので、次に話すときの手がかりになります。",
  },
  {
    id: "handover",
    audience: "educator",
    heading: "面談メモの引き継ぎ",
    words: ["面談メモの引き継ぎ", "引き継ぎ", "引継ぎ", "引き継ぐ", "異動"],
    href: { admin: "/educator/settings" },
    say: "担任が替わるときに生徒の面談メモを後任の担任へ、先生が異動するときに管理職の面談メモを異動先へ、引き継ぐかどうかの設定です。学校管理者が決めます。先生についてのメモは、原則として引き継ぎません。",
  },
  {
    id: "no-export",
    audience: "educator",
    heading: "印刷・書き出し",
    words: ["印刷", "CSV", "ダウンロード", "書き出し", "エクスポート", "出力"],
    href: { manager: "/educator/staff" },
    where: (pathname) => pathname === "/educator/staff" || onStaffDetail(pathname),
    say: "先生の記録・サマリー・面談メモは、印刷・CSV出力・一括ダウンロードができません。人事評価に使われないための決まりで、学校の設定でも変えられません。",
  },
  {
    id: "readers-setting",
    audience: "educator",
    heading: "だれが記録を読めるか",
    words: ["だれが記録を読めるか", "閲覧の権限", "閲覧権限", "権限", "閲覧の設定"],
    href: { admin: "/educator/settings" },
    say: "生徒の記録と先生の記録を、それぞれだれが読めるかを決める設定です。担任は、自分のクラスの生徒の記録をいつも読めます。変更は、記録する本人の画面の「この記録を読める人」にすぐ反映されます。",
  },
  {
    id: "roster-import",
    audience: "educator",
    heading: "名簿の取り込み",
    words: ["名簿の取り込み", "名簿", "CSVの取り込み", "取り込み"],
    href: { admin: "/educator/settings" },
    say: "生徒名簿（学年・組・出席番号・氏名）と教職員名簿（氏名・よみ・担当）を、CSVで取り込みます。クラス替え・転出入・異動・退職に伴う更新は、Blescの運用担当が代わりに行うこともできます。",
  },
  {
    id: "reminder-setting",
    audience: "educator",
    heading: "記録の時間とお知らせ",
    words: ["記録の時間とお知らせ", "記録の時間", "お知らせの時刻"],
    href: { admin: "/educator/settings" },
    say: "帰りのHRの時刻と、その時刻に1日1回お知らせを出すかどうかの設定です。記録しない日が続いても、管理職へのお知らせは送りません。これは設定では変えられません。",
  },
  {
    id: "retention",
    audience: "educator",
    heading: "データの保持と削除",
    words: ["データの保持と削除", "保持", "保存期間", "削除"],
    href: { admin: "/educator/settings" },
    say: "卒業・転出・異動・退職のあと、記録を3か月・6か月・1年・3年のどれだけ残してから削除するかを決める設定です。契約が終わるときは、その学校のデータをすべて完全に削除します。",
  },
  {
    id: "record-rate",
    audience: "educator",
    heading: "記録率",
    words: ["記録率"],
    href: { admin: "/educator/usage" },
    say: "記録できた日のうち、記録があった日の割合です。学期ごとに、クラスごとの記録率と、先生全体の記録率だけを出します。個人別の記録率は出さず、クラスの順位も付けません。",
  },
];

export type PageGuide = {
  audience: Audience;
  /** そのページを指す呼び名。「クラスの見方」のように、ページの名前で聞かれたとき。 */
  names: readonly string[];
  matches: (pathname: string) => boolean;
  say: string;
  /** 続けて聞ける言葉。どれも GLOSSARY で説明できるもの。 */
  terms: readonly string[];
};

export const PAGE_GUIDES: readonly PageGuide[] = [
  {
    audience: "student",
    names: ["今日", "ホーム", "トップ"],
    matches: (pathname) => pathname === "/",
    say: "今日の日記の状態、記録のつづき（連続提出日数・今週の提出・今月の提出率と直近7日）、試験導入期間のカレンダー、最近の日記が並んでいます。",
    terms: ["記録のつづき", "今月の提出率", "試験導入期間"],
  },
  {
    audience: "student",
    names: ["振り返り", "ふりかえり"],
    matches: (pathname) => pathname === "/reflect",
    say: "これまでに記録した日の、気分の移り変わり・気分の内訳・よく書いている出来事と、過去の日記が見られます。",
    terms: ["気分の移り変わり", "気分の内訳", "よく書いている出来事"],
  },
  {
    audience: "student",
    names: ["日記"],
    matches: (pathname) => pathname === "/journal",
    say: "今日の気分、出来事、自由記述の3つを順に書きます。書きたくないことは、書かなくて大丈夫です。書いたあとにblescから質問が届くことがありますが、答えたくない質問は飛ばせます。",
    terms: [],
  },
  {
    audience: "student",
    names: ["共有の設定", "共有"],
    matches: (pathname) => pathname === "/sharing",
    say: "学校や団体からの共有の申請と、だれが見たかを確認できます。決めるのはあなたで、「はい」と言うまで何も共有されません。",
    terms: ["状態のまとめ", "だれが見たか"],
  },
  {
    audience: "student",
    names: ["タイムライン"],
    matches: (pathname) => pathname === "/timeline",
    say: "その人自身のふだんの状態と比べて、どれくらい変化があったかを日ごとに表しています。",
    terms: ["変化の内訳"],
  },
  {
    audience: "educator",
    names: ["今日の記録"],
    matches: (pathname) => pathname === "/educator",
    say: "先生自身の、今日の記録の画面です。必須は今日の気分だけで、今日のこと（1,000字まで）と今日の業務は、書いても書かなくても構いません。1日1件で、今日のうちは書き直せます。いちばん上に、この記録を読める人を表示しています。",
    terms: ["今日の気分", "今日の業務", "記録を読める人"],
  },
  {
    audience: "educator",
    names: ["振り返り", "ふりかえり"],
    matches: (pathname) => pathname === "/educator/my-records",
    say: "これまでの自分の記録を、カレンダーと一覧で見られます。気分の推移のグラフもあります。過去の記録は読むだけで、書き直した日はその履歴も表示します。",
    terms: ["気分の推移", "書き直し"],
  },
  {
    audience: "educator",
    names: ["クラス", "クラスの一覧"],
    matches: (pathname) => pathname === "/educator/class",
    say: "担当クラスの生徒を出席番号順に並べ、直近の記録日、直近8週の気分、「変化あり」の札を表示しています。札は本人が書いた・選んだものの推移だけから決まり、重さの段階はありません。「記録を探す」では、クラスの記録を絞りこめます。",
    terms: ["変化あり", "判定なし", "記録を探す"],
  },
  {
    audience: "educator",
    names: ["生徒の画面", "生徒の詳細"],
    matches: onStudentDetail,
    say: "生徒ひとりの記録をまとめた画面です。直近4週の変化、気分の推移、話題の推移と、すべての記録を新しい順に並べています。面談前サマリーと面談メモも、ここから開けます。",
    terms: ["直近4週の変化", "話題の推移", "面談前サマリー"],
  },
  {
    audience: "educator",
    names: ["面談メモの一覧", "面談"],
    matches: (pathname) => pathname === "/educator/meetings",
    say: "自分が書いた面談メモが、新しい順に並んでいます。担任は生徒との面談、管理職は先生との面談のメモです。メモは本人には表示されません。新しいメモは、ひとりずつの画面から書きます。",
    terms: ["面談メモ", "次回確かめたいこと"],
  },
  {
    audience: "educator",
    names: ["教職員", "教職員の一覧", "担当教職員"],
    matches: (pathname) => pathname === "/educator/staff",
    say: "読める立場にある先生の記録を、五十音順に並べています。直近の記録日、直近8週の気分、本人が選んだ業務タグの割合、「変化あり」の札を表示します。印刷・CSV出力・一括ダウンロードはできません。",
    terms: ["変化あり", "業務タグ", "印刷"],
  },
  {
    audience: "educator",
    names: ["先生の画面", "先生の詳細"],
    matches: onStaffDetail,
    say: "先生ひとりの記録をまとめた画面です。直近4週の変化、気分の推移、業務タグの推移と、すべての記録を新しい順に並べています。面談前サマリーと面談メモも、ここから開けます。印刷・書き出しはできません。",
    terms: ["直近4週の変化", "業務タグの推移", "面談前サマリー"],
  },
  {
    audience: "educator",
    names: ["学校の設定"],
    matches: (pathname) => pathname === "/educator/settings",
    say: "学校管理者が、だれが記録を読めるか、面談メモの引き継ぎ、名簿の取り込み、記録の時間とお知らせ、データの保持と削除を決める画面です。先生の記録の印刷・書き出しを許す設定はありません。",
    terms: ["だれが記録を読めるか", "名簿の取り込み", "データの保持と削除"],
  },
  {
    audience: "educator",
    names: ["利用状況"],
    matches: (pathname) => pathname === "/educator/usage",
    say: "学期ごとの、クラスごとの記録率と、先生全体の記録率です。個人別の記録率は出さず、クラスの順位も付けません。",
    terms: ["記録率"],
  },
];

/** 意味を聞いている言い方。表でならした形で持つ。 */
const MEANING_CUES = [
  "って何", "ってなに", "ってどういう", "とは", "意味", "見方", "どう見る", "どう読む",
  "何を表", "なにを表", "何を示", "について", "教えて", "説明", "何ですか", "なんですか",
].map(normalize);

/** いま見ている画面そのものを指す言葉。 */
const PAGE_WORDS = ["この画面", "このページ", "ここ", "これ", "この表示", "画面", "ページ"].map(normalize);

/** それだけで「この画面に何が出ているか」を聞いている言い方。 */
const PAGE_CUES = ["何が表示", "なにが表示", "何が書いて", "何が見られ", "どういう画面", "どういうページ"].map(normalize);

function asksMeaning(text: string): boolean {
  return MEANING_CUES.some((cue) => text.includes(cue)) || text.endsWith("何") || text.endsWith("なに");
}

/** 2 文字は「日記」「設定」のような最短の語。1 文字では拾わない。 */
const MATCH_FLOOR = 2;

/** 一致の強さ。いちばん長く一致した言葉の文字数で測る。 */
function score(text: string, words: readonly string[]): number {
  let best = 0;
  for (const word of words) {
    if (word.length > best && text.includes(word)) best = word.length;
  }
  return best;
}

/**
 * 表の言葉も同じ関数でならしておく。
 *
 * 入力だけをならして表を生のままにすると、カタカナで書いた見出し語が
 * どうやっても一致しなくなる（入力の「グラフ」は「ぐらふ」になるのに、
 * 表の「グラフ」はカタカナのまま）。気付きにくく、黙って死ぬ種類の穴なので、
 * 突き合わせる直前ではなく読み込み時に一度だけ揃える。
 */
const MATCHERS = INTENTS.map((intent) => ({
  intent,
  words: intent.words.map(normalize),
  exact: (intent.exact ?? []).map(normalize),
}));

const ENTRY_MATCHERS = GLOSSARY.map((entry) => ({ entry, words: entry.words.map(normalize) }));
const GUIDE_MATCHERS = PAGE_GUIDES.map((guide) => ({ guide, names: guide.names.map(normalize) }));

/** 表に載っている言葉すべて。どれも実際に反応するかを試験で確かめている。 */
export const INTENT_WORDS: ReadonlyArray<{ word: string; audience: Audience | null }> = INTENTS.flatMap((intent) =>
  [...intent.words, ...(intent.exact ?? [])].map((word) => ({ word, audience: intent.audience ?? null })),
);

const reaches = (audience: Audience | undefined, context: Audience) => !audience || audience === context;

/** 操作（chat = false）か雑談（chat = true）のうち、いちばん強く一致したもの。 */
function strongest(text: string, chat: boolean, audience: Audience): Intent | null {
  let matched: Intent | null = null;
  let top = 0;
  for (const matcher of MATCHERS) {
    if (Boolean(matcher.intent.chat) !== chat || !reaches(matcher.intent.audience, audience)) continue;
    const value = matcher.exact.includes(text) ? Number.POSITIVE_INFINITY : score(text, matcher.words);
    if (value > top) {
      top = value;
      matched = matcher.intent;
    }
  }
  return top >= MATCH_FLOOR ? matched : null;
}

function strongestEntry(text: string, audience: Audience): { entry: GlossaryEntry; strength: number } | null {
  let found: GlossaryEntry | null = null;
  let top = 0;
  for (const matcher of ENTRY_MATCHERS) {
    if (matcher.entry.audience !== audience) continue;
    const value = score(text, matcher.words);
    if (value > top) {
      top = value;
      found = matcher.entry;
    }
  }
  return found && top >= MATCH_FLOOR ? { entry: found, strength: top } : null;
}

function guideByName(text: string, audience: Audience): { guide: PageGuide; strength: number } | null {
  let found: PageGuide | null = null;
  let top = 0;
  for (const matcher of GUIDE_MATCHERS) {
    if (matcher.guide.audience !== audience) continue;
    const value = score(text, matcher.names);
    if (value > top) {
      top = value;
      found = matcher.guide;
    }
  }
  return found && top >= MATCH_FLOOR ? { guide: found, strength: top } : null;
}

/**
 * 言葉の説明。いまその画面にいれば「画面で見る」、いなければ開いてから示す。
 * いまの立場では開けない画面にしか無い言葉は、説明だけをする。
 */
function explain(entry: GlossaryEntry, context: AssistantContext): AssistantReply {
  const role = roleOf(context);
  const href = entry.href === null || typeof entry.href === "string" ? entry.href : (entry.href[role] ?? null);
  const here = entry.where ? entry.where(context.pathname) : context.pathname === href;
  const list = entry.pick?.[role];
  let offer: AssistantOffer | null = null;
  if (here) {
    offer = { label: "画面で見る", icon: "visibility", action: { kind: "show", heading: entry.heading, href: null } };
  } else if (href) {
    offer = {
      label: `${PAGE_LABELS[href] ?? "そのページ"}で見る`,
      icon: "visibility",
      action: { kind: "show", heading: entry.heading, href },
    };
  } else if (list) {
    // ひとりずつの画面にある項目。だれの画面かはこちらでは決められない。
    offer = { label: `${PAGE_LABELS[list] ?? "一覧"}から選ぶ`, icon: "groups", action: { kind: "navigate", href: list } };
  }
  return { say: entry.say, expression: "listening", actions: [], offers: offer ? [offer] : [] };
}

/** 画面の説明。続けて聞ける言葉をボタンにして添える。 */
function describePage(guide: PageGuide | null): AssistantReply {
  if (!guide) {
    return {
      say: "この画面の説明はまだ用意していません。画面に出ている言葉を打つと、意味を説明できるものもあります。",
      expression: "oops",
      actions: [],
      offers: [{ label: "できることを見る", icon: "lightbulb", action: { kind: "help" } }],
    };
  }
  return {
    say: guide.say,
    expression: "listening",
    actions: [],
    offers: guide.terms.map((term) => ({ label: `${term}とは`, icon: "info", action: { kind: "ask", text: `${term}って何？` } })),
  };
}

/** 生徒の画面。監査済みの文をそのまま出し、相談ページへ言葉ごと渡す道を出す。 */
function studentCrisis(context: AssistantContext, raw: string): AssistantReply {
  return {
    // 文言は監査済みのものをそのまま出す。ここで言い換えない。
    say: context.safety.safe_response,
    expression: "steady",
    calm: true,
    actions: [],
    offers: [{ label: "相談のページで話す", icon: DESTINATIONS.chat.icon, action: { kind: "handoff", text: raw } }],
  };
}

/**
 * 教員の画面。生徒向けの監査済みの文（「信頼できる大人に」）は、教員に
 * 向けると噛み合わない。多くは生徒についての話なので、ひとりで抱えず、
 * 学校の定める緊急対応フローに沿って確かめるよう伝える。Blesc for Teachers
 * は自動の判定や警告の画面を持たない（設計原則 1）ので、行き先は示さない。
 * 教員自身のことである可能性にも一言だけ触れる。言葉はどこにも渡さない。
 */
function educatorConcern(): AssistantReply {
  return {
    say: "深刻な内容が含まれているかもしれません。生徒についてのことなら、ひとりで抱えず、学校の定める緊急対応フローに沿って、管理職や養護教諭、スクールカウンセラーと確認してください。ご自身のことであれば、身近な人や専門の窓口に相談してください。",
    expression: "steady",
    calm: true,
    actions: [],
    offers: [],
  };
}

/**
 * 言葉を受け取り、返事と動作を決める。
 *
 * 順番に意味がある。
 *  1. つらさが混じっていないかを最初に見て、そこで拾ったら表は引かない。
 *     「死にたい、日記を開いて」を日記への移動として処理してしまうのが、
 *     この種の仕組みで一番やってはいけないこと。
 *  2. 意味を聞いていれば説明する。「クラス」は開くが、「クラスって何？」
 *     は開かずに説明する。
 *  3. 頼みごと、言葉の説明、雑談の順。
 */
export function routeIntent(raw: string, context: AssistantContext): AssistantReply {
  const text = normalize(raw);
  if (!text) {
    return { say: "どうしますか。", expression: "listening", actions: [], offers: [] };
  }

  if (context.safety.risk_level === "crisis" || context.safety.risk_level === "elevated") {
    return context.audience === "educator" ? educatorConcern() : studentCrisis(context, raw);
  }

  const said = { text, raw };
  const meaning = asksMeaning(text);
  const entry = strongestEntry(text, context.audience);
  const task = strongest(text, false, context.audience);
  const chat = strongest(text, true, context.audience);

  // 「こんにちは、日記を書きたい」には、あいさつを返してから動く。
  const greeted = (reply: AssistantReply): AssistantReply =>
    chat?.id === "greeting" ? { ...reply, say: greetingFor(text) + reply.say } : reply;

  if (meaning) {
    const named = guideByName(text, context.audience);
    // 長く一致したほうを取る。「面談メモの引き継ぎとは」は、ページ名の
    // 「面談」ではなく項目の「面談メモの引き継ぎ」の説明。
    if (entry && (!named || entry.strength >= named.strength)) return explain(entry.entry, context);
    if (named) return describePage(named.guide);
  }

  const aboutThisPage =
    PAGE_CUES.some((cue) => text.includes(cue)) || (meaning && PAGE_WORDS.some((word) => text.includes(word)));
  if (aboutThisPage) {
    const guide = PAGE_GUIDES.find((item) => item.audience === context.audience && item.matches(context.pathname)) ?? null;
    return describePage(guide);
  }

  if (task) return greeted(task.reply(context, said));
  // 見出しの言葉だけが来たとき（「判定なし」など）も説明する。
  if (entry) return greeted(explain(entry.entry, context));
  if (chat) return chat.reply(context, said);

  // 表で拾えなかったとき。作り話で埋めない。
  if (context.audience === "educator") {
    return {
      say: "うまく聞き取れませんでした。画面の移動と見え方の調整、画面に出ている言葉の説明ならできます。",
      expression: "oops",
      actions: [],
      offers: [ABOUT_THIS_PAGE, { label: "できることを見る", icon: "lightbulb", action: { kind: "help" } }],
    };
  }
  return {
    say: "うまく聞き取れませんでした。ページの移動と表示の調整ならできます。話を聞いてほしいときは、相談のページへ渡しますね。",
    expression: "oops",
    actions: [],
    offers: [
      { label: "相談のページで話す", icon: DESTINATIONS.chat.icon, action: { kind: "handoff", text: raw } },
      { label: "できることを見る", icon: "lightbulb", action: { kind: "help" } },
    ],
  };
}

/** パネルに出す言葉。画面の種類ごとに変える。 */
export const ASSISTANT_COPY: Record<
  Audience,
  { intro: string; placeholder: string; note: string; suggestions: ReadonlyArray<{ label: string; icon: IconName }> }
> = {
  student: {
    intro: "行きたいページや、読みにくいところ、画面の見方を聞いてください。",
    placeholder: "日記、気分の内訳って何？…",
    note: "ここでの言葉は端末の外に出ません。相談は「相談」のページで。",
    suggestions: [
      { label: "日記を書きたい", icon: "edit_note" },
      { label: "この画面は何？", icon: "info" },
      { label: "文字を大きく", icon: "add" },
      { label: "あと何日？", icon: "calendar_month" },
    ],
  },
  educator: {
    intro: "開きたい画面や、読みにくいところ、画面に出ている言葉の意味を聞いてください。",
    placeholder: "振り返り、変化ありって何？…",
    note: "ここでの言葉は端末の外に出ません。",
    suggestions: [
      { label: "この画面は何？", icon: "info" },
      { label: "だれが読める？", icon: "visibility" },
      { label: "変化ありって何？", icon: "info" },
      { label: "文字を大きく", icon: "add" },
    ],
  },
};
