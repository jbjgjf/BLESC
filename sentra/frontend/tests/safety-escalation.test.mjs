import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  dedupeKey,
  deliverEscalation,
  notifiableLevel,
  notificationText,
  recipientHashKey,
  recordEscalation,
} from "../src/lib/server/safetyEscalation.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (path) => readFileSync(resolve(HERE, path), "utf8");

/**
 * Source with comments stripped.
 *
 * The guardrail change left a comment quoting the sentence it removed, because
 * a promise withdrawn without a record invites the next person to restore it.
 * That makes a naive `includes` check find the old wording in the explanation
 * of why the old wording is gone.
 */
const code = (path) =>
  read(path).replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

/**
 * A fake Supabase client, recording what was asked of it.
 *
 * Enough of the builder to answer the three calls this module makes, and no
 * more: a fuller fake would start asserting its own behaviour rather than the
 * module's.
 */
function fakeClient({ insert = {}, rpc = { data: [], error: null } } = {}) {
  const calls = { inserts: [], updates: [], rpc: [] };
  return {
    calls,
    rpc(name, args) {
      calls.rpc.push({ name, args });
      return Promise.resolve(rpc);
    },
    from(table) {
      const builder = {
        insert(rows) {
          calls.inserts.push({ table, rows });
          const outcome = insert[table] ?? { data: { id: "esc-1", attempts: 0 }, error: null };
          return {
            select: () => ({ single: () => Promise.resolve(outcome) }),
            then: (onFulfilled) => Promise.resolve(outcome).then(onFulfilled),
          };
        },
        update(values) {
          calls.updates.push({ table, values });
          return { eq: () => Promise.resolve({ error: null }) };
        },
      };
      return builder;
    },
  };
}

const ESCALATION = {
  id: "esc-1",
  owner_user_id: "owner-1",
  participant_id: "participant-1",
  risk_level: "crisis",
  reasons: ["explicit_self_harm_statement"],
  surface: "chat",
  detected_at: "2026-09-16T17:02:00.000Z",
  status: "pending",
  attempts: 0,
};

/**
 * Run `run()` with these environment variables, then put the environment back.
 *
 * `await run()`, not `return run()`. The synchronous version restored the
 * environment the moment the callback returned a promise, so anything read
 * after the first `await` — which is everything in `deliverEscalation` — saw
 * the original values. Tests that asserted "unset" passed anyway, which is how
 * it went unnoticed until a test needed a variable to be *set*.
 */
