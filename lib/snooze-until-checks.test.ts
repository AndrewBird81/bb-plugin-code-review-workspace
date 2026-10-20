import { expect, test } from "vitest";
import { canSnoozeUntilChecks, CHECKS_SNOOZE_LABEL, CI_STALE_MS, computeTurn, type TurnInput, type TurnSignals } from "./turn";
import { statusWhy } from "./status-line";

const NOW = Date.parse("2026-10-10T12:00:00Z");
const MINUTE = 60_000;

/** A PR whose review was requested ten minutes ago, its head pushed five minutes ago. */
function requested(extra: Partial<TurnInput> = {}, signals: TurnSignals = {}): TurnInput {
  return {
    targetKey: "pr-1", kind: "pr", status: "ready", prState: "OPEN", headSha: "sha1", latestHeadSha: "sha1", createdAt: NOW - 10 * MINUTE,
    ...extra,
    signals: { requestPending: true, requestedAt: NOW - 10 * MINUTE, headSeenAt: NOW - 5 * MINUTE, ci: "pending", ...signals },
  };
}
/** Snoozed a minute ago until the checks finish, an hour at most. */
const snoozed = (signals: TurnSignals = {}) =>
  requested({ snoozedAt: NOW - MINUTE, snoozedUntil: NOW - MINUTE + CI_STALE_MS, snoozedUntilChecks: true }, signals);
const turn = (review: TurnInput, now = NOW) => computeTurn(review, undefined, now);

test("Until checks finish is offered only while the head's checks are running", () => {
  expect(canSnoozeUntilChecks(requested(), turn(requested()), NOW)).toBe(true);
  expect(canSnoozeUntilChecks(requested({}, { ci: "expected" }), turn(requested({}, { ci: "expected" })), NOW)).toBe(true);
  for (const ci of ["pass", "fail", "none"] as const) {
    expect(canSnoozeUntilChecks(requested({}, { ci }), turn(requested({}, { ci })), NOW)).toBe(false);
  }
  // Checks pending for an hour after the push never will report.
  const stale = requested({}, { headSeenAt: NOW - CI_STALE_MS });
  expect(canSnoozeUntilChecks(stale, turn(stale), NOW)).toBe(false);
  // A local review has no checks.
  const local = requested({ kind: "ref" });
  expect(canSnoozeUntilChecks(local, turn(local), NOW)).toBe(false);
});

test("a review snoozed until checks finish waits while they run, and says so", () => {
  expect(turn(snoozed())).toMatchObject({ group: "waiting", reason: "snoozed", label: CHECKS_SNOOZE_LABEL });
  const review = { ...snoozed(), targetKey: "pr-1", turn: turn(snoozed()) };
  expect(statusWhy(review, NOW)).toMatchObject({ text: CHECKS_SNOOZE_LABEL, icon: "CircleDashed" });
});

test("it comes back to Needs review when the checks pass or fail", () => {
  expect(turn(snoozed({ ci: "pass" }))).toMatchObject({ group: "needs", reason: "requested" });
  expect(turn(snoozed({ ci: "fail" }))).toMatchObject({ group: "needs", reason: "requested" });
});

test("it stays snoozed while a required check hasn't reported", () => {
  expect(turn(snoozed({ ci: "expected" }))).toMatchObject({ group: "waiting", label: CHECKS_SNOOZE_LABEL });
});

test("checks that never report hold it an hour at most", () => {
  expect(turn(snoozed(), NOW - MINUTE + CI_STALE_MS)).toMatchObject({ group: "needs", reason: "requested" });
});
