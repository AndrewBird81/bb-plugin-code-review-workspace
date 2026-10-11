// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { defaultPreferences } from "../src/preferences";
import { getReviewState, patchReviewState } from "../lib/panel-state";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
// The lines pierre is asked to show something under, and what's shown there.
vi.mock("@pierre/diffs/react", () => ({
  FileDiff: ({ lineAnnotations, renderAnnotation }: any) => (
    <div data-testid="filediff">
      {lineAnnotations?.map((annotation: any, index: number) => <div key={index} data-annotation={`${annotation.side}:${annotation.lineNumber}`}>{renderAnnotation?.(annotation)}</div>)}
    </div>
  ),
}));

afterEach(() => { cleanup(); localStorage.clear(); sessionStorage.clear(); vi.clearAllMocks(); });

const patch = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n one\n-two\n+TWO\n";
const guide = { title: "Guide", intent: "Parses rows.", unplacedFiles: [] as string[], sections: [{ id: "c1", title: "Parsing", overview: "Reads rows.", diffs: [{ file: "src/a.ts", summary: "Reads a row." }] }] };
const comment = (id: string, databaseId: number, author: string, body: string) => ({ id, databaseId, author, body });
const threads = [
  { id: "t1", isResolved: false, isOutdated: false, path: "src/a.ts", line: 2, side: "RIGHT", comments: [comment("c1", 111, "alice", "Why upper case?"), comment("c2", 112, "bob", "It's a constant.")] },
  { id: "t2", isResolved: true, isOutdated: false, path: "src/a.ts", line: 2, side: "LEFT", comments: [comment("c3", 113, "carol", "Old line note.")] },
  { id: "t3", isResolved: false, isOutdated: true, path: "src/a.ts", line: null, side: "RIGHT", comments: [comment("c4", 114, "dave", "This moved.")] },
];

async function renderWorkspace(rpc: Record<string, unknown> = {}) {
  // Opened before, on its first chapter: a first open shows the Overview.
  if (!getReviewState("pr-42").activeId) patchReviewState("pr-42", { activeId: "c1" });
  const app = await loadPluginApp(() => import("../app"));
  const handlers = {
    setReviewPresence: () => ({ ok: true }),
    getReviewBundle: () => ({ review: { targetKey: "pr-42", kind: "pr", status: "ready", createdAt: 1, title: "Parse rows", headSha: "new" }, guide: structuredClone(guide), patch, revision: "r1" }),
    getChecks: () => ({ bucket: "none", checks: [] }),
    getPreferences: () => ({ preferences: defaultPreferences, revision: 0 }),
    getFileViews: () => ({ views: [] }),
    checkRepoAccess: () => ({ accessible: true, repo: "acme/web", account: "me" }),
    checkForUpdates: () => ({ hasNewCommits: false }),
    getDraft: () => ({ draft: { targetKey: "pr-42", verdict: "COMMENT", body: "", comments: [] }, stale: [] }),
    getReviewerNotes: () => ({ body: "", revision: 0 }),
    getConversation: () => ({ threadId: null, legacy: [], defaults: null }),
    markSeen: () => ({ ok: true }),
    getReviewThreads: vi.fn(() => ({ threads: structuredClone(threads) })),
    replyToThread: vi.fn(() => ({ ok: true })),
    resolveThread: vi.fn(() => ({ ok: true })),
    unresolveThread: vi.fn(() => ({ ok: true })),
    ...rpc,
  };
  const slot = renderSlot(app.navPanels[0]!, { subPath: "pr-42" }, { rpc: handlers as any });
  await slot.findByRole("main", { name: "Review" });
  await slot.findByTestId("filediff");
  return { slot, rpc: handlers, file: () => within(slot.container.querySelector<HTMLElement>('[data-file="src/a.ts"]')!) };
}

