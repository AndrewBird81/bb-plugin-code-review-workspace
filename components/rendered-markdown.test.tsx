// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { useState, type MutableRefObject } from "react";
import { defaultPreferences } from "../src/preferences";
import { patchReviewState } from "../lib/panel-state";
import { panelTabCalls, renderPanelTab } from "./panel-tabs.test-support";
import { gitPatch } from "../lib/markdown-test-patch.test-support";
import type { MarkdownShow } from "./DiffViewer";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
// The source view: the lines pierre would put comments under.
vi.mock("@pierre/diffs/react", () => ({
  FileDiff: ({ lineAnnotations, renderAnnotation }: any) => (
    <div data-testid="filediff">
      {lineAnnotations?.map((annotation: any, index: number) => <div key={index} data-annotation={`${annotation.side}:${annotation.lineNumber}`}>{renderAnnotation?.(annotation)}</div>)}
    </div>
  ),
}));

// BB's Markdown, as far as its HTML goes: the content as HTML, so <del> and <ins> are elements; as a BB whose Markdown
// drops raw HTML (`strip`), without them; or, until `loadsAt`, as BB's draws it while its HTML loads, without them too.
// Each content it's given is kept, with when. Drawn again only for new content: React 19 sets innerHTML on every render.
// A table draws as BB's does, a thead and a tbody of rows, so the view can read its rows.
const markdown = vi.hoisted(() => ({
  strip: false as boolean | "del", loadsAt: 0, given: [] as { content: string; at: number }[], extraRow: false,
  tables: (content: string) => {
    if (!content.startsWith("|")) return content;
    const [head, , ...body] = content.split("\n").filter((line) => line.startsWith("|"));
    const cells = (line: string, tag: string) => line.split("|").slice(1, -1).map((cell) => `<${tag}>${cell.trim()}</${tag}>`).join("");
    return `<table><thead><tr>${cells(head, "th")}</tr></thead><tbody>${body.map((line) => `<tr>${cells(line, "td")}</tr>`).join("")}${markdown.extraRow ? "<tr><td>x</td></tr>" : ""}</tbody></table>`;
  },
}));
vi.mock("@get-bb/plugin-sdk/app", async (importOriginal) => {
  const { memo, useEffect, useState } = await import("react");
  return {
    ...await importOriginal<typeof import("@get-bb/plugin-sdk/app")>(),
    Markdown: memo(function Markdown({ content }: { content: string }) {
      const [loaded, setLoaded] = useState(() => Date.now() >= markdown.loadsAt);
      useEffect(() => { markdown.given.push({ content, at: Date.now() }); }, [content]);
      useEffect(() => {
        if (loaded) return;
        const wait = setTimeout(() => setLoaded(true), markdown.loadsAt - Date.now());
        return () => clearTimeout(wait);
      }, [loaded]);
      const html = markdown.strip === "del" ? content.replace(/<\/?del>/g, "") : markdown.strip || !loaded ? content.replace(/<\/?(?:del|ins)>/g, "") : content;
      return <div data-testid="bb-markdown" dangerouslySetInnerHTML={{ __html: markdown.tables(html) }} />;
    }),
  };
});

afterEach(async () => {
  cleanup(); sessionStorage.clear(); localStorage.clear(); vi.clearAllMocks(); Object.assign(markdown, { strip: false, loadsAt: 0, given: [], extraRow: false });
  (await import("./RenderedMarkdown")).resetMarksForTests();
});

const FILE = "docs/rfc.md";
const OLD = "# Tokens\n\nWe want short-lived tokens.\n\n## Lifetime\n\nTokens expire after 1 hour.\n\nRefresh tokens are never rotated.\n\n## Fields\n\nOne field.\n";
const NEW = "# Tokens\n\nWe want short-lived tokens.\n\n## Lifetime\n\nTokens expire after 15 minutes.\n\n## Fields\n\nOne field.\n";
const PATCH = gitPatch(FILE, OLD, NEW);
const draftOf = (comments: any[] = []) => ({ targetKey: "k", verdict: "COMMENT", body: "", comments });

async function renderDiff({ rpc = {}, contents = { ok: true, old: OLD, new: NEW } as any, patch = PATCH, markdownFiles = "source" as MarkdownShow, extra = {} as Record<string, unknown>, failures = [] as any[] } = {}) {
  await loadPluginApp(() => import("../app"));
  const { DraftTray } = await import("./draft-tray.test-support");
  const { DiffViewer } = await import("./DiffViewer");
  const { CheckFailuresContext } = await import("./CheckFailures");
  const readContents = vi.fn(async () => contents);
  const onLineSelected = vi.fn();
  const component = () => (
    <DraftTray targetKey="k" activeChapterId="c1" activeFiles={[FILE]} reviewRevision="r1" account="reviewer" patch={patch}>
      <CheckFailuresContext.Provider value={failures}>
        <DiffViewer patch={patch} files={[FILE]} views={new Map()} onToggleViewed={() => {}} readContents={readContents} markdownFiles={markdownFiles} onLineSelected={onLineSelected} {...extra} />
      </CheckFailuresContext.Provider>
    </DraftTray>
  );
  const slot = renderSlot({ component }, {}, { rpc: { setReviewPresence: () => ({ ok: true }), getReviewerNotes: () => ({ body: "", revision: 0 }), getDraft: () => ({ draft: draftOf(), stale: [], discussions: [] }), ...rpc } as any });
  await slot.findByText("Draft saved");
  const file = () => within(slot.container.querySelector<HTMLElement>(`[data-file="${FILE}"]`)!);
  return { slot, file, readContents, onLineSelected };
}
const switchTo = (file: () => ReturnType<typeof within>, value: "Source" | "Rendered") => fireEvent.click(within(file().getByRole("radiogroup", { name: `How ${FILE} shows` })).getByRole("radio", { name: value }));
const units = (root: HTMLElement) => Array.from(root.querySelectorAll<HTMLElement>("[data-md-index]"));

