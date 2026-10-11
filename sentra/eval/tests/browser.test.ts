import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ja } from "../../frontend/src/lib/i18n/ja.ts";
import { ObservationNotReady, counselorReadOversight, grantConsentIfRequested, submitJournal } from "../src/browser.ts";
import { FakePage } from "./fakes/page.ts";

// #305: submitJournal "waited" for extraction with `isEnabled()`, an instant
// query whose result was discarded, plus a fixed 1.5 s sleep. Extraction takes
// up to ~28 s, so every observation after it was taken against a journal the
// product had not processed yet. These tests use a page where time only passes
// when the test says so.

const ENTRY_URL = "http://localhost:3940/api/entries?user_id=u1&observation_type=daily";
const settled = async (promise: Promise<unknown>) => {
  let done = false;
  promise.then(() => { done = true; }, () => { done = true; });
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  return done;
};

describe("submitJournal waits for the product to finish (#305)", () => {
  it("does not return before the journal submission's response arrives", async () => {
    const page = new FakePage();
    const submitted = submitJournal(page.asPage(), "今日はつかれた");
    assert.equal(await settled(submitted), false, `returned early after: ${page.actions.join(" → ")}`);

    page.respond({
      url: ENTRY_URL, status: 200,
      body: {
        supabase_sync: { entry_id: "entry-1" },
        extraction: { reflection_cards_json: [{ type: "reflection_question", status: "active" }] },
      },
    });
    const result = await submitted;
    assert.equal(result.entryId, "entry-1");
    assert.deepEqual(result.reflectionCards, [{ type: "reflection_question", status: "active" }]);
  });

  it("is not satisfied by another request to an entries sub-route", async () => {
    const page = new FakePage();
    const submitted = submitJournal(page.asPage(), "x");
    await page.whenWaiting();
    page.respond({ url: "http://localhost:3940/api/entries/followups?user_id=u1", status: 200, body: {} });
    assert.equal(await settled(submitted), false);
    page.respond({ url: ENTRY_URL, status: 200, body: { supabase_sync: { entry_id: "e" } } });
    await submitted;
  });

  it("fails loudly when processing does not finish in time", async () => {
    const page = new FakePage();
    const submitted = submitJournal(page.asPage(), "x");
    await page.whenWaiting();
    page.timeOutResponses();
    await assert.rejects(submitted, (error: unknown) => error instanceof ObservationNotReady && error.step === "journal");
  });

  it("fails loudly when the product rejects or does not save the journal", async () => {
    for (const response of [
      { url: ENTRY_URL, status: 500, body: { error: "boom" } },
      { url: ENTRY_URL, status: 200, body: { supabase_sync: { entry_id: null } } },
    ]) {
      const page = new FakePage();
      const submitted = submitJournal(page.asPage(), "x");
      await page.whenWaiting();
      page.respond(response);
      await assert.rejects(submitted, ObservationNotReady, JSON.stringify(response));
    }
  });
});

describe("other waits in browser.ts (#305)", () => {
  it("does not read an oversight page that never loaded as if it had", async () => {
    // A blank or still-loading page has no sentinel and no student code, so
    // reading it would pass the privacy checks without having checked them.
    const page = new FakePage();
    page.neverAppears.add('[data-testid="oversight-student-list"], [data-testid="oversight-empty"], [data-testid="oversight-summary"]');
    await assert.rejects(counselorReadOversight(page.asPage()), (error: unknown) => error instanceof ObservationNotReady && error.step === "oversight");
  });

  it("waits for /sharing to finish loading before deciding there is no consent to grant", async () => {
    const page = new FakePage();
    await grantConsentIfRequested(page.asPage());
    const waited = page.actions.indexOf(`waitFor text=${ja.sharing.loading} hidden`);
    const counted = page.actions.findIndex((action) => action.startsWith("count "));
    assert.ok(waited >= 0 && waited < counted, page.actions.join(" → "));
  });
});
