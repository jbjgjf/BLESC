import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";

import {
  DISPATCH_STALE_MINUTES,
  blockingGaps,
  configChecks,
  oldestOwedMinutes,
} from "../src/lib/server/opsConfig.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (path) => readFileSync(resolve(HERE, path), "utf8");

/**
 * The deployment self-check behind `/api/pilot/admin/ops` (#194).
 *
 * Two properties are worth a test rather than a reading. The first is that a
 * malformed value is distinguishable from a missing one — an operator who set
 * `SAFETY_RECIPIENT_HASH_KEY` to a 16-byte string and an operator who set
 * nothing need different instructions, and `recipientHashKey()` returns null
 * for both. The second is that no secret reaches the response: this is a
 * diagnostic that an uptime checker polls with a bearer token, and a diagnostic
 * that echoes what it found is worse than none.
 */

const TOUCHED = [
  "CRON_SECRET",
  "SAFETY_DISPATCH_TOKEN",
  "SAFETY_RECIPIENT_HASH_KEY",
  "RESEARCH_RAW_TEXT_KEY",
  "NEXT_PUBLIC_PILOT_MODE",
  "PILOT_OPERATOR_USER_IDS",
  "RESEARCH_EXPORT_USER_IDS",
  "PILOT_INVITE_HMAC_KEY",
  "PILOT_GUARDIAN_HMAC_KEY",
  "NEXT_PUBLIC_SITE_URL",
  "SAFETY_ALERT_WEBHOOK_URL",
  "RESEND_API_KEY",
  "SAFETY_ALERT_EMAIL_FROM",
];

const saved = new Map(TOUCHED.map((name) => [name, process.env[name]]));

afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function clearAll() {
  for (const name of TOUCHED) delete process.env[name];
}

const byName = (name) => configChecks().find((check) => check.name.startsWith(name));

