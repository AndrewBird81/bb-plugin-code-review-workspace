// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, within } from "@testing-library/react";
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