test("a Markdown file opens as its source; Rendered draws each block through BB's Markdown, with its change marked", async () => {
  const { slot, file, readContents } = await renderDiff();
  expect(file().getByTestId("filediff")).toBeTruthy();
  switchTo(file, "Rendered");
  await waitFor(() => expect(file().queryByTestId("filediff")).toBeNull());
  expect(readContents).toHaveBeenCalledWith(FILE);
  // Marked once BB's Markdown has drawn the probe's <ins>.
  await waitFor(() => expect(slot.container.querySelector("[data-md-words]")).toBeTruthy());
  const shown = units(slot.container).map((unit) => [unit.dataset.mdStatus, within(unit).getAllByTestId("bb-markdown").map((md) => md.innerHTML)]);
  expect(shown).toEqual([
    ["unchanged", ["# Tokens"]], ["unchanged", ["We want short-lived tokens."]], ["unchanged", ["## Lifetime"]],
    ["changed", ["Tokens expire after <del>1 hour</del><ins>15 minutes</ins>."]], ["removed", ["Refresh tokens are never rotated."]],
    ["unchanged", ["## Fields"]], ["unchanged", ["One field."]],
  ]);
  // Each bar's meaning is in words too.
  expect(within(units(slot.container)[4]).getByText("Removed, old line 9")).toBeTruthy();
  // Show previous puts the changed block's version before above it, as a removed block.
  fireEvent.click(within(units(slot.container)[3]).getByRole("button", { name: "Show previous" }));
  expect(within(units(slot.container)[3]).getAllByTestId("bb-markdown").map((md) => md.innerHTML)).toEqual(["Tokens expire after 1 hour.", "Tokens expire after <del>1 hour</del><ins>15 minutes</ins>."]);
  switchTo(file, "Source");
  expect(file().getByTestId("filediff")).toBeTruthy();
  slot.lifecycle.unmount();
});

test("a list's items show added, changed and removed on their own, a changed item's words marked", async () => {
  const old = "Steps:\n\n- Install the CLI.\n- Sign in with your token.\n- Clean up.\n";
  const now = "Steps:\n\n- Install the CLI.\n- Sign in with your SSO account.\n- Configure the project.\n";
  const { slot } = await renderDiff({ markdownFiles: "rendered", patch: gitPatch(FILE, old, now), contents: { ok: true, old, new: now } });
  await waitFor(() => expect(slot.container.querySelector("[data-md-words]")).toBeTruthy());
  expect(units(slot.container).map((unit) => [unit.dataset.mdStatus, within(unit).getByTestId("bb-markdown").innerHTML])).toEqual([
    ["unchanged", "Steps:"], ["unchanged", "- Install the CLI."], ["changed", "- Sign in with your <del>token</del><ins>SSO account</ins>."],
    ["removed", "- Clean up."], ["added", "- Configure the project."],
  ]);
  slot.lifecycle.unmount();
});

test("a BB whose Markdown drops raw HTML never draws marked words: changed blocks show whole, never old and new run together", async () => {
  markdown.strip = true;
  const { slot } = await renderDiff({ markdownFiles: "rendered" });
  await waitFor(() => expect(units(slot.container)).toHaveLength(7));
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(within(units(slot.container)[3]).getByTestId("bb-markdown").innerHTML).toBe("Tokens expire after 15 minutes.");
  expect(units(slot.container)[3].querySelector("[data-md-words]")).toBeNull();
  expect(within(units(slot.container)[3]).getByRole("button", { name: "Show previous" })).toBeTruthy();
  expect(markdown.given.filter(({ content }) => content.includes("<del>") && content !== "a<del>b</del><ins>c</ins>")).toEqual([]);
  slot.lifecycle.unmount();
});

test("once BB's Markdown has drawn marks, a file drawn after marks its words from the start, with no probe of its own", async () => {
  const first = await renderDiff({ markdownFiles: "rendered" });
  await waitFor(() => expect(first.slot.container.querySelector("[data-md-words]")).toBeTruthy());
  first.slot.lifecycle.unmount();
  markdown.given = [];
  const { slot } = await renderDiff({ markdownFiles: "rendered" });
  await waitFor(() => expect(units(slot.container)).toHaveLength(7));
  expect(markdown.given.map(({ content }) => content)).not.toContain("a<del>b</del><ins>c</ins>");
  expect(markdown.given.find(({ content }) => content.startsWith("Tokens expire after"))?.content).toBe("Tokens expire after <del>1 hour</del><ins>15 minutes</ins>.");
  slot.lifecycle.unmount();
});

