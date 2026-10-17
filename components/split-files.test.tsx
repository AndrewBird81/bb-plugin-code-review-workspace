// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { toast } from "sonner";
import type { ReactNode } from "react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { defaultPreferences } from "../src/preferences";
import { render } from "@testing-library/react";
import { interdiff } from "../src/interdiff";
import { DiffViewer } from "./DiffViewer";
import { getReviewState, patchReviewState } from "../lib/panel-state";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
// Each diff's new lines, and the lines it has comments under.
vi.mock("@pierre/diffs/react", () => ({
  FileDiff: ({ fileDiff, lineAnnotations }: any) => (
    <div data-testid="filediff">
      <pre>{fileDiff.additionLines.join("\n")}</pre>
      {(lineAnnotations ?? []).map((a: any) => <span key={a.lineNumber}>{`comment on ${a.lineNumber}`}</span>)}
    </div>
  ),
}));

afterEach(() => { cleanup(); localStorage.clear(); sessionStorage.clear(); vi.clearAllMocks(); });

// src/a.ts mixes two changes: its first hunk parses, its second caches.
const patch = [
  "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n",
  "@@ -1,2 +1,2 @@\n-parse\n+PARSE\n keep\n",
  "@@ -20,2 +20,2 @@\n-cache\n+CACHE\n keep\n",
  "diff --git a/src/b.ts b/src/b.ts\n--- a/src/b.ts\n+++ b/src/b.ts\n@@ -1 +1 @@\n-b\n+bb\n",
].join("");
const guide = {
  title: "Guide", intent: "Parses and caches rows.", unplacedFiles: [] as string[],
  hotspots: [{ file: "src/a.ts", line: 20, why: "The cache never expires." }],
  sections: [
    { id: "c1", title: "Parsing", overview: "Reads rows.", diffs: [{ file: "src/a.ts", summary: "Parses a row.", hunks: [1] }, { file: "src/b.ts", summary: "Uses it." }] },
    { id: "c2", title: "Caching", overview: "Keeps rows.", diffs: [{ file: "src/a.ts", summary: "Caches a row.", hunks: [2] }] },
  ],
};

async function renderWorkspace({ bundle = {}, review = {}, rpc = {} }: { bundle?: Record<string, unknown>; review?: Record<string, unknown>; rpc?: Record<string, unknown> } = {}) {
  // Opened before, on its first chapter: a first open shows the Overview.
  if (!getReviewState("pr-42").activeId) patchReviewState("pr-42", { activeId: "c1" });
  const app = await loadPluginApp(() => import("../app"));
  const handlers = {
    setReviewPresence: () => ({ ok: true }),
    getReviewBundle: vi.fn(() => ({ review: { targetKey: "pr-42", kind: "pr", status: "ready", createdAt: 1, title: "Parse rows", headSha: "new", ...review }, guide: structuredClone(guide), patch, revision: "r1", ...bundle })),
    getChecks: () => ({ bucket: "none", checks: [] }),
    getPreferences: () => ({ preferences: defaultPreferences, revision: 0 }),
    getFileViews: vi.fn(() => ({ views: [] })),
    setFileViewed: vi.fn(() => ({ ok: true })),
    setFilesViewed: vi.fn(() => ({ ok: true })),
    checkRepoAccess: () => ({ accessible: true, repo: "acme/web", account: "me" }),
    checkForUpdates: () => ({ hasNewCommits: false }),
    getDraft: vi.fn(() => ({ draft: { targetKey: "pr-42", verdict: "COMMENT", body: "", comments: [
      { file: "src/a.ts", line: 1, side: "RIGHT", body: "Parse it once." },
      { file: "src/a.ts", line: 20, side: "RIGHT", body: "Expire it." },
    ] } })),
    getReviewerNotes: () => ({ body: "", revision: 0 }),
    getConversation: () => ({ threadId: null, legacy: [], defaults: null }),
    markSeen: vi.fn(() => ({ ok: true })),
    ...rpc,
  };
  const slot = renderSlot(app.navPanels[0]!, { subPath: "pr-42" }, { rpc: handlers as any });
  await slot.findByRole("main", { name: "Review" });
  return slot;
}

const card = (slot: Awaited<ReturnType<typeof renderWorkspace>>) => within(slot.container.querySelector<HTMLElement>('[data-file="src/a.ts"]')!);

