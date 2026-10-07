"use client";

/**
 * 先生の個別画面（C-2）・面談前サマリー（C-3）・面談メモ（C-4）。
 *
 * 生徒の個別画面（B-2〜B-4）と同じ組み立てで、話題の代わりに業務タグの
 * 推移を出す。面談メモは管理職だけが読み、本人には表示しない。異動のときの
 * 引き継ぎは、学校の設定に従う（既定は引き継がない）。
 *
 * どの部分も、印刷・CSV出力・一括ダウンロードはできない（C-5）。
 */

import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { MoodTrend } from "@/components/blesc/MoodTrend";
import { AS_OF, PERSONAS, WORK_TAGS, getStaffMember } from "@/lib/teachers/fixtures";
import { compareRecentWindows } from "@/lib/teachers/records";
import { ChangeFacts, ChangeMark, NoExport, NoExportNote, PageHead, RecordList, RoleGate, TagTrend, styles } from "@/components/teachers/parts";
import { MemoPanel } from "@/components/teachers/MemoPanel";
import { SummaryView } from "@/components/teachers/SummaryView";

type Tab = "records" | "summary" | "memo";

export function StaffDetail() {
  return (
    <RoleGate allow={["manager"]}>
      <NoExport>
        <Detail />
      </NoExport>
    </RoleGate>
  );
}

function Detail() {
  const params = useParams<{ staffId: string }>();
  const member = getStaffMember(params.staffId);
  const [tab, setTab] = useState<Tab>("records");

  if (!member) {
    return (
      <div className={styles.page}>
        <PageHead title="先生が見つかりません" />
        <Link href="/educator/staff" className={styles.linkButton}>
          教職員の一覧へ
        </Link>
      </div>
    );
  }

  const change = compareRecentWindows(member.records, AS_OF);
  const usedTags = WORK_TAGS.map((t) => t.value).filter((tag) => member.records.some((r) => r.tags.includes(tag)));

  return (
    <div className={styles.page}>
      <PageHead kicker={`先生の記録・${member.duty}`} title={member.name}>
        <NoExportNote />
      </PageHead>

      <div className={styles.segmented} role="tablist" aria-label="表示">
        <button type="button" role="tab" aria-selected={tab === "records"} onClick={() => setTab("records")}>
          記録
        </button>
        <button type="button" role="tab" aria-selected={tab === "summary"} onClick={() => setTab("summary")} data-bl-term="面談前サマリー">
          面談前サマリー
        </button>
        <button type="button" role="tab" aria-selected={tab === "memo"} onClick={() => setTab("memo")} data-bl-term="面談メモ">
          面談メモ
        </button>
      </div>

      {tab === "records" && (
        <>
          <section className={styles.section} style={{ borderTop: 0, paddingTop: 0 }}>
            <div className={styles.sectionHead}>
              <h2 className={styles.h2}>直近4週の変化</h2>
              <ChangeMark result={change} />
            </div>
            <ChangeFacts result={change} />
          </section>

          <section className={styles.section}>
            <h2 className={styles.h2}>気分の推移（8週）</h2>
            <MoodTrend series={member.records.map(({ date, mood }) => ({ date, mood }))} />
          </section>

          <section className={styles.section}>
            <h2 className={styles.h2}>業務タグの推移（本人の申告、週ごと）</h2>
            <TagTrend records={member.records} tags={usedTags} />
          </section>

          <section className={styles.section}>
            <h2 className={styles.h2}>すべての記録（{member.records.length}件・新しい順）</h2>
            <RecordList records={[...member.records].reverse()} />
          </section>
        </>
      )}

      {tab === "summary" && (
        <section className={styles.section} style={{ borderTop: 0, paddingTop: 0 }}>
          <SummaryView records={member.records} subject={member.name} />
        </section>
      )}

      {tab === "memo" && (
        <section className={styles.section} style={{ borderTop: 0, paddingTop: 0 }}>
          <MemoPanel subject={{ kind: "staff", id: member.id, name: member.name }} author={PERSONAS.manager.name} />
        </section>
      )}
    </div>
  );
}
