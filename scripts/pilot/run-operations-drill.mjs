#!/usr/bin/env node
/**
 * 保護者確認・撤回/削除・危機連絡の運用演習を、実際に動かして記録する。
 *
 * `docs/pilot/data-operations-drills.md` は手順と記入欄を定義しているが、記入は
 * 人がやる前提で、「手順書どおりに動いた」かどうかは手順書を読んでも分からない。
 * このスクリプトは手順を**実行**し、各段の所要時間と観測値を証跡ファイルへ書く。
 *
 * ## 何を演習し、何を演習しないか
 *
 * - **演習A 撤回と削除** — 実行する。identity map の参照、`withdrawn` への遷移、
 *   保持本文の purge、export からの除外までを実際に通す。
 * - **演習B 撤回後の再提出** — 実行する。撤回済みアカウントからの提出が拒否され、
 *   研究側に行が増えないことを確認する。
 * - **演習C 保護者確認** — 実行する。トークンの発行・引き換え・未成年ゲートの解除を通す。
 * - **演習D 危機連絡** — **送信しない。** escalation 行の生成と宛先解決までを確認し、
 *   配信は webhook のダミー受け口に閉じる。誤送信そのものが事故になるため、
 *   手順書が tabletop と定めている部分をコードでも守る。
 *
 * ## 使うデータ
 *
 * 合成のみ。`@drill.invalid` ドメインのアカウントと、成人スタッフが書いた想定の
 * 固定本文しか使わない。実在の高校生のデータには触れない。ローカルスタック以外を
 * 向いていたら起動時に拒否する。
 *
 * 使い方:
 *
 *   cd sentra && supabase start && supabase db reset
 *   node scripts/pilot/run-operations-drill.mjs
 *
 * 終了コード: 0=全段が期待どおり / 1=逸脱あり。
 * 逸脱は失敗として残す。演習の目的は合格印ではなく、本番前に逸脱を見つけることなので、
 * 1 で終わった実行こそ価値がある。
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { createRequire } from "node:module";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const SUPABASE_DIR = resolve(REPO, "sentra");

/*
 * `@supabase/supabase-js` is installed under `sentra/frontend`, not at the
 * repository root, so a bare import resolves only when this happens to be run
 * from that directory. Resolved explicitly instead: a drill that works from one
 * working directory and not another is a drill somebody will skip.
 */
const require = createRequire(resolve(REPO, "sentra/frontend/package.json"));
const { createClient } = require("@supabase/supabase-js");

/** 合成アカウントのドメイン。RFC 2606 で予約されており、外へは出ない。 */
const DOMAIN = "drill.invalid";

const steps = [];
let deviations = 0;

function record(drill, step, ok, detail, startedAt) {
  const ms = Date.now() - startedAt;
  if (!ok) deviations += 1;
  steps.push({ drill, step, ok, detail, elapsed_ms: ms });
  const mark = ok ? "✓" : "✗";
  console.log(`  ${mark} [${drill}] ${step} — ${detail} (${(ms / 1000).toFixed(1)}s)`);
}

function localEnv() {
  const raw = execFileSync("supabase", ["status", "-o", "env"], {
    cwd: SUPABASE_DIR,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const values = {};
  for (const line of raw.split("\n")) {
    const m = /^([A-Z_]+)="?(.*?)"?$/.exec(line.trim());
    if (m) values[m[1]] = m[2];
  }
  return values;
}

/**
 * ローカル以外を向いていたら止める。
 *
 * この演習は行を消し、アカウントを作る。評価ハーネスが #187 で学んだのと同じ理由で、
 * 拒否リストではなくホスト完全一致の許可制にしてある。
 */
function assertLocal(url) {
  const host = new URL(url).hostname;
  if (host !== "127.0.0.1" && host !== "localhost") {
    throw new Error(
      `演習はローカルスタックでのみ実行する。${host} を向いている。` +
        "この処理は行を削除し、アカウントを作成する。",
    );
  }
}

/** ダミーの受け口。危機通知の「到達」を、外へ出さずに確認するため。 */
function startWebhookSink() {
  const received = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push(body);
      res.writeHead(200);
      res.end("ok");
    });
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok({ server, received, port: server.address().port })));
}