test("a file split across two chapters shows each chapter only its hunks and comments, noting the other chapter", async () => {
  const slot = await renderWorkspace();
  await slot.findByText(/PARSE/);
  expect(card(slot).queryByText(/CACHE/)).toBeNull();
  expect(card(slot).getByText("Parses a row.")).toBeTruthy();
  expect(card(slot).getByText(/Also in/).textContent).toBe("Also in Caching");
  await waitFor(() => expect(card(slot).getByText("comment on 1")).toBeTruthy());
  expect(card(slot).queryByText("comment on 20")).toBeNull();
  // The chapter's end counts the comments in its hunks only.
  expect(within(slot.getByRole("main")).getByText("1 comment")).toBeTruthy();
  // Viewed stays per file: two files, not three.
  expect(within(slot.getByRole("navigation", { name: "Chapters" })).getByText("0/2 files viewed")).toBeTruthy();

  fireEvent.click(within(slot.getByRole("navigation", { name: "Chapters" })).getByText("Caching"));
  await slot.findByText(/CACHE/);
  expect(card(slot).queryByText(/PARSE/)).toBeNull();
  expect(card(slot).getByText("Caches a row.")).toBeTruthy();
  expect(card(slot).getByText(/Also in/).textContent).toBe("Also in Parsing");
  expect(card(slot).getByText("comment on 20")).toBeTruthy();
  expect(card(slot).queryByText("comment on 1")).toBeNull();
  expect(within(slot.getByRole("main")).getByText("1 comment")).toBeTruthy();
  slot.lifecycle.unmount();
});

test("opening a line of a split file goes to the chapter holding its hunk", async () => {
  patchReviewState("pr-42", { activeId: "overview" });
  const slot = await renderWorkspace();
  fireEvent.click(within(await slot.findByRole("region", { name: "Start here" })).getByRole("button", { name: "src/a.ts:20" }));
  await slot.findByText(/CACHE/);
  expect(slot.queryByText(/PARSE/)).toBeNull();
  slot.lifecycle.unmount();
});

test("a guide whose hunks don't fit the diff shows the file whole, in its first chapter", async () => {
  const stale = { ...guide, sections: [guide.sections[0], { ...guide.sections[1], diffs: [{ file: "src/a.ts", summary: "Caches a row.", hunks: [3] }] }] };
  const slot = await renderWorkspace({ bundle: { guide: stale } });
  await slot.findByText(/PARSE/);
  expect(card(slot).getByText(/CACHE/)).toBeTruthy();
  expect(card(slot).queryByText(/Also in/)).toBeNull();
  expect(within(slot.getByRole("navigation", { name: "Chapters" })).queryByText("Caching")).toBeNull();
  slot.lifecycle.unmount();
});

test("since your review, a split file counts and shows only in the chapters whose hunks changed", async () => {
  const { interdiff } = await import("../src/interdiff");
  const reviewed = patch.replace("+CACHE", "+CACHED");
  const slot = await renderWorkspace({
    review: { signals: { lastReviewSha: "old" }, submittedVerdict: "COMMENT" },
    rpc: { getSinceReview: () => ({ baseline: { sha: "old", at: 1, verdict: "COMMENT" }, files: interdiff(reviewed, patch) }) },
  });
  const nav = within(slot.getByRole("navigation", { name: "Chapters" }));
  await waitFor(() => expect(nav.getByText("1 changed")).toBeTruthy());
  expect(nav.getByText("1 changed").closest("li")!.textContent).toContain("Caching");
  fireEvent.click(nav.getByText("Parsing"));
  // The re-review shows only what changed since your review.
  expect(await slot.findByRole("button", { name: "Show changes: Since your review" })).toBeTruthy();
  await waitFor(() => expect(slot.container.querySelector('[data-file="src/a.ts"]')).toBeNull());
  fireEvent.click(nav.getByText("Caching"));
  await slot.findByText(/CACHE/);
  slot.lifecycle.unmount();
});

