/**
 * Getting a crisis to a person on the night it happens.
 *
 * Before this module, a crisis assessment produced a `model_runs` audit row and
 * nothing else. The educator-facing alert was computed in the educator's own
 * browser, from the roster, when they opened the dashboard — so the product's
 * answer to "a student wrote at 02:00 that they do not want to be alive" was to
 * wait for someone to open a tab.
 *
 * Three things have to be true for this to be worth adding, and each is a
 * decision in the code below rather than an intention.
 *
 * **It must not widen who knows.** The recipients are recomputed at send time
 * from the same tables `educator_oversees` reads: an active roster entry, an
 * active organisation membership, an active `oversight_consents` row. Every one
 * of them could already have read this observation from the roster. What
 * changes is when, not who. A consent revoked an hour ago means no message
 * tonight.
 *
 * **It must not leak what the student wrote.** The outbound message carries the
 * participant's code, the time, and a link. Not the journal text, not the chat
 * text, not a score, not a band. An educator who needs more clicks through and
 * authenticates. A notification is read on a lock screen, in a staff room, over
 * someone's shoulder.
 *
 * **It must never fail silently.** The escalation row is written first and
 * awaited; delivery is attempted after. A send that fails, or a deployment with
 * no channel configured, leaves a row in `pending`/`failed` with the reason, and
 * `/api/safety/dispatch` retries it. The failure mode is "late", never "never" —
 * which is the whole complaint this module answers.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

/*
 * `fetchWithTimeout` is duplicated from `lib/server/api.ts` rather than
 * imported, and the eight lines are worth the duplication twice over.
 *
 * `api.ts` pulls in `next/server` and the Supabase SSR client, which makes this
 * module unloadable outside a Next runtime — so the delivery logic could only
 * be exercised by standing up the app. The part of this product that decides
 * whether anyone is told about a crisis should be testable by running one file.
 *
 * The second reason is smaller and still real: nothing on the path between "a
 * student is in danger" and "a person is paged" should depend on a module of
 * general request helpers that anything may edit.
 */
