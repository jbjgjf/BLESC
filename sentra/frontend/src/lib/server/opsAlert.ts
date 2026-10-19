/**
 * Telling the operator that a crisis notification reached nobody (#178).
 *
 * ## Why this cannot share the escalation channel
 *
 * The condition being reported is "the escalation channel did not deliver".
 * Sending that report down the same channel is a smoke alarm wired to the
 * circuit that is on fire: when it matters most, it is the thing that is
 * broken. So this takes its own URL, `SAFETY_OPS_ALERT_WEBHOOK_URL`, and a
 * deployment is expected to point it somewhere different — a second Slack
 * workspace, a pager, the on-call phone. Pointing both at the same endpoint is
 * allowed and is a configuration mistake; §5.7 of the runbook says so.
 *
 * ## Four reasons, one message each
 *
 *   `no_recipient`  A crisis was assessed and no educator holds active
 *                   oversight consent for that participant. Terminal — retrying
 *                   will not produce consent — so nothing else will ever raise
 *                   it again.
 *   `no_channel`    The deployment has no webhook and no mail credentials. The
 *                   row stays queued and will send once configured, but nobody
 *                   is going to configure it if nobody is told (#178).
 *   `no_reachable_address`
 *                   Consent is held, but no consented educator has an address
 *                   the configured channels can reach (#203). Queued; fixed by
 *                   filling in an address, not by touching consent.
 *   `lookup_failed` The recipient lookup itself failed, so consent was never
 *                   checked (#458). Queued; the dispatcher asks again.
 *
 * The kinds are one-to-one with the reasons `deliverEscalation` gives for
 * reaching nobody. Before #458 there were two, so #203 was reported with the
 * `no_recipient` text — wrong cause, wrong repair, and "will not be retried"
 * about a row that was still in the queue. That text goes to whoever is woken
 * at 02:00, and it is the one place the three facts must be right.
 *
 * Each used to produce a `console.error` and nothing else. A line in a Vercel
 * function log is not a notification: nobody is reading it at 02:00, which is
 * the hour this exists for.
 *
 * ## What is not in the message
 *
 * No participant code, no research code, no reasons, no text. The operator
 * channel is watched by whoever runs the deployment, and that is not the same
 * set of people as the educators who hold oversight consent — the whole design
 * of the escalation path is that only they learn who. What the operator needs
 * is that it happened, how many, and which of the causes, all of which are
 * actionable without naming anyone.
 */

const SEND_TIMEOUT_MS = 8_000;

export type OpsAlertKind = "no_recipient" | "no_channel" | "no_reachable_address" | "lookup_failed";

export function opsAlertConfigured(): boolean {
  return Boolean(process.env.SAFETY_OPS_ALERT_WEBHOOK_URL);
}

/**
 * Whether the ops channel is distinct from the delivery channel.
 *
 * Reported rather than enforced: a deployment that has only one endpoint is
 * better off with this pointed at it than with nothing. But it is worth
 * surfacing, because the failure mode — both dead together — is exactly the one
 * this module was added to avoid.
 */
export function opsAlertIsSeparate(): boolean {
  const ops = process.env.SAFETY_OPS_ALERT_WEBHOOK_URL;
  const delivery = process.env.SAFETY_ALERT_WEBHOOK_URL;
  if (!ops) return false;
  return ops !== delivery;
}

/** The operator-facing text for one kind. Exported so tests can pin which kind was sent. */
export function opsAlertMessage(kind: OpsAlertKind, escalationId: string): string {
  const shared = [
    "【blesc・運用】危機の通知が誰にも届いていません。",
    `escalation: ${escalationId}`,
    "",
  ];
  /*
   * Every kind states three things: the cause, the repair, and whether this
   * escalation will be sent again by itself. An operator acts on the third
   * before the other two — "queued" means fix and wait, "not retried" means
   * this one is already lost.
   */
  const body: Record<OpsAlertKind, string[]> = {
    no_channel: [
      "原因: このデプロイに送信先が設定されていません。",
      "対応: SAFETY_ALERT_WEBHOOK_URL、または RESEND_API_KEY と SAFETY_ALERT_EMAIL_FROM を設定してください。",
      "設定すれば、この件を含む保留中の通知が次回の再送で送られます。",
    ],
    lookup_failed: [
      "原因: 通知先の教員を照会する処理がデータベースで失敗しました。見守り同意の有無はまだ確認できていません。",
      "対応: Supabase の状態（タイムアウト・接続・safety_escalation_recipients 関数）を確認してください。",
      "この件は保留のまま残り、次回の再送で照会からやり直します。",
    ],
    no_reachable_address: [
      "原因: 見守り同意のある教員はいますが、設定済みの送信先で届くアドレスを持つ人がいません。",
      "対応: 名簿の教員アカウントにメールアドレスを登録するか、SAFETY_ALERT_WEBHOOK_URL を設定してください。同意の状態は問題ありません。",
      "この件は保留のまま残り、アドレスが入れば次回の再送で送られます。",
    ],
    no_recipient: [
      "原因: この参加者を見守る教員の同意が有効ではありません。",
      "対応: 再送では解決しません。名簿と見守り同意の状態を確認してください。",
      "この件は再送の対象になりません。",
    ],
  };
  return [...shared, ...body[kind]].join("\n");
}

/**
 * Fire and forget, with a timeout.
 *
 * Never throws and never blocks the caller's outcome: this is a report about a
 * failure, and a failure to report must not turn into a second failure in the
 * path that was already degraded.
 */
export async function reportUndeliverable(kind: OpsAlertKind, escalationId: string): Promise<void> {
  const url = process.env.SAFETY_OPS_ALERT_WEBHOOK_URL;
  if (!url) {
    console.error(
      "[ops-alert] SAFETY_OPS_ALERT_WEBHOOK_URL is not set, so nobody is being told that a " +
        "crisis notification reached no one. Set it to something other than SAFETY_ALERT_WEBHOOK_URL.",
      { escalation: escalationId, kind },
    );
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: opsAlertMessage(kind, escalationId) }),
      signal: controller.signal,
    });
    if (!response.ok) {
      console.error(`[ops-alert] operator channel answered ${response.status}`, { escalation: escalationId });
    }
  } catch (error) {
    console.error(
      "[ops-alert] could not reach the operator channel",
      error instanceof Error ? error.message : error,
    );
  } finally {
    clearTimeout(timeout);
  }
}