test("GitHub threads show under their lines, with replies, and resolved and outdated ones folded", async () => {
  const { slot, file } = await renderWorkspace();
  const open = await file().findByRole("article", { name: "GitHub thread on src/a.ts:2" });
  expect(open.closest("[data-annotation]")!.getAttribute("data-annotation")).toBe("additions:2");
  expect(within(open).getByText("Why upper case?")).toBeTruthy();
  expect(within(open).getByText("It's a constant.")).toBeTruthy();
  expect(within(open).getByText("bob")).toBeTruthy();
  const resolved = file().getByRole("article", { name: "GitHub thread on src/a.ts:2 (LEFT side)" });
  expect(within(resolved).getByText("Resolved")).toBeTruthy();
  expect(within(resolved).queryByText("Old line note.")).toBeNull();
  fireEvent.click(within(resolved).getByRole("button", { name: "Show" }));
  expect(within(resolved).getByText("Old line note.")).toBeTruthy();
  const outdated = file().getByRole("button", { name: "1 outdated thread" });
  expect(file().queryByText("This moved.")).toBeNull();
  fireEvent.click(outdated);
  expect(file().getByText("This moved.")).toBeTruthy();
  slot.lifecycle.unmount();
});

test("Reply and Resolve on a thread in the diff go to GitHub, and the toolbar hides the threads", async () => {
  const { slot, rpc, file } = await renderWorkspace();
  const open = await file().findByRole("article", { name: "GitHub thread on src/a.ts:2" });
  fireEvent.click(within(open).getByRole("button", { name: "Reply" }));
  fireEvent.change(within(open).getByRole("textbox", { name: "Reply on src/a.ts:2" }), { target: { value: "Thanks." } });
  fireEvent.click(within(open).getByRole("button", { name: "Send reply" }));
  await waitFor(() => expect(rpc.replyToThread).toHaveBeenCalledWith({ targetKey: "pr-42", inReplyTo: 111, body: "Thanks." }));
  await waitFor(() => expect(rpc.getReviewThreads).toHaveBeenCalledTimes(2));
  fireEvent.click(within(await file().findByRole("article", { name: "GitHub thread on src/a.ts:2" })).getByRole("button", { name: "Resolve" }));
  await waitFor(() => expect(rpc.resolveThread).toHaveBeenCalledWith({ targetKey: "pr-42", threadId: "t1" }));
  const toggle = within(slot.getByRole("main")).getByRole("button", { name: "GitHub threads" });
  expect(toggle.getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(toggle);
  await waitFor(() => expect(file().queryByRole("article", { name: "GitHub thread on src/a.ts:2" })).toBeNull());
  expect(toggle.getAttribute("aria-pressed")).toBe("false");
  slot.lifecycle.unmount();
});

/** Comments' Threads, in the side panel, from the band's Comments where BB's title bar didn't take it. */
async function openThreads(slot: Awaited<ReturnType<typeof renderWorkspace>>["slot"]) {
  fireEvent.click(await slot.findByRole("button", { name: "Comments" }));
  const panel = within(slot.getByRole("complementary", { name: "Comments and agent" }));
  fireEvent.click(panel.getByRole("button", { name: "Threads" }));
  return panel;
}

test("Show in diff in Comments' Threads opens the diff at the thread, beside the list", async () => {
  const { slot, file } = await renderWorkspace();
  const panel = await openThreads(slot);
  await panel.findByText("Why upper case?");
  fireEvent.click(panel.getAllByRole("button", { name: "Show in diff" })[0]);
  expect(await file().findByRole("article", { name: "GitHub thread on src/a.ts:2" })).toBeTruthy();
  expect(panel.getByRole("button", { name: "Threads" }).getAttribute("aria-pressed")).toBe("true");
  slot.lifecycle.unmount();
});

test("Show in diff in Comments' Threads shows GitHub threads in the diff again if they were hidden", async () => {
  const { slot, file } = await renderWorkspace();
  const main = within(slot.getByRole("main"));
  await file().findByRole("article", { name: "GitHub thread on src/a.ts:2" });
  fireEvent.click(main.getByRole("button", { name: "GitHub threads" }));
  const panel = await openThreads(slot);
  await panel.findByText("Why upper case?");
  fireEvent.click(panel.getAllByRole("button", { name: "Show in diff" })[0]);
  expect(await file().findByRole("article", { name: "GitHub thread on src/a.ts:2" })).toBeTruthy();
  expect(main.getByRole("button", { name: "GitHub threads" }).getAttribute("aria-pressed")).toBe("true");
  slot.lifecycle.unmount();
});
