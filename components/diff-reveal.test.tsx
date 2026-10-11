// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

// Like pierre, each file's rows are in a diffs-container's shadow root.
vi.mock("@pierre/diffs/react", () => ({
  FileDiff: ({ fileDiff }: any) => createElement("diffs-container", {
    ref: (el: HTMLElement | null) => {
      if (!el || el.shadowRoot) return;
      el.attachShadow({ mode: "open" }).innerHTML = fileDiff.additionLines.map((_: string, i: number) => `<div data-line-type="change-addition" data-line="${i + 1}"></div>`).join("");
    },
  }),
}));

import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import type { FileViewFlags } from "./DiffViewer";

installTestPluginRuntime();
// Before pierre defines its own, which needs stylesheets jsdom lacks.
customElements.define("diffs-container", class extends HTMLElement {});
const { DiffViewer } = await import("./DiffViewer");

const rects = Element.prototype.getClientRects;
const animate = (Element.prototype as Partial<Element>).animate;
afterEach(() => {
  cleanup();
  Element.prototype.getClientRects = rects;
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