test("since your review, a split file whose hunks here didn't change, picked in the chapters list, shows all changes there", async () => {
  const { interdiff } = await import("../src/interdiff");
  const reviewed = patch.replace("+CACHE", "+CACHED");
  const slot = await renderWorkspace({
    review: { signals: { lastReviewSha: "old" }, submittedVerdict: "COMMENT" },
    rpc: { getSinceReview: () => ({ baseline: { sha: "old", at: 1, verdict: "COMMENT" }, files: interdiff(reviewed, patch) }) },
  });
  const nav = within(slot.getByRole("navigation", { name: "Chapters" }));
  await waitFor(() => expect(nav.getByText("1 changed")).toBeTruthy());
  fireEvent.click(nav.getByText("Parsing"));
  expect(await slot.findByRole("button", { name: "Show changes: Since your review" })).toBeTruthy();
  await waitFor(() => expect(slot.container.querySelector('[data-file="src/a.ts"]')).toBeNull());
  fireEvent.click(nav.getAllByRole("button").find((button) => button.title.startsWith("src/a.ts"))!);
  expect(await slot.findByRole("button", { name: "Show changes: All changes" })).toBeTruthy();
  expect(card(slot).getByText(/PARSE/)).toBeTruthy();
  slot.lifecycle.unmount();
});

const currentFile = (slot: Awaited<ReturnType<typeof renderWorkspace>>) => within(slot.getByRole("navigation", { name: "Chapters" })).getAllByRole("button").find((button) => button.getAttribute("aria-current") === "true")?.textContent;
const currentChapter = (slot: Awaited<ReturnType<typeof renderWorkspace>>) => within(slot.getByRole("navigation", { name: "Chapters" })).getAllByRole("button").find((button) => button.getAttribute("aria-current") === "step")?.textContent;
const press = (key: string) => fireEvent.keyDown(document.body, { key });

test("] goes through a split file's comments in the chapter showing each line", async () => {
  const scrollIntoView = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = () => {};
  const slot = await renderWorkspace({ rpc: { getDraft: () => ({ draft: { targetKey: "pr-42", verdict: "COMMENT", body: "", comments: [
    { file: "src/a.ts", line: 1, side: "RIGHT", body: "Parse it once." },
    { file: "src/b.ts", line: 1, side: "RIGHT", body: "Use it." },
    { file: "src/a.ts", line: 20, side: "RIGHT", body: "Expire it." },
  ] } }) } });
  await waitFor(() => expect(card(slot).getByText("comment on 1")).toBeTruthy());
  press("]");
  await waitFor(() => expect(currentFile(slot)).toContain("a.ts"));
  expect(currentChapter(slot)).toContain("Parsing");
  press("]");
  await waitFor(() => expect(currentFile(slot)).toContain("b.ts"));
  press("]");
  await slot.findByText(/CACHE/);
  expect(currentChapter(slot)).toContain("Caching");
  Element.prototype.scrollIntoView = scrollIntoView;
  slot.lifecycle.unmount();
}, 15_000);

test("u goes on from a split file's place in the open chapter", async () => {
  const scrollIntoView = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = () => {};
  const withC = { ...guide, sections: [guide.sections[0], { ...guide.sections[1], diffs: [...guide.sections[1].diffs, { file: "src/c.ts", summary: "Evicts a row." }] }] };
  const slot = await renderWorkspace({ bundle: { guide: withC, patch: `${patch}diff --git a/src/c.ts b/src/c.ts\n--- a/src/c.ts\n+++ b/src/c.ts\n@@ -1 +1 @@\n-c\n+cc\n` } });
  await slot.findByText(/PARSE/);
  fireEvent.click(within(slot.getByRole("navigation", { name: "Chapters" })).getByText("Caching"));
  await slot.findByText(/CACHE/);
  press("u");
  await waitFor(() => expect(currentFile(slot)).toContain("c.ts"));
  expect(currentChapter(slot)).toContain("Caching");
  Element.prototype.scrollIntoView = scrollIntoView;
  slot.lifecycle.unmount();
}, 15_000);

// With Settings on All changes, a re-review shows every hunk, each badged where it changed.
const showAll = { getPreferences: () => ({ preferences: { ...defaultPreferences, rereviewShows: "all" }, revision: 0 }) };

test("a split file shows Changed since your review only in the chapters whose hunks changed", async () => {
  const { interdiff } = await import("../src/interdiff");
  const reviewed = patch.replace("+CACHE", "+CACHED");
  const slot = await renderWorkspace({
    review: { signals: { lastReviewSha: "old" }, submittedVerdict: "COMMENT" },
    rpc: { ...showAll, getSinceReview: () => ({ baseline: { sha: "old", at: 1, verdict: "COMMENT" }, files: interdiff(reviewed, patch) }) },
  });
  const nav = within(slot.getByRole("navigation", { name: "Chapters" }));
  await waitFor(() => expect(nav.getByText("1 changed")).toBeTruthy());
  fireEvent.click(nav.getByText("Parsing"));
  await slot.findByText(/PARSE/);
  expect(card(slot).queryByTitle("Changed since your review")).toBeNull();
  fireEvent.click(nav.getByText("Caching"));
  await slot.findByText(/CACHE/);
  expect(card(slot).getByTitle("Changed since your review")).toBeTruthy();
  slot.lifecycle.unmount();
});

