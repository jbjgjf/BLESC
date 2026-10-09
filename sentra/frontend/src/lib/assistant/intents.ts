import type { A11ySettings, TextSize } from "@/lib/a11y";
import type { AppContext } from "@/lib/blesc/context";
import type { PilotProgress } from "@/lib/blesc/pilot";
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
 * 作文で埋めると、教員が「変化があった」の意味を取り違えることになる。
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
  /** 教員の画面で、そのページを開くのに要る権限。省くとだれでも開ける。 */
  needs?: Need;
};

/** 教員の権限（UI仕様書 1章）。役割は、この3つの組み合わせのプリセットにすぎない。 */
export type Need = "write" | "students" | "teachers";
export type EducatorAccess = { write: boolean; students: boolean; teachers: boolean; studentTab?: "クラス" | "生徒" };

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
 * 教員の行き先。タブ（components/teachers/TeacherShell.tsx）と同じで、
 * 権限の分だけ開ける。開けない画面を頼まれたら、動かずにそう伝える —
 * 開いても「このページは表示できません」が出るだけなので。
 */
export const EDUCATOR_DESTINATIONS = {
  today:    { href: "/educator",            label: "自分の記録", icon: "edit_note",      needs: "write" },
  records:  { href: "/educator/my-records", label: "これまで",   icon: "calendar_month", needs: "write" },
  class:    { href: "/educator/class",      label: "クラス",     icon: "groups",         needs: "students" },
  staff:    { href: "/educator/staff",      label: "先生",       icon: "group",          needs: "teachers" },
  settings: { href: "/educator/settings",   label: "設定",       icon: "settings" },
} as const satisfies Record<string, Destination>;

