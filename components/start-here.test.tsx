// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { defaultPreferences } from "../src/preferences";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@pierre/diffs/react", () => ({ FileDiff: ({ fileDiff }: any) => <pre>{fileDiff.additionLines.join("\n")}</pre> }));

afterEach(() => { cleanup(); localStorage.clear(); sessionStorage.clear(); });

const file = (path: string, hunks: string) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${hunks}`;
const patch = file("src/a.ts", "@@ -1 +1 @@\n-a\n+aa\n") + file("src/b.ts", "@@ -1,2 +1,2 @@\n x\n-b\n+bb\n");
const guide = {
  title: "Guide", intent: "Parses rows.", unplacedFiles: [] as string[],
  sections: [
    { id: "c1", title: "Parsing", overview: "Reads rows.", diffs: [{ file: "src/a.ts", summary: "Reads a row." }] },
    { id: "c2", title: "Caching", overview: "Keeps rows.", diffs: [{ file: "src/b.ts", summary: "Caches a row." }] },
  ],
  hotspots: [{ file: "src/b.ts", line: 2, why: "The cache key ignores `tenant`." }],
};

const rpc = (bundle: object) => ({
  setReviewPresence: () => ({ ok: true }),
  getReviewBundle: () => bundle,
  getChecks: () => ({ bucket: "none", checks: [] }),
  getPreferences: () => ({ preferences: defaultPreferences, revision: 0 }),
  getFileViews: () => ({ views: [] }),
  checkRepoAccess: () => ({ accessible: true, repo: "acme/web", account: "me" }),
  checkForUpdates: () => ({ hasNewCommits: false }),
  getDraft: () => ({ draft: { targetKey: "pr-42", verdict: "COMMENT", body: "", comments: [] }, stale: [] }),
  getReviewerNotes: () => ({ body: "", revision: 0 }),
  getConversation: () => ({ threadId: null, legacy: [], defaults: null }),
  markSeen: () => ({ ok: true }),
});

test("Start here on the Overview lists the guide's hotspots, each opening its line", async () => {
  const app = await loadPluginApp(() => import("../app"));
  const slot = renderSlot(app.navPanels[0]!, { subPath: "pr-42" }, { rpc: rpc({
    review: { targetKey: "pr-42", kind: "pr", status: "ready", createdAt: 1, title: "Parse rows", headSha: "new" }, guide: structuredClone(guide), patch, revision: "r1",
  }) as any });
  const start = within(await slot.findByRole("region", { name: "Start here" }));
  expect(start.getByText("tenant")).toBeTruthy();
  // Named by its line, described by why.
  fireEvent.click(start.getByRole("button", { name: "src/b.ts:2", description: /^The cache key ignores tenant/ }));
  await slot.findByText(/bb/);
  const chapters = within(slot.getByRole("navigation", { name: "Chapters" }));
  await waitFor(() => expect(chapters.getAllByRole("button").find((b) => b.getAttribute("aria-current") === "step")?.textContent).toContain("Caching"));
  slot.lifecycle.unmount();
}, 15_000);

test("a Start here line on removed code opens on the diff's old side", async () => {
  // Hunk 1 holds new-file line 4 and hunk 2 old-file line 4, each in its own chapter.
  const split = file("src/c.ts", "@@ -1,1 +1,4 @@\n a\n+b\n+c\n+d\n@@ -3,2 +6,1 @@\n e\n-check(user);\n");
  const removed = {
    title: "Guide", intent: "Drops a check.", unplacedFiles: [] as string[],
    sections: [
      { id: "c1", title: "Adding", overview: "Adds lines.", diffs: [{ file: "src/c.ts", hunks: [1], summary: "Adds lines." }] },
      { id: "c2", title: "Removing", overview: "Drops the check.", diffs: [{ file: "src/c.ts", hunks: [2], summary: "Drops the check." }] },
    ],
    hotspots: [{ file: "src/c.ts", line: 4, side: "LEFT", why: "The user check is gone." }],
  };
  const app = await loadPluginApp(() => import("../app"));
  const slot = renderSlot(app.navPanels[0]!, { subPath: "pr-42" }, { rpc: rpc({
    review: { targetKey: "pr-42", kind: "pr", status: "ready", createdAt: 1, title: "Drop a check", headSha: "new" }, guide: removed, patch: split, revision: "r1",
  }) as any });
  const start = within(await slot.findByRole("region", { name: "Start here" }));
  fireEvent.click(start.getByRole("button", { name: "src/c.ts:4 (removed line)" }));
  const chapters = within(slot.getByRole("navigation", { name: "Chapters" }));
  await waitFor(() => expect(chapters.getAllByRole("button").find((b) => b.getAttribute("aria-current") === "step")?.textContent).toContain("Removing"));
  slot.lifecycle.unmount();
}, 15_000);
