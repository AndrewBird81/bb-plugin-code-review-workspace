// Where a sent comment's fix stands (notes/design/E7-plan.md Part 2 §4): only your click resolves, dismisses or reopens
// it; on your own change only open comments post with Submit, in its checks, its payload and Submit anyway; a reopened
// comment goes with the next Send; and Undo after Remove puts a comment back with its id and where it stood.
import { expect, test, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";

const runGh = vi.hoisted(() => vi.fn());
vi.mock("./gh", async (orig) => ({ ...(await orig<any>()), runGh }));
vi.mock("./store-queue", async (original) => {
  const actual = await original<typeof import("./store-queue")>();
  return { ...actual, queueStore: vi.fn(actual.queueStore) };
});

import { startPlugin } from "./plugin-store.test-support";
import { postable, toGithubReviewPayload, type CommentLocation } from "./draft";
import { setAsk } from "./asks";
import { DRAFT_CHANGED } from "./submit-review";
import type { AsyncStore } from "./store-queue";

// Right lines 1–4 of a.ts are in the diff.
const PATCH = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1,4 @@\n+a\n+b\n+c\n+d\n";
const at = (line: number): CommentLocation => ({ file: "a.ts", line, side: "RIGHT" });
const KEY = "pr-1";

/** gh as GitHub: the PR at sha2, and the review POSTs it takes. */
function gh() {
  runGh.mockReset();
  runGh.mockImplementation(async (args: string[]) => {
    if (args[0] === "auth") return { stdout: "token", stderr: "", code: 0 };
    if (args[0] === "api" && args[1] === "user") return { stdout: "me\n", stderr: "", code: 0 };
    if (args[0] === "pr" && args[1] === "view") return { stdout: JSON.stringify({ headRefOid: "sha2", baseRefName: "main", state: "OPEN" }), stderr: "", code: 0 };
    if (args.includes("repos/acme/web/pulls/12/reviews")) return { stdout: JSON.stringify({ node_id: "R1", user: { login: "me" } }), stderr: "", code: 0 };
    return { stdout: "", stderr: "", code: 0 };
  });
}
/** What Submit gave GitHub, oldest first. */
const posts = () => runGh.mock.calls.filter(([args]) => (args as string[]).includes("repos/acme/web/pulls/12/reviews")).map(([, options]) => JSON.parse((options as { stdin: string }).stdin));

/**
 * Your own PR acme/web#12 (or, `own` false, alice's), whose main thread is `coder`, with comments on lines 1–4, and
 * lines 1–3 sent in Send 1 as c1–c3.
 */
async function sentThree({ own = true } = {}) {
  gh();
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace", sdk: {
    threads: {
      get: async ({ threadId }: { threadId: string }) => ({ id: threadId, title: "Retry uploads", titleFallback: null, archivedAt: null, deletedAt: null, environmentId: null, status: "idle", visibility: "visible", originPluginId: null }),
      send: async () => ({ ok: true, delivery: "sent" }),
      experimental_listAncestors: async ({ threadIds }: { threadIds: string[] }) => ({ threads: threadIds.map((threadId) => ({ threadId, ancestorIds: [] })) }),
    },
  } as any });
  const store = await startPlugin(bb);
  await store.saveReview({ targetKey: KEY, kind: "pr", repo: "acme/web", number: 12, title: "Retry uploads", author: own ? "me" : "alice", base: "main", head: "retry", headSha: "sha2", status: "ready", createdAt: 1, projectId: "p1" });
  await store.setLifecycle(KEY, { ownPr: own, prState: "OPEN", sourceThreadId: "coder", sourceThreadAt: 1 });
  await store.savePatch(KEY, PATCH);
  for (const line of [1, 2, 3, 4]) await store.upsertDraftComment(KEY, { ...at(line), body: `Line ${line}.` });
  const call = (method: string, input: unknown) => harness.behavior.callRpc(method, input) as Promise<any>;
  expect(await call("sendToSourceThread", { targetKey: KEY, comments: [at(1), at(2), at(3)], force: true })).toMatchObject({ ok: true, sendN: 1 });
  const cli = (...argv: string[]) => harness.behavior.runCli(argv, { threadId: "coder", projectId: "p1" });
  return { bb, harness, store, call, cli };
}

