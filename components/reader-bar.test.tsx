// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { defaultPreferences } from "../src/preferences";
import { interdiff } from "../src/interdiff";
import { getCommentsFolded, patchReviewState } from "../lib/panel-state";
import { openDiffOptions, reviewAction } from "./review-bar.test-support";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@pierre/diffs/react", () => ({ FileDiff: ({ fileDiff }: any) => <pre data-testid="filediff">{fileDiff.additionLines.join("\n")}</pre> }));
afterEach(() => { cleanup(); localStorage.clear(); sessionStorage.clear(); });

const file = (path: string, line: string) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-x\n+${line}\n`;
const patch = file("src/a.ts", "aa") + file("src/b.ts", "bb");
const reviewed = file("src/a.ts", "a0") + file("src/b.ts", "bb");
const guide = { title: "Guide", intent: "Parses rows.", unplacedFiles: [] as string[], sections: [{ id: "c1", title: "Parsing", overview: "Reads rows.", diffs: [{ file: "src/a.ts" }, { file: "src/b.ts" }] }] };

async function renderWorkspace(review: Record<string, unknown> = {}) {
  patchReviewState("pr-42", { activeId: "c1" });
  const app = await loadPluginApp(() => import("../app"));
  const slot = renderSlot(app.navPanels[0]!, { subPath: "pr-42" }, { rpc: {
    setReviewPresence: () => ({ ok: true }),
    getReviewBundle: () => ({ review: { targetKey: "pr-42", kind: "pr", status: "ready", createdAt: 1, title: "Parse rows", headSha: "new", ...review }, guide: structuredClone(guide), patch, revision: "r1" }),
    getChecks: () => ({ bucket: "none", checks: [] }),
    getPreferences: () => ({ preferences: defaultPreferences, revision: 0 }),
    getFileViews: () => ({ views: [] }),
    checkRepoAccess: () => ({ accessible: true, repo: "acme/web", account: "me" }),
    checkForUpdates: () => ({ hasNewCommits: false }),
    getDraft: () => ({ draft: { targetKey: "pr-42", verdict: "COMMENT", body: "", comments: [] }, stale: [] }),
    getReviewerNotes: () => ({ body: "", revision: 0 }),
    getConversation: () => ({ threadId: null, legacy: [], defaults: null }),
    markSeen: () => ({ ok: true }),
    getSinceReview: () => ({ baseline: { sha: "old", at: 1, verdict: "COMMENT" }, files: interdiff(reviewed, patch) }),
  } as any });
  await slot.findAllByTestId("filediff");
  return slot;
}
type Slot = Awaited<ReturnType<typeof renderWorkspace>>;
const band = (slot: Slot) => within(slot.getByRole("navigation", { name: "Breadcrumb" }).closest<HTMLElement>("[class*='@container/band']")!);
const rereview = { signals: { lastReviewSha: "old" }, submittedVerdict: "COMMENT" };


test("the band names the chapter without a back button, review id, review name, or diff controls", async () => {
  const slot = await renderWorkspace();
  const breadcrumb = slot.getByRole("navigation", { name: "Breadcrumb" });
  const barElement = breadcrumb.closest<HTMLElement>("[class*='@container/band']")!;
  expect(barElement.closest("main")).toBeNull();
  expect(barElement.closest("[data-review-root]")).toBeTruthy();
  const crumbs = within(breadcrumb);
  expect(crumbs.getByText("Chapter 1 of 1: Parsing, 0 of 2 files viewed")).toBeTruthy();
  expect(crumbs.queryByText("pr-42")).toBeNull();
  expect(crumbs.queryByText("Parse rows")).toBeNull();
  expect(band(slot).queryByRole("button", { name: "All reviews" })).toBeNull();
  expect(band(slot).queryByRole("button", { name: "Find in review" })).toBeNull();
  expect(band(slot).queryByRole("button", { name: "Diff options" })).toBeNull();
  expect(band(slot).queryByRole("button", { name: "Fold comments in code" })).toBeNull();
  // The docked chapters list has the toggle in its own head, so the bar doesn't repeat it.
  expect(band(slot).queryByRole("button", { name: /chapters/ })).toBeNull();
});

test("the re-review switch remains in the chapter intro and switches both ways without a bar select", async () => {
  const slot = await renderWorkspace(rereview);
  expect(band(slot).queryByRole("button", { name: /^Show changes/ })).toBeNull();
  const intro = within(slot.getByRole("region", { name: "Parsing" }));
  const shown = within(intro.getByRole("radiogroup", { name: "Changes shown" }));
  expect(shown.getByRole("radio", { name: "Since your review · 1 of 2 files" }).getAttribute("aria-checked")).toBe("true");
  fireEvent.click(shown.getByRole("radio", { name: "All changes" }));
  expect(slot.getAllByTestId("filediff")).toHaveLength(2);
  fireEvent.click(shown.getByRole("radio", { name: "Since your review · 1 of 2 files" }));
  expect(slot.getAllByTestId("filediff")).toHaveLength(1);
});

test("⋯ groups navigation and display before guide actions, then settings; Find and Fold retain their keys", async () => {
  const slot = await renderWorkspace();
  const find = reviewAction(slot, "Find in review");
  expect(find.getAttribute("aria-keyshortcuts")).toBe("/");
  const fold = slot.getByRole("button", { name: "Fold comments in code" });
  expect(fold.getAttribute("aria-keyshortcuts")).toBe("i");
  const menu = within(find.parentElement!);
  const names = menu.getAllByRole("button").map(b => b.getAttribute("aria-label") ?? b.textContent);
  expect(names.slice(0, 5)).toEqual(["All reviews", "Find in review/", "Fold comments in codei", "Diff options", "Rebuild guide"]);
  expect(menu.getByRole("button", { name: "Rename…" })).toBeTruthy();
  expect(menu.getByRole("button", { name: "Snooze" })).toBeTruthy();
  expect(menu.getByRole("button", { name: "Move to section" })).toBeTruthy();
  expect(menu.getByRole("button", { name: "Archive" })).toBeTruthy();

  expect(menu.getByRole("button", { name: "Review settings…" })).toBeTruthy();
  expect(menu.getAllByRole("separator").length).toBeGreaterThan(1);
  fireEvent.click(find);
  expect(slot.getByRole("searchbox", { name: "Find in review" })).toBeTruthy();
});

test("Fold comments moved into ⋯ still folds and unfolds every comment, and the keyboard shortcut works", async () => {
  const slot = await renderWorkspace();
  fireEvent.click(reviewAction(slot, "Fold comments in code"));
  expect(getCommentsFolded()).toBe(true);
  fireEvent.click(reviewAction(slot, "Unfold comments in code"));
  expect(getCommentsFolded()).toBe(false);
  fireEvent.keyDown(document.body, { key: "i" });
  expect(getCommentsFolded()).toBe(true);
});

test("Diff options is the existing sub-page, with compare, display and file controls and a way back", async () => {
  const slot = await renderWorkspace(rereview);
  openDiffOptions(slot);
  expect(slot.getByRole("button", { name: "Show changes: Since your review" })).toBeTruthy();
  for (const name of ["Wrap long lines", "Hide whitespace changes"]) expect(slot.getByRole("switch", { name })).toBeTruthy();
  for (const name of ["Layout", "New and deleted files", "Markdown files"]) expect(slot.getByRole("radiogroup", { name })).toBeTruthy();
  expect(slot.getByRole("button", { name: "Collapse all" })).toBeTruthy();
  expect(slot.getByRole("button", { name: "Expand all" })).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: "Back to review actions" }));
  expect(slot.getByRole("button", { name: "All reviews" })).toBeTruthy();
});

test("Overview keeps the same commands and says Overview without repeating the review identity", async () => {
  const slot = await renderWorkspace();
  fireEvent.keyDown(document.body, { key: "p" });
  expect(band(slot).getByText("Overview")).toBeTruthy();
  expect(band(slot).getByRole("button", { name: "Agent" })).toBeTruthy();
  expect(band(slot).queryByText("pr-42")).toBeNull();
});
