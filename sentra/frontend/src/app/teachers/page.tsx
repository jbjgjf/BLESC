"use client";

/**
 * 自分の記録・今日を書く（UI仕様書 4-1 / 4-2）。
 *
 * 生徒の日記（3-1）と同じ組み立てで、違うのは問いかけ・タグ・言葉づかいだけ。
 * 「同じものを書いている」実感を作るため。必須は気分だけで、記録を
 * 読める人は保存ボタンのすぐ上にいつも出しておく。
 *
 * 保存後は「記録しました。また明日」を1.5秒出し、今日の記録の表示に
 * 切り替える。その日のうちは「編集」で書き直せる。継続日数・バッジは出さない。
 * 書き忘れた日は2日前までさかのぼれる。催促のお知らせは送らない。
 */

import { useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { TransitionLink } from "@/components/ui/Transition";
import { MOODS, formatDate } from "@/lib/blesc/labels";
import type { Mood } from "@/lib/blesc/types";
import { AS_OF, TEACHER_QUESTIONS, WORK_TAGS, readersOfStaff, staffById } from "@/lib/teachers/fixtures";
import { addDays, isSchoolDay } from "@/lib/teachers/records";
import { draftKey, readRaw, saveWrittenRecord, usePersona, useWrittenRecords, writeRaw } from "@/lib/teachers/store";
import type { Persona, TeacherRecord, WorkTag } from "@/lib/teachers/types";
import { AccessGate, MoodWithLabel, ReadersLine, styles, tagLabel } from "@/components/teachers/parts";
import { OwnTabs } from "@/components/teachers/OwnTabs";

const LIMIT = 400;
const SHOW_REST_AFTER = 350;
const PROMISE = "人事評価・勤務評定には使われません";

const now = () => {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

export default function TodayPage() {
  return (
    <AccessGate need="write">
      <Today />
    </AccessGate>
  );
}

function Today() {
  const persona = usePersona();
  // 立場を切り替えたら、書きかけの状態ごと作り直す。
  return <Writer key={persona.id} persona={persona} />;
}

function Writer({ persona }: { persona: Persona }) {
  const me = staffById(persona.staffId);
  const written = useWrittenRecords(persona.id);
  const [date, setDate] = useState(AS_OF);
  const [editing, setEditing] = useState(false);
  const [flash, setFlash] = useState(false);

  const recorded = useMemo(() => new Set([...(me?.records ?? []).map((r) => r.date), ...Object.keys(written)]), [me, written]);
  // さかのぼれるのは2日前まで（登校日だけ）。それより前は空白のまま。
  const backfill = [1, 2].map((n) => addDays(AS_OF, -n)).filter((d) => isSchoolDay(d) && !recorded.has(d));
  const firstDay = (me?.records.length ?? 0) === 0 && Object.keys(written).length === 0;

  if (!me) return null;
  const readers = readersOfStaff(me.id);
  const saved = written[date] ?? null;
  const showForm = flash || !saved || editing;

  return (
    <div className={`${styles.page} ${styles.narrow}`}>
      <OwnTabs />

      {firstDay && (
        <p className={styles.lede}>
          はじめまして。毎日の帰りのHRで、今日のことを一言だけ書きます。生徒と同じ時間に、先生もご自身の記録を書きます。
        </p>
      )}

      {date === AS_OF && backfill.length > 0 && (
        <div className={styles.backfill}>
          {backfill.map((d) => (
            <span key={d} className={styles.row} style={{ gap: 10 }}>
              {d === addDays(AS_OF, -1) ? "昨日" : formatDate(d)}の分も書けます
              <button type="button" className={styles.linkButton} onClick={() => setDate(d)}>
                書く
              </button>
            </span>
          ))}
        </div>
      )}

      {date !== AS_OF && (
        <button type="button" className={styles.linkButton} style={{ alignSelf: "flex-start" }} onClick={() => setDate(AS_OF)}>
          <Icon name="arrow_back" size={18} />
          今日の記録に戻る
        </button>
      )}

      {showForm ? (
        <Form
          key={`${date}-${editing ? "edit" : "new"}`}
          persona={persona}
          date={date}
          readers={readers}
          existing={saved}
          onSaved={() => {
            setFlash(true);
            window.setTimeout(() => {
              setFlash(false);
              setEditing(false);
            }, 1500);
          }}
        />
      ) : (
        <ReadView record={saved} readers={readers} onEdit={() => setEditing(true)} />
      )}

      {flash && (
        <div className={styles.saved} role="status">
          <span className={styles.savedText}>記録しました。また明日</span>
        </div>
      )}
    </div>
  );
}

type Draft = { mood: Mood | null; tags: WorkTag[]; text: string; question: number | null };

function Form({
  persona,
  date,
  readers,
  existing,
  onSaved,
}: {
  persona: Persona;
  date: string;
  readers: Array<{ name: string; title: string }>;
  existing: TeacherRecord | null;
  onSaved: () => void;
}) {
  const initial: Draft = existing
    ? {
        mood: existing.mood,
        tags: existing.tags,
        text: existing.text,
        question: existing.question ? Math.max(0, TEACHER_QUESTIONS.indexOf(existing.question as (typeof TEACHER_QUESTIONS)[number])) : null,
      }
    : { mood: null, tags: [], text: "", question: null };
  const [draft, setDraft] = useState<Draft>(initial);
  const [restored, setRestored] = useState(existing !== null);
  // 開いたときに書き直しだったかどうか。保存した直後に呼び名が変わらないように。
  const [rewriting] = useState(existing !== null);
  const [failed, setFailed] = useState(false);
  const key = draftKey(persona.id, date);

  // 書きかけを戻す（最初の描画のあとで。サーバーの HTML と食い違わないように）。
  useEffect(() => {
    if (existing) return;
    const timer = window.setTimeout(() => {
      try {
        const raw = readRaw("local", key);
        if (raw) setDraft((d) => ({ ...d, ...(JSON.parse(raw) as Draft) }));
      } catch {
        // 読めない下書きは捨てる。
      }
      setRestored(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [existing, key]);

  // 打つたびに端末へ残す（通信が切れても消えないように）。
  useEffect(() => {
    if (!restored || existing) return;
    const timer = window.setTimeout(() => writeRaw("local", key, JSON.stringify(draft)), 500);
    return () => window.clearTimeout(timer);
  }, [draft, restored, existing, key]);

  const length = [...draft.text].length;
  const today = date === AS_OF;

  const save = () => {
    if (!draft.mood) return;
    const text = draft.text.trim();
    const record: TeacherRecord = {
      date,
      time: now(),
      mood: draft.mood,
      tags: draft.tags,
      text,
      ...(draft.question !== null && text ? { question: TEACHER_QUESTIONS[draft.question] } : {}),
    };
    if (!saveWrittenRecord(persona.id, record)) {
      setFailed(true);
      return;
    }
    setFailed(false);
    writeRaw("local", key, null);
    onSaved();
  };

  return (
    <>
      <header className={styles.head}>
        <div className={styles.row}>
          <p className={styles.date}>{formatDate(date)}</p>
          <span className={styles.spacer} />
          {/* スマホでは上のタブを畳むので、これまでへの入口をここに置く。 */}
          <TransitionLink href="/teachers/my-records" className={`${styles.linkButton} ${styles.mobileOnly}`}>
            これまで
            <Icon name="chevron_right" size={18} />
          </TransitionLink>
        </div>
        <h1 className={styles.ask}>{today ? "今日はいかがでしたか" : `${formatDate(date)}はいかがでしたか`}</h1>
      </header>

      <div className={styles.moodRow} role="group" aria-label="気分（必須）">
        {MOODS.map((mood) => {
          const selected = draft.mood === mood.value;
          return (
            <button
              key={mood.value}
              type="button"
              className={styles.moodOption}
              aria-pressed={selected}
              onClick={() => setDraft((d) => ({ ...d, mood: mood.value }))}
            >
              <span className={styles.moodFace} style={selected ? { background: mood.color } : undefined}>
                <Icon name={mood.icon} size={32} fill={selected} weight={selected ? 500 : 400} />
              </span>
              {mood.label}
            </button>
          );
        })}
      </div>

      <section className={styles.section} aria-labelledby="tags-label">
        <h2 id="tags-label" className={styles.fieldLabel}>
          テーマ<span className={styles.optional}>任意・いくつでも</span>
        </h2>
        <div className={styles.tagRow}>
          {WORK_TAGS.map((tag) => (
            <button
              key={tag.value}
              type="button"
              className={styles.chip}
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
      </section>

      <section className={styles.section} data-bl-term="今日のこと">
        <div className={styles.row} style={{ justifyContent: "space-between", rowGap: 0 }}>
          <label htmlFor="body" className={styles.fieldLabel}>
            今日のこと<span className={styles.optional}>任意</span>
          </label>
          {draft.question === null && (
            <button type="button" className={styles.linkButton} onClick={() => setDraft((d) => ({ ...d, question: 0 }))}>
              書くことが思いつかないとき
            </button>
          )}
        </div>
        {draft.question === null ? null : (
          <p className={styles.question}>
            {TEACHER_QUESTIONS[draft.question]}
            <button
              type="button"
              className={styles.linkButton}
              onClick={() => setDraft((d) => ({ ...d, question: ((d.question ?? 0) + 1) % TEACHER_QUESTIONS.length }))}
            >
              別の質問
            </button>
          </p>
        )}
        <textarea
          id="body"
          className={styles.textarea}
          value={draft.text}
          maxLength={LIMIT}
          placeholder="一言でも構いません。今日あったこと、感じたこと"
          onChange={(event) => setDraft((d) => ({ ...d, text: event.target.value }))}
        />
        {length > SHOW_REST_AFTER && <span className={styles.counter}>残り{LIMIT - length}字</span>}
        {draft.question !== null && draft.text.trim() && <p className={styles.note}>質問は記録と一緒に保存され、記録を読める人にも見えます。</p>}
      </section>

      {/* 保存ボタンの帯。ボタンのすぐ上に、読める人をいつも出す。 */}
      <div className={styles.saveBar} data-bl-fixed-action="">
        <div className={styles.saveInner}>
          <ReadersLine readers={readers} />
          <p className={styles.promise}>{PROMISE}</p>
          {failed && (
            <p className={styles.note} role="alert">
              保存できませんでした。内容はこの端末に残っています。
              <button type="button" className={styles.linkButton} onClick={save} style={{ marginLeft: 8 }}>
                もう一度
              </button>
            </p>
          )}
          <button type="button" className={`${styles.button} ${styles.primary} ${styles.saveButton}`} disabled={!draft.mood} onClick={save}>
            {rewriting ? "書き直して保存" : "保存"}
          </button>
        </div>
      </div>
    </>
  );
}

function ReadView({ record, readers, onEdit }: { record: TeacherRecord; readers: Array<{ name: string; title: string }>; onEdit: () => void }) {
  const today = record.date === AS_OF;
  return (
    <section className={styles.head} aria-labelledby="saved-title">
      <p className={styles.date}>{formatDate(record.date)}</p>
      <h1 id="saved-title" className={styles.title}>
        {today ? "今日の記録" : `${formatDate(record.date)}の記録`}
      </h1>
      <div className={styles.recordBody} style={{ gap: 14, marginTop: 10 }}>
        <div className={styles.recordMeta}>
          <MoodWithLabel mood={record.mood} />
          {record.tags.map((tag) => (
            <span key={tag} className={styles.tag}>
              #{tagLabel(tag)}
            </span>
          ))}
        </div>
        {record.question && record.text && <p className={styles.recordQuestion}>質問「{record.question}」に答えて</p>}
        {record.text ? <p className={styles.recordText}>{record.text}</p> : <p className={styles.note}>（気分だけの記録）</p>}
        <div className={styles.row}>
          <button type="button" className={styles.button} onClick={onEdit}>
            <Icon name="edit" size={18} />
            編集
          </button>
          <span className={styles.note}>{today ? "今日の23:59まで書き直せます。" : "この記録は今日の23:59まで書き直せます。"}</span>
        </div>
        <ReadersLine readers={readers} />
        <p className={styles.promise}>{PROMISE}</p>
      </div>
    </section>
  );
}