const comments = async (store: AsyncStore) => (await store.getDraft(KEY)).comments;
const states = async (store: AsyncStore) => (await comments(store)).map((c) => [c.id ?? null, c.state ?? null]);

/** Submit as the page does, with what it shows, and what it shows posting. */
async function submit(store: AsyncStore, call: (method: string, input: unknown) => Promise<any>, extra: Record<string, unknown> = {}) {
  const { revision } = await call("getReviewBundle", { targetKey: KEY });
  const { comments, body, verdict } = await store.getDraft(KEY);
  const own = (await store.getReview(KEY))!.ownPr !== false;
  const posting = comments.filter((c) => postable(c, own)).map(({ file, line, side }) => ({ file, line, side }));
  return call("submitReview", { targetKey: KEY, revision, account: "me", comments, posting, body, verdict, ...extra });
}

test("only your click resolves or dismisses a comment: no agent tool, command or report does", async () => {
  const { harness, store, call, cli } = await sentThree();
  const registered = harness.inspection.registrations;
  // Nothing an agent or a thread can run takes a comment's state.
  for (const tool of registered.agentTools) expect(JSON.stringify(tool.inputSchema), tool.name).not.toMatch(/"enum":\[[^\]]*"(resolved|dismissed)"/);
  expect(registered.cli!.commands.map((command) => command.name)).not.toEqual(expect.arrayContaining(["resolve", "dismiss", "reopen"]));
  // The main thread's report leaves it sent, and a command can't change your comment.
  expect(await cli("report", "c1", "done", "--note", "Fixed.")).toMatchObject({ exitCode: 0 });
  expect(await cli("comment", "edit", KEY, "a.ts:2", "--body", "Line 2, again.")).toMatchObject({ exitCode: 1 });
  expect(await states(store)).toEqual([["c1", "sent"], ["c2", "sent"], ["c3", "sent"], [null, null]]);
  // Your click does, and keeps the id, the Send and the report.
  await call("resolveComment", { targetKey: KEY, ...at(1), state: "resolved" });
  await call("resolveComment", { targetKey: KEY, ...at(3), state: "dismissed" });
  const [first] = await comments(store);
  expect(first).toMatchObject({ id: "c1", state: "resolved", sendN: 1, claim: { outcome: "done", note: "Fixed.", threadId: "coder" } });
  expect(await states(store)).toEqual([["c1", "resolved"], ["c2", "sent"], ["c3", "dismissed"], [null, null]]);
  // Only c2 is out with the main thread now.
  expect((await store.getReview(KEY))!.fixes).toMatchObject({ sent: 1 });
  await expect(call("resolveComment", { targetKey: KEY, ...at(9), state: "resolved" })).rejects.toThrow("The comment on a.ts:9 is no longer in the draft.");
});

test("on your own change, Submit posts only open comments: never sent, resolved or dismissed ones, which stay in the draft", async () => {
  const { store, call } = await sentThree();
  await call("resolveComment", { targetKey: KEY, ...at(1), state: "resolved" });
  await call("resolveComment", { targetKey: KEY, ...at(2), state: "dismissed" });
  const draft = await store.getDraft(KEY);
  expect(toGithubReviewPayload(draft, false, true).comments.map((c) => c.body)).toEqual(["Line 4."]);
  expect(await submit(store, call)).toEqual({ ok: true, url: undefined });
  expect(posts()).toEqual([{ event: "COMMENT", body: "", comments: [{ path: "a.ts", line: 4, side: "RIGHT", body: "Line 4." }], commit_id: "sha2" }]);
  // GitHub has line 4; the three that didn't post stay, as they were.
  expect(await states(store)).toEqual([["c1", "resolved"], ["c2", "dismissed"], ["c3", "sent"]]);
});

test("on your own change, with only comments that don't post, Submit says it has nothing but the summary to post", async () => {
  const { store, call } = await sentThree();
  await call("removeDraftComment", { targetKey: KEY, ...at(4) });
  expect(await submit(store, call)).toEqual({ ok: false, error: "Add a summary or at least one comment before submitting a Comment review." });
  expect(posts()).toEqual([]);
});

