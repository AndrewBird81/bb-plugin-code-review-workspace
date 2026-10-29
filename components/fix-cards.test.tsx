// @vitest-environment jsdom
// A sent comment's card (notes/design/E7-plan.md Part 2 §4): which thread reported it and what it said, the review
// agent's check against its Send, Resolve, Dismiss and Reopen, which only your click does, the note's code as code on
// its pill and row too, and Comments' chips for where fixes stand.
import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { StatusFacts } from "../lib/comments";
import type { WorkspaceApi } from "../lib/workspace-context";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
// Pierre's annotations at its rows, new lines 1–3 and old lines 1–2, not its internals.
vi.mock("@pierre/diffs/react", () => ({
  FileDiff: ({ lineAnnotations, renderAnnotation }: any) => <div data-testid="filediff">
    {lineAnnotations?.filter((a: any) => a.lineNumber <= (a.side === "additions" ? 3 : 2)).map((annotation: any, index: number) => <div key={index}>{renderAnnotation?.(annotation)}</div>)}
  </div>,
}));

afterEach(() => { cleanup(); sessionStorage.clear(); });

const patch = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,3 @@\n-old\n-gone\n+new\n+more\n+most\n";
const now = Date.now();
const SENDS: StatusFacts = { posts: false, own: true, sends: [{ n: 1, at: now, threadId: "coder", ids: ["c1", "c2", "c3"] }] };
const done = { file: "src/a.ts", line: 1, side: "RIGHT", body: "Name it.", id: "c1", state: "sent", sendN: 1, claim: { outcome: "done", note: "Renamed it `total`.", commit: "abc1234def", threadId: "coder", at: now } };
const sent = { file: "src/a.ts", line: 3, side: "RIGHT", body: "Test it.", id: "c2", state: "sent", sendN: 1, claim: { outcome: "declined", note: "Covered.", threadId: "sub", at: now } };
const resolved = { file: "src/a.ts", line: 2, side: "LEFT", body: "Why drop it?", id: "c3", state: "resolved", sendN: 1, claim: { outcome: "done", threadId: null, at: now } };

/** A local review's code and its panel, with `drafted`, as the server answers getDraft and each click. */
async function renderCards(drafted: any[], { status = SENDS, workspace = {} }: { status?: StatusFacts; workspace?: Partial<WorkspaceApi> } = {}) {
  await loadPluginApp(() => import("../app"));
  const { DraftTray, testWorkspace } = await import("./draft-tray.test-support");
  const { DiffViewer } = await import("./DiffViewer");
  const { ReviewLinksContext } = await import("../lib/review-links");
  let draft = { targetKey: "k", verdict: "COMMENT", body: "", comments: drafted };
  const checks: Record<string, { verdict: string; evidence: string }> = { c1: { verdict: "addressed", evidence: "Renamed in `a.ts:1`." }, c4: { verdict: "not_addressed", evidence: "Still `<=`." } };
  const answer = () => ({ draft, stale: [], discussions: [], checks });
  const setState = (at: any, state: string) => {
    draft = { ...draft, comments: draft.comments.map((c: any) => c.file === at.file && c.line === at.line && c.side === at.side ? { ...c, state } : c) };
    return answer();
  };
  const resolveComment = vi.fn(async ({ state, ...at }: any) => setState(at, state));
  const reopenComment = vi.fn(async ({ undo, ...at }: any) => setState(at, undo ? "sent" : "open"));
  const component = () => <ReviewLinksContext.Provider value={{ status, editor: null }}>
    <DraftTray targetKey="k" patch={patch} activeChapterId="c1" activeFiles={["src/a.ts"]} reviewRevision="r1" account="reviewer" isLocal workspace={{ review: { ...testWorkspace("k").review, kind: "ref" } as any, ...workspace }}>
      <DiffViewer patch={patch} files={["src/a.ts"]} views={new Map()} onToggleViewed={() => {}} />
    </DraftTray>
  </ReviewLinksContext.Provider>;
  const slot = renderSlot({ component }, {}, { rpc: { setReviewPresence: () => ({ ok: true }), getReviewerNotes: () => ({ body: "", revision: 0 }), getDraft: answer, resolveComment, reopenComment } as any });
  await slot.findByText("Draft saved");
  const card = (name: string) => within(slot.getByTestId("filediff")).findByRole("article", { name });
  return { slot, card, resolveComment, reopenComment };
}

