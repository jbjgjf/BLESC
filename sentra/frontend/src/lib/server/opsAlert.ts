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
 * ## Two conditions, both silent until now
 *
 *   `no_recipient`  A crisis was assessed and no educator holds active
 *                   oversight consent for that participant. Terminal — retrying
 *                   will not produce consent — so nothing else will ever raise
 *                   it again.
 *   `pending` with no channel
 *                   The deployment has no webhook and no mail credentials. The
 *                   row stays queued and will send once configured, but nobody
 *                   is going to configure it if nobody is told.
 *
 * Both used to produce a `console.error` and nothing else. A line in a Vercel
 * function log is not a notification: nobody is reading it at 02:00, which is
 * the hour this exists for.
 *
 * ## What is not in the message
 *
 * No participant code, no research code, no reasons, no text. The operator
 * channel is watched by whoever runs the deployment, and that is not the same
 * set of people as the educators who hold oversight consent — the whole design
 * of the escalation path is that only they learn who. What the operator needs
 * is that it happened, how many, and which of the two causes, all of which are
 * actionable without naming anyone.
 */

const SEND_TIMEOUT_MS = 8_000;

export type OpsAlertKind = "no_recipient" | "no_channel";

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

function message(kind: OpsAlertKind, escalationId: string): string {
  const shared = [
    "【blesc・運用】危機の通知が誰にも届いていません。",
    `escalation: ${escalationId}`,
    "",
  ];
  if (kind === "no_channel") {
    return [
      ...shared,
      "原因: このデプロイに送信先が設定されていません。",
      "対応: SAFETY_ALERT_WEBHOOK_URL、または RESEND_API_KEY と SAFETY_ALERT_EMAIL_FROM を設定してください。",
      "設定すれば、この件を含む保留中の通知が次回の再送で送られます。",
    ].join("\n");
  }
  return [
    ...shared,
    "原因: この参加者を見守る教員の同意が有効ではありません。",
    "対応: 再送では解決しません。名簿と見守り同意の状態を確認してください。",
    "この件は再送の対象になりません。",
  ].join("\n");
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
      body: JSON.stringify({ text: message(kind, escalationId) }),
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