test("a BB whose Markdown keeps <ins> but drops <del> draws no marked words either", async () => {
  markdown.strip = "del";
  const { slot } = await renderDiff({ markdownFiles: "rendered" });
  await waitFor(() => expect(units(slot.container)).toHaveLength(7));
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(units(slot.container)[3].querySelector("[data-md-words]")).toBeNull();
  slot.lifecycle.unmount();
});

// BB's Markdown draws content without its HTML while that loads, the first time: marked words would read run together.
test("words are marked once BB's Markdown has drawn HTML, however long that takes, and never before", async () => {
  markdown.loadsAt = Date.now() + 2500;
  const { slot } = await renderDiff({ markdownFiles: "rendered" });
  await waitFor(() => expect(units(slot.container)).toHaveLength(7));
  expect(within(units(slot.container)[3]).getByTestId("bb-markdown").innerHTML).toBe("Tokens expire after 15 minutes.");
  await waitFor(() => expect(within(units(slot.container)[3]).getByTestId("bb-markdown").innerHTML).toBe("Tokens expire after <del>1 hour</del><ins>15 minutes</ins>."), { timeout: 5000 });
  const marked = markdown.given.filter(({ content }) => content.includes("<del>") && content !== "a<del>b</del><ins>c</ins>");
  expect(marked.length).toBeGreaterThan(0);
  expect(marked.every(({ at }) => at >= markdown.loadsAt)).toBe(true);
  slot.lifecycle.unmount();
});

