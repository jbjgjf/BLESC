import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { modelTrainingUseAllowed, normalizeConsent } from "../src/lib/consent.ts";
import { GUARDIAN_REVIEWABLE_GRANTS, participantConsentGrant } from "../src/lib/guardianVerification.ts";

/**
 * blesc.jp: 「日記を販売することも、広告に使うことも、AIモデルの学習に使う
 * こともありません」. On 2026-10-18 the owner chose to make the product keep
 * that sentence rather than qualify it (#469). These are the places a training
 * permission could come back in.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const read = (path) => readFileSync(resolve(HERE, "..", path), "utf8");

describe("no model training on participant data (#469)", () => {
  it("is not offered on any consent screen", () => {
    for (const path of [
      "src/app/consent/page.tsx",
      "src/app/pilot/join/page.tsx",
      "src/app/pilot/guardian/[token]/GuardianConfirm.tsx",
      "src/app/pilot/guardian/[token]/page.tsx",
    ]) {
      assert.doesNotMatch(read(path), /model_training_use|学習に(利用|使)/, path);
    }
  });

  it("is not something a guardian is asked to approve", () => {
    assert.ok(!GUARDIAN_REVIEWABLE_GRANTS.includes("model_training_use"));
  });

  it("is never granted, whatever the request asks for", () => {
    const grant = participantConsentGrant(
      { app_use: true, research_analysis: true, model_training_use: true },
      { guardianRequired: false, guardianConfirmed: false },
    );
    assert.equal(grant.model_training_use, false);
  });

  it("is never read back as a permission from a stored row", () => {
    const stored = normalizeConsent({
      app_use: true,
      research_analysis: true,
      model_training_use: true,
      minor_assent: true,
      guardian_consent: true,
      status: "active",
    });
    assert.equal(stored.model_training_use, false);
    assert.equal(modelTrainingUseAllowed(stored), false);
  });

  it("is never written by the consent store", () => {
    assert.match(read("src/lib/server/consentStore.ts"), /model_training_use: false,/);
    assert.doesNotMatch(read("src/lib/server/consentStore.ts"), /input\.model_training_use/);
  });
});
