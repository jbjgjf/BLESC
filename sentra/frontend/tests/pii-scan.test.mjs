import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  PII_SCANNER_LIMITS,
  PII_SCANNER_VERSION,
  redactFindings,
  scanForPii,
  summarizeFindings,
} from "../src/lib/piiScan.ts";

/**
 * Every string below is synthetic. No text in this file came from a
 * participant, and none ever may (#167: サンプルは合成データだけで作り).
 */

const kindsIn = (text) => scanForPii(text).map((finding) => finding.kind);

describe("true positives — the identifiers a school journal actually contains", () => {
  const cases = [
    ["email", "連絡は sakura.t@example.ac.jp までお願いします。"],
    ["phone_jp", "母の携帯は 090-1234-5678 です。"],
    ["phone_jp", "学校の番号は 03-1234-5678 だった。"],
    ["my_number", "マイナンバーは 123456789012 と書いてあった。"],
    ["student_id", "学籍番号は 2026B014 と登録した。"],
    ["student_id", "生徒番号：14 を書かされた。"],
    ["postal_code_jp", "〒150-0001 に送るらしい。"],
    ["address_jp", "東京都渋谷区のあたりで待ち合わせた。"],
    ["school_name", "桜丘高校の文化祭に行った。"],
    ["school_name", "青葉中学校の先輩と会った。"],
    ["person_name_honorific", "田中さんに借りたノートを返した。"],
    ["person_name_honorific", "佐藤先生に相談した。"],
    ["sns_handle", "返事がないので @sakura_2026 にDMした。"],
    ["url", "https://example.com/diary を見せてもらった。"],
  ];

  for (const [kind, text] of cases) {
    it(`finds ${kind} in ${JSON.stringify(text)}`, () => {
      assert.ok(kindsIn(text).includes(kind), `expected ${kind}, got ${JSON.stringify(kindsIn(text))}`);
    });
  }

  it("finds a full-width phone number, which a Japanese IME produces by default", () => {
    // The reason `narrow()` exists. A scanner that only knows half-width digits
    // misses the form most students actually type.
    assert.deepEqual(kindsIn("０９０−１２３４−５６７８ にかけた。"), ["phone_jp"]);
  });

  it("keeps offsets valid against the original string after width folding", () => {
    const text = "電話は ０９０−１２３４−５６７８ です。";
    const [finding] = scanForPii(text);
    assert.equal(text.slice(finding.start, finding.end), "０９０−１２３４−５６７８");
  });
});

describe("false positives — the entries this must not fill the queue with", () => {
  const clean = [
    "今日は部活の練習がきつかった。ずっと走っていた。",
    "お母さんは怒っていたけど、あとで謝ってくれた。",
    "先生に相談したほうがいいのかな、と思った。",
    "テストが 12 問しか解けなかった。",
    "3年生になったら受験だと言われた。",
    "東京はよかった。また行きたい。",
    "友だちと 15 分だけ話した。",
  ];

  for (const text of clean) {
    it(`leaves ${JSON.stringify(text)} alone`, () => {
      assert.deepEqual(scanForPii(text), [], `unexpected findings: ${JSON.stringify(kindsIn(text))}`);
    });
  }

  it("does not treat a family word as a classmate's name", () => {
    // お母さん matches the honorific pattern and is never an identifier. A
    // reviewer who sees it in every single entry stops reading the queue, which
    // costs more than the pattern gains.
    assert.deepEqual(scanForPii("お母さんとお父さんに話した。"), []);
  });

  it("does not swallow the particle in front of a name", () => {
    // 「今日は田中さん」 matched as one seven-character name when the pattern
    // allowed ひらがな in the body — and a finding whose offsets are wrong
    // redacts the wrong span.
    const text = "今日は田中さんと話した。";
    const [finding] = scanForPii(text);
    assert.equal(text.slice(finding.start, finding.end), "田中さん");
  });
});

describe("known false negatives are declared, not hidden", () => {
  it("misses a bare given name, and says so in the limits", () => {
    assert.deepEqual(scanForPii("ゆうたと帰った。"), []);
    assert.ok(PII_SCANNER_LIMITS.some((limit) => limit.includes("氏名だけ")));
  });

  it("misses an all-hiragana name with an honorific, and says so", () => {
    assert.deepEqual(scanForPii("さくらさんと話した。"), []);
    assert.ok(PII_SCANNER_LIMITS.some((limit) => limit.includes("ひらがなだけの氏名")));
  });

  it("misses indirect identification, and says so", () => {
    assert.deepEqual(scanForPii("3年の生徒会長に呼び出された。"), []);
    assert.ok(PII_SCANNER_LIMITS.some((limit) => limit.includes("間接的な特定")));
  });

  it("states that a clean scan is not anonymisation", () => {
    assert.ok(PII_SCANNER_LIMITS.some((limit) => limit.includes("匿名化の完了を意味しない")));
  });
});

