import { expect, test, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { createStore, reanchorAll } from "./store";
import { createReviewSubmitter } from "./submit-review";
import { invalidComments, orderRange, rangeProblem } from "./review-positions";
import { toGithubReviewPayload, type DraftComment } from "./draft";
import { runGh } from "./gh";
import { addComment } from "./draft-comments";

vi.mock("./gh", async (original) => ({ ...await original<typeof import("./gh")>(), runGh: vi.fn() }));

const headers = ["diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts"];
const patch = [
  ...headers,
  "@@ -1,4 +1,5 @@",
  " one", // old 1 / new 1
  "-two", // old 2
  "+two();", // new 2
  "+three();", // new 3
  " four", // old 3 / new 4
  " five", // old 4 / new 5
  "@@ -20,2 +21,3 @@",
  " twenty", // old 20 / new 21
  "+more", // new 22
  " end", // old 21 / new 23
  "",
].join("\n");
const at = (line: number, startLine?: number, side: "LEFT" | "RIGHT" = "RIGHT", startSide?: "LEFT" | "RIGHT"): DraftComment =>
  ({ file: "a.ts", line, side, ...(startLine === undefined ? {} : { startLine }), ...(startSide ? { startSide } : {}), body: "x" });

test("a range is valid with both ends in one hunk and its first line first, as GitHub requires", () => {
  expect(rangeProblem(patch, at(4, 2))).toBeNull();
  // From a removed line to an added one.
  expect(rangeProblem(patch, at(3, 2, "RIGHT", "LEFT"))).toBeNull();
  expect(rangeProblem(patch, at(2, 4))).toBe("Line 4 comes after line 2 in the diff. Give the range's first line as its start.");
  expect(rangeProblem(patch, at(22, 4))).toBe("Lines 4 and 22 of a.ts are in different hunks of the diff. GitHub takes a range within one hunk.");
  expect(rangeProblem(patch, at(22, 10))).toBe("a.ts:10 isn’t in the current diff.");
  expect(invalidComments(patch, [at(4, 2), at(2, 4), at(22, 4), at(22, 10), at(3, 2, "RIGHT", "LEFT")])).toEqual([at(2, 4), at(22, 4), at(22, 10)]);
});

test("a selection dragged upward, or across sides, orders to its first and last line in the diff", () => {
  expect(orderRange(patch, "a.ts", { line: 4, side: "RIGHT" }, { line: 2, side: "RIGHT" })).toEqual([{ line: 2, side: "RIGHT" }, { line: 4, side: "RIGHT" }]);
  expect(orderRange(patch, "a.ts", { line: 3, side: "RIGHT" }, { line: 2, side: "LEFT" })).toEqual([{ line: 2, side: "LEFT" }, { line: 3, side: "RIGHT" }]);
  expect(orderRange(patch, "a.ts", { line: 2, side: "RIGHT" }, { line: 4, side: "RIGHT" })).toEqual([{ line: 2, side: "RIGHT" }, { line: 4, side: "RIGHT" }]);
});

test("the GitHub payload sends a range's start line and side; single-line comments are unchanged", () => {
  const payload = toGithubReviewPayload({ targetKey: "k", verdict: "COMMENT", body: "", comments: [at(4, 2), at(3, 2, "RIGHT", "LEFT"), at(5)] });
  expect(payload.comments).toEqual([
    { path: "a.ts", line: 4, side: "RIGHT", start_line: 2, start_side: "RIGHT", body: "x" },
    { path: "a.ts", line: 3, side: "RIGHT", start_line: 2, start_side: "LEFT", body: "x" },
    { path: "a.ts", line: 5, side: "RIGHT", body: "x" },
  ]);
});

function storeWith(text = patch) {
  const { bb } = createFakePluginHost({ pluginId: "guided-review" });
  const store = createStore(bb);
  store.saveReview({ targetKey: "pr-1", kind: "pr", repo: "acme/web", number: 7, status: "ready", createdAt: 1, headSha: "sha1" });
  store.savePatch("pr-1", text);
  return store;
}

test("submitting a range sends it, and the page must show the same range", async () => {
  const store = storeWith();
  store.upsertDraftComment("pr-1", at(4, 2));
  const run = vi.fn<typeof runGh>(async (args) => ({ code: 0, stderr: "", stdout: args[0] === "pr" ? '{"headRefOid":"sha1"}' : '{"id":12}' }));
  const submit = createReviewSubmitter(store, run);
  expect(await submit("pr-1", undefined, undefined, [{ ...at(4), body: "x" }])).toMatchObject({ ok: false, error: expect.stringContaining("Your draft comments changed") });
  expect(await submit("pr-1", undefined, undefined, [at(4, 2)])).toEqual({ ok: true });
  expect(JSON.parse(run.mock.calls[1][1]!.stdin!).comments).toEqual([{ path: "a.ts", line: 4, side: "RIGHT", start_line: 2, start_side: "RIGHT", body: "x" }]);
});

test("a re-review moves both ends of a range; one whose either end is gone is on an older diff", () => {
  const store = storeWith();
  store.upsertDraftComment("pr-1", at(4, 2));
  store.upsertDraftComment("pr-1", { ...at(23, 21), body: "y" });
  // Two lines added at the top, and the line `more` is gone.
  const next = [
    ...headers,
    "@@ -1,4 +1,7 @@",
    "+zero", "+zero2", " one", "-two", "+two();", "+three();", " four", " five",
    "@@ -20,2 +23,2 @@",
    " twenty", " end",
    "",
  ].join("\n");
  store.savePatch("pr-1", next);
  store.rebaseDraftComments("pr-1", reanchorAll(store, "pr-1", patch, next));
  expect(store.getDraft("pr-1").comments).toEqual([at(6, 4), { ...at(24, 23), body: "y" }]);
  expect(store.staleDraftComments("pr-1")).toEqual([]);

  // `two();` is gone now, so the first range lost its start.
  const third = [...headers, "@@ -1,4 +1,4 @@", " one", "-two", "+three();", " four", " five", ""].join("\n");
  store.savePatch("pr-1", third);
  store.rebaseDraftComments("pr-1", reanchorAll(store, "pr-1", next, third));
  expect(store.staleDraftComments("pr-1").map((c) => [c.startLine, c.line])).toEqual([[4, 6], [23, 24]]);
});

async function host() {
  const { bb, harness } = createFakePluginHost({ pluginId: "guided-review" });
  await plugin(bb);
  const store = createStore(bb);
  store.saveReview({ targetKey: "pr-1", kind: "pr", number: 7, repo: "acme/web", status: "ready", createdAt: 1, headSha: "sha1" });
  store.savePatch("pr-1", patch);
  store.setAssistantThread("pr-1", "assistant");
  const call = async (tool: string, input: Record<string, unknown>) => {
    const result: any = await harness.behavior.callAgentTool(tool, input, { threadId: "assistant" });
    return typeof result === "string" ? result : result.isError ? `error: ${result.content[0].text}` : result;
  };
  const cli = (...argv: string[]) => harness.behavior.runCli(["comment", ...argv]);
  return { harness, store, call, cli };
}

test("the assistant comments on a range, checking its code's first and last line, and can change the range", async () => {
  const { store, call } = await host();
  expect(await call("add_draft_comment", { file: "a.ts", startLine: 2, line: 4, code: "two();\nthree();\nfour", body: "Merge these." }))
    .toBe("Added a draft comment on a.ts:2–4. It stays in bb until the reviewer submits the review.");
  expect(await call("add_draft_comment", { file: "a.ts", startLine: 1, line: 3, code: "two();\nthree();", body: "x" }))
    .toBe("error: Line 1 on the RIGHT side of a.ts is `one`, not the first line of the code you sent. Nothing was added.");
  expect(await call("add_draft_comment", { file: "a.ts", startLine: 4, line: 22, code: "four\nfive\ntwenty\nmore", body: "x" }))
    .toBe("error: Lines 4 and 22 of a.ts are in different hunks of the diff. GitHub takes a range within one hunk. Nothing was added.");
  expect(await call("add_draft_comment", { file: "a.ts", startLine: 2, startSide: "LEFT", line: 3, code: "two\ntwo();\nthree();", body: "Old and new." })).toBe("Added a draft comment on a.ts:2–3. It stays in bb until the reviewer submits the review.");
  expect(store.getDraft("pr-1").comments).toEqual([
    { file: "a.ts", line: 4, side: "RIGHT", startLine: 2, author: "agent", body: "Merge these." },
    { file: "a.ts", line: 3, side: "RIGHT", startLine: 2, startSide: "LEFT", author: "agent", body: "Old and new." },
  ]);
  expect(await call("edit_draft_comment", { file: "a.ts", line: 4, startLine: 3, code: "three();\nfour", body: "Just these." })).toBe("Updated the draft comment on a.ts:3–4.");
  expect(await call("edit_draft_comment", { file: "a.ts", line: 4, startLine: 3, body: "x" })).toBe("error: Give code, the text of lines 3 to 4, to change the comment's lines. Nothing was changed.");
  expect(store.getDraft("pr-1").comments[0]).toEqual({ file: "a.ts", line: 4, side: "RIGHT", startLine: 3, author: "agent", body: "Just these." });
  expect(store.staleDraftComments("pr-1")).toEqual([]);
  expect(await call("list_draft_comments", {})).toContain("a.ts:3–4 RIGHT · added by an agent\n  Just these.");
});

test("bb review comment adds a range as <file>:<start>-<end>, and lists it", async () => {
  const { store, cli } = await host();
  expect(await cli("add", "pr-1", "a.ts:2-4", "--code", "two();\nthree();\nfour", "--body", "Merge these.")).toMatchObject({ exitCode: 0, stdout: "Added a draft comment on a.ts:2–4. It stays in bb until the reviewer submits the review." });
  // Written last line first, it's the same range.
  expect(await cli("add", "pr-1", "a.ts:23-21", "--code", "twenty\nmore\nend", "--body", "Tail.")).toMatchObject({ exitCode: 0, stdout: expect.stringContaining("on a.ts:21–23.") });
  expect(await cli("add", "pr-1", "a.ts:2-x", "--code", "x", "--body", "x")).toMatchObject({ exitCode: 2, stderr: expect.stringContaining("a.ts:2-x isn't a <file>:<line> or <file>:<start>-<end>.") });
  expect((await cli("list", "pr-1")).stdout).toContain("a.ts:2–4 RIGHT · added by an agent");
  expect(JSON.parse((await cli("list", "pr-1", "--json")).stdout).comments[0]).toEqual({ file: "a.ts", startLine: 2, line: 4, side: "RIGHT", author: "agent", body: "Merge these.", stale: false });
  expect(store.getDraft("pr-1").comments.map((c) => [c.startLine, c.line])).toEqual([[2, 4], [21, 23]]);
});

test("saveDraftComment saves a range in one hunk, and refuses one across hunks", async () => {
  const { harness, store } = await host();
  const { revision } = await harness.behavior.callRpc("getReviewBundle", { targetKey: "pr-1" }) as any;
  await harness.behavior.callRpc("saveDraftComment", { targetKey: "pr-1", revision, comment: { file: "a.ts", startLine: 2, line: 4, side: "RIGHT", body: "Range." } });
  await expect(harness.behavior.callRpc("saveDraftComment", { targetKey: "pr-1", revision, comment: { file: "a.ts", startLine: 4, line: 22, side: "RIGHT", body: "x" } }))
    .rejects.toThrow("Lines 4 and 22 of a.ts are in different hunks of the diff. GitHub takes a range within one hunk.");
  // A one-line "range" is a line comment.
  await harness.behavior.callRpc("saveDraftComment", { targetKey: "pr-1", revision, comment: { file: "a.ts", startLine: 5, line: 5, side: "RIGHT", body: "One line." } });
  expect(store.getDraft("pr-1").comments).toEqual([
    { file: "a.ts", startLine: 2, line: 4, side: "RIGHT", body: "Range." },
    { file: "a.ts", line: 5, side: "RIGHT", body: "One line." },
  ]);
});

test("undoing the agent's removal of a range comment puts the range back", async () => {
  const { harness, store, call } = await host();
  await call("add_draft_comment", { file: "a.ts", startLine: 2, line: 4, code: "two();\nthree();\nfour", body: "Merge these." });
  // The reviewer asked about it, so the removal shows in their discussion there, with Undo.
  store.addDiscussionMessage("pr-1", { file: "a.ts", line: 4, side: "RIGHT" }, "reviewer", "Drop this?");
  await call("delete_draft_comment", { file: "a.ts", line: 4 });
  await harness.behavior.callRpc("undoAgentChange", { targetKey: "pr-1", file: "a.ts", line: 4, side: "RIGHT" });
  expect(store.getDraft("pr-1").comments).toEqual([{ file: "a.ts", line: 4, side: "RIGHT", startLine: 2, author: "agent", body: "Merge these." }]);
});

test("a range whose two ends are one row of the diff isn't one GitHub takes", () => {
  expect(rangeProblem(patch, at(4, 4))).toBe("Lines 4 and 4 of a.ts are one line of the diff. Comment on the line alone.");
  // A context line is on both sides.
  expect(rangeProblem(patch, at(4, 3, "RIGHT", "LEFT"))).toBe("Lines 3 and 4 of a.ts are one line of the diff. Comment on the line alone.");
});

test("an agent's range can start or end on a blank line", () => {
  const blank = ["diff --git a/b.ts b/b.ts", "--- a/b.ts", "+++ b/b.ts", "@@ -0,0 +1,5 @@", "+a", "+", "+b", "+", "+c", ""].join("\n");
  const store = storeWith(blank);
  expect(addComment(store, "pr-1", { file: "b.ts", startLine: 1, line: 2, code: "a\n", body: "Ends blank." })).toMatchObject({ ok: true });
  expect(addComment(store, "pr-1", { file: "b.ts", startLine: 2, line: 3, code: "\nb", body: "Starts blank." })).toMatchObject({ ok: true });
  // A trailing newline after the last line's text is still allowed.
  expect(addComment(store, "pr-1", { file: "b.ts", startLine: 3, line: 5, code: "b\n\nc\n", body: "Last three." })).toMatchObject({ ok: true });
  expect(store.getDraft("pr-1").comments.map((c) => [c.startLine, c.line])).toEqual([[1, 2], [2, 3], [3, 5]]);
});
