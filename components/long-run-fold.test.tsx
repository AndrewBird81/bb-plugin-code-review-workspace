// @vitest-environment jsdom
// A long run of deleted lines in the real diff view: its fold row's button, the runs that start open, and ⇧J / ⇧K
// stepping through the changes drawn, a folded run counting as its block's. Pierre draws each file with its own server
// renderer, into a diffs-container's shadow root, and calls onPostRender after each draw, as it does in the browser.
import { createElement, useEffect, useRef } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@pierre/diffs/react", async () => {
  const { preloadFileDiff } = await import("@pierre/diffs/ssr");
  return {
    // Draws again only when its file, options or annotations are new objects, as pierre does.
    FileDiff: ({ fileDiff, options, lineAnnotations, renderAnnotation }: any) => {
      const host = useRef<HTMLElement>(null);
      useEffect(() => {
        let live = true;
        const { onPostRender, ...drawing } = options;
        void preloadFileDiff({ fileDiff, options: drawing, annotations: lineAnnotations ?? [] }).then(({ prerenderedHTML }) => {
          const el = host.current;
          if (!live || !el) return;
          // Pierre's own styles, which jsdom can't parse, aren't what's checked.
          (el.shadowRoot ?? el.attachShadow({ mode: "open" })).innerHTML = prerenderedHTML.replace(/<style[\s\S]*?<\/style>/g, "");
          onPostRender?.(el, null, "mount");
        });
        return () => { live = false; };
      }, [fileDiff, options, lineAnnotations]);
      return createElement("div", null, createElement("diffs-container", { ref: host }),
        ...(lineAnnotations ?? []).map((annotation: any, i: number) => createElement("div", { key: i }, renderAnnotation(annotation))));
    },
  };
});

import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import type { FileViewFlags } from "./DiffViewer";
import { InlineDraftContext, type InlineDraft } from "./InlineDraft";
import { MOVED_OUT, hunkPatch } from "../lib/diff-fixtures.test-support";
import type { CommentLocation } from "../src/draft";

installTestPluginRuntime();
// Before pierre defines its own, which needs stylesheets jsdom lacks.
customElements.define("diffs-container", class extends HTMLElement {});
const { DiffViewer } = await import("./DiffViewer");

const rects = Element.prototype.getClientRects;
const boxes = Element.prototype.getBoundingClientRect;
afterEach(() => {
  cleanup();
  Element.prototype.getClientRects = rects;
  Element.prototype.getBoundingClientRect = boxes;
  vi.restoreAllMocks();
});

// Old 14–190 deleted whole (run 0 folds 17–190 under old 16), then 62 lines for 2 (run 1 folds 198–254 under old 197).
const PATH = "infra/s3.tf";
const patch = hunkPatch(PATH, MOVED_OUT);
const root = () => document.querySelector("diffs-container")!.shadowRoot!;
const fold = (count: number) => screen.findByRole("button", { name: new RegExp(`^(Show ${count} more|Hide ${count}) deleted lines`) });
const shown = (run: number) => root().querySelectorAll(`[data-gr-fold="${run}"][data-gr-fold-open]`).length;
const hidden = (run: number) => root().querySelectorAll(`[data-gr-fold="${run}"]:not([data-gr-fold-open])`).length;
const draftWith = (comments: CommentLocation[]): InlineDraft => ({
  comments: comments.map((at) => ({ ...at, body: "Still read anywhere?" })), stale: [], discussions: [], editable: false, busy: false, writing: false,
  composer: null, editingAt: null, open() {}, ask() {}, remove() {}, dismiss() {}, undo() {}, chat: null,
});
function show(props: Partial<Parameters<typeof DiffViewer>[0]> = {}, draft: InlineDraft | null = null, container?: HTMLElement) {
  return render(
    <InlineDraftContext.Provider value={draft}>
      <DiffViewer patch={patch} files={[PATH]} views={new Map<string, FileViewFlags>()} onToggleViewed={() => {}} diffLayout="unified" {...props} />
    </InlineDraftContext.Provider>,
    container ? { container } : undefined,
  );
}

test("a long run's fold row is one button that shows and hides its lines where they are, without a redraw", async () => {
  show();
  const button = await fold(174);
  expect(button.textContent).toBe("Show 174 more deleted linesold 17–190");
  expect(button.getAttribute("aria-expanded")).toBe("false");
  await waitFor(() => expect(root().querySelectorAll('[data-gr-fold="0"]')).toHaveLength(2 * 174));
  expect(shown(0)).toBe(0);
  const drawn = root().firstElementChild;

  fireEvent.click(button);
  await waitFor(() => expect(button.getAttribute("aria-expanded")).toBe("true"));
  expect(button.textContent).toBe("Hide 174 deleted linesold 17–190");
  expect(shown(0)).toBe(2 * 174);
  // The other run stays as it was, and pierre didn't draw the file again.
  expect((await fold(57)).getAttribute("aria-expanded")).toBe("false");
  expect(shown(1)).toBe(0);
  expect(root().firstElementChild).toBe(drawn);

  fireEvent.click(button);
  await waitFor(() => expect(button.getAttribute("aria-expanded")).toBe("false"));
  expect(button.textContent).toBe("Show 174 more deleted linesold 17–190");
  expect(shown(0)).toBe(0);
});

