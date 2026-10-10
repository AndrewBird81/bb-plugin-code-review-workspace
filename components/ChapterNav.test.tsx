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
  { id: "c3", title: "Dependencies", overview: "lockfile", risk: "low", diffs: [{ file: "package-lock.json" }] },
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
  // Tests aren't skippable; a chapter of only lockfiles reads as one to skim.
  expect(screen.getAllByText(/1 skippable/)).toHaveLength(1);
  expect(screen.getByText(/generated files — skim/)).toBeTruthy();
});

test("the active chapter expands into a file list with tags and click-to-open", () => {
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
  // A test file carries a plain "test" tag, not a "skip" one.
  expect(screen.getByText("test")).toBeTruthy();
  expect(screen.queryByText(/test · skip/)).toBeNull();
  // Clicking a file row asks the workspace to open it.
  fireEvent.click(screen.getByText("auth.ts"));
  expect(onSelectFile).toHaveBeenCalledWith("c1", "src/auth.ts");
});

test("a viewed file is struck through in the sidebar list", () => {
  const views = new Map<string, FileViewFlags>([["src/auth.ts", { viewed: true, stale: false }]]);
  render(<ChapterNav sections={sections} activeId="c1" onSelect={() => {}} views={views} onSelectFile={() => {}} />);
  expect(screen.getByText("auth.ts").className).toContain("line-through");
});
