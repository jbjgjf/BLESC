"use client";

/**
 * 先生自身の記録（A-1 / A-2 / A-3 / A-5 / A-6）。
 *
 * 気分だけで保存できる。本文は任意で、思いつかないときは質問を1つ出す。
 * 1日1件で、その日のうちは書き直せる。翌日からは読むだけになり、書き直した
 * 履歴は残る。打っているあいだは下書きを端末に残しておく（通信が切れても
 * 書いたものが消えないように）。
 *
 * 誰がこの記録を読めるかは、画面のいちばん上に常に出しておく（設計原則 3）。
 */

import Link from "next/link";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { MOODS, formatDate } from "@/lib/blesc/labels";
import type { Mood } from "@/lib/blesc/types";
import { AS_OF, PROMPTS, TEXT_LIMIT, WORK_TAGS, readersOfTeacherRecords } from "@/lib/teachers/fixtures";
import { useSchoolSettings } from "@/lib/teachers/store";
import type { TeacherRecord, WorkTag } from "@/lib/teachers/types";
import { PageHead, ReadersLine, RoleGate, styles } from "@/components/teachers/parts";

const SAVED_KEY = `blesc:my-record:${AS_OF}`;
const DRAFT_KEY = `blesc:my-draft:${AS_OF}`;
const EVENT = "blesc:my-record";

type Draft = { mood: Mood | null; text: string; tags: WorkTag[]; promptId?: string };
const EMPTY_DRAFT: Draft = { mood: null, text: "", tags: [] };

