// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { defaultPreferences } from "../src/preferences";
import { getReviewState, patchReviewState } from "../lib/panel-state";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@pierre/diffs/react", () => ({
  FileDiff: ({ lineAnnotations, renderAnnotation }: any) => (
    <div data-testid="filediff">
      {lineAnnotations?.map((annotation: any, index: number) => <div key={index} data-annotation={`${annotation.side}:${annotation.lineNumber}`}>{renderAnnotation?.(annotation)}</div>)}
    </div>
  ),
}));

afterEach(() => { cleanup(); localStorage.clear(); sessionStorage.clear(); });

const patch = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n one\n-two\n+TWO\n";
const guide = { title: "Guide", intent: "Parses rows.", unplacedFiles: [] as string[], sections: [{ id: "c1", title: "Parsing", overview: "Reads rows.", diffs: [{ file: "src/a.ts", summary: "Reads a row." }] }] };

test("CI failures show on their lines in the diff, with a link to the check", async () => {
  // Opened before, on its first chapter: a first open shows the Overview.
  if (!getReviewState("pr-42").activeId) patchReviewState("pr-42", { activeId: "c1" });
  const app = await loadPluginApp(() => import("../app"));
  const slot = renderSlot(app.navPanels[0]!, { subPath: "pr-42" }, { rpc: {
    setReviewPresence: () => ({ ok: true }),
    getReviewBundle: () => ({ review: { targetKey: "pr-42", kind: "pr", status: "ready", createdAt: 1, title: "Parse rows", headSha: "new" }, guide: structuredClone(guide), patch, revision: "r1" }),
    getChecks: () => ({ bucket: "fail", checks: [] }),
    getPreferences: () => ({ preferences: defaultPreferences, revision: 0 }),
    getFileViews: () => ({ views: [] }),
    checkRepoAccess: () => ({ accessible: true, repo: "acme/web", account: "me" }),
    checkForUpdates: () => ({ hasNewCommits: false }),
    getDraft: () => ({ draft: { targetKey: "pr-42", verdict: "COMMENT", body: "", comments: [] }, stale: [] }),
    getReviewerNotes: () => ({ body: "", revision: 0 }),
    getConversation: () => ({ threadId: null, legacy: [], defaults: null }),
    markSeen: () => ({ ok: true }),
    getCheckFailures: () => ({ failures: [
      { file: "src/a.ts", line: 2, check: "lint", title: "no-shout", message: "Lower-case it.", url: "https://github.com/acme/web/runs/1" },
      { file: "src/a.ts", line: 40, check: "lint", title: null, message: "Not in the diff.", url: "https://github.com/acme/web/runs/1" },
    ] }),
  } as any });
  await slot.findByTestId("filediff");
  const file = within(slot.container.querySelector<HTMLElement>('[data-file="src/a.ts"]')!);
  const failure = await file.findByRole("note", { name: "CI failure on src/a.ts:2" });
  expect(failure.closest("[data-annotation]")!.getAttribute("data-annotation")).toBe("additions:2");
  expect(within(failure).getByText("Lower-case it.", { exact: false })).toBeTruthy();
  expect(within(failure).getByRole("link", { name: "View check" }).getAttribute("href")).toBe("https://github.com/acme/web/runs/1");
  expect(file.queryByText("Not in the diff.", { exact: false })).toBeNull();
  slot.lifecycle.unmount();
}, 15_000);
