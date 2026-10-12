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
  // Low risk is the usual case: it goes unsaid.
  expect(screen.queryByText("Low risk")).toBeNull();
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

test("the current file is marked for screen readers, and viewed files say so", () => {
  const views = new Map<string, FileViewFlags>([["src/auth.test.ts", { viewed: true, stale: false }]]);
  render(<ChapterNav sections={sections} activeId="c1" onSelect={() => {}} views={views} onSelectFile={() => {}} currentFile="src/auth.ts" />);
  expect(screen.getByRole("button", { name: /^auth\.ts/ }).getAttribute("aria-current")).toBe("true");
  expect(screen.getByRole("button", { name: /^auth\.test\.ts/ }).getAttribute("aria-current")).toBeNull();
  expect(screen.getByRole("button", { name: /^auth\.test\.ts/ }).textContent).toContain("viewed");
});

test("a file split across chapters counts in each only the lines of its hunks there", () => {
  const patch = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+aa\n@@ -20,2 +20,2 @@\n-b\n-c\n+bb\n+cc\n";
  render(
    <ChapterNav
      sections={[
        { id: "c1", title: "Parsing", overview: "", diffs: [{ file: "src/a.ts", hunks: [1] }] },
        { id: "c2", title: "Caching", overview: "", diffs: [{ file: "src/a.ts", hunks: [2] }] },
      ]}
      activeId="c1"
      onSelect={() => {}}
      views={new Map<string, FileViewFlags>()}
      onSelectFile={() => {}}
      lines={new Map([["src/a.ts", 6]])}
      patch={patch}
    />,
  );
  expect(screen.getByText("2 lines")).toBeTruthy();
  expect(screen.getByText("4 lines")).toBeTruthy();
});

test("each chapter shows the changed lines worth reading, without lockfiles", () => {
  render(
    <ChapterNav
      sections={sections}
      activeId="c1"
      onSelect={() => {}}
      views={new Map<string, FileViewFlags>()}
      onSelectFile={() => {}}
      lines={new Map([["src/auth.ts", 1200], ["src/auth.test.ts", 40], ["README.md", 1], ["package-lock.json", 5000]])}
    />,
  );
  expect(screen.getByText("1,240 lines")).toBeTruthy();
  expect(screen.getByText("1 line")).toBeTruthy();
  expect(screen.queryByText(/5,000/)).toBeNull();
  expect(screen.getAllByText(/ lines?$/)).toHaveLength(2);
});

test("files the repo's .gitattributes marks generated count as skippable, tagged, and not to read", () => {
  render(
    <ChapterNav
      sections={sections}
      activeId="c1"
      onSelect={() => {}}
      views={new Map<string, FileViewFlags>()}
      onSelectFile={() => {}}
      lines={new Map([["src/auth.ts", 1200], ["src/auth.test.ts", 40]])}
      generated={new Set(["src/auth.ts"])}
    />,
  );
  expect(screen.getAllByText(/1 skippable/)).toHaveLength(2);
  expect(screen.getByText("generated · skip")).toBeTruthy();
  expect(screen.getByText("40 lines")).toBeTruthy();
});

test("Chapters and All files read in sentence case, beside the files viewed, with Next unviewed by the progress until all are", () => {
  const onNextUnviewed = vi.fn();
  const nav = (views: Map<string, FileViewFlags>) => <ChapterNav sections={sections} activeId="c1" onSelect={() => {}} views={views} onSelectFile={() => {}} onViewChange={() => {}} onNextUnviewed={onNextUnviewed} />;
  const view = render(nav(new Map([["README.md", { viewed: true, stale: false }]])));
  for (const name of ["Chapters", "All files"]) expect(screen.getByRole("button", { name }).className).not.toContain("uppercase");
  expect(screen.getByText("1/4 files viewed")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Next unviewed" }));
  expect(onNextUnviewed).toHaveBeenCalledOnce();
  view.rerender(nav(new Map(["src/auth.ts", "src/auth.test.ts", "README.md", "package-lock.json"].map((file) => [file, { viewed: true, stale: false }]))));
  expect(screen.getByText("4/4 files viewed")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Next unviewed" })).toBeNull();
});

test("the Overview's row comes before the chapters, and only with them, not All files", () => {
  const nav = (view: "chapters" | "files") => <ChapterNav sections={sections} activeId="c1" onSelect={() => {}} views={new Map()} onSelectFile={() => {}} view={view} overview={<button type="button">Overview</button>} />;
  const view = render(nav("chapters"));
  const chapters = screen.getByRole("navigation", { name: "Chapters" });
  const buttons = Array.from(chapters.querySelectorAll("button")).map((button) => button.textContent);
  expect(buttons.indexOf("Overview")).toBeLessThan(buttons.findIndex((text) => text?.startsWith("Auth token refresh")));
  view.rerender(nav("files"));
  expect(screen.queryByRole("button", { name: "Overview" })).toBeNull();
});

test("an open chapter's card ends with how much of it you've viewed and Mark chapter viewed, then Chapter viewed once it's done", () => {
  const onMarkViewed = vi.fn();
  const nav = (views: Map<string, FileViewFlags>) => <ChapterNav sections={sections} activeId="c1" onSelect={() => {}} views={views} onSelectFile={() => {}} onMarkViewed={onMarkViewed} />;
  const view = render(nav(new Map([["src/auth.ts", { viewed: true, stale: false }]])));
  expect(screen.getByText("1 of 2 viewed")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Mark chapter viewed" }));
  expect(onMarkViewed).toHaveBeenCalledWith("c1");
  view.rerender(nav(new Map([["src/auth.ts", { viewed: true, stale: false }], ["src/auth.test.ts", { viewed: true, stale: false }]])));
  expect(screen.getByText("Chapter viewed")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Mark chapter viewed" })).toBeNull();
});

test("a closed chapter's card has a ✓ that marks it viewed without opening it, until it's done, and opened it has the button instead", () => {
  const onMarkViewed = vi.fn();
  const onSelect = vi.fn();
  render(<ChapterNav sections={sections} activeId="c1" onSelect={onSelect} views={new Map([["package-lock.json", { viewed: true, stale: false }]])} onSelectFile={() => {}} onMarkViewed={onMarkViewed} />);
  // Shown on hover or focus: it's there for a pointer and the keyboard, and hidden on touch, where the card opens.
  const check = screen.getByRole("button", { name: "Mark chapter 2 viewed" });
  expect(check.className).toContain("group-hover/card:opacity-100");
  expect(check.className).toContain("pointer-coarse:hidden");
  fireEvent.click(check);
  expect(onMarkViewed).toHaveBeenCalledWith("c2");
  expect(onSelect).not.toHaveBeenCalled();
  // Chapter 3 is all viewed; the open chapter 1 has its own button.
  expect(screen.queryByRole("button", { name: "Mark chapter 3 viewed" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Mark chapter 1 viewed" })).toBeNull();
  fireEvent.click(screen.getAllByRole("button", { name: "Expand chapter" })[0]);
  expect(screen.queryByRole("button", { name: "Mark chapter 2 viewed" })).toBeNull();
  expect(screen.getAllByRole("button", { name: "Mark chapter viewed" })).toHaveLength(2);
});
