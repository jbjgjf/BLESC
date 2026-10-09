"use client";

/**
 * 一人ぶんの画面（UI仕様書 5-2 / 5-3 / 6-2）。タブは「記録」「推移」「面談」。
 *
 *  - 記録：新しい日が上。本文はそのまま全文を出し、要約やハイライトはしない。
 *  - 推移：気分は折れ線ではなく、日ごとの顔を並べた帯。タグは回数。
 *    点数・平均値・順位は出さない。
 *  - 面談：面談前の要約・次の面談予定日・面談メモ。メモは本人には見えない。
 */

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { MOOD_BY_VALUE, formatDate } from "@/lib/blesc/labels";
import type { Mood } from "@/lib/blesc/types";
import { AS_OF, WORK_RELATED } from "@/lib/teachers/fixtures";
import { SUMMARY_RULE, addDays, buildSummary, summaryViolations, weekStart } from "@/lib/teachers/records";
import { addMemo, setMeetingPlan, useMeetingPlans, useMemos, usePersona } from "@/lib/teachers/store";
import type { Kind, Person } from "./PeopleScreen";
import { MoodMark, PageHead, RecordItem, styles, tagLabel } from "./parts";

type Href = (next: Record<string, string | null>) => string;

const TABS = [
  { value: "records", label: "記録" },
  { value: "trend", label: "推移" },
  { value: "meeting", label: "面談" },
] as const;

export function PersonDetail({ kind, person, tab, focusDate, hrefWith }: { kind: Kind; person: Person; tab: string; focusDate: string | null; hrefWith: Href }) {
  const current = TABS.some((t) => t.value === tab) ? tab : "records";
  return (
    <>
      <PageHead kicker={person.sub} title={person.name} />
      <nav className={styles.tabs} aria-label="表示">
        {TABS.map((t) => (
          <Link
            key={t.value}
            href={hrefWith({ p: person.id, tab: t.value === "records" ? null : t.value })}
            className={styles.tab}
            data-active={current === t.value}
            aria-current={current === t.value ? "page" : undefined}
            style={{ display: "inline-flex", alignItems: "center", textDecoration: "none" }}
            scroll={false}
            data-bl-term={t.label === "面談" ? "面談" : undefined}
          >
            {t.label}
          </Link>
        ))}
      </nav>
      {current === "records" && <RecordsTab person={person} focusDate={focusDate} />}
      {current === "trend" && <TrendTab person={person} />}
      {current === "meeting" && <MeetingTab kind={kind} person={person} hrefWith={hrefWith} />}
    </>
  );
}

/* ── 記録 ─────────────────────────────────────────── */

const PERIODS = [
  { value: 7, label: "1週" },
  { value: 30, label: "1か月" },
  { value: 90, label: "3か月" },
  { value: 0, label: "全期間" },
] as const;

function RecordsTab({ person, focusDate }: { person: Person; focusDate: string | null }) {
  const [days, setDays] = useState<number>(focusDate ? 0 : 30);
  const from = days === 0 ? "0000-00-00" : addDays(AS_OF, -(days - 1));
  const shown = [...person.records].filter((r) => r.date >= from).reverse();

  // 本人の言葉から来たときは、その日の記録まで送る。
  useEffect(() => {
    if (!focusDate) return;
    document.getElementById(`rec-${focusDate}`)?.scrollIntoView({ block: "center" });
  }, [focusDate]);

  return (
    <section className={styles.head} aria-label="記録">
      <div className={styles.segmented} role="group" aria-label="期間">
        {PERIODS.map((p) => (
          <button key={p.value} type="button" className={styles.chip} aria-pressed={days === p.value} onClick={() => setDays(p.value)}>
            {p.label}
          </button>
        ))}
      </div>
      {shown.length === 0 ? (
        <p className={styles.note}>この期間の記録はありません。</p>
      ) : (
        <ol className={styles.records}>
          {shown.map((record) => (
            <RecordItem key={record.date} record={record} target={record.date === focusDate} />
          ))}
        </ol>
      )}
    </section>
  );
}

/* ── 推移 ─────────────────────────────────────────── */

const WEEKS = 8;
const WEEKDAYS = ["月", "火", "水", "木", "金"];

