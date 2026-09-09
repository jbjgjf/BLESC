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

describe("fixtures cannot reach a pilot screen or an export", () => {
  it("is not imported by any server module or route", async () => {
    // The demo reads `src/lib/blesc/fixtures.ts` and never touches Supabase.
    // The risk this guards is the reverse direction: a server module importing
    // a fixture would put invented rows into a research export, where nothing
    // downstream could tell them from a participant's.
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");

    const roots = [
      fileURLToPath(new URL("../src/lib/server", import.meta.url)),
      fileURLToPath(new URL("../src/app/api", import.meta.url)),
    ];
    const offenders = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir)) {
        const path = `${dir}/${entry}`;
        if (statSync(path).isDirectory()) {
          walk(path);
          continue;
        }
        if (!/\.tsx?$/.test(entry)) continue;
        if (/blesc\/(demoApi|fixtures)/.test(readFileSync(path, "utf8"))) offenders.push(path);
      }
    };
    for (const root of roots) walk(root);
    assert.deepEqual(offenders, []);
  });

  it("cannot be turned on where the gate is enforced", async () => {
    // Demo mode disables the enrollment gate, so a pilot deployment that also
    // enabled the demo would be collecting from a screen showing fixed data.
    // The two are mutually exclusive by construction; this is where that is
    // said. Asserted from source because `pilotGate.ts` imports through the
    // `@/` alias, which this runner does not resolve.
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const source = readFileSync(
      fileURLToPath(new URL("../src/lib/server/pilotGate.ts", import.meta.url)),
      "utf8",
    );
    assert.match(source, /NEXT_PUBLIC_DEMO_MODE === "1"\) return false/);
  });
});