test("Submit anyway never moves a comment that doesn't post into the summary", async () => {
  const { store, call } = await sentThree();
  await call("resolveComment", { targetKey: KEY, ...at(1), state: "resolved" });
  // The diff moves on: every comment is on an older diff now, and lines 3 and 4 are outside it.
  await store.savePatch(KEY, "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1,2 @@\n+a\n+b\n");
  await store.setVerdict(KEY, "COMMENT", "Summary.");
  const warned = await submit(store, call);
  expect(warned).toMatchObject({ ok: false, warnings: ["older-diff"] });
  // Only line 4, open, warns.
  expect(warned.warning).toBe("1 comment was drafted on an older diff (a.ts:4). Submitting anyway moves it into the summary.");
  expect(await submit(store, call, { force: true })).toMatchObject({ ok: true });
  const [posted] = posts();
  expect(posted.comments).toEqual([]);
  expect(posted.body).toContain("Summary.");
  expect(posted.body).toContain("Line 4.");
  for (const line of [1, 2, 3]) expect(posted.body).not.toContain(`Line ${line}.`);
});

test("on a PR you don't own a sent comment still posts; one you resolved or dismissed doesn't", async () => {
  const { store, call } = await sentThree({ own: false });
  await call("resolveComment", { targetKey: KEY, ...at(1), state: "resolved" });
  expect(await submit(store, call)).toMatchObject({ ok: true });
  expect(posts()[0].comments.map((c: { body: string }) => c.body)).toEqual(["Line 2.", "Line 3.", "Line 4."]);
  expect(await states(store)).toEqual([["c1", "resolved"]]);
});

test("a reopened comment goes with the next Send, with its id, and posts with Submit again", async () => {
  const { store, call, cli } = await sentThree();
  for (const [id, outcome] of [["c1", "done"], ["c2", "done"], ["c3", "declined"]]) expect(await cli("report", id!, outcome!)).toMatchObject({ exitCode: 0 });
  expect((await comments(store))[2]!.claim).toMatchObject({ outcome: "declined" });
  await call("resolveComment", { targetKey: KEY, ...at(1), state: "resolved" });
  await call("resolveComment", { targetKey: KEY, ...at(2), state: "resolved" });
  await call("reopenComment", { targetKey: KEY, ...at(3) });
  expect(await states(store)).toEqual([["c1", "resolved"], ["c2", "resolved"], ["c3", "open"], [null, null]]);
  expect(toGithubReviewPayload(await store.getDraft(KEY), false, true).comments.map((c) => c.body)).toEqual(["Line 3.", "Line 4."]);
  // A resolved one isn't sent again until you reopen it.
  await expect(call("sendToSourceThread", { targetKey: KEY, comments: [at(1)] })).rejects.toThrow("The comment on a.ts:1 is resolved. Reopen it to send it again.");
  expect(await call("sendToSourceThread", { targetKey: KEY, comments: [at(3)] })).toMatchObject({ ok: true, sendN: 2 });
  const third = (await comments(store))[2]!;
  expect(third).toMatchObject({ id: "c3", state: "sent", sendN: 2 });
  expect(third.claim).toBeUndefined();
  expect((await store.getReview(KEY))!.fixes).toMatchObject({ sent: 1, reported: 0 });
});

test("Undo after Remove puts a sent comment back with its id, its Send and its report", async () => {
  const { store, call, cli } = await sentThree();
  expect(await cli("report", "c1", "done", "--note", "Renamed it.")).toMatchObject({ exitCode: 0 });
  const [removed] = await comments(store);
  expect(removed!.claim).toMatchObject({ outcome: "done", note: "Renamed it." });
  await call("removeDraftComment", { targetKey: KEY, ...at(1) });
  expect((await store.getReview(KEY))!.fixes).toMatchObject({ sent: 2, reported: 0 });
  const { revision } = await call("getReviewBundle", { targetKey: KEY });
  await call("saveDraftComment", { targetKey: KEY, revision, replaces: null, restore: true, comment: removed });
  expect((await comments(store)).find((c) => c.line === 1)).toEqual(removed);
  expect((await store.getReview(KEY))!.fixes).toMatchObject({ sent: 3, reported: 1 });
});