describe("configChecks", () => {
  it("reports every blocking setting as unsatisfied on a bare deployment", () => {
    clearAll();
    const gaps = blockingGaps().map((gap) => gap.name);
    for (const name of [
      "CRON_SECRET",
      "SAFETY_DISPATCH_TOKEN",
      "NEXT_PUBLIC_PILOT_MODE",
      "PILOT_INVITE_HMAC_KEY",
      "PILOT_GUARDIAN_HMAC_KEY",
      "NEXT_PUBLIC_SITE_URL",
    ]) {
      assert.ok(
        gaps.some((gap) => gap.startsWith(name)),
        `${name} should be reported as a blocking gap when unset`,
      );
    }
  });

  it("distinguishes a malformed key from a missing one", () => {
    clearAll();
    const missing = byName("SAFETY_RECIPIENT_HASH_KEY");
    assert.equal(missing.configured, false);
    assert.equal(missing.valid, false);

    // 16 bytes: set by somebody, and still too short to be the key.
    process.env.SAFETY_RECIPIENT_HASH_KEY = Buffer.alloc(16).toString("base64");
    const short = byName("SAFETY_RECIPIENT_HASH_KEY");
    assert.equal(short.configured, true, "a short key was still configured by someone");
    assert.equal(short.valid, false, "16 bytes is not a 32-byte key");

    process.env.SAFETY_RECIPIENT_HASH_KEY = Buffer.alloc(32).toString("base64");
    assert.equal(byName("SAFETY_RECIPIENT_HASH_KEY").valid, true);
  });

  it("treats either alert channel as a channel, and neither as none", () => {
    clearAll();
    assert.equal(byName("SAFETY_ALERT_WEBHOOK_URL").valid, false);

    process.env.SAFETY_ALERT_WEBHOOK_URL = "https://example.invalid/hook";
    assert.equal(byName("SAFETY_ALERT_WEBHOOK_URL").valid, true);

    delete process.env.SAFETY_ALERT_WEBHOOK_URL;
    process.env.RESEND_API_KEY = "re_test";
    assert.equal(byName("SAFETY_ALERT_WEBHOOK_URL").valid, false, "a key without a from address is not a channel");
    process.env.SAFETY_ALERT_EMAIL_FROM = "alerts@example.invalid";
    assert.equal(byName("SAFETY_ALERT_WEBHOOK_URL").valid, true);
  });

  it("counts an allowlist of whitespace and commas as empty", () => {
    clearAll();
    process.env.PILOT_OPERATOR_USER_IDS = " , ,  ";
    assert.equal(byName("PILOT_OPERATOR_USER_IDS").valid, false);
    process.env.PILOT_OPERATOR_USER_IDS = " ,abc, ";
    assert.equal(byName("PILOT_OPERATOR_USER_IDS").valid, true);
  });

  it("accepts only the exact string 1 for pilot mode", () => {
    clearAll();
    for (const value of ["0", "true", "yes", ""]) {
      process.env.NEXT_PUBLIC_PILOT_MODE = value;
      assert.equal(
        byName("NEXT_PUBLIC_PILOT_MODE").valid,
        false,
        `"${value}" must not read as pilot mode — next.config.ts compares against "1"`,
      );
    }
    process.env.NEXT_PUBLIC_PILOT_MODE = "1";
    assert.equal(byName("NEXT_PUBLIC_PILOT_MODE").valid, true);
  });

  describe("the guardian path (#289)", () => {
    /** Everything else a pilot deployment needs, so only the two rows under test can be gaps. */
    function configureEverythingElse() {
      clearAll();
      const key = Buffer.alloc(32, 1).toString("base64");
      process.env.CRON_SECRET = "cron";
      process.env.SAFETY_DISPATCH_TOKEN = "dispatch";
      process.env.SAFETY_ALERT_WEBHOOK_URL = "https://example.invalid/hook";
      process.env.NEXT_PUBLIC_PILOT_MODE = "1";
      process.env.PILOT_OPERATOR_USER_IDS = "operator-1";
      process.env.PILOT_INVITE_HMAC_KEY = key;
      process.env.PILOT_GUARDIAN_HMAC_KEY = key;
      process.env.NEXT_PUBLIC_SITE_URL = "https://pilot.example.jp";
    }
    const gapNames = () => blockingGaps().map((gap) => gap.name);

    it("is not ready when only the guardian key is missing", () => {
      // The reproduction in the issue: the invite key is set, the guardian key
      // is not, and the report used to say nothing was blocking.
      configureEverythingElse();
      assert.deepEqual(gapNames(), []);

      delete process.env.PILOT_GUARDIAN_HMAC_KEY;
      assert.deepEqual(gapNames(), ["PILOT_GUARDIAN_HMAC_KEY"]);
      const row = byName("PILOT_GUARDIAN_HMAC_KEY");
      assert.equal(row.configured, false);
      assert.equal(row.severity, byName("PILOT_INVITE_HMAC_KEY").severity);
    });

    it("tells a guardian key that is set wrongly from one that is not set", async () => {
      configureEverythingElse();
      const { guardianHmacKey } = await import("../src/lib/server/guardianTokens.ts");

      for (const [label, value] of [
        ["16 bytes", Buffer.alloc(16, 1).toString("base64")],
        ["not base64", "this is not a key!"],
        ["hex", "ab".repeat(32)],
      ]) {
        process.env.PILOT_GUARDIAN_HMAC_KEY = value;
        const row = byName("PILOT_GUARDIAN_HMAC_KEY");
        assert.equal(row.configured, true, `${label}: somebody did set it`);
        assert.equal(row.valid, false, `${label}: reported as usable`);
        // The report and the code that reads the key must not disagree.
        assert.equal(guardianHmacKey(), null, `${label}: the loader accepts what the report rejects`);
        assert.deepEqual(gapNames(), ["PILOT_GUARDIAN_HMAC_KEY"]);
      }

      process.env.PILOT_GUARDIAN_HMAC_KEY = Buffer.alloc(32, 1).toString("base64");
      assert.equal(byName("PILOT_GUARDIAN_HMAC_KEY").valid, true);
      assert.notEqual(guardianHmacKey(), null);
    });

    it("is not ready without a site URL, and says both things that break", () => {
      configureEverythingElse();
      delete process.env.NEXT_PUBLIC_SITE_URL;

      assert.deepEqual(gapNames(), ["NEXT_PUBLIC_SITE_URL"]);
      const row = byName("NEXT_PUBLIC_SITE_URL");
      assert.equal(row.configured, false);
      assert.match(row.consequence, /保護者確認リンク/);
      assert.match(row.consequence, /危機通知/);
      assert.match(row.consequence, /再デプロイ/);
    });

    it("rejects a site URL a link cannot be built on", async () => {
      configureEverythingElse();
      for (const value of [
        "pilot.example.jp",
        "http://pilot.example.jp",
        "https://pilot.example.jp/app",
        "https://pilot.example.jp/?utm=1",
        "https://user:pw@pilot.example.jp",
        "   ",
      ]) {
        process.env.NEXT_PUBLIC_SITE_URL = value;
        const row = byName("NEXT_PUBLIC_SITE_URL");
        assert.equal(row.valid, false, `"${value}" was reported as usable`);
        assert.equal(row.configured, value.trim() !== "", `"${value}"`);
        assert.deepEqual(gapNames(), ["NEXT_PUBLIC_SITE_URL"]);
      }
    });

    it("accepts an https origin, with or without the trailing slash, and the link is built on it", async () => {
      configureEverythingElse();
      const { guardianVerificationUrl } = await import("../src/lib/server/guardianTokens.ts");
      for (const value of ["https://pilot.example.jp", "https://pilot.example.jp/", "http://localhost:3000"]) {
        process.env.NEXT_PUBLIC_SITE_URL = value;
        assert.equal(byName("NEXT_PUBLIC_SITE_URL").valid, true, value);
        assert.equal(guardianVerificationUrl("t"), `${value.replace(/\/$/, "")}/pilot/guardian/t`);
      }
    });
  });

  it("never carries a configured value into the report", () => {
    clearAll();
    const sentinel = "SENTINEL-c0ffee-do-not-leak";
    process.env.CRON_SECRET = sentinel;
    process.env.SAFETY_DISPATCH_TOKEN = sentinel;
    process.env.PILOT_INVITE_HMAC_KEY = sentinel;
    process.env.RESEARCH_RAW_TEXT_KEY = sentinel;
    process.env.SAFETY_RECIPIENT_HASH_KEY = sentinel;
    process.env.PILOT_OPERATOR_USER_IDS = sentinel;
    process.env.PILOT_GUARDIAN_HMAC_KEY = sentinel;
    process.env.NEXT_PUBLIC_SITE_URL = `https://${sentinel}.example.jp/path`;

    const serialized = JSON.stringify(configChecks());
    assert.ok(!serialized.includes(sentinel), "a secret's value reached the ops report");
    // Nor its length, which is a hint worth withholding.
    assert.ok(!serialized.includes(String(sentinel.length)), "the report leaked a secret's length");
  });
});

