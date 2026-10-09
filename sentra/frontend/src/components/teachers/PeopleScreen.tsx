"use client";

/**
 * 先生の画面（UI仕様書 6章）。学年主任・教頭・校長が、読める範囲の先生の
 * 記録を読む。
 *
 *  - 見出し：読める範囲。教頭・校長は学年・教科で絞りこめる。
 *  - 今日の記録状況：人数だけ。誰が未記録かは出さない。
 *  - 変化があった先生：この画面の主役。五十音順で、良い方向の変化も
 *    同じ扱い。深刻度順にはしない。
 *  - 全員の一覧：五十音順。名前で探せる。
 *
 * 一人を選ぶと、PC では左に一覧・右に詳細の2分割になる（8-5）。
 * どの人を開いているかは URL（?p=）に持つ。
 *
 * 生徒の記録はここでは扱わない。生徒を読むのは Blesc の教員の画面（/educator）。
 */

import Link from "next/link";
import { useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Icon } from "@/components/ui/Icon";
import { formatDate } from "@/lib/blesc/labels";
import { AS_OF, dutyOf, staffById } from "@/lib/teachers/fixtures";
import { addDays, describeChange, detectChanges, isSchoolDay, weekStart, type ChangeResult } from "@/lib/teachers/records";
import { setWeeklyCheck, useMeetingPlans, useNoticePrefs, usePersona, useWeeklyCheck } from "@/lib/teachers/store";
import type { SelfRecord } from "@/lib/teachers/types";
import { Forbidden, LastRecord, MoodStrip, NoExport, PageHead, styles, tagLabel } from "./parts";
import { PersonDetail } from "./PersonDetail";

export type Person = {
  id: string;
  name: string;
  /** 担当（「2年3組担任・英語」） */
  sub: string;
  kana: string;
  grade: number | null;
  subject: string | null;
  records: ReadonlyArray<SelfRecord>;
};

const BASE = "/teachers/staff";

/** 次の登校日。面談前日のお知らせ（5-3）に使う。 */
function nextSchoolDay(from: string): string {
  let date = addDays(from, 1);
  while (!isSchoolDay(date)) date = addDays(date, 1);
  return date;
}

export function PeopleScreen() {
  const persona = usePersona();
  const params = useSearchParams();
  const teachers = persona.access.teachers;

  const gradeFilter = params.get("g") ?? "";
  const subjectFilter = params.get("sub") ?? "";
  const filterable = teachers?.label === "全教職員";

  const everyone: Person[] = useMemo(() => {
    if (!teachers) return [];
    return teachers.staffIds
      .map((id) => staffById(id))
      .filter((m) => m !== null)
      .map((m) => ({
        id: m.id,
        name: m.name,
        sub: dutyOf(m),
        kana: m.kana,
        grade: m.grade,
        subject: m.subject,
        records: m.records,
      }))
      .sort((a, b) => a.kana.localeCompare(b.kana, "ja"));
  }, [teachers]);

  const people = useMemo(
    () =>
      everyone.filter(
        (p) =>
          (!gradeFilter || (gradeFilter === "none" ? p.grade === null : String(p.grade) === gradeFilter)) &&
          (!subjectFilter || p.subject === subjectFilter),
      ),
    [everyone, gradeFilter, subjectFilter],
  );

  if (!teachers) return <Forbidden />;

  /** 絞りこみを保ったまま、URL の一部を変える。 */
  const hrefWith = (next: Record<string, string | null>) => {
    const search = new URLSearchParams();
    const keep = { g: gradeFilter || null, sub: subjectFilter || null };
    for (const [key, value] of Object.entries({ ...keep, ...next })) if (value) search.set(key, value);
    const query = search.toString();
    return `${BASE}${query ? `?${query}` : ""}`;
  };

  const selectedId = params.get("p");
  if (selectedId) {
    const person = people.find((p) => p.id === selectedId) ?? everyone.find((p) => p.id === selectedId);
    if (!person) return <Forbidden />;
    return (
      <NoExport>
        <div className={styles.split}>
          <aside className={styles.splitList} aria-label="一覧">
            <MiniList people={people} selectedId={person.id} hrefWith={hrefWith} />
          </aside>
          <div className={styles.page} style={{ minWidth: 0 }}>
            <Link href={hrefWith({})} className={`${styles.linkButton} ${styles.backLink}`} style={{ alignSelf: "flex-start" }}>
              <Icon name="arrow_back" size={18} />
              一覧に戻る
            </Link>
            <PersonDetail key={person.id} person={person} tab={params.get("tab") ?? "records"} focusDate={params.get("d")} hrefWith={hrefWith} />
          </div>
        </div>
      </NoExport>
    );
  }

  return (
    <NoExport>
      <div className={styles.page}>
        <PageHead kicker="先生の記録" title={`${teachers.label}（${everyone.length}名）`}>
          {filterable && <TeacherFilters everyone={everyone} grade={gradeFilter} subject={subjectFilter} hrefWith={hrefWith} />}
          <p className={styles.today}>
            今日 <strong>{people.filter((p) => p.records.some((r) => r.date === AS_OF)).length}</strong> / {people.length}名
          </p>
        </PageHead>

        <MeetingNotice people={people} hrefWith={hrefWith} />
        <Changes people={people} scopeKey={`teacher:staff:${gradeFilter}:${subjectFilter}`} hrefWith={hrefWith} />
        <Everyone people={people} hrefWith={hrefWith} />
      </div>
    </NoExport>
  );
}

