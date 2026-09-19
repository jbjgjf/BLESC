"use client";

/**
 * 運用コンソール（#B2）。
 *
 * 招待の発行、保護者確認リンクの発行、収集期間の開閉を1枚に置く。これまで
 * これらは API しか無く、50名分を bearer token 付きの curl で回す前提だった。
 *
 * 画面の設計方針が3つある。
 *
 *   1. **招待コードは一度きりで、それを画面が知っている。** サーバーは HMAC
 *      しか持たないので、発行レスポンスが平文の唯一の機会。だからコードは
 *      閉じられるまで消えず、閉じるときに「配布は済んだか」を確認する。
 *      再取得のボタンは置かない — 押しても取れないものを置くと、取れると
 *      思わせてしまう。
 *
 *   2. **一括操作は結果を行ごとに見せる。** day0 の朝に同意未完了が数人
 *      いるのは正常で、失敗ではない。`consent_missing` を赤いエラーとして
 *      出すと、運用側は「やり直す」を選んでしまう。
 *
 *   3. **保護者確認リンクは、この画面から生徒には渡らない。** 表示されるのは
 *      発行した本人（コーディネータ）の画面だけで、渡すのは学校の手。
 *      `/pilot/join` 側でリンクを出さないのと同じ理由（PR #170）。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/lib/auth";
import { Icon } from "@/components/ui/Icon";
import {
  PilotOpsApi,
  type EnrollmentsView,
  type InvitationsView,
  type IssuedGuardianLink,
  type OutstandingGuardian,
  type TransitionResult,
} from "@/lib/pilotOpsClient";
import { OPERATOR_TRANSITIONS, type PilotState } from "@/lib/pilotEnrollment";
import styles from "./ops.module.css";

const STATE_LABEL: Record<string, string> = {
  account_bound: "アカウント紐付け",
  information_read: "説明を読んだ",
  participant_assented: "本人の同意",
  guardian_verified: "保護者の確認",
  enrolled: "参加登録",
  collecting: "収集中",
  withdrawn: "撤回",
  completed: "終了",
};

const TRANSITION_LABEL: Record<string, string> = {
  collecting: "収集を開始する（窓を開ける）",
  completed: "収集を終了する（窓を閉じる）",
};

/**
 * 一括結果の読み方。`consent_missing` は正常な待ち状態なので警告色にしない。
 * ここで色を間違えると、運用側が「失敗した」と読んで再実行する。
 */
const OUTCOME_LABEL: Record<string, { text: string; tone: "good" | "wait" | "bad" }> = {
  ok: { text: "実行した", tone: "good" },
  consent_missing: { text: "同意がまだ（正常な待ち）", tone: "wait" },
  illegal_transition: { text: "その状態からは進めない", tone: "wait" },
  terminal: { text: "終了済み・撤回済み", tone: "wait" },
  not_found: { text: "行が見つからない", tone: "bad" },
  error: { text: "エラー", tone: "bad" },
};

const STUDY_KEY = "blesc.pilot.ops.study";

const CHANNELS = [
  { key: "school", label: "学校から手渡し" },
  { key: "email", label: "メール" },
  { key: "paper", label: "紙" },
  { key: "phone", label: "電話" },
];

