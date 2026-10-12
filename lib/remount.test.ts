// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { carried, keep, present } from "./remount";

afterEach(() => { sessionStorage.clear(); vi.useRealTimers(); });

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