/* ── 学年・教科の絞りこみ（教頭・校長） ─────────────── */

function TeacherFilters({
  everyone,
  grade,
  subject,
  hrefWith,
}: {
  everyone: Person[];
  grade: string;
  subject: string;
  hrefWith: (next: Record<string, string | null>) => string;
}) {
  const router = useRouter();
  const subjects = [...new Set(everyone.map((p) => p.subject).filter((s): s is string => Boolean(s)))].sort((a, b) => a.localeCompare(b, "ja"));
  return (
    <div className={styles.row}>
      <label className={styles.row} style={{ gap: 8 }}>
        <span className={styles.small}>学年</span>
        <select className={styles.select} value={grade} onChange={(e) => router.replace(hrefWith({ g: e.target.value || null }))}>
          <option value="">すべて</option>
          {[1, 2, 3].map((g) => (
            <option key={g} value={String(g)}>
              {g}年
            </option>
          ))}
          <option value="none">学年なし</option>
        </select>
      </label>
      <label className={styles.row} style={{ gap: 8 }}>
        <span className={styles.small}>教科</span>
        <select className={styles.select} value={subject} onChange={(e) => router.replace(hrefWith({ sub: e.target.value || null }))}>
          <option value="">すべて</option>
          {subjects.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

/* ── 面談前日のお知らせ（5-3） ─────────────────────── */

function MeetingNotice({ people, hrefWith }: { people: Person[]; hrefWith: (next: Record<string, string | null>) => string }) {
  const persona = usePersona();
  const plans = useMeetingPlans(persona.id);
  const prefs = useNoticePrefs(persona.id);
  if (!prefs.beforeMeeting) return null;
  const day = nextSchoolDay(AS_OF);
  const due = people.filter((p) => plans[p.id] === day);
  if (due.length === 0) return null;
  const when = day === addDays(AS_OF, 1) ? "明日" : formatDate(day);
  return (
    <>
      {due.map((p) => (
        <p key={p.id} className={styles.notice} data-bl-term="面談のお知らせ">
          <Icon name="event_note" size={20} />
          {when}は{p.name}先生の面談です。要約を確認しますか？
          <Link href={hrefWith({ p: p.id, tab: "meeting" })} className={styles.linkButton}>
            要約を確認する
          </Link>
        </p>
      ))}
    </>
  );
}

/* ── 変化があった先生 ─────────────────────────────── */

function Changes({ people, scopeKey, hrefWith }: { people: Person[]; scopeKey: string; hrefWith: (next: Record<string, string | null>) => string }) {
  const persona = usePersona();
  const checked = useWeeklyCheck(persona.id, scopeKey);
  const [peek, setPeek] = useState(false);
  const thisWeek = weekStart(AS_OF);

  const results = useMemo(
    () =>
      people
        .map((p) => ({ person: p, result: detectChanges(p.records, AS_OF, { time: true }) as ChangeResult<string> }))
        .filter((r): r is { person: Person; result: Extract<ChangeResult<string>, { status: "changed" }> } => r.result.status === "changed"),
    [people],
  );

  // 記録がまだ2週間ぶん無い（導入したばかり）。
  const earliest = people.flatMap((p) => p.records.map((r) => r.date)).sort()[0];
  const tooEarly = !earliest || earliest > addDays(AS_OF, -13);
  const done = checked === thisWeek;

  return (
    <section className={styles.section} aria-labelledby="changes-title">
      <div className={styles.row}>
        <h2 id="changes-title" className={styles.h2}>
          変化があった先生
          {!tooEarly && <span className={styles.optional}>{results.length}名</span>}
        </h2>
        <span className={styles.spacer} />
        {!tooEarly && results.length > 0 && !done && (
          <button type="button" className={styles.button} onClick={() => setWeeklyCheck(persona.id, scopeKey, thisWeek)}>
            <Icon name="check" size={18} />
            今週分を確認した
          </button>
        )}
      </div>
      <p className={styles.note}>
        直近2週間を、それまでと比べています。並びは五十音順で、良い方向の変化も同じように出します。「今週分を確認した」は自分用の目印で、ほかの人には伝わりません。
      </p>

      {tooEarly ? (
        <p className={styles.lede}>変化は記録が2週間たまると表示されます。</p>
      ) : results.length === 0 ? (
        <p className={styles.lede}>今週、大きな変化はありませんでした。</p>
      ) : done && !peek ? (
        <p className={styles.row}>
          <span className={styles.muted}>今週分は確認済みです（{formatDate(thisWeek, false)}の週）。</span>
          <button type="button" className={styles.linkButton} onClick={() => setPeek(true)}>
            ひらく
          </button>
          <button type="button" className={styles.linkButton} onClick={() => setWeeklyCheck(persona.id, scopeKey, null)}>
            確認を取り消す
          </button>
        </p>
      ) : (
        <ul className={styles.changes}>
          {results.map(({ person, result }) => (
            <li key={person.id} className={styles.change}>
              <span className={styles.changeName}>
                <Link href={hrefWith({ p: person.id })} className={styles.personLink}>
                  {person.name}
                </Link>
                <span className={styles.small}>{person.sub}</span>
              </span>
              <span className={styles.changeBody}>
                <span className={styles.changeText}>{result.changes.map((c) => `${describeChange(c, tagLabel, "teacher")}。`).join("")}</span>
                <MoodStrip records={person.records} days={14} size={17} name={person.name} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ── 全員の一覧 ───────────────────────────────────── */

function Everyone({ people, hrefWith }: { people: Person[]; hrefWith: (next: Record<string, string | null>) => string }) {
  const [query, setQuery] = useState("");
  const words = query.trim().split(/\s+/).filter(Boolean);
  const shown = people.filter((p) => words.every((w) => p.name.includes(w) || p.kana.includes(w)));

  return (
    <section className={styles.section} aria-labelledby="everyone-title">
      <div className={styles.row}>
        <h2 id="everyone-title" className={styles.h2}>
          全員の一覧
        </h2>
        <span className={styles.spacer} />
        <label className={styles.search}>
          <Icon name="search" size={20} />
          <input className={styles.input} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="名前で探す" aria-label="名前で探す" />
        </label>
      </div>

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">名前</th>
              <th scope="col">担当</th>
              <th scope="col">直近7日の気分</th>
              <th scope="col">最後に記録した日</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((p) => (
              <tr key={p.id}>
                <td>
                  <Link href={hrefWith({ p: p.id })} className={styles.personLink}>
                    {p.name}
                  </Link>
                </td>
                <td className={styles.small}>{p.sub}</td>
                <td>
                  <MoodStrip records={p.records} days={7} name={p.name} />
                </td>
                <td>
                  <LastRecord date={p.records.at(-1)?.date ?? null} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {shown.length === 0 && <p className={styles.note}>「{query}」に当てはまる人はいません。</p>}
    </section>
  );
}

/* ── 2分割の左の一覧 ─────────────────────────────── */

function MiniList({ people, selectedId, hrefWith }: { people: Person[]; selectedId: string; hrefWith: (next: Record<string, string | null>) => string }) {
  return (
    <ul className={styles.miniList}>
      {people.map((p) => (
        <li key={p.id}>
          <Link href={hrefWith({ p: p.id })} className={styles.miniItem} aria-current={p.id === selectedId ? "page" : undefined}>
            <span>{p.name}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
