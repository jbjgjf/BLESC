import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  PILOT_STATES,
  TERMINAL_STATES,
  canTransition,
  enrollmentProgress,
  isCollecting,
  nextState,
  pendingRequirement,
} from "../src/lib/pilotEnrollment.ts";

const MIGRATION = fileURLToPath(
  new URL("../../supabase/migrations/20260906010000_pilot_enrollment.sql", import.meta.url),
);

const minor = (state) => ({ state, is_minor: true });
const adult = (state) => ({ state, is_minor: false });

describe("nextState", () => {
  it("routes a minor through guardian verification", () => {
    assert.equal(nextState(minor("account_bound")), "information_read");
    assert.equal(nextState(minor("information_read")), "participant_assented");
    assert.equal(nextState(minor("participant_assented")), "guardian_verified");
    assert.equal(nextState(minor("guardian_verified")), "enrolled");
    assert.equal(nextState(minor("enrolled")), "collecting");
    assert.equal(nextState(minor("collecting")), "completed");
  });

  it("routes an adult straight from assent to enrolled", () => {
    assert.equal(nextState(adult("participant_assented")), "enrolled");
  });

  it("stops at the terminal states", () => {
    for (const state of TERMINAL_STATES) {
      assert.equal(nextState(minor(state)), null);
      assert.equal(nextState(adult(state)), null);
    }
  });
});

describe("canTransition", () => {
  it("allows exactly one step forward", () => {
    assert.equal(canTransition(minor("account_bound"), "information_read"), true);
    // Skipping the information sheet is the whole thing this gate exists for.
    assert.equal(canTransition(minor("account_bound"), "participant_assented"), false);
    assert.equal(canTransition(minor("account_bound"), "enrolled"), false);
    assert.equal(canTransition(minor("account_bound"), "collecting"), false);
  });

  it("refuses to skip guardian verification for a minor", () => {
    assert.equal(canTransition(minor("participant_assented"), "enrolled"), false);
    assert.equal(canTransition(minor("participant_assented"), "guardian_verified"), true);
  });

  it("does not invent a guardian step for an adult", () => {
    assert.equal(canTransition(adult("participant_assented"), "guardian_verified"), false);
    assert.equal(canTransition(adult("participant_assented"), "enrolled"), true);
  });

  it("lets a participant withdraw from any live state", () => {
    for (const state of PILOT_STATES) {
      const expected = !TERMINAL_STATES.includes(state);
      assert.equal(canTransition(minor(state), "withdrawn"), expected, `withdrawing from ${state}`);
    }
  });

  it("treats withdrawn and completed as final", () => {
    for (const state of TERMINAL_STATES) {
      for (const target of PILOT_STATES) {
        assert.equal(canTransition(minor(state), target), false, `${state} → ${target}`);
      }
    }
  });

  it("never allows moving backwards", () => {
    const order = ["account_bound", "information_read", "participant_assented", "guardian_verified", "enrolled", "collecting"];
    for (let i = 0; i < order.length; i += 1) {
      for (let j = 0; j <= i; j += 1) {
        assert.equal(canTransition(minor(order[i]), order[j]), false, `${order[i]} → ${order[j]}`);
      }
    }
  });
});

describe("the SQL and this module agree", () => {
  /**
   * The database is the authority. This parses the CASE expression out of
   * `advance_pilot_enrollment` and checks that every edge it accepts is one
   * `canTransition` accepts, and vice versa.
   *
   * Without this, the two drift the first time somebody adds a state to one of
   * them, and the failure mode is a screen that offers a button the server
   * rejects — or worse, a screen that hides a step the server does not require.
   */
  const sql = readFileSync(MIGRATION, "utf8");

  const edges = new Set();
  const pattern =
    /when v\.state = '(\w+)' and p_to_state = '(\w+)'(?:\s+and\s+(not\s+)?v\.is_minor)?\s+then true/g;

  for (const match of sql.matchAll(pattern)) {
    const [, from, to, negated] = match;
    if (negated) edges.add(`adult:${from}->${to}`);
    else if (match[0].includes("v.is_minor")) edges.add(`minor:${from}->${to}`);
    else {
      edges.add(`minor:${from}->${to}`);
      edges.add(`adult:${from}->${to}`);
    }
  }

  it("found the transition table in the migration", () => {
    // A regex that silently matches nothing would make every assertion below
    // pass vacuously.
    assert.ok(edges.size >= 7, `parsed only ${edges.size} edges from ${MIGRATION}`);
  });

  it("accepts the same edges the SQL accepts", () => {
    for (const edge of edges) {
      const [band, transition] = edge.split(":");
      const [from, to] = transition.split("->");
      const enrollment = band === "minor" ? minor(from) : adult(from);
      assert.equal(canTransition(enrollment, to), true, `SQL allows ${edge}; canTransition does not`);
    }
  });

  it("rejects every edge the SQL does not list", () => {
    for (const band of ["minor", "adult"]) {
      for (const from of PILOT_STATES) {
        for (const to of PILOT_STATES) {
          // Withdrawal is handled before the CASE in the SQL, so it is
          // legitimately absent from the parsed edge list.
          if (to === "withdrawn") continue;
          const enrollment = band === "minor" ? minor(from) : adult(from);
          if (canTransition(enrollment, to)) {
            assert.ok(
              edges.has(`${band}:${from}->${to}`),
              `canTransition allows ${band}:${from}->${to}; the SQL does not`,
            );
          }
        }
      }
    }
  });

  it("declares the same state list as the check constraint", () => {
    const constraint = sql.match(/add constraint pilot_enrollments_state_check\s+check \(state in \(([^)]+)\)\)/);
    assert.ok(constraint, "could not find pilot_enrollments_state_check");
    const sqlStates = [...constraint[1].matchAll(/'(\w+)'/g)].map((m) => m[1]);
    assert.deepEqual([...sqlStates].sort(), [...PILOT_STATES].sort());
  });
});