describe("oldestOwedMinutes", () => {
  const now = new Date("2026-09-20T12:00:00.000Z");

  it("is null when nothing is owed", () => {
    assert.equal(oldestOwedMinutes([], now), null);
    assert.equal(oldestOwedMinutes([null, null], now), null);
  });

  it("answers with the oldest, not the newest", () => {
    const minutes = oldestOwedMinutes(
      ["2026-09-20T11:55:00.000Z", "2026-09-20T09:00:00.000Z", "2026-09-20T11:59:00.000Z"],
      now,
    );
    assert.equal(minutes, 180);
  });

  it("ignores unparseable stamps rather than reporting NaN", () => {
    assert.equal(oldestOwedMinutes(["not-a-date", "2026-09-20T11:30:00.000Z"], now), 30);
    assert.equal(oldestOwedMinutes(["not-a-date"], now), null);
  });

  it("floors a clock-skewed future stamp at zero", () => {
    assert.equal(oldestOwedMinutes(["2026-09-20T12:05:00.000Z"], now), 0);
  });

  it("uses a staleness threshold well above GitHub's scheduler jitter", () => {
    // Five minutes is the target; a single delayed run is normal on a
    // best-effort scheduler, and alerting on it trains people to ignore this.
    assert.ok(DISPATCH_STALE_MINUTES >= 15, "a threshold this tight would fire on ordinary queueing");
  });
});

describe("the ops route", () => {
  const source = read("../src/app/api/pilot/admin/ops/route.ts");

  it("reads no text column from entries", () => {
    // The same rule the dashboard follows: this endpoint is polled by machines
    // and left open on screens, and a field that can carry a passage will.
    for (const column of ["raw_text,", "raw_text\"", "content", "body"]) {
      assert.ok(!source.includes(`select("${column}`), `ops must not select ${column}`);
    }
    assert.ok(
      source.includes('.select("id", { count: "exact", head: true })'),
      "entry reads should be counts, not rows",
    );
  });

  it("answers a failed read as a failed read, not as zero", () => {
    assert.ok(source.includes("read_errors"), "a read that failed must be visible in the response");
    assert.ok(
      source.includes("readErrors.length === 0"),
      "ready must not be true while a read that would have contradicted it failed",
    );
  });

  it("requires an operator or the cron secret", () => {
    assert.ok(source.includes("requireOperator"), "no anonymous access");
    assert.ok(source.includes("authorizedCron"), "an uptime check needs a way in that is not a browser session");
  });
});
