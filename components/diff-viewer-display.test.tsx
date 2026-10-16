// @vitest-environment jsdom
import { test, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, within } from "@testing-library/react";

// Each file pierre draws, with the options it was given; it fails to draw the files in `broken`.
const drawn: { name: string; options: any }[] = [];
const broken = new Set<string>();
vi.mock("@pierre/diffs/react", () => ({
  FileDiff: ({ fileDiff, options }: any) => {
    if (broken.has(fileDiff.name)) throw new Error(`Couldn't draw ${fileDiff.name}`);
    drawn.push({ name: fileDiff.name, options });
    return <div data-testid="filediff" />;
  },
}));

import { installTestPluginRuntime, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { FileViewFlags } from "./DiffViewer";

installTestPluginRuntime();
const { DiffViewer } = await import("./DiffViewer");

afterEach(() => { cleanup(); drawn.length = 0; broken.clear(); });

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
  // A huge file of code says why it folded, as a lockfile's tag does.
  expect(header("src/huge.ts").getByText("Large diff · 1,600 lines")).toBeTruthy();
  expect(header("package-lock.json").queryByText(/^Large diff/)).toBeNull();
  fireEvent.click(header("src/huge.ts").getByRole("button", { name: "Show diff of src/huge.ts" }));
  expect(header("src/huge.ts").queryByText(/^Large diff/)).toBeNull();
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

test("a narrow pane draws its diff unified from the first, never side by side first", () => {
  const original = globalThis.ResizeObserver;
  const measure = Element.prototype.getBoundingClientRect;
  // A pane 700px wide, which a ResizeObserver reports only after the first paint.
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  Element.prototype.getBoundingClientRect = function () { return { width: 700, height: 0, top: 0, left: 0, right: 700, bottom: 0 } as DOMRect; };
  try {
    render(<DiffViewer patch={file("src/a.ts", ["a"])} files={["src/a.ts"]} views={new Map()} onToggleViewed={() => {}} diffLayout="split" />);
    expect(drawn.length).toBeGreaterThan(0);
    expect(drawn.map((d) => d.options.diffStyle)).not.toContain("split");
  } finally {
    globalThis.ResizeObserver = original;
    Element.prototype.getBoundingClientRect = measure;
  }
});

test("a file whose diff fails to draw says so, with Try again and Open on GitHub, while the other files show", async () => {
  const { createHash } = await import("node:crypto");
  // React reports the error it caught.
  const report = vi.spyOn(console, "error").mockImplementation(() => {});
  broken.add("src/bad.ts");
  // Mounted as BB mounts a slot, which its links need.
  const component = () => <DiffViewer patch={file("src/bad.ts", ["b"]) + file("src/a.ts", ["a"])} files={["src/bad.ts", "src/a.ts"]} views={new Map()} onToggleViewed={() => {}} prUrl="https://github.com/acme/web/pull/42" />;
  const slot = renderSlot({ component }, {}, { rpc: {} as any });
  expect(new Set(drawn.map((d) => d.name))).toEqual(new Set(["src/a.ts"]));
  const failed = within(header("src/bad.ts").getByRole("alert"));
  expect(failed.getByText("Couldn’t show this file’s diff.")).toBeTruthy();
  const anchor = createHash("sha256").update("src/bad.ts").digest("hex");
  await waitFor(() => expect(failed.getByRole("link", { name: "Open on GitHub" }).getAttribute("href")).toBe(`https://github.com/acme/web/pull/42/files#diff-${anchor}`));
  expect(header("src/a.ts").queryByRole("alert")).toBeNull();
  broken.clear();
  fireEvent.click(failed.getByRole("button", { name: "Try again" }));
  expect(drawn.map((d) => d.name)).toContain("src/bad.ts");
  expect(header("src/bad.ts").queryByRole("alert")).toBeNull();
  slot.lifecycle.unmount();
  report.mockRestore();
});

test("a local review's failed file offers Try again, with no GitHub to open", () => {
  const report = vi.spyOn(console, "error").mockImplementation(() => {});
  broken.add("src/bad.ts");
  show(file("src/bad.ts", ["b"]), ["src/bad.ts"]);
  expect(header("src/bad.ts").getByRole("button", { name: "Try again" })).toBeTruthy();
  expect(header("src/bad.ts").queryByRole("link", { name: "Open on GitHub" })).toBeNull();
  report.mockRestore();
});

test("each file's card is a region named by its path, for a screen reader's list of them", () => {
  show(file("src/a.ts", ["a"]) + file("src/b.ts", ["b"]), ["src/a.ts", "src/b.ts"]);
  expect(screen.getByRole("region", { name: "src/a.ts" })).toBe(document.querySelector('[data-file="src/a.ts"]'));
  expect(screen.getByRole("region", { name: "src/b.ts" })).toBe(document.querySelector('[data-file="src/b.ts"]'));
});
