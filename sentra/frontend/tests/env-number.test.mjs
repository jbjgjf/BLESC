import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { envPositiveInt } from "../src/lib/server/envNumber.ts";
import { RULES } from "../src/lib/server/rateLimit.ts";

/**
 * Numbers read out of the environment (#269).
 *
 * The bug these cover is not "an invalid value is accepted". It is that an
 * invalid value became `NaN`, and `NaN` does not fail — it makes `setTimeout`
 * fire immediately and makes every `>` comparison false. So the assertions
 * below are about the two consequences, not only about the parse:
 *
 *   - whatever reaches `setTimeout` is finite, because `setTimeout(fn, NaN)`
 *     aborts a request on the next tick;
 *   - whatever a size cap is compared against is finite, because `n > NaN` is
 *     false and a cap that compares false is not a cap.
 *
 * `source` assertions are here for the same reason `collection-mode.test.mjs`
 * scans `src/app/api`: the fix is one helper, and it only holds while the call
 * sites keep going through it. A fourth `Number(process.env...)` added later
 * would reintroduce exactly this defect, silently.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (relative) => readFileSync(resolve(HERE, relative), "utf8");

const NAME = "BLESC_TEST_ENV_NUMBER";

function withEnv(value, run) {
  const had = Object.prototype.hasOwnProperty.call(process.env, NAME);
  const previous = process.env[NAME];
  if (value === undefined) delete process.env[NAME];
  else process.env[NAME] = value;
  try {
    return run();
  } finally {
    if (had) process.env[NAME] = previous;
    else delete process.env[NAME];
  }
}

describe("a number read from the environment", () => {
  it("uses the value when it is a positive integer", () => {
    assert.equal(withEnv("30000", () => envPositiveInt(NAME, 25000)), 30000);
    assert.equal(withEnv("1", () => envPositiveInt(NAME, 25000)), 1);
  });

  it("accepts surrounding whitespace, which is how a pasted value arrives", () => {
    assert.equal(withEnv("  30000\n", () => envPositiveInt(NAME, 25000)), 30000);
  });

  it("falls back when the variable is unset or empty", () => {
    assert.equal(withEnv(undefined, () => envPositiveInt(NAME, 25000)), 25000);
    assert.equal(withEnv("", () => envPositiveInt(NAME, 25000)), 25000);
    assert.equal(withEnv("   ", () => envPositiveInt(NAME, 25000)), 25000);
  });

  /**
   * Each of these used to become `NaN`. `"25s"` and `"24MB"` are the shapes
   * somebody writes when they think the variable takes a unit; `"20_000"` is
   * what they write copying a number out of code; the quoted form is what a
   * dashboard produces when the quotes are pasted along with the value.
   */
  it("falls back on every value that used to become NaN", () => {
    for (const bad of ["25s", "24MB", "20_000", '"20000"', "'20000'", "20000ms", "abc", "1e400"]) {
      assert.equal(
        withEnv(bad, () => envPositiveInt(NAME, 25000)),
        25000,
        `${JSON.stringify(bad)} should fall back`,
      );
    }
  });

  /**
   * The notations `Number()` accepts and Python's `int()` does not. `"0x20"` is
   * the dangerous one: it parses to 32, a plausible-looking number, so before
   * the shape check this service ran with a ceiling of 32 bytes while FastAPI
   * ran with 24MiB. `test_both_implementations_agree` in the backend suite is
   * the assertion that found it.
   */
  it("falls back on notations the FastAPI side does not accept", () => {
    for (const bad of ["0x20", "0b101", "0o17", "+20000", "1e3", "Infinity"]) {
      assert.equal(
        withEnv(bad, () => envPositiveInt(NAME, 25000)),
        25000,
        `${JSON.stringify(bad)} should fall back`,
      );
    }
  });

  it("falls back on zero, negatives and non-integers", () => {
    for (const bad of ["0", "-1", "-20000", "3.5", "0.5"]) {
      assert.equal(
        withEnv(bad, () => envPositiveInt(NAME, 25000)),
        25000,
        `${JSON.stringify(bad)} should fall back`,
      );
    }
  });

  it("never returns a value that setTimeout would treat as zero", () => {
    for (const value of [undefined, "", "25s", "20_000", "0", "-1", "3.5", "abc"]) {
      const resolved = withEnv(value, () => envPositiveInt(NAME, 25000));
      assert.ok(Number.isFinite(resolved), `${JSON.stringify(value)} resolved to a non-finite timeout`);
      assert.ok(resolved > 0, `${JSON.stringify(value)} resolved to a non-positive timeout`);
    }
  });

  it("never returns a ceiling that a size comparison would fall through", () => {
    // The defect: `file.size > AUDIO_MAX_BYTES` with a NaN ceiling is false for
    // every size, so an upload of any size was accepted.
    for (const value of ["24MB", "abc", ""]) {
      const ceiling = withEnv(value, () => envPositiveInt(NAME, 24 * 1024 * 1024));
      assert.equal(1e12 > ceiling, true, `a 1TB upload should exceed the ceiling for ${JSON.stringify(value)}`);
    }
  });
});

describe("the call sites that read a number from the environment", () => {
  const SITES = [
    ["../src/app/api/chat/route.ts", "OPENAI_CHAT_TIMEOUT_MS"],
    ["../src/app/api/voice/realtime-session/route.ts", "OPENAI_REALTIME_TIMEOUT_MS"],
    ["../src/app/api/audio/transcriptions/route.ts", "OPENAI_TRANSCRIPTION_MAX_BYTES"],
    ["../src/lib/server/rateLimit.ts", null],
  ];

  for (const [file, variable] of SITES) {
    it(`${file} reads it through envPositiveInt`, () => {
      const source = read(file);
      assert.match(source, /envPositiveInt/, `${file} should use the shared helper`);
      if (variable) {
        assert.match(
          source,
          new RegExp(`envPositiveInt\\("${variable}"`),
          `${file} should read ${variable} through the helper`,
        );
      }
    });

    it(`${file} does not wrap process.env in a bare Number()`, () => {
      const source = read(file);
      assert.doesNotMatch(
        source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " "),
        /Number\(\s*process\.env/,
        `${file} still has the pattern that produced NaN`,
      );
    });
  }
});

describe("the rate limit rules, which already validated and now share the helper", () => {
  it("keeps its documented defaults", () => {
    assert.equal(RULES.inviteCheck.limit, 20);
    assert.equal(RULES.inviteRedeem.limit, 10);
    assert.equal(RULES.guardianIssue.limit, 20);
    assert.equal(RULES.externalModel.limit, 60);
  });

  it("keeps every limit a positive integer", () => {
    for (const [name, rule] of Object.entries(RULES)) {
      assert.ok(Number.isSafeInteger(rule.limit), `${name} limit is not a safe integer`);
      assert.ok(rule.limit > 0, `${name} limit is not positive`);
      assert.ok(Number.isSafeInteger(rule.windowSeconds) && rule.windowSeconds > 0, `${name} window`);
    }
  });
});
