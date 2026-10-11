// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

// Like pierre, each file's rows are in a diffs-container's shadow root.
// What goes under a line draws outside it, as pierre's annotation slots do.
vi.mock("@pierre/diffs/react", () => ({
  FileDiff: ({ fileDiff, lineAnnotations, renderAnnotation }: any) => createElement("div", null,
    createElement("diffs-container", {
      ref: (el: HTMLElement | null) => {
        if (!el || el.shadowRoot) return;
        el.attachShadow({ mode: "open" }).innerHTML = fileDiff.additionLines.map((_: string, i: number) => `<div data-line-type="change-addition" data-line="${i + 1}"></div>`).join("");
      },
    }),
    ...(lineAnnotations ?? []).map((annotation: any, i: number) => createElement("div", { key: i }, renderAnnotation(annotation)))),
}));

import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import type { FileViewFlags } from "./DiffViewer";
import { InlineDraftContext, type InlineDraft } from "./InlineDraft";

installTestPluginRuntime();
// Before pierre defines its own, which needs stylesheets jsdom lacks.
customElements.define("diffs-container", class extends HTMLElement {});
const { DiffViewer } = await import("./DiffViewer");

const rects = Element.prototype.getClientRects;
const boxes = Element.prototype.getBoundingClientRect;
const animate = (Element.prototype as Partial<Element>).animate;
afterEach(() => {
  cleanup();
  Element.prototype.getClientRects = rects;
  Element.prototype.getBoundingClientRect = boxes;
  (Element.prototype as Partial<Element>).animate = animate;
});

const patch = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,3 @@\n-old\n+one\n+two\n+three\n";

test("a reveal scrolls the review to a line pierre drew in its shadow root, and outlines it for a moment", async () => {
  // jsdom has no layout: every element has a box, and the review scrolls.
  Element.prototype.getClientRects = () => [{}] as unknown as DOMRectList;
  const flashed = vi.fn();
  (Element.prototype as Partial<Element>).animate = function (this: Element) { flashed(this); return {} as Animation; };
  const review = document.body.appendChild(document.createElement("div"));
  review.style.overflowY = "auto";
  Object.defineProperties(review, { scrollHeight: { value: 2000 }, clientHeight: { value: 500 } });
  const scrollBy = vi.fn();
  review.scrollBy = scrollBy;
  render(
    <DiffViewer patch={patch} files={["src/a.ts"]} views={new Map<string, FileViewFlags>()} onToggleViewed={() => {}} reveal={{ at: { file: "src/a.ts", line: 2, side: "RIGHT" }, nonce: 1 }} />,
    { container: review },
  );
  await waitFor(() => expect(scrollBy).toHaveBeenCalled());
  const row = review.querySelector("diffs-container")!.shadowRoot!.querySelector('[data-line="2"]');
  expect(flashed).toHaveBeenCalledWith(row);
  review.remove();
});

test("a reveal of a line with a tall comment under it keeps the line below the file's sticky header", async () => {
  Element.prototype.getClientRects = () => [{}] as unknown as DOMRectList;
  // The review shows 500px; the file's header covers its top 60px. Line 2 is at 400, and its 400px comment under it.
  const box = (top: number, height: number) => ({ top, bottom: top + height, height, left: 0, right: 0, width: 0, x: 0, y: top, toJSON() {} }) as DOMRect;
  Element.prototype.getBoundingClientRect = function (this: Element) {
    if (this === review) return box(0, 500);
    if (this.matches("[data-file-header]")) return box(0, 60);
    if (this.matches("[data-draft-at]")) return box(420, 400);
    if (this.matches('[data-line="2"]')) return box(400, 20);
    return box(0, 0);
  };
  const review = document.body.appendChild(document.createElement("div"));
  review.style.overflowY = "auto";
  Object.defineProperties(review, { scrollHeight: { value: 2000 }, clientHeight: { value: 500 } });
  const scrollBy = vi.fn();
  review.scrollBy = scrollBy;
  const at = { file: "src/a.ts", line: 2, side: "RIGHT" as const };
  const draft: InlineDraft = {
    comments: [{ ...at, body: "Should this be `<`?" }], stale: [], discussions: [], editable: false, busy: false, writing: false,
    composer: null, editingAt: null, open() {}, ask() {}, remove() {}, dismiss() {}, undo() {}, chat: null,
  };
  render(
    <InlineDraftContext.Provider value={draft}>
      <DiffViewer patch={patch} files={["src/a.ts"]} views={new Map<string, FileViewFlags>()} onToggleViewed={() => {}} reveal={{ at, nonce: 1 }} />
    </InlineDraftContext.Provider>,
    { container: review },
  );
  await waitFor(() => expect(scrollBy).toHaveBeenCalled());
  // The line and its comment, 420px, centered in the 440px under the header: the line lands at 70.
  expect(400 - scrollBy.mock.calls[0][0].top).toBe(70);
  review.remove();
});
