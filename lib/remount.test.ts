// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { carried, keep, present, resetForTests } from "./remount";

afterEach(() => { sessionStorage.clear(); vi.useRealTimers(); resetForTests(); });

test("a workspace that mounts while the review's last one is there carries what it kept", () => {
  const gone = present("pr-42");
  keep("pr-42", { panelOverlay: true, find: "cache" });
  expect(carried("pr-42")).toEqual({ panelOverlay: true, find: "cache" });
  expect(carried("pr-43")).toBeNull();
  gone();
});

test("within 2 seconds of the last one going, it carries what it kept; later, a review opens afresh", () => {
  vi.useFakeTimers();
  const gone = present("pr-42");
  keep("pr-42", { navOverlay: true });
  gone();
  vi.advanceTimersByTime(1500);
  expect(carried("pr-42")).toEqual({ navOverlay: true });
  vi.advanceTimersByTime(600);
  expect(carried("pr-42")).toBeNull();
});

test("what's kept as the window resizes waits 300ms: a workspace that takes this one's place by then goes on from before", () => {
  vi.useFakeTimers();
  const gone = present("pr-42");
  keep("pr-42", { panelOverlay: true });
  window.dispatchEvent(new Event("resize"));
  // BB's old pane, at the window's new size, docks what was over the code.
  keep("pr-42", { panelOverlay: false });
  expect(carried("pr-42")).toEqual({ panelOverlay: true });
  vi.advanceTimersByTime(100);
  gone();
  expect(carried("pr-42")).toEqual({ panelOverlay: true });
  vi.advanceTimersByTime(300);
  expect(carried("pr-42")).toEqual({ panelOverlay: true });
});

test("with the workspace still there, what waited is kept once the window has settled", () => {
  vi.useFakeTimers();
  const gone = present("pr-42");
  window.dispatchEvent(new Event("resize"));
  keep("pr-42", { find: "cache" });
  keep("pr-42", { navOverlay: true });
  expect(carried("pr-42")).toEqual({});
  vi.advanceTimersByTime(300);
  expect(carried("pr-42")).toEqual({ find: "cache", navOverlay: true });
  gone();
});

test("a new page after a reload starts clean: a remount there carries only what it kept itself", () => {
  // The page reloads with the workspace there: it never says it went.
  present("pr-42");
  keep("pr-42", { panelOverlay: true, focus: { in: "composer", caret: [3, 3], typing: "other" } });
  const origin = vi.spyOn(performance, "timeOrigin", "get").mockReturnValue(performance.timeOrigin + 1);
  try {
    const gone = present("pr-42");
    expect(carried("pr-42")).toEqual({});
    keep("pr-42", { find: "cache" });
    expect(carried("pr-42")).toEqual({ find: "cache" });
    gone();
  } finally {
    origin.mockRestore();
  }
});

test("what no workspace can go on from any more is dropped as anything's kept: another page's, and a review's gone 2 seconds", () => {
  vi.useFakeTimers();
  sessionStorage.setItem("gr:remount", JSON.stringify({ "pr-40": { live: 1, doc: performance.timeOrigin - 1, find: "cache" } }));
  present("pr-41")();
  expect(Object.keys(JSON.parse(sessionStorage.getItem("gr:remount")!))).toEqual(["pr-41"]);
  vi.advanceTimersByTime(2000);
  const gone = present("pr-42");
  expect(Object.keys(JSON.parse(sessionStorage.getItem("gr:remount")!))).toEqual(["pr-42"]);
  gone();
});

test("kept in another page, as before a reload, nothing is carried", () => {
  const gone = present("pr-42");
  keep("pr-42", { panelOverlay: true });
  const origin = vi.spyOn(performance, "timeOrigin", "get").mockReturnValue(performance.timeOrigin + 1);
  try {
    expect(carried("pr-42")).toBeNull();
  } finally {
    origin.mockRestore();
  }
  gone();
});