function TrendTab({ person }: { person: Person }) {
  const byDate = new Map(person.records.map((r) => [r.date, r.mood]));
  const firstMonday = addDays(weekStart(AS_OF), -7 * (WEEKS - 1));
  const weeks = Array.from({ length: WEEKS }, (_, w) => addDays(firstMonday, w * 7));
  const counts = new Map<string, number>();
  for (const record of person.records) {
    if (record.date < firstMonday) continue;
    for (const tag of record.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  const ordered = [...counts.entries()].sort((a, b) => b[1] - a[1]);

  return (
    <>
      <section className={styles.head} aria-labelledby="band-title">
        <h2 id="band-title" className={styles.h2}>
          気分（直近{WEEKS}週）
        </h2>
        <div className={styles.band} role="table" aria-label={`気分の帯（直近${WEEKS}週）`}>
          <span role="columnheader" />
          {WEEKDAYS.map((w) => (
            <span key={w} role="columnheader" className={styles.bandHead}>
              {w}
            </span>
          ))}
          {weeks.map((monday) => (
            <BandRow key={monday} monday={monday} byDate={byDate} />
          ))}
        </div>
        <p className={styles.note}>記録のない日は点線の丸です。点数や平均には直していません。</p>
      </section>

      <section className={styles.section} aria-labelledby="counts-title">
        <h2 id="counts-title" className={styles.h2}>
          タグの回数（直近{WEEKS}週）
        </h2>
        {ordered.length === 0 ? (
          <p className={styles.note}>タグの付いた記録はありません。</p>
        ) : (
          <p className={styles.counts}>{ordered.map(([tag, count]) => `${tagLabel(tag)} ${count}回`).join("・")}</p>
        )}
      </section>
    </>
  );
}

function BandRow({ monday, byDate }: { monday: string; byDate: Map<string, Mood> }) {
  return (
    <>
      <span role="rowheader" className={styles.bandLabel}>
        {formatDate(monday, false)}〜
      </span>
      {WEEKDAYS.map((_, i) => {
        const date = addDays(monday, i);
        const mood = byDate.get(date);
        return (
          <span key={date} role="cell" title={`${formatDate(date)}・${mood ? MOOD_BY_VALUE[mood].label : date > AS_OF ? "" : "記録なし"}`} style={{ display: "grid", placeItems: "center" }}>
            {mood ? (
              <MoodMark mood={mood} size={24} />
            ) : date > AS_OF ? null : (
              <span className={styles.moodEmpty} style={{ width: 18, height: 18 }} aria-label="記録なし" />
            )}
          </span>
        );
      })}
    </>
  );
}

/* ── 面談 ─────────────────────────────────────────── */

function MeetingTab({ kind, person, hrefWith }: { kind: Kind; person: Person; hrefWith: Href }) {
  const persona = usePersona();
  const plans = useMeetingPlans(persona.id);
  const memos = useMemos(persona.id, person.id);
  const [made, setMade] = useState(false);
  const [writing, setWriting] = useState(false);
  const who = kind === "student" ? "生徒" : "先生";

  return (
    <>
      <section className={styles.head} aria-labelledby="summary-title">
        <h2 id="summary-title" className={styles.h2} data-bl-term="面談前の要約">
          面談前の要約
        </h2>
        {made ? (
          <SummaryBlock kind={kind} person={person} hrefWith={hrefWith} />
        ) : (
          <div className={styles.row}>
            <button type="button" className={`${styles.button} ${styles.primary}`} onClick={() => setMade(true)}>
              <Icon name="auto_awesome" size={18} />
              要約を作る
            </button>
            <span className={styles.note}>直近2か月の記録から作ります。</span>
          </div>
        )}
      </section>

      <section className={styles.section} aria-labelledby="plan-title">
        <h2 id="plan-title" className={styles.h2}>
          次の面談予定日
        </h2>
        <div className={styles.row}>
          <input
            type="date"
            className={styles.input}
            value={plans[person.id] ?? ""}
            min={AS_OF}
            onChange={(e) => setMeetingPlan(persona.id, person.id, e.target.value)}
            aria-label="次の面談予定日"
          />
          {plans[person.id] && (
            <button type="button" className={styles.linkButton} onClick={() => setMeetingPlan(persona.id, person.id, "")}>
              予定を消す
            </button>
          )}
        </div>
        <p className={styles.note}>入力すると一覧に出ます。前日に、あなたにだけお知らせします（設定で止められます）。</p>
      </section>

      <section className={styles.section} aria-labelledby="memo-title">
        <div className={styles.row}>
          <h2 id="memo-title" className={styles.h2}>
            面談メモ
          </h2>
          <span className={styles.spacer} />
          {!writing && (
            <button type="button" className={styles.button} onClick={() => setWriting(true)}>
              <Icon name="edit_note" size={18} />
              面談を記録
            </button>
          )}
        </div>
        <p className={styles.note}>
          面談メモは{who}本人には見えません。
          {kind === "student" ? "担任が替わるときは、新しい担任に引き継がれます（学校の設定）。" : ""}
        </p>
        {writing && <MemoForm subjectId={person.id} onDone={() => setWriting(false)} />}
        {memos.length === 0 ? (
          <p className={styles.note}>まだ面談メモはありません。</p>
        ) : (
          <ol className={styles.records}>
            {memos.map((memo) => (
              <li key={memo.id} className={styles.record}>
                <span className={styles.recordDate}>{formatDate(memo.date)}</span>
                <div className={styles.recordBody}>
                  <p className={styles.recordText}>{memo.body}</p>
                  {memo.nextCheck && (
                    <p className={styles.recordQuestion}>
                      <strong style={{ fontWeight: 600 }}>次回確認すること</strong>　{memo.nextCheck}
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>
    </>
  );
}

function SummaryBlock({ kind, person, hrefWith }: { kind: Kind; person: Person; hrefWith: Href }) {
  const summary = useMemo(
    () =>
      buildSummary(person.records, {
        asOf: AS_OF,
        moodLabel: (mood) => MOOD_BY_VALUE[mood].label,
        workTags: kind === "teacher" ? (WORK_RELATED as readonly string[]) : [],
      }),
    [person.records, kind],
  );
  if (!summary) return <p className={styles.lede}>記録が{SUMMARY_RULE.minRecords}日分未満のため要約できません。記録をそのままご覧ください。</p>;

  // AI が書く文は、出す前に検査する（診断・推測・評価・助言の言い回しを止める）。
  const flowOk = summaryViolations(summary.moodFlow, person.records).length === 0;

  return (
    <div className={styles.summary}>
      <p className={styles.aiNote}>
        <Icon name="auto_awesome" size={17} />
        AIによる要約です。元の記録もご確認ください
      </p>

      <div className={styles.head}>
        <h3 className={styles.h3}>よく出てくる話題</h3>
        <p className={styles.counts}>{summary.topics.map((t) => `${tagLabel(t.tag)} ${t.count}回`).join("・")}</p>
      </div>

      <div className={styles.head}>
        <h3 className={styles.h3}>気分の流れ</h3>
        <p className={styles.recordText}>{flowOk ? summary.moodFlow : "表示できる文がありませんでした。記録をそのままご覧ください。"}</p>
      </div>

      <div className={styles.head}>
        <h3 className={styles.h3}>本人の言葉</h3>
        {summary.quotes.length === 0 ? (
          <p className={styles.note}>本文のある記録がありません。</p>
        ) : (
          summary.quotes.map((quote) => (
            <Link key={quote.date} href={hrefWith({ p: person.id, d: quote.date })} className={styles.quote} style={{ textDecoration: "none" }}>
              <span className={styles.quoteDate}>{formatDate(quote.date)}の記録</span>「{quote.text}」
            </Link>
          ))
        )}
      </div>

      {kind === "teacher" && (
        <div className={styles.head}>
          <h3 className={styles.h3}>業務に関する記述</h3>
          {summary.work.length === 0 ? (
            <p className={styles.note}>業務量・校務・保護者対応のタグが付いた記述はありません。</p>
          ) : (
            <ol className={styles.records}>
              {summary.work.map((item) => (
                <li key={item.date} className={styles.record}>
                  <span className={styles.recordDate}>{formatDate(item.date)}</span>
                  <div className={styles.recordBody}>
                    <span className={styles.tag}>{item.tags.map((t) => `#${tagLabel(t)}`).join(" ")}</span>
                    <p className={styles.recordText}>{item.text}</p>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}

      <p className={styles.note}>デモでは、AIの代わりに決まった形の文で作っています。</p>
    </div>
  );
}

function MemoForm({ subjectId, onDone }: { subjectId: string; onDone: () => void }) {
  const persona = usePersona();
  const [date, setDate] = useState(AS_OF);
  const [body, setBody] = useState("");
  const [nextCheck, setNextCheck] = useState("");
  return (
    <form
      className={styles.form}
      onSubmit={(event) => {
        event.preventDefault();
        if (!body.trim()) return;
        addMemo({ id: `m-${Date.now()}`, subjectId, date, body: body.trim(), nextCheck: nextCheck.trim(), author: persona.id });
        onDone();
      }}
    >
      <label className={styles.field}>
        <span className={styles.fieldLabel}>日付</span>
        <input type="date" className={styles.input} value={date} max={AS_OF} onChange={(e) => setDate(e.target.value)} style={{ maxWidth: 220 }} />
      </label>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>メモ</span>
        <textarea className={styles.textarea} value={body} onChange={(e) => setBody(e.target.value)} />
      </label>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>次回確認すること</span>
        <input className={styles.input} value={nextCheck} onChange={(e) => setNextCheck(e.target.value)} />
      </label>
      <div className={styles.row}>
        <button type="submit" className={`${styles.button} ${styles.primary}`} disabled={!body.trim()}>
          保存
        </button>
        <button type="button" className={styles.button} onClick={onDone}>
          やめる
        </button>
      </div>
    </form>
  );
}