test("a Done card says the main thread reported it, in which commit, and what the check found; Resolve and Reopen come first, and it can't be dismissed or marked pre-existing", async () => {
  const { slot, card } = await renderCards([done]);
  const c1 = within(await card("Draft comment on src/a.ts:1"));
  expect(c1.getByText("Reported by the main thread")).toBeTruthy();
  expect(c1.getByText("abc1234")).toBeTruthy();
  expect(c1.getByText("Addressed")).toBeTruthy();
  expect(c1.getByLabelText("The review agent’s check").parentElement!.textContent).toContain("Renamed in");
  expect(c1.getAllByRole("button").map((button) => button.textContent).slice(0, 3)).toEqual(["Resolve", "Reopen", "Edit"]);
  expect(c1.queryByRole("button", { name: "Dismiss" })).toBeNull();
  expect(c1.queryByRole("button", { name: "Mark as pre-existing" })).toBeNull();
  slot.lifecycle.unmount();
});

test("sent and not reported, a comment is still out: Resolve and Dismiss; once the check finds it not addressed, Reopen too", async () => {
  const { claim: _claim, ...unreported } = done;
  const notFixed = { ...unreported, line: 3, id: "c4" };
  const { slot, card } = await renderCards([unreported, notFixed]);
  const out = within(await card("Draft comment on src/a.ts:1"));
  expect(out.getByRole("button", { name: "Resolve" })).toBeTruthy();
  expect(out.getByRole("button", { name: "Dismiss" })).toBeTruthy();
  expect(out.queryByRole("button", { name: "Reopen" })).toBeNull();
  expect(out.queryByRole("button", { name: "Mark as pre-existing" })).toBeNull();
  const c4 = within(await card("Draft comment on src/a.ts:3"));
  expect(c4.getByText("Not addressed")).toBeTruthy();
  expect(c4.getAllByRole("button").map((button) => button.textContent).slice(0, 3)).toEqual(["Resolve", "Reopen", "Dismiss"]);
  slot.lifecycle.unmount();
});

test("a report from a thread not in your list says so and opens it; one from a shell says the command line, muted under Resolved", async () => {
  const { slot, card } = await renderCards([sent, resolved]);
  const c2 = within(await card("Draft comment on src/a.ts:3"));
  expect(c2.getByText(/^Reported by/).textContent).toBe("Reported by a thread not in your list ↗");
  fireEvent.click(c2.getByRole("button", { name: "a thread not in your list ↗" }));
  expect(slot.inspection.navigateCalls).toContainEqual(expect.objectContaining({ method: "toThread" }));
  expect(c2.getByRole("button", { name: "Dismiss" })).toBeTruthy();
  // Resolved, the card keeps what was reported, which its status line no longer says.
  const c3 = within(await card("Draft comment on src/a.ts:2"));
  expect(c3.getByText("Done").closest(".text-muted-foreground")).toBeTruthy();
  expect(c3.getByText("Reported from the command line")).toBeTruthy();
  expect(c3.getByRole("button", { name: "Reopen" })).toBeTruthy();
  expect(c3.queryByRole("button", { name: "Resolve" })).toBeNull();
  slot.lifecycle.unmount();
});

test("Resolve is your click: the status line offers Undo, which takes the focus and puts it back as sent, with its report; it doesn't open it", async () => {
  const { slot, card, resolveComment, reopenComment } = await renderCards([done]);
  const c1 = within(await card("Draft comment on src/a.ts:1"));
  fireEvent.click(c1.getByRole("button", { name: "Resolve" }));
  await waitFor(() => expect(resolveComment).toHaveBeenCalledWith({ targetKey: "k", file: "src/a.ts", line: 1, side: "RIGHT", state: "resolved" }));
  const undo = await c1.findByRole("button", { name: "Undo" });
  await waitFor(() => expect(document.activeElement).toBe(undo));
  expect(undo.parentElement!.parentElement!.textContent).toBe("Resolved · Undo");
  fireEvent.click(undo);
  await waitFor(() => expect(reopenComment).toHaveBeenCalledWith({ targetKey: "k", file: "src/a.ts", line: 1, side: "RIGHT", undo: true }));
  await c1.findByRole("button", { name: "Resolve" });
  expect(c1.getByText("Reported by the main thread")).toBeTruthy();
  expect(c1.queryByRole("button", { name: "Undo" })).toBeNull();
  slot.lifecycle.unmount();
});

