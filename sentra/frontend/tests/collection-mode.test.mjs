import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  COLLECTION_ONLY_MESSAGE,
  COLLECTION_ONLY_PROVIDER,
  COLLECTION_ONLY_STATUS,
  collectionOnlyExtraction,
  collectionOnlyForParticipant,
  collectionOnlyForUser,
} from "../src/lib/server/collectionMode.ts";

const API_ROOT = fileURLToPath(new URL("../src/app/api", import.meta.url));

async function routeFiles(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await routeFiles(full)));
    else if (entry.name === "route.ts") found.push(full);
  }
  return found;
}

describe("every external send point consults the gate", () => {
  /**
   * The acceptance criterion for #165 is zero calls to an AI endpoint from a
   * pilot participant's submission. A runtime test can show that for the paths
   * it exercises; this shows it for paths nobody thought to exercise, which is
   * where the regression will actually come from — someone adds a sixth route
   * that calls OpenAI and never learns this gate exists.
   */
  it("no route reaches api.openai.com without importing collectionMode", async () => {
    const files = await routeFiles(API_ROOT);
    assert.ok(files.length > 5, `found only ${files.length} route files; the scan is not working`);

    const offenders = [];
    for (const file of files) {
      const source = await readFile(file, "utf8");
      if (!source.includes("api.openai.com")) continue;
      if (!source.includes("@/lib/server/collectionMode")) {
        offenders.push(path.relative(API_ROOT, file));
      }
    }

    assert.deepEqual(
      offenders,
      [],
      "These routes call an external AI endpoint without consulting the collection-only gate " +
        `(src/lib/server/collectionMode.ts):\n${offenders.join("\n")}`,
    );
  });

  it("covers the four route files that hold those five send points", async () => {
    const files = await routeFiles(API_ROOT);
    const calling = [];
    for (const file of files) {
      const source = await readFile(file, "utf8");
      if (source.includes("api.openai.com")) calling.push(path.relative(API_ROOT, file));
    }

    // If this list changes, `collectionMode.ts`'s header list is stale and the
    // next reader will trust a wrong inventory.
    assert.deepEqual(calling.sort(), [
      "audio/transcriptions/route.ts",
      "chat/route.ts",
      "entries/route.ts",
      "voice/realtime-session/route.ts",
    ]);
  });
});

describe("adaptive surfaces are refused server-side, not merely hidden", () => {
  /**
   * #165 asks for more than "no external send": the AI reply, the generated
   * advice, the adaptive follow-up, the personal graph and the educator
   * inference all have to be off during a collection window, at the API and not
   * only on the screen. The four routes above cover everything that leaves the
   * server. This covers the one that does not — the follow-up script, which is
   * adaptive without calling anybody.
   *
   * A follow-up that fires for a hard day is an intervention: the participant
   * who was asked "何がいちばん大変でしたか" writes tomorrow's entry having
   * been prompted, and a study measuring how people write cannot also be
   * prompting them.
   */
  it("the follow-up route consults the gate", async () => {
    const file = fileURLToPath(new URL("../src/app/api/entries/followups/route.ts", import.meta.url));
    const source = await readFile(file, "utf8");
    assert.ok(
      source.includes("@/lib/server/collectionMode"),
      "api/entries/followups must refuse adaptive probes during a collection window",
    );
    assert.ok(source.includes("collectionOnlyForParticipant"));
  });

  it("every route that stores a follow-up answer consults the gate", async () => {
    // The same shape as the OpenAI scan above, for the same reason: the
    // regression comes from a route somebody adds later, not from this one.
    const files = await routeFiles(API_ROOT);
    const offenders = [];
    for (const file of files) {
      const source = await readFile(file, "utf8");
      if (!source.includes("followup_responses")) continue;
      if (!source.includes("@/lib/server/collectionMode")) offenders.push(path.relative(API_ROOT, file));
    }
    assert.deepEqual(offenders, []);
  });

  it("the journal screen does not offer a follow-up while a window is open", async () => {
    // The display gate is the control that matters. By the time the API sees a
    // request the question has been asked, and refusing the write keeps the
    // answer out of the research record but cannot undo the nudge.
    const file = fileURLToPath(new URL("../src/app/journal/page.tsx", import.meta.url));
    const source = await readFile(file, "utf8");
    assert.ok(
      source.includes("needsFollowUp() && !collecting"),
      "the journal page must not enter the follow-up phase during a collection window",
    );
  });

  it("the writer withholds the derived record while a window is open", async () => {
    // The graph snapshot, the insight, the graph version history, the
    // longitudinal series and the evaluation example are all readings *of* a
    // participant. The educator alerts are built from the insight row, so
    // storing one means somebody can act on an interpretation the study said it
    // would not form — whether or not the participant is shown it.
    const file = fileURLToPath(new URL("../src/lib/server/supabaseWriter.ts", import.meta.url));
    const source = await readFile(file, "utf8");
    for (const guard of [
      "computed.graph_snapshot && !context.collectionOnly",
      "(computed.anomaly_result || computed.explanation) && !context.collectionOnly",
      "collection_only:longitudinal_features",
      "collection_only:eval_examples",
    ]) {
      assert.ok(source.includes(guard), `the writer no longer withholds: ${guard}`);
    }
  });
});

