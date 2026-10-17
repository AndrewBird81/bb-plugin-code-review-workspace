import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { DraftProviderProps } from "./DraftProvider";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
const { toast } = await import("sonner");

// Render the diff's annotations, not @pierre/diffs' internals. Like pierre,
// the gutter "+" reports a line selection right after its own click, and
// annotations show only at rows the diff has: new lines 1–2 and old line 1.
const ROWS: Record<string, number[]> = { additions: [1, 2], deletions: [1] };
vi.mock("@pierre/diffs/react", () => ({
  FileDiff: ({ options, lineAnnotations, renderAnnotation }: any) => {
    const range = { start: 2, end: 2, side: "additions" };
    return (
      <div data-testid="filediff">
        {lineAnnotations?.filter((a: any) => ROWS[a.side]?.includes(a.lineNumber)).map((annotation: any, index: number) => <div key={index}>{renderAnnotation?.(annotation)}</div>)}
        <button onClick={() => { options.onGutterUtilityClick(range); options.onLineSelected(range); }}>Gutter +</button>
      </div>
    );
  },
}));

afterEach(() => { cleanup(); sessionStorage.clear(); vi.clearAllMocks(); });

/** The draft's provider with Comments and Finish review after what it wraps, as the side panel shows them. */
async function draftTray() {
  const { DraftTray } = await import("./draft-tray.test-support");
  return DraftTray;
}

const patch = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,2 @@\n-old\n+new\n+more\n";
const empty = (targetKey: string) => ({ targetKey, verdict: "COMMENT", body: "", comments: [] as any[] });

async function renderReview(targetKey: string, rpc: Record<string, unknown>, onShowComment = vi.fn()) {
  await loadPluginApp(() => import("../app"));
  const DraftTray = await draftTray();
  const { DiffViewer } = await import("./DiffViewer");
  const component = () => (
    <DraftTray targetKey={targetKey} patch={patch} activeChapterId="c1" activeFiles={["src/a.ts"]} reviewRevision="r1" account="reviewer" onShowComment={onShowComment}>
      <DiffViewer patch={patch} files={["src/a.ts"]} views={new Map()} onToggleViewed={() => {}} />
    </DraftTray>
  );
  const slot = renderSlot({ component }, {}, { rpc: { setReviewPresence: () => ({ ok: true }), getReviewerNotes: () => ({ body: "", revision: 0 }), ...rpc } });
  await slot.findByText("Draft saved");
  return { slot, diff: () => within(slot.getByTestId("filediff")), panel: () => within(slot.getByRole("region", { name: "Comments" })) };
}

