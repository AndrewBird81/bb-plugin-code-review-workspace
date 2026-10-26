import { beforeEach, expect, test } from "vitest";
import type { Turn } from "./turn";
import type { ReviewItem } from "./review-state";
import { choicesFor, labelColor, matchesFilter, matchesFilters, savedFilters, saveFilters, valuesOf } from "./review-filters";

const DAY = 86_400_000;
const now = Date.parse("2026-10-26T12:00:00Z");
const turn = (label: string): Turn =>
  ({ group: "needs", reason: "requested", label, signal: null, at: null, notify: false, blocking: false, updated: false, eventAt: null, failed: false });
const review = (extra: Partial<ReviewItem> = {}): ReviewItem => ({ targetKey: "k", kind: "pr", status: "ready", turn: turn("Requested"), createdAt: now - 10 * DAY, ...extra });

const web = review({
  repo: "acme/web", author: "alice", prReviewers: ["bob"], prTeams: ["acme/live-dev"], prLabels: [{ name: "bug", color: "d73a4a" }],
  signals: { ci: "fail" }, submittedVerdict: "APPROVE", prUpdatedAt: now - 2 * DAY,
});
const local = review({ kind: "ref", gitRef: "main", turn: turn("Ready") });

beforeEach(() => localStorage.clear());

test("a review's values for each field read as the menu shows them", () => {
  expect(valuesOf(web, "owner")).toEqual(["acme"]);
  expect(valuesOf(web, "repo")).toEqual(["web"]);
  expect(valuesOf(web, "teams")).toEqual(["acme/live-dev"]);
  expect(valuesOf(web, "labels")).toEqual(["bug"]);
  expect(valuesOf(web, "ci")).toEqual(["Failing"]);
  expect(valuesOf(web, "verdict")).toEqual(["Approved"]);
  expect(valuesOf(local, "verdict")).toEqual(["Not reviewed"]);
  expect(valuesOf(local, "kind")).toEqual(["Local"]);
  expect(valuesOf(local, "labels")).toEqual([]);
});

test("a value filter matches any of its values, or none of them negated", () => {
  expect(matchesFilter(web, { field: "author", values: ["alice", "carol"] })).toBe(true);
  expect(matchesFilter(web, { field: "author", values: ["carol"] })).toBe(false);
  expect(matchesFilter(web, { field: "labels", values: ["bug"], negate: true })).toBe(false);
  // A review without the field has none of its values.
  expect(matchesFilter(local, { field: "labels", values: ["bug"], negate: true })).toBe(true);
  expect(matchesFilter(local, { field: "labels", values: [] })).toBe(true);
});

test("a date filter matches within its days, or before them, and never a time that hasn't happened", () => {
  expect(matchesFilter(web, { field: "updated", days: 3 }, now)).toBe(true);
  expect(matchesFilter(web, { field: "updated", days: 1 }, now)).toBe(false);
  expect(matchesFilter(web, { field: "added", days: 7, before: true }, now)).toBe(true);
  expect(matchesFilter(web, { field: "merged", days: 90 }, now)).toBe(false);
  expect(matchesFilter(web, { field: "merged", days: 90, before: true }, now)).toBe(false);
});

test("every filter must match", () => {
  expect(matchesFilters(web, [{ field: "owner", values: ["acme"] }, { field: "ci", values: ["Failing"] }], now)).toBe(true);
  expect(matchesFilters(web, [{ field: "owner", values: ["acme"] }, { field: "ci", values: ["Passing"] }], now)).toBe(false);
});

test("choices are the values the reviews have, the most common first, each counted once a review", () => {
  const other = review({ author: "bob", prLabels: [{ name: "bug", color: "" }, { name: "bug", color: "" }, { name: "ui", color: "" }] });
  expect(choicesFor([web, other, local], "labels")).toEqual([{ value: "bug", count: 2 }, { value: "ui", count: 1 }]);
  expect(labelColor([other, web], "bug")).toBe("#d73a4a");
  expect(labelColor([other], "ui")).toBeNull();
});

test("filters are kept in this browser, and a malformed one is dropped", () => {
  saveFilters([{ field: "author", values: ["alice"] }, { field: "updated", days: 3 }]);
  expect(savedFilters()).toEqual([{ field: "author", values: ["alice"] }, { field: "updated", days: 3 }]);
  localStorage.setItem("gr:inbox-filters", JSON.stringify([{ field: "nope", values: [] }, { field: "updated" }, null]));
  expect(savedFilters()).toEqual([]);
  localStorage.setItem("gr:inbox-filters", "{");
  expect(savedFilters()).toEqual([]);
});
