/**
 * The participation state machine, as the client understands it (#163).
 *
 * The authority is `advance_pilot_enrollment` in the database — this module
 * cannot grant anything and is not consulted before a write. It exists so the
 * join screen can say "next: a guardian has to confirm" without asking the
 * server what comes next, and so the legal edges are written down once in a
 * place a test can read.
 *
 * When these tables disagree with the SQL, the SQL wins and this is the bug.
 * `sentra/frontend/tests/pilot-enrollment.test.mjs` asserts the edge list here
 * matches the CASE expression in 20260906010000_pilot_enrollment.sql by
 * parsing it, so the two cannot drift silently.
 */

export const PILOT_STATES = [
  "account_bound",
  "information_read",
  "participant_assented",
  "guardian_verified",
  "enrolled",
  "collecting",
  "withdrawn",
  "completed",
] as const;

export type PilotState = (typeof PILOT_STATES)[number];

export type PilotEnrollment = {
  state: PilotState;
  is_minor: boolean;
};

/** States from which nothing further happens. */
export const TERMINAL_STATES: readonly PilotState[] = ["withdrawn", "completed"];

/**
 * The one legal step forward, or null at the end of the line.
 *
 * A minor goes `participant_assented → guardian_verified → enrolled`; an adult
 * goes `participant_assented → enrolled`. That branch is the only place the
 * machine forks, and it is the reason `is_minor` is an input here rather than a
 * display detail.
 */
export function nextState(enrollment: PilotEnrollment): PilotState | null {
  const { state, is_minor } = enrollment;
  switch (state) {
    case "account_bound":
      return "information_read";
    case "information_read":
      return "participant_assented";
    case "participant_assented":
      return is_minor ? "guardian_verified" : "enrolled";
    case "guardian_verified":
      return "enrolled";
    case "enrolled":
      return "collecting";
    case "collecting":
      return "completed";
    case "withdrawn":
    case "completed":
      return null;
  }
}

/**
 * Whether a requested transition is one the server will accept.
 *
 * Withdrawal is legal from any non-terminal state: a participant must be able
 * to leave whatever state a bug left them in. Everything else has exactly one
 * successor.
 */
export function canTransition(enrollment: PilotEnrollment, to: PilotState): boolean {
  if (TERMINAL_STATES.includes(enrollment.state)) return false;
  if (to === "withdrawn") return true;
  return nextState(enrollment) === to;
}

/**
 * Which step the participant is on, for a progress display.
 *
 * `guardian_verified` is counted for minors only, so an adult's bar is not
 * permanently one notch short of full.
 */
export function enrollmentProgress(enrollment: PilotEnrollment): { step: number; total: number } {
  const sequence: PilotState[] = enrollment.is_minor
    ? ["account_bound", "information_read", "participant_assented", "guardian_verified", "enrolled", "collecting"]
    : ["account_bound", "information_read", "participant_assented", "enrolled", "collecting"];

  const total = sequence.length;
  if (enrollment.state === "completed") return { step: total, total };
  if (enrollment.state === "withdrawn") return { step: 0, total };

  const index = sequence.indexOf(enrollment.state);
  return { step: index < 0 ? 0 : index + 1, total };
}

/**
 * Whether the journal may collect from this enrollment right now.
 *
 * Mirrors `pilot_collection_open` for display purposes only. The write path
 * calls the SQL function; a client that lies about this gets a rejected write,
 * not collected data.
 */
export function isCollecting(enrollment: PilotEnrollment): boolean {
  return enrollment.state === "collecting";
}

/**
 * What the participant is waiting on, in one line, for the join screen.
 *
 * Deliberately not an error message: every one of these is a normal step, and
 * a participant who reads "guardian confirmation is required" should not think
 * something went wrong.
 */
export function pendingRequirement(enrollment: PilotEnrollment): string | null {
  switch (enrollment.state) {
    case "account_bound":
      return "information_read";
    case "information_read":
      return "participant_assent";
    case "participant_assented":
      return enrollment.is_minor ? "guardian_verification" : "consent_record";
    case "guardian_verified":
      return "consent_record";
    case "enrolled":
      return "collection_window";
    default:
      return null;
  }
}

/**
 * Which screen of the join flow an enrollment is on.
 *
 * Extracted from `app/pilot/join/page.tsx` so the branch that matters can be
 * tested: the first version routed *every* `participant_assented` enrollment to
 * the guardian screen, including adults, whose only button there returns
 * `guardian_not_required` — leaving them unable to reach the perfectly legal
 * `participant_assented -> enrolled` transition, permanently stuck one step
 * short of joining.
 *
 * A display decision, not a permission: the server decides every transition,
 * and a participant who guesses a different screen still cannot advance.
 */
export type JoinStep =
  | "invite"
  | "information"
  | "assent"
  | "guardian"
  | "finish"
  | "done"
  | "withdrawn";

export function joinStep(enrollment: PilotEnrollment | null): JoinStep {
  if (!enrollment) return "invite";
  switch (enrollment.state) {
    case "withdrawn":
      return "withdrawn";
    case "account_bound":
      return "information";
    case "information_read":
      return "assent";
    case "participant_assented":
      return enrollment.is_minor ? "guardian" : "finish";
    case "guardian_verified":
      return "finish";
    default:
      return "done";
  }
}

/**
 * Who may request which transition (#B1).
 *
 * The state machine above says which edges exist. This says who is allowed to
 * walk them, and it lives here — beside the edges, in a module both the API
 * route and the dry-run runner import — because the two used to keep private
 * copies of the answer and the copies disagreed. The runner's copy listed
 * `collecting` as something a participant could request; the route's did not,
 * and nothing compared them. The dry run planned a step the API refuses.
 *
 * Every non-initial state belongs to exactly one of these lists. That is
 * asserted in `tests/pilot-operator-enrollment.test.mjs`, so a state added to
 * `PILOT_STATES` without an owner fails the build rather than becoming a
 * transition nobody can perform — which is precisely how `collecting` came to
 * be unreachable.
 */

/**
 * What a participant may ask for themselves.
 *
 * `guardian_verified` is absent: a guardian confirming through the
 * participant's own session is not a guardian confirmation, it is the
 * participant clicking a button. It is reached by `/api/pilot/guardian/confirm`
 * with `actor: "guardian"`.
 *
 * `collecting` and `completed` are absent: the collection window opens and
 * closes for a cohort on dates the protocol fixes, not per participant on
 * demand.
 */
export const PARTICIPANT_TRANSITIONS: readonly PilotState[] = [
  "information_read",
  "participant_assented",
  "enrolled",
  "withdrawn",
];

/**
 * What only a study coordinator may request, through
 * `/api/pilot/admin/enrollment`.
 *
 * `withdrawn` is deliberately NOT here. Withdrawal is the participant's own
 * decision and the one edge that must never be exercised on their behalf; an
 * operator who needs a participant out of the study takes it up with them.
 */
export const OPERATOR_TRANSITIONS: readonly PilotState[] = [
  "collecting",
  "completed",
];

/** Reached only by the guardian's own confirmation link. */
export const GUARDIAN_TRANSITIONS: readonly PilotState[] = ["guardian_verified"];
