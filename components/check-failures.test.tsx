// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { defaultPreferences } from "../src/preferences";
import { getReviewState, patchReviewState } from "../lib/panel-state";
import { defaultKnobs, type Knobs } from "../lib/knobs";

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

/** The review, opened on its Overview or on `activeId`, with the knobs `getPreferences` returns at each load. */
async function renderReview(knobs: () => Knobs, activeId?: string) {
  if (activeId) patchReviewState("pr-42", { activeId });
  const app = await loadPluginApp(() => import("../app"));
  return renderSlot(app.navPanels[0]!, { subPath: "pr-42" }, { rpc: {
    setReviewPresence: () => ({ ok: true }),
    getReviewBundle: () => ({ review: { targetKey: "pr-42", kind: "pr", status: "ready", createdAt: 1, title: "Parse rows", headSha: "new" }, guide: structuredClone(guide), patch, revision: "r1" }),
    getChecks: () => ({ bucket: "fail", checks: [{ name: "lint", bucket: "fail", state: "FAILURE", link: "https://github.com/acme/web/runs/1" }] }),
    getPreferences: () => ({ preferences: { ...defaultPreferences, knobs: knobs() }, revision: 0 }),
    getFileViews: () => ({ views: [] }),
    checkRepoAccess: () => ({ accessible: true, repo: "acme/web", account: "me" }),
    checkForUpdates: () => ({ hasNewCommits: false }),
    getDraft: () => ({ draft: { targetKey: "pr-42", verdict: "COMMENT", body: "", comments: [] }, stale: [] }),
    getReviewerNotes: () => ({ body: "", revision: 0 }),
    getConversation: () => ({ threadId: null, legacy: [], defaults: null }),
    markSeen: () => ({ ok: true }),
    getCheckFailures: () => ({ failures: [{ file: "src/a.ts", line: 2, check: "lint", title: "no-shout", message: "Lower-case it.", url: "https://github.com/acme/web/runs/1" }] }),
  } as any });
}

test("with CI failures in the code off in Settings, failures aren't read and no line shows one, while the Overview still lists the failing check", async () => {
  const slot = await renderReview(() => ({ ...defaultKnobs, ciInCode: false }));
  const checks = within(await slot.findByRole("region", { name: "Checks" }));
  expect(checks.getByText("lint")).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: "Start reading: Parsing" }));
  await slot.findByTestId("filediff");
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(slot.queryByRole("note", { name: "CI failure on src/a.ts:2" })).toBeNull();
  expect(slot.inspection.rpcCalls.some((call) => call.method === "getCheckFailures")).toBe(false);
  slot.lifecycle.unmount();
}, 15_000);

test("turning CI failures in the code off in Settings takes a shown failure off its line", async () => {
  let knobs: Knobs = defaultKnobs;
  const slot = await renderReview(() => knobs, "c1");
  await slot.findByRole("note", { name: "CI failure on src/a.ts:2" });
  knobs = { ...defaultKnobs, ciInCode: false };
  await slot.emitRealtime("preferences", {});
  await waitFor(() => expect(slot.queryByRole("note", { name: "CI failure on src/a.ts:2" })).toBeNull());
  expect(slot.getByTestId("filediff")).toBeTruthy();
  slot.lifecycle.unmount();
}, 15_000);