async function fetchWithTimeout(input: string, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

/** Levels that reach a person. `none` and `low` never do. */
export type EscalationLevel = "elevated" | "crisis";

export type EscalationInput = {
  ownerUserId: string;
  participantId: string;
  participantCode: string | null;
  riskLevel: EscalationLevel;
  reasons: string[];
  surface: string;
  sourceArtifactId?: string | null;
  detectedAt?: Date;
};

export type EscalationRow = {
  id: string;
  owner_user_id: string;
  participant_id: string;
  risk_level: EscalationLevel;
  reasons: string[];
  surface: string;
  detected_at: string;
  status: "pending" | "delivered" | "failed" | "no_recipient";
  attempts: number;
};

type Recipient = { educator_user_id: string; email: string | null };

/** How long a send may take before the dispatcher's next pass owns it. */
const SEND_TIMEOUT_MS = 8_000;

/**
 * Which levels are notified.
 *
 * `crisis` always. `elevated` only when the deployment opts in, because
 * `elevated` covers distress without an explicit danger signal — real, worth an
 * educator's attention, and frequent enough that nightly paging on it would
 * train the recipient to ignore the channel. A school that wants it says so.
 */
export function notifiableLevel(riskLevel: string): EscalationLevel | null {
  if (riskLevel === "crisis") return "crisis";
  if (riskLevel === "elevated" && process.env.SAFETY_ALERT_ON_ELEVATED === "1") return "elevated";
  return null;
}

/**
 * One escalation per participant, per level, per hour.
 *
 * A student in distress writes several turns in a row and each assesses as
 * crisis. Five messages in four minutes is one situation, and it teaches the
 * recipient to swipe. The hour bucket lets a continuing conversation escalate
 * once while a new night is a new row. Computed in UTC so two servers in
 * different regions agree.
 */
export function dedupeKey(riskLevel: string, surface: string, at: Date): string {
  const hour = at.toISOString().slice(0, 13); // YYYY-MM-DDTHH
  return `${riskLevel}:${surface}:${hour}`;
}

/**
 * Write the escalation. Returns null when there was nothing to write.
 *
 * Awaited by the caller before it responds to the student. The delivery is not:
 * a slow mail provider must not hold up the reply to someone in crisis, and an
 * unsent row is recoverable where an unwritten one is not.
 */
export async function recordEscalation(
  service: SupabaseClient,
  input: EscalationInput,
): Promise<EscalationRow | null> {
  const at = input.detectedAt ?? new Date();
  const row = {
    owner_user_id: input.ownerUserId,
    participant_id: input.participantId,
    risk_level: input.riskLevel,
    reasons: input.reasons,
    surface: input.surface,
    detected_at: at.toISOString(),
    source_artifact_id: input.sourceArtifactId ?? null,
    dedupe_key: dedupeKey(input.riskLevel, input.surface, at),
  };

  const result = await service
    .from("safety_escalations")
    .insert(row)
    .select("id, owner_user_id, participant_id, risk_level, reasons, surface, detected_at, status, attempts")
    .single();

  if (!result.error) return result.data as EscalationRow;

  // 23505 is the dedupe unique index: this hour already has one, and that one
  // is either delivered or still owed. Either way there is nothing to add.
  if (result.error.code === "23505") return null;

  // Everything else is loud. A failure here is the notification being lost at
  // the only point where losing it is unrecoverable, so it must not be a
  // `console.warn` somebody scrolls past.
  console.error(
    "[safety-escalation] COULD NOT RECORD AN ESCALATION — nobody will be told",
    { participant: input.participantId, surface: input.surface, error: result.error.message },
  );
  return null;
}

/** The educators who may be told, as of now. */
export async function recipientsFor(
  service: SupabaseClient,
  participantId: string,
): Promise<Recipient[]> {
  const result = await service.rpc("safety_escalation_recipients", {
    target_participant: participantId,
  });
  if (result.error) {
    console.error("[safety-escalation] recipient lookup failed", result.error.message);
    return [];
  }
  return (result.data ?? []) as Recipient[];
}

async function hashAddress(address: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(address));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

function consoleUrl(): string {
  const base = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") ?? "";
  return `${base}/educator/roster`;
}

/**
 * What goes over the wire.
 *
 * Deliberately thin. The participant's code — pseudonymous, and the handle the
 * educator's own roster uses — the time, and where to go. An educator who needs
 * to know what was written signs in.
 */
export function notificationText(escalation: {
  risk_level: string;
  detected_at: string;
  surface: string;
}, participantCode: string | null): string {
  const when = new Date(escalation.detected_at).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
  const who = participantCode ? `参加者 ${participantCode}` : "担当している生徒のひとり";
  const urgency = escalation.risk_level === "crisis"
    ? "すぐに確認してください。"
    : "確認をお願いします。";
  return [
    `【blesc】${who} の記録に、確認が必要な表現がありました。${urgency}`,
    `検知時刻：${when}`,
    "内容は本人の画面にのみ保存されています。詳細はログインして確認してください。",
    consoleUrl(),
    "",
    "blesc は緊急対応を行いません。危険が差し迫っていると判断される場合は、学校の緊急対応手順に従ってください。",
  ].join("\n");
}

type SendOutcome = { status: "delivered" | "failed" | "skipped"; error?: string; channel: string };

/**
 * A school's own endpoint — Slack, Teams, a duty-phone gateway, anything that
 * accepts a POST. Chosen as the first channel because it needs no account, no
 * npm package, and no per-recipient address: the school already knows who is on
 * duty at 02:00, and this product does not.
 */
async function sendWebhook(text: string): Promise<SendOutcome | null> {
  const url = process.env.SAFETY_ALERT_WEBHOOK_URL;
  if (!url) return null;
  try {
    const response = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      },
      SEND_TIMEOUT_MS,
    );
    if (!response.ok) {
      return { status: "failed", error: `webhook ${response.status}`, channel: "webhook" };
    }
    return { status: "delivered", channel: "webhook" };
  } catch (error) {
    return {
      status: "failed",
      error: error instanceof Error ? error.message : "webhook request failed",
      channel: "webhook",
    };
  }
}

/**
 * Email over Resend's HTTP API.
 *
 * An HTTP call rather than a package: adding an SDK to send one message would
 * put a dependency tree behind a safety path, and this is a POST with a JSON
 * body. Any provider with the same shape can be swapped in here.
 */
async function sendEmail(to: string, text: string, crisis: boolean): Promise<SendOutcome | null> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.SAFETY_ALERT_EMAIL_FROM;
  if (!apiKey || !from) return null;
  try {
    const response = await fetchWithTimeout(
      "https://api.resend.com/emails",
      {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          from,
          to: [to],
          subject: crisis ? "【blesc】至急の確認をお願いします" : "【blesc】確認をお願いします",
          text,
        }),
      },
      SEND_TIMEOUT_MS,
    );
    if (!response.ok) {
      return { status: "failed", error: `resend ${response.status}`, channel: "email" };
    }
    return { status: "delivered", channel: "email" };
  } catch (error) {
    return {
      status: "failed",
      error: error instanceof Error ? error.message : "email request failed",
      channel: "email",
    };
  }
}

