// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { defaultPreferences } from "../src/preferences";
import { interdiff } from "../src/interdiff";
import { fileTree, filterPaths, firstFile } from "../lib/file-tree";
import { getNavView, getReviewState, patchReviewState, setHideNits } from "../lib/panel-state";
import { render } from "@testing-library/react";
import { ChapterNav } from "./ChapterNav";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@pierre/diffs/react", () => ({ FileDiff: ({ fileDiff }: any) => <pre>{fileDiff.additionLines.join("")}</pre> }));

afterEach(() => { cleanup(); localStorage.clear(); sessionStorage.clear(); });
// jsdom has none, and opening a file's chapter scrolls to it a frame later, which can land after a test ends.
Element.prototype.scrollIntoView = () => {};

test("changed files make a folder tree: folders first, by name, and a folder holding only a folder shows as one", () => {
  const tree = fileTree(["src/lib/deep/b.ts", "src/lib/deep/a.ts", "README.md", "src/app.ts", "docs/guide/intro.md"]);
  const shape = (nodes: ReturnType<typeof fileTree>): unknown[] => nodes.map((node) => node.kind === "folder" ? { [node.name]: shape(node.children) } : node.name);
  expect(shape(tree)).toEqual([
    { "docs/guide": ["intro.md"] },
    { src: [{ "lib/deep": ["a.ts", "b.ts"] }, "app.ts"] },
    "README.md",
  ]);
});

test("the tree's first file is the one it shows first: in its first folder, not the guide's first", () => {
  expect(firstFile(fileTree(["src/z/a.ts", "docs/a.md", "a.ts"]))).toBe("docs/a.md");
  expect(firstFile(fileTree(["b.ts", "a.ts"]))).toBe("a.ts");
  expect(firstFile([])).toBeUndefined();
});

test("the path filter keeps files holding every word, in any case", () => {
  const paths = ["src/cache/Store.ts", "src/cache/evict.ts", "test/cache.test.ts"];
  expect(filterPaths(paths, "cache STORE")).toEqual(["src/cache/Store.ts"]);
  expect(filterPaths(paths, " test ")).toEqual(["test/cache.test.ts"]);
  expect(filterPaths(paths, "")).toEqual(paths);
});

test("the path filter ignores accents", () => {
  expect(filterPaths(["docs/café.md", "docs/cafe-notes.md", "src/api.ts"], "cafe")).toEqual(["docs/café.md", "docs/cafe-notes.md"]);
  expect(filterPaths(["docs/cafe-notes.md", "docs/Café.md"], "CAFÉ")).toEqual(["docs/cafe-notes.md", "docs/Café.md"]);
});

test("a file split across chapters opens in the current chapter when it lists the file, else the first that does", () => {
  const sections = [
    { id: "c1", title: "One", overview: "", diffs: [{ file: "src/server.ts", hunks: [2] }] },
    { id: "c2", title: "Two", overview: "", diffs: [{ file: "src/server.ts", hunks: [1] }] },
    { id: "c3", title: "Three", overview: "", diffs: [{ file: "README.md" }] },
  ];
  const onSelectFile = vi.fn();
  const tree = (activeId: string) => <ChapterNav sections={sections} activeId={activeId} onSelect={() => {}} views={new Map()} onSelectFile={onSelectFile} view="files" />;
  const view = render(tree("c1"));
  const server = () => within(view.getByRole("list", { name: "All files" })).getByTitle("src/server.ts");
  fireEvent.click(server());
  view.rerender(tree("c2"));
  fireEvent.click(server());
  view.rerender(tree("c3"));
  fireEvent.click(server());
  expect(onSelectFile.mock.calls).toEqual([["c1", "src/server.ts"], ["c2", "src/server.ts"], ["c1", "src/server.ts"]]);
});

