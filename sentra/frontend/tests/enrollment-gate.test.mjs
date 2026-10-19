/**
 * `POST /api/chat` and the voice routes ask the enrollment gate (#344).
 *
 * Before this, only `/journal` and `POST /api/entries` asked it, so a withdrawn
 * participant on a pilot deployment could keep talking to the model — and their
 * text went to OpenAI *because* they were withdrawn: no window was open, so
 * collection-only mode did not apply.
 *
 * The handlers are called through `route-loader.mjs` against an in-memory
 * Supabase, and `fetch` is replaced so a call to OpenAI is observed, not
 * inferred.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";

import { setServiceClient, setSignedInUser } from "./helpers/route-loader.mjs";
import { fakeSupabase } from "./helpers/fake-supabase.mjs";

const { NextRequest } = await import("next/server.js");
const chat = await import("../src/app/api/chat/route.ts");
const realtime = await import("../src/app/api/voice/realtime-session/route.ts");
const transcriptions = await import("../src/app/api/audio/transcriptions/route.ts");
const { redirectFor } = await import("../src/lib/server/pilotGate.ts");
const { enrollmentGate } = await import("../src/lib/server/enrollmentGate.ts");

const USER = "user-alice";
const PARTICIPANT = { id: "participant-1", code: "P-001", owner_user_id: USER };
const STUDY = { id: "study-1", slug: "pilot-2026", status: "active" };

const enrollment = (state) => ({
  id: "enrollment-1",
  owner_user_id: USER,
  study_id: STUDY.id,
  state,
  is_minor: false,
});

let fetches;
let realFetch;
let env;
let quiet;

beforeEach(() => {
  fetches = [];
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    fetches.push(String(url));
    return new Response(JSON.stringify({}), { status: 500 });
  };
  env = { ...process.env };
  process.env.OPENAI_API_KEY = "sk-test";
  quiet = { warn: console.warn, error: console.error };
  console.warn = () => {};
  console.error = () => {};
});

afterEach(() => {
  globalThis.fetch = realFetch;
  process.env = env;
  console.warn = quiet.warn;
  console.error = quiet.error;
  setServiceClient(null);
  setSignedInUser(null);
});

function pilot() {
  process.env.PILOT_STUDY_SLUG = STUDY.slug;
  process.env.NODE_ENV = "production";
  delete process.env.NEXT_PUBLIC_DEMO_MODE;
}

/** The service-role client: the gate's tables, the counter, the escalation rows. */
function service({ enrollments = [], open = true } = {}) {
  return fakeSupabase({
    tables: {
      pilot_studies: [STUDY],
      pilot_enrollments: enrollments,
      participants: [PARTICIPANT],
      safety_escalations: [],
    },
    defaults: { safety_escalations: (n) => ({ id: `escalation-${n + 1}`, status: "pending", attempts: 0 }) },
    rpc: {
      bump_rate_limit: () => ({ data: 1, error: null }),
      pilot_collection_open: () => ({ data: open, error: null }),
      safety_escalation_recipients: () => ({ data: [], error: null }),
    },
  });
}

/** The caller's own client, where the chat route reads the participant. */
const own = () => fakeSupabase({ tables: { participants: [PARTICIPANT], chat_messages: [] } });

const post = (url, body) =>
  new NextRequest(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const say = (message) => chat.POST(post("/api/chat", { participant_code: PARTICIPANT.code, message }));
const openAICalls = () => fetches.filter((url) => url.includes("api.openai.com"));

describe("POST /api/chat on a pilot deployment (#344)", () => {
  const refused = {
    withdrawn: [enrollment("withdrawn")],
    completed: [enrollment("completed")],
    "enrolled, before the window": [enrollment("enrolled")],
    "never enrolled": [],
  };

  for (const [label, enrollments] of Object.entries(refused)) {
    it(`refuses a ${label} account without calling OpenAI or writing a chat row`, async () => {
      pilot();
      const ownClient = own();
      setServiceClient(service({ enrollments }));
      setSignedInUser({ id: USER }, ownClient);

      const response = await say("今日は部活の話をしたい");
      assert.equal(response.status, 403);
      const body = await response.json();
      assert.equal(body.redirect, "/pilot/join");
      assert.ok(["no_enrollment", "not_collecting"].includes(body.code), body.code);
      assert.match(body.detail, /[぀-ヿ]/, "the refusal is in Japanese");
      assert.deepEqual(openAICalls(), []);
      assert.equal(ownClient.calls.filter((call) => call.action === "insert").length, 0);
    });
  }

  it("still escalates a crisis from a refused account, and shows the support response", async () => {
    pilot();
    const svc = service({ enrollments: [enrollment("withdrawn")] });
    setServiceClient(svc);
    setSignedInUser({ id: USER }, own());

    const response = await say("もう死にたい");
    assert.equal(response.status, 403);
    const body = await response.json();
    assert.ok(body.safe_response.includes("0120-0-78310"));
    assert.equal(svc.tables.safety_escalations.length, 1, "the crisis was not recorded for anyone to see");
    assert.equal(svc.tables.safety_escalations[0].surface, "chat");
    assert.deepEqual(openAICalls(), []);
  });

  // The admitted path goes on into the conversation, which needs more of
  // Supabase than the fake implements, so these two ask the gate itself — the
  // same call the routes make — rather than running the whole route.
  it("lets a participant inside an open window through the gate", async () => {
    pilot();
    const outcome = await enrollmentGate(USER, PARTICIPANT.id, service({ enrollments: [enrollment("collecting")], open: true }));
    assert.deepEqual(outcome, { allowed: true, reason: "collecting" });
  });

  it("refuses a collecting enrollment whose window has closed", async () => {
    pilot();
    const outcome = await enrollmentGate(USER, PARTICIPANT.id, service({ enrollments: [enrollment("collecting")], open: false }));
    assert.equal(outcome.allowed, false);
  });

  it("changes nothing on a deployment that is not the pilot", async () => {
    delete process.env.PILOT_STUDY_SLUG;
    const outcome = await enrollmentGate(USER, PARTICIPANT.id, service({ enrollments: [] }));
    assert.deepEqual(outcome, { allowed: true, reason: "not_enforced" });
  });
});

describe("the voice routes on a pilot deployment (#344)", () => {
  for (const [name, call] of [
    ["realtime-session", () => realtime.POST(post("/api/voice/realtime-session", {}))],
    ["transcriptions", () => transcriptions.POST(post("/api/audio/transcriptions", {}))],
  ]) {
    it(`${name} refuses a withdrawn account before any model call`, async () => {
      pilot();
      setServiceClient(service({ enrollments: [enrollment("withdrawn")] }));
      setSignedInUser({ id: USER }, own());
      const response = await call();
      assert.equal(response.status, 403);
      assert.equal((await response.json()).redirect, "/pilot/join");
      assert.deepEqual(openAICalls(), []);
    });
  }
});

describe("the screens (#344)", () => {
  it("/chat and /recall have the journal's server-side gate", () => {
    for (const route of ["journal", "chat", "recall"]) {
      const layout = readFileSync(`src/app/${route}/layout.tsx`, "utf8");
      assert.match(layout, new RegExp(`requirePilotCollection\\("/${route}"\\)`), route);
    }
  });

  it("sends a signed-out visitor back to the screen they asked for", () => {
    const outcome = { allowed: false, reason: "no_session", pending: null };
    assert.equal(redirectFor(outcome), "/login?next=%2Fjournal");
    assert.equal(redirectFor(outcome, "/chat"), "/login?next=%2Fchat");
  });
});
