// @vitest-environment jsdom
// Checks sinceReviewCSS's selectors against what @pierre/diffs actually draws,
// using pierre's own server renderer (the same row markup as its shadow DOM).
import { test, expect } from "vitest";
import { preloadPatchDiff } from "@pierre/diffs/ssr";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";

installTestPluginRuntime();
const { sinceReviewCSS } = await import("./DiffViewer");

const patch = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,3 @@",
  " keep",
  "-old",
  "+new",
  " tail",
  "@@ -10,2 +10,3 @@",
  " a",
  "+b",
  " c",
  "",
].join("\n");

for (const diffStyle of ["unified", "split"] as const) {
  test(`marks exactly the gutter cells of new lines, the seam between their numbers and code (${diffStyle})`, async () => {
    // Line 11 was added and old line 2 deleted since your review; new line 2 was already there.
    const css = sinceReviewCSS([11], [2]);
    const { prerenderedHTML } = await preloadPatchDiff({ patch, options: { diffStyle, disableFileHeader: true, unsafeCSS: css } });
    const root = document.createElement("div");
    root.innerHTML = prerenderedHTML;
    const selector = css.slice(0, css.indexOf("{"));
    const cells = Array.from(root.querySelectorAll<HTMLElement>(selector));
    // The gutter cell of each of the two lines, not its code.
    expect(cells.map((cell) => cell.hasAttribute("data-column-number"))).toEqual([true, true]);
    expect(cells.map((cell) => cell.textContent?.trim()).sort()).toEqual(["11", "2"]);
    expect(prerenderedHTML).toContain('[data-line-type="change-addition"][data-column-number="11"]');
  });
}

test("the mark is the seam alone: no tint, so a deleted line keeps its color; a file drawn as a file marks the outer edge", () => {
  const css = sinceReviewCSS([11], [2]);
  expect(css).toContain("border-right-color: var(--gr-since-mark)");
  expect(css).not.toContain("background");
  const asFile = sinceReviewCSS([11], [], true);
  expect(asFile).toContain("box-shadow: inset 2px 0 0 var(--gr-since-mark)");
  expect(asFile).not.toContain("border-right-color");
});

test("no new lines, no styles", () => {
  expect(sinceReviewCSS([], [])).toBe("");
});
