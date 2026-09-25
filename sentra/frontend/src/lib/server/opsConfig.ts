/**
 * What this deployment is missing, named before it is needed.
 *
 * Every value below fails closed, and failing closed is the problem: a
 * deployment with no `CRON_SECRET` answers 403 to its own scheduler, logs one
 * line nobody reads, and looks exactly like a deployment where nothing needed
 * purging. The audit of 2026-09-18 listed four such settings and could only
 * describe them in prose, because nothing in the app could be asked.
 *
 * This module is that question. It reports **configured / not configured** and,
 * where a value has a shape, whether it holds — never the value itself. The
 * tests in `tests/pilot-ops-config.test.mjs` assert the second half of that
 * sentence, because a diagnostic that leaks a secret is worse than no
 * diagnostic.
 *
 * ## Why the env names are written out literally
 *
 * `NEXT_PUBLIC_PILOT_MODE` is inlined by the bundler at **build** time, so the
 * only way to report the value the running bundle was compiled with is to write
 * `process.env.NEXT_PUBLIC_PILOT_MODE` as a literal expression. Reading it
 * through a variable key would give whatever the environment happens to hold
 * now — which, for a variable added after the last deploy, is a lie: the
 * `/demo-view` rewrite in `next.config.ts` is baked into the build and would
 * still be absent. The rest are server-side and read at request time, but they
 * are written the same way so the file has one rule instead of two.
 *
 * Nothing here can see GitHub. `PILOT_BASE_URL` and `SAFETY_DISPATCH_TOKEN`
 * live in repository secrets, and a Vercel function has no standing to ask
 * about them — `scripts/pilot/check-ops-config.mjs` does, with `gh`.
 */

import { KEY_RULES, base64KeyAdvice, readBase64Key, type Base64KeyRule } from "./base64Key.ts";

export type Severity = "blocking" | "degraded";

export type ConfigCheck = {
  /** The environment variable, so the fix is unambiguous. */
  name: string;
  /** Present at all. */
  configured: boolean;
  /**
   * Present *and* the right shape. Equal to `configured` for values that have
   * no shape to check — a token is whatever it is.
   */
  valid: boolean;
  severity: Severity;
  /** What is untrue about the deployment while this is unset. In Japanese,
   *  because the person reading an ops report during the pilot is. */
  consequence: string;
};

/**
 * A base64 key, checked against the rule the code that reads it actually
 * applies (#255).
 *
 * The rule used to be restated here as "at least 32 bytes" for everything,
 * which was wrong twice over. `Buffer.from(value, "base64")` does not throw on
 * a value that is not base64 — it drops the offending characters — so the
 * `try`/`catch` this replaced never ran; and `rawTextKeyMaterial()` wants
 * *exactly* 32 bytes, so a 48-byte value was reported valid by a diagnostic
 * whose own header promises to tell "absent" from "malformed", while retention
 * was silently off. The rule now lives in `base64Key.ts` and each row below
 * names the same rule its loader uses.
 */
function base64Key(value: string | undefined, rule: Base64KeyRule, consequence: string) {
  const result = readBase64Key(value, rule);
  return {
    // "Somebody put something here", which whitespace is not. Reporting
    // `configured: true` alongside advice that reads 「未設定。」 would be the
    // report contradicting itself in the same row.
    configured: result.ok || result.problem !== "absent",
    valid: result.ok,
    // The advice is about the shape, never the value: `base64KeyAdvice` cannot
    // return anything derived from what was configured.
    consequence: result.ok ? consequence : `${consequence} ${base64KeyAdvice(result.problem)}`,
  };
}

function idListSize(value: string | undefined): number {
  return (value ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean).length;
}

/**
 * Every setting the pilot deployment needs, with what breaks without it.
 *
 * `blocking` means a promise the participant documents make is not being kept:
 * schedules that do not run, crises with nowhere to go, a demo UI still served
 * from the URL a school was given. `degraded` means the system works and the
 * record of it is thinner than designed.
 */
