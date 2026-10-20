// @vitest-environment jsdom
// The diff's styles (lib/diff-css.ts) and what decorate() stamps for them, against what @pierre/diffs draws, from its
// own server renderer (the same rows as its shadow DOM): pierre's markup isn't its API, so a pierre that draws
// differently fails here rather than in a review.
import { expect, test } from "vitest";
import { parsePatchFiles, processFile, type DiffLineAnnotation, type FileDiffMetadata, type FileDiffOptions } from "@pierre/diffs";
import { preloadFileDiff } from "@pierre/diffs/ssr";
import { DIFF_CSS, ONE_SIDE_CSS, WHOLE_FILE_CSS } from "../lib/diff-css";
import { applyOpen, decorate } from "../lib/diff-decorate";
import { longRuns } from "../lib/long-runs";
import { MOVED_OUT, hunkPatch } from "../lib/diff-fixtures.test-support";

type Style = "unified" | "split";
const parse = (patch: string) => parsePatchFiles(patch).flatMap((p) => p.files)[0]!;
const NONE: ReadonlySet<number> = new Set();

/** The file drawn by pierre's server renderer into a host's shadow root, as the browser has it, then marked up. */
async function drawn(fileDiff: FileDiffMetadata, options: FileDiffOptions<unknown>, annotations: DiffLineAnnotation<unknown>[] = []) {
  // Expanding 20 lines at a time, as DiffViewer does, so a longer gap's band expands both ways.
  const { prerenderedHTML } = await preloadFileDiff({ fileDiff, options: { disableFileHeader: true, diffIndicators: "classic", expansionLineCount: 20, ...options }, annotations });
  const host = document.createElement("div");
  // Pierre's own styles, which jsdom can't parse, aren't what's checked.
  host.attachShadow({ mode: "open" }).innerHTML = prerenderedHTML.replace(/<style[\s\S]*?<\/style>/g, "");
  return host;
}
const shadow = (host: Element) => host.shadowRoot!;
const folds = (fileDiff: FileDiffMetadata) => longRuns(fileDiff).map((run, fold): DiffLineAnnotation<unknown> => ({ side: "deletions", lineNumber: run.anchor, metadata: { fold } }));

const moved = parse(hunkPatch("infra/s3.tf", MOVED_OUT));
const comment: DiffLineAnnotation<unknown> = { side: "additions", lineNumber: 4, metadata: {} };

