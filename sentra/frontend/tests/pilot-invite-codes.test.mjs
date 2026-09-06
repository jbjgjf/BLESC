import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";

import {
  CODE_ENTROPY_BITS,
  CODE_PREFIX_LENGTH,
  generateInviteCode,
  generateResearchCode,
  hashInviteCode,
  hashesEqual,
  inviteCodePrefix,
  inviteHashingConfigured,
  normalizeInviteCode,
} from "../src/lib/server/inviteCodes.ts";

const KEY_A = Buffer.alloc(32, 7).toString("base64");
const KEY_B = Buffer.alloc(32, 9).toString("base64");

function withKey(value, fn) {
  const previous = process.env.PILOT_INVITE_HMAC_KEY;
  if (value === null) delete process.env.PILOT_INVITE_HMAC_KEY;
  else process.env.PILOT_INVITE_HMAC_KEY = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.PILOT_INVITE_HMAC_KEY;
    else process.env.PILOT_INVITE_HMAC_KEY = previous;
  }
}

afterEach(() => {
  delete process.env.PILOT_INVITE_HMAC_KEY;
});

describe("generateInviteCode", () => {
  it("carries at least 100 bits", () => {
    assert.ok(CODE_ENTROPY_BITS >= 100, `entropy was ${CODE_ENTROPY_BITS}`);
  });

  it("produces four readable groups from the unambiguous alphabet", () => {
    for (let i = 0; i < 200; i += 1) {
      const code = generateInviteCode();
      assert.match(code, /^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){3}$/, code);
      // The four characters people confuse must never be minted.
      assert.doesNotMatch(code, /[ILOU]/, code);
    }
  });

  it("does not repeat itself across a batch the size of a real study", () => {
    const codes = new Set();
    for (let i = 0; i < 1000; i += 1) codes.add(generateInviteCode());
    assert.equal(codes.size, 1000);
  });
});

describe("normalizeInviteCode", () => {
  it("accepts what a person actually types", () => {
    const canonical = "ABCDE-FGHJK-MNPQR-STVWX";
    const expected = "ABCDEFGHJKMNPQRSTVWX";

    assert.equal(normalizeInviteCode(canonical), expected);
    assert.equal(normalizeInviteCode(canonical.toLowerCase()), expected);
    assert.equal(normalizeInviteCode("ABCDE FGHJK MNPQR STVWX"), expected);
    assert.equal(normalizeInviteCode("ABCDEFGHJKMNPQRSTVWX"), expected);
    assert.equal(normalizeInviteCode("abcde—fghjk_mnpqr stvwx"), expected);
  });

  it("maps the classic misreadings instead of rejecting them", () => {
    // A student reading a printed code says O for 0, I or l for 1.
    assert.equal(normalizeInviteCode("O1234-5678I-9ABCD-EFGHl"), "01234567819ABCDEFGH1");
    assert.equal(normalizeInviteCode("U1234-56789-ABCDE-FGHJK"), "V123456789ABCDEFGHJK");
  });

  it("refuses anything that is not the right length", () => {
    assert.equal(normalizeInviteCode("ABCDE-FGHJK-MNPQR-STVW"), null);
    assert.equal(normalizeInviteCode("ABCDE-FGHJK-MNPQR-STVWXY"), null);
    assert.equal(normalizeInviteCode(""), null);
    assert.equal(normalizeInviteCode("   "), null);
  });

  it("refuses non-strings rather than coercing them", () => {
    assert.equal(normalizeInviteCode(undefined), null);
    assert.equal(normalizeInviteCode(null), null);
    assert.equal(normalizeInviteCode(12345), null);
    assert.equal(normalizeInviteCode({}), null);
  });
});

describe("inviteCodePrefix", () => {
  it("is short enough to be useless on its own", () => {
    assert.equal(CODE_PREFIX_LENGTH, 4);
    const normalized = normalizeInviteCode(generateInviteCode());
    assert.equal(inviteCodePrefix(normalized).length, 4);
  });
});

describe("hashInviteCode", () => {
  it("returns null with no key, so a misconfigured deployment redeems nothing", () => {
    withKey(null, () => {
      assert.equal(inviteHashingConfigured(), false);
      assert.equal(hashInviteCode(generateInviteCode()), null);
    });
  });

  it("returns null for a key that is not 32 bytes", () => {
    withKey(Buffer.alloc(16, 1).toString("base64"), () => {
      assert.equal(inviteHashingConfigured(), false);
      assert.equal(hashInviteCode(generateInviteCode()), null);
    });
  });

  it("hashes the normalised form, so how it was typed does not matter", () => {
    withKey(KEY_A, () => {
      const code = generateInviteCode();
      const typed = code.toLowerCase().replace(/-/g, " ");
      assert.equal(hashInviteCode(code), hashInviteCode(typed));
    });
  });

  it("gives different hashes under different keys", () => {
    const code = generateInviteCode();
    const underA = withKey(KEY_A, () => hashInviteCode(code));
    const underB = withKey(KEY_B, () => hashInviteCode(code));
    assert.notEqual(underA, underB);
  });

  it("never returns the code, in any form", () => {
    withKey(KEY_A, () => {
      const code = generateInviteCode();
      const hash = hashInviteCode(code);
      const normalized = normalizeInviteCode(code);
      assert.match(hash, /^[0-9a-f]{64}$/);
      assert.ok(!hash.includes(normalized));
      // Nor any five-character group of it.
      for (const group of code.split("-")) {
        assert.ok(!hash.toUpperCase().includes(group), `hash leaked group ${group}`);
      }
    });
  });

  it("refuses a malformed code before it reaches the key", () => {
    withKey(KEY_A, () => {
      assert.equal(hashInviteCode("too-short"), null);
    });
  });
});

describe("hashesEqual", () => {
  it("matches identical hashes and rejects different ones", () => {
    withKey(KEY_A, () => {
      const code = generateInviteCode();
      const other = generateInviteCode();
      assert.equal(hashesEqual(hashInviteCode(code), hashInviteCode(code)), true);
      assert.equal(hashesEqual(hashInviteCode(code), hashInviteCode(other)), false);
    });
  });

  it("returns false rather than throwing on a length mismatch", () => {
    assert.equal(hashesEqual("abc", "abcd"), false);
  });
});

describe("generateResearchCode", () => {
  it("is a short pseudonym, not a name", () => {
    for (let i = 0; i < 100; i += 1) {
      assert.match(generateResearchCode(), /^P-[0-9A-HJKMNP-TV-Z]{6}$/);
    }
  });

  it("collides rarely enough that a retry-on-conflict is sufficient", () => {
    const codes = new Set();
    for (let i = 0; i < 5000; i += 1) codes.add(generateResearchCode());
    // 5000 draws from 32^6 ≈ 1.07e9: a handful of collisions would still be
    // within chance, but anything approaching 1% means the generator is broken.
    assert.ok(codes.size > 4990, `only ${codes.size} distinct codes from 5000 draws`);
  });
});