export function configChecks(): ConfigCheck[] {
  const alertChannel = Boolean(
    process.env.SAFETY_ALERT_WEBHOOK_URL ||
      (process.env.RESEND_API_KEY && process.env.SAFETY_ALERT_EMAIL_FROM),
  );

  return [
    {
      name: "CRON_SECRET",
      configured: Boolean(process.env.CRON_SECRET),
      valid: Boolean(process.env.CRON_SECRET),
      severity: "blocking",
      consequence:
        "Vercel cron が全て403。保持期限切れ本文のpurgeも、危機通知の日次backstopも走らない。",
    },
    {
      name: "SAFETY_DISPATCH_TOKEN",
      configured: Boolean(process.env.SAFETY_DISPATCH_TOKEN),
      valid: Boolean(process.env.SAFETY_DISPATCH_TOKEN),
      severity: "blocking",
      consequence:
        "5分ごとの再送(GitHub Actions)が403。初回送信に失敗した危機通知が誰にも届かないまま残る。",
    },
    {
      // One name per row, even though this row has two ways to be satisfied:
      // the field is an identifier an operator pastes into a console, and a row
      // reading "A / B + C" is not something anyone can paste.
      name: "SAFETY_ALERT_WEBHOOK_URL",
      configured: alertChannel,
      valid: alertChannel,
      severity: "blocking",
      consequence:
        "危機通知の宛先が無い。escalationは記録されるが、誰にも届かない。" +
        "webhookの代わりに RESEND_API_KEY と SAFETY_ALERT_EMAIL_FROM の両方でも可。",
    },
    {
      name: "NEXT_PUBLIC_PILOT_MODE",
      configured: process.env.NEXT_PUBLIC_PILOT_MODE === "1",
      valid: process.env.NEXT_PUBLIC_PILOT_MODE === "1",
      severity: "blocking",
      consequence:
        "専用デプロイで /demo-view とURL/sessionのデモ上書きが生きたままになる(#193)。ビルド時に必要で、後から足しても再デプロイまで効かない。",
    },
    {
      name: "SAFETY_RECIPIENT_HASH_KEY",
      // `recipientHashKey()` — 32 バイト以上。
      ...base64Key(
        process.env.SAFETY_RECIPIENT_HASH_KEY,
        KEY_RULES.SAFETY_RECIPIENT_HASH_KEY,
        "通知ログの recipient hash が null。通知は届くが「誰に伝えたか」の記録が残らない。base64で32バイト以上。",
      ),
      severity: "degraded",
    },
    {
      name: "RESEARCH_RAW_TEXT_KEY",
      // `rawTextKeyMaterial()` — AES-256-GCM なので**ちょうど** 32 バイト。
      // ここを「32以上」と書いていたのが #255 の誤報の半分だった。
      ...base64Key(
        process.env.RESEARCH_RAW_TEXT_KEY,
        KEY_RULES.RESEARCH_RAW_TEXT_KEY,
        "日記原文を保持しない(平文保存は起きない)。人手評価が必要なら必須。base64でちょうど32バイト。",
      ),
      severity: "degraded",
    },
    {
      name: "PILOT_OPERATOR_USER_IDS",
      configured: idListSize(process.env.PILOT_OPERATOR_USER_IDS) > 0,
      valid: idListSize(process.env.PILOT_OPERATOR_USER_IDS) > 0,
      severity: "blocking",
      consequence: "招待コードの発行と保護者リンクの発行が誰にもできない(安全側)。",
    },
    {
      name: "RESEARCH_EXPORT_USER_IDS",
      configured: idListSize(process.env.RESEARCH_EXPORT_USER_IDS) > 0,
      valid: idListSize(process.env.RESEARCH_EXPORT_USER_IDS) > 0,
      severity: "degraded",
      consequence: "exportと運用dashboardが誰にも開けない(安全側)。収集中は無くても走る。",
    },
    {
      name: "PILOT_INVITE_HMAC_KEY",
      // `inviteHmacKey()` — 32 バイト以上。ここは「設定されているか」しか
      // 見ていなかったので、`inviteHmacKey()` が null を返す値でも blocking に
      // 上がらなかった。発行も引き換えもできない状態が、blocking gap の一覧に
      // 出てこない状態だった。
      ...base64Key(
        process.env.PILOT_INVITE_HMAC_KEY,
        KEY_RULES.PILOT_INVITE_HMAC_KEY,
        "招待コードのhash化ができず、発行も引き換えもできない。base64で32バイト以上。",
      ),
      severity: "blocking",
    },
  ];
}

/** The blocking checks that are not satisfied. Empty is the only acceptable
 *  value on a deployment that is collecting from real participants. */
export function blockingGaps(checks: ConfigCheck[] = configChecks()): ConfigCheck[] {
  return checks.filter((check) => check.severity === "blocking" && !check.valid);
}

/**
 * Minutes since the oldest still-owed escalation was recorded.
 *
 * This, not the presence of a token, is the evidence that the retry is running:
 * a queue whose oldest member is forty minutes old is a queue nothing is
 * draining, whatever the configuration claims. Null when nothing is owed.
 */
export function oldestOwedMinutes(createdAt: Array<string | null>, now: string | Date): number | null {
  const nowMs = (now instanceof Date ? now : new Date(now)).getTime();
  let oldest: number | null = null;
  for (const stamp of createdAt) {
    if (!stamp) continue;
    const ms = new Date(stamp).getTime();
    if (Number.isNaN(ms)) continue;
    if (oldest === null || ms < oldest) oldest = ms;
  }
  if (oldest === null) return null;
  return Math.max(0, Math.round((nowMs - oldest) / 60_000));
}

/**
 * Whether the five-minute retry is actually happening.
 *
 * Thirty minutes, not five: GitHub's scheduler is best-effort and queues under
 * load, so a single late run is normal and calling it a failure would train
 * everyone to ignore the field. Six missed windows is not scheduler jitter.
 */
export const DISPATCH_STALE_MINUTES = 30;
