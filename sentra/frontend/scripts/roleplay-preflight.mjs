/**
 * Read-only preflight for the 4-person role-play on a real deployment.
 *
 *   SITE_URL=https://blesc.online \
 *   NEXT_PUBLIC_SUPABASE_URL=https://<ref>.supabase.co \
 *   NEXT_PUBLIC_SUPABASE_ANON_KEY=<publishable/anon key> \
 *   node scripts/roleplay-preflight.mjs
 *
 * Writes nothing, signs nobody in, and needs no service-role key. It answers
 * the questions that decide whether the role-play can start, in the order a
 * failure blocks the next:
 *
 *   1. Does the Supabase host resolve at all? (NXDOMAIN = project gone/renamed)
 *   2. Is auth up, and is email/password sign-in enabled?
 *   3. Are the tables and RPCs the role-play uses present (migrations applied)?
 *   4. Does the deployment report the env it needs (`/api/health`, booleans)?
 *   5. Is the build that carries the teacher's daily-submission view deployed?
 *
 * The anon key is public by design (it ships in the browser bundle), so
 * passing it here discloses nothing new. A table that exists but refuses the
 * anon role is reported as present: that refusal is RLS/grants working.
 */

import { lookup } from "node:dns/promises";

const SITE_URL = (process.env.SITE_URL ?? "").replace(/\/$/, "");
const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "").replace(/\/$/, "");
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

/** Tables and RPCs the five must-have flows touch, oldest to newest migration. */
export const REQUIRED_TABLES = [
  "participants", "entries", "insights", "model_runs",
  "organizations", "organization_members", "oversight_roster", "oversight_consents",
  "educator_access_log", "safety_escalations", "legal_acceptances",
];
// Only no-argument RPCs: PostgREST answers PGRST202 for a signature mismatch too,
// which would read as "missing".
export const REQUIRED_RPCS = ["overseen_participants"];

/**
 * PostgREST status → whether the relation exists.
 * 404 with PGRST205/PGRST202 (or 42P01/42883) means it does not; 200, 401 and
 * 403 all mean it does and the anon role was merely answered or refused.
 */
export function classifyProbe(status, body) {
  const code = typeof body?.code === "string" ? body.code : "";
  if (status === 404 || ["PGRST205", "PGRST202", "42P01", "42883"].includes(code)) return "missing";
  if (status === 200 || status === 401 || status === 403 || code === "42501") return "present";
  if (status === 400 && code.startsWith("PGRST1")) return "present"; // bad args to an existing RPC
  return "unknown";
}

/** `/api/health` config → the problems that block the role-play. */
export function healthProblems(config) {
  const problems = [];
  if (!config) return ["/api/health did not answer with a config block"];
  if (!config.supabase_url || !config.supabase_anon_key) problems.push("Supabase URL / anon key not set on the deployment");
  if (!config.supabase_service_role_key) problems.push("SUPABASE_SERVICE_ROLE_KEY not set: every diary save returns 502");
  if (config.external_api_url) problems.push("NEXT_PUBLIC_API_URL is set: entries go to FastAPI instead of the route handler");
  if (config.mock_llm) problems.push("USE_MOCK_LLM=true");
  return problems;
}

async function fetchJson(url, init = {}) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(15000) });
  let body = null;
  try { body = await response.json(); } catch { /* not JSON */ }
  return { status: response.status, body };
}

