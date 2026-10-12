// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { installTestPluginRuntime, loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { defaultPreferences } from "../src/preferences";
import type { FileInterdiff } from "../src/interdiff";
import { getReviewState, patchReviewState } from "../lib/panel-state";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
// Each file pierre draws: its hunks' kinds of lines, and the comments under them.
const drawn: { name: string; kinds: string[]; partial: boolean }[] = [];
vi.mock("@pierre/diffs/react", () => ({
  FileDiff: ({ fileDiff, lineAnnotations, renderAnnotation }: any) => {
    drawn.push({ name: fileDiff.name, kinds: fileDiff.hunks.flatMap((hunk: any) => hunk.hunkContent.map((content: any) => content.type)), partial: fileDiff.isPartial });
    return <div data-testid="filediff">{lineAnnotations?.map((annotation: any, index: number) => <div key={index}>{renderAnnotation?.(annotation)}</div>)}</div>;
  },
}));

installTestPluginRuntime();
const { DiffViewer } = await import("./DiffViewer");

afterEach(() => { cleanup(); localStorage.clear(); sessionStorage.clear(); vi.clearAllMocks(); drawn.length = 0; });

const file = (path: string, hunks: string) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${hunks}`;
// Only reindented, and reindented around a real change.
const patch = file("src/a.ts", "@@ -1,2 +1,2 @@\n-  one();\n-  two();\n+    one();\n+    two();\n")
  + file("src/b.ts", "@@ -1,2 +1,2 @@\n-  keep();\n-  old();\n+    keep();\n+    fresh();\n");
const guide = { title: "Guide", intent: "Reindents.", unplacedFiles: [] as string[], sections: [{ id: "c1", title: "Indent", overview: "Moves code.", diffs: [{ file: "src/a.ts" }, { file: "src/b.ts" }] }] };
const lastDrawn = (name: string) => drawn.filter((d) => d.name === name).at(-1)!;

async function renderWorkspace() {
  // Opened before, on its first chapter: a first open shows the Overview.
  if (!getReviewState("pr-42").activeId) patchReviewState("pr-42", { activeId: "c1" });
  const app = await loadPluginApp(() => import("../app"));
  const handlers = {
    setReviewPresence: () => ({ ok: true }),
    getReviewBundle: () => ({ review: { targetKey: "pr-42", kind: "pr", status: "ready", createdAt: 1, title: "Reindent", headSha: "new" }, guide: structuredClone(guide), patch, revision: "r1" }),
    getChecks: () => ({ bucket: "none", checks: [] }),
    getPreferences: () => ({ preferences: defaultPreferences, revision: 0 }),
    getFileViews: () => ({ views: [] }),
    checkRepoAccess: () => ({ accessible: true, repo: "acme/web", account: "me" }),
    checkForUpdates: () => ({ hasNewCommits: false }),
    // A comment on a line whose change is only whitespace.
    getDraft: () => ({ draft: { targetKey: "pr-42", verdict: "COMMENT", body: "", comments: [{ file: "src/a.ts", line: 2, side: "RIGHT", body: "Why the extra indent?", author: "reviewer" }] }, stale: [] }),
    getReviewerNotes: () => ({ body: "", revision: 0 }),
    getConversation: () => ({ threadId: null, legacy: [], defaults: null }),
    markSeen: () => ({ ok: true }),
    getFileContents: vi.fn(() => ({ ok: true, old: "  one();\n  two();\n", new: "    one();\n    two();\n" })),
  };
  const slot = renderSlot(app.navPanels[0]!, { subPath: "pr-42" }, { rpc: handlers as any });
  await slot.findByRole("main", { name: "Review" });
  await slot.findAllByTestId("filediff");
  return slot;
}

/** Diff options' Hide whitespace changes. */
async function hideWhitespace(slot: Awaited<ReturnType<typeof renderWorkspace>>) {
  fireEvent.click(within(slot.getByRole("main")).getByRole("button", { name: "Diff options" }));
  return slot.findByRole("switch", { name: "Hide whitespace changes" });
}

test("Hide whitespace changes shows whitespace-only changes as unchanged lines, keeps comments on them, and sticks in this browser", async () => {
  const slot = await renderWorkspace();
  const toggle = await hideWhitespace(slot);
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  expect(lastDrawn("src/a.ts").kinds).toEqual(["change"]);
  fireEvent.click(toggle);
  await waitFor(() => expect(lastDrawn("src/a.ts").kinds).toEqual(["context"]));
  expect(lastDrawn("src/b.ts").kinds).toEqual(["context", "change"]);
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  const a = within(slot.container.querySelector<HTMLElement>('[data-file="src/a.ts"]')!);
  const b = within(slot.container.querySelector<HTMLElement>('[data-file="src/b.ts"]')!);
  expect(a.getByRole("status").textContent).toBe("Only whitespace changed.");
  expect(b.queryByText("Only whitespace changed.")).toBeNull();
  // The file's size is still the PR's, and its comment stays under its line.
  expect(a.getByText("+2")).toBeTruthy();
  expect(await a.findByText("Why the extra indent?")).toBeTruthy();
  slot.lifecycle.unmount();
  drawn.length = 0;

  const again = await renderWorkspace();
  expect((await hideWhitespace(again)).getAttribute("aria-checked")).toBe("true");
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(lastDrawn("src/a.ts").kinds).toEqual(["context"]);
  // Loaded in full, the file still hides them.
  const a2 = within(again.container.querySelector<HTMLElement>('[data-file="src/a.ts"]')!);
  fireEvent.click(a2.getByRole("button", { name: "Expand src/a.ts around its changes" }));
  await waitFor(() => expect(lastDrawn("src/a.ts").partial).toBe(false));
  expect(lastDrawn("src/a.ts").kinds).toEqual(["context"]);
  again.lifecycle.unmount();
});

test("with Since your review on, the changes since then hide their whitespace too", () => {
  const since = new Map<string, FileInterdiff>([["src/b.ts", { file: "src/b.ts", status: "changed", newLines: [2], newDeletions: [], patch: file("src/b.ts", "@@ -1,2 +1,2 @@\n-  keep();\n-  old();\n+    keep();\n+    fresh();\n"), dropped: "" }]]);
  render(<DiffViewer patch={patch} files={["src/b.ts"]} views={new Map()} onToggleViewed={() => {}} since={since} sinceOnly hideWhitespace />);
  expect(lastDrawn("src/b.ts").kinds).toEqual(["context", "change"]);
});
