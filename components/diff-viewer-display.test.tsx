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

test("lockfiles, generated files, and huge diffs start folded, with Show diff in their header", () => {
  const huge = Array.from({ length: 1600 }, (_, i) => `const x${i} = ${i};`);
  const patch = file("package-lock.json", ["{}"]) + file("dist/app.js", ["x"]) + file("src/huge.ts", huge) + file("src/a.ts", ["a"]);
  show(patch, ["package-lock.json", "dist/app.js", "src/huge.ts", "src/a.ts"]);
  expect(drawn.map((d) => d.name)).toEqual(["src/a.ts"]);
  expect(header("src/a.ts").queryByRole("button", { name: /^Show diff/ })).toBeNull();
  fireEvent.click(header("src/huge.ts").getByRole("button", { name: "Show diff of src/huge.ts" }));
  expect(drawn.map((d) => d.name)).toContain("src/huge.ts");
  expect(header("src/huge.ts").queryByRole("button", { name: /^Show diff/ })).toBeNull();
  expect(screen.getAllByRole("button", { name: /^Show diff of / }).map((button) => button.getAttribute("aria-label"))).toEqual(["Show diff of package-lock.json", "Show diff of dist/app.js"]);
});

test("a renamed file's header says what it was renamed from", () => {
  const renamed = "diff --git a/src/util/time.ts b/src/util/clock-time.ts\nsimilarity index 90%\nrename from src/util/time.ts\nrename to src/util/clock-time.ts\n--- a/src/util/time.ts\n+++ b/src/util/clock-time.ts\n@@ -1 +1 @@\n-a\n+b\n";
  show(renamed + file("src/a.ts", ["a"]), ["src/util/clock-time.ts", "src/a.ts"]);
  expect(header("src/util/clock-time.ts").getByText("src/util/time.ts").parentElement!.textContent).toBe("Renamed from src/util/time.ts");
  expect(header("src/a.ts").queryByText(/Renamed from/)).toBeNull();
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