export function channelsConfigured(): boolean {
  return Boolean(
    process.env.SAFETY_ALERT_WEBHOOK_URL ||
      (process.env.RESEND_API_KEY && process.env.SAFETY_ALERT_EMAIL_FROM),
  );
}

/**
 * Try to deliver one escalation, and record what happened either way.
 *
 * The status it leaves behind is the contract with `/api/safety/dispatch`:
 *
 *   `delivered`     at least one recipient was reached
 *   `failed`        recipients exist and every send failed — retry
 *   `no_recipient`  nobody may be told, or no channel is configured
 *   `pending`       untouched; the dispatcher will pick it up
 *
 * `no_recipient` is not success and is not silence. It means a student is in
 * crisis and this deployment has nowhere to send it, which is a configuration
 * emergency — so it is logged as an error and left visible in the table.
 */
export async function deliverEscalation(
  service: SupabaseClient,
  escalation: EscalationRow,
  participantCode: string | null,
): Promise<"delivered" | "failed" | "no_recipient"> {
  const recipients = await recipientsFor(service, escalation.participant_id);
  const text = notificationText(escalation, participantCode);
  const crisis = escalation.risk_level === "crisis";

  const deliveries: Array<{
    escalation_id: string;
    recipient_user_id: string | null;
    channel: string;
    recipient_hash: string | null;
    status: string;
    error: string | null;
  }> = [];
  let anyDelivered = false;
  let anyAttempt = false;

  // The webhook is addressed to the school, not to a person, so it fires once
  // regardless of how many educators are on the roster.
  const webhook = await sendWebhook(text);
  if (webhook) {
    anyAttempt = true;
    anyDelivered ||= webhook.status === "delivered";
    deliveries.push({
      escalation_id: escalation.id,
      recipient_user_id: null,
      channel: webhook.channel,
      recipient_hash: null,
      status: webhook.status,
      error: webhook.error ?? null,
    });
  }

  for (const recipient of recipients) {
    if (!recipient.email) continue;
    const outcome = await sendEmail(recipient.email, text, crisis);
    if (!outcome) continue;
    anyAttempt = true;
    anyDelivered ||= outcome.status === "delivered";
    deliveries.push({
      escalation_id: escalation.id,
      recipient_user_id: recipient.educator_user_id,
      channel: outcome.channel,
      recipient_hash: await hashAddress(recipient.email),
      status: outcome.status,
      error: outcome.error ?? null,
    });
  }

  if (deliveries.length > 0) {
    const written = await service.from("safety_escalation_deliveries").insert(deliveries);
    if (written.error) {
      console.error("[safety-escalation] delivery log not written", written.error.message);
    }
  }

  let status: "delivered" | "failed" | "no_recipient";
  if (anyDelivered) status = "delivered";
  else if (anyAttempt) status = "failed";
  else status = "no_recipient";

  if (status === "no_recipient") {
    console.error(
      "[safety-escalation] NOWHERE TO SEND A CRISIS ESCALATION. " +
        "Set SAFETY_ALERT_WEBHOOK_URL, or RESEND_API_KEY with SAFETY_ALERT_EMAIL_FROM, " +
        "and confirm this participant has an educator with active oversight consent.",
      { escalation: escalation.id, recipients: recipients.length, channels: channelsConfigured() },
    );
  }

  const update = await service
    .from("safety_escalations")
    .update({
      status,
      attempts: escalation.attempts + 1,
      last_attempt_at: new Date().toISOString(),
      last_error: status === "delivered" ? null : deliveries.find((d) => d.error)?.error ?? "no channel or recipient",
      delivered_at: status === "delivered" ? new Date().toISOString() : null,
    })
    .eq("id", escalation.id);
  if (update.error) console.error("[safety-escalation] status not updated", update.error.message);

  return status;
}

/**
 * Record and try to send, without making the student wait for a mail provider.
 *
 * The write is awaited. The send is started and deliberately not awaited by the
 * caller's response path — `/api/safety/dispatch` is what guarantees it, and a
 * student in crisis should not be watching a spinner while a school's SMTP
 * server decides.
 */
export async function escalate(
  service: SupabaseClient,
  input: EscalationInput,
): Promise<EscalationRow | null> {
  const escalation = await recordEscalation(service, input);
  if (!escalation) return null;
  void deliverEscalation(service, escalation, input.participantCode).catch((error: unknown) => {
    console.error(
      "[safety-escalation] delivery threw; the row stays pending for the dispatcher",
      error instanceof Error ? error.message : error,
    );
  });
  return escalation;
}
