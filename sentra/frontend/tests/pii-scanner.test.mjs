import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { redactFindings, scanForPii, summarizePii } from "../src/lib/piiScanner.ts";

const kinds = (text) => scanForPii(text).map((finding) => finding.kind);

describe("scanForPii — what it must catch", () => {
  it("finds an email address", () => {
    assert.deepEqual(kinds("連絡先は yui.tanaka@example.ac.jp です"), ["email"]);
  });

  it("finds a mobile number with and without hyphens", () => {
    assert.ok(kinds("090-1234-5678 にかけて").includes("phone"));
    assert.ok(kinds("09012345678 にかけて").includes("phone"));
  });

  it("finds a landline", () => {
    assert.ok(kinds("学校の番号は03-1234-5678").includes("phone"));
  });

  it("finds a URL", () => {
    assert.ok(kinds("https://example.com/私の日記 を見て").includes("url"));
  });

  it("finds a postal code", () => {
    assert.ok(kinds("〒150-0001 に住んでいる").includes("postal_code"));
  });

  it("finds a school name", () => {
    assert.ok(kinds("桜丘中学校の文化祭だった").includes("school_name"));
    assert.ok(kinds("第三高等学校に進学したい").includes("school_name"));
  });

  it("finds a family name with an honorific", () => {
    assert.ok(kinds("田中先生に相談した").includes("person_name_honorific"));
    assert.ok(kinds("佐藤さんと帰った").includes("person_name_honorific"));
  });

  it("finds an address", () => {
    assert.ok(kinds("東京都渋谷区に引っ越した").includes("address"));
  });

  it("finds a social handle", () => {
    assert.ok(kinds("LINEは @yui_tanaka だよ").includes("social_handle"));
  });

  it("finds a class identifier", () => {
    assert.ok(kinds("3年2組でのできごと").includes("class_identifier"));
    assert.ok(kinds("出席番号 12 の子").includes("class_identifier"));
  });
});

describe("scanForPii — what it must not flag", () => {
  it("does not treat a bare date as a birthdate", () => {
    // A journal is mostly dates. Flagging every one would bury the queue.
    assert.deepEqual(kinds("9月6日は体育祭だった"), []);
  });

  it("does not treat a time as a phone number", () => {
    assert.deepEqual(kinds("10:30に集合した"), []);
  });

  it("does not treat a count as a phone number", () => {
    assert.deepEqual(kinds("全部で1200人が参加した"), []);
  });

  it("does not match a phone-length fragment inside a longer digit run", () => {
    // An order or ticket number is not a phone number, and matching its first
    // eleven digits would put a false finding in the queue every time.
    assert.deepEqual(kinds("注文番号は08012345678901です"), []);
  });

  it("does not flag kinship terms as person names", () => {
    assert.deepEqual(kinds("お母さんと話した"), []);
    assert.deepEqual(kinds("お兄ちゃんが帰ってきた"), []);
  });

  it("does not flag a role as a person name", () => {
    assert.deepEqual(kinds("担任さんに提出した"), []);
  });

  it("does not flag ordinary feelings text", () => {
    assert.deepEqual(kinds("今日はしんどかった。部活で失敗して落ち込んでいる。"), []);
  });

  it("does not flag a bare @ followed by digits", () => {
    assert.ok(!kinds("集合は@3限のあと").includes("social_handle"));
  });
});

describe("scanForPii — mechanics", () => {
  it("returns findings in document order", () => {
    const text = "田中先生に 090-1234-5678 で連絡した";
    const found = scanForPii(text);
    const starts = found.map((f) => f.start);
    assert.deepEqual([...starts].sort((a, b) => a - b), starts);
  });

  it("reports spans that slice back to the matched text", () => {
    const text = "メールは a@b.co.jp です";
    for (const finding of scanForPii(text)) {
      assert.equal(text.slice(finding.start, finding.end), finding.text);
    }
  });

  it("is stable across repeated calls on the same string", () => {
    // A shared global regex carries `lastIndex` between calls; the second scan
    // would silently return fewer findings than the first.
    const text = "090-1234-5678 と 080-8765-4321";
    assert.deepEqual(scanForPii(text), scanForPii(text));
  });

  it("keeps overlapping findings rather than collapsing them", () => {
    const found = kinds("〒150-0001 東京都渋谷区神南");
    assert.ok(found.includes("postal_code"));
    assert.ok(found.includes("address"));
  });

  it("returns nothing for empty input", () => {
    assert.deepEqual(scanForPii(""), []);
  });
});

describe("summarizePii", () => {
  it("counts by confidence and kind", () => {
    const summary = summarizePii(scanForPii("田中先生 090-1234-5678 a@b.jp"));
    assert.equal(summary.high, 2); // phone + email
    assert.equal(summary.medium, 1); // name with honorific
    assert.equal(summary.total, 3);
    assert.equal(summary.kinds.phone, 1);
  });

  it("is all zeroes for no findings", () => {
    assert.deepEqual(summarizePii([]), { total: 0, high: 0, medium: 0, low: 0, kinds: {} });
  });
});

describe("redactFindings", () => {
  it("replaces a finding with its kind", () => {
    const text = "メールは a@b.co.jp です";
    assert.equal(redactFindings(text, scanForPii(text)), "メールは [email] です");
  });

  it("leaves text without findings untouched", () => {
    const text = "今日はしんどかった";
    assert.equal(redactFindings(text, scanForPii(text)), text);
  });

  it("merges overlapping findings into one replacement", () => {
    const text = "〒150-0001 東京都渋谷区";
    const out = redactFindings(text, scanForPii(text));
    // Overlaps replaced twice would corrupt the offsets and leave fragments.
    assert.ok(!out.includes("150-0001"));
    assert.ok(!out.includes("渋谷区"));
    assert.ok(out.includes("["));
  });

  it("preserves the text between findings", () => {
    const text = "田中先生に a@b.jp で連絡";
    const out = redactFindings(text, scanForPii(text));
    assert.ok(out.includes("に"));
    assert.ok(out.includes("で連絡"));
  });
});
