/**
 * The summary and the recurring topics behind `/recall`'s 「覚えていること」 panel.
 *
 * Lifted out of `app/api/research/conversation-recall/route.ts` so that both
 * halves of what it produces can be checked (#365). Both were wrong in the same
 * way, and in a way the route's shape hid:
 *
 *   1. The summary sentence was English prose built in the handler. It is
 *      rendered verbatim at `app/recall/page.tsx` under the Japanese heading
 *      「覚えていること」, so a Japanese student read an English sentence wrapped
 *      around their own words. The wording now comes from the catalogue, like
 *      every other string a student reads (#116).
 *
 *   2. The topics were matched with `/[a-z][a-z'-]{3,}/`, which cannot match
 *      Japanese at all. Every Japanese participant's `recurring_topics` and
 *      `top_topics` were therefore `[]` — not "no topic recurred", but "no
 *      topic could be seen". Those two fields are stored in
 *      `conversation_recall_summaries.summary_json` and read back as research
 *      data, so the gap was not only cosmetic.
 *
 * The language guard could not have caught either: `scripts/ui-strings.mjs`
 * skips `src/app/api` wholesale. That exemption is the remaining half of #365
 * and is deliberately not touched here — see the issue for why it cannot land
 * in the same change.
 */

/**
 * Enough of a chat row to summarise. The route selects more columns than this;
 * taking only what is read keeps the test fixtures honest about what the
 * summary actually depends on.
 */
export type RecallMessage = {
  role: string;
  content_redacted: string | null;
};

export type RecallTopic = {
  topic: string;
  count: number;
};

/** How much of the latest turn is quoted back in the summary. */
export const LATEST_TURN_EXCERPT = 180;

/** How many topics the summary carries. */
export const TOPIC_COUNT = 5;

/**
 * Latin words, as before. Kept because a conversation can be mixed: the chat
 * prompt tells the model to answer in the student's language, so an English
 * turn inside a Japanese conversation is a supported case, not a bug.
 */
const LATIN_WORD = /[a-z][a-z'-]{3,}/g;

/**
 * Japanese words, approximated by the runs that carry meaning.
 *
 * Kanji runs (including 々 〆 〇) and katakana runs of two characters or more.
 * Pure-hiragana runs are left out on purpose: without a morphological analyser
 * they are mostly particles and inflection — 「して」「という」「ことが」 — and a
 * topic list made of those says nothing about what the student talked about.
 *
 * **What this misses, stated rather than hidden.** A word written as one kanji
 * plus hiragana is not captured: 「友だち」 contributes nothing, because 友 is a
 * single-character run. Neither is a topic written only in hiragana. Catching
 * those needs real segmentation (kuromoji or an equivalent), which is a
 * dependency and a decision of its own; it is not required to stop the list
 * from being empty, which is what this change is for. A later pass that adds a
 * tokeniser should replace this constant and keep the tests.
 */
const JAPANESE_WORD = /[一-鿿々-〇]{2,}|[ァ-ヺ][ァ-ヺー]+/g;

/**
 * Words that would otherwise always win.
 *
 * The English list is the one that was already here. Its three non-function
 * entries — `recent`, `patterns`, `reflect` — are not stop words in general;
 * they are words this product puts into the conversation itself, so counting
 * them measures the prompt rather than the student. The Japanese list is held
 * to that same test, which is why it is short: a word the student chose is a
 * topic even when it is a common one. Nothing goes in here that cannot be
 * traced to a prompt, a heading or a date.
 *
 *   最近 / 傾向 / 話題 — the Japanese of `recent` / `patterns`, and the word
 *                        `recall.intro` uses for what this panel produces.
 *   今日 / 明日 / 昨日 — the journal's own field headings are 「今日の気分」
 *                        「今日あった出来事」「今日のこと」.
 *   自分            — carried by the safety wording, not by a subject.
 */
const STOP_WORDS = new Set([
  "about",
  "after",
  "again",
  "blesc",
  "could",
  "from",
  "have",
  "that",
  "this",
  "with",
  "what",
  "when",
  "where",
  "your",
  "recent",
  "patterns",
  "reflect",
  "最近",
  "傾向",
  "話題",
  "今日",
  "明日",
  "昨日",
  "自分",
]);

/** Every candidate word in one message, in both scripts. */
function words(text: string): string[] {
  const lowered = text.toLowerCase();
  return [...(lowered.match(LATIN_WORD) ?? []), ...(text.match(JAPANESE_WORD) ?? [])];
}

/**
 * The recurring topics in a window, most frequent first.
 *
 * Ties break on the word so the list is stable: two topics seen the same number
 * of times must not swap places between two reads of the same conversation,
 * because the result is written to a research row.
 */
export function extractTopics(messages: RecallMessage[]): RecallTopic[] {
  const counts = new Map<string, number>();
  for (const message of messages) {
    for (const word of words(message.content_redacted ?? "")) {
      if (!STOP_WORDS.has(word)) counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], "ja"))
    .slice(0, TOPIC_COUNT)
    .map(([topic, count]) => ({ topic, count }));
}

/** Turn counts, which the summary sentence names. */
export function turnCounts(messages: RecallMessage[]) {
  return {
    user: messages.filter((message) => message.role === "user").length,
    assistant: messages.filter((message) => message.role === "assistant").length,
  };
}

/** The student's most recent turn that has text, or null. */
export function latestUserTurn(messages: RecallMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "user" && message.content_redacted) return message.content_redacted;
  }
  return null;
}