async function withEnv(values, run) {
  const saved = {};
  for (const [key, value] of Object.entries(values)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("which levels reach a person", () => {
  it("always escalates a crisis", () => {
    assert.equal(notifiableLevel("crisis"), "crisis");
  });

  it("does not escalate on none or low", () => {
    // An alert that fires on everything is one the recipient learns to ignore,
    // and that lesson is paid for on the night it matters.
    assert.equal(notifiableLevel("none"), null);
    assert.equal(notifiableLevel("low"), null);
  });

  it("escalates on elevated only when the deployment opted in", async () => {
    await withEnv({ SAFETY_ALERT_ON_ELEVATED: undefined }, () => {
      assert.equal(notifiableLevel("elevated"), null);
    });
    await withEnv({ SAFETY_ALERT_ON_ELEVATED: "1" }, () => {
      assert.equal(notifiableLevel("elevated"), "elevated");
    });
  });
});

describe("repeat suppression", () => {
  it("collapses several turns in the same hour into one escalation", () => {
    const a = dedupeKey("crisis", "chat", new Date("2026-09-16T17:02:00Z"));
    const b = dedupeKey("crisis", "chat", new Date("2026-09-16T17:58:00Z"));
    assert.equal(a, b);
  });

  it("escalates again the next hour", () => {
    const a = dedupeKey("crisis", "chat", new Date("2026-09-16T17:58:00Z"));
    const b = dedupeKey("crisis", "chat", new Date("2026-09-16T18:02:00Z"));
    assert.notEqual(a, b);
  });

  it("keeps the journal and the chat separate", () => {
    // Two surfaces in one hour is two different things a teacher should see.
    const chat = dedupeKey("crisis", "chat", new Date("2026-09-16T17:02:00Z"));
    const journal = dedupeKey("crisis", "journal", new Date("2026-09-16T17:02:00Z"));
    assert.notEqual(chat, journal);
  });

  it("does not let an elevated row suppress a crisis in the same hour", () => {
    const elevated = dedupeKey("elevated", "chat", new Date("2026-09-16T17:02:00Z"));
    const crisis = dedupeKey("crisis", "chat", new Date("2026-09-16T17:20:00Z"));
    assert.notEqual(elevated, crisis);
  });
});

describe("what goes over the wire", () => {
  const text = notificationText(ESCALATION, "2A-08");

  it("names the participant by their pseudonymous code", () => {
    assert.ok(text.includes("2A-08"));
  });

  it("carries no journal or chat text, and no matched rule", () => {
    // A notification is read on a lock screen, in a staff room, over someone's
    // shoulder. The educator who needs more signs in.
    assert.ok(!text.includes("explicit_self_harm_statement"));
    assert.ok(!/自分なんて|死に|消えたい/.test(text));
  });

  it("carries no score and no band", () => {
    assert.ok(!/\d+\.\d\d/.test(text));
    assert.ok(!text.includes("高リスク"));
    assert.ok(!text.includes("要注意"));
  });

  it("says the product does not handle emergencies", () => {
    assert.ok(text.includes("緊急対応"));
  });

  it("still works when the participant has no code", () => {
    const anonymous = notificationText(ESCALATION, null);
    assert.ok(anonymous.length > 0);
    assert.ok(!anonymous.includes("null"));
  });
});

describe("recording", () => {
  it("writes the escalation with its dedupe key", async () => {
    const client = fakeClient();
    await recordEscalation(client, {
      ownerUserId: "owner-1",
      participantId: "participant-1",
      participantCode: "2A-08",
      riskLevel: "crisis",
      reasons: ["explicit_self_harm_statement"],
      surface: "chat",
      detectedAt: new Date("2026-09-16T17:02:00Z"),
    });
    const [written] = client.calls.inserts;
    assert.equal(written.table, "safety_escalations");
    assert.equal(written.rows.risk_level, "crisis");
    assert.equal(written.rows.dedupe_key, "crisis:chat:2026-09-16T17");
  });

  it("treats a duplicate as nothing to do rather than as an error", async () => {
    const client = fakeClient({
      insert: { safety_escalations: { data: null, error: { code: "23505", message: "duplicate" } } },
    });
    const result = await recordEscalation(client, {
      ownerUserId: "owner-1",
      participantId: "participant-1",
      participantCode: "2A-08",
      riskLevel: "crisis",
      reasons: [],
      surface: "chat",
    });
    assert.equal(result, null);
  });
});

describe("delivery", () => {
  it("leaves an escalation queued when the deployment has no channel", async () => {
    /*
     * The bug this replaces (#178): an unconfigured deployment finalised the row
     * as `no_recipient`, and the dispatcher only ever queries
     * `["pending", "failed"]`. Every crisis that happened before somebody
     * finished setting the alert variables was therefore lost for good, while
     * the module promised its failure mode was "late, never never".
     */
    const client = fakeClient({ rpc: { data: [{ educator_user_id: "e1", email: "t@example.test" }], error: null } });
    const status = await withEnv(
      {
        SAFETY_ALERT_WEBHOOK_URL: undefined,
        RESEND_API_KEY: undefined,
        SAFETY_ALERT_EMAIL_FROM: undefined,
      },
      () => deliverEscalation(client, ESCALATION, "2A-08"),
    );
    assert.equal(await status, "pending");
    const [update] = client.calls.updates;
    assert.equal(update.values.status, "pending");
    assert.equal(update.values.delivered_at, null);
    // Nothing was attempted, so an idle unconfigured night must not eat into the
    // retry budget that exists for transport failures.
    assert.equal(update.values.attempts, ESCALATION.attempts);
  });

  it("still finalises as no_recipient when a channel exists but nobody may be told", async () => {
    // This one is genuinely terminal: consent is not going to appear because we
    // asked again.
    const client = fakeClient({ rpc: { data: [], error: null } });
    const status = await withEnv(
      { SAFETY_ALERT_WEBHOOK_URL: undefined, RESEND_API_KEY: "k", SAFETY_ALERT_EMAIL_FROM: "a@b.test" },
      () => deliverEscalation(client, ESCALATION, "2A-08"),
    );
    assert.equal(await status, "no_recipient");
    assert.equal(client.calls.updates[0].values.status, "no_recipient");
  });

  it("sends the queued escalation once a channel is configured", async () => {
    // The ordering the issue asks for, end to end: recorded with nothing set,
    // then configured, then delivered.
    const recipients = { data: [{ educator_user_id: "e1", email: "t@example.test" }], error: null };

    const unconfigured = fakeClient({ rpc: recipients });
    const first = await withEnv(
      { SAFETY_ALERT_WEBHOOK_URL: undefined, RESEND_API_KEY: undefined, SAFETY_ALERT_EMAIL_FROM: undefined },
      () => deliverEscalation(unconfigured, ESCALATION, "2A-08"),
    );
    assert.equal(await first, "pending", "must stay in the dispatcher's queue");

    const configured = fakeClient({ rpc: recipients });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("ok", { status: 200 });
    try {
      const second = await withEnv(
        { SAFETY_ALERT_WEBHOOK_URL: "https://hook.example.test/alert" },
        () => deliverEscalation(configured, ESCALATION, "2A-08"),
      );
      assert.equal(await second, "delivered");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("asks the database who may be told, rather than deciding itself", async () => {
    const client = fakeClient();
    await withEnv({ SAFETY_ALERT_WEBHOOK_URL: undefined, RESEND_API_KEY: undefined }, () =>
      deliverEscalation(client, ESCALATION, "2A-08"),
    );
    // Recomputed at send time from the oversight tables, so a consent revoked
    // an hour ago means no message tonight.
    assert.deepEqual(client.calls.rpc[0], {
      name: "safety_escalation_recipients",
      args: { target_participant: "participant-1" },
    });
  });

  it("counts an attempt that was actually made and failed", async () => {
    // Only when something was tried. An unconfigured deployment attempts
    // nothing, and the case above asserts its `attempts` does not move.
    const client = fakeClient({
      rpc: { data: [{ educator_user_id: "e1", email: "t@example.test" }], error: null },
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("nope", { status: 500 });
    try {
      const status = await withEnv({ SAFETY_ALERT_WEBHOOK_URL: "https://hook.example.test/alert" }, () =>
        deliverEscalation(client, { ...ESCALATION, attempts: 2 }, "2A-08"),
      );
      assert.equal(status, "failed");
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal(client.calls.updates[0].values.attempts, 3);
  });
});

describe("the wiring that makes this reach anyone", () => {
  it("escalates from the chat route", () => {
    const route = read("../src/app/api/chat/route.ts");
    assert.ok(route.includes("notifiableLevel(safety.risk_level)"));
    assert.ok(route.includes("escalate(service"));
  });

  it("escalates from the journal route", () => {
    // The journal is the other surface a crisis arrives on, and it had the
    // same gap: assessed, shaped the response, told nobody.
    const route = read("../src/app/api/entries/route.ts");
    assert.ok(route.includes("notifiableLevel(safetyAssessment.risk_level)"));
    assert.ok(route.includes("escalate(service"));
  });

  it("records before it sends", () => {
    const source = read("../src/lib/server/safetyEscalation.ts");
    const record = source.indexOf("const escalation = await recordEscalation");
    const deliver = source.indexOf("void deliverEscalation", record);
    assert.ok(record !== -1 && deliver > record, "the row must be written before delivery is attempted");
  });

  it("has a retry path, so a failed send is late rather than lost", () => {
    // The loop moved to `lib/server/safetyDispatch.ts` when the Vercel cron
    // entry needed it too (#179): Vercel Cron issues a bare GET, and the
    // dispatch route is a POST behind its own token.
    const dispatch = read("../src/lib/server/safetyDispatch.ts");
    assert.ok(dispatch.includes('.in("status", ["pending", "failed"])'));
    assert.ok(dispatch.includes("deliverEscalation"));
    assert.ok(read("../src/app/api/safety/dispatch/route.ts").includes("dispatchPendingEscalations"));
  });

  it("is actually scheduled, from the directory Vercel reads", () => {
    /*
     * The manifest used to sit at the repository root while the Vercel project's
     * root directory is `sentra/frontend`, so nothing read it — and the two
     * paths in it did not exist either (#179, #185).
     */
    const manifest = JSON.parse(read("../vercel.json"));
    const paths = manifest.crons.map((entry) => entry.path);
    assert.ok(paths.includes("/api/cron/safety-dispatch"));
    assert.ok(paths.includes("/api/cron/retention-purge"));
    for (const path of paths) {
      assert.ok(
        existsSync(resolve(HERE, `../src/app${path}/route.ts`)),
        `${path} is scheduled but has no route`,
      );
    }
  });

  it("refuses the dispatcher when no shared secret is set", () => {
    const dispatch = read("../src/app/api/safety/dispatch/route.ts");
    // An open retry endpoint is a way to make this deployment send mail on
    // command.
    assert.ok(dispatch.includes("if (!expected) return false"));
    assert.ok(dispatch.includes("timingSafeEqual"));
  });
});

describe("what the student was told", () => {
  it("the chat guardrail no longer claims an adult is never notified", () => {
    const safety = code("../src/lib/server/safety.ts");
    assert.ok(
      !safety.includes("you cannot notify an adult yourself"),
      "the model would repeat this to a student deciding whether to be honest",
    );
    assert.ok(safety.includes("the educators who already oversee them are notified"));
  });

  it("the consent screen says what happens when danger is read", () => {
    const consent = read("../src/app/consent/page.tsx");
    assert.ok(consent.includes("危険が疑われるとき"));
    // And that it is not conditional on agreeing to the research.
    assert.ok(consent.includes("研究への協力に同意するかどうかとは関係なく"));
  });
});

describe("the database contract this relies on", () => {
  const migration = read("../../supabase/migrations/20260916000000_safety_escalations.sql");

  it("lets the student read escalations about themselves", () => {
    // A system that tells an adult something about a minor and hides that from
    // the minor is one they cannot trust.
    assert.ok(migration.includes("safety_escalations_select_own"));
    assert.ok(migration.includes("owner_user_id = (select auth.uid())"));
  });

  it("admits an educator only through the same consent gate as the roster", () => {
    assert.ok(migration.includes("public.educator_oversees(participant_id)"));
  });

  it("stores a hash of the address, not the address", () => {
    assert.ok(migration.includes("recipient_hash"));
    assert.ok(!/recipient_email/.test(migration));
  });

  it("revokes the stock grants before granting what it means", () => {
    // Supabase grants every new table to anon and authenticated before a policy
    // is written; `grant select ... to authenticated` alone widens nothing.
    assert.ok(migration.includes("revoke all on public.safety_escalations from anon, authenticated"));
  });

  it("gives educators UPDATE only on the acknowledgement columns", () => {
    assert.ok(
      migration.includes("grant update (acknowledged_at, acknowledged_by) on public.safety_escalations to authenticated"),
    );
  });

  it("keeps the recipient function away from anon and authenticated", () => {
    assert.ok(
      migration.includes(
        "revoke execute on function public.safety_escalation_recipients(uuid) from public, anon, authenticated",
      ),
    );
  });
});

describe("the recipient hash", () => {
  /** 32 bytes, base64, as `guardianHmacKey()` and `inviteHmacKey()` expect. */
  const KEY_A = Buffer.alloc(32, 3).toString("base64");
  const KEY_B = Buffer.alloc(32, 9).toString("base64");

  const hashUnder = async (key) => {
    const client = fakeClient({
      rpc: { data: [{ educator_user_id: "e1", email: "Teacher@Example.test" }], error: null },
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("ok", { status: 200 });
    try {
      await withEnv(
        {
          SAFETY_ALERT_WEBHOOK_URL: undefined,
          RESEND_API_KEY: "test-key",
          SAFETY_ALERT_EMAIL_FROM: "alerts@example.test",
          SAFETY_RECIPIENT_HASH_KEY: key,
        },
        () => deliverEscalation(client, ESCALATION, "2A-08"),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
    const written = client.calls.inserts.find((i) => i.table === "safety_escalation_deliveries");
    return written.rows.find((row) => row.channel === "email")?.recipient_hash ?? null;
  };

  it("is stable for the same address", async () => {
    assert.equal(await hashUnder(KEY_A), await hashUnder(KEY_A));
  });

  it("differs under a different key", async () => {
    // The property an unkeyed SHA-256 did not have: without the key, a holder of
    // the staff list cannot hash the candidates and match the digest.
    assert.notEqual(await hashUnder(KEY_A), await hashUnder(KEY_B));
  });

  it("is null when no key is configured, and delivery still happens", async () => {
    assert.equal(await hashUnder(undefined), null);
  });

  it("rejects a key that is too short rather than using it", async () => {
    await withEnv({ SAFETY_RECIPIENT_HASH_KEY: Buffer.alloc(8, 1).toString("base64") }, () => {
      assert.equal(recipientHashKey(), null);
    });
  });
});
