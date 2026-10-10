// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { defaultPreferences } from "../src/preferences";
import { patchReviewState } from "../lib/panel-state";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@pierre/diffs/react", () => ({
  FileDiff: ({ fileDiff }: any) => <pre data-testid="filediff">{fileDiff.additionLines.join("\n")}</pre>,
}));

afterEach(() => { cleanup(); localStorage.clear(); sessionStorage.clear(); vi.clearAllMocks(); });

const file = (path: string, hunks: string) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${hunks}`;
const patch = [
  file("src/a.ts", "@@ -1 +1 @@\n-a\n+aa\n"),
  file("src/b.ts", "@@ -1 +1 @@\n-b\n+bb\n"),
  file("src/c.ts", "@@ -1 +1 @@\n-c\n+cc\n"),
].join("");
const guide = {
  title: "Guide", intent: "Parses rows.", unplacedFiles: [] as string[],
  sections: [
    { id: "c1", title: "Parsing", overview: "Reads rows.", diffs: [{ file: "src/a.ts", summary: "Reads a row." }] },
    { id: "c2", title: "Caching", overview: "Keeps rows.", diffs: [{ file: "src/b.ts", summary: "Caches a row." }, { file: "src/c.ts", summary: "Evicts a row." }] },
  ],
};

async function renderWorkspace({ review = {}, rpc = {}, bundle = {} }: { review?: Record<string, unknown>; rpc?: Record<string, unknown>; bundle?: Record<string, unknown> } = {}) {
  const app = await loadPluginApp(() => import("../app"));
  const handlers = {
    setReviewPresence: () => ({ ok: true }),
    getReviewBundle: vi.fn(() => ({ review: { targetKey: "pr-42", kind: "pr", status: "ready", createdAt: 1, title: "Parse rows", headSha: "new", ...review }, guide: structuredClone(guide), patch, revision: "r1", ...bundle })),
    getChecks: () => ({ bucket: "none", checks: [] }),
    getPreferences: () => ({ preferences: defaultPreferences, revision: 0 }),
    getFileViews: vi.fn(() => ({ views: [] })),
    setFileViewed: vi.fn(() => ({ ok: true })),
    checkRepoAccess: () => ({ accessible: true, repo: "acme/web", account: "me" }),
    checkForUpdates: () => ({ hasNewCommits: false }),
    getDraft: vi.fn(() => ({ draft: { targetKey: "pr-42", verdict: "COMMENT", body: "", comments: [] } })),
    getReviewerNotes: () => ({ body: "", revision: 0 }),
    getConversation: () => ({ threadId: null, legacy: [], defaults: null }),
    markSeen: vi.fn(() => ({ ok: true })),
    ...rpc,
  };
  const slot = renderSlot(app.navPanels[0]!, { subPath: "pr-42" }, { rpc: handlers as any });
  await slot.findByRole("heading", { name: "Parse rows" });
  return { slot, rpc: handlers };
}
type Slot = Awaited<ReturnType<typeof renderWorkspace>>["slot"];
const chapters = (slot: Slot) => within(slot.getByRole("navigation", { name: "Chapters" }));
const currentChapter = (slot: Slot) => chapters(slot).getAllByRole("button").find((button) => button.getAttribute("aria-current") === "step");

test("reopening a review returns to the chapter you were on", async () => {
  patchReviewState("pr-42", { activeId: "c2" });
  const { slot } = await renderWorkspace();
  await slot.findByText("bb");
  expect(currentChapter(slot)?.textContent).toContain("Caching");
  slot.lifecycle.unmount();
});

test("the diff opens on the chapter's intro and shows each file's summary in its header", async () => {
  const overview = "Rows are cached by id. The cache evicts the **oldest** row first. Writes go through the cache. Reads fall back to the store. Nothing else changes.";
  const { slot } = await renderWorkspace({ bundle: { guide: { ...guide, sections: [{ ...guide.sections[0], overview, risk: "high" }, guide.sections[1]] } } });
  const main = within(slot.getByRole("main"));
  const intro = within(await main.findByRole("region", { name: "Parsing" }));
  expect(intro.getByText("High risk")).toBeTruthy();
  expect(intro.getByText(/Nothing else changes\./)).toBeTruthy();
  expect(within(slot.container.querySelector<HTMLElement>('[data-file="src/a.ts"]')!).getByText("Reads a row.")).toBeTruthy();
  // Hiding the overview sticks in this browser.
  fireEvent.click(intro.getByRole("button", { name: "Hide chapter overview" }));
  expect(intro.queryByText(/Nothing else changes\./)).toBeNull();
  slot.lifecycle.unmount();
  const again = await renderWorkspace();
  const reopened = within(await within(again.slot.getByRole("main")).findByRole("region", { name: "Parsing" }));
  expect(reopened.getByRole("button", { name: "Show chapter overview" }).getAttribute("aria-expanded")).toBe("false");
  expect(reopened.queryByText("Reads rows.")).toBeNull();
  again.slot.lifecycle.unmount();
});

const scroller = (slot: Slot) => slot.getByRole("main").querySelector<HTMLElement>(".overflow-y-auto")!;

test("after a chapter's last file, Next opens the next chapter at its top", async () => {
  const { slot } = await renderWorkspace();
  await slot.findByText("aa");
  scroller(slot).scrollTop = 400;
  fireEvent.click(within(slot.getByRole("main")).getByRole("button", { name: "Next: Caching" }));
  await slot.findByText("bb");
  expect(currentChapter(slot)?.textContent).toContain("Caching");
  expect(scroller(slot).scrollTop).toBe(0);
  // The last chapter has nothing next.
  expect(within(slot.getByRole("main")).queryByRole("button", { name: /^Next:/ })).toBeNull();
  slot.lifecycle.unmount();
});

test("Mark chapter viewed and continue marks the chapter's files and opens the next", async () => {
  const { slot, rpc } = await renderWorkspace();
  await slot.findByText("aa");
  fireEvent.click(within(slot.getByRole("main")).getByRole("button", { name: "Mark chapter viewed and continue" }));
  await slot.findByText("bb");
  expect(rpc.setFileViewed).toHaveBeenCalledWith({ targetKey: "pr-42", file: "src/a.ts", viewed: true });
  expect(currentChapter(slot)?.textContent).toContain("Caching");
  slot.lifecycle.unmount();
});

test("a review back with changes opens on the first chapter that changed, unless you were reading one", async () => {
  const { interdiff } = await import("../src/interdiff");
  const reviewed = patch.replace("+bb", "+b0");
  const sinceReview = { review: { signals: { lastReviewSha: "old" }, submittedVerdict: "COMMENT" }, rpc: { getSinceReview: () => ({ baseline: { sha: "old", at: 1, verdict: "COMMENT" }, files: interdiff(reviewed, patch) }) } };
  const { slot } = await renderWorkspace(sinceReview);
  await slot.findByText("bb");
  expect(currentChapter(slot)?.textContent).toContain("Caching");
  slot.lifecycle.unmount();
  patchReviewState("pr-42", { activeId: "c1" });
  const again = await renderWorkspace(sinceReview);
  await waitFor(() => expect(chapters(again.slot).getByText("1 changed")).toBeTruthy());
  expect(currentChapter(again.slot)?.textContent).toContain("Parsing");
  again.slot.lifecycle.unmount();
});

const reviewedPatch = patch.replace("+bb", "+b0");
async function sinceReviewSetup() {
  const { interdiff } = await import("../src/interdiff");
  return { review: { signals: { lastReviewSha: "old" }, submittedVerdict: "COMMENT" }, rpc: { getSinceReview: () => ({ baseline: { sha: "old", at: 1, verdict: "COMMENT" }, files: interdiff(reviewedPatch, patch) }) } };
}

test("under Since your review, opening a file unchanged since then turns the filter off to show it", async () => {
  const setup = await sinceReviewSetup();
  const comment = { file: "src/a.ts", line: 1, side: "RIGHT", body: "Why?", author: "reviewer" };
  const { slot } = await renderWorkspace({ ...setup, rpc: { ...setup.rpc, getDraft: () => ({ draft: { targetKey: "pr-42", verdict: "COMMENT", body: "", comments: [comment] } }) } });
  const filter = await slot.findByRole("button", { name: "Since your review" });
  fireEvent.click(chapters(slot).getByText("Parsing"));
  fireEvent.click(filter);
  expect(slot.container.querySelector('[data-file="src/a.ts"]')).toBeNull();
  fireEvent.click(chapters(slot).getByText("a.ts"));
  expect(filter.getAttribute("aria-pressed")).toBe("false");
  expect(slot.container.querySelector('[data-file="src/a.ts"]')).toBeTruthy();
  // A draft comment's Show in diff does the same.
  fireEvent.click(filter);
  const draftTool = slot.getByRole("button", { name: "Draft review" });
  if (draftTool.getAttribute("aria-pressed") !== "true") fireEvent.click(draftTool);
  fireEvent.click(await slot.findByRole("button", { name: /^src\/a\.ts:1/ }));
  expect(filter.getAttribute("aria-pressed")).toBe("false");
  slot.lifecycle.unmount();
}, 15_000);
