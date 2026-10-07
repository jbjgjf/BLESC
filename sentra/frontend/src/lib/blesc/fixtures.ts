import { TODAY, addDays } from "./labels";
import type { DiaryEntry, GuardianView, SubmissionStats } from "./types";

/**
 * デモ用の固定データ。企画書の各機能を一通り確認できる分量を持たせている。
 * 実在の生徒データではない。バックエンド接続後は data.ts 側で差し替える。
 */

/* ── 生徒側 ─────────────────────────────────────────────────── */

export const CURRENT_STUDENT = {
  name: "田中 悠真",
  grade: "2年",
  className: "A組",
};

export const MY_ENTRIES: DiaryEntry[] = [
  {
    id: "e-0806",
    date: addDays(TODAY, -1),
    mood: "good",
    categories: ["club", "study"],
    body: "部活の練習試合で、久しぶりにスタメンで出られた。数学の小テストも返ってきて、思ったより点が良かった。先輩が「今日の動き良かった」と声をかけてくれたのが嬉しかった。来週の実力テストの範囲がまだ全然終わっていないのは気になる。疲れたけど、今日はいい一日だった気がする。",
    submittedAt: `${addDays(TODAY, -1)}T21:14:00`,
  },
  {
    id: "e-0805",
    date: addDays(TODAY, -2),
    mood: "neutral",
    categories: ["study"],
    body: "授業が6時間あって、あまり印象に残ることがなかった。放課後は図書室で課題をやったけど、終わる気がしない。",
    submittedAt: `${addDays(TODAY, -2)}T22:02:00`,
  },
  {
    id: "e-0804",
    date: addDays(TODAY, -3),
    mood: "low",
    categories: ["friends", "health"],
    body: "昼休みにグループで話していたとき、自分だけ話題についていけなかった。みんなが盛り上がっているのを見て、少し距離を感じた。夜もあまり眠れなくて、最近寝つきが悪い。考えすぎかもしれない。",
    submittedAt: `${addDays(TODAY, -3)}T23:41:00`,
    followUp: {
      summary: "友人関係で疎外感を感じた出来事について確認。今日だけの出来事とのこと。睡眠についても言及あり。",
      turns: [
        { role: "ai", text: "特に気になった出来事はありましたか。" },
        { role: "student", text: "友人関係" },
        { role: "ai", text: "友人関係で、どのようなことがありましたか。話せる範囲で記録してください。" },
        { role: "student", text: "グループで話している時に、自分だけ話に入れなかった気がした" },
        { role: "ai", text: "そのように感じる出来事は今日だけでしたか。それとも最近も続いていますか。" },
        { role: "student", text: "今日だけ" },
      ],
    },
  },
  {
    id: "e-0803",
    date: addDays(TODAY, -4),
    mood: "good",
    categories: ["club"],
    body: "部活のあと、友達とコンビニに寄って帰った。何でもない時間だけど楽しかった。",
    submittedAt: `${addDays(TODAY, -4)}T20:30:00`,
  },
  {
    id: "e-0802",
    date: addDays(TODAY, -5),
    mood: "very_good",
    categories: ["family", "club"],
    body: "家族で出かけた。部活は休みだったので、久しぶりにゆっくりできた。また行きたい。",
    submittedAt: `${addDays(TODAY, -5)}T19:12:00`,
  },
  {
    id: "e-0801",
    date: addDays(TODAY, -6),
    mood: "neutral",
    categories: ["study", "future"],
    body: "進路希望調査の紙が配られた。まだ何も決まっていないなと思った。文理選択をどうするか迷っている。",
    submittedAt: `${addDays(TODAY, -6)}T21:50:00`,
  },
];

export const MY_STATS: SubmissionStats = {
  streak: 6,
  weekCount: 5,
  monthRate: 0.86,
  lastSubmitted: addDays(TODAY, -1),
  submittedDays: [1, 2, 3, 4, 5, 6].map((d) => addDays(TODAY, -d)),
};

/* ── 追加機能 ───────────────────────────────────────────────── */

export const GUARDIAN_VIEW: GuardianView = {
  studentName: "田中 悠真",
  className: "2年A組",
  stats: MY_STATS,
  sharedMoodSeries: [
    { date: addDays(TODAY, -6), mood: "neutral" },
    { date: addDays(TODAY, -5), mood: "very_good" },
    { date: addDays(TODAY, -4), mood: "good" },
    { date: addDays(TODAY, -3), mood: "low" },
    { date: addDays(TODAY, -2), mood: "neutral" },
    { date: addDays(TODAY, -1), mood: "good" },
  ],
  notices: [
    {
      date: addDays(TODAY, -4),
      text: "8月の三者面談の日程調整を開始しました。担任までご希望をお知らせください。",
      from: "2年A組 担任",
    },
    {
      date: addDays(TODAY, -12),
      text: "夏季休業中の生活リズムについて、保健だよりを配布しました。",
      from: "保健室",
    },
  ],
  scopeNote:
    "学校の運用方針により、保護者の方には日記の提出状況と、お子さま本人が共有に同意した範囲の情報のみを表示しています。日記の本文、AIとの対話内容、AIの分析結果は表示されません。",
};
