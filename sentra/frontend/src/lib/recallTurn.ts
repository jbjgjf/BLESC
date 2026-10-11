import type { ChatResponse, SafetyAssessment } from "@/api/models";
import { assessSafety } from "./safety-assessment.ts";

/**
 * One turn of the 30-turn recall workspace (`/recall`).
 *
 * Every turn goes to `/api/chat`, whatever it says (#343). That route is where
 * the safety assessment runs, where `safety_audits` gets its row and where a
 * crisis is escalated to the educators who hold oversight consent. The page
 * used to match its own ten crisis words first and, on a match, show a canned
 * reply without calling the server — so the most explicit disclosures were the
 * only ones nobody was told about.
 *
 * Holding the AI back during a collection window is decided inside the route
 * (`collectionOnlyForParticipant`, #165); the route still assesses and still
 * appends the safe response to `COLLECTION_ONLY_MESSAGE`. Nothing here needs
 * to, or may, short-circuit the call.
 */

export type RecallChat = (
  content: string,
  options: { mode: "recall_workspace"; conversationContext: string[] },
) => Promise<ChatResponse>;

export type RecallTurnInput = {
  content: string;
  /** 1-based count of user turns including this one. */
  turn: number;
  maxTurns: number;
  /** The guided question to ask after this turn. */
  nextQuestion: string;
  /** Text shown once the last turn is in. */
  completedText: string;
  /** Instructions for the model, built by the page. */
  conversationContext: string[];
  createChat: RecallChat;
};

export type RecallTurnResult = {
  reply: string;
  response: ChatResponse;
  safety: SafetyAssessment | null;
};

export async function sendRecallTurn(input: RecallTurnInput): Promise<RecallTurnResult> {
  const response = await input.createChat(input.content, {
    mode: "recall_workspace",
    conversationContext: input.conversationContext,
  });
  const safety = response.safety_assessment ?? null;
  return { reply: recallReply(response, input), response, safety };
}

/**
 * What the student reads after a turn.
 *
 * `answer` is already floored by the route (`withSafetyFloor`): when the
 * assessment carries a safe response, it is in the answer. After a crisis the
 * next interview question is left off — the reply should end on where to get
 * help, not on the next thing to write about.
 */
export function recallReply(
  response: Pick<ChatResponse, "answer" | "safety_assessment">,
  input: Pick<RecallTurnInput, "turn" | "maxTurns" | "nextQuestion" | "completedText">,
): string {
  const answer = response.answer.trim();
  if (response.safety_assessment?.escalation_required) return answer;
  const next = input.turn >= input.maxTurns ? input.completedText : input.nextQuestion;
  return `${answer}\n\n${next}`;
}

/**
 * Shown when the turn could not reach the server at all.
 *
 * The same lexicon the route uses, run in the browser, so a student whose
 * message carries risk still sees where to get help while the server is down.
 * This is not a substitute for the call: nothing is recorded and nobody is
 * told, so the page puts the message back in the input for the student to
 * send again instead of treating the turn as done.
 */
export function recallOfflineSafetyNotice(content: string): string {
  return assessSafety(content).safe_response;
}
