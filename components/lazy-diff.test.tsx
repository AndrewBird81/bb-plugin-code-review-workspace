// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

// Each file pierre draws.
const drawn: string[] = [];
vi.mock("@pierre/diffs/react", () => ({
  FileDiff: ({ fileDiff }: any) => {
    drawn.push(fileDiff.name);
    return <div data-testid="filediff" />;
  },
}));

import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import type { InlineDraft } from "./InlineDraft";

installTestPluginRuntime();
const { DiffViewer } = await import("./DiffViewer");
const { InlineDraftContext } = await import("./InlineDraft");

/** The IntersectionObserver the diff made, to say which file cards came near the screen. */
let observer: { callback: IntersectionObserverCallback; options?: IntersectionObserverInit; observed: Element[] } | null = null;
const original = globalThis.IntersectionObserver;
beforeEach(() => {
  globalThis.IntersectionObserver = class {
    constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) { observer = { callback, options, observed: [] }; }
    observe(el: Element) { observer!.observed.push(el); }
    unobserve() {}
    disconnect() {}
  } as unknown as typeof IntersectionObserver;
});
afterEach(() => { cleanup(); drawn.length = 0; observer = null; globalThis.IntersectionObserver = original; });

const card = (path: string) => document.querySelector<HTMLElement>(`[data-file="${path}"]`)!;
function near(...paths: string[]) {
  act(() => observer!.callback(paths.map((path) => ({ target: card(path), isIntersecting: true }) as unknown as IntersectionObserverEntry), observer as unknown as IntersectionObserver));
}

// 40 files of 50 replaced lines each: 4,000 rows unified.
const file = (path: string, lines = 50) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,${lines} +1,${lines} @@\n${Array.from({ length: lines }, (_, i) => `-old${i}`).join("\n")}\n${Array.from({ length: lines }, (_, i) => `+new${i}`).join("\n")}\n`;
const paths = Array.from({ length: 40 }, (_, i) => `src/f${i}.ts`);
const patch = paths.map((path) => file(path)).join("");
const show = (props: Record<string, unknown> = {}) => render(<DiffViewer patch={patch} files={paths} views={new Map()} onToggleViewed={() => {}} diffLayout="unified" {...props} />);

test("a large chapter draws a file's code only once it nears the screen, holding its height until then", () => {
  show();
  expect(drawn).toEqual([]);
  expect(observer!.observed.map((el) => (el as HTMLElement).dataset.file)).toEqual(paths);
  expect(observer!.options?.rootMargin).toBe("2000px 0px");
  // 100 rows of 20px, and pierre's 16px of padding.
  expect(card("src/f3.ts").querySelector<HTMLElement>("[data-pending-diff]")!.style.height).toBe("2016px");
  near("src/f0.ts", "src/f1.ts");
  expect(drawn).toEqual(["src/f0.ts", "src/f1.ts"]);
  expect(card("src/f1.ts").querySelector("[data-pending-diff]")).toBeNull();
  // Once drawn, a file stays drawn.
  act(() => observer!.callback([{ target: card("src/f0.ts"), isIntersecting: false } as unknown as IntersectionObserverEntry], observer as unknown as IntersectionObserver));
  expect(card("src/f0.ts").querySelector('[data-testid="filediff"]')).toBeTruthy();
});

test("a file revealed for a comment, or holding the comment box, draws without coming near first", () => {
  const view = show({ reveal: { at: { file: "src/f30.ts", line: 3, side: "RIGHT" }, nonce: 1 } });
  expect(drawn).toEqual(["src/f30.ts"]);
  const draft = { comments: [], discussions: [], composer: { file: "src/f35.ts", line: 2, side: "RIGHT", editing: false, asking: false }, editable: true, busy: false, open: () => {} } as unknown as InlineDraft;
  view.rerender(<InlineDraftContext.Provider value={draft}><DiffViewer patch={patch} files={paths} views={new Map()} onToggleViewed={() => {}} diffLayout="unified" /></InlineDraftContext.Provider>);
  expect(card("src/f35.ts").querySelector('[data-testid="filediff"]')).toBeTruthy();
});

test("a chapter of usual size draws every file at once", () => {
  render(<DiffViewer patch={patch} files={paths.slice(0, 5)} views={new Map()} onToggleViewed={() => {}} />);
  expect(drawn).toEqual(paths.slice(0, 5));
  expect(document.querySelector("[data-pending-diff]")).toBeNull();
});

test("a lockfile folded at the start doesn't make a chapter large", () => {
  render(<DiffViewer patch={file("package-lock.json", 3000) + file("src/a.ts", 5)} files={["package-lock.json", "src/a.ts"]} views={new Map()} onToggleViewed={() => {}} />);
  expect(drawn).toEqual(["src/a.ts"]);
});
