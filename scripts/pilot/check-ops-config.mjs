#!/usr/bin/env node
/**
 * パイロット環境の設定漏れを、宣言ではなく実測で確認する（#194）。
 *
 * 2026-09-18の監査は4件の設定について「未設定かもしれない」としか書けなかった。
 * 誰も聞ける相手がいなかったからで、その状態のまま募集を始めると、
 * 「cronが全部403」「再送が一度も走っていない」が誰にも見えないまま3日が過ぎる。
 *
 * このスクリプトは3方向から確認する。設定の申告だけを信じない:
 *
 *   1. Vercel側   — `GET /api/pilot/admin/ops`（CRON_SECRET bearer）。
 *                   到達できること自体が CRON_SECRET が正しいことの証拠になる。
 *   2. GitHub側   — `gh secret list`。名前と更新日時のみ。値は取得できない（正しい）。
 *   3. 効果の確認 — `/demo-view` が404であること。NEXT_PUBLIC_PILOT_MODE は
 *                   ビルド時に焼き込まれるので、環境変数の有無ではなく
 *                   **配信されている物**を見ないと嘘をつく。後から変数を足して
 *                   再デプロイしていない場合、環境変数は"1"でrewriteは無い。
 *
 * 値は一切表示しない。secretは長さも出さない（長さは総当たりの手掛かりになる）。
 *
 * 使い方:
 *
 *   PILOT_BASE_URL=https://blesc-pilot.vercel.app \
 *   CRON_SECRET=... \
 *   node scripts/pilot/check-ops-config.mjs
 *
 *   node scripts/pilot/check-ops-config.mjs --new-secrets   # 値を生成してファイルへ書く
 *
 * 終了コード: 0=blocking無し / 1=blockingあり / 2=確認できなかった。
 * 2 を 0 として扱わないこと。「聞けなかった」は「問題なし」ではない。
 */

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = "jbjgjf/BLESC";

/** GitHub Actionsのworkflowが読むsecret。値ではなく存在だけを確認する。 */
const REQUIRED_GITHUB_SECRETS = [
  {
    name: "PILOT_BASE_URL",
    consequence: "5分ごとの再送workflowがskipする（redにはならず、logに出るだけ）。",
  },
  {
    name: "SAFETY_DISPATCH_TOKEN",
    consequence: "同上。Vercel側の同名変数と同じ値でなければ403になる。",
  },
];

const RESET = "[0m";
const RED = "[31m";
const YELLOW = "[33m";
const GREEN = "[32m";
const DIM = "[2m";

const mark = (ok) => (ok ? `${GREEN}OK${RESET}` : `${RED}未設定${RESET}`);

function heading(text) {
  console.log(`\n${text}\n${"─".repeat(Math.max(8, text.length))}`);
}

/**
 * 新しい秘密値と、それを入れる手順を生成する。**stdoutには出さない。**
 *
 * 初版はstdoutへ印字し、「端末の外へ出すな」と注意書きを添えていた。
 * これは実際に破られた: このリポジトリの作業はCLIエージェント越しに行われ、
 * その端末のstdoutは会話の記録にそのまま入る。つまり注意書きが想定していた
 * 「端末の中」が、もう閉じた場所ではなかった。生成した3つの値は破棄して
 * 作り直すことになった（未投入だったので実害は無い）。
 *
 * なので既定では0600のファイルへ書き、pathだけを印字する。ファイルは
 * repositoryの外（TMPDIR）に置く。repository内だと、いつか誰かがcommitする。
 * `--stdout` は残してあるが、それは明示的に選ばれた時だけ通る道である。
 *
 * SAFETY_DISPATCH_TOKEN が2箇所に出るのは誤りではない：Vercelが検証する側、
 * GitHubが提示する側で、**同じ値**でなければ403になる。
 */
