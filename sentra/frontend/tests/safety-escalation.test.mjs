import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  dedupeKey,
  deliverEscalation,
  notifiableLevel,
  notificationText,
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
 * `withEnv` for a run that has to observe the variables *while* it awaits.
 *
 * `withEnv` restores in a synchronous `finally`, so an async `run` sees the
 * original environment from its first await onwards. That is fine for the tests
 * that unset a variable and check the resulting refusal, and wrong for any test
 * that sets one and expects the code under test to read it.
 */
async function withEnvAsync(values, run) {
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

function withEnv(values, run) {
  const saved = {};
  for (const [key, value] of Object.entries(values)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return run();
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

  it("escalates on elevated only when the deployment opted in", () => {
    withEnv({ SAFETY_ALERT_ON_ELEVATED: undefined }, () => {
      assert.equal(notifiableLevel("elevated"), null);
    });
    withEnv({ SAFETY_ALERT_ON_ELEVATED: "1" }, () => {
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
  it("marks an escalation nobody can receive as no_recipient, not as done", async () => {
    // The dangerous version of this bug is a deployment that reports success
    // because it had nowhere to send. `no_recipient` is a standing alarm.
    const client = fakeClient({ rpc: { data: [], error: null } });
    const status = await withEnv(
      {
        SAFETY_ALERT_WEBHOOK_URL: undefined,
        RESEND_API_KEY: undefined,
        SAFETY_ALERT_EMAIL_FROM: undefined,
      },
      () => deliverEscalation(client, ESCALATION, "2A-08"),
    );
    assert.equal(await status, "no_recipient");
    const [update] = client.calls.updates;
    assert.equal(update.values.status, "no_recipient");
    assert.equal(update.values.delivered_at, null);
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

  it("counts the attempt when a channel was actually called", async () => {
    // A configured webhook that rejects is a real try: a provider was reached,
    // it said no, and retrying that forever is what MAX_ATTEMPTS is for.
    const client = fakeClient();
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("nope", { status: 500 });
    try {
      const status = await withEnvAsync(
        {
          SAFETY_ALERT_WEBHOOK_URL: "https://school.example/hook",
          RESEND_API_KEY: undefined,
          SAFETY_ALERT_EMAIL_FROM: undefined,
        },
        () => deliverEscalation(client, { ...ESCALATION, attempts: 2 }, "2A-08"),
      );
      assert.equal(status, "failed");
      assert.equal(client.calls.updates[0].values.attempts, 3);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("does not spend a retry when there was nothing to try (#178)", async () => {
    // No channel and no recipient means no provider was contacted. Counting it
    // would let MAX_ATTEMPTS expire the row while it waits for the very
    // configuration that would let it be delivered — the fix turning back into
    // the bug, just more slowly.
    const client = fakeClient({ rpc: { data: [], error: null } });
    const status = await withEnvAsync(
      {
        SAFETY_ALERT_WEBHOOK_URL: undefined,
        RESEND_API_KEY: undefined,
        SAFETY_ALERT_EMAIL_FROM: undefined,
      },
      () => deliverEscalation(client, { ...ESCALATION, attempts: 2 }, "2A-08"),
    );
    assert.equal(status, "no_recipient");
    assert.equal(
      client.calls.updates[0].values.attempts,
      2,
      "a run with nothing to call must not consume an attempt",
    );
  });
});

describe("no_recipient is not where a crisis stops (#178)", () => {
  const jobs = code("../src/lib/server/scheduledJobs.ts");

  it("is picked up again by the dispatcher", () => {
    assert.match(
      jobs,
      /\.in\("status", \["pending", "failed", "no_recipient"\]\)/,
      "a crisis raised before the alert channel existed must be delivered once it does",
    );
  });

  it("does not leave a no_recipient row out of the exhausted sweep", () => {
    // Both the pickup and the "nobody has been told" sweep have to agree about
    // which statuses are still owed, or a stuck row stops being counted.
    const matches = jobs.match(/\["pending", "failed", "no_recipient"\]/g) ?? [];
    assert.ok(
      matches.length >= 2,
      `expected the pickup and the sweep to use the same status list, found ${matches.length}`,
    );
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
    // The queue loop moved to `scheduledJobs.ts` when the Vercel-cron entry
    // point was added (#B3): cron sends GET, the route's action is POST, and
    // both now call the same runner rather than each carrying a copy.
    const jobs = code("../src/lib/server/scheduledJobs.ts");
    assert.ok(jobs.includes("deliverEscalation"));
    assert.ok(jobs.includes("export async function runSafetyDispatch"));

    const dispatch = code("../src/app/api/safety/dispatch/route.ts");
    assert.ok(
      dispatch.includes("runSafetyDispatch(service)"),
      "the route must delegate to the shared runner",
    );
  });

  it("is actually scheduled, not just schedulable", () => {
    // A retry path nothing calls is a comment. `vercel.json` is what makes the
    // difference, and it had no `crons` key at all until #B3.
    const vercel = JSON.parse(read("../../../vercel.json"));
    assert.ok(Array.isArray(vercel.crons));
    assert.ok(
      vercel.crons.some((cron) => cron.path === "/api/cron/safety-dispatch"),
      "nothing was calling the dispatcher",
    );
  });

  it("refuses the dispatcher when no shared secret is set", () => {
    // An open retry endpoint is a way to make this deployment send mail on
    // command. The comparison moved to `cronAuth.ts` so the retention purge
    // could share it rather than grow a second copy.
    const auth = code("../src/lib/server/cronAuth.ts");
    assert.ok(auth.includes("if (!expected) return false"));
    assert.ok(auth.includes("timingSafeEqual"));

    const dispatch = code("../src/app/api/safety/dispatch/route.ts");
    assert.ok(dispatch.includes('bearerAuthorized(request, "SAFETY_DISPATCH_TOKEN")'));
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