test("showing only changes, a split file whose hunks here didn't change counts as unchanged", () => {
  const since = new Map(interdiff(patch.replace("+CACHE", "+CACHED"), patch).map((f) => [f.file, f]));
  const view = render(<DiffViewer patch={patch} files={["src/a.ts", "src/b.ts"]} splitFiles={new Map([["src/a.ts", { hunks: [1], alsoIn: ["Caching"] }]])} views={new Map()} onToggleViewed={() => {}} since={since} sinceOnly />);
  expect(view.getByText("Nothing changed in this chapter since your review.")).toBeTruthy();
  expect(view.getByText("2 files unchanged since your review")).toBeTruthy();
});

test("a split file shows Changed since your review in the chapter nearest a change gone since then", async () => {
  const { interdiff } = await import("../src/interdiff");
  const reviewed = patch.replace("+CACHE\n keep\n", "+CACHE\n keep\n@@ -30 +30 @@\n-x\n+X\n");
  const slot = await renderWorkspace({
    review: { signals: { lastReviewSha: "old" }, submittedVerdict: "COMMENT" },
    rpc: { ...showAll, getSinceReview: () => ({ baseline: { sha: "old", at: 1, verdict: "COMMENT" }, files: interdiff(reviewed, patch) }) },
  });
  const nav = within(slot.getByRole("navigation", { name: "Chapters" }));
  await waitFor(() => expect(nav.getByText("1 changed")).toBeTruthy());
  expect(nav.getByText("1 changed").closest("li")!.textContent).toContain("Caching");
  fireEvent.click(nav.getByText("Parsing"));
  await slot.findByText(/PARSE/);
  expect(card(slot).queryByTitle("Changed since your review")).toBeNull();
  fireEvent.click(nav.getByText("Caching"));
  await slot.findByText(/CACHE/);
  expect(card(slot).getByTitle("Changed since your review")).toBeTruthy();
  slot.lifecycle.unmount();
});

/** The views as the server keeps them: per file, as marks save them. */
function storedViews() {
  const viewed = new Set<string>();
  return {
    viewed,
    getFileViews: vi.fn(() => ({ views: [...viewed].map((file) => ({ file, viewed: true, stale: false, viewedAt: 1 })) })),
    setFilesViewed: vi.fn(({ files, viewed: on = true }: { files: string[]; viewed?: boolean }) => { for (const file of files) if (on) viewed.add(file); else viewed.delete(file); return { ok: true, previous: [] }; }),
  };
}
const toastText = (message: unknown) => { const shown = render(<>{message as ReactNode}</>); const text = shown.container.textContent; shown.unmount(); return text; };
const lastToast = (kind: "success" | "info") => vi.mocked(toast[kind]).mock.calls.at(-1)!;

// bug bash RDG-4: Viewed is kept per file, so marking the first chapter viewed (its end's "Mark viewed and continue")
// marked a split file's hunks in the next chapter viewed too: that chapter opened with them folded and read as done,
// though they were never shown. The last chapter holding its hunks marks it.
test("Mark viewed and continue leaves a split file for the next chapter's hunks, and that chapter's end marks it", async () => {
  const { viewed, getFileViews, setFilesViewed } = storedViews();
  const slot = await renderWorkspace({ rpc: { getFileViews, setFilesViewed } });
  await slot.findByText(/PARSE/);
  fireEvent.click(within(slot.getByRole("main")).getByRole("button", { name: "Mark viewed and continue" }));
  expect(setFilesViewed).toHaveBeenCalledWith({ targetKey: "pr-42", files: ["src/b.ts"] });
  const main = within(slot.getByRole("main"));
  await main.findByRole("heading", { name: "Caching" });
  // Caching's own hunk of src/a.ts, which no chapter had shown yet, is open.
  expect(main.queryByRole("button", { name: "Collapse src/a.ts" })).not.toBeNull();
  expect(main.queryByText(/CACHE/)).not.toBeNull();
  await waitFor(() => expect(toast.success).toHaveBeenCalled());
  const [message, options] = lastToast("success");
  expect(toastText(message)).toBe("Marked 1 file viewed. a.ts continues in Caching.");
  expect((options as { action: { label: string } }).action.label).toBe("Undo");

  fireEvent.click(main.getByRole("button", { name: "Mark viewed and finish" }));
  expect(setFilesViewed).toHaveBeenLastCalledWith({ targetKey: "pr-42", files: ["src/a.ts"] });
  await waitFor(() => expect(viewed.has("src/a.ts")).toBe(true));
  await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(2));
  expect(lastToast("success")[0]).toBe("Marked 1 file viewed");
  slot.lifecycle.unmount();
}, 15_000);