function newSecrets({ toStdout }) {
  const cron = randomBytes(32).toString("base64");
  const dispatch = randomBytes(32).toString("base64");
  const hash = randomBytes(32).toString("base64");

  // `printf | vercel env add` にしてあるのは、対話入力だと値を画面へ打ち込む
  // ことになるため。dashboardに貼る場合は # の右の値を使う。
  const body = [
    "# BLESC パイロット運用設定 — 投入したらこのファイルを消す。",
    "# repositoryの外に置いてある。commitしないこと。",
    "",
    "# Vercel（専用プロジェクト blesc-pilot / Production）",
    `printf '%s' '${cron}' | vercel env add CRON_SECRET production`,
    `printf '%s' '${dispatch}' | vercel env add SAFETY_DISPATCH_TOKEN production`,
    `printf '%s' '${hash}' | vercel env add SAFETY_RECIPIENT_HASH_KEY production`,
    `printf '%s' '1' | vercel env add NEXT_PUBLIC_PILOT_MODE production`,
    "",
    "# GitHub（SAFETY_DISPATCH_TOKEN はVercel側と同じ値でなければ403）",
    `gh secret set PILOT_BASE_URL --repo ${REPO} --body 'https://blesc-pilot.vercel.app'`,
    `gh secret set SAFETY_DISPATCH_TOKEN --repo ${REPO} --body '${dispatch}'`,
    "",
    "# NEXT_PUBLIC_PILOT_MODE はビルド時に焼き込まれる。投入後に再デプロイすること。",
    "# 確認: PILOT_BASE_URL=... CRON_SECRET=... node scripts/pilot/check-ops-config.mjs",
    "",
  ].join("\n");

  if (toStdout) {
    console.log(`${YELLOW}--stdout が指定された。この出力が残る場所を確認すること。${RESET}`);
    console.log(`${DIM}エージェント越しの端末なら、この時点で値は会話の記録に入っている。${RESET}\n`);
    console.log(body);
    return;
  }

  const path = join(tmpdir(), `blesc-pilot-secrets-${Date.now()}.sh`);
  writeFileSync(path, body, { mode: 0o600 });

  console.log(`秘密値と投入コマンドを書き出した:\n\n  ${path}\n`);
  console.log(`${DIM}0600、repositoryの外。${RESET}`);
  console.log(`${YELLOW}投入したら消すこと:${RESET} rm ${path}`);
  console.log("");
  console.log("順序: Vercel 4件 → 再デプロイ → GitHub 2件 → 確認。");
  console.log(`${DIM}NEXT_PUBLIC_PILOT_MODE はビルド時に焼き込まれるので、再デプロイまで効かない。${RESET}`);
}

function githubSecrets() {
  heading("GitHub repository secrets");
  let listed;
  try {
    listed = execFileSync("gh", ["secret", "list", "--repo", REPO], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    console.log(`${YELLOW}確認できず${RESET}: ${String(error.message).split("\n")[0]}`);
    console.log(`${DIM}gh auth login が必要か、このアカウントに ${REPO} の admin 権限が無い。${RESET}`);
    return { checked: false, missing: [] };
  }

  const names = new Set(
    listed
      .split("\n")
      .map((line) => line.trim().split(/\s+/)[0])
      .filter(Boolean),
  );

  const missing = [];
  for (const secret of REQUIRED_GITHUB_SECRETS) {
    const present = names.has(secret.name);
    if (!present) missing.push(secret.name);
    console.log(`  ${secret.name.padEnd(24)} ${mark(present)}`);
    if (!present) console.log(`    ${DIM}${secret.consequence}${RESET}`);
  }
  return { checked: true, missing };
}

async function deployment(baseUrl, cronSecret) {
  heading(`Vercel deployment  ${baseUrl}`);

  if (!cronSecret) {
    console.log(`${YELLOW}CRON_SECRET が環境に無いので ops を聞けない。${RESET}`);
    console.log(`${DIM}CRON_SECRET=... を付けて再実行する。${RESET}`);
    return { checked: false, blocking: [], stale: false, overdue: null };
  }

  let response;
  try {
    response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/pilot/admin/ops`, {
      headers: { authorization: `Bearer ${cronSecret}` },
    });
  } catch (error) {
    console.log(`${RED}到達できず${RESET}: ${error.message}`);
    return { checked: false, blocking: [], stale: false, overdue: null };
  }

  if (response.status === 403 || response.status === 404) {
    // 403はこのdeploymentのCRON_SECRETと手元の値が違うということ。
    // cronが403になるのと同じ理由なので、これ自体が所見。
    console.log(`${RED}HTTP ${response.status}${RESET} — この deployment の CRON_SECRET と手元の値が一致しない。`);
    console.log(`${DIM}Vercel cron も同じ理由で403になっている。${RESET}`);
    return { checked: false, blocking: ["CRON_SECRET"], stale: false, overdue: null };
  }
  if (!response.ok) {
    console.log(`${RED}HTTP ${response.status}${RESET} — ${(await response.text()).slice(0, 200)}`);
    return { checked: false, blocking: [], stale: false, overdue: null };
  }

  const report = await response.json();

  for (const check of report.config.checks) {
    const state = check.valid
      ? `${GREEN}OK${RESET}`
      : check.configured
        ? `${RED}値が不正${RESET}`
        : check.severity === "blocking"
          ? `${RED}未設定${RESET}`
          : `${YELLOW}未設定${RESET}`;
    console.log(`  ${check.name.padEnd(40)} ${state}`);
    if (!check.valid) console.log(`    ${DIM}${check.consequence}${RESET}`);
  }

  const dispatch = report.observed.safety_dispatch;
  const retention = report.observed.retention_purge;

  heading("実際に動いているか（設定の申告ではなく結果）");
  console.log(
    `  未送信の危機通知        ${dispatch.owed}件` +
      (dispatch.oldest_owed_minutes === null ? "" : ` / 最古 ${dispatch.oldest_owed_minutes}分前`),
  );
  if (dispatch.stale) {
    console.log(
      `    ${RED}${dispatch.stale_after_minutes}分を超えて滞留している。再送が走っていない。${RESET}`,
    );
  }
  if (dispatch.no_recipient > 0) {
    console.log(`  ${RED}宛先不在で終了  ${dispatch.no_recipient}件 — 誰にも届いていない。${RESET}`);
  }
  console.log(`  保持期限切れの本文      ${retention.overdue}件 / 保持中 ${retention.retained_rows}件`);
  if (!retention.healthy) {
    console.log(`    ${RED}purgeが走っていない。参加者に説明した保持期間が守られていない。${RESET}`);
  }
  for (const message of report.observed.read_errors ?? []) {
    console.log(`  ${RED}読めなかった${RESET}: ${message}`);
  }

  return {
    checked: true,
    blocking: report.config.blocking ?? [],
    stale: dispatch.stale || !retention.healthy,
    overdue: retention.overdue,
  };
}

/**
 * NEXT_PUBLIC_PILOT_MODE を環境変数ではなく配信物で確認する。
 *
 * 認証不要。参加者・保護者・学校が開けるURLと同じものを、同じ立場で叩く。
 * 200が返るなら、そのURLを渡された誰もがfixtureのデモUIに入れる（#193）。
 */
async function demoViewClosed(baseUrl) {
  heading("/demo-view（NEXT_PUBLIC_PILOT_MODE の効果を実測）");
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/demo-view`, { redirect: "manual" });
    if (response.status === 404) {
      console.log(`  ${GREEN}404${RESET} — 配信されていない。期待どおり。`);
      return true;
    }
    console.log(`  ${RED}HTTP ${response.status}${RESET} — デモUIがこのURLで生きている。`);
    console.log(
      `    ${DIM}NEXT_PUBLIC_PILOT_MODE=1 を設定し、設定後に再デプロイする（ビルド時に焼き込まれる）。${RESET}`,
    );
    return false;
  } catch (error) {
    console.log(`  ${YELLOW}確認できず${RESET}: ${error.message}`);
    return null;
  }
}

