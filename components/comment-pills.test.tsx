// @vitest-environment jsdom
// Fold comments (i): every card in the code shrinks to a one-line pill that still says what it is, except an open
// comment box; Show opens one, and going to a comment opens its pill.
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { defaultPreferences } from "../src/preferences";
import { patchReviewState } from "../lib/panel-state";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@pierre/diffs/react", () => ({
  FileDiff: ({ lineAnnotations, renderAnnotation }: any) => (
    <div data-testid="filediff">{lineAnnotations?.map((annotation: any, index: number) => <div key={index}>{renderAnnotation?.(annotation)}</div>)}</div>
  ),
}));

afterEach(() => { cleanup(); localStorage.clear(); sessionStorage.clear(); vi.clearAllMocks(); });

const now = Date.now();
const patch = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n-three\n+THREE\n";
const guide = { title: "Guide", intent: "Parses rows.", unplacedFiles: [] as string[], sections: [{ id: "c1", title: "Parsing", overview: "Reads rows.", diffs: [{ file: "src/a.ts" }] }] };
const threads = [
  { id: "t1", isResolved: true, isOutdated: false, path: "src/a.ts", line: 2, side: "RIGHT", resolvedBy: "alice", comments: [
    { id: "c1", databaseId: 1, author: "bob", body: "**Nit:** why upper case?", createdAt: now - 7_200_000 },
    { id: "c2", databaseId: 2, author: "alice", body: "It's a constant.", createdAt: now - 3_600_000 },
  ] },
];

async function renderWorkspace() {
  patchReviewState("pr-42", { activeId: "c1" });
  const app = await loadPluginApp(() => import("../app"));
  const slot = renderSlot(app.navPanels[0]!, { subPath: "pr-42" }, { rpc: {
    setReviewPresence: () => ({ ok: true }),
    getReviewBundle: () => ({ review: { targetKey: "pr-42", kind: "pr", status: "ready", createdAt: 1, title: "Parse rows", headSha: "new" }, guide: structuredClone(guide), patch, revision: "r1" }),
    getChecks: () => ({ bucket: "none", checks: [] }),
    getCheckFailures: () => ({ failures: [{ check: "lint", title: "no-shadow", message: "x is shadowed", file: "src/a.ts", line: 3, url: "https://ci.example/1" }] }),
    getPreferences: () => ({ preferences: defaultPreferences, revision: 0 }),
    getFileViews: () => ({ views: [] }),
    checkRepoAccess: () => ({ accessible: true, repo: "acme/web", account: "me" }),
    checkForUpdates: () => ({ hasNewCommits: false }),
    getDraft: () => ({ draft: { targetKey: "pr-42", verdict: "COMMENT", body: "", comments: [{ file: "src/a.ts", line: 2, side: "RIGHT", author: "agent", severity: "blocking", body: "An entry that expires now is still served." }] }, stale: [] }),
    getReviewerNotes: () => ({ body: "", revision: 0 }),
    getConversation: () => ({ threadId: null, legacy: [], defaults: null }),
    getSinceReview: () => ({ baseline: null, files: [] }),
    markSeen: () => ({ ok: true }),
    getReviewThreads: () => ({ threads: structuredClone(threads) }),
    getFeedback: () => ({ feedback: null }),
    getReplyDrafts: () => ({ drafts: [] }),
  } as any });
  await slot.findByRole("main", { name: "Review" });
  const diff = () => within(slot.getByTestId("filediff"));
  await diff().findByRole("article", { name: "GitHub thread on src/a.ts:2" });
  return { slot, diff };
}
const press = (key: string) => fireEvent.keyDown(document.body, { key });

test("i folds every card in the code to a pill that says who, its state, its first line, and what's under it", async () => {
  const { slot, diff } = await renderWorkspace();
  press("i");
  const draft = await diff().findByRole("group", { name: "Draft comment on src/a.ts:2, folded" });
  expect(draft.textContent).toContain("Agent draft · not submitted · Blocking");
  expect(draft.textContent).toContain("An entry that expires now is still served.");
  const thread = diff().getByRole("group", { name: "GitHub thread on src/a.ts:2, folded" });
  expect(thread.textContent).toContain("@bob");
  expect(thread.textContent).toContain("Resolved");
  // Its first line as plain words.
  expect(thread.textContent).toContain("Nit: why upper case?");
  expect(thread.textContent).toContain("1 reply");
  const check = diff().getByRole("group", { name: "CI failure on src/a.ts:3, folded" });
  expect(check.textContent).toContain("Check failed · lint");
  expect(diff().queryByRole("article")).toBeNull();
  // Again: every card in full.
  press("i");
  await diff().findByRole("article", { name: "Draft comment on src/a.ts:2" });
  slot.lifecycle.unmount();
}, 15_000);

