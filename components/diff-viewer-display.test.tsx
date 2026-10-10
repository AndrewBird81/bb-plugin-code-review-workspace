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
  expect(header("src/a.ts").queryByRole("button", { name: "Show diff" })).toBeNull();
  fireEvent.click(header("src/huge.ts").getByRole("button", { name: "Show diff" }));
  expect(drawn.map((d) => d.name)).toContain("src/huge.ts");
  expect(header("src/huge.ts").queryByRole("button", { name: "Show diff" })).toBeNull();
  expect(screen.getAllByRole("button", { name: "Show diff" })).toHaveLength(2);
});

test("a file stops highlighting well before a huge diff would freeze the page", () => {
  show(file("src/a.ts", ["a"]), ["src/a.ts"]);
  expect(drawn.at(-1)!.options.tokenizeMaxLength).toBeLessThanOrEqual(5000);
});
