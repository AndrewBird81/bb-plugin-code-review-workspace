// @vitest-environment jsdom
import { test, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent, screen } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";

// Like pierre, setting a selection reports it back as selected.
vi.mock("@pierre/diffs/react", async () => {
  const { useEffect } = await import("react");
  return {
    FileDiff: ({ options, selectedLines }: any) => {
      useEffect(() => { if (selectedLines !== undefined) options.onLineSelected?.(selectedLines); }, [selectedLines]);
      const range = (end: number) => ({ start: 1, end, side: "additions" });
      return (
        <div data-testid="filediff" data-selected={selectedLines ? `${selectedLines.start}-${selectedLines.end}` : ""}>
          <button onClick={() => { options.onLineSelectionStart(range(1)); options.onLineSelectionChange(range(2)); }}>Drag to line 2</button>
          <button onClick={() => { options.onLineSelectionEnd(range(2)); options.onLineSelected(range(2)); }}>Release</button>
        </div>
      );
    },
  };
});

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

test("pierre paints the lines being dragged over, then only the selection the workspace keeps", () => {
  const onLineSelected = vi.fn();
  const props = { patch: file("src/handler.ts"), files: ["src/handler.ts"], views: new Map(), onToggleViewed: () => {}, onLineSelected };
  const { rerender } = render(<DiffViewer {...props} selectedLines={null} />);
  fireEvent.click(screen.getByRole("button", { name: "Drag to line 2" }));
  expect(screen.getByTestId("filediff").dataset.selected).toBe("1-2");
  expect(onLineSelected).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Release" }));
  expect(onLineSelected).toHaveBeenCalledTimes(1);
  expect(onLineSelected).toHaveBeenCalledWith("src/handler.ts", { start: 1, end: 2, side: "additions" });
  rerender(<DiffViewer {...props} selectedLines={{ file: "src/handler.ts", range: { start: 1, end: 2, side: "additions" } }} />);
  expect(screen.getByTestId("filediff").dataset.selected).toBe("1-2");
  rerender(<DiffViewer {...props} selectedLines={null} />);
  expect(screen.getByTestId("filediff").dataset.selected).toBe("");
  expect(onLineSelected).toHaveBeenCalledTimes(1);
});

test("each file's Viewed and collapse controls name the file", () => {
  render(<DiffViewer patch={patch} files={["src/handler.ts", "README.md"]} views={new Map()} onToggleViewed={() => {}} />);
  expect(screen.getByRole("checkbox", { name: "Viewed src/handler.ts" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Collapse README.md" }));
  expect(screen.getByRole("button", { name: "Expand README.md" })).toBeTruthy();
});