test("Undo after Remove puts back only an id a Send lists: not another comment's, nor one no Send has", async () => {
  const { store, call } = await sentThree();
  const [, second] = await comments(store);
  await call("removeDraftComment", { targetKey: KEY, ...at(4) });
  const { revision } = await call("getReviewBundle", { targetKey: KEY });
  // Line 4 back as c2, sent in Send 1: c2 is line 2's.
  await call("saveDraftComment", { targetKey: KEY, revision, replaces: null, restore: true, comment: { ...at(4), body: "Line 4.", id: second!.id, state: "sent", sendN: 1 } });
  expect((await comments(store)).find((c) => c.line === 4)).toEqual({ ...at(4), body: "Line 4." });
  // c9, which Send 1 doesn't list, in Send 1 or in a Send 7 the review doesn't have: the counter hands c9 out later.
  for (const sendN of [1, 7]) {
    await call("removeDraftComment", { targetKey: KEY, ...at(4) });
    await call("saveDraftComment", { targetKey: KEY, revision, replaces: null, restore: true, comment: { ...at(4), body: "Line 4.", id: "c9", state: "sent", sendN } });
    expect((await comments(store)).find((c) => c.line === 4)).toEqual({ ...at(4), body: "Line 4." });
  }
  // A save that isn't Undo keeps nothing it's sent.
  await call("removeDraftComment", { targetKey: KEY, ...at(4) });
  await call("saveDraftComment", { targetKey: KEY, revision, replaces: null, comment: { ...at(4), body: "Line 4.", id: "c10", state: "resolved" } });
  expect((await comments(store)).find((c) => c.line === 4)).toEqual({ ...at(4), body: "Line 4." });
});

test("the draft carries what the review agent's check found of each sent comment, against its Send", async () => {
  const { store, call } = await sentThree();
  await store.saveAssessmentItems(KEY, "send:1", [{ id: "c1", verdict: "addressed", evidence: "Renamed in a.ts:1.", assessedAt: 1 }, { id: "c2", verdict: "partial", evidence: "Only half.", assessedAt: 1 }]);
  expect((await call("getDraft", { targetKey: KEY })).checks).toEqual({ c1: { verdict: "addressed", evidence: "Renamed in a.ts:1." }, c2: { verdict: "partial", evidence: "Only half." } });
  // Sent again, c1's check is the new Send's.
  await call("reopenComment", { targetKey: KEY, ...at(1) });
  await call("sendToSourceThread", { targetKey: KEY, comments: [at(1)] });
  expect(Object.keys((await call("getDraft", { targetKey: KEY })).checks)).toEqual(["c2"]);
});

test("Undo right after Resolve or Dismiss puts a comment back as sent, with its report: it goes with no Send and doesn't post", async () => {
  const { store, call, cli } = await sentThree();
  expect(await cli("report", "c1", "done", "--note", "Renamed it.")).toMatchObject({ exitCode: 0 });
  const [before] = await comments(store);
  await call("resolveComment", { targetKey: KEY, ...at(1), state: "resolved" });
  expect((await store.getReview(KEY))!.fixes).toMatchObject({ sent: 2, reported: 0 });
  await call("reopenComment", { targetKey: KEY, ...at(1), undo: true });
  expect((await comments(store))[0]).toEqual(before);
  expect((await store.getReview(KEY))!.fixes).toMatchObject({ sent: 3, reported: 1 });
  // Not open: the next Send, of what's open, leaves it out, and Submit doesn't post it.
  expect(toGithubReviewPayload(await store.getDraft(KEY), false, true).comments.map((c) => c.body)).toEqual(["Line 4."]);
  // Only a resolved or dismissed comment goes back.
  await expect(call("reopenComment", { targetKey: KEY, ...at(4), undo: true })).rejects.toThrow("There's nothing to undo");
  await call("resolveComment", { targetKey: KEY, ...at(2), state: "dismissed" });
  await call("reopenComment", { targetKey: KEY, ...at(2), undo: true });
  expect((await comments(store))[1]).toMatchObject({ id: "c2", state: "sent", sendN: 1 });
});

