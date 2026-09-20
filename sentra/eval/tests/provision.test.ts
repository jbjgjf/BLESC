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

  it("refuses to target the production Supabase project", () => {
    const prior = process.env.EVAL_SUPABASE_URL;
    const priorKey = process.env.BLESC_EVAL_RUNNER_OPENAI_API_KEY;
    // Deleted on purpose: the guard has to answer the question it was asked
    // even when an unrelated variable is also missing (#181). With the check at
    // the end of `loadEnv`, this environment answered "no OpenAI key" and said
    // nothing about being pointed at production.
    delete process.env.BLESC_EVAL_RUNNER_OPENAI_API_KEY;
    process.env.EVAL_SUPABASE_URL = "https://kvcrkveaxlrijhzyayeg.supabase.co";
    try {
      assert.throws(() => loadEnv(), /Refusing to run evaluation/i);
    } finally {
      if (priorKey === undefined) delete process.env.BLESC_EVAL_RUNNER_OPENAI_API_KEY;
      else process.env.BLESC_EVAL_RUNNER_OPENAI_API_KEY = priorKey;
      if (prior === undefined) delete process.env.EVAL_SUPABASE_URL;
      else process.env.EVAL_SUPABASE_URL = prior;
    }
  });

  it("refuses any Supabase project that is not on the allowlist", () => {
    /*
     * The case the old denylist missed (#187). #166 stands up a brand-new
     * Supabase for the pilot; its ref is not the one the denylist named, so
     * `reset` would have run against a project holding participant data.
     */
    const prior = process.env.EVAL_SUPABASE_URL;
    const cases = [
      "https://brandnewpilotref.supabase.co",
      "https://staging-somewhere.supabase.co",
      // Substring matching would have let these through.
      "https://127.0.0.1.attacker.example",
      "https://vkrhcctlbdjlhtbninsd.supabase.co.evil.test",
    ];
    try {
      for (const url of cases) {
        process.env.EVAL_SUPABASE_URL = url;
        assert.throws(() => loadEnv(), /Refusing to run evaluation/i, url);
      }
    } finally {
      if (prior === undefined) delete process.env.EVAL_SUPABASE_URL;
      else process.env.EVAL_SUPABASE_URL = prior;
    }
  });

  it("allows the local stack and the dedicated evaluation project", () => {
    const prior = process.env.EVAL_SUPABASE_URL;
    const priorKey = process.env.BLESC_EVAL_RUNNER_OPENAI_API_KEY;
    process.env.BLESC_EVAL_RUNNER_OPENAI_API_KEY = "test-key";
    try {
      for (const url of [
        "http://127.0.0.1:54321",
        "http://localhost:54321",
        "https://vkrhcctlbdjlhtbninsd.supabase.co",
      ]) {
        process.env.EVAL_SUPABASE_URL = url;
        assert.doesNotThrow(() => loadEnv(), url);
      }
    } finally {
      if (priorKey === undefined) delete process.env.BLESC_EVAL_RUNNER_OPENAI_API_KEY;
      else process.env.BLESC_EVAL_RUNNER_OPENAI_API_KEY = priorKey;
      if (prior === undefined) delete process.env.EVAL_SUPABASE_URL;
      else process.env.EVAL_SUPABASE_URL = prior;
    }
  });
});
