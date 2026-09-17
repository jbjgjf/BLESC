import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SYNTHETIC_ACCOUNTS, loadEnv } from "../src/config.ts";

describe("synthetic account contract", () => {
  it("provisions exactly 28 students, 4 counselors, 1 reviewer on .invalid", () => {
    assert.equal(SYNTHETIC_ACCOUNTS.students.length, 28);  // 20 English + 8 Japanese
    assert.equal(SYNTHETIC_ACCOUNTS.counselors.length, 4);
    for (const email of [...SYNTHETIC_ACCOUNTS.students, ...SYNTHETIC_ACCOUNTS.counselors, SYNTHETIC_ACCOUNTS.reviewer]) {
      assert.ok(email.endsWith("@synthetic.blesc.invalid"), email);
    }
    assert.equal(SYNTHETIC_ACCOUNTS.students[0], "student-01@synthetic.blesc.invalid");
    assert.equal(SYNTHETIC_ACCOUNTS.students[19], "student-20@synthetic.blesc.invalid");
    assert.equal(SYNTHETIC_ACCOUNTS.orgName, "BLESC Evaluation Lab");
  });

  // Both cases, because the refusal used to sit at the END of loadEnv() and the
  // missing-runner-key check threw first (#181). With no key configured —
  // which is every CI runner and every fresh checkout — aiming the harness at
  // production reported a missing OpenAI key and never said "production". The
  // guard has to answer before any unrelated validation can pre-empt it, so
  // the key-unset case is the one that pins the ordering.
  for (const [label, runnerKey] of [
    ["with no runner key configured", undefined],
    ["with a runner key configured", "sk-not-a-real-key"],
  ] as const) {
    it(`refuses to target the production Supabase project ${label}`, () => {
      const priorUrl = process.env.EVAL_SUPABASE_URL;
      const priorKey = process.env.BLESC_EVAL_RUNNER_OPENAI_API_KEY;
      process.env.EVAL_SUPABASE_URL = "https://kvcrkveaxlrijhzyayeg.supabase.co";
      if (runnerKey === undefined) delete process.env.BLESC_EVAL_RUNNER_OPENAI_API_KEY;
      else process.env.BLESC_EVAL_RUNNER_OPENAI_API_KEY = runnerKey;
      try {
        assert.throws(() => loadEnv(), /production/i);
      } finally {
        if (priorUrl === undefined) delete process.env.EVAL_SUPABASE_URL;
        else process.env.EVAL_SUPABASE_URL = priorUrl;
        if (priorKey === undefined) delete process.env.BLESC_EVAL_RUNNER_OPENAI_API_KEY;
        else process.env.BLESC_EVAL_RUNNER_OPENAI_API_KEY = priorKey;
      }
    });
  }
});
