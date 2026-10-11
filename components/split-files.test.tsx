// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { defaultPreferences } from "../src/preferences";

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
  await slot.findByRole("heading", { name: "Parse rows" });
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
  // Viewed stays per file: two files, not three.
  expect(within(slot.getByRole("navigation", { name: "Chapters" })).getByText("0/2 files viewed")).toBeTruthy();

  fireEvent.click(within(slot.getByRole("navigation", { name: "Chapters" })).getByText("Caching"));
  await slot.findByText(/CACHE/);
  expect(card(slot).queryByText(/PARSE/)).toBeNull();
  expect(card(slot).getByText("Caches a row.")).toBeTruthy();
  expect(card(slot).getByText(/Also in/).textContent).toBe("Also in Parsing");
  expect(card(slot).getByText("comment on 20")).toBeTruthy();
  expect(card(slot).queryByText("comment on 1")).toBeNull();
  slot.lifecycle.unmount();
});

test("opening a line of a split file goes to the chapter holding its hunk", async () => {
  const slot = await renderWorkspace();
  await slot.findByText(/PARSE/);
  fireEvent.click(within(slot.getByRole("region", { name: "Start here" })).getByRole("button", { name: "src/a.ts:20" }));
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
  fireEvent.click(await slot.findByRole("button", { name: "Since your review" }));
  await waitFor(() => expect(slot.container.querySelector('[data-file="src/a.ts"]')).toBeNull());
  fireEvent.click(nav.getByText("Caching"));
  await slot.findByText(/CACHE/);
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
