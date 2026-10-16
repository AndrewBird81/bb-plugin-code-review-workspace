// @vitest-environment jsdom
import { test, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";

// Each file pierre draws, with the options it was given.
const drawn: { name: string; options: any }[] = [];
vi.mock("@pierre/diffs/react", () => ({
  FileDiff: ({ fileDiff, options }: any) => {
    drawn.push({ name: fileDiff.name, options });
    return <div data-testid="filediff" />;
  },
}));

import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import type { FileViewFlags } from "./DiffViewer";

installTestPluginRuntime();
const { DiffViewer } = await import("./DiffViewer");

afterEach(() => { cleanup(); drawn.length = 0; });

const file = (path: string, lines: string[]) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join("\n")}\n`;
const show = (patch: string, files: string[], views = new Map<string, FileViewFlags>()) =>
  render(<DiffViewer patch={patch} files={files} views={views} onToggleViewed={() => {}} />);
const header = (path: string) => within(document.querySelector<HTMLElement>(`[data-file="${path}"]`)!);

test("lockfiles, generated files, and huge diffs start folded, keeping their tag and Show diff under their row", () => {
  const huge = Array.from({ length: 1600 }, (_, i) => `const x${i} = ${i};`);
  const patch = file("package-lock.json", ["{}"]) + file("dist/app.js", ["x"]) + file("src/huge.ts", huge) + file("src/a.ts", ["a"]);
  show(patch, ["package-lock.json", "dist/app.js", "src/huge.ts", "src/a.ts"]);
  expect(drawn.map((d) => d.name)).toEqual(["src/a.ts"]);
  expect(header("package-lock.json").getByText("lockfile · skip")).toBeTruthy();
  expect(header("src/a.ts").queryByRole("button", { name: /^Show diff/ })).toBeNull();
  fireEvent.click(header("src/huge.ts").getByRole("button", { name: "Show diff of src/huge.ts" }));
  expect(drawn.map((d) => d.name)).toContain("src/huge.ts");
  expect(header("src/huge.ts").queryByRole("button", { name: /^Show diff/ })).toBeNull();
  expect(screen.getAllByRole("button", { name: /^Show diff of / }).map((button) => button.getAttribute("aria-label"))).toEqual(["Show diff of package-lock.json", "Show diff of dist/app.js"]);
});

test("a file's row sticks and names the file; what else there is about it scrolls away under it, Renamed from included", () => {
  const renamed = "diff --git a/src/util/time.ts b/src/util/clock-time.ts\nsimilarity index 90%\nrename from src/util/time.ts\nrename to src/util/clock-time.ts\n--- a/src/util/time.ts\n+++ b/src/util/clock-time.ts\n@@ -1 +1 @@\n-a\n+b\n";
  show(renamed + file("src/a.ts", ["a"]), ["src/util/clock-time.ts", "src/a.ts"]);
  expect(header("src/util/clock-time.ts").getByText("src/util/time.ts").parentElement!.textContent).toBe("Renamed from src/util/time.ts");
  expect(header("src/a.ts").queryByText(/Renamed from/)).toBeNull();
  const row = document.querySelector<HTMLElement>('[data-file="src/util/clock-time.ts"] [data-file-header]')!;
  expect(row.className.split(" ")).toEqual(expect.arrayContaining(["sticky", "top-0", "h-9", "pointer-coarse:h-11"]));
  expect(within(row).getByTitle("src/util/clock-time.ts")).toBeTruthy();
  expect(within(row).queryByText(/Renamed from/)).toBeNull();
});

test("a viewed file folds to its row alone, without the guide's summary of it", () => {
  render(<DiffViewer patch={file("src/a.ts", ["a"])} files={["src/a.ts"]} summaries={new Map([["src/a.ts", "Reads a row."]])} views={new Map([["src/a.ts", { viewed: true, stale: false }]])} onToggleViewed={() => {}} />);
  expect(drawn).toEqual([]);
  const card = document.querySelector<HTMLElement>('[data-file="src/a.ts"]')!;
  expect(card.children).toHaveLength(1);
  expect(within(card).queryByText("Reads a row.")).toBeNull();
  // Opened, it shows the summary under its row.
  fireEvent.click(within(card).getByRole("button", { name: "Expand src/a.ts" }));
  expect(within(card).getByText("Reads a row.")).toBeTruthy();
});

test("a file stops highlighting well before a huge diff would freeze the page", () => {
  show(file("src/a.ts", ["a"]), ["src/a.ts"]);
  expect(drawn.at(-1)!.options.tokenizeMaxLength).toBeLessThanOrEqual(5000);
});

test("split view goes unified when a side would be narrower than about 480px", () => {
  const original = globalThis.ResizeObserver;
  let width = 900;
  globalThis.ResizeObserver = class {
    constructor(private notify: ResizeObserverCallback) {}
    observe(target: Element) { this.notify([{ target, contentRect: { width } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver); }
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  show(file("src/a.ts", ["a"]), ["src/a.ts"]);
  expect(drawn.at(-1)!.options.diffStyle).toBe("unified");
  cleanup();
  width = 1000;
  show(file("src/a.ts", ["a"]), ["src/a.ts"]);
  expect(drawn.at(-1)!.options.diffStyle).toBe("split");
  globalThis.ResizeObserver = original;
});

test("added and removed lines are marked + and −, not by color alone, in the diff and in the changes gone since", () => {
  show(file("src/a.ts", ["a"]), ["src/a.ts"]);
  expect(drawn.at(-1)!.options.diffIndicators).toBe("classic");
  cleanup();
  drawn.length = 0;
  const since = new Map([["src/a.ts", { file: "src/a.ts", status: "changed", newLines: [1], newDeletions: [], patch: file("src/a.ts", ["a"]), dropped: file("src/a.ts", ["gone"]) }]]);
  render(<DiffViewer patch={file("src/a.ts", ["a"])} files={["src/a.ts"]} views={new Map()} onToggleViewed={() => {}} since={since as any} sinceOnly />);
  fireEvent.click(screen.getByText(/^Changes gone since/));
  expect(drawn.length).toBeGreaterThan(0);
  expect(drawn.every((d) => d.options.diffIndicators === "classic")).toBe(true);
});
