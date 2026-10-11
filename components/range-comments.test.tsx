// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { defaultPreferences } from "../src/preferences";
import { readDraftRecovery } from "../lib/draft-recovery";

// Render the diff's annotations, not @pierre/diffs' internals, and a drag from line 4 up to line 2 as pierre reports it.
vi.mock("@pierre/diffs/react", () => ({
  FileDiff: ({ options, lineAnnotations, renderAnnotation }: any) => {
    const pick = () => { const range = { start: 4, side: "additions", end: 2, endSide: "additions" }; options.onLineSelectionStart?.(range); options.onLineSelectionEnd?.(range); options.onLineSelected?.(range); };
    return <div data-testid="filediff">
      {lineAnnotations?.map((annotation: any, index: number) => <div key={index}>{renderAnnotation?.(annotation)}</div>)}
      <button onClick={pick}>Drag lines 4 to 2</button>
    </div>;
  },
}));

afterEach(() => { cleanup(); sessionStorage.clear(); });

const patch = [
  "diff --git a/src/a.ts b/src/a.ts", "--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1,3 +1,5 @@",
  " one", // old 1 / new 1
  "-two", // old 2
  "+two();", // new 2
  "+  three();", // new 3
  "+    four;", // new 4
  " five", // old 3 / new 5
  "",
].join("\n");
const draftOf = (comments: any[] = []) => ({ targetKey: "k", verdict: "COMMENT", body: "", comments });

async function renderReview(rpc: Record<string, unknown>, prefill?: Record<string, unknown>) {
  await loadPluginApp(() => import("../app"));
  const { DraftTray } = await import("./DraftTray");
  const { DiffViewer } = await import("./DiffViewer");
  const component = () => (
    <DraftTray targetKey="k" activeChapterId="c1" activeFiles={["src/a.ts"]} reviewRevision="r1" account="reviewer" patch={patch} prefill={prefill as any}>
      <DiffViewer patch={patch} files={["src/a.ts"]} views={new Map()} onToggleViewed={() => {}} />
    </DraftTray>
  );
  const slot = renderSlot({ component }, {}, { rpc: { setReviewPresence: () => ({ ok: true }), getReviewerNotes: () => ({ body: "", revision: 0 }), ...rpc } as any });
  await slot.findByText("Draft saved");
  return { slot, diff: () => within(slot.getByTestId("filediff")), panel: () => within(slot.getByRole("region", { name: "Review draft" })) };
}

test("lines selected upward in the diff make a comment on the range, shown under its last line", async () => {
  let draft = draftOf();
  const saveDraftComment = vi.fn(async ({ comment }: any) => { draft = draftOf([comment]); return { draft, stale: [], discussions: [] }; });
  const { slot, diff, panel } = await renderReview({ getDraft: () => ({ draft, stale: [], discussions: [] }), saveDraftComment },
    { file: "src/a.ts", line: 2, side: "RIGHT", startLine: 4, startSide: "RIGHT", nonce: 1 });
  const box = await diff().findByRole("textbox", { name: "Draft comment" });
  expect(diff().getByText("Lines 2–4")).toBeTruthy();
  expect(panel().getByText("Writing a comment on src/a.ts:2–4 in the diff.")).toBeTruthy();
  fireEvent.change(box, { target: { value: "Fold these." } });
  fireEvent.click(diff().getByRole("button", { name: "Add to draft" }));
  await waitFor(() => expect(saveDraftComment).toHaveBeenCalledWith({ targetKey: "k", revision: "r1", comment: { file: "src/a.ts", line: 4, side: "RIGHT", startLine: 2, chapterId: "c1", body: "Fold these." } }));
  const card = await diff().findByRole("article", { name: "Draft comment on src/a.ts:2–4" });
  expect(within(card).getByText("Lines 2–4")).toBeTruthy();
  expect(panel().getByRole("button", { name: "src/a.ts:2–4" })).toBeTruthy();
  // Editing it in the panel keeps the range.
  fireEvent.click(panel().getByRole("button", { name: "Edit comment on src/a.ts:2–4" }));
  expect(panel().getByText("2–4").parentElement!.textContent).toBe("Lines2–4");
  expect(panel().queryByRole("spinbutton", { name: "Comment line" })).toBeNull();
  fireEvent.change(panel().getByRole("textbox", { name: "Draft comment" }), { target: { value: "Fold these, please." } });
  fireEvent.click(panel().getByRole("button", { name: "Save comment" }));
  await waitFor(() => expect(saveDraftComment).toHaveBeenLastCalledWith(expect.objectContaining({ comment: expect.objectContaining({ line: 4, startLine: 2, body: "Fold these, please." }) })));
  slot.lifecycle.unmount();
});

test("Suggest change fills the box with the selected lines' current text, indentation and all", async () => {
  const { slot, diff } = await renderReview({ getDraft: () => ({ draft: draftOf(), stale: [], discussions: [] }) },
    { file: "src/a.ts", line: 4, side: "RIGHT", startLine: 3, startSide: "RIGHT", nonce: 1 });
  const box = await diff().findByRole("textbox", { name: "Draft comment" }) as HTMLTextAreaElement;
  fireEvent.change(box, { target: { value: "Shorter:" } });
  fireEvent.click(diff().getByRole("button", { name: "Suggest change" }));
  expect(box.value).toBe("Shorter:\n\n```suggestion\n  three();\n    four;\n```");
  // The cursor waits at the end of the lines to edit.
  await waitFor(() => expect([document.activeElement, box.selectionStart]).toEqual([box, box.value.length - 4]));
  slot.lifecycle.unmount();
});

