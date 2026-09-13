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
 * 作文で埋めると、教員が「要注意」の意味を取り違えることになる。
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

export const EDUCATOR_DESTINATIONS = {
  home:     { href: "/educator",          label: "ホーム",         icon: "dashboard" },
  roster:   { href: "/educator/roster",   label: "生徒一覧",       icon: "groups" },
  alerts:   { href: "/educator/alerts",   label: "アラート",       icon: "notifications_active" },
  class:    { href: "/educator/class",    label: "クラス全体",     icon: "grid_view" },
  meetings: { href: "/educator/meetings", label: "面談",           icon: "event_note" },
  school:   { href: "/school",            label: "学校全体の傾向", icon: "apartment" },
} as const satisfies Record<string, Destination>;

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
  "/educator": "ホーム",
  "/educator/roster": "生徒一覧",
  "/educator/alerts": "アラート",
  "/educator/class": "クラス全体",
  "/educator/meetings": "面談",
  "/school": "学校全体の傾向",
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

const homeOf = (audience: Audience): Destination =>
  audience === "educator" ? EDUCATOR_DESTINATIONS.home : DESTINATIONS.home;

/** 相手のあいさつに合わせて返す。 */
function greetingFor(text: string): string {
  if (text.includes("おはよう")) return "おはようございます。";
  if (text.includes("こんばんは") || text.includes("こんばんわ")) return "こんばんは。";
  if (text.includes("はじめまして")) return "はじめまして。";
  if (text.includes("よろしく")) return "よろしくお願いします。";
  return "こんにちは。";
}

const goTo = (destination: Destination, context: AssistantContext, say: string): AssistantReply => {
  if (context.pathname === destination.href) {
    return {
      say: `いま開いているのが${destination.label}のページです。`,
      expression: "happy",
      actions: [],
      offers: [],
    };
  }
  return {
    say,
    expression: "happy",
    actions: [{ kind: "navigate", href: destination.href }],
    offers: [],
  };
};

/** 表示を変えたときの返事。取り消せることを必ず添える。 */
const changed = (say: string, patch: Partial<A11ySettings>, previous: Partial<A11ySettings>): AssistantReply => ({
  say,
  expression: "happy",
  actions: [{ kind: "display", patch }],
  offers: [
    { label: "元に戻す", icon: "arrow_back", action: { kind: "display", patch: previous } },
    { label: "表示設定を開く", icon: "settings", action: { kind: "open-settings" } },
  ],
});

