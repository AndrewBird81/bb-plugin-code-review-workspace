// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createStore } from "../src/store";
import { checkGuideInput } from "../src/guide";
import { defaultPreferences } from "../src/preferences";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
// Each diff's new lines.
vi.mock("@pierre/diffs/react", () => ({ FileDiff: ({ fileDiff }: any) => <pre data-testid="filediff">{fileDiff.additionLines.join("\n")}</pre> }));

afterEach(() => { cleanup(); localStorage.clear(); sessionStorage.clear(); vi.clearAllMocks(); });
// A pane as wide as a desktop's, where the side panel docks beside the chapters.
const windowWidth = window.innerWidth;
beforeEach(() => { window.innerWidth = 1440; });
afterEach(() => { window.innerWidth = windowWidth; });

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
    { id: "overview", title: "Caching", overview: "Keeps rows.", diffs: [{ file: "src/b.ts", summary: "Caches a row." }, { file: "src/c.ts", summary: "Evicts a row." }] },
  ],
};

/** The workspace on a first open, which shows the Overview, of a review whose bundle holds `stored`. */
async function renderWorkspace(stored: unknown) {
  const app = await loadPluginApp(() => import("../app"));
  const handlers = {
    setReviewPresence: () => ({ ok: true }),
    getReviewBundle: vi.fn(() => ({ review: { targetKey: "pr-42", kind: "pr", status: "ready", createdAt: 1, title: "Parse rows", headSha: "new" }, guide: stored, patch, revision: "r1" })),
    getChecks: () => ({ bucket: "none", checks: [] }),
    getPreferences: () => ({ preferences: defaultPreferences, revision: 0 }),
    getFileViews: vi.fn(() => ({ views: [] })),
    setFileViewed: vi.fn(() => ({ ok: true })),
    setFilesViewed: vi.fn(() => ({ ok: true })),
    checkRepoAccess: () => ({ accessible: true, repo: "acme/web", account: "me" }),
    checkForUpdates: () => ({ hasNewCommits: false }),
    getDraft: vi.fn(() => ({ draft: { targetKey: "pr-42", verdict: "COMMENT", body: "", comments: [] } })),
    getReviewerNotes: () => ({ body: "", revision: 0 }),
    getConversation: () => ({ threadId: null, legacy: [], defaults: null }),
    markSeen: vi.fn(() => ({ ok: true })),
  };
  const slot = renderSlot(app.navPanels[0]!, { subPath: "pr-42" }, { rpc: handlers as any });
  await slot.findByRole("main", { name: "Review" });
  return slot;
}
type Slot = Awaited<ReturnType<typeof renderWorkspace>>;
const chapters = (slot: Slot) => within(slot.getByRole("navigation", { name: "Chapters" }));
const currentChapter = (slot: Slot) => chapters(slot).getAllByRole("button").find((button) => button.getAttribute("aria-current") === "step");

// Earlier versions accepted a chapter with the Overview page's id, which then took over the Overview (bug bash AGT-1).
test("a stored chapter whose id was overview leaves the Overview reachable, and a submitted one is refused", async () => {
  expect(checkGuideInput({ ...guide, sections: guide.sections.map((s) => ({ ...s, risk: "low" })) }).ok).toBe(false);
  // The guide as the store reads it back for the review's bundle.
  const { bb } = createFakePluginHost({ pluginId: "code-review-workspace" });
  const store = createStore(bb);
  store.saveGuide("pr-42", guide);
  // A first open shows the Overview: the guide's intent, and no chapter's code.
  const slot = await renderWorkspace(store.getGuide("pr-42"));
  await slot.findByRole("button", { name: /^Overview/ });
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(currentChapter(slot)).toBeUndefined();
  expect(slot.queryByText("Parses rows.")).toBeTruthy();
  // The chapter still opens.
  fireEvent.click(chapters(slot).getByRole("button", { name: /Caching/ }));
  await waitFor(() => expect(currentChapter(slot)?.textContent).toContain("Caching"));
  slot.lifecycle.unmount();
});