test("Undo puts back only what the comment was before your click, as the server recorded it: a crafted Undo changes nothing", async () => {
  const { store, call } = await sentThree();
  // Line 4 was never sent: resolved, its Undo makes it open again, not sent.
  await call("resolveComment", { targetKey: KEY, ...at(4), state: "resolved" });
  await call("reopenComment", { targetKey: KEY, ...at(4), undo: true });
  expect((await comments(store))[3]).toEqual({ ...at(4), body: "Line 4.", state: "open" });
  // Nothing to undo now, nor on a comment no click resolved.
  await expect(call("reopenComment", { targetKey: KEY, ...at(4), undo: true })).rejects.toThrow("There's nothing to undo");
  await expect(call("reopenComment", { targetKey: KEY, ...at(1), undo: true })).rejects.toThrow("There's nothing to undo");
  // Reopened instead, its Undo is gone.
  await call("resolveComment", { targetKey: KEY, ...at(2), state: "dismissed" });
  await call("reopenComment", { targetKey: KEY, ...at(2) });
  await call("resolveComment", { targetKey: KEY, ...at(2), state: "resolved" });
  await call("reopenComment", { targetKey: KEY, ...at(2), undo: true });
  expect((await comments(store))[1]).toMatchObject({ id: "c2", state: "open" });
  expect((await comments(store)).map((c) => c.state)).toEqual(["sent", "open", "sent", "open"]);
});

test("after Submit on your own PR, a comment that stays in the draft keeps its discussion, its Undo and its ask; what posted doesn't", async () => {
  const { store, call } = await sentThree();
  const ask = { threadId: "agent", state: "running" as const, at: Date.now() };
  for (const line of [1, 4]) {
    await store.addDiscussionMessage(KEY, at(line), "reviewer", `Is line ${line} right?`);
    await store.noteDiscussionChange(KEY, at(line), "edited", { body: `Line ${line}.`, previous: { body: `Line ${line} before.` } as any });
    await setAsk(store, KEY, at(line), ask);
  }
  await store.setLifecycle(KEY, { summaryAsk: ask });
  expect(await submit(store, call)).toMatchObject({ ok: true });
  expect((await store.listDiscussions(KEY)).map((d) => d.line)).toEqual([1]);
  expect(await store.lastDiscussionChange(KEY, at(1))).toMatchObject({ kind: "edited", body: "Line 1." });
  const review = (await store.getReview(KEY))!;
  expect(review.commentAsks).toEqual([{ ...at(1), ask }]);
  expect(review.summaryAsk ?? null).toBeNull();
});

test("on a PR whose author is you, before the sync has said so, Submit asks GitHub who you are; when it can't tell, nothing posts", async () => {
  const { store, call } = await sentThree();
  await store.setLifecycle(KEY, { ownPr: null });
  // GitHub says you're "me", the author: only the open comment posts.
  expect(await submit(store, call)).toMatchObject({ ok: true });
  expect(posts()[0].comments.map((c: { body: string }) => c.body)).toEqual(["Line 4."]);
});

test("when who you are can't be read, Submit with a comment sent to fix posts nothing", async () => {
  const { store, call } = await sentThree();
  await store.setLifecycle(KEY, { ownPr: null });
  const gh = runGh.getMockImplementation()!;
  runGh.mockImplementation(async (args: string[]) => args[0] === "api" && args[1] === "user" ? { stdout: "", stderr: "offline", code: 1 } : gh(args));
  expect(await submit(store, call)).toEqual({ ok: false, error: "Couldn't tell whether this PR is yours, so nothing posted. Try again in a moment." });
  expect(posts()).toEqual([]);
});

test("Submit refuses a draft whose comments that post changed since the page showed them, as after a Reopen", async () => {
  const { store, call } = await sentThree();
  const { revision } = await call("getReviewBundle", { targetKey: KEY });
  const { comments, body, verdict } = await store.getDraft(KEY);
  // The page showed line 4 posting; c3 is reopened before the click.
  await call("reopenComment", { targetKey: KEY, ...at(3) });
  expect(await call("submitReview", { targetKey: KEY, revision, account: "me", comments, posting: [at(4)], body, verdict })).toEqual({ ok: false, error: DRAFT_CHANGED });
  // Without what it shows posting, a page can't submit a draft with a comment sent.
  expect(await call("submitReview", { targetKey: KEY, revision, account: "me", comments, body, verdict })).toEqual({ ok: false, error: DRAFT_CHANGED });
  expect(posts()).toEqual([]);
  expect(await call("submitReview", { targetKey: KEY, revision, account: "me", comments, posting: [at(3), at(4)], body, verdict })).toMatchObject({ ok: true });
  expect(posts()[0].comments.map((c: { body: string }) => c.body)).toEqual(["Line 3.", "Line 4."]);
});
