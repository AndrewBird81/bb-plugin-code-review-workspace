// @vitest-environment jsdom
import { test, expect, afterEach, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";

vi.mock("@pierre/diffs/react", () => ({
  FileDiff: () => <div data-testid="filediff" />,
}));

installTestPluginRuntime();
const { DiffViewer } = await import("./DiffViewer");

afterEach(cleanup);

const file = (path: string) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`;
const patch = [file("README.md"), file("src/handler.ts")].join("");
const shownFiles = (container: HTMLElement) => Array.from(container.querySelectorAll<HTMLElement>("[data-file]")).map((el) => el.dataset.file);

test("a chapter's files show in the guide's order, not the patch's", () => {
  const { container } = render(<DiffViewer patch={patch} files={["src/handler.ts", "README.md"]} views={new Map()} onToggleViewed={() => {}} />);
  expect(shownFiles(container)).toEqual(["src/handler.ts", "README.md"]);
});
