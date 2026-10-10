// @vitest-environment jsdom
import { test, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { ChapterNav } from "./ChapterNav";
import type { FileViewFlags } from "./DiffViewer";

afterEach(cleanup);

const sections = [
  {
    id: "c1",
    title: "Auth token refresh logic with a deliberately long title",
    overview: "Schedules a refresh before expiry to avoid 401s",
    risk: "high",
    diffs: [{ file: "src/auth.ts" }, { file: "src/auth.test.ts" }],
  },
  { id: "c2", title: "Docs", overview: "readme tweaks", risk: "low", diffs: [{ file: "README.md" }] },
];

test("shows the full title, a worded risk flag, and a skippable count", () => {
  render(
    <ChapterNav
      sections={sections}
      activeId="c1"
      onSelect={() => {}}
      views={new Map<string, FileViewFlags>()}
      onSelectFile={() => {}}
    />,
  );
  expect(screen.getByText("Auth token refresh logic with a deliberately long title")).toBeTruthy();
  expect(screen.getByText("High risk")).toBeTruthy();
  expect(screen.getByText(/1 skippable/)).toBeTruthy();
});

test("the active chapter expands into a file list with skip tags and click-to-open", () => {
  const onSelectFile = vi.fn();
  render(
    <ChapterNav
      sections={sections}
      activeId="c1"
      onSelect={() => {}}
      views={new Map<string, FileViewFlags>()}
      onSelectFile={onSelectFile}
    />,
  );
  // Test file carries a "skip" tag.
  expect(screen.getByText(/test · skip/)).toBeTruthy();
  // Clicking a file row asks the workspace to open it.
  fireEvent.click(screen.getByText("auth.ts"));
  expect(onSelectFile).toHaveBeenCalledWith("c1", "src/auth.ts");
});

test("a viewed file is struck through in the sidebar list", () => {
  const views = new Map<string, FileViewFlags>([["src/auth.ts", { viewed: true, stale: false }]]);
  render(<ChapterNav sections={sections} activeId="c1" onSelect={() => {}} views={views} onSelectFile={() => {}} />);
  expect(screen.getByText("auth.ts").className).toContain("line-through");
});

test("the current file is marked for screen readers, and viewed files say so", () => {
  const views = new Map<string, FileViewFlags>([["src/auth.test.ts", { viewed: true, stale: false }]]);
  render(<ChapterNav sections={sections} activeId="c1" onSelect={() => {}} views={views} onSelectFile={() => {}} currentFile="src/auth.ts" />);
  expect(screen.getByRole("button", { name: /^auth\.ts/ }).getAttribute("aria-current")).toBe("true");
  expect(screen.getByRole("button", { name: /^auth\.test\.ts/ }).getAttribute("aria-current")).toBeNull();
  expect(screen.getByRole("button", { name: /^auth\.test\.ts/ }).textContent).toContain("viewed");
});