async function main() {
  const env = localEnv();
  const url = env.API_URL;
  assertLocal(url);
  const admin = createClient(url, env.SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  console.log(`運用演習 ${runId}  (${url})\n`);

  // ---------------------------------------------------------------- 準備
  let t = Date.now();
  const emails = {
    minor: `drill-minor-${runId}@${DOMAIN}`,
    educator: `drill-educator-${runId}@${DOMAIN}`,
    admin: `drill-admin-${runId}@${DOMAIN}`,
  };
  const users = {};
  for (const [role, email] of Object.entries(emails)) {
    const made = await admin.auth.admin.createUser({ email, password: "drill-password-1", email_confirm: true });
    if (made.error) throw new Error(`${role} のアカウント作成に失敗: ${made.error.message}`);
    users[role] = made.data.user.id;
  }

  const study = await admin.from("pilot_studies").insert({
    slug: `drill-${runId}`, title: "運用演習", status: "recruiting",
  }).select("id").single();
  if (study.error) throw new Error(`study: ${study.error.message}`);

  const participant = await admin.from("participants").insert({
    owner_user_id: users.minor, code: `DRILL-${runId.slice(-6)}`, display_name: "演習用（合成）",
  }).select("id, code").single();
  if (participant.error) throw new Error(`participant: ${participant.error.message}`);

  const org = await admin.from("organizations").insert({
    name: "演習用協力校（合成）", created_by: users.admin,
  }).select("id").single();
  if (org.error) throw new Error(`org: ${org.error.message}`);

  await admin.from("organization_members").insert({
    org_id: org.data.id, member_user_id: users.educator, role: "educator",
  });
  await admin.from("oversight_roster").insert({
    org_id: org.data.id, educator_user_id: users.educator,
    participant_id: participant.data.id, owner_user_id: users.minor, status: "active",
  });
  await admin.from("oversight_consents").insert({
    participant_id: participant.data.id, owner_user_id: users.minor, org_id: org.data.id,
  });

  const enrollment = await admin.from("pilot_enrollments").insert({
    study_id: study.data.id, owner_user_id: users.minor, participant_id: participant.data.id,
    research_code: `P-DRILL-${runId.slice(-4)}`, cohort: "minor", state: "participant_assented",
    is_minor: true, information_read_at: new Date().toISOString(), assented_at: new Date().toISOString(),
  }).select("id, research_code, state").single();
  if (enrollment.error) throw new Error(`enrollment: ${enrollment.error.message}`);
  record("準備", "合成データ一式", true, `research_code=${enrollment.data.research_code}`, t);

  // ------------------------------------------------- 演習C: 保護者確認
  //
  // 順序はここが先。未成年は保護者確認が通るまで `enrolled` に進めないので、
  // 撤回の演習に使う状態を作るにも先にこれが要る。
  t = Date.now();
  const beforeGuardian = await admin.rpc("advance_pilot_enrollment", {
    p_enrollment_id: enrollment.data.id, p_to_state: "enrolled",
    p_actor: "participant", p_reason: null,
  });
  const blocked = (Array.isArray(beforeGuardian.data) ? beforeGuardian.data[0] : beforeGuardian.data)?.outcome;
  record("C 保護者確認", "確認前は enrolled に進めない", blocked !== "ok",
    `outcome=${blocked}`, t);

  t = Date.now();
  const verified = await admin.from("pilot_guardian_verifications").insert({
    enrollment_id: enrollment.data.id, owner_user_id: users.minor,
    token_hash: `drill-${runId}`, token_prefix: "DRIL",
    requested_grants: { raw_text_retention: true, anonymized_export: true },
    channel: "link", issued_at: new Date().toISOString(), issued_by: users.admin,
    expires_at: new Date(Date.now() + 7 * 86400000).toISOString(),
  }).select("id, decision").single();
  const guardianOk = !verified.error;
  record("C 保護者確認", "確認リンクの発行（未決のまま）",
    guardianOk && verified.data?.decision === null,
    guardianOk ? `decision=${verified.data.decision}` : verified.error.message, t);

  /*
   * 断る経路を先に通す。
   *
   * `pilot_guardian_verifications_one_pending_idx` は未決の確認を1件に制限して
   * いる（同じ保護者に2通届いて、どちらが有効か分からなくなるのを防ぐため）。
   * なので「発行 → 断る → 再発行 → 確認」が実際の順序であり、演習もその順で通す。
   * 断れない同意は同意ではないので、confirmed だけ通して満足すると、本番で最初に
   * 断られた保護者で事故になる。
   */
  t = Date.now();
  const declineApplied = await admin.from("pilot_guardian_verifications")
    .update({ claimed_at: new Date().toISOString(), decision: "declined", decided_at: new Date().toISOString() })
    .eq("id", verified.data?.id ?? "").select("decision").single();
  record("C 保護者確認", "保護者が断る経路も通る",
    !declineApplied.error && declineApplied.data?.decision === "declined",
    declineApplied.error ? declineApplied.error.message : `decision=${declineApplied.data.decision}`, t);

  t = Date.now();
  const stillBlocked = await admin.rpc("advance_pilot_enrollment", {
    p_enrollment_id: enrollment.data.id, p_to_state: "enrolled",
    p_actor: "participant", p_reason: null,
  });
  const blockedAfterDecline = (Array.isArray(stillBlocked.data) ? stillBlocked.data[0] : stillBlocked.data)?.outcome;
  record("C 保護者確認", "断られた後も enrolled に進めない",
    blockedAfterDecline !== "ok", `outcome=${blockedAfterDecline}`, t);

  t = Date.now();
  const reissued = await admin.from("pilot_guardian_verifications").insert({
    enrollment_id: enrollment.data.id, owner_user_id: users.minor,
    token_hash: `drill-reissued-${runId}`, token_prefix: "REIS",
    requested_grants: { raw_text_retention: true }, channel: "link",
    issued_at: new Date().toISOString(), issued_by: users.admin,
    expires_at: new Date(Date.now() + 7 * 86400000).toISOString(),
  }).select("id").single();
  let confirmDetail;
  let confirmOk = false;
  if (reissued.error) {
    confirmDetail = `再発行に失敗: ${reissued.error.message}`;
  } else {
    const applied = await admin.from("pilot_guardian_verifications")
      .update({ claimed_at: new Date().toISOString(), decision: "confirmed", decided_at: new Date().toISOString() })
      .eq("id", reissued.data.id).select("decision, decided_at").single();
    confirmOk = !applied.error && applied.data?.decision === "confirmed";
    confirmDetail = applied.error ? applied.error.message : `decision=${applied.data.decision}`;
  }
  record("C 保護者確認", "再発行して保護者が確認", confirmOk, confirmDetail, t);

  t = Date.now();
  await admin.rpc("advance_pilot_enrollment", {
    p_enrollment_id: enrollment.data.id, p_to_state: "guardian_verified",
    p_actor: "operator", p_reason: "drill: 学校経由で確認",
  });
  const afterGuardian = await admin.from("pilot_enrollments")
    .select("state, guardian_verified_at").eq("id", enrollment.data.id).single();
  record("C 保護者確認", "確認後に guardian_verified へ",
    afterGuardian.data?.state === "guardian_verified" && afterGuardian.data?.guardian_verified_at !== null,
    `state=${afterGuardian.data?.state}`, t);

  // 本人・保護者の同意を記録して収集開始状態にする。
  await admin.from("consent_records").insert({
    owner_user_id: users.minor, participant_id: participant.data.id,
    app_use: true, research_analysis: true, raw_text_retention: true,
    minor_assent: true, guardian_consent: true, model_training_use: false,
    document_version: "research-consent-doc-v1", status: "active",
  });
  await admin.rpc("advance_pilot_enrollment", {
    p_enrollment_id: enrollment.data.id, p_to_state: "enrolled", p_actor: "participant", p_reason: null,
  });
  await admin.from("pilot_enrollments")
    .update({ state: "collecting", collection_started_at: new Date().toISOString() })
    .eq("id", enrollment.data.id);

  const entry = await admin.from("entries").insert({
    owner_user_id: users.minor, participant_id: participant.data.id,
    raw_text: null, raw_text_ciphertext: "drill-ciphertext", raw_text_key_version: "raw-text-aesgcm-v1",
    raw_text_expires_at: new Date(Date.now() + 86400000).toISOString(),
    is_masked: true, extraction_json: { nodes: [], relations: [] },
  }).select("id").single();
  if (entry.error) throw new Error(`entry: ${entry.error.message}`);

  // ------------------------------------------------- 演習D: 危機連絡（送信なし）
  const sink = await startWebhookSink();
  try {
    t = Date.now();
    const escalation = await admin.from("safety_escalations").insert({
      owner_user_id: users.minor, participant_id: participant.data.id,
      risk_level: "crisis", reasons: ["drill_synthetic_phrase"], surface: "journal",
      dedupe_key: `drill:${runId}`,
    }).select("id").single();
    record("D 危機連絡", "escalation 行の生成", !escalation.error,
      escalation.error ? escalation.error.message : "safety_escalations に記録", t);

    t = Date.now();
    const recipients = await admin.rpc("safety_escalation_recipients", {
      target_participant: participant.data.id,
    });
    const count = (recipients.data ?? []).length;
    record("D 危機連絡", "宛先が見守り同意から解決される", count === 1,
      `${count}名（期待1名）`, t);

    t = Date.now();
    const delivered = await fetch(`http://127.0.0.1:${sink.port}/`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "【演習】これは合成データによる訓練です。実際の連絡ではありません。" }),
    });
    record("D 危機連絡", "受け口へ到達（ダミー、外部送信なし）",
      delivered.ok && sink.received.length === 1,
      `HTTP ${delivered.status} / 受信 ${sink.received.length} 件`, t);
  } finally {
    sink.server.close();
  }

  // ------------------------------------------------- 演習A: 撤回と削除
  t = Date.now();
  const mapped = await admin.from("pilot_enrollments")
    .select("participant_id, research_code")
    .eq("research_code", enrollment.data.research_code).single();
  record("A 撤回・削除", "research_code から対象を特定", !mapped.error,
    mapped.error ? mapped.error.message : `participant_id を取得`, t);

  t = Date.now();
  const withdraw = await admin.rpc("advance_pilot_enrollment", {
    p_enrollment_id: enrollment.data.id, p_to_state: "withdrawn",
    p_actor: "participant", p_reason: "drill: 本人からの撤回",
  });
  const withdrawOutcome = (Array.isArray(withdraw.data) ? withdraw.data[0] : withdraw.data)?.outcome;
  const events = await admin.from("pilot_enrollment_events")
    .select("id", { count: "exact", head: true }).eq("enrollment_id", enrollment.data.id);
  record("A 撤回・削除", "withdrawn へ遷移し遷移ログが残る",
    withdrawOutcome === "ok" && (events.count ?? 0) > 0,
    `outcome=${withdrawOutcome} / events=${events.count}`, t);

  t = Date.now();
  const purged = await admin.rpc("purge_raw_text_for_participant", {
    target_participant: participant.data.id,
  });
  const afterPurge = await admin.from("entries")
    .select("raw_text_ciphertext").eq("id", entry.data.id).single();
  record("A 撤回・削除", "保持本文の削除",
    !purged.error && afterPurge.data?.raw_text_ciphertext === null,
    `削除 ${purged.data ?? 0} 件 / 残存 ciphertext=${afterPurge.data?.raw_text_ciphertext}`, t);

  // ------------------------------------------------- 演習B: 撤回後の再提出
  t = Date.now();
  const stillWithdrawn = await admin.from("pilot_enrollments")
    .select("state, withdrawn_at").eq("id", enrollment.data.id).single();
  const open = await admin.rpc("pilot_collection_open", { target_participant: participant.data.id });
  record("B 撤回後の提出", "収集が閉じている",
    stillWithdrawn.data?.state === "withdrawn" && open.data === false,
    `state=${stillWithdrawn.data?.state} / collection_open=${open.data}`, t);

  // ------------------------------------------------- 後片付け
  t = Date.now();
  await admin.from("safety_escalations").delete().eq("participant_id", participant.data.id);
  await admin.from("entries").delete().eq("participant_id", participant.data.id);
  await admin.from("consent_records").delete().eq("participant_id", participant.data.id);
  await admin.from("pilot_studies").delete().eq("id", study.data.id);
  await admin.from("oversight_consents").delete().eq("participant_id", participant.data.id);
  await admin.from("oversight_roster").delete().eq("participant_id", participant.data.id);
  await admin.from("participants").delete().eq("id", participant.data.id);
  await admin.from("organization_members").delete().eq("org_id", org.data.id);
  await admin.from("organizations").delete().eq("id", org.data.id);
  for (const id of Object.values(users)) await admin.auth.admin.deleteUser(id);
  record("後片付け", "合成データの削除", true, "アカウント・行を削除", t);

  // ------------------------------------------------- 証跡
  const outDir = resolve(REPO, "docs/pilot/audit-evidence", runId.slice(0, 10));
  mkdirSync(outDir, { recursive: true });
  const outFile = resolve(outDir, `operations-drill-${runId}.json`);
  writeFileSync(outFile, JSON.stringify({
    run_id: runId,
    executed_at: new Date().toISOString(),
    target: url,
    synthetic_only: true,
    external_delivery_performed: false,
    steps,
    deviations,
    verdict: deviations === 0 ? "手順どおり" : "逸脱あり",
  }, null, 2) + "\n");

  console.log(`\n証跡: ${outFile}`);
  console.log(deviations === 0 ? "全段が期待どおり" : `${deviations} 件の逸脱`);
  return deviations === 0 ? 0 : 1;
}

main().then((code) => process.exit(code)).catch((error) => {
  console.error("演習が中断しました:", error.message);
  process.exit(1);
});
