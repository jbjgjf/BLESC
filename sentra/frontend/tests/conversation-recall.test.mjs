import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  LATEST_TURN_EXCERPT,
  TOPIC_COUNT,
  extractTopics,
  latestUserTurn,
  turnCounts,
} from "../src/lib/conversationRecall.ts";
import { t } from "../src/lib/i18n/index.ts";

/**
 * `/recall`'s 「覚えていること」 panel (#365).
 *
 * Two properties, both of which the route handler violated while every one of
 * the 805 other tests stayed green — `scripts/ui-strings.mjs` skips
 * `src/app/api`, so nothing read what that handler wrote:
 *
 *   1. The summary sentence is read by a Japanese student. It was English.
 *   2. The topics are stored as research data. For a Japanese conversation
 *      they were always `[]`, which reads as "nothing recurred" and meant
 *      "nothing could be seen".
 */

/** Six user turns, the threshold the route requires before it summarises. */
const JAPANESE_CONVERSATION = [
  { role: "user", content_redacted: "今日は部活の試合で緊張したけど、友だちと話して少し落ち着いた。" },
  { role: "assistant", content_redacted: "緊張したのに最後まで走りきれたのですね。" },
  { role: "user", content_redacted: "明日はテストがあるから勉強しないといけない。眠れない。" },
  { role: "assistant", content_redacted: "眠れないのはつらいですね。" },
  { role: "user", content_redacted: "部活と勉強の両立がしんどい。" },
  { role: "assistant", content_redacted: "両立は簡単ではないですよね。" },
  { role: "user", content_redacted: "友だちに相談してみようと思う。" },
  { role: "assistant", content_redacted: "いい考えだと思います。" },
  { role: "user", content_redacted: "今日は少し眠れた。" },
  { role: "assistant", content_redacted: "よかったです。" },
  { role: "user", content_redacted: "テストが終わってほっとした。部活にまた集中できる。" },
  { role: "assistant", content_redacted: "おつかれさまでした。" },
];

/** The same conversation in English, which is the case that already worked. */
const ENGLISH_CONVERSATION = [
  { role: "user", content_redacted: "I was nervous about the club match today but talking with a friend calmed me down." },
  { role: "assistant", content_redacted: "You kept going even though you were nervous." },
  { role: "user", content_redacted: "I have a test tomorrow so I must study. I cannot sleep." },
  { role: "assistant", content_redacted: "Not sleeping is hard." },
  { role: "user", content_redacted: "Balancing club and study is exhausting." },
  { role: "assistant", content_redacted: "Balancing is not easy." },
  { role: "user", content_redacted: "I think I will talk to a friend about the club." },
  { role: "assistant", content_redacted: "That sounds like a good idea." },
  { role: "user", content_redacted: "I slept a little better today." },
  { role: "assistant", content_redacted: "Glad to hear it." },
  { role: "user", content_redacted: "The test is over and I feel relieved. I can focus on club again." },
  { role: "assistant", content_redacted: "Well done." },
];

const topicNames = (messages) => extractTopics(messages).map((entry) => entry.topic);

describe("recall topics — the Japanese case that returned nothing", () => {
  it("finds recurring topics in a Japanese conversation", () => {
    const topics = extractTopics(JAPANESE_CONVERSATION);

    // The regression this file exists for: the list was `[]` for every
    // Japanese participant, whatever they wrote.
    assert.notDeepEqual(topics, []);
    assert.ok(topics.length > 1, `expected more than one topic, got ${JSON.stringify(topics)}`);
  });

  it("names what the student actually talked about", () => {
    const names = topicNames(JAPANESE_CONVERSATION);

    // 部活 appears in three turns and 勉強 in two, so both have to be in a
    // five-topic list. Asserting the words rather than the count is the point:
    // a list of particles would satisfy "not empty" and say nothing.
    assert.ok(names.includes("部活"), `missing 部活 in ${JSON.stringify(names)}`);
    assert.ok(names.includes("勉強"), `missing 勉強 in ${JSON.stringify(names)}`);
  });

  it("counts a repeated topic once per occurrence", () => {
    const counts = new Map(extractTopics(JAPANESE_CONVERSATION).map((e) => [e.topic, e.count]));
    assert.equal(counts.get("部活"), 3);
  });

  it("still reads an English conversation", () => {
    // The chat prompt tells the model to answer in the student's language, so a
    // conversation can be either or both. Adding Japanese must not cost the
    // behaviour that was already there.
    const names = topicNames(ENGLISH_CONVERSATION);
    assert.ok(names.includes("club"), `missing club in ${JSON.stringify(names)}`);
    assert.ok(names.includes("study"), `missing study in ${JSON.stringify(names)}`);
  });

  it("reads both scripts in one conversation", () => {
    const names = topicNames([
      { role: "user", content_redacted: "部活のあとに club activities のことを考えていた。" },
      { role: "user", content_redacted: "部活は楽しいけれど、club のメンバーと少し気まずい。" },
    ]);
    assert.ok(names.includes("部活"), `missing 部活 in ${JSON.stringify(names)}`);
    assert.ok(names.includes("club"), `missing club in ${JSON.stringify(names)}`);
  });

  it("leaves out words this product put in the conversation itself", () => {
    // 今日 is the journal's own field heading (「今日の気分」, 「今日のこと」), so
    // counting it measures the form rather than the student — the same reason
    // `recent`, `patterns` and `reflect` were already excluded.
    const names = topicNames([
      { role: "user", content_redacted: "今日は今日のことを書いた。今日は今日。" },
      { role: "user", content_redacted: "今日も今日とて、今日の記録。" },
    ]);
    assert.ok(!names.includes("今日"), `今日 should not be a topic: ${JSON.stringify(names)}`);
  });

  it("does not offer hiragana inflection as a topic", () => {
    // Without a morphological analyser, hiragana runs are particles and verb
    // endings. A topic list made of 「という」 and 「ことが」 would be worse than
    // an empty one, because it would look like an answer.
    const names = topicNames([
      { role: "user", content_redacted: "そうなんだけど、やっぱりそういうことがあって、どうしようかな。" },
      { role: "user", content_redacted: "そういうことがあると、そうなってしまう。" },
    ]);
    for (const name of names) {
      assert.ok(
        /[一-鿿々-〇ァ-ヺ]/.test(name),
        `${JSON.stringify(name)} is hiragana or Latin-only and should not be a topic`,
      );
    }
  });

  it("is stable when two topics are seen the same number of times", () => {
    // The result is written to `conversation_recall_summaries`. Two reads of
    // one conversation must not produce two different research rows.
    const messages = [
      { role: "user", content_redacted: "部活と勉強と読書。" },
      { role: "user", content_redacted: "読書と勉強と部活。" },
    ];
    assert.deepEqual(extractTopics(messages), extractTopics([...messages]));
    assert.deepEqual(topicNames(messages), topicNames(messages.slice().reverse()));
  });

  it("carries at most five topics", () => {
    const names = topicNames([
      {
        role: "user",
        content_redacted: "部活 勉強 読書 音楽 家族 友人 試験 睡眠 運動 弁当",
      },
    ]);
    assert.equal(names.length, TOPIC_COUNT);
  });

  it("tolerates a row with no redacted text", () => {
    assert.deepEqual(extractTopics([{ role: "user", content_redacted: null }]), []);
  });
});

