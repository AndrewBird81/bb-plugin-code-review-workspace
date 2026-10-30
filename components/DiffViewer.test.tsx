// @vitest-environment jsdom
import { test, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";

// Render only our chrome and annotations, not @pierre/diffs' internals. Like
// pierre, the gutter "+" reports a line selection right after its own click.
vi.mock("@pierre/diffs/react", () => ({
  FileDiff: ({ fileDiff, options, lineAnnotations, renderAnnotation }: any) => {
    const range = { start: 2, end: 2, side: "additions" };
    return (
      <div data-testid="filediff" data-new-lines={fileDiff.additionLines.length}>
        {lineAnnotations?.map((annotation: any, index: number) => <div key={index}>{renderAnnotation?.(annotation)}</div>)}
        <button onClick={() => { options.onGutterUtilityClick(range); options.onLineSelected(range); }}>Gutter +</button>
        <button onClick={() => options.onLineSelected(range)}>Line number</button>
      </div>
    );
  },
}));

import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import type { FileViewFlags } from "./DiffViewer";
import type { InlineComposer, InlineDraft } from "./InlineDraft";

// Comments render with bb's Markdown, which binds to the plugin runtime when its module loads.
installTestPluginRuntime();
const { DiffViewer } = await import("./DiffViewer");
const { InlineComposerContext, InlineDraftContext } = await import("./InlineDraft");

afterEach(cleanup);

const patch = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,2 @@\n-old\n+new\n+more\n";

test("renders a file header with path, additions/deletions, and a Viewed checkbox", () => {
  render(
    <DiffViewer
      patch={patch}
      files={["src/a.ts"]}
      views={new Map<string, FileViewFlags>()}
      onToggleViewed={() => {}}
    />,
  );
  expect(screen.getByTitle("src/a.ts").textContent).toBe("src/a.ts");
  expect(screen.getByText("+2")).toBeTruthy();
  expect(screen.getByText("−1")).toBeTruthy();
  expect(screen.getByTestId("filediff")).toBeTruthy(); // expanded body present
});

test("checking Viewed reports up and collapses the diff body", () => {
  const onToggleViewed = vi.fn();
  render(
    <DiffViewer
      patch={patch}
      files={["src/a.ts"]}
      views={new Map<string, FileViewFlags>()}
      onToggleViewed={onToggleViewed}
    />,
  );
  fireEvent.click(screen.getByRole("checkbox"));
  expect(onToggleViewed).toHaveBeenCalledWith("src/a.ts", true);
  expect(screen.queryByTestId("filediff")).toBeNull(); // collapsed
});

test("checking Viewed on a file read past its top keeps its folded row at the top of the view, with the next file under it", () => {
  const second = patch.replaceAll("src/a.ts", "src/b.ts");
  const { container } = render(
    <div data-testid="box" style={{ overflowY: "auto" }}>
      <DiffViewer patch={patch + second} files={["src/a.ts", "src/b.ts"]} views={new Map<string, FileViewFlags>()} onToggleViewed={() => {}} />
    </div>,
  );
  const box = screen.getByTestId("box");
  const card = container.querySelector<HTMLElement>('[data-file="src/a.ts"]')!;
  // The box's top at 0; the file starts 100px down the box's content, and 500px of it are scrolled past.
  box.getBoundingClientRect = () => new DOMRect(0, 0, 800, 600);
  card.getBoundingClientRect = () => new DOMRect(0, 100 - box.scrollTop, 800, 40);
  box.scrollTop = 600;
  fireEvent.click(screen.getByRole("checkbox", { name: "Viewed src/a.ts" }));
  expect(box.scrollTop).toBe(100);
  // Unchecked, it opens where it is.
  fireEvent.click(screen.getByRole("checkbox", { name: "Viewed src/a.ts" }));
  expect(box.scrollTop).toBe(100);
});

test("checking Viewed on a file whose top shows leaves the view where it is", () => {
  const { container } = render(
    <div data-testid="box" style={{ overflowY: "auto" }}>
      <DiffViewer patch={patch} files={["src/a.ts"]} views={new Map<string, FileViewFlags>()} onToggleViewed={() => {}} />
    </div>,
  );
  const box = screen.getByTestId("box");
  const card = container.querySelector<HTMLElement>('[data-file="src/a.ts"]')!;
  box.getBoundingClientRect = () => new DOMRect(0, 0, 800, 600);
  card.getBoundingClientRect = () => new DOMRect(0, 300 - box.scrollTop, 800, 40);
  box.scrollTop = 200;
  fireEvent.click(screen.getByRole("checkbox"));
  expect(box.scrollTop).toBe(200);
});

test("a file that changed since you viewed it says so", () => {
  render(
    <DiffViewer
      patch={patch}
      files={["src/a.ts"]}
      views={new Map<string, FileViewFlags>([["src/a.ts", { viewed: false, stale: true }]])}
      onToggleViewed={() => {}}
    />,
  );
  expect(screen.getByText("Changed since you viewed it")).toBeTruthy();
});

test("the file header counts hunk lines that look like file headers", () => {
  const sql = "diff --git a/m.sql b/m.sql\n--- a/m.sql\n+++ b/m.sql\n@@ -1,2 +1,2 @@\n--- old note\n----\n+++i;\n+ok\n";
  render(<DiffViewer patch={sql} files={["m.sql"]} views={new Map()} onToggleViewed={() => {}} />);
  expect(screen.getByText("+2")).toBeTruthy();
  expect(screen.getByText("−2")).toBeTruthy();
});

const comment = { file: "src/a.ts", line: 2, side: "RIGHT" as const, author: "agent" as const, body: "Is the empty case tested?" };

function renderWithDraft(draft: Partial<InlineDraft>, props: Partial<Parameters<typeof DiffViewer>[0]> = {}, composer?: InlineComposer) {
  const value: InlineDraft = { comments: [], stale: [], discussions: [], editable: true, busy: false, writing: false, composer: null, open: vi.fn(), ask: vi.fn(), remove: vi.fn(), dismiss: vi.fn(), undo: vi.fn(), chat: null, editingAt: null, ...draft };
  render(
    <InlineDraftContext.Provider value={value}>
      <InlineComposerContext.Provider value={composer ?? null}>
        <DiffViewer patch={patch} files={["src/a.ts"]} views={new Map()} onToggleViewed={() => {}} {...props} />
      </InlineComposerContext.Provider>
    </InlineDraftContext.Provider>,
  );
  return value;
}

test("draft comments show under their lines with who added them, and the file's row counts them", () => {
  renderWithDraft({ comments: [comment], stale: [{ file: "src/a.ts", line: 2, side: "RIGHT" }] });
  const shown = screen.getByRole("article", { name: "Draft comment on src/a.ts:2" });
  expect(within(shown).getByText("Is the empty case tested?")).toBeTruthy();
  expect(within(shown).getByText("Older diff · not submitted")).toBeTruthy();
  expect(within(shown).getByText("Agent")).toBeTruthy();
  expect(screen.getByText("1 not submitted")).toBeTruthy();
});

test("a comment's Edit and Remove act on it, and a collapsed file still counts it", () => {
  const draft = renderWithDraft({ comments: [comment] });
  const shown = screen.getByRole("article", { name: "Draft comment on src/a.ts:2" });
  fireEvent.click(within(shown).getByRole("button", { name: "Edit" }));
  expect(draft.open).toHaveBeenCalledWith(comment);
  fireEvent.click(within(shown).getByRole("button", { name: "Remove" }));
  expect(draft.remove).toHaveBeenCalledWith(comment);
  fireEvent.click(screen.getByRole("checkbox"));
  expect(screen.queryByRole("article")).toBeNull();
  expect(screen.getByText("1 not submitted")).toBeTruthy();
});

test("a file's ▤ counts its drafts and its GitHub threads that aren't resolved, as the comments list does", async () => {
  const { DiffThreadsContext } = await import("./LineThreads");
  const thread = (id: string, line: number, isResolved = false) => ({ id, isResolved, isOutdated: false, path: "src/a.ts", line, side: "RIGHT" as const, comments: [{ id: `${id}c`, databaseId: 1, author: "bob", body: "Why?" }] });
  const threads = { targetKey: "pr-42", threads: [thread("T1", 1), thread("T2", 2, true), { ...thread("T3", 9), isOutdated: true }] };
  render(
    <DiffThreadsContext.Provider value={threads}>
      <InlineDraftContext.Provider value={{ comments: [comment, { ...comment, line: 1, author: undefined, body: "Name it." }], stale: [], discussions: [], editable: true, busy: false, writing: false, composer: null, open: vi.fn(), ask: vi.fn(), remove: vi.fn(), dismiss: vi.fn(), undo: vi.fn(), chat: null, editingAt: null }}>
        <DiffViewer patch={patch} files={["src/a.ts"]} views={new Map()} onToggleViewed={() => {}} />
      </InlineDraftContext.Provider>
    </DiffThreadsContext.Provider>,
  );
  const header = within(document.querySelector<HTMLElement>("[data-file-header]")!);
  // The resolved thread doesn't count; the outdated one, shown in the file's fold, does.
  const count = header.getByText("2 not submitted · 2 on GitHub");
  expect(count.parentElement!.textContent).toBe("42 not submitted · 2 on GitHub");
});

test("the gutter + opens a comment box at its line instead of offering the selection's actions", async () => {
  const onLineSelected = vi.fn();
  const draft = renderWithDraft({}, { onLineSelected });
  fireEvent.click(screen.getByRole("button", { name: "Gutter +" }));
  expect(draft.open).toHaveBeenCalledWith({ file: "src/a.ts", line: 2, side: "RIGHT" });
  expect(onLineSelected).not.toHaveBeenCalled();
  await Promise.resolve();
  fireEvent.click(screen.getByRole("button", { name: "Line number" }));
  expect(onLineSelected).toHaveBeenCalledWith("src/a.ts", { start: 2, end: 2, side: "additions" });
});

test("a draft that can't change shows its comments read-only, and the gutter + offers the selection's actions", () => {
  const onLineSelected = vi.fn();
  const draft = renderWithDraft({ comments: [comment], editable: false }, { onLineSelected });
  expect(within(screen.getByRole("article")).queryByRole("button")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Gutter +" }));
  expect(draft.open).not.toHaveBeenCalled();
  expect(onLineSelected).toHaveBeenCalledWith("src/a.ts", { start: 2, end: 2, side: "additions" });
});

test("the comment box takes the place of the comment it edits", () => {
  const composer: InlineComposer = { body: "Is the empty case tested?", change: vi.fn(), save: vi.fn(), askAgent: vi.fn(), cancel: vi.fn(), textareaRef: { current: null } };
  renderWithDraft({ comments: [comment], writing: true, composer: { file: "src/a.ts", line: 2, side: "RIGHT", editing: true, asking: false } }, {}, composer);
  expect(screen.queryByRole("article")).toBeNull();
  const box = screen.getByRole("textbox", { name: "Draft comment" }) as HTMLTextAreaElement;
  expect(box.value).toBe("Is the empty case tested?");
  fireEvent.change(box, { target: { value: "Please test the empty case." } });
  expect(composer.change).toHaveBeenCalledWith("Please test the empty case.");
  fireEvent.click(screen.getByRole("button", { name: "Save comment" }));
  expect(composer.save).toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(composer.cancel).toHaveBeenCalled();
});

test("Undo under a line puts back the agent's latest change there, except while its box is open", () => {
  const at = { file: "src/a.ts", line: 2, side: "RIGHT" as const };
  const discussion = { ...at, waiting: false, undoable: true, entries: [
    { author: "reviewer" as const, kind: "message" as const, body: "Shorter?", createdAt: 1 },
    { author: "agent" as const, kind: "edited" as const, body: comment.body, createdAt: 2 },
  ] };
  const draft = renderWithDraft({ comments: [comment], discussions: [discussion] });
  const thread = screen.getByRole("region", { name: "Discussion with agent on src/a.ts:2" });
  expect(within(thread).getByText("Agent edited the comment.")).toBeTruthy();
  fireEvent.click(within(thread).getByRole("button", { name: "Undo" }));
  expect(draft.undo).toHaveBeenCalledWith(discussion);
  cleanup();
  renderWithDraft({ comments: [comment], discussions: [discussion], composer: { ...at, editing: true, asking: false } }, {}, { body: comment.body, change: vi.fn(), save: vi.fn(), askAgent: vi.fn(), cancel: vi.fn(), textareaRef: { current: null } });
  expect(within(screen.getByRole("region", { name: "Discussion with agent on src/a.ts:2" })).queryByRole("button", { name: "Undo" })).toBeNull();
});

test("Undo under a line waits while the panel's box edits that comment", () => {
  const at = { file: "src/a.ts", line: 2, side: "RIGHT" as const };
  const discussion = { ...at, waiting: false, undoable: true, entries: [{ author: "agent" as const, kind: "edited" as const, body: comment.body, createdAt: 2 }] };
  renderWithDraft({ comments: [comment], discussions: [discussion], editingAt: at });
  expect(within(screen.getByRole("region", { name: "Discussion with agent on src/a.ts:2" })).queryByRole("button", { name: "Undo" })).toBeNull();
});

test("a viewed file, folded, dims its path alone, not its row's other text", () => {
  render(<DiffViewer patch={patch} files={["src/a.ts"]} views={new Map<string, FileViewFlags>([["src/a.ts", { viewed: true, stale: true }]])} onToggleViewed={() => {}} />);
  const card = document.querySelector<HTMLElement>('[data-file="src/a.ts"]')!;
  expect(card.className).not.toMatch(/opacity/);
  expect(screen.getByTitle("src/a.ts").className.split(" ")).toEqual(expect.arrayContaining(["opacity-60", "group-hover/file:opacity-100", "group-focus-within/file:opacity-100"]));
  expect(within(card).getByText("Viewed").className).not.toMatch(/opacity/);
});

// bug bash RDG-6: a binary, mode-only or empty file has no hunks, and its card showed nothing under its row.
test("a file with no hunks says what its diff does instead: binary, mode change, empty, or not sent by GitHub", () => {
  const bare = [
    "diff --git a/logo.png b/logo.png\nindex 1..2 100644\nBinary files a/logo.png and b/logo.png differ\n",
    "diff --git a/bin/run b/bin/run\nold mode 100644\nnew mode 100755\n",
    "diff --git a/.keep b/.keep\nnew file mode 100644\nindex 0000000..e69de29\n",
    "diff --git a/db/seed.sql b/db/seed.sql\nGitHub didn't send this file's diff: it's too large or binary. (blob abcdef1)\n",
    "diff --git a/src/old.ts b/src/new.ts\nsimilarity index 100%\nrename from src/old.ts\nrename to src/new.ts\n",
  ].join("");
  const { container } = render(<DiffViewer patch={bare + patch} files={["logo.png", "bin/run", ".keep", "db/seed.sql", "src/new.ts", "src/a.ts"]} views={new Map<string, FileViewFlags>()} onToggleViewed={() => {}} />);
  const card = (path: string) => within(Array.from(container.querySelectorAll<HTMLElement>("[data-file]")).find((el) => el.dataset.file === path)!);
  expect(card("logo.png").getByText("Binary file.")).toBeTruthy();
  expect(card("bin/run").getByText("Made executable.")).toBeTruthy();
  expect(card(".keep").getByText("New empty file.")).toBeTruthy();
  expect(card("db/seed.sql").getByText("GitHub didn't send this file's diff; read it on GitHub.")).toBeTruthy();
  // A pure rename's row names the old path once.
  expect(card("src/new.ts").getByText("No content changes.")).toBeTruthy();
  expect(card("src/new.ts").getAllByText(/Renamed from/)).toHaveLength(1);
  // A file with hunks shows them, not words.
  expect(card("src/a.ts").queryByText(/Binary file|No content changes|empty file/)).toBeNull();
});

// bug bash RDG-1 (Trojan Source, CVE-2021-42574): an added line holding bidirectional controls draws in an order other
// than the one it compiles in. This one shows as `if (role != "user") { // Check if admin`, but the comment is inside
// the string, so every role is granted. GitHub warns on such a file; the diff here drew it with no sign.
const bidiWarning = "Hidden bidirectional Unicode in this file can make code read differently than it runs.";
const trojan = 'if (role != "user\u202E \u2066// Check if admin\u2069 \u2066") { grant(); }';
const trojanPatch = `diff --git a/src/auth.ts b/src/auth.ts\n--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -1 +1 @@\n-if (role === "admin") { grant(); }\n+${trojan}\n`;
const fileCard = (container: HTMLElement, path: string) => within(Array.from(container.querySelectorAll<HTMLElement>("[data-file]")).find((el) => el.dataset.file === path)!);

test("a file whose diff adds bidirectional controls warns, in its details row, folded too", () => {
  const { container } = render(<DiffViewer patch={trojanPatch + patch} files={["src/auth.ts", "src/a.ts"]} views={new Map<string, FileViewFlags>()} onToggleViewed={() => {}} />);
  const warning = fileCard(container, "src/auth.ts").getByText(bidiWarning);
  expect(warning.className).toContain("text-warning-text");
  expect(warning.querySelector("svg")).not.toBeNull();
  expect(fileCard(container, "src/a.ts").queryByText(bidiWarning)).toBeNull();
  // Folded, the row stays, with the warning alone.
  fireEvent.click(screen.getByRole("button", { name: "Collapse src/auth.ts" }));
  expect(fileCard(container, "src/auth.ts").getByText(bidiWarning)).toBeTruthy();
});

test("a file whose path holds a bidirectional control warns", () => {
  const path = "src/\u202Ests.ts";
  const { container } = render(<DiffViewer patch={`diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-a\n+b\n`} files={[path]} views={new Map<string, FileViewFlags>()} onToggleViewed={() => {}} />);
  expect(fileCard(container, path).getByText(bidiWarning)).toBeTruthy();
});

// bug bash FUZ-3: with git's diff.suppressBlankEmpty a blank context line comes as "", which pierre skipped, so the
// lines after it drew one number short of where comments are saved.
test("a blank context line git wrote as \"\" is drawn, so the lines after it keep their numbers", () => {
  const blank = "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,4 +1,4 @@\n a\n\n-b\n+B\n c\n";
  render(<DiffViewer patch={blank} files={["f"]} views={new Map<string, FileViewFlags>()} onToggleViewed={() => {}} />);
  // a, the blank line, B and c.
  expect(screen.getByTestId("filediff").dataset.newLines).toBe("4");
});
