import { expect, test } from "vitest";
import type { Turn } from "./turn";
import { needsGroup, needsOrder, type ReviewItem } from "./review-state";

const DAY = 86_400_000;
const now = Date.now();
const turn = (reason: Turn["reason"], at: number, extra: Partial<Turn> = {}): Turn =>
  ({ group: "needs", reason, label: "", signal: null, at, notify: false, blocking: false, updated: false, eventAt: null, failed: false, ...extra });
const review = (targetKey: string, t: Turn, extra: Partial<ReviewItem> = {}): ReviewItem => ({ targetKey, turn: t, ...extra });

test("Needs review is in three parts: what came back to you, first reviews, and team requests", () => {
  expect(needsGroup(review("a", turn("re-requested", 1)))).toBe("back");
  expect(needsGroup(review("b", turn("question", 1)))).toBe("back");
  expect(needsGroup(review("c", turn("handled", 1)))).toBe("back");
  expect(needsGroup(review("d", turn("requested", 1)))).toBe("new");
  expect(needsGroup(review("e", turn("own", 1)))).toBe("new");
  expect(needsGroup(review("f", turn("new", 1)))).toBe("new");
  expect(needsGroup(review("g", turn("team-requested", 1)))).toBe("team");
  // A failed guide keeps the reason underneath: one you reviewed is back to you.
  expect(needsGroup(review("h", turn("waiting", 1, { failed: true }), { submittedVerdict: "REQUEST_CHANGES", submittedAt: now - DAY }))).toBe("back");
  expect(needsGroup(review("i", turn("requested", 1, { failed: true })))).toBe("new");
});

test("Needs review puts Blocks merge first, then Back to you, New and Team requests, each longest waiting first", () => {
  const reviews = [
    review("team-old", turn("team-requested", now - 9 * DAY)),
    review("new-recent", turn("requested", now - DAY)),
    review("back-recent", turn("question", now - 60_000)),
    review("new-old", turn("new", now - 5 * DAY)),
    review("blocking", turn("re-requested", now - 30_000, { blocking: true })),
    review("back-old", turn("re-requested", now - 2 * DAY)),
    review("unstamped", { ...turn("new", 0), at: null }, { createdAt: now - 3 * DAY }),
  ];
  expect(reviews.sort(needsOrder).map((r) => r.targetKey)).toEqual(["blocking", "back-old", "back-recent", "new-old", "unstamped", "new-recent", "team-old"]);
});