test("Undo after a chapter mark that left a split file out unmarks only what it marked", async () => {
  const { viewed, getFileViews, setFilesViewed } = storedViews();
  const slot = await renderWorkspace({ rpc: { getFileViews, setFilesViewed } });
  await slot.findByText(/PARSE/);
  fireEvent.click(within(slot.getByRole("navigation", { name: "Chapters" })).getByRole("button", { name: "Mark chapter viewed" }));
  await waitFor(() => expect(toast.success).toHaveBeenCalled());
  act(() => (lastToast("success")[1] as unknown as { action: { onClick: () => void } }).action.onClick());
  await waitFor(() => expect(setFilesViewed).toHaveBeenLastCalledWith({ targetKey: "pr-42", files: ["src/b.ts"], viewed: false, previous: [] }));
  await waitFor(() => expect(viewed.size).toBe(0));
  slot.lifecycle.unmount();
}, 15_000);

test("a chapter whose only unviewed file continues later marks nothing and says where it continues", async () => {
  const { getFileViews, setFilesViewed } = storedViews();
  const onlySplit = { ...guide, sections: [
    { id: "c1", title: "Parsing", overview: "Reads rows.", diffs: [{ file: "src/a.ts", summary: "Parses a row.", hunks: [1] }] },
    { id: "c2", title: "Caching rows for the parser between requests and across restarts", overview: "Keeps rows.", diffs: [{ file: "src/a.ts", summary: "Caches a row.", hunks: [2] }, { file: "src/b.ts", summary: "Uses it." }] },
  ] };
  const slot = await renderWorkspace({ bundle: { guide: onlySplit }, rpc: { getFileViews, setFilesViewed } });
  await slot.findByText(/PARSE/);
  fireEvent.click(within(slot.getByRole("navigation", { name: "Chapters" })).getByRole("button", { name: "Mark chapter viewed" }));
  expect(setFilesViewed).not.toHaveBeenCalled();
  expect(toast.success).not.toHaveBeenCalled();
  const [message] = lastToast("info");
  expect(toastText(message)).toBe("a.ts continues in Caching rows for the parser between requests and across restarts.");
  // The agent's title, as plain text, shortened to the toast's width.
  const shown = render(<>{message as ReactNode}</>);
  expect(within(shown.container).getByText("Caching rows for the parser between requests and across restarts").className).toContain("truncate");
  shown.unmount();
  slot.lifecycle.unmount();
}, 15_000);

test("a chapter mark that leaves out several split files counts them", async () => {
  const { getFileViews, setFilesViewed } = storedViews();
  const twoSplit = patch + "diff --git a/src/c.ts b/src/c.ts\n--- a/src/c.ts\n+++ b/src/c.ts\n@@ -1,2 +1,2 @@\n-c\n+C1\n keep\n@@ -20,2 +20,2 @@\n-c\n+C2\n keep\n";
  const guided = { ...guide, sections: [
    { ...guide.sections[0], diffs: [...guide.sections[0].diffs, { file: "src/c.ts", summary: "Parses c.", hunks: [1] }] },
    { ...guide.sections[1], diffs: [...guide.sections[1].diffs, { file: "src/c.ts", summary: "Caches c.", hunks: [2] }] },
  ] };
  const slot = await renderWorkspace({ bundle: { guide: guided, patch: twoSplit }, rpc: { getFileViews, setFilesViewed } });
  await slot.findByText(/PARSE/);
  fireEvent.click(within(slot.getByRole("navigation", { name: "Chapters" })).getByRole("button", { name: "Mark chapter viewed" }));
  expect(setFilesViewed).toHaveBeenCalledWith({ targetKey: "pr-42", files: ["src/b.ts"] });
  await waitFor(() => expect(toast.success).toHaveBeenCalled());
  expect(toastText(lastToast("success")[0])).toBe("Marked 1 file viewed. 2 split files continue in later chapters.");
  slot.lifecycle.unmount();
}, 15_000);