// Two hunks well into a file, each under git's function context, as text alone and with the file's contents.
const oldLines = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`);
const newLines = oldLines.map((line, i) => (i === 10 ? "LINE 11" : i === 40 ? "LINE 41" : line));
const twoHunks = `diff --git a/src/rows.ts b/src/rows.ts
--- a/src/rows.ts
+++ b/src/rows.ts
@@ -9,5 +9,5 @@ function parse(rows) {
 line 9
 line 10
-line 11
+LINE 11
 line 12
 line 13
@@ -39,5 +39,5 @@ function render(view) {
 line 39
 line 40
-line 41
+LINE 41
 line 42
 line 43
`;
const banded = parse(twoHunks);
const expandable = processFile(twoHunks, { oldFile: { name: "src/rows.ts", contents: `${oldLines.join("\n")}\n` }, newFile: { name: "src/rows.ts", contents: `${newLines.join("\n")}\n` } })!;
const noNewline = parse("diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n");
const added = parse("diff --git a/src/new.ts b/src/new.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1,3 @@\n+const a = 1;\n+const b = 2;\n+export { a, b };\n");
const deleted = parse("diff --git a/src/old.ts b/src/old.ts\ndeleted file mode 100644\n--- a/src/old.ts\n+++ /dev/null\n@@ -1,3 +0,0 @@\n-const a = 1;\n-const b = 2;\n-export { a, b };\n");

/** Every selector of every rule, split at its top-level commas, without its pseudo-elements and :hover. */
function selectorsOf(css: string): string[] {
  const selectors: string[] = [];
  for (const [, prelude] of css.matchAll(/([^{}]+)\{[^{}]*\}/g)) {
    let depth = 0, start = 0;
    const text = prelude.trim();
    for (let i = 0; i <= text.length; i++) {
      const c = text[i];
      if (c === "(") depth++;
      else if (c === ")") depth--;
      else if ((c === "," && depth === 0) || i === text.length) {
        const selector = text.slice(start, i).trim().replace(/::(before|after)$/, "").replace(/:hover$/, "");
        if (selector && selector !== ":host") selectors.push(selector);
        start = i + 1;
      }
    }
  }
  return selectors;
}

/** Whether a selector finds anything; jsdom has no :has(), so `A:has(+ B) C` is looked for by hand. */
function finds(root: ParentNode, selector: string): boolean {
  const has = selector.match(/^(.*?):has\(\+ (.*)\)(.*)$/);
  if (!has) return !!root.querySelector(selector);
  const [, before, next, after] = has;
  return Array.from(root.querySelectorAll(before)).some((el) => !!el.nextElementSibling?.matches(next) && (!after.trim() || !!el.querySelector(after.trim())));
}

test("every selector of the diff's styles finds the rows it's for, in pierre's markup, unified and split", async () => {
  const roots: ShadowRoot[] = [];
  for (const diffStyle of ["unified", "split"] as Style[]) {
    for (const [fileDiff, annotations] of [[moved, [...folds(moved), comment]], [banded, []], [expandable, []], [noNewline, []]] as const) {
      const host = await drawn(fileDiff, { diffStyle }, [...annotations]);
      decorate(host, fileDiff, longRuns(fileDiff), NONE);
      roots.push(shadow(host));
    }
  }
  const selectors = selectorsOf(DIFF_CSS);
  expect(selectors.length).toBeGreaterThanOrEqual(40);
  expect(selectors.filter((selector) => !roots.some((root) => finds(root, selector)))).toEqual([]);
  // A new or a deleted file, drawn as a file: pierre's bars.
  const whole = new Map<string, ShadowRoot>();
  for (const [kind, fileDiff] of [["new", added], ["deleted", deleted]] as const) {
    const host = await drawn(fileDiff, { diffStyle: "unified", diffIndicators: "bars", disableBackground: true });
    decorate(host, fileDiff);
    whole.set(kind, shadow(host));
  }
  expect(selectorsOf(ONE_SIDE_CSS).filter((selector) => ![...whole.values()].some((root) => finds(root, selector)))).toEqual([]);
  expect(selectorsOf(WHOLE_FILE_CSS.new).filter((selector) => !finds(whole.get("new")!, selector))).toEqual([]);
  expect(selectorsOf(WHOLE_FILE_CSS.deleted).filter((selector) => !finds(whole.get("deleted")!, selector))).toEqual([]);
});

test("unified, each gutter cell gets the other side's number: an unchanged line shows both", async () => {
  const host = await drawn(moved, { diffStyle: "unified" });
  decorate(host, moved);
  const cell = (line: number) => shadow(host).querySelector<HTMLElement>(`[data-column-number="${line}"][data-line-type="context"]`)!;
  // Old 3 is new 6; old 191, after the long run, is new 10.
  expect([cell(6).dataset.altLine, cell(10).dataset.altLine]).toEqual(["3", "191"]);
  expect(shadow(host).querySelector('[data-line-type="change-deletion"][data-alt-line]')).toBeNull();
});

test("each band carries git's function context for the hunk after it, by the hunk it expands into once it can", async () => {
  for (const fileDiff of [banded, expandable]) {
    const host = await drawn(fileDiff, { diffStyle: "unified" });
    decorate(host, fileDiff);
    const labels = Array.from(shadow(host).querySelectorAll<HTMLElement>("[data-gutter] [data-separator-content]"));
    expect(labels.map((label) => label.dataset.hunkContext)).toEqual(expect.arrayContaining(["function parse(rows) {", "function render(view) {"]));
  }
});

test("a long run folds past its first 3 lines: its rows and their gutter cells, and one fold row, which a comment doesn't break", async () => {
  const runs = longRuns(moved);
  const host = await drawn(moved, { diffStyle: "unified" }, [...folds(moved), { side: "deletions", lineNumber: 100, metadata: {} }]);
  expect(decorate(host, moved, runs, NONE)).toEqual(new Set([0, 1]));
  const stamped = (attribute: string, run: number) => shadow(host).querySelectorAll(`[${attribute}="${run}"]`);
  // Old 17–190 and their cells, and the comment under old 100 with its gutter: it folds with its line.
  expect(stamped("data-gr-fold", 0)).toHaveLength(2 * 174 + 2);
  expect(stamped("data-gr-fold", 1)).toHaveLength(2 * 57);
  expect(Array.from(stamped("data-gr-fold-row", 0), (el) => el.matches("[data-line-annotation], [data-gutter-buffer=annotation]"))).toEqual([true, true]);
  expect(shadow(host).querySelector('[data-line="16"]')!.nextElementSibling!.getAttribute("data-gr-fold-row")).toBe("0");
  // Opening a run shows its rows where they are, closing hides them again.
  applyOpen(host, new Set([1]));
  expect(shadow(host).querySelectorAll("[data-gr-fold-open]")).toHaveLength(2 * 57);
  applyOpen(host, NONE);
  expect(shadow(host).querySelectorAll("[data-gr-fold-open]")).toHaveLength(0);
});

test("in a split, the fold row and the empty side beside the folded rows fold too, so both sides stay aligned", async () => {
  const host = await drawn(moved, { diffStyle: "split" }, folds(moved));
  expect(decorate(host, moved, longRuns(moved), NONE)).toEqual(new Set([0, 1]));
  const rows = (run: number) => Array.from(shadow(host).querySelectorAll<HTMLElement>(`[data-gr-fold="${run}"]`));
  // The deleted rows and their cells, then the empty side's one block of exactly as many rows, and its gutter.
  expect(rows(0)).toHaveLength(2 * 174 + 2);
  const emptySide = rows(0).filter((el) => el.closest("[data-additions]"));
  expect(emptySide.map((el) => [el.dataset.gutterBuffer ?? "code", el.dataset.bufferSize])).toEqual([["buffer", "174"], ["code", "174"]]);
  expect(shadow(host).querySelectorAll('[data-gr-fold-row="0"]')).toHaveLength(4);
});

test("a run that can't be folded exactly shows whole, without stamps: a comment inside it splits a split's empty side", async () => {
  const host = await drawn(moved, { diffStyle: "split" }, [...folds(moved), { side: "deletions", lineNumber: 100, metadata: {} }]);
  expect(decorate(host, moved, longRuns(moved), NONE)).toEqual(new Set([1]));
  expect(shadow(host).querySelectorAll('[data-gr-fold="0"], [data-gr-fold-row="0"]')).toHaveLength(0);
});

test("a comment on a run's last line shown shares the run's fold row, which decorate() marks shared: it keeps the comment's look", async () => {
  const comment = { side: "deletions" as const, lineNumber: 16, metadata: {} };
  for (const diffStyle of ["unified", "split"] as Style[]) {
    const host = await drawn(moved, { diffStyle }, [comment, ...folds(moved)]);
    expect(decorate(host, moved, longRuns(moved), NONE)).toEqual(new Set([0, 1]));
    const row = shadow(host).querySelector('[data-content] > [data-line="16"][data-line-type="change-deletion"]')!.nextElementSibling!;
    expect([row.getAttribute("data-gr-fold-shared"), row.hasAttribute("data-gr-fold-row")]).toEqual(["0", false]);
    // Its gutter cell too, and in a split the other side's row and cell: none of them is styled as a fold row.
    expect(shadow(host).querySelectorAll('[data-gr-fold-shared="0"]')).toHaveLength(diffStyle === "split" ? 4 : 2);
    expect(shadow(host).querySelectorAll('[data-gr-fold-row="0"]')).toHaveLength(0);
    expect(shadow(host).querySelectorAll('[data-gr-fold-row="1"]')).toHaveLength(diffStyle === "split" ? 4 : 2);
  }
  // Once the comment's gone, the next draw marks the row a fold row again.
  const host = await drawn(moved, { diffStyle: "unified" }, [comment, ...folds(moved)]);
  decorate(host, moved, longRuns(moved), NONE);
  const slots = shadow(host).querySelector('[data-content] > [data-line="16"]')!.nextElementSibling!.querySelectorAll("slot");
  slots[0].remove();
  decorate(host, moved, longRuns(moved), NONE);
  expect([shadow(host).querySelectorAll('[data-gr-fold-row="0"]').length, shadow(host).querySelectorAll("[data-gr-fold-shared]").length]).toEqual([2, 0]);
});

test("a run whose rows' gutter cells aren't the ones those rows have shows whole: the gutter and the code must stay 1:1", async () => {
  // The fold row's gutter cell isn't an annotation's.
  const unified = await drawn(moved, { diffStyle: "unified" }, folds(moved));
  shadow(unified).querySelector('[data-gutter] > [data-column-number="16"][data-line-type="change-deletion"]')!.nextElementSibling!.setAttribute("data-gutter-buffer", "metadata");
  expect(decorate(unified, moved, longRuns(moved), NONE)).toEqual(new Set([1]));
  expect(shadow(unified).querySelectorAll('[data-gr-fold="0"], [data-gr-fold-row="0"]')).toHaveLength(0);
  // A comment under a folded line whose gutter cell is something else.
  const commented = await drawn(moved, { diffStyle: "unified" }, [...folds(moved), { side: "deletions", lineNumber: 100, metadata: {} }]);
  shadow(commented).querySelector('[data-gutter] > [data-column-number="100"][data-line-type="change-deletion"]')!.nextElementSibling!.removeAttribute("data-gutter-buffer");
  expect(decorate(commented, moved, longRuns(moved), NONE)).toEqual(new Set([1]));
  // In a split, the empty side's gutter cell isn't as tall as its code.
  const split = await drawn(moved, { diffStyle: "split" }, folds(moved));
  shadow(split).querySelector('[data-additions] [data-gutter] > [data-gutter-buffer="buffer"][data-buffer-size="174"]')!.setAttribute("data-buffer-size", "173");
  expect(decorate(split, moved, longRuns(moved), NONE)).toEqual(new Set([1]));
  expect(shadow(split).querySelectorAll('[data-gr-fold="0"], [data-gr-fold-row="0"]')).toHaveLength(0);
});

test("a selected line's number in a file drawn as a file takes pierre's selection color, not the neutral numbers'", () => {
  for (const css of [WHOLE_FILE_CSS.new, WHOLE_FILE_CSS.deleted]) {
    const neutral = css.split("\n").find((rule) => rule.includes("color: var(--diffs-fg-number)"));
    expect(neutral).toMatch(/\[data-column-number\]:not\(\[data-selected-line\]\) \{/);
  }
});
