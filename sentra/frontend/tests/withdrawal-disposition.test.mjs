/**
 * Withdrawal lets the participant decide what happens to what was collected
 * (#224).
 *
 * It used to be one button that meant "withdraw, and destroy the text" — an
 * irreversible act with no second step and no alternative. This locks down the
 * shape of the replacement, and in particular the two asymmetries that make it
 * safe:
 *
 *   1. Only the exact string "keep" keeps. Anything else deletes, because a
 *      request that did not say is not a request to keep.
 *   2. "Keep" is about destruction, never about use. Withdrawal still stops
 *      collection, the export and training use; the stored text simply waits
 *      for its ordinary retention window.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const read = (relative) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

/** Comments state the rules, so a naive grep finds a rule inside its rationale. */
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

const route = read("../src/app/api/consent/route.ts");
const store = read("../src/lib/server/consentStore.ts");
const page = read("../src/app/consent/page.tsx");
const migration = read(
  "../../supabase/migrations/20260921020000_withdrawal_data_disposition.sql",
);

describe("the choice exists and is recorded", () => {
  it("the revocation row carries the disposition", () => {
    assert.match(code(store), /retained_data_disposition: disposition/);
  });

  it("the column only accepts delete or keep", () => {
    assert.match(migration, /in \('delete', 'keep'\)/);
  });

  it("the column cannot appear on a row that is not a revocation", () => {
    // A live consent record reading "chose delete" would quietly corrupt any
    // later count of how people withdrew.
    assert.match(migration, /or status = 'revoked'/);
  });
});

describe("silence deletes", () => {
  it("the route treats only the exact string as keep", () => {
    assert.match(
      code(route),
      /body\.retained_data === "keep" \? "keep" : "delete"/,
      "a malformed or absent value must not retain text after a withdrawal",
    );
  });

  it("the store defaults to delete", () => {
    assert.match(code(store), /disposition: RetainedDataDisposition = "delete"/);
  });

  it("the client has no default at all", () => {
    // The screen must choose deliberately; the server default is a guard
    // against malformed requests, not an API convenience.
    const client = code(read("../src/api/client.ts"));
    assert.match(client, /retainedData: "delete" \| "keep",/);
    assert.doesNotMatch(client, /retainedData: "delete" \| "keep" =/);
  });
});

describe("keep is not permission to carry on", () => {
  it("the export gate does not read the disposition", () => {
    // If it ever does, "keep my record" silently becomes "keep using my
    // record", which is a consent nobody gave.
    const exportRoute = code(read("../src/app/api/research/export/route.ts"));
    const exportLib = code(read("../src/lib/researchExport.ts"));
    assert.doesNotMatch(exportRoute, /retained_data_disposition/);
    assert.doesNotMatch(exportLib, /retained_data_disposition/);
  });

  it("the revocation still zeroes every grant", () => {
    const body = code(store);
    for (const grant of [
      "research_analysis: false",
      "anonymized_export: false",
      "raw_text_retention: false",
      "model_training_use: false",
    ]) {
      assert.ok(body.includes(grant), `revocation must set ${grant}`);
    }
  });

  it("the screen says so to the participant", () => {
    assert.match(page, /研究への協力はここで終わります/);
    assert.match(page, /研究の分析やAIの学習に使われることはありません/);
  });
});

describe("the irreversible option is not one click away", () => {
  it("withdrawing opens a choice rather than acting", () => {
    assert.match(code(page), /onClick=\{\(\) => setWithdrawing\(true\)\}/);
  });

  it("both outcomes are offered, and so is backing out", () => {
    const body = code(page);
    assert.match(body, /revoke\("delete"\)/);
    assert.match(body, /revoke\("keep"\)/);
    assert.match(body, /setWithdrawing\(false\)/);
  });

  it("tells the participant which one cannot be undone", () => {
    assert.match(page, /元に戻せません/);
  });
});

describe("the response cannot be misread", () => {
  it("keeping reports zero purged alongside an explicit keep", () => {
    // `purged_raw_text: 0` on its own reads as "deleted nothing", which is what
    // a failed delete also looks like.
    assert.match(code(route), /retained_data: "keep",\s*purged_raw_text: 0,/);
  });

  it("a failed purge is still an error", () => {
    assert.match(code(route), /status: 502/);
  });
});