const NEED_TEXT: Record<Need, string> = {
  write: "自分の記録を書く権限",
  students: "生徒の記録を読む権限",
  teachers: "先生の記録を読む権限",
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
  "/educator": "自分の記録",
  "/educator/my-records": "これまで",
  "/educator/class": "クラス",
  "/educator/staff": "先生",
  "/educator/settings": "設定",
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
   * 教員の画面での権限。開ける画面が権限で違う。生徒の画面では使わない。
   * 省くと担任と同じ（書く・自分のクラスの生徒を読む）。
   */
  access?: EducatorAccess;
  /** 一人ぶんの画面（記録・推移・面談）を開いているか。 */
  detail?: boolean;
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

const ACCESS_DEFAULT: EducatorAccess = { write: true, students: true, teachers: false, studentTab: "クラス" };
const accessOf = (context: AssistantContext): EducatorAccess => context.access ?? ACCESS_DEFAULT;
const allows = (context: AssistantContext, need: Need | undefined) => !need || accessOf(context)[need];

/** 生徒・先生ひとりずつの画面。面談前の要約と面談メモは、ここの「面談」タブにある。 */
const onPeople = (pathname: string) => pathname === "/educator/class" || pathname === "/educator/staff";
const onDetail = (pathname: string, detail: boolean) => detail && onPeople(pathname);

/** 権限ごとの入口（2章）。書く人は「自分の記録」、読むだけの人は「先生」か「生徒」。 */
function firstOf(context: AssistantContext): Destination {
  const access = accessOf(context);
  if (access.write) return EDUCATOR_DESTINATIONS.today;
  if (access.teachers) return EDUCATOR_DESTINATIONS.staff;
  if (access.students) return studentsDestination(context);
  return EDUCATOR_DESTINATIONS.settings;
}

/** 生徒を読む画面。養護教諭やスクールカウンセラーには「生徒」というタブ名で出る。 */
const studentsDestination = (context: AssistantContext): Destination => ({
  ...EDUCATOR_DESTINATIONS.class,
  label: accessOf(context).studentTab ?? "クラス",
});

/** 一人ぶんの画面を選ぶ一覧。生徒を読める人は生徒、そうでなければ先生。 */
function listOf(context: AssistantContext): Destination | null {
  const access = accessOf(context);
  if (access.students) return studentsDestination(context);
  if (access.teachers) return EDUCATOR_DESTINATIONS.staff;
  return null;
}

/** 相手のあいさつに合わせて返す。 */
function greetingFor(text: string): string {
  if (text.includes("おはよう")) return "おはようございます。";
  if (text.includes("こんばんは") || text.includes("こんばんわ")) return "こんばんは。";
  if (text.includes("はじめまして")) return "はじめまして。";
  if (text.includes("よろしく")) return "よろしくお願いします。";
  return "こんにちは。";
}

const goTo = (destination: Destination, context: AssistantContext, say: string): AssistantReply => {
  if (context.audience === "educator" && !allows(context, destination.needs)) {
    return {
      say: `${destination.label}は、${NEED_TEXT[destination.needs as Need]}がある人の画面です。`,
      expression: "listening",
      actions: [],
      offers: [],
    };
  }
  if (context.pathname === destination.href && !context.detail) {
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

/** 教員の画面での「使い方」。例に出す画面と言葉は、その人が開けるものにする。 */
function educatorHelp(context: AssistantContext): AssistantReply {
  const access = accessOf(context);
  const featured = listOf(context) ?? firstOf(context);
  const term = access.students ? "変化があった生徒" : access.teachers ? "変化があった先生" : "この記録を読めるのは";
  return {
    say: `画面を開いたり、文字の大きさや色を変えたりできます。「${featured.label}」のような画面の名前のほか、「${term}って何？」のように、画面に出ている言葉の意味も聞けます。`,
    expression: "listening",
    actions: [],
    offers: [
      { label: featured.label, icon: featured.icon, action: { kind: "navigate", href: featured.href } },
      ABOUT_THIS_PAGE,
      { label: "文字を大きく", icon: "add", action: { kind: "display", patch: { text: "l" } } },
      { label: "表示設定を開く", icon: "settings", action: { kind: "open-settings" } },
    ],
  };
}

/** 面談のこと（要約・予定日・メモ）は、ひとりずつの画面の「面談」タブにある。 */
function toMeeting(context: AssistantContext, what: string): AssistantReply {
  if (onDetail(context.pathname, Boolean(context.detail))) return pointHere("面談", `${what}は、この画面の「面談」タブにあります。`);
  const list = listOf(context);
  if (!list) {
    return {
      say: `${what}は、生徒や先生の記録を読む人の画面にあります。`,
      expression: "listening",
      actions: [],
      offers: [],
    };
  }
  return goTo(list, context, `${what}は、ひとりずつの画面の「面談」タブにあります。${list.label}の一覧から選んでください。`);
}

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
  // 開ける画面は権限で違う。開けない画面を頼まれたら、goTo がそう答える。
  {
    id: "educator-home",
    audience: "educator",
    words: ["ホーム", "ダッシュボード", "トップ", "最初の画面", "さいしょ"],
    reply: (context) => goTo(firstOf(context), context, "最初の画面に戻りますね。"),
  },
  {
    id: "today",
    audience: "educator",
    words: ["今日の記録", "今日を書く", "記録を書", "記録したい", "記録する", "自分の記録"],
    reply: (context) => goTo(EDUCATOR_DESTINATIONS.today, context, "今日の記録を開きますね。"),
  },
  {
    id: "my-records",
    audience: "educator",
    words: ["これまで", "振り返り", "ふりかえり", "過去の記録", "カレンダー"],
    reply: (context) => goTo(EDUCATOR_DESTINATIONS.records, context, "これまでの記録を開きますね。"),
  },
  {
    id: "class",
    audience: "educator",
    words: ["クラス", "学級", "生徒一覧", "生徒の一覧", "生徒"],
    reply: (context) => {
      const destination = studentsDestination(context);
      return goTo(destination, context, `${destination.label}の画面を開きますね。`);
    },
  },
  {
    id: "staff",
    audience: "educator",
    words: ["先生の一覧", "先生一覧", "教職員", "職員", "先生画面"],
    reply: (context) => goTo(EDUCATOR_DESTINATIONS.staff, context, "先生の画面を開きますね。"),
  },
  {
    id: "meetings",
    audience: "educator",
    words: ["面談メモ", "面談", "めんだん", "面接", "メモ"],
    reply: (context) => toMeeting(context, "面談の記録"),
  },
  {
    id: "summary",
    audience: "educator",
    words: ["面談前の要約", "要約", "サマリー"],
    reply: (context) => toMeeting(context, "面談前の要約"),
  },
  {
    id: "educator-settings",
    audience: "educator",
    words: ["設定", "せってい"],
    reply: (context) => goTo(EDUCATOR_DESTINATIONS.settings, context, "設定を開きますね。"),
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
        ? educatorHelp(context)
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
        ? { destination: firstOf(context), label: accessOf(context).write ? "今日の記録を書く" : `${firstOf(context).label}の画面を開く` }
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
  /** その見出しがあるページ。ひとりずつの画面のように、決まった URL が無いものは null。 */
  href: string | null;
  /** 教員の画面で、href を開くのに要る権限。無ければ説明だけをする。 */
  needs?: Need;
  /** href のほかにも見出しがあるページ（または href で表せないページ）に、いまいるか。 */
  where?: (pathname: string, detail: boolean) => boolean;
  /** ひとりずつの画面にある項目。いまその画面にいないとき、その人を選ぶ一覧を出す。 */
  pick?: boolean;
  say: string;
};

const onOverview = (pathname: string, detail: boolean) => onPeople(pathname) && !detail;

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
  // Blesc for Teachers の画面の言葉。どれも本人が書いた・選んだ記録を数えて
  // 並べたもので、点数・判定・順位の言葉は画面にも表にも置かない。
  {
    id: "readers",
    audience: "educator",
    heading: "この記録を読めるのは",
    words: ["この記録を読めるのは", "記録を読める人", "読める人", "だれが読める", "誰が読める", "閲覧者"],
    href: "/educator",
    needs: "write",
    say: "その記録を読める人です。書く画面の保存ボタンのすぐ上に、いつも出しています。読む向きは一方通行で（担任→学年主任→教頭→校長）、同僚どうしでは読めません。読める人は学校が決めます。",
  },
  {
    id: "promise",
    audience: "educator",
    heading: "この記録を読めるのは",
    words: ["人事評価", "勤務評定", "評価に使"],
    href: "/educator",
    needs: "write",
    say: "先生の記録は、人事評価・勤務評定には使われません。記録をまとめて書き出す機能も置いていません。",
  },
  {
    id: "mood",
    audience: "educator",
    heading: "今日はいかがでしたか",
    words: ["気分の選び方", "5つの顔", "5段階", "気分"],
    href: "/educator",
    needs: "write",
    say: "その日の気分を、5つの顔（とても良い・良い・ふつう・少しつらい・つらい）から選びます。記録に必要なのはこれだけで、気分だけでも保存できます。気分は点数にはしていません。",
  },
  {
    id: "themes",
    audience: "educator",
    heading: "テーマ",
    words: ["テーマ", "タグ", "業務量"],
    href: "/educator",
    needs: "write",
    say: "その日に関わったことを、授業・校務・生徒対応・保護者対応・部活動・業務量・体調・その他から選びます。いくつ選んでも、選ばなくても構いません。",
  },
  {
    id: "prompt",
    audience: "educator",
    heading: "今日のこと",
    words: ["書くことが思いつかない", "思いつかない", "別の質問", "質問"],
    href: "/educator",
    needs: "write",
    say: "「書くことが思いつかないとき」を押すと、記述欄の上に質問が1つ出ます。「別の質問」で入れ替えられます。答えた質問は記録と一緒に保存され、記録を読める人にも見えます。",
  },
  {
    id: "backfill",
    audience: "educator",
    heading: "",
    words: ["昨日の分", "書き忘れ", "さかのぼ"],
    href: null,
    say: "書き忘れた日は、2日前までさかのぼって書けます。それより前は空白のままです。記録を催促するお知らせは送りません。",
  },
  {
    id: "edit",
    audience: "educator",
    heading: "",
    words: ["編集", "書き直"],
    href: null,
    say: "保存した記録は、その日の23:59まで「編集」で書き直せます。",
  },
  {
    id: "today-count",
    audience: "educator",
    heading: "今日の記録状況",
    words: ["今日の記録状況", "何人書いた", "書いた人数", "記録状況"],
    href: "/educator/class",
    needs: "students",
    where: onOverview,
    say: "今日、記録を書いた人数です。誰が書いていないかは、ここには出しません。",
  },
  {
    id: "changes",
    audience: "educator",
    heading: "変化があった",
    words: ["変化があった生徒", "変化があった先生", "変化があった", "変化"],
    href: "/educator/class",
    needs: "students",
    where: onOverview,
    say: "直近2週間の記録を、それまでと比べて変化があった人です。記録の間・気分・話題・記述の長さ（先生は記録の時間も）を見て、何がどう変わったかを一文で書きます。並びは名簿順で、良い方向の変化も同じように出します。判定の基準はまだ仮置きです。",
  },
  {
    id: "weekly-check",
    audience: "educator",
    heading: "変化があった",
    words: ["今週分を確認した", "週の確認", "確認した"],
    href: "/educator/class",
    needs: "students",
    where: onOverview,
    say: "押すと、今週の「変化があった」の一覧を次の更新まで折りたたみます。自分用の目印で、管理職には伝わりません。",
  },
  {
    id: "strip",
    audience: "educator",
    heading: "直近7日の気分",
    words: ["直近7日の気分", "直近7日", "顔のアイコン", "点線の丸"],
    href: "/educator/class",
    needs: "students",
    where: onOverview,
    say: "直近7日（登校日）の気分を、日ごとの顔で並べています。点線の丸は記録のない日です。点数や平均には直していません。",
  },
  {
    id: "last-record",
    audience: "educator",
    heading: "最後に記録した日",
    words: ["最後に記録した日", "最後の記録"],
    href: "/educator/class",
    needs: "students",
    where: onOverview,
    say: "最後に記録した日と、今日から何日前かです。",
  },
  {
    id: "next-meeting",
    audience: "educator",
    heading: "次の面談",
    words: ["次の面談予定日", "次の面談", "面談予定", "予定日"],
    href: "/educator/class",
    needs: "students",
    say: "面談の予定日です。ひとりずつの画面の「面談」タブで入力すると一覧に出て、前日にあなたにだけお知らせします。",
  },
  {
    id: "trend",
    audience: "educator",
    heading: "推移",
    words: ["推移", "気分の帯", "タグの回数"],
    href: null,
    where: onDetail,
    pick: true,
    say: "「推移」タブでは、気分を折れ線ではなく日ごとの顔を並べた帯で、タグを回数で見られます。点数・平均値・順位は出しません。",
  },
  {
    id: "summary",
    audience: "educator",
    heading: "面談",
    words: ["面談前の要約", "要約を作る", "aiによる要約", "要約"],
    href: null,
    where: onDetail,
    pick: true,
    say: "「面談」タブの「要約を作る」で、直近2か月の記録から作ります。よく出てくる話題・気分の流れ・本人の言葉（記録からそのまま引用）の3つで、先生の要約には業務に関する記述も入ります。助言は書きません。AIによる要約なので、元の記録もご確認ください。",
  },
  {
    id: "quotes",
    audience: "educator",
    heading: "面談",
    words: ["本人の言葉", "引用"],
    href: null,
    where: onDetail,
    pick: true,
    say: "記録からそのまま切り出した本人の言葉です。押すと、その日の記録に移ります。",
  },
  {
    id: "work-notes",
    audience: "educator",
    heading: "面談",
    words: ["業務に関する記述", "業務"],
    href: null,
    where: onDetail,
    pick: true,
    say: "先生の要約にだけ入る項目で、業務量・校務・保護者対応のタグが付いた記録を抜き出したものです。業務分担を見直す材料にするためのものです。",
  },
  {
    id: "memo",
    audience: "educator",
    heading: "面談",
    words: ["面談メモ", "メモ", "次回確認すること", "面談を記録"],
    href: null,
    where: onDetail,
    pick: true,
    say: "面談の日付・内容・次回確認することを残すメモです。読めるのは書いた本人だけで、生徒（先生）本人には見えません。",
  },
  {
    id: "scope",
    audience: "educator",
    heading: "私が読める範囲",
    words: ["私が読める範囲", "読める範囲"],
    href: "/educator/settings",
    say: "あなたが読める記録の範囲です。権限や名簿は、学校からの依頼をもとに Blesc が設定します。",
  },
  {
    id: "notices",
    audience: "educator",
    heading: "お知らせ",
    words: ["面談前日のお知らせ", "週の確認のお知らせ", "お知らせ", "通知"],
    href: "/educator/settings",
    say: "面談の前日と、週の確認のお知らせを、設定で止めたり曜日を変えたりできます。記録を催促するお知らせはありません。",
  },
  {
    id: "no-export",
    audience: "educator",
    heading: "",
    words: ["印刷", "csv", "ダウンロード", "書き出し", "エクスポート"],
    href: null,
    say: "記録をまとめて書き出す機能（CSV）はありません。評価に流用されるのを防ぐためです。先生の記録の画面は、印刷もできないようにしています。",
  },
  {
    id: "no-scores",
    audience: "educator",
    heading: "",
    words: ["危険度", "リスク", "要注意", "アラート", "順位", "ランキング", "点数"],
    href: null,
    say: "Blesc は、点数・判定・順位を出しません。一覧の並びは名簿順です。",
  },
];

export type PageGuide = {
  audience: Audience;
  /** そのページを指す呼び名。「クラスの見方」のように、ページの名前で聞かれたとき。 */
  names: readonly string[];
  matches: (pathname: string, detail: boolean) => boolean;
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
    names: ["今日を書く", "自分の記録"],
    matches: (pathname) => pathname === "/educator",
    say: "先生ご自身の、今日の記録を書く画面です。必須は気分だけで、テーマと今日のこと（400字まで）は書いても書かなくても構いません。保存ボタンのすぐ上に、この記録を読める人をいつも出しています。",
    terms: ["気分", "テーマ", "この記録を読めるのは"],
  },
  {
    audience: "educator",
    names: ["これまで"],
    matches: (pathname) => pathname === "/educator/my-records",
    say: "これまでの自分の記録を、月のカレンダーで見られます。日を選ぶと、その日の気分・テーマ・本文・答えた質問が出ます。管理職が読んだかどうかは出しません。",
    terms: ["この記録を読めるのは", "編集"],
  },
  {
    audience: "educator",
    names: ["クラス", "クラス画面", "生徒の画面"],
    matches: (pathname, detail) => pathname === "/educator/class" && !detail,
    say: "担当している生徒の記録を読む画面です。今日の記録状況、変化があった生徒（この画面の主役）、全員の一覧が並んでいます。",
    terms: ["変化があった生徒", "今週分を確認した", "直近7日の気分"],
  },
  {
    audience: "educator",
    names: ["先生画面", "先生の画面", "教職員の画面"],
    matches: (pathname, detail) => pathname === "/educator/staff" && !detail,
    say: "読める範囲の先生の記録を読む画面です。今日の記録状況、変化があった先生、全員の一覧が並んでいます。先生の記録は、人事評価・勤務評定には使われません。",
    terms: ["変化があった先生", "今週分を確認した", "直近7日の気分"],
  },
  {
    audience: "educator",
    names: ["ひとりずつの画面", "個別画面", "個別の画面"],
    matches: onDetail,
    say: "ひとりぶんの記録の画面です。「記録」は本文をそのまま新しい順に、「推移」は気分の帯とタグの回数を、「面談」は面談前の要約・次の面談予定日・面談メモをまとめています。",
    terms: ["推移", "面談前の要約", "面談メモ"],
  },
  {
    audience: "educator",
    names: ["設定画面", "設定"],
    matches: (pathname) => pathname === "/educator/settings",
    say: "名前と担当、私の記録を読める人、私が読める範囲、お知らせ、学校の資料が並んでいます。権限や名簿の変更は、学校からの依頼をもとに Blesc が行います。",
    terms: ["私が読める範囲", "お知らせ"],
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
 * いまの権限では開けない画面にしか無い言葉は、説明だけをする。
 */
function explain(entry: GlossaryEntry, context: AssistantContext): AssistantReply {
  const detail = Boolean(context.detail);
  const here = entry.where ? entry.where(context.pathname, detail) : context.pathname === entry.href && !detail;
  const list = entry.pick ? listOf(context) : null;
  let offer: AssistantOffer | null = null;
  if (entry.heading && here) {
    offer = { label: "画面で見る", icon: "visibility", action: { kind: "show", heading: entry.heading, href: null } };
  } else if (entry.heading && entry.href && allows(context, entry.needs)) {
    offer = {
      label: `${PAGE_LABELS[entry.href] ?? "そのページ"}で見る`,
      icon: "visibility",
      action: { kind: "show", heading: entry.heading, href: entry.href },
    };
  } else if (list) {
    // ひとりずつの画面にある項目。だれの画面かはこちらでは決められない。
    offer = { label: `${list.label}の一覧から選ぶ`, icon: "groups", action: { kind: "navigate", href: list.href } };
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
    const guide = PAGE_GUIDES.find((item) => item.audience === context.audience && item.matches(context.pathname, Boolean(context.detail))) ?? null;
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
    placeholder: "今日の記録、変化があったって何？…",
    note: "ここでの言葉は端末の外に出ません。",
    suggestions: [
      { label: "この画面は何？", icon: "info" },
      { label: "だれが読める？", icon: "visibility" },
      { label: "変化があったって何？", icon: "info" },
      { label: "文字を大きく", icon: "add" },
    ],
  },
};
