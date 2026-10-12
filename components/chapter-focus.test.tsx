// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { defaultPreferences } from "../src/preferences";
import { getReviewState, patchReviewState } from "../lib/panel-state";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@pierre/diffs/react", () => ({ FileDiff: ({ fileDiff }: any) => <pre>{fileDiff.additionLines.join("\n")}</pre> }));

afterEach(() => { cleanup(); localStorage.clear(); sessionStorage.clear(); });

const file = (path: string, hunks: string) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${hunks}`;
const patch = file("src/a.ts", "@@ -1 +1 @@\n-a\n+aa\n") + file("src/b.ts", "@@ -1,2 +1,2 @@\n x\n-b\n+bb\n");
const guide = {
  title: "Guide", intent: "Parses rows.", unplacedFiles: [] as string[],
  sections: [
    { id: "c1", title: "Parsing", overview: "Reads rows.", risk: "high", focus: ["Check that an empty row is skipped.", "Check that `tenant` is kept."], diffs: [{ file: "src/a.ts", summary: "Reads a row." }] },
    { id: "c2", title: "Caching", overview: "Keeps rows.", diffs: [{ file: "src/b.ts", summary: "Caches a row." }] },
  ],
};

function renderWorkspace(sent: object) {
  // Opened before, on its first chapter: a first open shows the Overview.
  if (!getReviewState("pr-42").activeId) patchReviewState("pr-42", { activeId: "c1" });
  return loadPluginApp(() => import("../app")).then((app) => renderSlot(app.navPanels[0]!, { subPath: "pr-42" }, { rpc: {
    setReviewPresence: () => ({ ok: true }),
    getReviewBundle: () => ({ review: { targetKey: "pr-42", kind: "pr", status: "ready", createdAt: 1, title: "Parse rows", headSha: "new" }, guide: structuredClone(sent), patch, revision: "r1" }),
    getChecks: () => ({ bucket: "none", checks: [] }),
    getPreferences: () => ({ preferences: defaultPreferences, revision: 0 }),
    getFileViews: () => ({ views: [] }),
    checkRepoAccess: () => ({ accessible: true, repo: "acme/web", account: "me" }),
    checkForUpdates: () => ({ hasNewCommits: false }),
    getDraft: () => ({ draft: { targetKey: "pr-42", verdict: "COMMENT", body: "", comments: [] }, stale: [] }),
    getReviewerNotes: () => ({ body: "", revision: 0 }),
    getConversation: () => ({ threadId: null, legacy: [], defaults: null }),
    markSeen: () => ({ ok: true }),
  } as any }));
}

test("a chapter's intro lists what to verify under its overview, and hides it with the overview", async () => {
  const slot = await renderWorkspace(guide);
  await slot.findByText("aa");
  const intro = within(slot.getByRole("region", { name: "Parsing" }));
  const focus = intro.getByRole("list", { name: "What to verify" });
  expect(within(focus).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Check that an empty row is skipped.", "Check that tenant is kept."]);
  fireEvent.click(intro.getByRole("button", { name: "Hide chapter overview" }));
  expect(intro.queryByRole("list", { name: "What to verify" })).toBeNull();
  slot.lifecycle.unmount();
}, 15_000);

test("a chapter without focus shows its overview alone", async () => {
  const slot = await renderWorkspace({ ...guide, sections: guide.sections.map(({ focus: _, ...section }: any) => section) });
  await slot.findByText("aa");
  expect(slot.queryByRole("list", { name: "What to verify" })).toBeNull();
  expect(within(slot.getByRole("region", { name: "Parsing" })).getByText("Reads rows.")).toBeTruthy();
  slot.lifecycle.unmount();
}, 15_000);

test("a chapter's intro says where it is, its risk, its size and how much of it you've viewed on one line, and Low risk goes unsaid", async () => {
  const slot = await renderWorkspace({ ...guide, sections: [guide.sections[0], { ...guide.sections[1], risk: "low" }] });
  await slot.findByText("aa");
  const intro = within(slot.getByRole("region", { name: "Parsing" }));
  const meta = intro.getByText("Chapter 1 of 2").parentElement!;
  expect(meta.textContent).toBe("Chapter 1 of 2\u00a0· High risk\u00a0· 1 file\u00a0· 2 lines\u00a0· 0 of 1 viewed");
  expect(intro.getByText("High risk").className).toContain("rounded-full");
  fireEvent.keyDown(document.body, { key: "n" });
  const next = within(await slot.findByRole("region", { name: "Caching" }));
  expect(next.getByText("Chapter 2 of 2").parentElement!.textContent).toBe("Chapter 2 of 2\u00a0· 1 file\u00a0· 2 lines\u00a0· 0 of 1 viewed");
  slot.lifecycle.unmount();
}, 15_000);