/** A stand-in Supabase client: `rpc` and `from(...).select(...)` only. */
function fakeClient({ rpcData, rpcError, rows, rowsError }) {
  return {
    rpc: async () => ({ data: rpcData, error: rpcError ?? null }),
    from() {
      const builder = {
        select: () => builder,
        eq: () => builder,
        limit: async () => ({ data: rows ?? [], error: rowsError ?? null }),
      };
      return builder;
    },
  };
}

describe("collectionOnlyForParticipant", () => {
  it("is false for an ordinary user with no enrollment", async () => {
    const client = fakeClient({ rpcData: false });
    assert.equal(await collectionOnlyForParticipant(client, "participant-1"), false);
  });

  it("is true inside an open collection window", async () => {
    const client = fakeClient({ rpcData: true });
    assert.equal(await collectionOnlyForParticipant(client, "participant-1"), true);
  });

  it("fails closed: a database error withholds the external call", async () => {
    const client = fakeClient({ rpcError: { message: "connection reset" } });
    assert.equal(await collectionOnlyForParticipant(client, "participant-1"), true);
  });

  it("is false when there is no client or participant to check", async () => {
    assert.equal(await collectionOnlyForParticipant(null, "participant-1"), false);
    assert.equal(await collectionOnlyForParticipant(fakeClient({ rpcData: true }), null), false);
  });
});

describe("collectionOnlyForUser", () => {
  it("is true when the account holds a collecting enrollment", async () => {
    const client = fakeClient({ rows: [{ id: "enrollment-1" }] });
    assert.equal(await collectionOnlyForUser(client, "user-1"), true);
  });

  it("is false when it holds none", async () => {
    const client = fakeClient({ rows: [] });
    assert.equal(await collectionOnlyForUser(client, "user-1"), false);
  });

  it("fails closed on a query error", async () => {
    const client = fakeClient({ rowsError: { message: "permission denied" } });
    assert.equal(await collectionOnlyForUser(client, "user-1"), true);
  });
});

describe("collectionOnlyExtraction", () => {
  /**
   * The alternative considered and rejected was `fallbackExtraction`, which
   * matches English keywords against text that is Japanese and therefore
   * returns nearly the same generic nodes for every entry. Storing that would
   * put a constant, fabricated graph into the research record.
   */
  it("fabricates nothing", () => {
    const extraction = collectionOnlyExtraction();
    assert.deepEqual(extraction.nodes, []);
    assert.deepEqual(extraction.relations, []);
    assert.deepEqual(extraction.evidence_summaries, []);
  });

  it("differs from the deterministic fallback, which invents nodes", async () => {
    const { fallbackExtraction } = await import("../src/lib/extraction.ts");
    const invented = fallbackExtraction("今日は数学の小テストがありました。");
    assert.ok(invented.nodes.length > 0, "the fallback is expected to invent nodes");
    assert.equal(collectionOnlyExtraction().nodes.length, 0);
  });

  it("says what happened, in the participant's language", () => {
    assert.match(collectionOnlyExtraction().summary, /[ぁ-んァ-ヶ一-龠]/);
    assert.match(COLLECTION_ONLY_MESSAGE, /[ぁ-んァ-ヶ一-龠]/);
  });
});

describe("withheld markers", () => {
  it("are distinguishable from a provider failure", () => {
    // `failed_500` and `fallback` already mean "we tried and it did not work".
    // A withheld call has to read differently in `model_runs`, or the study
    // cannot tell a design decision from an outage.
    assert.equal(COLLECTION_ONLY_STATUS, "withheld_collection_only");
    assert.equal(COLLECTION_ONLY_PROVIDER, "none");
    assert.notEqual(COLLECTION_ONLY_STATUS, "fallback");
  });
});