async function main() {
  const report = [];
  const add = (level, name, detail = "") => {
    report.push({ level, name, detail });
    console.log(`${level.padEnd(4)} ${name}${detail ? ` — ${detail}` : ""}`);
  };
  if (!SITE_URL || !SUPABASE_URL || !ANON_KEY) {
    console.error("Set SITE_URL, NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.");
    process.exit(2);
  }

  // 1. DNS
  const host = new URL(SUPABASE_URL).hostname;
  let resolved = false;
  try {
    const { address } = await lookup(host);
    add("OK", `DNS ${host}`, address);
    resolved = true;
  } catch (error) {
    add("FAIL", `DNS ${host}`, `${error.code ?? error.message} — the project is deleted, paused past recovery, or the URL is wrong`);
  }

  if (resolved) {
    const headers = { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` };
    // 2. Auth
    try {
      const health = await fetchJson(`${SUPABASE_URL}/auth/v1/health`, { headers });
      add(health.status === 200 ? "OK" : "FAIL", "auth health", `HTTP ${health.status}`);
      const settings = await fetchJson(`${SUPABASE_URL}/auth/v1/settings`, { headers });
      const email = settings.body?.external?.email;
      add(email ? "OK" : "FAIL", "email/password sign-in enabled", String(email));
    } catch (error) {
      add("FAIL", "auth reachable", error.message);
    }
    // 3. Schema
    for (const table of REQUIRED_TABLES) {
      try {
        const probe = await fetchJson(`${SUPABASE_URL}/rest/v1/${table}?select=*&limit=0`, { headers });
        const state = classifyProbe(probe.status, probe.body);
        add(state === "present" ? "OK" : state === "missing" ? "FAIL" : "WARN", `table ${table}`, `HTTP ${probe.status} ${probe.body?.code ?? ""}`.trim());
      } catch (error) {
        add("FAIL", `table ${table}`, error.message);
      }
    }
    for (const rpc of REQUIRED_RPCS) {
      try {
        const probe = await fetchJson(`${SUPABASE_URL}/rest/v1/rpc/${rpc}`, {
          method: "POST", headers: { ...headers, "content-type": "application/json" }, body: "{}",
        });
        const state = classifyProbe(probe.status, probe.body);
        add(state === "present" ? "OK" : state === "missing" ? "FAIL" : "WARN", `rpc ${rpc}`, `HTTP ${probe.status} ${probe.body?.code ?? ""}`.trim());
      } catch (error) {
        add("FAIL", `rpc ${rpc}`, error.message);
      }
    }
  }

  // 4. Deployment env
  try {
    const health = await fetchJson(`${SITE_URL}/api/health`);
    const problems = healthProblems(health.body?.config);
    add(problems.length ? "FAIL" : "OK", "deployment env (/api/health)", problems.join("; ") || `commit ${health.body?.commit ?? "?"}`);
    add(health.body?.config?.openai_api_key ? "OK" : "WARN", "OpenAI key (chat/voice only)", health.body?.config?.openai_api_key ? "set" : "not set: chat answers a fixed sentence, voice returns 503");
  } catch (error) {
    add("FAIL", "deployment reachable", error.message);
  }

  // 5. Feature build
  try {
    const page = await fetch(`${SITE_URL}/educator/roster`, { redirect: "manual", signal: AbortSignal.timeout(15000) });
    const html = page.status === 200 ? await page.text() : "";
    const login = await fetch(`${SITE_URL}/login`, { signal: AbortSignal.timeout(15000) });
    const loginHtml = await login.text();
    const chunks = [...new Set([...(html + loginHtml).matchAll(/\/_next\/static\/[^"']+\.js/g)].map((m) => m[0]))];
    let found = false;
    for (const chunk of chunks) {
      const js = await (await fetch(`${SITE_URL}${chunk}`, { signal: AbortSignal.timeout(15000) })).text();
      if (js.includes("毎日の提出")) { found = true; break; }
    }
    add(found ? "OK" : "WARN", "daily-submission view deployed", found ? "found in bundle" : `not found in ${chunks.length} chunks reachable without login (may be lazy-loaded; check /educator/roster after signing in)`);
  } catch (error) {
    add("WARN", "daily-submission view deployed", error.message);
  }

  const failed = report.filter((r) => r.level === "FAIL").length;
  console.log(`\n${failed ? `NOT READY: ${failed} blocking problem(s)` : "READY for the role-play preconditions checked here"}`);
  process.exit(failed ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