const now = () => {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/* 今日の記録は、このタブの中（sessionStorage）に。下書きは端末（localStorage）に。 */
let savedRaw: string | null | undefined;
let savedValue: TeacherRecord | null = null;
function readSaved(): TeacherRecord | null {
  let raw: string | null = null;
  try {
    raw = window.sessionStorage.getItem(SAVED_KEY);
  } catch {
    raw = null;
  }
  if (raw === savedRaw) return savedValue;
  savedRaw = raw;
  try {
    savedValue = raw ? (JSON.parse(raw) as TeacherRecord) : null;
  } catch {
    savedValue = null;
  }
  return savedValue;
}
const subscribe = (notify: () => void) => {
  window.addEventListener(EVENT, notify);
  return () => window.removeEventListener(EVENT, notify);
};

function readDraft(): Draft {
  try {
    const raw = window.localStorage.getItem(DRAFT_KEY);
    return raw ? { ...EMPTY_DRAFT, ...(JSON.parse(raw) as Draft) } : EMPTY_DRAFT;
  } catch {
    return EMPTY_DRAFT;
  }
}

export default function MyRecordTodayPage() {
  return (
    <RoleGate allow={["homeroom", "manager"]}>
      <MyRecordToday />
    </RoleGate>
  );
}

function MyRecordToday() {
  const settings = useSchoolSettings();
  const readers = readersOfTeacherRecords(settings);
  const saved = useSyncExternalStore(subscribe, readSaved, () => null);

  // 下書きは最初の描画のあとで読む（サーバーの HTML と食い違わないように）。
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [loaded, setLoaded] = useState(false);
  const [draftAt, setDraftAt] = useState<string | null>(null);
  const [promptIndex, setPromptIndex] = useState(0);

  useEffect(() => {
    const restored = saved ? { mood: saved.mood, text: saved.text, tags: saved.tags, promptId: saved.promptId } : readDraft();
    const timer = window.setTimeout(() => {
      setDraft(restored);
      setLoaded(true);
    }, 0);
    return () => window.clearTimeout(timer);
    // 開いたときに一度だけ戻す。保存のたびに打ちかけを上書きしない。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 打つたびに下書きを残す（少し待ってからまとめて）。
  useEffect(() => {
    if (!loaded) return;
    const timer = window.setTimeout(() => {
      try {
        window.localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
        setDraftAt(now());
      } catch {
        // 端末に残せない環境では、下書きの表示を出さないだけ。
      }
    }, 600);
    return () => window.clearTimeout(timer);
  }, [draft, loaded]);

  const prompt = PROMPTS[promptIndex % PROMPTS.length];
  const length = [...draft.text].length;
  const over = length > TEXT_LIMIT;
  const changed = useMemo(
    () => !saved || saved.mood !== draft.mood || saved.text !== draft.text || saved.tags.join() !== draft.tags.join(),
    [saved, draft],
  );

  const save = () => {
    if (!draft.mood || over) return;
    const record: TeacherRecord = {
      date: AS_OF,
      mood: draft.mood,
      text: draft.text.trim(),
      tags: draft.tags,
      promptId: draft.text.trim() ? draft.promptId : undefined,
      edits: [...(saved?.edits ?? []), now()],
    };
    try {
      window.sessionStorage.setItem(SAVED_KEY, JSON.stringify(record));
      window.localStorage.removeItem(DRAFT_KEY);
    } catch {
      // 保存できない環境でも、画面の上では保存した状態にする。
    }
    window.dispatchEvent(new Event(EVENT));
  };

  return (
    <div className={styles.page}>
      <PageHead
        kicker="先生自身の記録"
        title={`${formatDate(AS_OF)}の記録`}
        lede="気分を選ぶだけでも保存できます。書きたいことがあれば、ひとことでも。"
      >
        <ReadersLine readers={readers} />
      </PageHead>

      <section className={styles.section} aria-labelledby="mood-label">
        <h2 id="mood-label" className={styles.fieldLabel}>
          今日の気分<span className={styles.required}>必須</span>
        </h2>
        <div className={styles.moodRow} role="group" aria-labelledby="mood-label">
          {MOODS.map((mood) => (
            <button
              key={mood.value}
              type="button"
              className={styles.moodOption}
              aria-pressed={draft.mood === mood.value}
              onClick={() => setDraft((d) => ({ ...d, mood: mood.value }))}
            >
              <span className={styles.moodDot} style={{ background: mood.color }} aria-hidden="true" />
              {mood.label}
            </button>
          ))}
        </div>
      </section>

      <section className={styles.section} data-bl-term="今日のこと">
        <label htmlFor="body" className={styles.fieldLabel}>
          今日のこと<span className={styles.required}>任意・{TEXT_LIMIT.toLocaleString()}字まで</span>
        </label>
        {draft.text.trim() === "" && (
          <p className={styles.prompt}>
            <span>{prompt.text}</span>
            <button type="button" className={styles.linkButton} onClick={() => setPromptIndex((i) => i + 1)}>
              別の質問にする
            </button>
          </p>
        )}
        <textarea
          id="body"
          className={styles.textarea}
          value={draft.text}
          placeholder={draft.text.trim() === "" ? "質問に答えてもいいし、ほかのことでも。" : undefined}
          onChange={(event) => {
            const text = event.target.value;
            // 書き始めた瞬間に出ていた質問を、その回答の紐づけとして持っておく（A-2）。
            setDraft((d) => ({ ...d, text, promptId: d.text.trim() === "" && text.trim() !== "" ? prompt.id : d.promptId }));
          }}
          aria-describedby="body-count"
        />
        <span id="body-count" className={styles.counter} style={over ? { color: "var(--bl-alert-ink)" } : undefined}>
          {length.toLocaleString()} / {TEXT_LIMIT.toLocaleString()}字{over ? "（多すぎます）" : ""}
        </span>
        {draft.promptId && draft.text.trim() && (
          <p className={styles.note}>
            質問「{PROMPTS.find((p) => p.id === draft.promptId)?.text}」への回答として保存します。
          </p>
        )}
      </section>

      <section className={styles.section} aria-labelledby="tags-label">
        <h2 id="tags-label" className={styles.fieldLabel}>
          今日の業務<span className={styles.required}>任意・いくつでも</span>
        </h2>
        <div className={styles.tagRow} role="group" aria-labelledby="tags-label">
          {WORK_TAGS.map((tag) => (
            <button
              key={tag.value}
              type="button"
              className={styles.tagOption}
              aria-pressed={draft.tags.includes(tag.value)}
              onClick={() =>
                setDraft((d) => ({
                  ...d,
                  tags: d.tags.includes(tag.value) ? d.tags.filter((t) => t !== tag.value) : [...d.tags, tag.value],
                }))
              }
            >
              {tag.label}
            </button>
          ))}
        </div>
        <p className={styles.note}>選んだ業務は、管理職が業務の偏りを本人の申告どおりに見るためだけに使います。自動で分類はしません。</p>
      </section>

      <section className={styles.section}>
        <div className={styles.saveRow}>
          <button type="button" className="bl-btn bl-btn--primary" onClick={save} disabled={!draft.mood || over || !changed}>
            {saved ? "書き直して保存" : "保存"}
          </button>
          <span className={styles.status} aria-live="polite">
            {saved
              ? `保存済み（${saved.edits.at(-1)}）。今日のうちは書き直せます。${saved.edits.length > 1 ? `書き直し ${saved.edits.length - 1}回。` : ""}`
              : draft.mood === null
                ? "気分を選ぶと保存できます。"
                : draftAt
                  ? `下書きを端末に保存しました（${draftAt}）`
                  : ""}
          </span>
        </div>
        <p className={styles.note}>
          明日からは読むだけになり、書き直した履歴が残ります。過去の記録は
          <Link href="/educator/my-records" className={styles.linkButton} style={{ marginLeft: 4 }}>
            振り返り
          </Link>
          で見られます。
        </p>
      </section>

      <section className={styles.section}>
        <h2 className={styles.h2}>お知らせ</h2>
        <p className={styles.note}>
          {settings.reminder.enabled
            ? `帰りのHRの時間（${settings.reminder.time}）に、1日1回だけお知らせします。`
            : "記録のお知らせは、学校の設定で止めてあります。"}
          記録しない日が続いても、管理職に知らせることはありません。
        </p>
      </section>
    </div>
  );
}