test("Show opens one pill as its card, which folds back; folding them all again starts over", async () => {
  const { slot, diff } = await renderWorkspace();
  press("i");
  fireEvent.click(await diff().findByRole("button", { name: "Show Draft comment on src/a.ts:2" }));
  const card = diff().getByRole("article", { name: "Draft comment on src/a.ts:2" });
  expect(diff().getByRole("group", { name: "GitHub thread on src/a.ts:2, folded" })).toBeTruthy();
  fireEvent.click(within(card.closest("[data-draft-at]")!).getByRole("button", { name: "Fold" }));
  expect(diff().getByRole("group", { name: "Draft comment on src/a.ts:2, folded" })).toBeTruthy();
  fireEvent.click(diff().getByRole("button", { name: "Show GitHub thread on src/a.ts:2" }));
  expect(diff().getByRole("article", { name: "GitHub thread on src/a.ts:2" })).toBeTruthy();
  press("i");
  press("i");
  await waitFor(() => expect(diff().getByRole("group", { name: "GitHub thread on src/a.ts:2, folded" })).toBeTruthy());
  slot.lifecycle.unmount();
});

test("an open comment box never folds", async () => {
  const { slot, diff } = await renderWorkspace();
  fireEvent.click(within(await diff().findByRole("article", { name: "Draft comment on src/a.ts:2" })).getByRole("button", { name: "Edit" }));
  // i from the page, not typed in the box.
  press("i");
  expect(diff().getByRole("textbox", { name: "Draft comment" })).toBeTruthy();
  expect(diff().getByRole("group", { name: "GitHub thread on src/a.ts:2, folded" })).toBeTruthy();
  slot.lifecycle.unmount();
});

test("a thread card you're writing a reply in stays open when comments fold, with your text and the focus", async () => {
  const { slot, diff } = await renderWorkspace();
  const card = within(await diff().findByRole("article", { name: "GitHub thread on src/a.ts:2" }));
  fireEvent.click(card.getByRole("button", { name: "Show" }));
  fireEvent.click(card.getByRole("button", { name: "Reply" }));
  const box = card.getByRole("textbox", { name: "Reply on src/a.ts:2" }) as HTMLTextAreaElement;
  fireEvent.change(box, { target: { value: "Half a thought" } });
  press("i");
  expect(diff().getByRole("group", { name: "Draft comment on src/a.ts:2, folded" })).toBeTruthy();
  expect(diff().queryByRole("group", { name: "GitHub thread on src/a.ts:2, folded" })).toBeNull();
  expect(document.activeElement).toBe(box);
  expect(box.value).toBe("Half a thought");
  // Done with the reply, the card folds with the next fold.
  fireEvent.change(box, { target: { value: "" } });
  fireEvent.keyDown(box, { key: "Escape" });
  press("i");
  press("i");
  await waitFor(() => expect(diff().getByRole("group", { name: "GitHub thread on src/a.ts:2, folded" })).toBeTruthy());
  slot.lifecycle.unmount();
});

test("going to a comment from the list opens its pill", async () => {
  const { slot, diff } = await renderWorkspace();
  press("i");
  await diff().findByRole("group", { name: "GitHub thread on src/a.ts:2, folded" });
  fireEvent.click(await slot.findByRole("button", { name: /^Comments/ }));
  const list = within(slot.getByRole("region", { name: "Comments" }));
  fireEvent.click(await list.findByRole("button", { name: "1 resolved" }));
  fireEvent.click(list.getByRole("button", { name: /^@bob · Resolved · src\/a\.ts:2/ }));
  expect(await diff().findByRole("article", { name: "GitHub thread on src/a.ts:2" })).toBeTruthy();
  expect(diff().getByRole("group", { name: "Draft comment on src/a.ts:2, folded" })).toBeTruthy();
  slot.lifecycle.unmount();
});
