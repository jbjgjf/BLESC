import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SYNTHETIC_ACCOUNTS, loadEnv } from "../src/config.ts";

describe("synthetic account contract", () => {
  it("provisions exactly 20 students, 4 counselors, 1 reviewer on .invalid", () => {
    assert.equal(SYNTHETIC_ACCOUNTS.students.length, 20);
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
    process.env.EVAL_SUPABASE_URL = "https://kvcrkveaxlrijhzyayeg.supabase.co";
    try {
      assert.throws(() => loadEnv(), /production/i);
    } finally {
      if (prior === undefined) delete process.env.EVAL_SUPABASE_URL;
      else process.env.EVAL_SUPABASE_URL = prior;
    }
  });
});