describe("recall summary — the sentence the student reads", () => {
  it("is the catalogue's Japanese, not prose built in the handler", () => {
    const turns = turnCounts(JAPANESE_CONVERSATION);
    const latest = latestUserTurn(JAPANESE_CONVERSATION);
    const summary = t.recall.memorySummary.withLatestTurn(
      turns.user,
      turns.assistant,
      latest.slice(0, LATEST_TURN_EXCERPT),
    );

    assert.ok(/[぀-ヿ一-鿿]/.test(summary), "the summary has no Japanese in it");
    assert.ok(summary.includes("テストが終わってほっとした"), "the latest turn is not quoted back");
    // The sentence around the student's words is the part that was English.
    // The student's own turn may contain Latin letters, so the check is on
    // what the catalogue adds, not on the whole string.
    const framing = summary.replace(latest.slice(0, LATEST_TURN_EXCERPT), "");
    assert.ok(
      !/[A-Za-z]{2,}(\s+[A-Za-z]{2,})+/.test(framing.replace("blesc", "")),
      `English prose in the framing: ${JSON.stringify(framing)}`,
    );
  });

  it("counts user and assistant turns separately", () => {
    assert.deepEqual(turnCounts(JAPANESE_CONVERSATION), { user: 6, assistant: 6 });
  });

  it("names the counts in the sentence", () => {
    const summary = t.recall.memorySummary.counts(6, 6);
    assert.ok(summary.includes("6"), summary);
  });

  it("has a Japanese sentence for a window that is too short", () => {
    // Stored in `summary_json.summary` and read back by a researcher even
    // though the screen shows its own message instead.
    const stored = t.recall.memorySummary.notEnoughHistory;
    assert.ok(/[぀-ヿ一-鿿]/.test(stored), stored);
    assert.ok(!/[A-Za-z]{2,}/.test(stored), stored);
  });
});

describe("the latest user turn", () => {
  it("is the last user message that has text", () => {
    assert.equal(
      latestUserTurn([
        { role: "user", content_redacted: "さいしょ" },
        { role: "user", content_redacted: "さいご" },
        { role: "assistant", content_redacted: "応答" },
      ]),
      "さいご",
    );
  });

  it("skips a user row with no text rather than quoting the assistant", () => {
    assert.equal(
      latestUserTurn([
        { role: "user", content_redacted: "のこっている本文" },
        { role: "assistant", content_redacted: "応答" },
        { role: "user", content_redacted: null },
      ]),
      "のこっている本文",
    );
  });

  it("is null when the student has said nothing with text", () => {
    assert.equal(latestUserTurn([{ role: "assistant", content_redacted: "応答" }]), null);
  });

  it("is quoted back at most LATEST_TURN_EXCERPT characters", () => {
    const long = "あ".repeat(LATEST_TURN_EXCERPT + 50);
    const summary = t.recall.memorySummary.withLatestTurn(1, 1, long.slice(0, LATEST_TURN_EXCERPT));
    assert.ok(!summary.includes(long), "the whole turn was quoted");
    assert.ok(summary.includes("あ".repeat(LATEST_TURN_EXCERPT)), "the excerpt was truncated further");
  });
});