async function main() {
  if (process.argv.includes("--new-secrets")) {
    newSecrets({ toStdout: process.argv.includes("--stdout") });
    return 0;
  }

  const baseUrl = process.env.PILOT_BASE_URL;
  const cronSecret = process.env.CRON_SECRET;

  const github = githubSecrets();

  let deploy = { checked: false, blocking: [], stale: false };
  let demo = null;
  if (baseUrl) {
    deploy = await deployment(baseUrl, cronSecret);
    demo = await demoViewClosed(baseUrl);
  } else {
    heading("Vercel deployment");
    console.log(`${YELLOW}PILOT_BASE_URL が環境に無いので確認していない。${RESET}`);
  }

  heading("判定");
  const problems = [];
  if (github.missing.length > 0) problems.push(`GitHub secrets 未設定: ${github.missing.join(", ")}`);
  if (deploy.blocking.length > 0) problems.push(`Vercel 未設定: ${deploy.blocking.join(", ")}`);
  if (deploy.stale) problems.push("定期実行が結果を出していない");
  if (demo === false) problems.push("/demo-view が配信されている");

  if (problems.length > 0) {
    for (const problem of problems) console.log(`  ${RED}✗${RESET} ${problem}`);
    console.log(`\n${RED}この状態で実参加者の募集を開始しない。${RESET}`);
    return 1;
  }

  const unchecked = [];
  if (!github.checked) unchecked.push("GitHub secrets");
  if (!deploy.checked) unchecked.push("Vercel deployment");
  if (demo === null && baseUrl) unchecked.push("/demo-view");
  if (unchecked.length > 0) {
    console.log(`  ${YELLOW}?${RESET} 確認できなかった: ${unchecked.join(", ")}`);
    console.log(`\n${YELLOW}確認できなかった項目を「問題なし」と記録しない。${RESET}`);
    return 2;
  }

  console.log(`  ${GREEN}✓${RESET} blocking な設定漏れは無い。`);
  console.log(
    `${DIM}承認・当番・演習はこのスクリプトの範囲外。docs/pilot/readiness-audit-2026-09-18.md を参照。${RESET}`,
  );
  return 0;
}

process.exitCode = await main();
