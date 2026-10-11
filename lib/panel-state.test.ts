import { afterEach, expect, test, vi } from "vitest";
import { getCommentsFolded, getGithubThreadsInCode, getHideNits, getHideWhitespace, getIntroCollapsed, getLastReview, getNavOpen, getNavView, getNavWidth, getPanelWidth, getReviewState, getWrapLines, migrateLayoutState, patchReviewState, setNavWidth, setPanelWidth } from "./panel-state";

afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

const stored = () => JSON.parse(localStorage.getItem("gr:panelstate")!);

/** What 0.5.2 saved after a few reviews: one left on Feedback with the agent open, one on a phone, one from before 0.5.0. */
const v052 = {
  lastTargetKey: "pr-86f279ce9c29f106-42",
  introCollapsed: true,
  wrapLines: false,
  hideNits: true,
  navView: "files",
  hideWhitespace: true,
  perReview: {
    "pr-86f279ce9c29f106-42": { activeId: "api", view: "feedback", scrollTop: 640, sidebarWidth: 340, headerCollapsed: true, activeTool: "agent", toolsOpen: true },
    "pr-86f279ce9c29f106-43": { activeId: "cache", view: "diff", scrollTop: 0, sidebarWidth: 288, headerCollapsed: false, activeTool: "notes", toolsOpen: false },
    "pr-86f279ce9c29f106-44": { activeId: "cache", activeTool: "draft" },
    "pr-86f279ce9c29f106-45": { activeId: "chores", scrollTop: 120, activeTool: "notes", toolsOpen: true },
    "pr-old": { activeId: "x", focus: false },
  },
};

test("0.5.2's state opens each review at its chapter and scroll position, with its open tool as the side panel", () => {
  localStorage.setItem("gr:panelstate", JSON.stringify(v052));
  expect(getReviewState("pr-86f279ce9c29f106-42")).toMatchObject({ activeId: "api", scrollTop: 640, panel: "agent" });
  expect(getReviewState("pr-86f279ce9c29f106-43")).toMatchObject({ activeId: "cache", scrollTop: 0, panel: null });
  // Opened only on a phone, which didn't save whether the tools were open: they opened on wider screens.
  expect(getReviewState("pr-86f279ce9c29f106-44").panel).toBe("comments");
  expect(getReviewState("pr-86f279ce9c29f106-45").panel).toBe("comments");
  expect(getReviewState("pr-old").panel).toBeUndefined();
  // The last review's sidebar width is the navigator's in every review.
  expect(getNavWidth()).toBe(340);
  expect([getLastReview(), getIntroCollapsed(), getWrapLines(), getHideNits(), getNavView(), getHideWhitespace()]).toEqual([{ targetKey: "pr-86f279ce9c29f106-42" }, true, false, true, "files", true]);
  // The new layout's own toggles start at their defaults.
  expect([getNavOpen(), getPanelWidth(), getCommentsFolded(), getGithubThreadsInCode()]).toEqual([true, 400, undefined, true]);
});

test("the migration keeps every older key, Feedback's view included, and runs once", () => {
  localStorage.setItem("gr:panelstate", JSON.stringify(v052));
  getNavWidth();
  const migrated = stored();
  expect(migrated.layoutVersion).toBe(2);
  for (const [key, review] of Object.entries(v052.perReview)) expect(migrated.perReview[key]).toMatchObject(review);
  // Later changes to the older keys don't map again.
  patchReviewState("pr-86f279ce9c29f106-42", { toolsOpen: false, sidebarWidth: 500 });
  expect(getReviewState("pr-86f279ce9c29f106-42").panel).toBe("agent");
  expect(getNavWidth()).toBe(340);
});

test("unreadable or out-of-range values fall back to defaults, and nothing throws", () => {
  localStorage.setItem("gr:panelstate", "{not json");
  expect(getNavWidth()).toBe(288);
  expect(getReviewState("k")).toEqual({});
  localStorage.setItem("gr:panelstate", JSON.stringify({ lastTargetKey: "k", perReview: { k: { sidebarWidth: 9999, activeTool: "pins", toolsOpen: true }, j: "junk" } }));
  expect(getNavWidth()).toBe(560);
  expect(getReviewState("k").panel).toBeUndefined();
  expect(getReviewState("j")).toEqual({});
  localStorage.setItem("gr:panelstate", JSON.stringify({ layoutVersion: 2, navOpen: "yes", navWidth: "wide", panelWidth: 10, commentsFolded: 1, githubThreadsInCode: null, perReview: { k: { panel: "notes" } } }));
  expect([getNavOpen(), getNavWidth(), getPanelWidth(), getCommentsFolded(), getGithubThreadsInCode(), getReviewState("k").panel]).toEqual([true, 288, 320, undefined, true, null]);
  localStorage.setItem("gr:panelstate", JSON.stringify(["not", "an", "object"]));
  expect(migrateLayoutState(JSON.parse(localStorage.getItem("gr:panelstate")!))).toEqual({ perReview: {}, layoutVersion: 2 });
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("SecurityError"); });
  expect([getNavOpen(), getNavWidth(), getReviewState("k")]).toEqual([true, 288, {}]);
});

test("a fresh state starts at the defaults, and widths save within their ranges", () => {
  expect([getNavOpen(), getNavWidth(), getPanelWidth(), getCommentsFolded(), getGithubThreadsInCode()]).toEqual([true, 288, 400, undefined, true]);
  expect(stored()).toEqual({ perReview: {}, layoutVersion: 2 });
  setNavWidth(120);
  setPanelWidth(700);
  expect([getNavWidth(), getPanelWidth()]).toEqual([200, 640]);
});