describe("enrollmentProgress", () => {
  it("fills for an adult without a permanently missing notch", () => {
    const { step, total } = enrollmentProgress(adult("collecting"));
    assert.equal(step, total);
  });

  it("counts the guardian step for a minor", () => {
    assert.equal(enrollmentProgress(minor("collecting")).total, 6);
    assert.equal(enrollmentProgress(adult("collecting")).total, 5);
  });

  it("reports completed as full and withdrawn as zero", () => {
    assert.equal(enrollmentProgress(minor("completed")).step, 6);
    assert.equal(enrollmentProgress(minor("withdrawn")).step, 0);
  });
});

describe("pendingRequirement", () => {
  it("names the guardian step only for minors", () => {
    assert.equal(pendingRequirement(minor("participant_assented")), "guardian_verification");
    assert.equal(pendingRequirement(adult("participant_assented")), "consent_record");
  });

  it("says nothing is pending once collecting or finished", () => {
    assert.equal(pendingRequirement(minor("collecting")), null);
    assert.equal(pendingRequirement(minor("completed")), null);
    assert.equal(pendingRequirement(minor("withdrawn")), null);
  });
});

describe("isCollecting", () => {
  it("is true only in the collecting state", () => {
    for (const state of PILOT_STATES) {
      assert.equal(isCollecting(minor(state)), state === "collecting");
    }
  });
});

/**
 * The join screen has to come back from a failed read (#236).
 *
 * These are structural assertions on the source rather than a render, because
 * the behaviour they protect is a control-flow property — "every path resolves
 * `loaded`" — and the screen it lives on needs a session, a Supabase client and
 * an effect pass to render at all. The behavioural version of this is the
 * `unreadable state` case in `e2e/pilot-join.spec.ts`, which fails the request
 * for real and asserts on what a participant sees.
 *
 * What went wrong without them: `setLoaded(true)` was the last statement of an
 * un-caught async function, so one failed request left the screen on its
 * spinner, with no message, no retry, and a poll that could not start because
 * the state it keys on is only ever set by the call that failed.
 */
describe("the /pilot/join loading path", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../src/app/pilot/join/page.tsx", import.meta.url)),
    "utf8",
  );

  it("resolves the spinner on every path, including the failing one", () => {
    // `finally`, not a second `setLoaded(true)` in the catch: the point is that
    // no future branch added to the try can skip it.
    const finallyBlock = source.match(/}\s*finally\s*{([^}]*)}/);
    assert.ok(finallyBlock, "refresh() has no finally block");
    assert.match(
      finallyBlock[1],
      /setLoaded\(true\)/,
      "the spinner is not cleared in the finally, so a throw can still strand it",
    );
  });

  it("catches the failure rather than rejecting into a swallowed void", () => {
    assert.match(source, /catch\s*{[\s\S]*?setLoadFailed\(true\)/);
  });

  it("retries by itself after the first failure", () => {
    // The poll used to key on `guardian?.status` alone. `guardian` is only set
    // by refresh(), so a first failure meant the interval never started and the
    // screen could not recover on its own.
    assert.match(
      source,
      /guardian\?\.status !== "pending" && !loadFailed/,
      "the poll does not run while the screen is in its failed state",
    );
  });

  it("offers the participant a retry that is not a page reload", () => {
    assert.match(source, /data-testid="pilot-join-retry"/);
    assert.match(source, /onClick=\{\(\) => void refresh\(\)\}/);
  });

  it("says the state is unknown instead of showing a step it guessed", () => {
    // Rendering the invite step from a read that failed would invite someone to
    // act on a state nobody knows.
    assert.match(source, /loadFailed && !enrollment/);
    assert.match(source, /t\.pilotJoin\.loadFailedTitle/);
  });

  it("does not strand a signed-out visitor either", () => {
    // `if (!user) return` left `loaded` false, which is the same spinner by a
    // different route — and every e2e case logs in first, so nothing saw it.
    const guard = source.match(/if \(!user\) {([\s\S]*?)}\n/);
    assert.ok(guard, "the signed-out guard in refresh() is gone");
    assert.match(guard[1], /setLoaded\(true\)/);
  });

  it("shows the catalogue's words, never the error's", () => {
    // A Supabase or fetch error is English and describes our plumbing. #116.
    assert.ok(
      !/setLoadFailed\([^)]*error/.test(source),
      "the raw error is being carried into the screen's failure state",
    );
  });
});
