import type { A11ySettings, TextSize } from "@/lib/a11y";
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
 * 逆に、表で拾えない言葉は無理に答えない。気持ちの話だと分かった時点で
 * 相談ページへ渡す。それがこの部品の一番大事な仕事になっている。
 */

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

export type AssistantAction =
  | { kind: "navigate"; href: string }
  | { kind: "display"; patch: Partial<A11ySettings> }
  | { kind: "open-settings" }
  /** 表示をすべて既定に戻す。既定値そのものは lib/a11y.ts が持つ。 */
  | { kind: "reset-display" }
  /** できることの説明を出す。 */
  | { kind: "help" }
  /** 相談ページへ渡す。text は下書きとして持っていく。 */
  | { kind: "handoff"; text: string };

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
   * 内容そのものは lib/safety-assessment.ts の監査済みの文をそのまま使う。
   */
  calm?: boolean;
};

export type AssistantContext = {
  pathname: string;
  settings: A11ySettings;
  /** 試験導入期間の進み具合。未確定（ハイドレーション前）は null。 */
  pilot: PilotProgress | null;
  /** lib/safety-assessment.ts の判定結果。 */
  safety: SafetyAssessment;
  /** これまでに生徒が送った回数。雑談の返事を毎回同じ言い回しにしないために使う。 */
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

const INTENTS: readonly Intent[] = [
  // ── 移動 ───────────────────────────────────────────────
  {
    id: "journal",
    words: ["日記", "にっき", "今日のこと", "書きたい", "記録したい", "入力"],
    reply: (context) => goTo(DESTINATIONS.journal, context, "日記のページを開きますね。"),
  },
  {
    id: "reflect",
    words: ["振り返り", "ふりかえり", "グラフ", "変化", "傾向", "これまで", "先週"],
    reply: (context) => goTo(DESTINATIONS.reflect, context, "振り返りのページを開きますね。"),
  },
  {
    id: "chat",
    words: ["相談", "話したい", "聞いてほしい", "聞いて", "悩み", "はなしたい"],
    reply: (context) => goTo(DESTINATIONS.chat, context, "相談のページを開きますね。ゆっくりで大丈夫です。"),
  },
  {
    id: "home",
    words: ["ホーム", "最初の画面", "トップ", "さいしょ"],
    reply: (context) => goTo(DESTINATIONS.home, context, "ホームに戻りますね。"),
  },
  {
    id: "sharing",
    words: ["共有", "だれが見", "誰が見", "先生に見", "見られ", "プライバシー", "公開範囲"],
    reply: (context) =>
      goTo(DESTINATIONS.sharing, context, "誰に何が伝わるかは、共有の設定で確かめられます。開きますね。"),
  },
  {
    id: "audit",
    words: ["aiの記録", "どう使われ", "処理の記録", "履歴"],
    reply: (context) => goTo(DESTINATIONS.audit, context, "AI処理の記録を開きますね。"),
  },
  {
    id: "timeline",
    words: ["タイムライン", "たいむらいん"],
    reply: (context) => goTo(DESTINATIONS.timeline, context, "タイムラインを開きますね。"),
  },
  {
    id: "summary",
    words: ["支援サマリー", "サマリー", "まとめ"],
    reply: (context) => goTo(DESTINATIONS.summary, context, "支援サマリーを開きますね。"),
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
      if (!context.pilot) {
        return {
          say: "試験導入の残りは、ホームのカレンダーで確かめられます。",
          expression: "rest",
          actions: [],
          offers: [{ label: "カレンダーを見る", icon: "calendar_month", action: { kind: "navigate", href: DESTINATIONS.home.href } }],
        };
      }
      const say =
        context.pilot.phase === "before"
          ? "試験導入はまだ始まっていません。"
          : context.pilot.phase === "after"
            ? "試験導入の期間は終わっています。"
            : `試験導入は、今日を入れてあと${context.pilot.remaining}日です。`;
      return {
        say,
        expression: "rest",
        actions: [],
        offers:
          context.pathname === DESTINATIONS.home.href
            ? []
            : [{ label: "カレンダーを見る", icon: "calendar_month", action: { kind: "navigate", href: DESTINATIONS.home.href } }],
      };
    },
  },
  {
    id: "help",
    words: ["使い方", "つかいかた", "何ができる", "なにができる", "ヘルプ", "できること", "help"],
    reply: () => ({
      say: "ページを開いたり、文字の大きさや色を変えたりできます。「日記」「文字を大きく」のように打ってみてください。",
      expression: "listening",
      actions: [],
      offers: [
        { label: "日記", icon: DESTINATIONS.journal.icon, action: { kind: "navigate", href: DESTINATIONS.journal.href } },
        { label: "文字を大きく", icon: "add", action: { kind: "display", patch: { text: "l" } } },
        { label: "表示設定を開く", icon: "settings", action: { kind: "open-settings" } },
      ],
    }),
  },
  {
    id: "identity",
    words: ["だれ", "誰な", "誰で", "あなたは", "きみは", "君は", "名前", "何者"],
    reply: () => ({
      say: "blescの案内役です。画面の移動と、見え方の調整を手伝います。気持ちの話は、相談のページでちゃんと聞きます。",
      expression: "listening",
      actions: [],
      offers: [{ label: "相談へ", icon: DESTINATIONS.chat.icon, action: { kind: "navigate", href: DESTINATIONS.chat.href } }],
    }),
  },
  // ── 雑談 ─────────────────────────────────────────────
  // 気分が沈んだ言葉を先に置く。「すごい疲れた」のように同じ強さで並んだとき、
  // 明るい返事のほうを選ばないように。
  {
    id: "low",
    chat: true,
    words: ["つらい", "辛い", "しんどい", "疲れた", "つかれた", "元気がない", "元気ない", "落ち込", "だるい", "さみしい", "寂しい", "不安"],
    reply: (context, said) => ({
      say: pick(["話してくれてありがとうございます。", "そういう日もありますよね。"], context.turn)
        + "相談のページでは、ゆっくり話を聞けます。",
      expression: "steady",
      calm: true,
      actions: [],
      offers: [
        { label: "相談のページで話す", icon: DESTINATIONS.chat.icon, action: { kind: "handoff", text: said.raw } },
        { label: "日記に書く", icon: DESTINATIONS.journal.icon, action: { kind: "navigate", href: DESTINATIONS.journal.href } },
      ],
    }),
  },
  {
    id: "greeting",
    chat: true,
    words: ["こんにちは", "こんにちわ", "こんばんは", "こんばんわ", "おはよう", "はじめまして", "やあ", "hello", "よろしく"],
    reply: (context, said) => ({
      say: said.text.includes("はじめまして")
        ? "はじめまして。blescの案内役です。ページの移動と、見え方の調整を手伝います。"
        : greetingFor(said.text) + pick(["今日はどうしますか。", "行きたいページや、見えにくいところがあれば言ってください。"], context.turn),
      expression: "happy",
      actions: [],
      offers: [
        ...(context.pathname === DESTINATIONS.journal.href
          ? []
          : [{ label: "日記を書く", icon: DESTINATIONS.journal.icon, action: { kind: "navigate", href: DESTINATIONS.journal.href } } as const]),
        { label: "できることを見る", icon: "lightbulb", action: { kind: "help" } },
      ],
    }),
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
] as const;

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

/** 表に載っている言葉すべて。どれも実際に反応するかを試験で確かめている。 */
export const INTENT_WORDS: readonly string[] = INTENTS.flatMap((intent) => [...intent.words, ...(intent.exact ?? [])]);

/** 一致の強さ。いちばん長く一致した言葉の文字数で測る。 */
function score(text: string, words: readonly string[]): number {
  let best = 0;
  for (const word of words) {
    if (word.length > best && text.includes(word)) best = word.length;
  }
  return best;
}

/** 操作（chat = false）か雑談（chat = true）のうち、いちばん強く一致したもの。 */
function strongest(text: string, chat: boolean): Intent | null {
  let matched: Intent | null = null;
  let top = 0;
  for (const matcher of MATCHERS) {
    if (Boolean(matcher.intent.chat) !== chat) continue;
    const value = matcher.exact.includes(text) ? Number.POSITIVE_INFINITY : score(text, matcher.words);
    if (value > top) {
      top = value;
      matched = matcher.intent;
    }
  }
  return top >= MATCH_FLOOR ? matched : null;
}

/** 2 文字は「日記」「設定」のような最短の語。1 文字では拾わない。 */
const MATCH_FLOOR = 2;

/**
 * 言葉を受け取り、返事と動作を決める。
 *
 * 順番に意味がある。つらさが混じっていないかを最初に見て、そこで拾ったら
 * 表は引かない。「死にたい、日記を開いて」を日記への移動として処理して
 * しまうのが、この種の仕組みで一番やってはいけないこと。
 */
export function routeIntent(raw: string, context: AssistantContext): AssistantReply {
  const text = normalize(raw);
  if (!text) {
    return { say: "どうしますか。", expression: "listening", actions: [], offers: [] };
  }

  if (context.safety.risk_level === "crisis" || context.safety.risk_level === "elevated") {
    return {
      // 文言は監査済みのものをそのまま出す。ここで言い換えない。
      say: context.safety.safe_response,
      expression: "steady",
      calm: true,
      actions: [],
      offers: [{ label: "相談のページで話す", icon: DESTINATIONS.chat.icon, action: { kind: "handoff", text: raw } }],
    };
  }

  const said = { text, raw };
  const task = strongest(text, false);
  const chat = strongest(text, true);

  if (task) {
    const reply = task.reply(context, said);
    // 「こんにちは、日記を書きたい」には、あいさつを返してから動く。
    return chat?.id === "greeting" ? { ...reply, say: greetingFor(text) + reply.say } : reply;
  }
  if (chat) return chat.reply(context, said);

  // 表で拾えなかったとき。作り話で埋めずに、相談へ渡す道を出す。
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

/** 空のときに出す候補。 */
export const SUGGESTIONS: ReadonlyArray<{ label: string; icon: IconName }> = [
  { label: "日記を書きたい", icon: "edit_note" },
  { label: "文字を大きく", icon: "add" },
  { label: "あと何日？", icon: "calendar_month" },
  { label: "誰が見られるの？", icon: "shield" },
];
