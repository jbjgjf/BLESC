import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { recallOfflineSafetyNotice, recallReply, sendRecallTurn } from "../src/lib/recallTurn.ts";
import { SAFETY_LEXICON_TERMS, assessSafety } from "../src/lib/safety-assessment.ts";
import { demoChatReply } from "../src/lib/blesc/demoApi.ts";

/**
 * `/recall` used to match ten crisis words in the browser and, on a match,
 * answer with a canned line without calling `/api/chat` — so the most explicit
 * disclosures were the only ones never assessed, audited or escalated (#343).
 */

// The list `app/recall/page.tsx` carried before #343, kept here so the
// regression is pinned to exactly the inputs that used to be dropped.
const FORMER_RECALL_CRISIS_TERMS = [
  "自殺",
  "死にたい",
  "消えたい",
  "殺したい",
  "傷つけたい",
  "suicide",
  "kill myself",
  "want to die",
  "self-harm",
  "hurt myself",
];

const COLLECTION_ONLY_ANSWER =
  "研究期間中は、AIの応答機能を停止しています。日記の記録はこれまでどおり保存されます。";

function fakeChat(answerFor = (message) => `${message} を受け取りました。`) {
  const calls = [];
  const createChat = async (content, options) => {
    calls.push({ content, options });
    const safety = assessSafety(content);
    // What the route does: the answer comes back with the safe response
    // already appended (`withSafetyFloor`).
    const base = answerFor(content);
    const answer = safety.safe_response ? `${base}\n\n${safety.safe_response}` : base;
    return {
      chat_session_id: "s",
      message_id: "m",
      answer,
      safety_assessment: safety,
      evidence_refs: {},
      retrieval_context: {},
      status: "completed",
      mirrored: true,
    };
  };
  return { calls, createChat };
}

function turnInput(content, createChat, overrides = {}) {
  return {
    content,
    turn: 3,
    maxTurns: 30,
    nextQuestion: "次の質問",
    completedText: "おわり",
    conversationContext: ["ctx"],
    createChat,
    ...overrides,
  };
}

describe("recall turn", () => {
  it("sends every term the page used to intercept to /api/chat", async () => {
    for (const term of FORMER_RECALL_CRISIS_TERMS) {
      const { calls, createChat } = fakeChat();
      const content = `最近、${term}と思うことがある`;
      await sendRecallTurn(turnInput(content, createChat));
      assert.equal(calls.length, 1, `"${term}" did not reach createChat`);
      assert.equal(calls[0].content, content);
      assert.equal(calls[0].options.mode, "recall_workspace");
      assert.deepEqual(calls[0].options.conversationContext, ["ctx"]);
    }
  });

  it("sends ordinary turns too, and asks the next question after them", async () => {
    const { calls, createChat } = fakeChat();
    const result = await sendRecallTurn(turnInput("今日は部活で疲れた", createChat));
    assert.equal(calls.length, 1);
    assert.match(result.reply, /次の質問$/);
  });

  it("shows the route's safe response for a crisis turn and stops the interview there", async () => {
    const { createChat } = fakeChat();
    const result = await sendRecallTurn(turnInput("死にたい", createChat));
    const crisis = assessSafety("死にたい").safe_response;
    assert.ok(crisis, "the lexicon gives 死にたい a safe response");
    assert.ok(result.reply.includes(crisis));
    assert.ok(!result.reply.includes("次の質問"), "a crisis reply must not end on the next interview question");
    assert.equal(result.safety?.risk_level, "crisis");
  });

  it("keeps the safe response when the AI is withheld for a collection window", async () => {
    const { createChat } = fakeChat(() => COLLECTION_ONLY_ANSWER);
    const result = await sendRecallTurn(turnInput("死にたい", createChat));
    assert.ok(result.reply.startsWith(COLLECTION_ONLY_ANSWER));
    assert.ok(result.reply.includes(assessSafety("死にたい").safe_response));
  });

  it("stops the interview after a crisis in demo mode too", async () => {
    const createChat = async (content) => demoChatReply(content);
    const result = await sendRecallTurn(turnInput("死にたい", createChat));
    assert.equal(result.safety?.escalation_required, true);
    assert.ok(!result.reply.includes("次の質問"));
    const ordinary = await sendRecallTurn(turnInput("今日は部活で疲れた", createChat));
    assert.match(ordinary.reply, /次の質問$/);
  });

  it("ends on the completion text after the last turn", () => {
    const reply = recallReply(
      { answer: "ありがとう。" },
      { turn: 30, maxTurns: 30, nextQuestion: "次の質問", completedText: "おわり" },
    );
    assert.equal(reply, "ありがとう。\n\nおわり");
  });

  it("lets a failed call surface, so the page can put the turn back", async () => {
    const createChat = async () => {
      throw new Error("network down");
    };
    await assert.rejects(sendRecallTurn(turnInput("死にたい", createChat)), /network down/);
  });

  it("still shows where to get help when the server cannot be reached", () => {
    assert.equal(recallOfflineSafetyNotice("死にたい"), assessSafety("死にたい").safe_response);
    assert.equal(recallOfflineSafetyNotice("今日は晴れ"), "");
  });
});

describe("crisis vocabulary has one source", () => {
  const sources = ["../src/app/recall/page.tsx", "../src/lib/recallTurn.ts"];

  /** Every quoted string literal in a source file. */
  function stringLiterals(source) {
    const found = new Set();
    for (const match of source.matchAll(/"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'/g)) {
      found.add((match[1] ?? match[2]).toLowerCase());
    }
    return found;
  }

  for (const relative of sources) {
    it(`${relative.replace("../", "")} keeps no copy of the safety lexicon`, async () => {
      const source = await readFile(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
      const literals = stringLiterals(source);
      const copied = SAFETY_LEXICON_TERMS.filter((term) => literals.has(term.toLowerCase()));
      assert.deepEqual(copied, [], `crisis terms belong in src/lib/safety-assessment.ts only`);
      for (const term of FORMER_RECALL_CRISIS_TERMS) {
        assert.ok(!literals.has(term), `"${term}" is still a literal in ${relative}`);
      }
    });
  }

  it("the page reaches the server through sendRecallTurn", async () => {
    const page = await readFile(fileURLToPath(new URL("../src/app/recall/page.tsx", import.meta.url)), "utf8");
    assert.match(page, /from "@\/lib\/recallTurn"/);
    assert.match(page, /await sendRecallTurn\(/);
    assert.doesNotMatch(page, /hasCrisisLanguage|crisisTerms/);
  });
});

describe("assessSafety on the words /recall used to drop", () => {
  it("grades 死にたい as crisis with escalation", () => {
    const result = assessSafety("死にたい");
    assert.equal(result.risk_level, "crisis");
    assert.equal(result.escalation_required, true);
  });

  it("grades 自殺を考えた as crisis with escalation", () => {
    const result = assessSafety("自殺を考えた");
    assert.equal(result.risk_level, "crisis");
    assert.equal(result.escalation_required, true);
  });
});
