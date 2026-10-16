// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { defaultPreferences } from "../src/preferences";
import { patchReviewState } from "../lib/panel-state";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@pierre/diffs/react", () => ({ FileDiff: () => <div data-testid="filediff" /> }));
// Count whole-patch splits: the distinct results for the review's full patch, since a repeat call that
// returns the last split did no work.
const splits = vi.hoisted(() => ({ results: new Set<unknown>(), patch: "" }));
vi.mock("../src/patch", async (orig) => {
  const actual = await orig<typeof import("../src/patch")>();
  return {
    ...actual,
    splitPatchByFile: (p: string) => {
      const files = actual.splitPatchByFile(p);
      if (p === splits.patch) splits.results.add(files);
      return files;
    },
  };
});

afterEach(() => { cleanup(); localStorage.clear(); sessionStorage.clear(); });

const file = (path: string, lines: number) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,${lines} +1,${lines} @@\n${Array.from({ length: lines }, (_, i) => `-old${i}`).join("\n")}\n${Array.from({ length: lines }, (_, i) => `+new${i}`).join("\n")}\n`;
const paths = Array.from({ length: 300 }, (_, i) => `src/f${i}.ts`);
splits.patch = paths.map((path) => file(path, 20)).join("");
const guide = {
  title: "Guide", intent: "x", unplacedFiles: [],
  sections: [
    { id: "c1", title: "One", overview: "", diffs: paths.slice(0, 150).map((f) => ({ file: f })) },
    { id: "c2", title: "Two", overview: "", diffs: paths.slice(150).map((f) => ({ file: f })) },
  ],
};

test("opening a review splits the full patch at most twice", async () => {
  patchReviewState("pr-42", { activeId: "c1" });
  const app = await loadPluginApp(() => import("../app"));
  const rpc = {
    setReviewPresence: () => ({ ok: true }),
    getReviewBundle: () => ({ review: { targetKey: "pr-42", kind: "pr", status: "ready", createdAt: 1, title: "T", headSha: "h" }, guide: structuredClone(guide), patch: splits.patch, revision: "r1" }),
    getChecks: () => ({ bucket: "none", checks: [] }),
    getPreferences: () => ({ preferences: defaultPreferences, revision: 0 }),
    getFileViews: () => ({ views: [] }),
    checkRepoAccess: () => ({ accessible: true, repo: "acme/web", account: "me" }),
    checkForUpdates: () => ({ hasNewCommits: false }),
    getDraft: () => ({ draft: { targetKey: "pr-42", verdict: "COMMENT", body: "", comments: [] } }),
    getReviewerNotes: () => ({ body: "", revision: 0 }),
    getConversation: () => ({ threadId: null, legacy: [], defaults: null }),
    getSinceReview: () => ({ baseline: null, files: [] }),
    getFeedback: () => ({ feedback: null }),
    markSeen: () => ({ ok: true }),
  };
  splits.results.clear();
  const slot = renderSlot(app.navPanels[0]!, { subPath: "pr-42" }, { rpc: rpc as any });
  await slot.findByRole("main", { name: "Review" });
  await new Promise((r) => setTimeout(r, 200));
  slot.lifecycle.unmount();
  expect(splits.results.size).toBeLessThanOrEqual(2);
});