export default function PilotOpsPage() {
  const { isLoading, session } = useAuth();

  const [study, setStudy] = useState("");
  const [cohort, setCohort] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const [invitations, setInvitations] = useState<InvitationsView | null>(null);
  const [guardians, setGuardians] = useState<OutstandingGuardian[]>([]);
  const [enrollments, setEnrollments] = useState<EnrollmentsView | null>(null);

  // 平文のコードとリンクは、閉じるまでこのstateにだけ存在する。
  const [freshCodes, setFreshCodes] = useState<string[] | null>(null);
  const [freshLink, setFreshLink] = useState<IssuedGuardianLink | null>(null);
  const [lastRun, setLastRun] = useState<TransitionResult | null>(null);

  const [issueCount, setIssueCount] = useState(10);
  const [issueMinor, setIssueMinor] = useState(true);
  const [issueNote, setIssueNote] = useState("");
  const [channel, setChannel] = useState("school");

  const refresh = useCallback(async () => {
    if (!study.trim()) return;
    const slug = study.trim();
    const scope = cohort.trim() || undefined;
    const [inv, guard, enr] = await Promise.all([
      PilotOpsApi.invitations(slug).catch(() => null),
      PilotOpsApi.outstandingGuardians(slug).catch(() => ({ study: slug, outstanding: [] })),
      PilotOpsApi.enrollments(slug, scope).catch(() => null),
    ]);
    setInvitations(inv);
    setGuardians(guard.outstanding);
    setEnrollments(enr);
    setLoaded(true);
  }, [cohort, study]);

  // 最後に使ったスラッグを覚えておく。localStorage にしているのは、
  // NEXT_PUBLIC_ の変数を1つ増やすとデプロイ側の設定項目が1つ増えるうえ、
  // ビルド時に焼き込まれるため。ここで必要なのは「前回の続き」だけで、
  // それはこのブラウザの都合でしかない。
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(STUDY_KEY);
      if (saved) setStudy(saved);
    } catch {
      // プライベートモード等。覚えられないだけで、手で入力すれば動く。
    }
  }, []);

  useEffect(() => {
    if (!study.trim()) return;
    try {
      window.localStorage.setItem(STUDY_KEY, study.trim());
    } catch {
      // 同上。
    }
  }, [study]);

  const run = async (action: () => Promise<string | null>) => {
    setBusy(true);
    setNotice(null);
    setProblem(null);
    try {
      const message = await action();
      if (message) setNotice(message);
      await refresh();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "うまくいきませんでした。");
    } finally {
      setBusy(false);
    }
  };

  const readyCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const target of OPERATOR_TRANSITIONS) {
      counts[target] = (enrollments?.enrollments ?? []).filter((row) =>
        row.ready_for.includes(target),
      ).length;
    }
    return counts;
  }, [enrollments]);

  if (isLoading) {
    return (
      <main className="bl-wrap" style={{ display: "grid", placeItems: "center", minHeight: "50vh" }}>
        <span className="bl-loader" aria-label="読み込み中" />
      </main>
    );
  }

  if (!session) {
    return (
      <main className="bl-wrap bl-stack">
        <p className="bl-notice" role="status">
          この画面を使うにはサインインが必要です。
        </p>
      </main>
    );
  }

  return (
    <main className="bl-wrap bl-stack">
      <header className="bl-stack" style={{ gap: 6 }}>
        <p className="bl-eyebrow">運用</p>
        <h1 className="bl-h1">パイロット運用コンソール</h1>
        <p className="bl-meta">
          招待の発行・保護者確認リンクの発行・収集期間の開閉。運営者として許可された
          アカウントでのみ動作します（許可が無い場合、各操作は「見つかりません」を返します）。
        </p>
      </header>

      {notice && (
        <p className="bl-notice" role="status">
          <Icon name="info" size={19} /> {notice}
        </p>
      )}
      {problem && (
        <p className="bl-notice bl-notice--watch" role="alert">
          <Icon name="info" size={19} /> {problem}
        </p>
      )}

      <section className="bl-card bl-stack">
        <h2 className="bl-h2">対象</h2>
        <div className="bl-row" style={{ gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
          <div style={{ flex: "1 1 220px" }}>
            <label className="bl-label" htmlFor="study">研究スラッグ</label>
            <input
              id="study"
              className="bl-input"
              value={study}
              onChange={(event) => setStudy(event.target.value)}
              placeholder="PILOT_STUDY_SLUG の値"
            />
          </div>
          <div style={{ flex: "1 1 160px" }}>
            <label className="bl-label" htmlFor="cohort">コホート（空欄＝全体）</label>
            <input
              id="cohort"
              className="bl-input"
              value={cohort}
              onChange={(event) => setCohort(event.target.value)}
              placeholder="A"
            />
          </div>
          <button
            type="button"
            className="bl-btn bl-btn--primary"
            disabled={busy || !study.trim()}
            onClick={() => void run(async () => null)}
          >
            読み込む
          </button>
        </div>
        {invitations && (
          <p className="bl-meta">
            {invitations.study.title}（{invitations.study.status}
            {invitations.study.is_dry_run ? "・ドライラン" : ""}）　プロトコル版{" "}
            {invitations.study.protocol_version}
          </p>
        )}
      </section>

      {loaded && (
        <>
          <section className="bl-card bl-stack">
            <h2 className="bl-h2">収集期間の開閉</h2>
            {enrollments ? (
              <>
                <div className="bl-row" style={{ gap: 16, flexWrap: "wrap" }}>
                  {Object.entries(enrollments.by_state).map(([state, count]) => (
                    <span key={state} className="bl-micro">
                      {STATE_LABEL[state] ?? state}: <strong>{count}</strong>
                    </span>
                  ))}
                  <span className="bl-micro">合計: <strong>{enrollments.total}</strong></span>
                </div>

                <div className="bl-row" style={{ gap: 10, flexWrap: "wrap" }}>
                  {OPERATOR_TRANSITIONS.map((target) => (
                    <button
                      key={target}
                      type="button"
                      className="bl-btn bl-btn--secondary"
                      disabled={busy || readyCounts[target] === 0}
                      onClick={() =>
                        void run(async () => {
                          const result = await PilotOpsApi.transition({
                            study: study.trim(),
                            cohort: cohort.trim() || undefined,
                            to: target as PilotState,
                            reason: target === "collecting" ? "window_open" : "window_close",
                          });
                          setLastRun(result);
                          return `${result.considered} 件を処理しました。`;
                        })
                      }
                    >
                      {TRANSITION_LABEL[target] ?? target}
                      （対象 {readyCounts[target] ?? 0} 件）
                    </button>
                  ))}
                </div>
                <p className="bl-micro">
                  コホート単位で開きます。個別に開ける必要がある場合（遅れて参加した人など）は
                  一覧から対象を選んでください。撤回はこの画面からは行えません。
                </p>

                {lastRun && (
                  <div className="bl-stack" style={{ gap: 6 }}>
                    <h3 className="bl-h3">直前の結果</h3>
                    <div className="bl-row" style={{ gap: 12, flexWrap: "wrap" }}>
                      {Object.entries(lastRun.counts).map(([outcome, count]) => {
                        const meta = OUTCOME_LABEL[outcome] ?? { text: outcome, tone: "wait" as const };
                        return (
                          <span key={outcome} className="bl-micro">
                            {meta.text}: <strong>{count}</strong>
                          </span>
                        );
                      })}
                    </div>
                    {(lastRun.counts.consent_missing ?? 0) > 0 && (
                      <p className="bl-micro">
                        同意がまだの方がいます。これは開講日の通常の状態です。同意が済んでから、
                        その方だけを個別に開いてください。同じ操作をもう一度実行しても二重には開きません。
                      </p>
                    )}
                  </div>
                )}

                <details>
                  <summary className="bl-micro">参加者一覧（{enrollments.enrollments.length}件）</summary>
                  <div className={styles.tableScroll}>
                    <table className={styles.table} style={{ marginTop: 8 }}>
                      <thead>
                        <tr>
                          <th style={{ textAlign: "left" }}>参加者ID</th>
                          <th style={{ textAlign: "left" }}>コホート</th>
                          <th style={{ textAlign: "left" }}>状態</th>
                          <th style={{ textAlign: "left" }}>未成年</th>
                          <th style={{ textAlign: "left" }}>個別操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {enrollments.enrollments.map((row) => (
                          <tr key={row.enrollment_id}>
                            <td className={styles.code}>{row.research_code}</td>
                            <td>{row.cohort}</td>
                            <td>{STATE_LABEL[row.state] ?? row.state}</td>
                            <td>{row.is_minor ? "はい" : "いいえ"}</td>
                            <td>
                              {row.ready_for.length === 0 ? (
                                <span className="bl-micro">—</span>
                              ) : (
                                row.ready_for.map((target) => (
                                  <button
                                    key={target}
                                    type="button"
                                    className="bl-btn bl-btn--ghost"
                                    disabled={busy}
                                    onClick={() =>
                                      void run(async () => {
                                        const result = await PilotOpsApi.transition({
                                          study: study.trim(),
                                          to: target,
                                          enrollment_ids: [row.enrollment_id],
                                          reason: "individual",
                                        });
                                        setLastRun(result);
                                        return `${row.research_code}: ${
                                          OUTCOME_LABEL[result.results[0]?.outcome ?? ""]?.text ?? "処理しました"
                                        }`;
                                      })
                                    }
                                  >
                                    {target === "collecting" ? "開く" : "閉じる"}
                                  </button>
                                ))
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              </>
            ) : (
              <p className="bl-meta">参加登録を読み込めませんでした。研究スラッグを確認してください。</p>
            )}
          </section>

          <section className="bl-card bl-stack">
            <h2 className="bl-h2">保護者確認の待ち（{guardians.length}件）</h2>
            {guardians.length === 0 ? (
              <p className="bl-meta">待っている依頼はありません。</p>
            ) : (
              <>
                <div className="bl-row" style={{ gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
                  <div style={{ flex: "1 1 200px" }}>
                    <label className="bl-label" htmlFor="channel">渡し方</label>
                    <select
                      id="channel"
                      className="bl-input"
                      value={channel}
                      onChange={(event) => setChannel(event.target.value)}
                    >
                      {CHANNELS.map((option) => (
                        <option key={option.key} value={option.key}>{option.label}</option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className={styles.tableScroll}>
                  <table className={styles.table}>
                    <thead>
                      <tr>
                        <th style={{ textAlign: "left" }}>参加者ID</th>
                        <th style={{ textAlign: "left" }}>コホート</th>
                        <th style={{ textAlign: "left" }}>状態</th>
                        <th style={{ textAlign: "left" }}>依頼</th>
                        <th style={{ textAlign: "left" }}></th>
                      </tr>
                    </thead>
                    <tbody>
                      {guardians.map((row) => (
                        <tr key={row.verification_id}>
                          <td className={styles.code}>{row.research_code ?? "—"}</td>
                          <td>{row.cohort ?? "—"}</td>
                          <td>{row.status}</td>
                          <td className="bl-micro">
                            {new Date(row.requested_at).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}
                          </td>
                          <td>
                            <button
                              type="button"
                              className="bl-btn bl-btn--secondary"
                              disabled={busy}
                              onClick={() =>
                                void run(async () => {
                                  const issued = await PilotOpsApi.issueGuardianLink(
                                    row.verification_id,
                                    channel,
                                  );
                                  setFreshLink(issued);
                                  return null;
                                })
                              }
                            >
                              リンクを発行
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}

            {freshLink && (
              <div className="bl-notice bl-notice--watch bl-stack" role="alert" style={{ gap: 8 }}>
                <strong>{freshLink.research_code ?? "—"} の保護者確認リンク</strong>
                <code className={styles.secret}>{freshLink.url}</code>
                <p className="bl-micro">
                  <strong>このリンクは保護者に渡すものです。生徒には渡さないでください。</strong>
                  リンクを持っている人は誰でも確認を完了できます。
                  {freshLink.expires_at &&
                    `期限: ${new Date(freshLink.expires_at).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}`}
                </p>
                <div className="bl-row" style={{ gap: 10 }}>
                  <button
                    type="button"
                    className="bl-btn bl-btn--ghost"
                    onClick={() => void navigator.clipboard?.writeText(freshLink.url)}
                  >
                    コピー
                  </button>
                  <button type="button" className="bl-btn bl-btn--ghost" onClick={() => setFreshLink(null)}>
                    閉じる
                  </button>
                </div>
              </div>
            )}
          </section>

          <section className="bl-card bl-stack">
            <h2 className="bl-h2">招待コード</h2>
            {invitations && (
              <div className="bl-row" style={{ gap: 16, flexWrap: "wrap" }}>
                <span className="bl-micro">発行済: <strong>{invitations.totals.issued}</strong></span>
                <span className="bl-micro">使用済: <strong>{invitations.totals.redeemed}</strong></span>
                <span className="bl-micro">未使用: <strong>{invitations.totals.available}</strong></span>
                <span className="bl-micro">失効: <strong>{invitations.totals.revoked}</strong></span>
              </div>
            )}

            <div className="bl-row" style={{ gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
              <div style={{ flex: "0 1 120px" }}>
                <label className="bl-label" htmlFor="count">枚数</label>
                <input
                  id="count"
                  className="bl-input"
                  type="number"
                  min={1}
                  max={200}
                  value={issueCount}
                  onChange={(event) => setIssueCount(Number(event.target.value))}
                />
              </div>
              <div style={{ flex: "1 1 200px" }}>
                <label className="bl-label" htmlFor="note">メモ（任意）</label>
                <input
                  id="note"
                  className="bl-input"
                  value={issueNote}
                  onChange={(event) => setIssueNote(event.target.value)}
                  placeholder="2年A組 9/20配布"
                />
              </div>
              <label className="bl-choice" style={{ flex: "0 1 auto" }}>
                <input
                  type="checkbox"
                  checked={issueMinor}
                  onChange={(event) => setIssueMinor(event.target.checked)}
                />
                このコードは未成年に配る（保護者確認を必須にする）
              </label>
              <button
                type="button"
                className="bl-btn bl-btn--primary"
                disabled={busy || !study.trim()}
                onClick={() =>
                  void run(async () => {
                    const issued = await PilotOpsApi.issueInvitations({
                      study: study.trim(),
                      count: issueCount,
                      cohort: cohort.trim() || undefined,
                      is_minor: issueMinor,
                      note: issueNote.trim() || undefined,
                    });
                    setFreshCodes(issued.codes);
                    return null;
                  })
                }
              >
                発行する
              </button>
            </div>
            <p className="bl-micro">
              未成年かどうかは<strong>配る側が決めます</strong>。参加者本人に選ばせると、
              未成年が「18歳以上」を選んだ時点で保護者確認が丸ごと飛びます。
            </p>

            {freshCodes && (
              <div className="bl-notice bl-notice--watch bl-stack" role="alert" style={{ gap: 8 }}>
                <strong>発行した {freshCodes.length} 件のコード</strong>
                <p className="bl-micro">
                  <strong>この画面を閉じると二度と表示できません。</strong>
                  サーバーはコードのハッシュしか保存していないため、再発行はできても復元はできません。
                  いま配布するか、控えを取ってください。
                </p>
                <pre className={styles.secret}>{freshCodes.join("\n")}</pre>
                <div className="bl-row" style={{ gap: 10 }}>
                  <button
                    type="button"
                    className="bl-btn bl-btn--ghost"
                    onClick={() => void navigator.clipboard?.writeText(freshCodes.join("\n"))}
                  >
                    すべてコピー
                  </button>
                  <button
                    type="button"
                    className="bl-btn bl-btn--ghost"
                    onClick={() => {
                      if (window.confirm("配布は済みましたか？ 閉じるとこのコードは二度と表示できません。")) {
                        setFreshCodes(null);
                      }
                    }}
                  >
                    配布した（閉じる）
                  </button>
                </div>
              </div>
            )}

            {invitations && invitations.invitations.length > 0 && (
              <details>
                <summary className="bl-micro">発行済みの一覧（コードは表示されません）</summary>
                <div className={styles.tableScroll}>
                  <table className={styles.table} style={{ marginTop: 8 }}>
                    <thead>
                      <tr>
                        <th style={{ textAlign: "left" }}>接頭辞</th>
                        <th style={{ textAlign: "left" }}>コホート</th>
                        <th style={{ textAlign: "left" }}>使用</th>
                        <th style={{ textAlign: "left" }}>メモ</th>
                        <th style={{ textAlign: "left" }}></th>
                      </tr>
                    </thead>
                    <tbody>
                      {invitations.invitations.map((row) => (
                        <tr key={row.prefix} style={{ opacity: row.revoked ? 0.5 : 1 }}>
                          <td className={styles.code}>{row.prefix}…</td>
                          <td>{row.cohort}</td>
                          <td>{row.redeemed} / {row.max}</td>
                          <td className="bl-micro">{row.note ?? "—"}</td>
                          <td>
                            {!row.revoked && row.redeemed === 0 && (
                              <button
                                type="button"
                                className="bl-btn bl-btn--ghost"
                                disabled={busy}
                                onClick={() =>
                                  void run(async () => {
                                    const result = await PilotOpsApi.revokeInvitations(
                                      study.trim(),
                                      row.prefix,
                                    );
                                    return `${result.count} 件を失効させました。`;
                                  })
                                }
                              >
                                失効させる
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            )}
          </section>
        </>
      )}
    </main>
  );
}
