import { expect, test, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { createStore } from "./store";
import { commentsKey, SUMMARY_AT } from "./draft";
import { writeSummary } from "./draft-summary";
import { reviewRevision } from "./review-revision";
import { runGh } from "./gh";

vi.mock("./gh", async (original) => ({ ...await original<typeof import("./gh")>(), runGh: vi.fn() }));

const patch = [
  "diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", "@@ -1,3 +1,4 @@",
  " const a = 1;", "-const b = 2;", "+const b = 3;", "+const c = b * 2;", " export { a };", "",
].join("\n");
const at = { file: "a.ts", line: 3, side: "RIGHT" } as const;

async function host() {
  const { bb, harness } = createFakePluginHost({ pluginId: "guided-review" });
  await plugin(bb);
  const store = createStore(bb);
  store.saveReview({ targetKey: "pr-1", kind: "pr", number: 1, repo: "acme/web", status: "ready", createdAt: 1, headSha: "sha1" });
  store.savePatch("pr-1", patch);
  store.setAssistantThread("pr-1", "assistant");
  const tool = (name: string, input: Record<string, unknown>) => harness.behavior.callAgentTool(name, input, { threadId: "assistant" }) as Promise<any>;
  const call = (method: string, input: Record<string, unknown>) => harness.behavior.callRpc(method, { targetKey: "pr-1", ...input }) as Promise<any>;
  const error = (result: any) => (result.isError ? result.content[0].text : null) as string | null;
  const signals = () => harness.inspection.realtimeSignals.filter((signal) => signal.channel === "draft:pr-1").length;
  const ask = (where: typeof at | typeof SUMMARY_AT, body: string) => store.addDiscussionMessage("pr-1", where, "reviewer", body);
  return { store, tool, call, error, signals, ask };
}

test("the assistant writes an empty or an agent's summary and suggests a verdict, and nothing reaches GitHub", async () => {
  const { store, tool, signals } = await host();
  expect(await tool("set_review_summary", { body: " Looks right; one risk at a.ts:3. ", verdict: "APPROVE" }))
    .toBe("Wrote the review summary. Your suggested verdict, Approve, is marked for the reviewer, who picks the verdict. It stays in bb until the reviewer submits the review.");
  expect(store.getDraft("pr-1")).toEqual({ targetKey: "pr-1", verdict: "COMMENT", body: "Looks right; one risk at a.ts:3.", comments: [],
    bodyAuthor: "agent", suggestedVerdict: "APPROVE", written: { verdict: "APPROVE", comments: commentsKey([]) } });

  // Without a verdict, the suggestion stays, and the summary is written for no verdict until the reviewer picks one.
  expect(await tool("set_review_summary", { body: "Looks right." })).toBe("Wrote the review summary. It stays in bb until the reviewer submits the review.");
  expect(store.getDraft("pr-1")).toMatchObject({ body: "Looks right.", bodyAuthor: "agent", suggestedVerdict: "APPROVE", written: { verdict: null } });
  store.setVerdict("pr-1", "REQUEST_CHANGES");
  store.upsertDraftComment("pr-1", { ...at, body: "Overflow?" });
  await tool("set_review_summary", { body: "One blocker at a.ts:3." });
  expect(store.getDraft("pr-1")).toMatchObject({ verdict: "REQUEST_CHANGES", verdictChosen: true, bodyAuthor: "agent",
    written: { verdict: "REQUEST_CHANGES", comments: commentsKey([{ ...at, body: "Overflow?" }]) } });
  expect(signals()).toBe(3);

  expect(await tool("list_draft_comments", {})).toBe([
    "Review summary · written by an agent",
    "  One blocker at a.ts:3.",
    "Verdict: the reviewer picked Request changes.",
    "An agent's suggested verdict: Approve.",
    "1 draft comment:",
    "a.ts:3 RIGHT · added by the reviewer\n  Overflow?",
  ].join("\n"));
  expect(runGh).not.toHaveBeenCalled();
});

test("a summary the reviewer wrote is refused, unless they asked on it; then it stays theirs", async () => {
  const { store, tool, error, ask } = await host();
  store.updateSummary("pr-1", { body: "My summary." });
  const refused = error(await tool("set_review_summary", { body: "Better summary.", verdict: "APPROVE" }));
  expect(refused).toBe("The reviewer wrote the review summary, so it stays as they wrote it. Put your suggested summary in your reply instead; the reviewer can ask on the summary (Ask agent on the review summary, in Draft review) to apply it. Nothing was changed.");
  expect(store.getDraft("pr-1")).toEqual({ targetKey: "pr-1", verdict: "COMMENT", body: "My summary.", comments: [] });
  // A discussion on a line isn't a request about the summary.
  ask(at, "Comment here?");
  expect(error(await tool("set_review_summary", { body: "Better summary." }))).toBe(refused);
  expect(await tool("list_draft_comments", {})).toContain("Review summary · written by the reviewer\n  My summary.\nVerdict: the reviewer hasn't picked one, so it's Comment by default.\nThe draft has no comments.");

  ask(SUMMARY_AT, "Make it shorter.");
  expect(await tool("set_review_summary", { body: "Short.", verdict: "COMMENT" })).toContain("Updated the reviewer's review summary, as they asked.");
  expect(store.getDraft("pr-1")).toEqual({ targetKey: "pr-1", verdict: "COMMENT", body: "Short.", comments: [], suggestedVerdict: "COMMENT" });
  const summary = store.listDiscussions("pr-1").find((d) => d.file === "")!;
  expect(summary).toMatchObject({ waiting: false, entries: [{ kind: "message" }, { author: "agent", kind: "edited", body: "Short." }] });
  expect(store.lastDiscussionChange("pr-1", SUMMARY_AT)).toEqual({ kind: "edited", body: "Short.", previous: { body: "My summary." } });
  // Answered, the request is over.
  expect(error(await tool("set_review_summary", { body: "Shorter." }))).toBe(refused);
});

test("a review being regenerated, merged, or closed takes no summary", async () => {
  const { store } = await host();
  store.setStatus("pr-1", "generating");
  expect(writeSummary(store, "pr-1", { body: "x" })).toEqual({ ok: false, error: expect.stringContaining("being regenerated") });
  store.setStatus("pr-1", "ready");
  store.setLifecycle("pr-1", { prState: "MERGED" });
  expect(writeSummary(store, "pr-1", { body: "x" })).toEqual({ ok: false, error: expect.stringContaining("merged") });
  expect(writeSummary(store, "nope", { body: "x" })).toEqual({ ok: false, error: "This review no longer exists." });
  expect(store.getDraft("pr-1").body).toBe("");
});

test("the reviewer undoes the agent's latest change to the summary, until something else changes it", async () => {
  const { store, tool, call, ask } = await host();
  ask(SUMMARY_AT, "Write one.");
  await tool("set_review_summary", { body: "First." });
  expect(store.lastDiscussionChange("pr-1", SUMMARY_AT)).toEqual({ kind: "added", body: "First.", previous: { body: "" } });
  expect((await call("getDraft", {})).discussions).toEqual([expect.objectContaining({ ...SUMMARY_AT, undoable: true })]);
  const undone = await call("undoAgentChange", SUMMARY_AT);
  expect(undone.draft).toEqual({ targetKey: "pr-1", verdict: "COMMENT", body: "", comments: [] });
  expect(undone.discussions[0].entries.at(-1)).toMatchObject({ author: "reviewer", kind: "restored" });
  expect(undone.discussions[0]).not.toHaveProperty("undoable");
  await expect(call("undoAgentChange", SUMMARY_AT)).rejects.toThrow("It changed since the agent's edit, so there's nothing to undo. Edit it instead.");

  await tool("set_review_summary", { body: "Second." });
  const second = store.getDraft("pr-1");
  await tool("set_review_summary", { body: "Third." });
  expect(store.lastDiscussionChange("pr-1", SUMMARY_AT)).toEqual({ kind: "edited", body: "Third.", previous: { body: "Second.", author: "agent", written: second.written } });
  expect((await call("undoAgentChange", SUMMARY_AT)).draft).toEqual(second);

  await tool("set_review_summary", { body: "Fourth." });
  await call("saveSummary", { body: "Mine now.", revision: reviewRevision(store, "pr-1") });
  expect((await call("getDraft", {})).discussions[0]).not.toHaveProperty("undoable");
  await expect(call("undoAgentChange", SUMMARY_AT)).rejects.toThrow("It changed since the agent's edit");
  expect(store.getDraft("pr-1").body).toBe("Mine now.");
});

test("the reviewer undoes the agent's latest change to a comment: added, edited, or removed", async () => {
  const { store, tool, call, ask } = await host();
  ask(at, "Comment here?");
  await tool("add_draft_comment", { ...at, code: "const c = b * 2;", body: "Overflow?" });
  expect((await call("undoAgentChange", at)).draft.comments).toEqual([]);

  store.upsertDraftComment("pr-1", { ...at, chapterId: "c1", body: "Mine." });
  await tool("edit_draft_comment", { ...at, body: "Theirs." });
  expect((await call("undoAgentChange", at)).draft.comments).toEqual([{ ...at, chapterId: "c1", body: "Mine." }]);

  await tool("delete_draft_comment", at);
  expect((await call("getDraft", {})).discussions[0].undoable).toBe(true);
  expect((await call("undoAgentChange", at)).draft.comments).toEqual([{ ...at, chapterId: "c1", body: "Mine." }]);
  expect(store.staleDraftComments("pr-1")).toEqual([]);

  // A later edit wins over undo.
  await tool("edit_draft_comment", { ...at, body: "Theirs." });
  store.editDraftComment("pr-1", at, "Mine again.");
  expect((await call("getDraft", {})).discussions[0]).not.toHaveProperty("undoable");
  await expect(call("undoAgentChange", at)).rejects.toThrow("It changed since the agent's edit");
});

test("a removed comment goes back only to the line it was on", async () => {
  const { store, tool, call, ask } = await host();
  store.upsertDraftComment("pr-1", { ...at, body: "Mine." });
  ask(at, "Drop it?");
  await tool("delete_draft_comment", at);
  store.savePatch("pr-1", "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n const a = 1;\n-const b = 2;\n+const b = 3;\n");
  await expect(call("undoAgentChange", at)).rejects.toThrow("a.ts:3 isn't in the diff anymore, so the comment can't go back there.");
  // Line 3 is in the diff again, with other code.
  store.savePatch("pr-1", patch.replace("+const c = b * 2;", "+const d = 4;"));
  await expect(call("undoAgentChange", at)).rejects.toThrow("The code at a.ts:3 changed since the comment was drafted, so it can't go back there.");
  store.savePatch("pr-1", patch);
  expect((await call("undoAgentChange", at)).draft.comments).toEqual([{ ...at, body: "Mine." }]);
});

test("the reviewer's summary and verdict: saving makes it theirs, and picking a verdict keeps it", async () => {
  const { store, tool, call } = await host();
  await tool("set_review_summary", { body: "Agent's.", verdict: "APPROVE" });
  const revision = reviewRevision(store, "pr-1");
  expect((await call("setVerdict", { verdict: "APPROVE", revision })).draft).toMatchObject({ verdict: "APPROVE", verdictChosen: true, body: "Agent's.", bodyAuthor: "agent" });
  const saved = await call("saveSummary", { body: "Mine.", revision });
  expect(saved).toEqual({ draft: { targetKey: "pr-1", verdict: "APPROVE", verdictChosen: true, body: "Mine.", comments: [], suggestedVerdict: "APPROVE" }, stale: [], discussions: [] });
  await expect(call("saveSummary", { body: "Stale.", revision: "old" })).rejects.toThrow("changed in another window");
  expect(store.getDraft("pr-1").body).toBe("Mine.");
});

test("the assistant replies in the summary's discussion", async () => {
  const { store, tool, error, ask, signals } = await host();
  expect(error(await tool("reply_in_discussion", { summary: true, body: "Hi" }))).toBe("There's no discussion on the review summary. The reviewer starts discussions; answer other messages in the chat.");
  expect(error(await tool("reply_in_discussion", { body: "Hi" }))).toBe("Give the discussion's file and line, or summary: true for the review summary's discussion.");
  expect(error(await tool("reply_in_discussion", { file: "a.ts", body: "Hi" }))).toBe("Give the discussion's file and line, or summary: true for the review summary's discussion.");
  ask(SUMMARY_AT, "Is Approve right?");
  expect(await tool("reply_in_discussion", { summary: true, body: " Yes: nothing blocks merging. " })).toBe("Replied in the discussion on the review summary. The reviewer reads it there.");
  expect(store.listDiscussions("pr-1")).toEqual([{ ...SUMMARY_AT, waiting: false, entries: [
    expect.objectContaining({ author: "reviewer", body: "Is Approve right?" }), expect.objectContaining({ author: "agent", kind: "message", body: "Yes: nothing blocks merging." }),
  ] }]);
  expect(signals()).toBe(1);
});