describe("a finding never carries the text it found", () => {
  it("reports kind, severity and offsets only", () => {
    const [finding] = scanForPii("連絡先は taro@example.com です。");
    assert.deepEqual(Object.keys(finding).sort(), ["end", "kind", "length", "severity", "start"]);
  });

  it("keeps the matched string out of the serialised summary", () => {
    const text = "連絡先は taro@example.com、電話は 090-1234-5678。桜丘高校の田中さん。";
    const serialised = JSON.stringify(summarizeFindings(scanForPii(text)));
    for (const secret of ["taro@example.com", "090-1234-5678", "桜丘高校", "田中"]) {
      assert.ok(!serialised.includes(secret), `summary leaked ${secret}`);
    }
  });

  it("summarises to the fields the queue row stores", () => {
    const summary = summarizeFindings(scanForPii("taro@example.com と 090-1234-5678"));
    assert.equal(summary.scanner_version, PII_SCANNER_VERSION);
    assert.equal(summary.finding_count, 2);
    assert.equal(summary.max_severity, "high");
    assert.deepEqual(summary.kinds, ["email", "phone_jp"]);
  });

  it("reports no severity when nothing matched", () => {
    const summary = summarizeFindings(scanForPii("今日はよく眠れた。"));
    assert.equal(summary.finding_count, 0);
    assert.equal(summary.max_severity, null);
    assert.deepEqual(summary.kinds, []);
  });

  it("ranks a high finding above a medium one in the same text", () => {
    const summary = summarizeFindings(scanForPii("桜丘高校の連絡先は taro@example.com。"));
    assert.equal(summary.max_severity, "high");
  });
});

describe("overlapping matches resolve once", () => {
  it("reports an email address as an email and not also as a handle or a URL", () => {
    assert.deepEqual(kindsIn("taro@example.com"), ["email"]);
  });

  it("reports an address and the school after it as two findings", () => {
    // The regression: a greedy school pattern matched from 東 through 桜丘,
    // overlapped the address, and the overlap rule then dropped it — losing
    // both findings from a sentence that contains two.
    assert.deepEqual(kindsIn("東京都渋谷区の桜丘高校に通っている。"), ["address_jp", "school_name"]);
  });
});

describe("redaction", () => {
  it("replaces every finding with a typed placeholder", () => {
    const text = "田中さんに taro@example.com を教えた。";
    assert.equal(
      redactFindings(text, scanForPii(text)),
      "[[PII:person_name_honorific]]に [[PII:email]] を教えた。",
    );
  });

  it("keeps the surrounding text byte-identical", () => {
    const text = "きのうは眠れなかった。090-1234-5678 にかけた。今日はましだった。";
    const redacted = redactFindings(text, scanForPii(text));
    assert.ok(redacted.startsWith("きのうは眠れなかった。"));
    assert.ok(redacted.endsWith("にかけた。今日はましだった。"));
  });

  it("handles several findings without shifting the ones it has not replaced yet", () => {
    const text = "taro@example.com と jiro@example.com と saburo@example.com";
    assert.equal(
      redactFindings(text, scanForPii(text)),
      "[[PII:email]] と [[PII:email]] と [[PII:email]]",
    );
  });

  it("returns the text unchanged when there is nothing to redact", () => {
    const text = "今日は何もなかった。";
    assert.equal(redactFindings(text, scanForPii(text)), text);
  });
});

describe("the scanner is safe to run on anything", () => {
  it("returns nothing for empty input", () => {
    assert.deepEqual(scanForPii(""), []);
  });

  it("does not loop on repeated scans of the same text", () => {
    // The patterns are module-level `g` regexes, which carry `lastIndex`
    // between `exec` loops. A scanner that forgets to reset it returns findings
    // for the first call and fewer for the second.
    const text = "taro@example.com に送った。";
    assert.deepEqual(scanForPii(text), scanForPii(text));
  });

  it("survives emoji, which are two code units per character", () => {
    const text = "今日は最高だった🎉🎉 taro@example.com";
    const [finding] = scanForPii(text).filter((item) => item.kind === "email");
    assert.equal(text.slice(finding.start, finding.end), "taro@example.com");
  });
});