const file = (path: string, hunks: string) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${hunks}`;
const patch = [
  file("src/cache/store.ts", "@@ -1 +1 @@\n-a\n+store body\n"),
  file("src/cache/evict.ts", "@@ -1 +1 @@\n-b\n+evict body\n"),
  file("src/api.ts", "@@ -1 +1 @@\n-c\n+api body\n"),
  file("dist/bundle.js", "@@ -1 +1 @@\n-d\n+bundle body\n"),
].join("");
const reviewed = patch.replace("+evict body", "+evict older");
const guide = {
  title: "Guide", intent: "Caches.", unplacedFiles: [] as string[],
  sections: [
    { id: "c1", title: "Store", overview: "", diffs: [{ file: "src/cache/store.ts" }, { file: "src/api.ts" }] },
    { id: "c2", title: "Evict", overview: "", diffs: [{ file: "src/cache/evict.ts" }, { file: "dist/bundle.js" }] },
  ],
};
const at = (file: string, line: number) => ({ file, line, side: "RIGHT" as const });

async function renderWorkspace() {
  // Opened before, on its first chapter: a first open shows the Overview.
  if (!getReviewState("pr-42").activeId) patchReviewState("pr-42", { activeId: "c1" });
  const app = await loadPluginApp(() => import("../app"));
  const handlers = {
    setReviewPresence: () => ({ ok: true }),
    getReviewBundle: () => ({ review: { targetKey: "pr-42", kind: "pr", status: "ready", createdAt: 1, title: "Cache rows", headSha: "new", signals: { lastReviewSha: "old" }, submittedVerdict: "COMMENT" }, guide: structuredClone(guide), patch, revision: "r1" }),
    getChecks: () => ({ bucket: "none", checks: [] }),
    getPreferences: () => ({ preferences: defaultPreferences, revision: 0 }),
    getFileViews: () => ({ views: [{ file: "src/api.ts", viewed: true, stale: false }] }),
    getGeneratedFiles: () => ({ files: ["dist/bundle.js"] }),
    checkRepoAccess: () => ({ accessible: true, repo: "acme/web", account: "me" }),
    checkForUpdates: () => ({ hasNewCommits: false }),
    getDraft: () => ({
      draft: { targetKey: "pr-42", verdict: "COMMENT", body: "", comments: [{ ...at("src/cache/store.ts", 1), body: "Why?" }, { ...at("src/cache/store.ts", 1), side: "LEFT", body: "And this?", severity: "nit" }] },
      stale: [], discussions: [{ ...at("src/cache/evict.ts", 1), entries: [{ author: "reviewer", kind: "message", body: "Safe?", createdAt: 1 }], waiting: false }],
    }),
    getReviewThreads: () => ({ threads: [
      { id: "t1", isResolved: false, isOutdated: false, path: "src/cache/evict.ts", line: 1, side: "RIGHT", comments: [{ id: "c1", databaseId: 1, author: "bob", body: "Hmm" }] },
      { id: "t2", isResolved: true, isOutdated: false, path: "src/cache/evict.ts", line: 1, side: "RIGHT", comments: [{ id: "c2", databaseId: 2, author: "bob", body: "Done" }] },
    ] }),
    getSinceReview: () => ({ baseline: { sha: "old", at: 1, verdict: "COMMENT" }, files: interdiff(reviewed, patch) }),
    getCodeOwners: () => ({ files: [{ file: "src/cache/store.ts", owners: ["@acme/cache"], mine: true }, { file: "src/api.ts", owners: ["@bob"], mine: false }] }),
    getReviewerNotes: () => ({ body: "", revision: 0 }),
    getConversation: () => ({ threadId: null, legacy: [], defaults: null }),
    markSeen: () => ({ ok: true }),
  };
  const slot = renderSlot(app.navPanels[0]!, { subPath: "pr-42" }, { rpc: handlers as any });
  await slot.findByRole("main", { name: "Review" });
  await slot.findAllByText(/ body/);
  return slot;
}
type Slot = Awaited<ReturnType<typeof renderWorkspace>>;
const nav = (slot: Slot) => within(slot.getByRole("navigation", { name: "Chapters" }));
const fileRow = (slot: Slot, name: string) => within(slot.getByRole("list", { name: "All files" })).getByTitle(name);

test("All files lists every file as a tree with what's on it, and the choice sticks in this browser", async () => {
  const slot = await renderWorkspace();
  fireEvent.click(nav(slot).getByRole("button", { name: "All files" }));
  expect(getNavView()).toBe("files");
  const tree = within(slot.getByRole("list", { name: "All files" }));
  expect(tree.getByRole("button", { name: "src" }).getAttribute("aria-expanded")).toBe("true");
  // Draft comments, and discussions: open GitHub threads and the agent's.
  expect(within(fileRow(slot, "src/cache/store.ts")).getByText("2 draft comments")).toBeTruthy();
  const evict = within(fileRow(slot, "src/cache/evict.ts"));
  expect(evict.getByText("1 open GitHub thread, 1 discussion with the agent")).toBeTruthy();
  expect(evict.getByText("changed since your review")).toBeTruthy();
  expect(within(fileRow(slot, "src/cache/store.ts")).queryByText("changed since your review")).toBeNull();
  expect(within(fileRow(slot, "src/api.ts")).getByText("viewed")).toBeTruthy();
  expect(within(fileRow(slot, "dist/bundle.js")).getByText("generated · skip")).toBeTruthy();
  // Owners, with yours marked.
  await waitFor(() => expect(within(fileRow(slot, "src/cache/store.ts")).getByText("@acme/cache")).toBeTruthy());
  expect(within(fileRow(slot, "src/cache/store.ts")).getByText("· yours")).toBeTruthy();
  expect(within(fileRow(slot, "src/api.ts")).queryByText("· yours")).toBeNull();
  // And in the file's header.
  fireEvent.click(fileRow(slot, "src/cache/store.ts"));
  await slot.findByText(/store body/);
  const header = within(slot.container.querySelector<HTMLElement>('[data-file="src/cache/store.ts"]')!);
  expect(header.getByText("@acme/cache")).toBeTruthy();
  expect(header.getByText("· yours")).toBeTruthy();
  slot.lifecycle.unmount();

  const again = await renderWorkspace();
  expect(again.getByRole("list", { name: "All files" })).toBeTruthy();
  fireEvent.click(nav(again).getByRole("button", { name: "Chapters" }));
  expect(getNavView()).toBe("chapters");
  again.lifecycle.unmount();
}, 15_000);

test("with Hide nits on, All files counts the comments it shows, as the file's header does", async () => {
  setHideNits(true);
  const slot = await renderWorkspace();
  fireEvent.click(nav(slot).getByRole("button", { name: "All files" }));
  expect(within(fileRow(slot, "src/cache/store.ts")).getByText("1 draft comment")).toBeTruthy();
  slot.lifecycle.unmount();
}, 15_000);

test("choosing a file in All files opens it in its chapter at its header", async () => {
  const scrolled = vi.fn();
  const scrollIntoView = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function (this: Element) { scrolled((this as HTMLElement).dataset.file); };
  try {
    const slot = await renderWorkspace();
    fireEvent.click(nav(slot).getByRole("button", { name: "All files" }));
    fireEvent.click(fileRow(slot, "src/api.ts"));
    // A viewed file is folded, so its chapter's other file shows.
    await slot.findByText(/store body/);
    await waitFor(() => expect(scrolled).toHaveBeenCalledWith("src/api.ts"));
    expect(fileRow(slot, "src/api.ts").getAttribute("aria-current")).toBe("true");
    slot.lifecycle.unmount();
  } finally {
    Element.prototype.scrollIntoView = scrollIntoView;
  }
}, 15_000);

test("f shows All files with the cursor in the filter; Enter opens the first match, and arrows move through the tree", async () => {
  const slot = await renderWorkspace();
  fireEvent.keyDown(document.body, { key: "f" });
  const filter = await slot.findByRole("searchbox", { name: "Filter files" });
  await waitFor(() => expect(document.activeElement).toBe(filter));
  fireEvent.change(filter, { target: { value: "cache ST" } });
  expect(slot.getByText("1 file of 4")).toBeTruthy();
  expect(within(slot.getByRole("list", { name: "All files" })).queryByTitle("src/cache/evict.ts")).toBeNull();
  fireEvent.keyDown(filter, { key: "Enter" });
  await slot.findByText(/store body/);
  fireEvent.keyDown(filter, { key: "Escape" });
  expect((filter as HTMLInputElement).value).toBe("");
  // Down from the filter to the first folder; Left folds it, and Right opens it again.
  fireEvent.keyDown(filter, { key: "ArrowDown" });
  const dist = within(slot.getByRole("list", { name: "All files" })).getByRole("button", { name: "dist" });
  expect(document.activeElement).toBe(dist);
  fireEvent.keyDown(dist, { key: "ArrowLeft" });
  expect(dist.getAttribute("aria-expanded")).toBe("false");
  expect(within(slot.getByRole("list", { name: "All files" })).queryByTitle("dist/bundle.js")).toBeNull();
  fireEvent.keyDown(dist, { key: "ArrowRight" });
  fireEvent.keyDown(dist, { key: "ArrowDown" });
  expect(document.activeElement).toBe(fileRow(slot, "dist/bundle.js"));
  fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
  fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
  expect(document.activeElement).toBe(filter);
  slot.lifecycle.unmount();
}, 15_000);

test("Enter in the filter opens the first file the tree shows, not the guide's first", async () => {
  const slot = await renderWorkspace();
  fireEvent.keyDown(document.body, { key: "f" });
  const filter = await slot.findByRole("searchbox", { name: "Filter files" });
  // In the guide, store.ts comes first; the tree shows evict.ts first.
  fireEvent.change(filter, { target: { value: "cache" } });
  fireEvent.keyDown(filter, { key: "Enter" });
  await slot.findByText(/evict body/);
  expect(fileRow(slot, "src/cache/evict.ts").getAttribute("aria-current")).toBe("true");
  slot.lifecycle.unmount();
}, 15_000);