test("Undo goes once the focus leaves the card, and Reopen stays for later: it opens the comment for the next Send", async () => {
  const { slot, card, reopenComment } = await renderCards([done]);
  const article = await card("Draft comment on src/a.ts:1");
  const c1 = within(article);
  fireEvent.click(c1.getByRole("button", { name: "Resolve" }));
  const undo = await c1.findByRole("button", { name: "Undo" });
  fireEvent.focusOut(article, { relatedTarget: document.body });
  await waitFor(() => expect(c1.queryByRole("button", { name: "Undo" })).toBeNull());
  expect(undo.isConnected).toBe(false);
  fireEvent.click(c1.getByRole("button", { name: "Reopen" }));
  await waitFor(() => expect(reopenComment).toHaveBeenCalledWith({ targetKey: "k", file: "src/a.ts", line: 1, side: "RIGHT" }));
  await waitFor(() => expect(c1.queryByRole("button", { name: "Reopen" })).toBeNull());
  expect(c1.queryByText("Reported by the main thread")).toBeNull();
  slot.lifecycle.unmount();
});

test("a note's code shows as code on the folded pill and the list's row too, and nothing else of Markdown", async () => {
  const marked = { ...done, claim: { ...done.claim, note: "Renamed it `total` **now**." } };
  const { slot } = await renderCards([marked], { workspace: { display: { ...(await import("./draft-tray.test-support")).testWorkspace("k").display, commentsFolded: true } } });
  const pill = await within(slot.getByTestId("filediff")).findByRole("group", { name: "Draft comment on src/a.ts:1, folded" });
  expect(pill.querySelector("code")?.textContent).toBe("total");
  // With what the check found, as the row shows it.
  expect(within(pill).getAllByText("Addressed").length).toBeGreaterThan(0);
  expect(pill.textContent).toContain("Done · Renamed it total **now**");
  const row = within(slot.getByRole("region", { name: "Comments" })).getByRole("button", { name: /^Done · Renamed it `total` \*\*now\*\* · src\/a\.ts:1/ });
  expect(row.querySelector("code")?.textContent).toBe("total");
  slot.lifecycle.unmount();
});

test("once a comment was sent, Comments' chips filter by where fixes stand: those with any, after the groups", async () => {
  const open = { file: "src/a.ts", line: 2, side: "LEFT", body: "Not sent." };
  const { slot } = await renderCards([done, sent, open]);
  const list = within(slot.getByRole("region", { name: "Comments" }));
  const chips = list.getByRole("radiogroup", { name: "Show" });
  expect(within(chips).getAllByRole("radio").map((chip) => chip.getAttribute("aria-label"))).toEqual(["All, 3", "Open, 1", "Done, 1", "Declined, 1"]);
  // A local review's comments are just that: nothing here is submitted.
  expect(list.getAllByRole("heading").map((heading) => heading.textContent)).toEqual(["Needs you · 1", "Comments · 3"]);
  expect(list.getByText("+1 in Needs you")).toBeTruthy();
  fireEvent.click(within(chips).getByRole("radio", { name: "Done, 1" }));
  await waitFor(() => expect(list.getAllByRole("button", { name: /^Expand/ })).toHaveLength(1));
  expect(list.getByRole("button", { name: /^Done · Renamed it `total` · src\/a\.ts:1/ })).toBeTruthy();
  // The arrows move between them.
  act(() => { fireEvent.keyDown(within(chips).getByRole("radio", { name: "Done, 1" }), { key: "ArrowRight" }); });
  await waitFor(() => expect(within(chips).getByRole("radio", { name: "Declined, 1" }).getAttribute("aria-checked")).toBe("true"));
  slot.lifecycle.unmount();
});

test("a local review with nothing sent has no chips", async () => {
  const { slot } = await renderCards([{ file: "src/a.ts", line: 1, side: "RIGHT", body: "Not sent." }]);
  expect(within(slot.getByRole("region", { name: "Comments" })).queryByRole("radiogroup")).toBeNull();
  slot.lifecycle.unmount();
});