test("a comment written at a line in the diff joins the draft, and shows there and in the panel", async () => {
  let stored = empty("write");
  const saveDraftComment = vi.fn(async ({ comment }: any) => { stored = { ...stored, comments: [comment] }; return { draft: stored, stale: [] }; });
  const { slot, diff, panel } = await renderReview("write", { getDraft: () => ({ draft: stored, stale: [] }), saveDraftComment });
  fireEvent.click(diff().getByRole("button", { name: "Gutter +" }));
  const box = diff().getByRole("textbox", { name: "Draft comment" });
  await waitFor(() => expect(document.activeElement).toBe(box));
  expect(panel().getByText("Writing a comment on src/a.ts:2")).toBeTruthy();
  fireEvent.change(box, { target: { value: "Cover the empty case." } });
  expect((slot.getByRole("button", { name: /^Submit to GitHub/ }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(diff().getByRole("button", { name: "Add to draft" }));
  await waitFor(() => expect(saveDraftComment).toHaveBeenCalledWith({ targetKey: "write", revision: "r1", replaces: null, comment: { file: "src/a.ts", line: 2, side: "RIGHT", chapterId: "c1", body: "Cover the empty case." } }));
  const shown = await diff().findByRole("article", { name: "Draft comment on src/a.ts:2" });
  expect(within(shown).getByText("Cover the empty case.")).toBeTruthy();
  expect(diff().queryByRole("textbox")).toBeNull();
  expect(panel().getByRole("button", { name: "Draft · not submitted · src/a.ts:2" })).toBeTruthy();
  expect(panel().queryByText(/^Writing a comment/)).toBeNull();
  slot.lifecycle.unmount();
});

test("an agent's comment that arrives on a new box's line shows above it, and saving says it replaces that comment", async () => {
  let stored = empty("race");
  // As the server does: one comment per line, a save refused when it'd replace one the box didn't show.
  const saveDraftComment = vi.fn(async ({ comment, replaces }: any) => {
    const there = stored.comments.find((c) => c.file === comment.file && c.line === comment.line && c.side === comment.side);
    if ((there?.body ?? null) !== replaces) throw new Error("The comment on src/a.ts:2 changed as you wrote, so yours isn’t saved yet.");
    stored = { ...stored, comments: [...stored.comments.filter((c) => c !== there), comment] };
    return { draft: stored, stale: [] };
  });
  const { slot, diff } = await renderReview("race", { getDraft: () => ({ draft: structuredClone(stored), stale: [] }), saveDraftComment });
  fireEvent.click(diff().getByRole("button", { name: "Gutter +" }));
  fireEvent.change(diff().getByRole("textbox", { name: "Draft comment" }), { target: { value: "Mine." } });
  // The agent comments on the line; the box hasn't heard yet, and its save is refused, text kept.
  stored = { ...stored, comments: [{ file: "src/a.ts", line: 2, side: "RIGHT", author: "agent", body: "Is this tested?" }] };
  fireEvent.click(diff().getByRole("button", { name: "Add to draft" }));
  expect(await diff().findByText(/changed as you wrote/)).toBeTruthy();
  expect(saveDraftComment).toHaveBeenLastCalledWith(expect.objectContaining({ replaces: null }));
  expect((diff().getByRole("textbox", { name: "Draft comment" }) as HTMLTextAreaElement).value).toBe("Mine.");
  // Told, the box shows the agent's comment above it, and says saving replaces it.
  await slot.emitRealtime("draft:race", {});
  await diff().findByText("Is this tested?");
  expect(diff().getByText("This line already has a comment. Saving yours replaces it.")).toBeTruthy();
  fireEvent.click(diff().getByRole("button", { name: "Replace comment" }));
  await waitFor(() => expect(saveDraftComment).toHaveBeenLastCalledWith(expect.objectContaining({ replaces: "Is this tested?" })));
  await waitFor(() => expect(stored.comments.map((c) => c.body)).toEqual(["Mine."]));
  slot.lifecycle.unmount();
});

test("a refused save reads the line's comment again, so the next Replace goes through without a realtime event", async () => {
  let stored = empty("refused");
  const saveDraftComment = vi.fn(async ({ comment, replaces }: any) => {
    const there = stored.comments.find((c) => c.file === comment.file && c.line === comment.line && c.side === comment.side);
    if ((there?.body ?? null) !== replaces) throw new Error("The comment on src/a.ts:2 changed as you wrote, so yours isn’t saved yet.");
    stored = { ...stored, comments: [...stored.comments.filter((c) => c !== there), comment] };
    return { draft: stored, stale: [] };
  });
  const { slot, diff } = await renderReview("refused", { getDraft: () => ({ draft: structuredClone(stored), stale: [] }), saveDraftComment });
  fireEvent.click(diff().getByRole("button", { name: "Gutter +" }));
  fireEvent.change(diff().getByRole("textbox", { name: "Draft comment" }), { target: { value: "Mine." } });
  // Another window saves a comment on the line, which publishes nothing.
  stored = { ...stored, comments: [{ file: "src/a.ts", line: 2, side: "RIGHT", author: "agent", body: "Saved elsewhere." }] };
  fireEvent.click(diff().getByRole("button", { name: "Add to draft" }));
  expect(await diff().findByText(/changed as you wrote/)).toBeTruthy();
  await diff().findByText("Saved elsewhere.");
  expect((diff().getByRole("textbox", { name: "Draft comment" }) as HTMLTextAreaElement).value).toBe("Mine.");
  fireEvent.click(diff().getByRole("button", { name: "Replace comment" }));
  await waitFor(() => expect(stored.comments.map((c) => c.body)).toEqual(["Mine."]));
  slot.lifecycle.unmount();
});

test("editing an agent's comment in the diff saves it in place, while its new comments keep arriving", async () => {
  const agents = { file: "src/a.ts", line: 2, side: "RIGHT", author: "agent", body: "Is this tested?" };
  const later = { file: "src/a.ts", line: 1, side: "RIGHT", author: "agent", body: "Name this better?" };
  let stored = { ...empty("edit"), comments: [agents] as any[] };
  const saveDraftComment = vi.fn(async ({ comment }: any) => { stored = { ...stored, comments: stored.comments.map((c) => c.line === comment.line ? comment : c) }; return { draft: stored, stale: [] }; });
  const { slot, diff } = await renderReview("edit", { getDraft: () => ({ draft: structuredClone(stored), stale: [] }), saveDraftComment });
  const shown = await diff().findByRole("article", { name: "Draft comment on src/a.ts:2" });
  fireEvent.click(within(shown).getByRole("button", { name: "Edit" }));
  expect(diff().queryByRole("article", { name: "Draft comment on src/a.ts:2" })).toBeNull();
  const box = diff().getByRole("textbox", { name: "Draft comment" }) as HTMLTextAreaElement;
  expect(box.value).toBe("Is this tested?");
  fireEvent.change(box, { target: { value: "Please add a test for the empty case." } });
  stored = { ...stored, comments: [...stored.comments, later] };
  await slot.emitRealtime("draft:edit", {});
  await diff().findByRole("article", { name: "Draft comment on src/a.ts:1" });
  expect((diff().getByRole("textbox", { name: "Draft comment" }) as HTMLTextAreaElement).value).toBe("Please add a test for the empty case.");
  fireEvent.click(diff().getByRole("button", { name: "Save comment" }));
  // It replaces the comment the box opened on.
  await waitFor(() => expect(saveDraftComment).toHaveBeenCalledWith({ targetKey: "edit", revision: "r1", replaces: "Is this tested?", comment: { file: "src/a.ts", line: 2, side: "RIGHT", chapterId: "c1", body: "Please add a test for the empty case." } }));
  const saved = await diff().findByRole("article", { name: "Draft comment on src/a.ts:2" });
  expect(within(saved).getByText("Please add a test for the empty case.")).toBeTruthy();
  // Yours now.
  expect(within(saved).getByText("Draft · not submitted")).toBeTruthy();
  slot.lifecycle.unmount();
});

test("an edit saved after the agent changed the comment is refused, then says so with the agent's words, and Replace goes through", async () => {
  let stored = { ...empty("edit-race"), comments: [{ file: "src/a.ts", line: 2, side: "RIGHT", author: "agent", body: "Is this tested?" }] as any[] };
  // As the server does: a save refused when it'd replace a comment the box didn't show.
  const saveDraftComment = vi.fn(async ({ comment, replaces }: any) => {
    const there = stored.comments.find((c) => c.file === comment.file && c.line === comment.line && c.side === comment.side);
    if ((there?.body ?? null) !== replaces) throw new Error("The comment on src/a.ts:2 changed as you wrote, so yours isn’t saved yet. Read it, then save yours to replace it.");
    stored = { ...stored, comments: [...stored.comments.filter((c) => c !== there), comment] };
    return { draft: stored, stale: [] };
  });
  const { slot, diff } = await renderReview("edit-race", { getDraft: () => ({ draft: structuredClone(stored), stale: [] }), saveDraftComment });
  fireEvent.click(within(await diff().findByRole("article", { name: "Draft comment on src/a.ts:2" })).getByRole("button", { name: "Edit" }));
  fireEvent.change(diff().getByRole("textbox", { name: "Draft comment" }), { target: { value: "Mine." } });
  // The agent edits the comment; the box hasn't heard yet.
  stored = { ...stored, comments: [{ ...stored.comments[0], body: "Is the empty case tested?" }] };
  fireEvent.click(diff().getByRole("button", { name: "Save comment" }));
  expect(await diff().findByText(/changed as you wrote/)).toBeTruthy();
  expect(saveDraftComment).toHaveBeenLastCalledWith(expect.objectContaining({ replaces: "Is this tested?" }));
  expect(stored.comments.map((c) => c.body)).toEqual(["Is the empty case tested?"]);
  // Read again, the box says what it'd replace, and Replace comment does.
  expect(await diff().findByText("This line’s comment changed while you were editing. Saving yours replaces it:")).toBeTruthy();
  expect(diff().getByText("Is the empty case tested?")).toBeTruthy();
  expect((diff().getByRole("textbox", { name: "Draft comment" }) as HTMLTextAreaElement).value).toBe("Mine.");
  fireEvent.click(diff().getByRole("button", { name: "Replace comment" }));
  await waitFor(() => expect(saveDraftComment).toHaveBeenLastCalledWith(expect.objectContaining({ replaces: "Is the empty case tested?" })));
  await waitFor(() => expect(stored.comments.map((c) => c.body)).toEqual(["Mine."]));
  // The save's own notice to every window, arriving as you edit again, leaves the box as it is.
  fireEvent.click(within(await diff().findByRole("article", { name: "Draft comment on src/a.ts:2" })).getByRole("button", { name: "Edit" }));
  fireEvent.change(diff().getByRole("textbox", { name: "Draft comment" }), { target: { value: "Mine, again." } });
  await slot.emitRealtime("draft:edit-race", {});
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect((diff().getByRole("textbox", { name: "Draft comment" }) as HTMLTextAreaElement).value).toBe("Mine, again.");
  expect(diff().queryByText(/while you were editing/)).toBeNull();
  expect(diff().getByRole("button", { name: "Save comment" })).toBeTruthy();
  slot.lifecycle.unmount();
});

test("the gutter + on a line with a comment opens that comment, and Remove deletes it", async () => {
  const mine = { file: "src/a.ts", line: 2, side: "RIGHT", body: "My comment" };
  const removeDraftComment = vi.fn(() => ({ draft: empty("one-per-line"), stale: [] }));
  const { slot, diff } = await renderReview("one-per-line", { getDraft: () => ({ draft: { ...empty("one-per-line"), comments: [mine] }, stale: [] }), removeDraftComment });
  await diff().findByRole("article", { name: "Draft comment on src/a.ts:2" });
  fireEvent.click(diff().getByRole("button", { name: "Gutter +" }));
  expect((diff().getByRole("textbox", { name: "Draft comment" }) as HTMLTextAreaElement).value).toBe("My comment");
  fireEvent.click(diff().getByRole("button", { name: "Cancel" }));
  fireEvent.click(within(diff().getByRole("article")).getByRole("button", { name: "Remove" }));
  await waitFor(() => expect(removeDraftComment).toHaveBeenCalledWith({ targetKey: "one-per-line", file: "src/a.ts", line: 2, side: "RIGHT" }));
  await waitFor(() => expect(diff().queryByRole("article")).toBeNull());
  slot.lifecycle.unmount();
});

test("commenting on selected lines opens the box at the last line, leaving the panel as it was", async () => {
  await loadPluginApp(() => import("../app"));
  const DraftTray = await draftTray();
  const { DiffViewer } = await import("./DiffViewer");
  const onOpenPanel = vi.fn();
  function Review() {
    const [nonce, setNonce] = useState(0);
    return <>
      <button onClick={() => setNonce((value) => value + 1)}>Comment on selected lines</button>
      <DraftTray targetKey="request" activeChapterId="c1" activeFiles={["src/a.ts"]} reviewRevision="r1" onOpenPanel={onOpenPanel} prefill={nonce ? { file: "src/a.ts", line: 1, side: "RIGHT", nonce } : undefined}>
        <DiffViewer patch={patch} files={["src/a.ts"]} views={new Map()} onToggleViewed={() => {}} />
      </DraftTray>
    </>;
  }
  const slot = renderSlot({ component: Review }, {}, { rpc: { setReviewPresence: () => ({ ok: true }), getReviewerNotes: () => ({ body: "", revision: 0 }), getDraft: () => ({ draft: empty("request"), stale: [] }) } });
  await slot.findByText("Draft saved");
  fireEvent.click(slot.getByRole("button", { name: "Comment on selected lines" }));
  const box = await within(slot.getByTestId("filediff")).findByRole("textbox", { name: "Draft comment" });
  expect(box.closest("[data-draft-at]")?.getAttribute("data-draft-at")).toBe("src/a.ts:1:RIGHT");
  await waitFor(() => expect(document.activeElement).toBe(box));
  expect(onOpenPanel).not.toHaveBeenCalled();
  slot.lifecycle.unmount();
});

test("an unfinished comment in the diff is recovered there after the page reloads", async () => {
  const rpc = { getDraft: () => ({ draft: empty("recover"), stale: [] }) };
  let { slot, diff } = await renderReview("recover", rpc);
  fireEvent.click(diff().getByRole("button", { name: "Gutter +" }));
  fireEvent.change(diff().getByRole("textbox", { name: "Draft comment" }), { target: { value: "Don't lose this" } });
  slot.lifecycle.unmount();
  ({ slot, diff } = await renderReview("recover", rpc));
  expect((diff().getByRole("textbox", { name: "Draft comment" }) as HTMLTextAreaElement).value).toBe("Don't lose this");
  slot.lifecycle.unmount();
});

test("a recovered comment box on a line the diff no longer shows opens in the panel, and doesn't hold Submit unseen", async () => {
  sessionStorage.setItem("guided-review:draft-recovery:stranded", JSON.stringify({ composer: { file: "src/a.ts", line: "40", side: "RIGHT", body: "Stranded text", inline: true, revision: "r1" } }));
  const comments = [{ file: "src/a.ts", line: 2, side: "RIGHT", body: "Existing" }];
  const { slot, diff, panel } = await renderReview("stranded", { getDraft: () => ({ draft: { ...empty("stranded"), comments }, stale: [] }) });
  const box = await panel().findByRole("textbox", { name: "Draft comment" }) as HTMLTextAreaElement;
  expect(box.value).toBe("Stranded text");
  expect(diff().queryByRole("textbox")).toBeNull();
  expect(panel().queryByText(/^Writing a comment/)).toBeNull();
  fireEvent.click(panel().getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect((slot.getAllByRole("button", { name: /^Submit to GitHub/ }) as HTMLButtonElement[]).some((b) => !b.disabled)).toBe(true));
  slot.lifecycle.unmount();
});

test("a recovered box on a hunk the diff hides, narrowed to what changed since, opens in the panel; Show in diff shows all and moves it under its line", async () => {
  sessionStorage.setItem("guided-review:draft-recovery:narrowed", JSON.stringify({ composer: { file: "src/a.ts", line: "2", side: "RIGHT", body: "Hidden text", inline: true, revision: "r1" } }));
  await loadPluginApp(() => import("../app"));
  const DraftTray = await draftTray();
  const { DiffViewer } = await import("./DiffViewer");
  // Since your review only new line 1 changed: line 2's hunk isn't drawn.
  const since = new Map([["src/a.ts", { file: "src/a.ts", status: "changed" as const, newLines: [1], newDeletions: [1], dropped: "", patch: "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n" }]]);
  const showLocation = vi.fn();
  const component = () => {
    const [narrowed, setNarrowed] = useState(true);
    const compare = { baseline: "old", head: "new", from: null, pick: () => {}, since, narrowed, setNarrowed, error: null, what: "your review" };
    return (
      <DraftTray targetKey="narrowed" patch={patch} activeChapterId="c1" activeFiles={["src/a.ts"]} reviewRevision="r1" account="reviewer"
        workspace={{ compare, showLocation: (...at: unknown[]) => { setNarrowed(false); showLocation(...at); } }}>
        <DiffViewer patch={patch} files={["src/a.ts"]} views={new Map()} onToggleViewed={() => {}} since={since} sinceOnly={narrowed} />
      </DraftTray>
    );
  };
  const slot = renderSlot({ component }, {}, { rpc: { setReviewPresence: () => ({ ok: true }), getReviewerNotes: () => ({ body: "", revision: 0 }), getDraft: () => ({ draft: empty("narrowed"), stale: [] }) } as any });
  const panel = within(await slot.findByRole("region", { name: "Comments" }));
  const box = await panel.findByRole("textbox", { name: "Draft comment" }) as HTMLTextAreaElement;
  expect(box.value).toBe("Hidden text");
  expect(within(slot.getByTestId("filediff")).queryByRole("textbox")).toBeNull();
  fireEvent.click(panel.getByRole("button", { name: "Show in diff" }));
  expect(showLocation).toHaveBeenCalledWith("src/a.ts", 2, "RIGHT");
  const moved = await within(slot.getByTestId("filediff")).findByRole("textbox", { name: "Draft comment" }) as HTMLTextAreaElement;
  expect(moved.value).toBe("Hidden text");
  expect(panel.queryByRole("textbox", { name: "Draft comment" })).toBeNull();
  expect(panel.getByText("Writing a comment on src/a.ts:2")).toBeTruthy();
  slot.lifecycle.unmount();
});

test("editing a comment whose line Since your review doesn't draw shows Show in diff in its box, which shows all and moves the box under its line", async () => {
  await loadPluginApp(() => import("../app"));
  const DraftTray = await draftTray();
  const { DiffViewer } = await import("./DiffViewer");
  // Since your review only new line 1 changed: line 2's hunk, and the comment on it, aren't drawn.
  const since = new Map([["src/a.ts", { file: "src/a.ts", status: "changed" as const, newLines: [1], newDeletions: [1], dropped: "", patch: "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n" }]]);
  const showLocation = vi.fn();
  const comments = [{ file: "src/a.ts", line: 2, side: "RIGHT", body: "Name it better." }];
  const component = () => {
    const [narrowed, setNarrowed] = useState(true);
    const compare = { baseline: "old", head: "new", from: null, pick: () => {}, since, narrowed, setNarrowed, error: null, what: "your review" };
    return (
      <DraftTray targetKey="edit-narrowed" patch={patch} activeChapterId="c1" activeFiles={["src/a.ts"]} reviewRevision="r1" account="reviewer"
        workspace={{ compare, showLocation: (...at: unknown[]) => { setNarrowed(false); showLocation(...at); } }}>
        <DiffViewer patch={patch} files={["src/a.ts"]} views={new Map()} onToggleViewed={() => {}} since={since} sinceOnly={narrowed} />
      </DraftTray>
    );
  };
  const slot = renderSlot({ component }, {}, { rpc: { setReviewPresence: () => ({ ok: true }), getReviewerNotes: () => ({ body: "", revision: 0 }), getDraft: () => ({ draft: { ...empty("edit-narrowed"), comments }, stale: [] }) } as any });
  const panel = within(await slot.findByRole("region", { name: "Comments" }));
  fireEvent.click(await panel.findByRole("button", { name: /^Expand .*src\/a\.ts:2/ }));
  fireEvent.click(panel.getByRole("button", { name: "Edit comment on src/a.ts:2" }));
  const card = panel.getByRole("article", { name: "Draft comment on src/a.ts:2" });
  expect((within(card).getByRole("textbox", { name: "Draft comment" }) as HTMLTextAreaElement).value).toBe("Name it better.");
  expect(within(slot.getByTestId("filediff")).queryByRole("textbox")).toBeNull();
  fireEvent.click(within(card).getByRole("button", { name: "Show in diff" }));
  expect(showLocation).toHaveBeenCalledWith("src/a.ts", 2, "RIGHT");
  const moved = await within(slot.getByTestId("filediff")).findByRole("textbox", { name: "Draft comment" }) as HTMLTextAreaElement;
  expect(moved.value).toBe("Name it better.");
  expect(moved.closest("[data-draft-at]")?.getAttribute("data-draft-at")).toBe("src/a.ts:2:RIGHT");
  expect(panel.queryByRole("textbox", { name: "Draft comment" })).toBeNull();
  slot.lifecycle.unmount();
});

test("a comment box in the panel of a draft with no comments doesn't sit above No comments yet", async () => {
  sessionStorage.setItem("guided-review:draft-recovery:alone", JSON.stringify({ composer: { file: "src/a.ts", line: "40", side: "RIGHT", body: "Stranded text", inline: true, revision: "r1" } }));
  const { slot, panel } = await renderReview("alone", { getDraft: () => ({ draft: empty("alone"), stale: [] }) });
  await panel().findByRole("textbox", { name: "Draft comment" });
  expect(panel().queryByText(/^No comments yet/)).toBeNull();
  fireEvent.click(panel().getByRole("button", { name: "Cancel" }));
  await panel().findByText(/^No comments yet/);
  slot.lifecycle.unmount();
});

test("a comment box open in the diff when a rebuild drops its line moves to the panel, text and all", async () => {
  await loadPluginApp(() => import("../app"));
  const DraftTray = await draftTray();
  const { DiffViewer } = await import("./DiffViewer");
  const onOpenPanel = vi.fn();
  // The rebuilt diff adds only line 1.
  const rebuilt = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n";
  function Review() {
    const [shown, setShown] = useState(patch);
    return <>
      <button onClick={() => setShown(rebuilt)}>Rebuild</button>
      <DraftTray targetKey="rebuilt" patch={shown} activeChapterId="c1" activeFiles={["src/a.ts"]} reviewRevision="r1" onOpenPanel={onOpenPanel}>
        <DiffViewer patch={shown} files={["src/a.ts"]} views={new Map()} onToggleViewed={() => {}} />
      </DraftTray>
    </>;
  }
  const slot = renderSlot({ component: Review }, {}, { rpc: { setReviewPresence: () => ({ ok: true }), getReviewerNotes: () => ({ body: "", revision: 0 }), getDraft: () => ({ draft: empty("rebuilt"), stale: [] }) } });
  await slot.findByText("Draft saved");
  const diff = () => within(slot.getByTestId("filediff"));
  fireEvent.click(diff().getByRole("button", { name: "Gutter +" }));
  fireEvent.change(diff().getByRole("textbox", { name: "Draft comment" }), { target: { value: "About line 2" } });
  fireEvent.click(slot.getByRole("button", { name: "Rebuild" }));
  const box = await within(slot.getByRole("region", { name: "Comments" })).findByRole("textbox", { name: "Draft comment" }) as HTMLTextAreaElement;
  expect(box.value).toBe("About line 2");
  expect(diff().queryByRole("textbox")).toBeNull();
  expect(onOpenPanel).toHaveBeenLastCalledWith("comments");
  slot.lifecycle.unmount();
});

test("Esc in a comment box with text leaves the box, keeping the text; Cancel discards it", async () => {
  const { slot, diff } = await renderReview("esc", { getDraft: () => ({ draft: empty("esc"), stale: [] }) });
  fireEvent.click(diff().getByRole("button", { name: "Gutter +" }));
  const box = diff().getByRole("textbox", { name: "Draft comment" }) as HTMLTextAreaElement;
  fireEvent.change(box, { target: { value: "A long careful comment" } });
  act(() => box.focus());
  fireEvent.keyDown(box, { key: "Escape" });
  expect((diff().getByRole("textbox", { name: "Draft comment" }) as HTMLTextAreaElement).value).toBe("A long careful comment");
  expect(document.activeElement).not.toBe(box);
  expect(sessionStorage.getItem("guided-review:draft-recovery:esc")).toContain("A long careful comment");
  fireEvent.click(diff().getByRole("button", { name: "Cancel" }));
  expect(diff().queryByRole("textbox")).toBeNull();
  await waitFor(() => expect(sessionStorage.getItem("guided-review:draft-recovery:esc") ?? "").not.toContain("A long careful comment"));
  slot.lifecycle.unmount();
});

test("Enter or Esc that ends an IME conversion in a comment box does nothing else, Safari's included", async () => {
  const saveDraftComment = vi.fn(() => ({ ok: true, revision: "r1" }));
  const { slot, diff } = await renderReview("ime", { getDraft: () => ({ draft: empty("ime"), stale: [] }), saveDraftComment });
  fireEvent.click(diff().getByRole("button", { name: "Gutter +" }));
  const box = diff().getByRole("textbox", { name: "Draft comment" }) as HTMLTextAreaElement;
  fireEvent.change(box, { target: { value: "東京" } });
  act(() => box.focus());
  fireEvent.keyDown(box, { key: "Enter", ctrlKey: true, isComposing: true, keyCode: 229 });
  // Safari has already cleared isComposing on the key that cancels the conversion.
  fireEvent.keyDown(box, { key: "Escape", keyCode: 229 });
  expect(document.activeElement).toBe(box);
  expect(saveDraftComment).not.toHaveBeenCalled();
  slot.lifecycle.unmount();
});

test("choosing a comment, or the comment being written, in the panel shows it in the diff", async () => {
  const mine = { file: "src/a.ts", line: 1, side: "RIGHT", body: "My comment" };
  const onShowComment = vi.fn();
  const { slot, diff, panel } = await renderReview("show", { getDraft: () => ({ draft: { ...empty("show"), comments: [mine] }, stale: [{ file: "src/a.ts", line: 1, side: "RIGHT" }] }) }, onShowComment);
  fireEvent.click(panel().getByRole("button", { name: "Older diff · not submitted · src/a.ts:1" }));
  expect(onShowComment).toHaveBeenLastCalledWith({ file: "src/a.ts", line: 1, side: "RIGHT" });
  fireEvent.click(diff().getByRole("button", { name: "Gutter +" }));
  fireEvent.click(panel().getByRole("button", { name: "Show in diff" }));
  expect(onShowComment).toHaveBeenLastCalledWith({ file: "src/a.ts", line: 2, side: "RIGHT" });
  slot.lifecycle.unmount();
});

const reviewerSaid = (body: string) => ({ author: "reviewer", kind: "message", body, createdAt: 1 });

test("asking the agent about its comment opens a box under it, and the agent answers in the comment's discussion", async () => {
  const agents = { file: "src/a.ts", line: 2, side: "RIGHT", author: "agent", body: "Is this tested?" };
  let discussions: any[] = [];
  const askAgent = vi.fn(async ({ body }: any) => {
    discussions = [{ file: "src/a.ts", line: 2, side: "RIGHT", waiting: true, entries: [reviewerSaid(body)] }];
    return { draft: { ...empty("ask"), comments: [agents] }, stale: [], discussions };
  });
  const { slot, diff, panel } = await renderReview("ask", { getDraft: () => ({ draft: { ...empty("ask"), comments: [agents] }, stale: [], discussions }), askAgent });
  const shown = await diff().findByRole("article", { name: "Draft comment on src/a.ts:2" });
  fireEvent.click(within(shown).getByRole("button", { name: "Ask agent" }));
  const box = diff().getByRole("textbox", { name: "Message to agent" });
  await waitFor(() => expect(document.activeElement).toBe(box));
  // The box sits under the comment, which stays.
  expect(box.closest("[data-draft-at]")).toBe(diff().getByRole("article", { name: "Draft comment on src/a.ts:2" }).closest("[data-draft-at]"));
  expect(panel().getByText("Writing to the agent about src/a.ts:2")).toBeTruthy();
  fireEvent.change(box, { target: { value: "It is, in a.test.ts." } });
  fireEvent.click(diff().getByRole("button", { name: "Send to agent" }));
  await waitFor(() => expect(askAgent).toHaveBeenCalledWith({ targetKey: "ask", file: "src/a.ts", line: 2, side: "RIGHT", body: "It is, in a.test.ts." }));
  const discussion = await diff().findByRole("region", { name: "Discussion with agent on src/a.ts:2" });
  expect(within(discussion).getByText("It is, in a.test.ts.")).toBeTruthy();
  expect(within(discussion).getByRole("status").textContent).toBe("Waiting for agent…");
  expect(diff().queryByRole("textbox")).toBeNull();
  expect(panel().getByRole("button", { name: "Agent draft · not submitted · src/a.ts:2 · 1 message with the agent · Waiting for agent" })).toBeTruthy();

  discussions = [{ ...discussions[0], waiting: false, entries: [...discussions[0].entries, { author: "agent", kind: "message", body: "Then I'll drop it.", createdAt: 2 }, { author: "agent", kind: "removed", body: "", createdAt: 3 }] }];
  await slot.emitRealtime("draft:ask", {});
  await within(discussion).findByText("Then I'll drop it.");
  expect(within(discussion).queryByRole("status")).toBeNull();
  slot.lifecycle.unmount();
});

test("the comment box can send its text to the agent instead, which starts a discussion at the line until it's dismissed", async () => {
  let discussions: any[] = [];
  const saveDraftComment = vi.fn();
  const askAgent = vi.fn(async ({ body }: any) => {
    discussions = [{ file: "src/a.ts", line: 2, side: "RIGHT", waiting: false, entries: [reviewerSaid(body)] }];
    return { draft: empty("question"), stale: [], discussions };
  });
  const dismissDiscussion = vi.fn(async () => { discussions = []; return { draft: empty("question"), stale: [], discussions }; });
  const { slot, diff } = await renderReview("question", { getDraft: () => ({ draft: empty("question"), stale: [], discussions }), saveDraftComment, askAgent, dismissDiscussion });
  fireEvent.click(diff().getByRole("button", { name: "Gutter +" }));
  fireEvent.change(diff().getByRole("textbox", { name: "Draft comment" }), { target: { value: "Why two lines?" } });
  fireEvent.click(diff().getByRole("button", { name: "Ask agent" }));
  await waitFor(() => expect(askAgent).toHaveBeenCalledWith({ targetKey: "question", file: "src/a.ts", line: 2, side: "RIGHT", body: "Why two lines?" }));
  expect(saveDraftComment).not.toHaveBeenCalled();
  const discussion = await diff().findByRole("region", { name: "Discussion with agent on src/a.ts:2" });
  expect(diff().getByText("Private · with the agent")).toBeTruthy();
  expect(within(discussion).getByText("Why two lines?")).toBeTruthy();
  // The agent finished without answering here.
  expect(within(discussion).getByText("The agent didn’t reply here.")).toBeTruthy();
  expect(diff().queryByRole("article")).toBeNull();
  fireEvent.click(diff().getByRole("button", { name: "Dismiss" }));
  await waitFor(() => expect(dismissDiscussion).toHaveBeenCalledWith({ targetKey: "question", file: "src/a.ts", line: 2, side: "RIGHT" }));
  await waitFor(() => expect(diff().queryByRole("region")).toBeNull());
  slot.lifecycle.unmount();
});

test("asking about selected lines opens a message box at the last line, and quotes from the first", async () => {
  await loadPluginApp(() => import("../app"));
  const DraftTray = await draftTray();
  const { DiffViewer } = await import("./DiffViewer");
  const askAgent = vi.fn(async () => ({ draft: empty("lines"), stale: [], discussions: [] }));
  function Review() {
    const [nonce, setNonce] = useState(0);
    return <>
      <button onClick={() => setNonce((value) => value + 1)}>Ask about selected lines</button>
      <DraftTray targetKey="lines" activeChapterId="c1" activeFiles={["src/a.ts"]} reviewRevision="r1" prefill={nonce ? { file: "src/a.ts", line: 2, side: "RIGHT", startLine: 1, ask: true, nonce } : undefined}>
        <DiffViewer patch={patch} files={["src/a.ts"]} views={new Map()} onToggleViewed={() => {}} />
      </DraftTray>
    </>;
  }
  const slot = renderSlot({ component: Review }, {}, { rpc: { setReviewPresence: () => ({ ok: true }), getReviewerNotes: () => ({ body: "", revision: 0 }), getDraft: () => ({ draft: empty("lines"), stale: [], discussions: [] }), askAgent } });
  await slot.findByText("Draft saved");
  fireEvent.click(slot.getByRole("button", { name: "Ask about selected lines" }));
  const box = await within(slot.getByTestId("filediff")).findByRole("textbox", { name: "Message to agent" });
  expect(box.closest("[data-draft-at]")?.getAttribute("data-draft-at")).toBe("src/a.ts:2:RIGHT");
  fireEvent.change(box, { target: { value: "Why both?" } });
  fireEvent.click(slot.getByRole("button", { name: "Send to agent" }));
  await waitFor(() => expect(askAgent).toHaveBeenCalledWith({ targetKey: "lines", file: "src/a.ts", line: 2, side: "RIGHT", startLine: 1, body: "Why both?" }));
  slot.lifecycle.unmount();
});

test("a comment the agent removed leaves its discussion at the line, and an unsent message to the agent survives a reload", async () => {
  const removed = { file: "src/a.ts", line: 2, side: "RIGHT", waiting: false, entries: [reviewerSaid("Drop this one."), { author: "agent", kind: "removed", body: "", createdAt: 2 }] };
  const rpc = { getDraft: () => ({ draft: empty("stub"), stale: [], discussions: [removed] }) };
  let { slot, diff } = await renderReview("stub", rpc);
  const discussion = await diff().findByRole("region", { name: "Discussion with agent on src/a.ts:2" });
  expect(diff().getByText("Removed by agent")).toBeTruthy();
  expect(within(discussion).getByText("Agent removed the comment.")).toBeTruthy();
  expect(within(discussion).queryByText("The agent didn’t reply here.")).toBeNull();
  fireEvent.click(diff().getByRole("button", { name: "Ask agent" }));
  fireEvent.change(diff().getByRole("textbox", { name: "Message to agent" }), { target: { value: "Why?" } });
  slot.lifecycle.unmount();
  ({ slot, diff } = await renderReview("stub", rpc));
  expect((diff().getByRole("textbox", { name: "Message to agent" }) as HTMLTextAreaElement).value).toBe("Why?");
  slot.lifecycle.unmount();
});

test("after saving or cancelling an edit in the diff, focus goes to the comment's card", async () => {
  const mine = { file: "src/a.ts", line: 2, side: "RIGHT", body: "Mine" };
  const saveDraftComment = vi.fn(async ({ comment }: any) => ({ draft: { ...empty("refocus"), comments: [comment] }, stale: [] }));
  const { slot, diff } = await renderReview("refocus", { getDraft: () => ({ draft: { ...empty("refocus"), comments: [mine] }, stale: [] }), saveDraftComment });
  const card = () => diff().getByRole("article", { name: "Draft comment on src/a.ts:2" });
  fireEvent.click(within(await diff().findByRole("article")).getByRole("button", { name: "Edit" }));
  fireEvent.click(diff().getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(document.activeElement).toBe(card()));
  fireEvent.click(within(card()).getByRole("button", { name: "Edit" }));
  fireEvent.change(diff().getByRole("textbox", { name: "Draft comment" }), { target: { value: "Mine, edited" } });
  fireEvent.click(diff().getByRole("button", { name: "Save comment" }));
  await waitFor(() => expect(document.activeElement).toBe(card()));
  slot.lifecycle.unmount();
});

test("an agent's comment folds how it checked it under its words, in the code and in the panel, and the reviewer's edit leaves it out", async () => {
  const agents = { file: "src/a.ts", line: 2, side: "RIGHT", author: "agent", body: "Is this tested?", evidence: "Read `src/a.test.ts`: no case calls it." };
  let stored = { ...empty("checked"), comments: [agents] as any[] };
  const saveDraftComment = vi.fn(async ({ comment }: any) => { stored = { ...stored, comments: [comment] }; return { draft: stored, stale: [] }; });
  const { slot, diff, panel } = await renderReview("checked", { getDraft: () => ({ draft: structuredClone(stored), stale: [] }), saveDraftComment });
  const shown = within(await diff().findByRole("article", { name: "Draft comment on src/a.ts:2" }));
  const how = shown.getByRole("button", { name: "How the agent checked" });
  expect(how.getAttribute("aria-expanded")).toBe("false");
  expect(shown.queryByText(/no case calls it/)).toBeNull();
  fireEvent.click(how);
  expect(shown.getByText(/no case calls it/)).toBeTruthy();
  // The card in the panel's list has it too.
  fireEvent.click(panel().getByRole("button", { name: "Expand Draft comment on src/a.ts:2" }));
  const card = within(panel().getByRole("article", { name: "Draft comment on src/a.ts:2" }));
  fireEvent.click(card.getByRole("button", { name: "How the agent checked" }));
  expect(card.getByText(/no case calls it/)).toBeTruthy();
  // Rewritten, the comment is the reviewer's: the agent's check no longer goes with it.
  fireEvent.click(shown.getByRole("button", { name: "Edit" }));
  fireEvent.change(diff().getByRole("textbox", { name: "Draft comment" }), { target: { value: "Please add a test." } });
  fireEvent.click(diff().getByRole("button", { name: "Save comment" }));
  await waitFor(() => expect(saveDraftComment).toHaveBeenCalled());
  expect(saveDraftComment.mock.calls[0][0].comment).not.toHaveProperty("evidence");
  await waitFor(() => expect(diff().queryByRole("button", { name: "How the agent checked" })).toBeNull());
  slot.lifecycle.unmount();
});

// bug bash DFT-3: Undo saved the removed comment with the revision the page showed when Undo was clicked, so after a
// rebuild it went back on the new diff's line of the same number, unchecked, over any comment that took it meanwhile.
test("Undo after a rebuild doesn't put the removed comment back on the new diff's line of the same number", async () => {
  await loadPluginApp(() => import("../app"));
  const DraftTray = await draftTray();
  const before = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n one\n-two\n+TWO\n";
  // The new commit puts a line above: line 2 is now "added", and TWO is line 3.
  const after = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,3 @@\n one\n+added\n-two\n+TWO\n";
  const mine = { file: "src/a.ts", line: 2, side: "RIGHT", chapterId: "c1", body: "Upper case reads as a constant." };
  let draft: Record<string, any> = { ...empty("undo-rebuild"), comments: [mine] };
  let current = "r1";
  const removeDraftComment = vi.fn(async () => { draft = { ...draft, comments: [] }; return { draft, stale: [] }; });
  // As the server: a save against a diff the review no longer shows is refused.
  const saveDraftComment = vi.fn(async ({ comment, revision }: any) => {
    if (revision !== current) throw new Error("This review changed in another window. Reload it, then try again.");
    draft = { ...draft, comments: [comment] };
    return { draft, stale: [] };
  });
  const component = () => {
    const [state, setState] = useState({ revision: "r1", patch: before });
    return <>
      <button onClick={() => { current = "r2"; setState({ revision: "r2", patch: after }); }}>Rebuilt</button>
      <DraftTray targetKey="undo-rebuild" activeChapterId="c1" activeFiles={["src/a.ts"]} reviewRevision={state.revision} patch={state.patch} account="reviewer" />
    </>;
  };
  const slot = renderSlot({ component }, {}, { rpc: { setReviewPresence: () => ({ ok: true }), getReviewerNotes: () => ({ body: "", revision: 0 }), getDraft: () => ({ draft, stale: [] }), removeDraftComment, saveDraftComment } as any });
  await slot.findByText("Draft saved");
  fireEvent.click(slot.getByRole("button", { name: "Expand Draft comment on src/a.ts:2" }));
  fireEvent.click(slot.getByRole("button", { name: "Remove comment on src/a.ts:2" }));
  await waitFor(() => expect(toast.info).toHaveBeenCalledWith("Comment removed", expect.objectContaining({ action: expect.objectContaining({ label: "Undo" }) })));
  // The guide finishes rebuilding for a new commit while the toast still offers Undo.
  fireEvent.click(slot.getByRole("button", { name: "Rebuilt" }));
  const [, { action }] = vi.mocked(toast.info).mock.calls[0] as any;
  action.onClick();
  await waitFor(() => expect(saveDraftComment).toHaveBeenCalledTimes(1));
  // Bound to the diff it was removed from, over no comment: the server refuses, and says why.
  expect(saveDraftComment.mock.calls[0][0]).toMatchObject({ revision: "r1", replaces: null, comment: { line: 2, body: mine.body } });
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith("This review changed in another window. Reload it, then try again."));
  expect(draft.comments).toEqual([]);
  slot.lifecycle.unmount();
});

// bug bash DFT-4: a box restored after a reload or a remount took any comment at its line as the one it edited, so a new
// comment's box became an edit of the agent's comment added meanwhile, and Save replaced it unwarned.
const agents = { file: "src/a.ts", line: 2, side: "RIGHT", author: "agent", chapterId: "c1", body: "Agent: this leaks the handle." };
function recovered(targetKey: string, composer: Record<string, unknown>) {
  sessionStorage.setItem(`guided-review:draft-recovery:${targetKey}`, JSON.stringify({ composer: { file: "src/a.ts", line: "2", side: "RIGHT", body: "Mine: rename this.", revision: "r1", ...composer } }));
  let stored: Record<string, any> = { ...empty(targetKey), comments: [agents] };
  const saveDraftComment = vi.fn(async ({ comment }: any) => { stored = { ...stored, comments: [comment] }; return { draft: stored, stale: [] }; });
  return { rpc: { getDraft: () => ({ draft: stored, stale: [] }), saveDraftComment }, saveDraftComment };
}

test("a new comment's box restored after a reload warns before replacing a comment its line got meanwhile", async () => {
  const { rpc, saveDraftComment } = recovered("rec-new", {});
  const { slot, panel } = await renderReview("rec-new", rpc);
  expect((panel().getByRole("textbox", { name: "Draft comment" }) as HTMLTextAreaElement).value).toBe("Mine: rename this.");
  expect(panel().getByText("This line already has a comment. Saving yours replaces it.")).toBeTruthy();
  fireEvent.click(panel().getByRole("button", { name: "Replace comment" }));
  await waitFor(() => expect(saveDraftComment).toHaveBeenCalledWith(expect.objectContaining({ replaces: agents.body, comment: expect.objectContaining({ body: "Mine: rename this." }) })));
  slot.lifecycle.unmount();
});

test("an edit's box restored after a reload stays an edit of its comment while that reads as it did, and becomes a new box once it doesn't", async () => {
  const kept = recovered("rec-edit", { editing: agents.body });
  const first = await renderReview("rec-edit", kept.rpc);
  expect(first.panel().queryByText("This line already has a comment. Saving yours replaces it.")).toBeNull();
  fireEvent.click(first.panel().getByRole("button", { name: "Save comment" }));
  await waitFor(() => expect(kept.saveDraftComment).toHaveBeenCalledWith(expect.objectContaining({ replaces: agents.body })));
  first.slot.lifecycle.unmount();
  cleanup();
  // The agent rewrote its comment meanwhile: the box no longer edits it.
  const changed = recovered("rec-changed", { editing: "Agent: an earlier wording." });
  const second = await renderReview("rec-changed", changed.rpc);
  expect(second.panel().getByText("This line already has a comment. Saving yours replaces it.")).toBeTruthy();
  expect(second.panel().getByRole("button", { name: "Replace comment" })).toBeTruthy();
  second.slot.lifecycle.unmount();
});

test("a comment's edit box keeps which comment it edits for a reload", async () => {
  const { rpc } = recovered("rec-keep", {});
  sessionStorage.clear();
  const { slot, panel } = await renderReview("rec-keep", rpc);
  fireEvent.click(await panel().findByRole("button", { name: /^Expand .*src\/a\.ts:2/ }));
  fireEvent.click(panel().getByRole("button", { name: "Edit comment on src/a.ts:2" }));
  fireEvent.change(panel().getByRole("textbox", { name: "Draft comment" }), { target: { value: "Agent: this leaks the file handle." } });
  await waitFor(() => expect(JSON.parse(sessionStorage.getItem("guided-review:draft-recovery:rec-keep")!).composer).toMatchObject({ body: "Agent: this leaks the file handle.", editing: agents.body }));
  slot.lifecycle.unmount();
});

// bug bash DFT-7: an edit box whose comment a rebuild moved looked for it at its old line, said it "was removed", and
// saving made a second comment.
test("an edit box follows its comment when a rebuild moves it, and says “moved or removed” when it can't tell where", async () => {
  const mine = { file: "src/a.ts", line: 2, side: "RIGHT", body: "Is this tested?" };
  let stored = { ...empty("edit-moved"), comments: [mine] as any[] };
  const saveDraftComment = vi.fn(async ({ comment }: any) => { stored = { ...stored, comments: [comment] }; return { draft: stored, stale: [] }; });
  const { slot, diff, panel } = await renderReview("edit-moved", { getDraft: () => ({ draft: structuredClone(stored), stale: [] }), saveDraftComment });
  fireEvent.click(within(await diff().findByRole("article", { name: "Draft comment on src/a.ts:2" })).getByRole("button", { name: "Edit" }));
  fireEvent.change(diff().getByRole("textbox", { name: "Draft comment" }), { target: { value: "Please add a test." } });
  // A rebuild moves the comment to line 1.
  stored = { ...stored, comments: [{ ...mine, line: 1 }] };
  await slot.emitRealtime("draft:edit-moved", {});
  expect(await panel().findByText("Writing a comment on src/a.ts:1")).toBeTruthy();
  expect(diff().queryByText(/while you were editing/)).toBeNull();
  expect((diff().getByRole("textbox", { name: "Draft comment" }) as HTMLTextAreaElement).value).toBe("Please add a test.");
  fireEvent.click(diff().getByRole("button", { name: "Save comment" }));
  await waitFor(() => expect(saveDraftComment).toHaveBeenCalledWith(expect.objectContaining({ replaces: "Is this tested?", comment: expect.objectContaining({ line: 1, body: "Please add a test." }) })));
  expect(stored.comments).toHaveLength(1);
  // Removed, or one of two with its words: the box can't tell where it went.
  fireEvent.click(within(await diff().findByRole("article", { name: "Draft comment on src/a.ts:1" })).getByRole("button", { name: "Edit" }));
  fireEvent.change(diff().getByRole("textbox", { name: "Draft comment" }), { target: { value: "Mine." } });
  stored = { ...stored, comments: [] };
  await slot.emitRealtime("draft:edit-moved", {});
  expect(await diff().findByText("This line’s comment was moved or removed while you were editing. Saving yours puts it back.")).toBeTruthy();
  slot.lifecycle.unmount();
});
