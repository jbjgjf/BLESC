/**
 * Every transition has exactly one owner, and every owner has a route (#B1).
 *
 * The bug this locks down: `collecting` was listed in the dry-run runner as a
 * participant transition and refused by the API as an operator one, and no
 * route implemented the operator side. Consent completed, the journal stayed
 * locked, and `--plan` said the scenario matrix was runnable.
 *
 * The three assertions that would have caught it, in the order they would have
 * fired:
 *
 *   1. The ownership lists partition the states. A state in neither list is
 *      unreachable; a state in both is ambiguous.
 *   2. Each list is actually consulted by a route that exists.
 *   3. The runner does not restate either list.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  GUARDIAN_TRANSITIONS,
  OPERATOR_TRANSITIONS,
  PARTICIPANT_TRANSITIONS,
  PILOT_STATES,
  canTransition,
} from "../src/lib/pilotEnrollment.ts";

const read = (relative) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

const PARTICIPANT_ROUTE = "../src/app/api/pilot/enrollment/route.ts";
const OPERATOR_ROUTE = "../src/app/api/pilot/admin/enrollment/route.ts";
const GUARDIAN_ROUTE = "../src/app/api/pilot/guardian/confirm/route.ts";
const RUNNER = "../scripts/dry-run-smoke.mjs";

describe("transition ownership", () => {
  it("partitions every state except the initial one", () => {
    const owned = [
      ...PARTICIPANT_TRANSITIONS,
      ...OPERATOR_TRANSITIONS,
      ...GUARDIAN_TRANSITIONS,
    ];

    // `account_bound` is where an enrollment starts; nobody transitions *to* it.
    const expected = PILOT_STATES.filter((state) => state !== "account_bound");

    assert.deepEqual(
      [...owned].sort(),
      [...expected].sort(),
      "a state with no owner is a state no route can reach — which is exactly " +
        "how `collecting` became unreachable",
    );
  });

  it("gives each state exactly one owner", () => {
    const seen = new Set();
    for (const state of [...PARTICIPANT_TRANSITIONS, ...OPERATOR_TRANSITIONS, ...GUARDIAN_TRANSITIONS]) {
      assert.ok(!seen.has(state), `${state} is claimed by more than one actor`);
      seen.add(state);
    }
  });

  it("never lets an operator withdraw a participant", () => {
    assert.ok(
      !OPERATOR_TRANSITIONS.includes("withdrawn"),
      "withdrawal is the participant's own decision",
    );
    assert.ok(PARTICIPANT_TRANSITIONS.includes("withdrawn"));
  });
});

describe("each list is consulted by a route that exists", () => {
  it("the participant route imports the shared list and does not restate it", () => {
    const source = read(PARTICIPANT_ROUTE);
    assert.match(source, /PARTICIPANT_TRANSITIONS/);
    assert.match(source, /from "@\/lib\/pilotEnrollment"/);
    assert.doesNotMatch(
      source,
      /const PARTICIPANT_TRANSITIONS\s*(:|=)/,
      "the route must import the list, not keep a copy",
    );
  });

  it("the operator route exists and gates on OPERATOR_TRANSITIONS", () => {
    const source = read(OPERATOR_ROUTE);
    assert.match(source, /OPERATOR_TRANSITIONS/);
    assert.match(source, /requireOperator/, "the operator route must be allowlisted");
    assert.match(source, /actor: "operator"/, "the event row must say who did it");
    assert.doesNotMatch(
      source,
      /const OPERATOR_TRANSITIONS\s*(:|=)/,
      "the route must import the list, not keep a copy",
    );
  });

  it("the guardian route records the guardian, not an operator", () => {
    const source = read(GUARDIAN_ROUTE);
    assert.match(source, /to: "guardian_verified"/);
    assert.match(source, /actor: "guardian"/);
  });
});

describe("the dry-run runner agrees with the routes", () => {
  const runner = read(RUNNER);

  it("imports the lists instead of restating them", () => {
    assert.match(runner, /from "\.\.\/src\/lib\/pilotEnrollment\.ts"/);
    assert.doesNotMatch(
      runner,
      /const PARTICIPANT_TRANSITIONS\s*=/,
      "the runner's private copy is what drifted; it must not come back",
    );
  });

  it("marks the collecting step as the operator's", () => {
    assert.match(
      runner,
      /to: "collecting", actor: "operator"/,
      "a plan that asks the participant to open their own window is a 403 on day 0",
    );
  });
});

describe("the state machine still reaches the end of the study", () => {
  it("enrolled -> collecting -> completed is walkable by the listed owners", () => {
    const adult = (state) => ({ state, is_minor: false });

    assert.ok(canTransition(adult("enrolled"), "collecting"));
    assert.ok(OPERATOR_TRANSITIONS.includes("collecting"));

    assert.ok(canTransition(adult("collecting"), "completed"));
    assert.ok(OPERATOR_TRANSITIONS.includes("completed"));

    // And the participant cannot short-circuit either of them.
    assert.ok(!PARTICIPANT_TRANSITIONS.includes("collecting"));
    assert.ok(!PARTICIPANT_TRANSITIONS.includes("completed"));
  });
});
