import { beforeEach, expect, test } from "vitest";
import type { Turn } from "./turn";
import type { ReviewItem } from "./review-state";
import { choicesFor, labelColor, matchesFilter, matchesFilters, sameFilters, savedActiveView, savedFilters, saveFilters, savedViews, saveActiveView, saveViews, valuesOf, viewNameProblem, type Filter } from "./review-filters";

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

beforeEach(() => { sessionStorage.clear(); localStorage.clear(); });

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

test("a status is its row's, the same whether or not the PR changed since your review", () => {
  expect(valuesOf(review({ turn: turn("Approved · updated") }), "status")).toEqual(["Approved"]);
  expect(choicesFor([review({ turn: turn("Approved") }), review({ turn: turn("Approved · updated") })], "status")).toEqual([{ value: "Approved", count: 2 }]);
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

test("closed is closed without merging, though GitHub gives a merged PR a close time too", () => {
  const merged = review({ prState: "MERGED", prMergedAt: now - DAY, prClosedAt: now - DAY });
  const closed = review({ prState: "CLOSED", prClosedAt: now - DAY });
  expect(matchesFilter(merged, { field: "merged", days: 3 }, now)).toBe(true);
  expect(matchesFilter(merged, { field: "closed", days: 3 }, now)).toBe(false);
  expect(matchesFilter(closed, { field: "closed", days: 3 }, now)).toBe(true);
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

test("filters are kept in this tab, as the box's words are, and a malformed one is dropped", () => {
  saveFilters([{ field: "author", values: ["alice"] }, { field: "updated", days: 3 }]);
  expect(savedFilters()).toEqual([{ field: "author", values: ["alice"] }, { field: "updated", days: 3 }]);
  expect(localStorage.getItem("gr:inbox-filters")).toBeNull();
  sessionStorage.setItem("gr:inbox-filters", JSON.stringify([
    { field: "nope", values: [] }, { field: "updated" }, null, { field: "author", values: [1] }, { field: "added", days: -1 }, { field: "labels", values: ["bug"], negate: "yes" },
  ]));
  expect(savedFilters()).toEqual([]);
  // One a field, as the bar makes them: the first stands.
  sessionStorage.setItem("gr:inbox-filters", JSON.stringify([{ field: "author", values: ["alice"] }, { field: "author", values: ["bob"] }]));
  expect(savedFilters()).toEqual([{ field: "author", values: ["alice"] }]);
  sessionStorage.setItem("gr:inbox-filters", "{");
  expect(savedFilters()).toEqual([]);
});

test("views are kept in this browser, past the tab, with their malformed filters dropped", () => {
  saveViews([{ id: "v1", name: "Live 4 Project", filters: [{ field: "teams", values: ["acme/live-dev"] }] }]);
  expect(savedViews()).toEqual([{ id: "v1", name: "Live 4 Project", filters: [{ field: "teams", values: ["acme/live-dev"] }] }]);
  localStorage.setItem("gr:inbox-views", JSON.stringify([
    { id: "v2", name: "Last week", filters: [{ field: "updated", days: 7 }, { field: "nope" }, { field: "updated", days: 1 }] },
    { id: "v3", name: "  ", filters: [] }, { name: "No id", filters: [] }, null,
  ]));
  expect(savedViews()).toEqual([{ id: "v2", name: "Last week", filters: [{ field: "updated", days: 7 }] }]);
  localStorage.setItem("gr:inbox-views", "{");
  expect(savedViews()).toEqual([]);
});

test("the active view is the tab's, as its filters are", () => {
  saveActiveView("v1");
  expect(savedActiveView()).toBe("v1");
  expect(localStorage.getItem("gr:inbox-view")).toBeNull();
  saveActiveView(null);
  expect(savedActiveView()).toBeNull();
});

test("filters are the same in any order, values in any order, and differ on a flip or a span", () => {
  const a: Filter[] = [{ field: "labels", values: ["bug", "ui"] }, { field: "updated", days: 7 }];
  expect(sameFilters(a, [{ field: "updated", days: 7 }, { field: "labels", values: ["ui", "bug"] }])).toBe(true);
  expect(sameFilters(a, [{ field: "updated", days: 7 }, { field: "labels", values: ["ui", "bug"], negate: true }])).toBe(false);
  expect(sameFilters(a, [{ field: "updated", days: 3 }, { field: "labels", values: ["ui", "bug"] }])).toBe(false);
  expect(sameFilters([], [])).toBe(true);
});

test("a view's name must be there and its own, in any case", () => {
  const views = [{ id: "v1", name: "Live 4 Project", filters: [] }];
  expect(viewNameProblem(views, "  ")).toBe("Name the view");
  expect(viewNameProblem(views, "live 4 project ")).toBe("There’s a view named “live 4 project”");
  expect(viewNameProblem(views, "Live 4 Project", "v1")).toBeNull();
  expect(viewNameProblem(views, "Last 1 week updated")).toBeNull();
});
