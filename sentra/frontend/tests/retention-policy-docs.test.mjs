/**
 * The retention periods `/legal` tells participants are the ones the database
 * is seeded with (#318).
 *
 * Two artefacts state the same three numbers: the privacy policy a participant
 * reads, and `pilot_retention_policy`, which the purge job will act on. They
 * are written by different people at different times, and the failure this
 * guards against is one of them being edited alone — a policy that says one
 * year over a job that deletes at ninety days, or the reverse.
 *
 * What the periods *do* is tested where they run:
 * `supabase/tests/retention_policy.test.sql`.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { LEGAL_DOCUMENTS } from "../src/lib/legalDocuments.ts";

const migration = readFileSync(
  fileURLToPath(
    new URL("../../supabase/migrations/20261010010000_study_end_and_retention_policy.sql", import.meta.url),
  ),
  "utf8",
);

/** `{ category: "1 year" }`, read from the seed rows. */
const seeded = Object.fromEntries(
  [...migration.matchAll(/\('(\w+)',\s+interval '([^']+)',/g)].map((match) => [match[1], match[2]]),
);

/** How each seeded interval is written in the Japanese documents. */
const JAPANESE = { "1 year": "1年", "90 days": "90日", "5 years": "5年" };

const text = (id) =>
  LEGAL_DOCUMENTS.find((document) => document.id === id)
    .sections.flatMap((section) => section.paragraphs)
    .join("\n");

describe("the periods in the documents and in the database", () => {
  it("the seed has the three categories and nothing else", () => {
    assert.deepEqual(Object.keys(seeded).sort(), ["audit_trail", "identity_map", "research_records"]);
    for (const period of Object.values(seeded)) {
      assert.ok(period in JAPANESE, `no Japanese wording is known for "${period}"`);
    }
  });

  for (const id of ["privacy", "research"]) {
    it(`${id}: states the same period for each category`, () => {
      const body = text(id);
      const stated = {
        research_records: body.match(/研究用自己評定・操作指標[^。]*?(?:は|：)研究終了から(\d+(?:年|日))/)?.[1],
        identity_map: body.match(/対応表(?:は|：)(?:研究)?終了から(\d+(?:年|日))/)?.[1],
        audit_trail: body.match(/証跡(?:は|：)[^。]*?から(\d+(?:年|日))/)?.[1],
      };
      for (const [category, period] of Object.entries(seeded)) {
        assert.equal(stated[category], JAPANESE[period], `${id} and the seed disagree about ${category}`);
      }
    });
  }

  it("the documents still call the periods a proposal, as the unapproved seed is", () => {
    // The seed ships with `approved_at` null. A document that stopped saying
    // 「案」 while the periods are unapproved would be promising a deletion
    // schedule nobody has signed.
    assert.doesNotMatch(migration, /approved_at\s*,|approval_reference\s*\)\s*values/);
    assert.match(text("research"), /とする案です/);
  });
});