test("Suggest change isn't offered on removed lines", async () => {
  const { slot, diff } = await renderReview({ getDraft: () => ({ draft: draftOf(), stale: [], discussions: [] }) },
    { file: "src/a.ts", line: 2, side: "LEFT", nonce: 1 });
  await diff().findByRole("textbox", { name: "Draft comment" });
  expect(diff().queryByRole("button", { name: "Suggest change" })).toBeNull();
  slot.lifecycle.unmount();
});

test("a comment's suggestion shows as the code it would put in place", async () => {
  const comment = { file: "src/a.ts", line: 4, side: "RIGHT", startLine: 3, body: "Shorter:\n\n```suggestion\n  three(); four;\n```\nThanks." };
  const { slot, diff, panel } = await renderReview({ getDraft: () => ({ draft: draftOf([comment]), stale: [], discussions: [] }) });
  const card = await diff().findByRole("article", { name: "Draft comment on src/a.ts:3–4" });
  for (const where of [within(card), panel()]) {
    const suggestion = where.getByRole("figure", { name: "Suggested change" });
    expect(suggestion.querySelector("pre code")?.textContent).toBe("  three(); four;");
    expect(where.getByText("Shorter:")).toBeTruthy();
    expect(where.getByText("Thanks.")).toBeTruthy();
  }
  slot.lifecycle.unmount();
});

test("in the review, Add comment on lines dragged upward comments on them first to last", async () => {
  const app = await loadPluginApp(() => import("../app"));
  let draft = draftOf();
  const saveDraftComment = vi.fn(async ({ comment }: any) => { draft = draftOf([comment]); return { draft, stale: [], discussions: [] }; });
  const guide = { title: "Guide", intent: "Folds calls.", unplacedFiles: [], sections: [{ id: "c1", title: "Calls", overview: "Folds calls.", diffs: [{ file: "src/a.ts", summary: "Folds." }] }] };
  const slot = renderSlot(app.navPanels[0]!, { subPath: "pr-42" }, { rpc: {
    setReviewPresence: () => ({ ok: true }),
    getReviewBundle: () => ({ review: { targetKey: "pr-42", kind: "pr", status: "ready", createdAt: 1, title: "Fold calls", headSha: "h" }, guide, patch, revision: "r1" }),
    getChecks: () => ({ bucket: "none", checks: [] }),
    getPreferences: () => ({ preferences: defaultPreferences, revision: 0 }),
    getFileViews: () => ({ views: [] }),
    checkRepoAccess: () => ({ accessible: true, repo: "acme/web", account: "me" }),
    checkForUpdates: () => ({ hasNewCommits: false }),
    getDraft: () => ({ draft, stale: [], discussions: [] }),
    getReviewerNotes: () => ({ body: "", revision: 0 }),
    getConversation: () => ({ threadId: null, legacy: [], defaults: null }),
    markSeen: () => ({ ok: true }),
    saveDraftComment,
  } as any });
  await slot.findByRole("heading", { name: "Fold calls" });
  fireEvent.click(await slot.findByRole("button", { name: "Drag lines 4 to 2" }));
  fireEvent.click(within(slot.getByRole("button", { name: "Clear selection" }).parentElement!).getByRole("button", { name: "Add comment" }));
  const box = await within(slot.getByTestId("filediff")).findByRole("textbox", { name: "Draft comment" }) as HTMLTextAreaElement;
  fireEvent.click(within(slot.getByTestId("filediff")).getByRole("button", { name: "Suggest change" }));
  expect(box.value).toBe("```suggestion\ntwo();\n  three();\n    four;\n```");
  fireEvent.click(within(slot.getByTestId("filediff")).getByRole("button", { name: "Add to draft" }));
  await waitFor(() => expect(saveDraftComment).toHaveBeenCalledWith(expect.objectContaining({ comment: expect.objectContaining({ file: "src/a.ts", line: 4, side: "RIGHT", startLine: 2 }) })));
  slot.lifecycle.unmount();
}, 15_000);

test("an unsaved box from before range comments, with a start after its line, comes back on its line alone", () => {
  const box = { file: "src/a.ts", line: "2", side: "RIGHT", body: "Unsaved words" };
  sessionStorage.setItem("guided-review:draft-recovery:k", JSON.stringify({ composer: { ...box, startLine: 4 } }));
  expect(readDraftRecovery("k").composer).toEqual(box);
  // Across sides, a first line's number can be higher than the last's.
  sessionStorage.setItem("guided-review:draft-recovery:k", JSON.stringify({ composer: { ...box, startLine: 4, startSide: "LEFT" } }));
  expect(readDraftRecovery("k").composer).toEqual({ ...box, startLine: 4, startSide: "LEFT" });
});