test("a run starts open when a comment is in it, when the lines picked cross it, or when a reveal goes to a line in it", async () => {
  // Every row it folds is shown: its lines, their cells, and a comment under one of them.
  const opened = async () => {
    await waitFor(() => expect([shown(0) >= 2 * 174, hidden(0)]).toEqual([true, 0]));
    expect((await fold(174)).getAttribute("aria-expanded")).toBe("true");
    expect((await fold(57)).getAttribute("aria-expanded")).toBe("false");
    cleanup();
  };
  show({}, draftWith([{ file: PATH, line: 100, side: "LEFT" }]));
  await opened();
  show({ selectedLines: { file: PATH, range: { start: 150, end: 160, side: "deletions" } } });
  await opened();
  show({ reveal: { at: { file: PATH, line: 120, side: "LEFT" }, nonce: 1 } });
  await opened();
  // A comment on the run's last line shown shares its fold row: it opens the run, and the row stays the comment's.
  show({}, draftWith([{ file: PATH, line: 16, side: "LEFT" }]));
  await opened();
  show({}, draftWith([{ file: PATH, line: 16, side: "LEFT" }]));
  await waitFor(() => expect([shown(0), hidden(0)]).toEqual([2 * 174, 0]));
  const row = root().querySelector('[data-unified] [data-content] > [data-line="16"]')!.nextElementSibling!;
  expect([row.getAttribute("data-gr-fold-shared"), row.hasAttribute("data-gr-fold-row")]).toEqual(["0", false]);
  // A line on the new side with the same number doesn't.
  cleanup();
  show({}, draftWith([{ file: PATH, line: 100, side: "RIGHT" }]));
  expect((await fold(174)).getAttribute("aria-expanded")).toBe("false");
});

/**
 * jsdom has no layout: each row of the drawn code is 20px tall, by its index in the layout drawn, a folded run's rows
 * are hidden, and the review shows `view` (top and bottom). Steps must end, so the review scrolls nowhere.
 */
function layout(view: [number, number]) {
  const box = (top: number, bottom: number) => ({ top, bottom, height: bottom - top, left: 0, right: 0, width: 0, x: 0, y: top, toJSON() {} }) as DOMRect;
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const index = this.getAttribute("data-line-index");
    if (!index) return box(...view);
    const [unified, split] = index.split(",").map(Number);
    const top = (this.closest("[data-unified]") ? unified : split) * 20;
    return box(top, top + 20);
  };
  Element.prototype.getClientRects = function (this: Element) {
    return (this.matches("[data-gr-fold]:not([data-gr-fold-open])") ? [] : [{}]) as unknown as DOMRectList;
  };
  const review = document.body.appendChild(document.createElement("div"));
  review.style.overflowY = "auto";
  return review;
}
const said = () => screen.getByRole("status").textContent;
type Step = { current: ((direction: 1 | -1) => boolean) | null };
/** A step, as ⇧J or ⇧K takes it, and whether there was a change that way. */
function go(step: Step, direction: 1 | -1) {
  let moved = false;
  act(() => { moved = step.current!(direction); });
  return moved;
}

test("⇧J and ⇧K stop once at each change: a split's two sides are one, a comment under a line isn't one, and a folded run is its block's", async () => {
  for (const diffLayout of ["unified", "split"] as const) {
    // Every row in view, so each step goes on from the last.
    const review = layout([-100, 100_000]);
    const step: Step = { current: null };
    // A comment under the second added line of the first block.
    show({ diffLayout, changeStep: step }, draftWith([{ file: PATH, line: 2, side: "RIGHT" }]), review);
    await waitFor(() => expect(root().querySelectorAll("[data-gr-fold]").length).toBeGreaterThan(0));
    const stops: string[] = [];
    while (stops.length < 10 && go(step, 1)) stops.push(said()!);
    // The 2-for-5 block, the 9-for-2, the run of 177 (its first 3 shown, the rest folded), the 62-for-2, and 3 added.
    expect(stops).toEqual([
      `Change 1 of 5 · ${PATH}:1 (old line)`,
      `Change 2 of 5 · ${PATH}:4 (old line)`,
      `Change 3 of 5 · ${PATH}:14 (old line)`,
      `Change 4 of 5 · ${PATH}:193 (old line)`,
      `Change 5 of 5 · ${PATH}:15`,
    ]);
    expect(go(step, -1)).toBe(true);
    expect(said()).toBe(`Change 4 of 5 · ${PATH}:193 (old line)`);
    cleanup();
    review.remove();
  }
});

test("⇧J held down goes on from the change it just went to while the scroll there runs, not back to the one in view", async () => {
  const review = layout([0, 100]);
  const step: Step = { current: null };
  show({ changeStep: step }, null, review);
  await waitFor(() => expect(root().querySelectorAll("[data-gr-fold]").length).toBeGreaterThan(0));
  let now = 1000;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  // The review never scrolls here, as if each smooth scroll had only begun. From the view's top, the first change
  // below it is the second, which is out of view.
  expect(go(step, 1)).toBe(true);
  expect(said()).toBe(`Change 2 of 5 · ${PATH}:4 (old line)`);
  // Repeats a moment later go on from it, though it isn't in view yet.
  now += 30;
  go(step, 1);
  expect(said()).toBe(`Change 3 of 5 · ${PATH}:14 (old line)`);
  now += 30;
  go(step, -1);
  expect(said()).toBe(`Change 2 of 5 · ${PATH}:4 (old line)`);
  // Long after, with it out of view, a step starts again from the view's top.
  now += 5000;
  go(step, 1);
  expect(said()).toBe(`Change 2 of 5 · ${PATH}:4 (old line)`);
  review.remove();
});