test("Show previous is a button the keyboard reaches, that says it opens the version before and, open, closes it", async () => {
  const { slot } = await renderDiff({ markdownFiles: "rendered" });
  await waitFor(() => expect(units(slot.container)).toHaveLength(7));
  const toggle = within(units(slot.container)[3]).getByRole("button", { name: "Show previous" });
  toggle.focus();
  expect(document.activeElement).toBe(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(toggle);
  const open = within(units(slot.container)[3]).getByRole("button", { name: "Hide previous" });
  expect(open.getAttribute("aria-expanded")).toBe("true");
  expect(within(units(slot.container)[3]).getAllByTestId("bb-markdown")).toHaveLength(2);
  fireEvent.click(open);
  expect(within(units(slot.container)[3]).getAllByTestId("bb-markdown")).toHaveLength(1);
  slot.lifecycle.unmount();
});

test("Diff options' Rendered opens a Markdown file rendered, and m switches it back", async () => {
  const renderToggle: MutableRefObject<((file: string) => boolean) | null> = { current: null };
  const { slot, file } = await renderDiff({ markdownFiles: "rendered", extra: { renderToggle } });
  await waitFor(() => expect(units(slot.container)).toHaveLength(7));
  expect(renderToggle.current?.("src/other.ts")).toBe(false);
  expect(renderToggle.current?.(FILE)).toBe(true);
  await file().findByTestId("filediff");
  slot.lifecycle.unmount();
});

test("comments and CI failures show after the block holding their line, and + opens the box on a block's lines", async () => {
  let draft = draftOf([{ file: FILE, line: 7, side: "RIGHT", body: "Why 15?", author: "reviewer" }]);
  const saveDraftComment = vi.fn(async ({ comment }: any) => { draft = draftOf([...draft.comments, comment]); return { draft, stale: [], discussions: [] }; });
  const failure = { file: FILE, line: 5, check: "markdownlint", title: null, message: "MD001 heading levels", url: "https://ci.example/1" };
  const { slot, file } = await renderDiff({ markdownFiles: "rendered", failures: [failure], rpc: { getDraft: () => ({ draft, stale: [], discussions: [] }), saveDraftComment } });
  await waitFor(() => expect(units(slot.container)).toHaveLength(7));
  const [, , heading, changed, removed] = units(slot.container);
  expect(within(changed).getByRole("article", { name: `Draft comment on ${FILE}:7` })).toBeTruthy();
  expect(within(heading).getByRole("note", { name: `CI failure on ${FILE}:5` })).toBeTruthy();
  fireEvent.click(within(removed).getByRole("button", { name: "Comment on line 9 (old)" }));
  const box = await within(removed).findByRole("textbox", { name: "Draft comment" });
  fireEvent.change(box, { target: { value: "Mobile clients rely on this." } });
  fireEvent.click(within(removed).getByRole("button", { name: "Add to draft" }));
  await waitFor(() => expect(saveDraftComment).toHaveBeenCalledWith(expect.objectContaining({ comment: { file: FILE, line: 9, side: "LEFT", chapterId: "c1", body: "Mobile clients rely on this." } })));
  await within(units(slot.container)[4]).findByRole("article", { name: `Draft comment on ${FILE}:9` });
  // The same comment, in the source, is under its line.
  switchTo(file, "Source");
  const under = await waitFor(() => file().getByRole("article", { name: `Draft comment on ${FILE}:9` }));
  expect(under.closest("[data-annotation]")?.getAttribute("data-annotation")).toBe("deletions:9");
  slot.lifecycle.unmount();
});

test("a block's + takes the lines of it that are in the diff, in one hunk", async () => {
  const old = "Para one\nline two\nline three\n\nTail.\n";
  const now = "Para one\nline 2\nline three\n\nTail.\n";
  const saveDraftComment = vi.fn(async ({ comment }: any) => ({ draft: draftOf([comment]), stale: [], discussions: [] }));
  const { slot } = await renderDiff({ markdownFiles: "rendered", patch: gitPatch(FILE, old, now, 1), contents: { ok: true, old, new: now }, rpc: { saveDraftComment } });
  await waitFor(() => expect(units(slot.container)).toHaveLength(2));
  fireEvent.click(within(units(slot.container)[0]).getByRole("button", { name: "Comment on lines 1–3" }));
  fireEvent.change(await slot.findByRole("textbox", { name: "Draft comment" }), { target: { value: "Spell it out." } });
  fireEvent.click(slot.getByRole("button", { name: "Add to draft" }));
  await waitFor(() => expect(saveDraftComment).toHaveBeenCalledWith(expect.objectContaining({ comment: expect.objectContaining({ line: 3, side: "RIGHT", startLine: 1 }) })));
  // A block the diff doesn't show takes no comment.
  expect(within(units(slot.container)[1]).queryByRole("button", { name: /^Comment on/ })).toBeNull();
  slot.lifecycle.unmount();
});

test("a file whose contents don't load stays as its source, Rendered off with the reason", async () => {
  const { slot, file } = await renderDiff({ markdownFiles: "rendered", contents: { ok: false, error: "The file is over 2 MB, so only the diff shows." } });
  await file().findByText("The file is over 2 MB, so only the diff shows.", { selector: "p" });
  const rendered = within(file().getByRole("radiogroup", { name: `How ${FILE} shows` })).getByRole("radio", { name: "Rendered" });
  expect(rendered.getAttribute("aria-disabled")).toBe("true");
  expect(document.getElementById(rendered.getAttribute("aria-describedby")!)?.textContent).toBe("The file is over 2 MB, so only the diff shows.");
  expect(file().getByTestId("filediff")).toBeTruthy();
  slot.lifecycle.unmount();
});

test("a file split across chapters shows as its source, and says why it can't render", async () => {
  const { slot, file, readContents } = await renderDiff({ markdownFiles: "rendered", extra: { splitFiles: new Map([[FILE, { hunks: [1], alsoIn: ["Other"] }]]) } });
  const rendered = within(file().getByRole("radiogroup", { name: `How ${FILE} shows` })).getByRole("radio", { name: "Rendered" });
  expect(rendered.getAttribute("aria-disabled")).toBe("true");
  expect(document.getElementById(rendered.getAttribute("aria-describedby")!)?.textContent).toMatch(/split across chapters/);
  expect(readContents).not.toHaveBeenCalled();
  slot.lifecycle.unmount();
});

test("three or more removed blocks in a row show the first, and fold the rest", async () => {
  const old = "Kept intro.\n\nGone one.\n\nGone two.\n\nGone three.\n\nGone four.\n\nKept end.\n";
  const now = "Kept intro.\n\nKept end.\n";
  const { slot } = await renderDiff({ markdownFiles: "rendered", patch: gitPatch(FILE, old, now), contents: { ok: true, old, new: now } });
  const fold = await slot.findByRole("button", { name: "Show 3 more removed sections" });
  expect(units(slot.container).map((unit) => [unit.dataset.mdStatus, within(unit).getByTestId("bb-markdown").innerHTML])).toEqual([
    ["unchanged", "Kept intro."], ["removed", "Gone one."], ["unchanged", "Kept end."],
  ]);
  fireEvent.click(fold);
  expect(units(slot.container).map((unit) => unit.dataset.mdStatus)).toEqual(["unchanged", "removed", "removed", "removed", "removed", "unchanged"]);
  slot.lifecycle.unmount();
});

test("a long run of unchanged blocks folds, but for the one beside the change", async () => {
  const old = `${Array.from({ length: 10 }, (_, i) => `Paragraph ${i} says something.`).join("\n\n")}\n\nThe end is here.\n`;
  const now = old.replace("end is here", "end is near");
  const { slot } = await renderDiff({ markdownFiles: "rendered", patch: gitPatch(FILE, old, now), contents: { ok: true, old, new: now } });
  const fold = await slot.findByRole("button", { name: "9 unchanged sections · Show" });
  expect(units(slot.container).map((unit) => unit.dataset.mdStatus)).toEqual(["unchanged", "changed"]);
  fireEvent.click(fold);
  expect(units(slot.container)).toHaveLength(11);
  slot.lifecycle.unmount();
});

test("an outdated thread shows in the file's fold, as in the source", async () => {
  const { DiffThreadsContext } = await import("./LineThreads");
  const thread = { id: "t1", path: FILE, line: null, originalLine: 3, side: "RIGHT", isOutdated: true, isResolved: false, subjectType: "LINE", comments: [] };
  const { DiffViewer } = await import("./DiffViewer");
  await loadPluginApp(() => import("../app"));
  const { DraftTray } = await import("./draft-tray.test-support");
  const component = () => (
    <DraftTray targetKey="k" activeChapterId="c1" activeFiles={[FILE]} reviewRevision="r1" account="reviewer" patch={PATCH}>
      <DiffThreadsContext.Provider value={{ targetKey: "k", threads: [thread as any] }}>
        <DiffViewer patch={PATCH} files={[FILE]} views={new Map()} onToggleViewed={() => {}} readContents={async () => ({ ok: true, old: OLD, new: NEW })} markdownFiles="rendered" />
      </DiffThreadsContext.Provider>
    </DraftTray>
  );
  const again = renderSlot({ component }, {}, { rpc: { setReviewPresence: () => ({ ok: true }), getReviewerNotes: () => ({ body: "", revision: 0 }), getDraft: () => ({ draft: draftOf(), stale: [], discussions: [] }) } as any });
  await waitFor(() => expect(units(again.container)).toHaveLength(7));
  expect(again.getByRole("button", { name: "Outdated (1)" })).toBeTruthy();
  again.lifecycle.unmount();
});

function select(from: Node, to: Node) {
  const range = document.createRange();
  range.setStart(from, 0);
  range.setEnd(to, to.textContent!.length);
  document.getSelection()!.removeAllRanges();
  document.getSelection()!.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
}

test("text selected across blocks picks their lines in one hunk; in blocks the diff doesn't show, it offers to ask the agent", async () => {
  const old = `Intro paragraph.\n\n${Array.from({ length: 4 }, (_, i) => `Filler ${i}.`).join("\n\n")}\n\nTokens expire after 1 hour.\n\nClosing words.\n`;
  const now = old.replace("1 hour", "15 minutes");
  const { slot, onLineSelected } = await renderDiff({ markdownFiles: "rendered", patch: gitPatch(FILE, old, now, 1), contents: { ok: true, old, new: now } });
  await waitFor(() => expect(units(slot.container)).toHaveLength(7));
  const text = (index: number) => within(units(slot.container)[index]).getByTestId("bb-markdown").firstChild!;
  select(text(4), text(5));
  await waitFor(() => expect(onLineSelected).toHaveBeenLastCalledWith(FILE, { start: 10, end: 11, side: "additions" }, undefined));
  select(text(0), text(1));
  await waitFor(() => expect(onLineSelected).toHaveBeenLastCalledWith(FILE, { start: 1, end: 3, side: "additions" }, { code: "Intro paragraph.\n\nFiller 0." }));
  slot.lifecycle.unmount();
});

test("text selected in a changed block's version before picks its old lines", async () => {
  const { slot, onLineSelected } = await renderDiff({ markdownFiles: "rendered" });
  await waitFor(() => expect(units(slot.container)).toHaveLength(7));
  fireEvent.click(within(units(slot.container)[3]).getByRole("button", { name: "Show previous" }));
  const ghost = within(units(slot.container)[3]).getAllByTestId("bb-markdown")[0].firstChild!;
  expect(ghost.textContent).toBe("Tokens expire after 1 hour.");
  select(ghost, ghost);
  await waitFor(() => expect(onLineSelected).toHaveBeenLastCalledWith(FILE, { start: 7, end: 7, side: "deletions" }, undefined));
  slot.lifecycle.unmount();
});

test("the same text selected again, after its lines were cleared, picks them again", async () => {
  await loadPluginApp(() => import("../app"));
  const { DraftTray } = await import("./draft-tray.test-support");
  const { DiffViewer } = await import("./DiffViewer");
  const picked = vi.fn();
  function Picking() {
    const [lines, setLines] = useState<any>(null);
    return <>
      <button type="button" onClick={() => setLines(null)}>Clear selection</button>
      <DiffViewer patch={PATCH} files={[FILE]} views={new Map()} onToggleViewed={() => {}} readContents={async () => ({ ok: true, old: OLD, new: NEW })} markdownFiles="rendered"
        selectedLines={lines} onLineSelected={(file, range) => { picked(range); setLines(range ? { file, range } : null); }} />
    </>;
  }
  const component = () => <DraftTray targetKey="k" activeChapterId="c1" activeFiles={[FILE]} reviewRevision="r1" account="reviewer" patch={PATCH}><Picking /></DraftTray>;
  const slot = renderSlot({ component }, {}, { rpc: { setReviewPresence: () => ({ ok: true }), getReviewerNotes: () => ({ body: "", revision: 0 }), getDraft: () => ({ draft: draftOf(), stale: [], discussions: [] }) } as any });
  await waitFor(() => expect(units(slot.container)).toHaveLength(7));
  const text = within(units(slot.container)[3]).getByTestId("bb-markdown").firstChild!;
  select(text, text);
  await waitFor(() => expect(picked).toHaveBeenCalledTimes(1));
  fireEvent.click(slot.getByRole("button", { name: "Clear selection" }));
  select(text, text);
  await waitFor(() => expect(picked).toHaveBeenCalledTimes(2));
  expect(picked).toHaveBeenLastCalledWith({ start: 7, end: 7, side: "additions" });
  slot.lifecycle.unmount();
});

test("text selected in part of a paragraph picks only the lines it's on", async () => {
  const old = "An intro to the rule.\n\nFirst line of the rule,\nsecond line of the rule,\nthird line of the rule.\n";
  const now = old.replace("An intro", "A short intro");
  const { slot, onLineSelected } = await renderDiff({ markdownFiles: "rendered", patch: gitPatch(FILE, old, now), contents: { ok: true, old, new: now } });
  await waitFor(() => expect(units(slot.container)).toHaveLength(2));
  const text = within(units(slot.container)[1]).getByTestId("bb-markdown").firstChild!;
  const range = document.createRange();
  const at = text.textContent!.indexOf("second");
  range.setStart(text, at);
  range.setEnd(text, at + "second line".length);
  document.getSelection()!.removeAllRanges();
  document.getSelection()!.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
  await waitFor(() => expect(onLineSelected).toHaveBeenLastCalledWith(FILE, { start: 4, end: 4, side: "additions" }, undefined));
  slot.lifecycle.unmount();
});

test("a changed table tints its new and changed rows, and each row it shows takes a comment of its own", async () => {
  const old = "| Field | Type |\n|---|---|\n| exp | int |\n| iat | int |\n";
  const now = "| Field | Type |\n|---|---|\n| exp | int |\n| iat | long |\n| nbf | int |\n";
  let draft = draftOf();
  const saveDraftComment = vi.fn(async ({ comment }: any) => { draft = draftOf([comment]); return { draft, stale: [], discussions: [] }; });
  const { slot } = await renderDiff({ markdownFiles: "rendered", patch: gitPatch(FILE, old, now, 0), contents: { ok: true, old, new: now }, rpc: { getDraft: () => ({ draft, stale: [], discussions: [] }), saveDraftComment } });
  await waitFor(() => expect(units(slot.container)).toHaveLength(1));
  const table = units(slot.container)[0];
  const scope = table.querySelector<HTMLElement>("[data-md-rows]")!.dataset.mdRows;
  expect(table.querySelector("style")!.textContent).toBe([
    `[data-md-rows="${scope}"] tbody tr:nth-child(2) { background-color: color-mix(in oklab, var(--warning) 10%, transparent); }`,
    `[data-md-rows="${scope}"] tbody tr:nth-child(2) > :first-child { box-shadow: inset 2px 0 var(--warning); }`,
    `[data-md-rows="${scope}"] tbody tr:nth-child(3) { background-color: color-mix(in oklab, var(--diff-added) 12%, transparent); }`,
    `[data-md-rows="${scope}"] tbody tr:nth-child(3) > :first-child { box-shadow: inset 2px 0 var(--diff-added); }`,
  ].join("\n"));
  // With no context in the diff, only its changed rows take one.
  const buttons = within(table).getAllByRole("button", { name: /^Comment on/ });
  expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual(["Comment on table row 2 (line 4)", "Comment on table row 3 (line 5)"]);
  // One stop for the keyboard, the arrow keys moving between rows.
  expect(buttons.map((button) => button.tabIndex)).toEqual([0, -1]);
  buttons[0].focus();
  fireEvent.keyDown(buttons[0], { key: "ArrowDown" });
  expect(document.activeElement).toBe(buttons[1]);
  expect(buttons.map((button) => button.tabIndex)).toEqual([-1, 0]);
  fireEvent.click(within(table).getByRole("button", { name: "Comment on table row 3 (line 5)" }));
  fireEvent.change(await slot.findByRole("textbox", { name: "Draft comment" }), { target: { value: "Why nbf?" } });
  fireEvent.click(slot.getByRole("button", { name: "Add to draft" }));
  await waitFor(() => expect(saveDraftComment).toHaveBeenCalledWith(expect.objectContaining({ comment: expect.objectContaining({ line: 5, side: "RIGHT" }) })));
  slot.lifecycle.unmount();
});

test("a changed block says which of its links now go elsewhere", async () => {
  const old = "Get more info about [Keyboard Shortcuts editor](/docs/getstarted/keybindings.md).\n";
  const now = "Get more info about [Keyboard Shortcuts editor](/docs/editor/keybindings.md).\n";
  const { slot } = await renderDiff({ markdownFiles: "rendered", patch: gitPatch(FILE, old, now), contents: { ok: true, old, new: now } });
  await waitFor(() => expect(units(slot.container)).toHaveLength(1));
  const said = within(units(slot.container)[0]).getByRole("note", { name: "Link changed" });
  expect(said.textContent).toBe("Link changed: Keyboard Shortcuts editor/docs/getstarted/keybindings.md to /docs/editor/keybindings.md");
  slot.lifecycle.unmount();
});

test("text selected into a block's Link changed note, or to its row's edge, picks the block's lines", async () => {
  const old = "Intro.\n\nGet more info about [Keyboard Shortcuts editor](/docs/getstarted/keybindings.md).\n";
  const now = "Intro.\n\nGet more info about [Keyboard Shortcuts editor](/docs/editor/keybindings.md).\n";
  const { slot, onLineSelected } = await renderDiff({ markdownFiles: "rendered", patch: gitPatch(FILE, old, now), contents: { ok: true, old, new: now } });
  await waitFor(() => expect(units(slot.container)).toHaveLength(2));
  const unit = units(slot.container)[1];
  const text = within(unit).getByTestId("bb-markdown").firstChild!;
  const note = document.createTreeWalker(within(unit).getByRole("note", { name: "Link changed" }), NodeFilter.SHOW_TEXT).nextNode()!;
  select(text, note);
  await waitFor(() => expect(onLineSelected).toHaveBeenLastCalledWith(FILE, { start: 3, end: 3, side: "additions" }, undefined));
  document.getSelection()!.collapse(text, 0);
  document.dispatchEvent(new Event("selectionchange"));
  await waitFor(() => expect(onLineSelected).toHaveBeenLastCalledWith(FILE, null));
  // As a triple-click's selection can end: after the row's last child.
  const range = document.createRange();
  range.setStart(text, 0);
  range.setEnd(unit, unit.childNodes.length);
  document.getSelection()!.removeAllRanges();
  document.getSelection()!.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
  await waitFor(() => expect(onLineSelected).toHaveBeenLastCalledWith(FILE, { start: 3, end: 3, side: "additions" }, undefined));
  slot.lifecycle.unmount();
});

test("a PR's relative links go to their files at its head on GitHub, in marked words too", async () => {
  const old = "See [the setup](../setup.md) first.\n\n![chart](img/a.png)\n";
  const now = "See [the setup](../setup.md) now.\n\n![chart](img/a.png)\n";
  const { slot } = await renderDiff({ markdownFiles: "rendered", patch: gitPatch(FILE, old, now), contents: { ok: true, old, new: now }, extra: { linkRoot: "https://github.com/acme/web/blob/abc/" } });
  await waitFor(() => expect(slot.container.querySelector("[data-md-words]")).toBeTruthy());
  expect(units(slot.container).map((unit) => within(unit).getByTestId("bb-markdown").innerHTML)).toEqual([
    "See [the setup](https://github.com/acme/web/blob/abc/setup.md) <del>first</del><ins>now</ins>.",
    "[Image: chart](https://github.com/acme/web/blob/abc/docs/img/a.png)",
  ]);
  slot.lifecycle.unmount();
});

test("a file's own HTML links stay links, an image's to it, relative ones to the PR's head; in a local review those are words", async () => {
  const old = '<p align="center">\n  <a href="https://acme.dev" target="_blank"><img src="logo.svg" alt="Acme"></a>\n</p>\n\nSee <a href="setup.md" onclick="x()">setup</a> and <a href="javascript:alert(1)">this</a> first.\n';
  const now = old.replace("first", "now");
  const links = (root: HTMLElement) => Array.from(root.querySelectorAll("[data-md-rendered] a")).map((a) => [a.textContent, ...Array.from(a.attributes).map((at) => `${at.name}=${at.value}`)]);
  const pr = await renderDiff({ markdownFiles: "rendered", patch: gitPatch(FILE, old, now), contents: { ok: true, old, new: now }, extra: { linkRoot: "https://github.com/acme/web/blob/abc/" } });
  await waitFor(() => expect(pr.slot.container.querySelector("[data-md-words]")).toBeTruthy());
  expect(links(pr.slot.container)).toEqual([["Image: Acme", "href=https://acme.dev/"], ["setup", "href=https://github.com/acme/web/blob/abc/docs/setup.md"], ["this"]]);
  pr.slot.lifecycle.unmount();
  const local = await renderDiff({ markdownFiles: "rendered", patch: gitPatch(FILE, old, now), contents: { ok: true, old, new: now } });
  await waitFor(() => expect(local.slot.container.querySelector("[data-md-words]")).toBeTruthy());
  expect(links(local.slot.container)).toEqual([["Image: Acme", "href=https://acme.dev/"], ["setup"], ["this"]]);
  local.slot.lifecycle.unmount();
});

test("a table drawn with other rows than its source has tints none, and takes one comment for the whole table", async () => {
  markdown.extraRow = true;
  const old = "| Field | Type |\n|---|---|\n| exp | int |\n| iat | int |\n";
  const now = "| Field | Type |\n|---|---|\n| exp | int |\n| iat | long |\n| nbf | int |\n";
  const { slot } = await renderDiff({ markdownFiles: "rendered", patch: gitPatch(FILE, old, now, 0), contents: { ok: true, old, new: now } });
  await waitFor(() => expect(units(slot.container)).toHaveLength(1));
  expect(units(slot.container)[0].querySelector("style")).toBeNull();
  expect(within(units(slot.container)[0]).getAllByRole("button", { name: /^Comment on/ }).map((button) => button.getAttribute("aria-label"))).toEqual(["Comment on lines 4–5"]);
  slot.lifecycle.unmount();
});

test("a new Markdown file shown rendered offers no Show as diff, which it wouldn't show", async () => {
  const now = "# New doc\n\nIts words.\n";
  const onNewFiles = vi.fn();
  const { slot, file } = await renderDiff({ markdownFiles: "rendered", patch: gitPatch(FILE, null, now), contents: { ok: true, old: null, new: now }, extra: { onNewFiles } });
  await waitFor(() => expect(units(slot.container)).toHaveLength(2));
  expect(file().queryByRole("button", { name: "Show as diff" })).toBeNull();
  switchTo(file, "Source");
  expect(file().getByRole("button", { name: "Show as diff" })).toBeTruthy();
  slot.lifecycle.unmount();
});

test("a paragraph split in two shows each half with the paragraph it was, its words unmarked", async () => {
  const old = "Tokens expire quickly,\nso a stolen one is useless soon.\n";
  const now = "Tokens expire quickly,\n\nso a stolen one is useless soon.\n";
  const { slot } = await renderDiff({ markdownFiles: "rendered", patch: gitPatch(FILE, old, now), contents: { ok: true, old, new: now } });
  await waitFor(() => expect(units(slot.container)).toHaveLength(2));
  for (const unit of units(slot.container)) {
    expect(unit.querySelector("[data-md-words]")).toBeNull();
    fireEvent.click(within(unit).getByRole("button", { name: "Show previous" }));
    expect(within(unit).getAllByTestId("bb-markdown")[0].innerHTML).toBe("Tokens expire quickly,\nso a stolen one is useless soon.");
  }
  slot.lifecycle.unmount();
});

test("lines that take no comment offer Ask agent alone, which asks about their source", async () => {
  patchReviewState("pr-42", { activeId: "c1" });
  const old = `Intro paragraph.\n\n${Array.from({ length: 4 }, (_, i) => `Filler ${i}.`).join("\n\n")}\n\nTokens expire after 1 hour.\n`;
  const now = old.replace("1 hour", "15 minutes");
  const app = await loadPluginApp(() => import("../app"));
  const guide = { title: "Guide", intent: "Docs.", unplacedFiles: [] as string[], sections: [{ id: "c1", title: "Docs", overview: "Docs.", diffs: [{ file: FILE, summary: "RFC." }] }] };
  const rpc = {
    setReviewPresence: () => ({ ok: true }),
    getReviewBundle: () => ({ review: { targetKey: "pr-42", kind: "pr", status: "ready", createdAt: 1, title: "Docs", headSha: "new" }, guide, patch: gitPatch(FILE, old, now, 1), revision: "r1" }),
    getChecks: () => ({ bucket: "none", checks: [] }),
    getPreferences: () => ({ preferences: { ...defaultPreferences, markdownFiles: "rendered" }, revision: 0 }),
    getFileViews: () => ({ views: [] }),
    checkRepoAccess: () => ({ accessible: true, repo: "acme/web", account: "me" }),
    checkForUpdates: () => ({ hasNewCommits: false }),
    getDraft: () => ({ draft: { targetKey: "pr-42", verdict: "COMMENT", body: "", comments: [] }, stale: [] }),
    getReviewerNotes: () => ({ body: "", revision: 0 }),
    getConversation: () => ({ threadId: null, legacy: [], defaults: { providerId: "codex", model: "gpt-6-astra", reasoningLevel: "low", serviceTier: "default" } }),
    startConversation: vi.fn(async (_input: { text: string }) => ({ threadId: "th-1" })),
    markSeen: () => ({ ok: true }),
    getFileContents: () => ({ ok: true, old, new: now }),
  };
  const slot = renderSlot(app.navPanels[0]!, { subPath: "pr-42" }, { rpc: rpc as any });
  await slot.findByRole("main", { name: /^Review\b/ });
  await waitFor(() => expect(units(slot.container)).toHaveLength(6));
  select(within(units(slot.container)[0]).getByTestId("bb-markdown").firstChild!, within(units(slot.container)[0]).getByTestId("bb-markdown").firstChild!);
  const bar = within(await slot.findByRole("group", { name: "Selection" }));
  await bar.findByText("GitHub only takes comments on changed sections");
  expect(bar.queryByRole("button", { name: "Comment" })).toBeNull();
  expect(bar.getByText("L1")).toBeTruthy();
  fireEvent.click(bar.getByRole("button", { name: "Ask agent" }));
  // BB's side panel opens on the Review agent tab, with the lines as the question's context.
  expect(panelTabCalls(slot)).toEqual(["openTab:agent"]);
  const tab = renderPanelTab(app, "agent", "pr-42", { rpc: rpc as any });
  await tab.findByText("rfc.md:1");
  // The lines aren't in the diff, so the question quotes their source.
  const box = await tab.findByRole("textbox", { name: "Ask the agent" });
  fireEvent.change(box, { target: { value: "Why this?" } });
  fireEvent.keyDown(box, { key: "Enter" });
  fireEvent.keyDown(box, { key: "Enter" });
  await waitFor(() => expect(rpc.startConversation).toHaveBeenCalled());
  expect(rpc.startConversation.mock.calls[0][0].text).toBe("Why this?\n\nIn `docs/rfc.md` line 1:\n```\nIntro paragraph.\n```");
  tab.lifecycle.unmount();
  slot.lifecycle.unmount();
});