/** The review on its chapter, with the failure on src/a.ts:2, the draft's saves recorded, and no conversation yet. */
async function renderChapter(knobs: Knobs = defaultKnobs, message = "Lower-case it.\nSee the style guide.") {
  const saveDraftComment = vi.fn(({ comment }: { comment: object }) => ({ draft: { targetKey: "pr-42", verdict: "COMMENT", body: "", comments: [comment] }, stale: [], discussions: [] }));
  const startConversation = vi.fn(() => ({ threadId: "t1" }));
  patchReviewState("pr-42", { activeId: "c1" });
  const app = await loadPluginApp(() => import("../app"));
  const slot = renderSlot(app.navPanels[0]!, { subPath: "pr-42" }, { rpc: {
    setReviewPresence: () => ({ ok: true }),
    getReviewBundle: () => ({ review: { targetKey: "pr-42", kind: "pr", status: "ready", createdAt: 1, title: "Parse rows", headSha: "new" }, guide: structuredClone(guide), patch, revision: "r1" }),
    getChecks: () => ({ bucket: "fail", checks: [] }),
    getPreferences: () => ({ preferences: { ...defaultPreferences, knobs }, revision: 0 }),
    getFileViews: () => ({ views: [] }),
    checkRepoAccess: () => ({ accessible: true, repo: "acme/web", account: "me" }),
    checkForUpdates: () => ({ hasNewCommits: false }),
    getDraft: () => ({ draft: { targetKey: "pr-42", verdict: "COMMENT", body: "", comments: [] }, stale: [] }),
    getReviewerNotes: () => ({ body: "", revision: 0 }),
    getConversation: () => ({ threadId: null, legacy: [], defaults: { providerId: "codex", model: "gpt-6", reasoningLevel: "medium" } }),
    markSeen: () => ({ ok: true }),
    getCheckFailures: () => ({ failures: [{ file: "src/a.ts", line: 2, check: "lint", title: "no-shout", message, url: "https://github.com/acme/web/runs/1" }] }),
    saveDraftComment, startConversation,
  } as any });
  const failure = await slot.findByRole("note", { name: "CI failure on src/a.ts:2" });
  return { slot, failure: within(failure), saveDraftComment, startConversation };
}

test("a failure's Comment opens the comment box at its line, Blocking, with the failure quoted", async () => {
  const { slot, failure, saveDraftComment } = await renderChapter();
  fireEvent.click(failure.getByRole("button", { name: "Comment on the lint failure at src/a.ts:2" }));
  const box = await slot.findByRole("textbox", { name: /comment/i }) as HTMLTextAreaElement;
  expect(box.value).toBe("> **lint** · no-shout\n> Lower-case it.\n> See the style guide.\n\n");
  expect((slot.getByRole("combobox", { name: "Severity" }) as HTMLSelectElement).value).toBe("blocking");
  fireEvent.change(box, { target: { value: `${box.value}Lower-case it before merging.` } });
  fireEvent.click(slot.getByRole("button", { name: "Add to draft" }));
  await waitFor(() => expect(saveDraftComment).toHaveBeenCalledWith(expect.objectContaining({ comment: expect.objectContaining({ file: "src/a.ts", line: 2, side: "RIGHT", severity: "blocking", body: "> **lint** · no-shout\n> Lower-case it.\n> See the style guide.\n\nLower-case it before merging." }) })));
  slot.lifecycle.unmount();
}, 15_000);

test("a failure's Comment quotes an image in its message as a link, so your comment loads nothing", async () => {
  const { slot, failure } = await renderChapter(defaultKnobs, "Lower-case it. ![badge](https://evil.example/p.png)");
  fireEvent.click(failure.getByRole("button", { name: "Comment on the lint failure at src/a.ts:2" }));
  const box = await slot.findByRole("textbox", { name: /comment/i }) as HTMLTextAreaElement;
  expect(box.value).toBe("> **lint** · no-shout\n> Lower-case it. [Image: badge](https://evil.example/p.png)\n\n");
  slot.lifecycle.unmount();
}, 15_000);

test("a failure's Ask agent puts it into the agent's box, fenced as CI output, unsent", async () => {
  const { slot, failure, startConversation } = await renderChapter();
  fireEvent.click(failure.getByRole("button", { name: "Ask agent about the lint failure at src/a.ts:2" }));
  const agent = within(await slot.findByRole("region", { name: "Review agent" }));
  await waitFor(() => expect((agent.getByRole("textbox", { name: "Ask the agent" }) as HTMLTextAreaElement).value).toBe("In `src/a.ts` line 2, a check fails:\n```text\n<untrusted source=\"CI annotation\">\nlint · no-shout\nLower-case it.\nSee the style guide.\n</untrusted>\n```"));
  expect(startConversation).not.toHaveBeenCalled();
  slot.lifecycle.unmount();
}, 15_000);

test("with Comment on or ask about a failing check off, a failure offers View check alone", async () => {
  const { slot, failure } = await renderChapter({ ...defaultKnobs, checkFailureActions: false });
  expect(failure.getByRole("link", { name: "View check" })).toBeTruthy();
  expect(failure.queryAllByRole("button")).toEqual([]);
  slot.lifecycle.unmount();
}, 15_000);