const ABOUT_THIS_PAGE: AssistantOffer = { label: "この画面について", icon: "info", action: { kind: "ask", text: "この画面は何？" } };

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
  {
    id: "educator-home",
    audience: "educator",
    words: ["ホーム", "ダッシュボード", "トップ", "最初の画面", "さいしょ"],
    reply: (context) => goTo(EDUCATOR_DESTINATIONS.home, context, "ホームに戻りますね。"),
  },
  {
    id: "roster",
    audience: "educator",
    // 「クラスの生徒」は生徒一覧。「クラス」だけならクラス全体に行く。
    words: ["生徒一覧", "生徒の一覧", "クラスの生徒", "名簿", "生徒"],
    reply: (context) => goTo(EDUCATOR_DESTINATIONS.roster, context, "生徒一覧を開きますね。"),
  },
  {
    id: "alerts",
    audience: "educator",
    words: ["アラート", "通知", "緊急", "気になる生徒", "確認が必要"],
    reply: (context) => goTo(EDUCATOR_DESTINATIONS.alerts, context, "アラートを開きますね。"),
  },
  {
    id: "class",
    audience: "educator",
    words: ["クラス全体", "クラス", "学級", "ヒートマップ"],
    reply: (context) => goTo(EDUCATOR_DESTINATIONS.class, context, "クラス全体を開きますね。"),
  },
  {
    id: "meetings",
    audience: "educator",
    words: ["面談", "めんだん", "面接"],
    reply: (context) => goTo(EDUCATOR_DESTINATIONS.meetings, context, "面談のページを開きますね。"),
  },
  {
    id: "school",
    audience: "educator",
    words: ["学校全体", "全校", "学年ごと", "学年"],
    reply: (context) => goTo(EDUCATOR_DESTINATIONS.school, context, "学校全体の傾向を開きますね。"),
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
      expression: "happy",
      actions: [{ kind: "reset-display" }],
      offers: [{ label: "表示設定を開く", icon: "settings", action: { kind: "open-settings" } }],
    }),
  },
  {
    id: "settings",
    words: ["表示設定", "設定", "せってい"],
    reply: () => ({
      say: "表示設定を開きますね。",
      expression: "happy",
      actions: [{ kind: "open-settings" }],
      offers: [],
    }),
  },

  // ── 答えるだけ ─────────────────────────────────────────
  {
    id: "pilot",
    words: ["あと何日", "何日", "いつまで", "期間", "残り", "終わる", "試験導入", "パイロット", "お試し"],
    reply: (context) => {
      const home = homeOf(context.audience);
      const calendar: AssistantOffer = {
        label: "カレンダーを見る",
        icon: "calendar_month",
        action: { kind: "show", heading: "試験導入期間", href: home.href },
      };
      if (!context.pilot) {
        return {
          say: "試験導入の残りは、ホームのカレンダーで確かめられます。",
          expression: "rest",
          actions: [],
          offers: [calendar],
        };
      }
      const say =
        context.pilot.phase === "before"
          ? "試験導入はまだ始まっていません。"
          : context.pilot.phase === "after"
            ? "試験導入の期間は終わっています。"
            : `試験導入は、今日を入れてあと${context.pilot.remaining}日です。`;
      return { say, expression: "rest", actions: [], offers: [calendar] };
    },
  },
  {
    id: "help",
    words: ["使い方", "つかいかた", "何ができる", "なにができる", "ヘルプ", "できること", "help"],
    reply: (context) =>
      context.audience === "educator"
        ? {
            say: "画面を開いたり、文字の大きさや色を変えたりできます。「アラート」「面談」のほか、「高リスクって何？」のように、画面に出ている言葉の意味も聞けます。",
            expression: "listening",
            actions: [],
            offers: [
              { label: "アラート", icon: EDUCATOR_DESTINATIONS.alerts.icon, action: { kind: "navigate", href: EDUCATOR_DESTINATIONS.alerts.href } },
              ABOUT_THIS_PAGE,
              { label: "文字を大きく", icon: "add", action: { kind: "display", patch: { text: "l" } } },
              { label: "表示設定を開く", icon: "settings", action: { kind: "open-settings" } },
            ],
          }
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
    words: ["だれ", "誰な", "誰で", "あなたは", "きみは", "君は", "名前", "何者"],
    reply: (context) =>
      context.audience === "educator"
        ? {
            say: "blescの案内役です。画面の移動と、見え方の調整、画面に出ている言葉の説明を手伝います。",
            expression: "listening",
            actions: [],
            offers: [],
          }
        : {
            say: "blescの案内役です。ページの移動と、見え方の調整、画面に出ている言葉の説明を手伝います。気持ちの話は、相談のページでちゃんと聞きます。",
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
        ? { destination: EDUCATOR_DESTINATIONS.alerts, label: "アラートを見る" }
        : { destination: DESTINATIONS.journal, label: "日記を書く" };
      return {
        say: said.text.includes("はじめまして")
          ? "はじめまして。blescの案内役です。ページの移動と、見え方の調整、画面の見方の説明を手伝います。"
          : greetingFor(said.text)
            + pick(
                educator
                  ? ["今日はどうしますか。", "開きたい画面や、画面に出ている言葉の意味があれば聞いてください。"]
                  : ["今日はどうしますか。", "行きたいページや、見えにくいところがあれば言ってください。"],
                context.turn,
              ),
        expression: "happy",
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
      expression: "happy",
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
      expression: "happy",
      actions: [],
      offers: [],
    }),
  },
  {
    id: "sorry",
    chat: true,
    words: ["ごめん", "すみません", "すいません"],
    reply: () => ({ say: "気にしないでください。", expression: "happy", actions: [], offers: [] }),
  },
  {
    id: "praise",
    chat: true,
    words: ["かわいい", "可愛い", "すごい", "いいね", "えらい"],
    reply: (context) => ({
      say: pick(["ありがとうございます。うれしいです。", "そう言ってもらえると、うれしいです。"], context.turn),
      expression: "happy",
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
    reply: () => ({ say: "どういたしまして。", expression: "happy", actions: [], offers: [] }),
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
  /** その見出しがあるページ。生徒ごとの画面のように、決まった URL がないものは null。 */
  href: string | null;
  /** href で表せないページにあるとき、いまそのページにいるか。 */
  where?: (pathname: string) => boolean;
  say: string;
};

const onStudentDetail = (pathname: string) => pathname.startsWith("/educator/student/");

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
  {
    id: "band",
    audience: "educator",
    heading: "状態",
    words: ["高リスク", "要注意", "安定", "状態の区分", "状態の色", "色分け", "状態"],
    href: "/educator/roster",
    say: "日記と対話の内容からAIが算出した傾向を、3つに分けたものです。高リスクは優先的に確認、要注意は様子を見る、安定は大きな変化なし、の目安です。診断ではありません。最終的な判断は学校の支援体制が行います。",
  },
  {
    id: "trend",
    audience: "educator",
    heading: "傾向",
    words: ["悪化傾向", "改善傾向", "横ばい", "傾向"],
    href: "/educator/roster",
    say: "最近の記録から見た、状態の変化の向きです。悪化傾向・改善傾向・横ばいの3つで表します。",
  },
  {
    id: "last-entry",
    audience: "educator",
    heading: "最終提出",
    words: ["最終提出"],
    href: "/educator/roster",
    say: "その生徒が最後に日記を提出した日です。",
  },
  {
    id: "missed",
    audience: "educator",
    heading: "未提出",
    words: ["未提出日数", "未提出"],
    href: "/educator/roster",
    say: "日記を提出していない日数です。未提出は体調・行事・端末の不調など様々な理由で起こるので、状態の判断ではなく、声掛けのきっかけとして使ってください。",
  },
  {
    id: "follow-up-flag",
    audience: "educator",
    heading: "AI補足",
    words: ["ai補足", "aiによる補足"],
    href: "/educator/roster",
    say: "生徒が日記のあと、対話型AIの質問に答えたかどうかです。教員には要約だけが表示され、会話の全文は表示されません。生徒が「話したくない」を選んだ内容は記録されていません。",
  },
  {
    id: "themes",
    audience: "educator",
    heading: "主な観点",
    words: ["主な観点", "観点"],
    href: "/educator/roster",
    say: "AIが日記を分析するときの観点のうち、その生徒で目立っているものです。学業ストレス・人間関係・家庭環境・睡眠不足・自己否定的な表現・感情の急激な変化・日記未提出・利用頻度の低下があります。AIは診断を行いません。",
  },
  {
    id: "support-status",
    audience: "educator",
    heading: "対応",
    words: ["対応ステータス", "未対応", "経過観察", "面談予定", "面談実施済", "連携中", "対応完了"],
    href: "/educator/roster",
    say: "その生徒への対応の進み具合です。未対応・経過観察・面談予定・面談実施済・連携中・対応完了があります。",
  },
  {
    id: "urgent",
    audience: "educator",
    heading: "優先度の高いアラート",
    words: ["優先度の高いアラート", "早急な確認", "緊急性", "検知の根拠"],
    href: "/educator/alerts",
    say: "日記や対話型AIとのやりとりに、緊急性が高い可能性のある内容が見つかった生徒です。検知された内容の要約、検知の根拠、出典と、対応の流れ（担当者への通知、学校の定める緊急対応フローに沿った確認、必要に応じた連携）が表示されます。",
  },
  {
    id: "missing-alerts",
    audience: "educator",
    heading: "日記の未提出",
    words: ["日記の未提出", "3日以上未提出", "1週間未利用", "連続提出が中断", "提出頻度が低下"],
    href: "/educator/alerts",
    say: "提出の様子に変化がある生徒の一覧です。3日以上未提出・1週間未利用・連続提出が中断・提出頻度が低下の4種類があります。未提出は様々な理由で起こるので、声掛けのきっかけとして使ってください。",
  },
  {
    id: "follow-up",
    audience: "educator",
    heading: "フォロー漏れ",
    words: ["フォロー漏れ", "フォローアップ"],
    href: "/educator/alerts",
    say: "面談のあとのフォローが止まっていないかを確かめるための一覧です。前回の面談からの日数、次回の面談日（決まっていなければ未設定）、AIの所見が表示され、そこから面談を設定できます。",
  },
  {
    id: "heatmap",
    audience: "educator",
    heading: "クラス全体ヒートマップ",
    words: ["クラス全体ヒートマップ", "ヒートマップ"],
    href: "/educator/class",
    say: "クラスの生徒を1マスずつ、状態の色（高リスク・要注意・安定）で並べたものです。色は日記と対話の内容からAIが算出した傾向で、診断ではありません。未提出がある生徒にはマークが付き、マスを押すとその生徒の画面を開けます。",
  },
  {
    id: "class-trend",
    audience: "educator",
    heading: "クラス全体の傾向",
    words: ["クラス全体の傾向"],
    href: "/educator/class",
    say: "日記と対話の内容から、いま何についての記述が多いかをクラス全体で集計したものです。右端の数値は先週との差（ポイント）です。",
  },
  {
    id: "class-hints",
    audience: "educator",
    heading: "学級運営のヒント",
    words: ["学級運営のヒント"],
    href: "/educator/class",
    say: "クラス全体の記述の傾向から、学級運営で確かめられそうなことをまとめたものです。",
  },
  {
    id: "meeting-support",
    audience: "educator",
    heading: "AIによる面談サポート",
    words: ["aiによる面談サポート", "面談サポート", "質問案"],
    href: "/educator/meetings",
    say: "生徒の記録から、面談で確認したい質問案を用意できます。面談記録は担当教員と支援担当者が閲覧できます。",
  },
  {
    id: "detail-mood",
    audience: "educator",
    heading: "感情の推移",
    words: ["感情の推移"],
    href: null,
    where: onStudentDetail,
    say: "生徒が記録した日ごとの気分を、日付の順に線でつないだグラフです。上が「とても良い」、下が「つらい」です。",
  },
  {
    id: "detail-categories",
    audience: "educator",
    heading: "出来事の傾向",
    words: ["出来事の傾向"],
    href: null,
    where: onStudentDetail,
    say: "生徒が日記で選んだ出来事を、回数で表したものです。",
  },
  {
    id: "detail-themes",
    audience: "educator",
    heading: "注目されている観点",
    words: ["注目されている観点"],
    href: null,
    where: onStudentDetail,
    say: "AIが日記を分析するときの観点のうち、この生徒でいま目立っているものです。AIは診断を行いません。教員が状況を確認するための補助です。",
  },
  {
    id: "detail-timeline",
    audience: "educator",
    heading: "AIタイムライン",
    words: ["aiタイムライン"],
    href: null,
    where: onStudentDetail,
    say: "すべての日記と対話を読まなくても、変化の要点を追えるように日付順にまとめたものです。",
  },
  {
    id: "detail-follow-up",
    audience: "educator",
    heading: "対話型AIによる補足",
    words: ["対話型aiによる補足"],
    href: null,
    where: onStudentDetail,
    say: "日記のあとに対話型AIとやりとりした内容の要約です。会話の全文は表示されません。生徒が「話したくない」を選んだ内容は記録されていません。",
  },
  {
    id: "detail-suggestions",
    audience: "educator",
    heading: "検討できる支援",
    words: ["検討できる支援", "支援の例"],
    href: null,
    where: onStudentDetail,
    say: "観点ごとに、次の一手を考えるための材料として支援の例を挙げています。AIが判断を代替するものではありません。",
  },
  {
    id: "detail-actions",
    audience: "educator",
    heading: "対応履歴",
    words: ["対応履歴"],
    href: null,
    where: onStudentDetail,
    say: "AIの検知と教員の対応をまとめて確認できる記録です。引き継ぎや対応の重複を防ぐために使えます。",
  },
  {
    id: "school-breakdown",
    audience: "educator",
    heading: "記述されている内容の内訳",
    words: ["記述されている内容の内訳", "内容の内訳"],
    href: "/school",
    say: "学校全体で、何についての記述が多いかの割合です。学校全体の傾向把握が目的で、個人の状態を示すものではなく、診断でもありません。",
  },
  {
    id: "school-trend",
    audience: "educator",
    heading: "6週間の推移",
    words: ["6週間の推移"],
    href: "/school",
    say: "学業・人間関係・睡眠についての記述が、週ごとにどう変わったかを表しています。",
  },
  {
    id: "school-hidden",
    audience: "educator",
    heading: "学年",
    words: ["母数が小さい", "非表示", "表示されない"],
    href: "/school",
    say: "人数が少ない学年は、個人が特定されないよう数値を表示していません。",
  },
  {
    id: "educator-pilot",
    audience: "educator",
    heading: "試験導入期間",
    words: ["試験導入期間", "試験導入"],
    href: "/educator",
    say: "blescを試験的に導入している期間です。カレンダーで、始まりから終わりまでの日と今日の位置、残りの日数を確かめられます。",
  },
];

export type PageGuide = {
  audience: Audience;
  /** そのページを指す呼び名。「アラートの見方」のように、ページの名前で聞かれたとき。 */
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
    names: ["ホーム", "ダッシュボード"],
    matches: (pathname) => pathname === "/educator",
    say: "クラスの状態ごとの人数（高リスク・要注意・安定）、確認したい生徒、日記の未提出、フォローアップ、対応ステータス、試験導入期間が並んでいます。早急な確認が必要な可能性がある生徒がいるときは、いちばん上に表示されます。",
    terms: ["高リスク", "日記の未提出", "フォローアップ"],
  },
  {
    audience: "educator",
    names: ["生徒一覧"],
    matches: (pathname) => pathname === "/educator/roster",
    say: "クラスの生徒ごとに、状態・傾向・最終提出・未提出・AI補足・主な観点・対応・担当を一覧で見られます。日記の本文と対話の全文は、ここには表示されません。",
    terms: ["状態", "AI補足", "主な観点"],
  },
  {
    audience: "educator",
    names: ["アラート"],
    matches: (pathname) => pathname === "/educator/alerts",
    say: "優先度の高いアラート、日記の未提出、フォロー漏れをまとめています。確認のきっかけとして使い、アラートだけで状態を判断しないでください。",
    terms: ["優先度の高いアラート", "日記の未提出", "フォロー漏れ"],
  },
  {
    audience: "educator",
    names: ["クラス全体", "クラス"],
    matches: (pathname) => pathname === "/educator/class",
    say: "クラス全体ヒートマップ、提出・補足・対応の人数、クラス全体の傾向、学級運営のヒントが見られます。",
    terms: ["クラス全体ヒートマップ", "クラス全体の傾向"],
  },
  {
    audience: "educator",
    names: ["面談"],
    matches: (pathname) => pathname === "/educator/meetings",
    say: "面談の記録と、AIによる面談サポートをまとめています。面談記録は担当教員と支援担当者が閲覧できます。",
    terms: ["AIによる面談サポート"],
  },
  {
    audience: "educator",
    names: ["生徒の画面", "生徒の詳細"],
    matches: onStudentDetail,
    say: "生徒ひとりの感情の推移、出来事の傾向、注目されている観点、AIタイムライン、対話型AIによる補足、検討できる支援、面談記録、対応履歴をまとめています。AIは診断を行いません。",
    terms: ["注目されている観点", "AIタイムライン", "検討できる支援"],
  },
  {
    audience: "educator",
    names: ["学校全体の傾向", "学校全体"],
    matches: (pathname) => pathname === "/school",
    say: "学校全体と学年ごとの傾向を、個人が特定されない形で集計しています。個人の状態を示すものではなく、診断でもありません。",
    terms: ["記述されている内容の内訳", "6週間の推移"],
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

/** 言葉の説明。いまその画面にいれば「画面で見る」、いなければ開いてから示す。 */
function explain(entry: GlossaryEntry, context: AssistantContext): AssistantReply {
  const here = entry.where ? entry.where(context.pathname) : context.pathname === entry.href;
  let offer: AssistantOffer;
  if (here) {
    offer = { label: "画面で見る", icon: "visibility", action: { kind: "show", heading: entry.heading, href: null } };
  } else if (entry.href) {
    offer = {
      label: `${PAGE_LABELS[entry.href] ?? "そのページ"}で見る`,
      icon: "visibility",
      action: { kind: "show", heading: entry.heading, href: entry.href },
    };
  } else {
    // 生徒ごとの画面にある項目。どの生徒かはこちらでは決められない。
    offer = {
      label: "生徒一覧から選ぶ",
      icon: EDUCATOR_DESTINATIONS.roster.icon,
      action: { kind: "navigate", href: EDUCATOR_DESTINATIONS.roster.href },
    };
  }
  return { say: entry.say, expression: "listening", actions: [], offers: [offer] };
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
 * 向けると噛み合わない。多くは生徒についての話なので、アラートと学校の
 * 緊急対応フローを示す（教員画面にすでにある文言に揃えてある）。
 * 教員自身のことである可能性にも一言だけ触れる。言葉はどこにも渡さない。
 */
function educatorConcern(): AssistantReply {
  return {
    say: "深刻な内容が含まれているかもしれません。生徒についてのことなら、アラートの画面を開き、学校の定める緊急対応フローに沿って状況を確認してください。ご自身のことであれば、身近な人や専門の窓口に相談してください。",
    expression: "steady",
    calm: true,
    actions: [],
    offers: [{ label: "アラートを見る", icon: EDUCATOR_DESTINATIONS.alerts.icon, action: { kind: "navigate", href: EDUCATOR_DESTINATIONS.alerts.href } }],
  };
}

/**
 * 言葉を受け取り、返事と動作を決める。
 *
 * 順番に意味がある。
 *  1. つらさが混じっていないかを最初に見て、そこで拾ったら表は引かない。
 *     「死にたい、日記を開いて」を日記への移動として処理してしまうのが、
 *     この種の仕組みで一番やってはいけないこと。
 *  2. 意味を聞いていれば説明する。「アラート」は開くが、「アラートって何？」
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
    // 長く一致したほうを取る。「クラス全体の傾向とは」は、ページ名の
    // 「クラス全体」ではなく項目の「クラス全体の傾向」の説明。
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
  // 見出しの言葉だけが来たとき（「日記の未提出」など）も説明する。
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
    placeholder: "アラート、高リスクって何？…",
    note: "ここでの言葉は端末の外に出ません。",
    suggestions: [
      { label: "アラートを見る", icon: "notifications_active" },
      { label: "この画面は何？", icon: "info" },
      { label: "高リスクって何？", icon: "info" },
      { label: "文字を大きく", icon: "add" },
    ],
  },
};
