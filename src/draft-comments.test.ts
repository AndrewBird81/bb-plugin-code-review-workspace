import { expect, test, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { runGh } from "./gh";
import { queueStore, type AsyncStore } from "./store-queue";
import { startPlugin } from "./plugin-store.test-support";

vi.mock("./gh", async (original) => ({ ...await original<typeof import("./gh")>(), runGh: vi.fn() }));
vi.mock("./store-queue", async (original) => {
  const actual = await original<typeof import("./store-queue")>();
  return { ...actual, queueStore: vi.fn(actual.queueStore) };
});

const patch = [
  "diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", "@@ -1,3 +1,4 @@",
  " const a = 1;", "-const b = 2;", "+const b = 3;", "+const c = b * 2;", " export { a };", "",
].join("\n");

async function host() {
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace" });
  const store = await startPlugin(bb);
  await store.saveReview({ targetKey: "pr-1", kind: "pr", number: 1, repo: "acme/web", status: "ready", createdAt: 1, headSha: "sha1" });
  await store.savePatch("pr-1", patch);
  await store.setAssistantThread("pr-1", "assistant");
  const call = (tool: string, input: Record<string, unknown>, threadId = "assistant") => harness.behavior.callAgentTool(tool, input, { threadId });
  const add = (input: Record<string, unknown>, threadId?: string) => call("add_draft_comment", input, threadId);
  const error = (result: any) => (result.isError ? result.content[0].text : null) as string | null;
  const signals = () => harness.inspection.realtimeSignals.filter((signal) => signal.channel === "draft:pr-1").length;
  return { harness, store, call, add, error, signals };
}

test("the assistant adds comments to its own review's local draft, and nothing reaches GitHub", async () => {
  const { store, add, error, signals } = await host();
  expect(await add({ file: "a.ts", line: 3, code: "  const c = b * 2; ", body: " Can this overflow? " })).toBe("Added a draft comment on a.ts:3. It stays in bb until the reviewer submits the review.");
  expect(error(await add({ file: "a.ts", line: 2, side: "LEFT", code: "const b = 2;", body: "Why change b?" }))).toBeNull();
  expect((await store.getDraft("pr-1")).comments).toEqual([
    { file: "a.ts", line: 3, side: "RIGHT", author: "agent", body: "Can this overflow?" },
    { file: "a.ts", line: 2, side: "LEFT", author: "agent", body: "Why change b?" },
  ]);
  // Bound to the current diff, so submission accepts them.
  expect(await store.staleDraftComments("pr-1")).toEqual([]);
  expect(signals()).toBe(2);
  expect(runGh).not.toHaveBeenCalled();
});

test("a miscounted or out-of-diff line is refused with where its code is", async () => {
  const { store, add, error } = await host();
  expect(error(await add({ file: "a.ts", line: 2, code: "const c = b * 2;", body: "x" })))
    .toBe("Line 2 on the RIGHT side of a.ts is `const b = 3;`. The code you sent is on line 3. Nothing was added.");
  expect(error(await add({ file: "a.ts", line: 40, code: "const c = b * 2;", body: "x" }))).toMatch(/^Line 40 isn't on the RIGHT side of a.ts in this diff. The code you sent is on line 3/);
  expect(error(await add({ file: "a.ts", line: 2, side: "LEFT", code: "const c = b * 2;", body: "x" }))).toContain("isn't on the LEFT side of a.ts");
  expect(error(await add({ file: "b.ts", line: 1, code: "x", body: "x" }))).toContain("b.ts isn't in this review's diff");
  await expect(add({ file: "a.ts", line: 3, code: "const c = b * 2;", body: "   " })).rejects.toThrow();
  expect((await store.getDraft("pr-1")).comments).toEqual([]);
});

test("adding never replaces a comment; editing and deleting change only the one at that location", async () => {
  const { store, call, add, error, signals } = await host();
  await store.upsertDraftComment("pr-1", { file: "a.ts", line: 3, side: "RIGHT", chapterId: "c1", body: "Mine" });
  await store.upsertDraftComment("pr-1", { file: "a.ts", line: 2, side: "LEFT", author: "agent", body: "Theirs" });
  expect(error(await add({ file: "a.ts", line: 3, code: "const c = b * 2;", body: "New" }))).toContain('already has a draft comment: "Mine"');
  expect(await call("list_draft_comments", {})).toBe([
    "The draft has no review summary yet.",
    "Verdict: the reviewer hasn't picked one, so it's Comment by default.",
    "2 draft comments:",
    "a.ts:3 RIGHT · added by the reviewer\n  Mine",
    "a.ts:2 LEFT · added by an agent\n  Theirs",
  ].join("\n"));

  // An edit keeps the location, who added it, and the diff it was drafted against.
  await store.savePatch("pr-1", patch.replace("export { a };", "export { a, b };"));
  await store.setLifecycle("pr-1", { commentAsks: [{ file: "a.ts", line: 3, side: "RIGHT", ask: { threadId: "assistant", state: "running", at: Date.now() } }] });
  expect(await call("edit_draft_comment", { file: "a.ts", line: 3, body: "Mine, reworded" })).toBe("Updated the reviewer's draft comment on a.ts:3, as they asked.");
  expect((await store.getDraft("pr-1")).comments[0]).toEqual({ file: "a.ts", line: 3, side: "RIGHT", chapterId: "c1", body: "Mine, reworded", editedBy: "agent" });
  expect(await store.staleDraftComments("pr-1")).toHaveLength(2);
  expect(await call("list_draft_comments", {})).toContain("added by the reviewer · drafted against an older diff, so Submit warns, and moves it into the summary if submitted anyway\n  Mine, reworded");
  expect(error(await call("edit_draft_comment", { file: "a.ts", line: 2, body: "x" }))).toBe("There's no draft comment on a.ts:2.");

  expect(await call("delete_draft_comment", { file: "a.ts", line: 2, side: "LEFT" })).toBe("Deleted the draft comment on a.ts:2 (LEFT side).");
  expect(error(await call("delete_draft_comment", { file: "a.ts", line: 2, side: "LEFT" }))).toBe("There's no draft comment on a.ts:2 (LEFT side).");
  expect((await store.getDraft("pr-1")).comments.map((c) => c.body)).toEqual(["Mine, reworded"]);
  expect(signals()).toBe(2);
  expect(runGh).not.toHaveBeenCalled();
});

test("only a review's current assistant changes its draft, and only while the draft can be submitted", async () => {
  const { store, call, add, error } = await host();
  const comment = { file: "a.ts", line: 3, code: "const c = b * 2;", body: "x" };
  for (const [tool, input] of [["list_draft_comments", {}], ["add_draft_comment", comment], ["edit_draft_comment", { file: "a.ts", line: 3, body: "x" }], ["delete_draft_comment", { file: "a.ts", line: 3 }]] as const) {
    expect(error(await call(tool, input, "another-thread"))).toContain("no longer a review's assistant");
  }
  await store.setStatus("pr-1", "generating");
  expect(error(await add(comment))).toContain("being regenerated");
  await store.setStatus("pr-1", "ready");
  await store.setLifecycle("pr-1", { prState: "MERGED", archivedAt: 1 });
  expect(error(await add(comment))).toContain("merged");
  expect(error(await call("delete_draft_comment", { file: "a.ts", line: 3 }))).toContain("merged");
  expect((await store.getDraft("pr-1")).comments).toEqual([]);
});

test("each draft tool checks it's still the assistant in the same turn as its change, so a new assistant queued meanwhile comes after both", async () => {
  vi.mocked(queueStore).mockClear();
  const { call } = await host();
  // The plugin's own queue and the store under it.
  const backend = vi.mocked(queueStore).mock.calls[0][0] as unknown as Record<string, (...args: unknown[]) => unknown>;
  const plugins = vi.mocked(queueStore).mock.results[0].value as AsyncStore;
  const ran: string[] = [];
  for (const [name, method] of Object.entries(backend)) backend[name] = (...args) => { ran.push(name); return method.apply(backend, args); };
  const tools = [
    ["list_draft_comments", {}], ["add_draft_comment", { file: "a.ts", line: 3, code: "const c = b * 2;", body: "x" }], ["edit_draft_comment", { file: "a.ts", line: 3, body: "y" }],
    ["set_review_summary", { body: "Fine." }], ["reply_in_discussion", { summary: true, body: "Done." }], ["delete_draft_comment", { file: "a.ts", line: 3 }],
  ] as const;
  for (const [tool, input] of tools) {
    ran.length = 0;
    const result = call(tool, input);
    await plugins.setAssistantThread("pr-1", "assistant");
    await result;
    expect([tool, ran.indexOf("listAssistantThreads"), ran.indexOf("setAssistantThread")]).toEqual([tool, 0, ran.length - 1]);
  }
});

test("the panel removes a comment by its location, so an agent's delete can't shift it", async () => {
  const { harness, store } = await host();
  await store.upsertDraftComment("pr-1", { file: "a.ts", line: 3, side: "RIGHT", body: "First" });
  await store.upsertDraftComment("pr-1", { file: "a.ts", line: 2, side: "LEFT", body: "Second" });
  const remove = (line: number, side: string) => harness.behavior.callRpc("removeDraftComment", { targetKey: "pr-1", file: "a.ts", line, side }) as Promise<any>;
  expect((await remove(2, "LEFT")).draft.comments.map((c: any) => c.body)).toEqual(["First"]);
  expect((await remove(2, "LEFT")).draft.comments.map((c: any) => c.body)).toEqual(["First"]);
});

test("an agent's comment takes its severity from its label or the severity given, and an edit changes or keeps it", async () => {
  const { harness, store, call, add, error } = await host();
  expect(error(await add({ file: "a.ts", line: 3, code: "const c = b * 2;", body: "**Blocking:** This overflows." }))).toBeNull();
  expect(error(await add({ file: "a.ts", line: 2, side: "LEFT", code: "const b = 2;", severity: "nit", body: "Why change b?" }))).toBeNull();
  const at = { file: "a.ts", line: 3, side: "RIGHT" as const };
  expect((await store.getDraft("pr-1")).comments).toEqual([
    { ...at, author: "agent", severity: "blocking", body: "This overflows." },
    { file: "a.ts", line: 2, side: "LEFT", author: "agent", severity: "nit", body: "Why change b?" },
  ]);
  expect(await call("list_draft_comments", {})).toContain("a.ts:3 RIGHT · added by an agent · blocking\n  This overflows.");
  await expect(add({ file: "a.ts", line: 3, code: "x", severity: "major", body: "x" })).rejects.toThrow();

  // A discussion keeps the agent's change, which Undo reverts, severity and all.
  await store.addDiscussionMessage("pr-1", at, "reviewer", "It's minor.");
  expect(error(await call("edit_draft_comment", { ...at, body: "This could overflow." }))).toBeNull();
  expect((await store.getDraft("pr-1")).comments[0]).toMatchObject({ severity: "blocking", body: "This could overflow." });
  expect(error(await call("edit_draft_comment", { ...at, body: "Should fix: This could overflow." }))).toBeNull();
  expect((await store.getDraft("pr-1")).comments[0]).toMatchObject({ severity: "should-fix", body: "This could overflow." });
  expect(error(await call("edit_draft_comment", { ...at, severity: "none", body: "This could overflow." }))).toBeNull();
  expect((await store.getDraft("pr-1")).comments[0]).not.toHaveProperty("severity");
  await harness.behavior.callRpc("undoAgentChange", { targetKey: "pr-1", ...at });
  expect((await store.getDraft("pr-1")).comments[0]).toEqual({ ...at, author: "agent", severity: "should-fix", body: "This could overflow." });
  expect(error(await call("delete_draft_comment", at))).toBeNull();
  await harness.behavior.callRpc("undoAgentChange", { targetKey: "pr-1", ...at });
  expect((await store.getDraft("pr-1")).comments[1]).toEqual({ ...at, author: "agent", severity: "should-fix", body: "This could overflow." });
});

test("the reviewer's comment takes its severity from the panel's control or a label, and Undo after Remove keeps it", async () => {
  const { harness, store } = await host();
  const { revision } = await harness.behavior.callRpc("getReviewBundle", { targetKey: "pr-1" }) as any;
  const save = (comment: Record<string, unknown>) => harness.behavior.callRpc("saveDraftComment", { targetKey: "pr-1", revision, comment: { file: "a.ts", line: 3, side: "RIGHT", ...comment } }) as Promise<any>;
  expect((await save({ severity: "question", body: "Why?" })).draft.comments).toEqual([{ file: "a.ts", line: 3, side: "RIGHT", severity: "question", body: "Why?" }]);
  expect((await save({ severity: "question", body: "nit: Rename it." })).draft.comments[0]).toMatchObject({ severity: "nit", body: "Rename it." });
  expect((await save({ body: "Rename it." })).draft.comments[0]).not.toHaveProperty("severity");
  await expect(save({ severity: "major", body: "x" })).rejects.toThrow();
  await harness.behavior.callRpc("removeDraftComment", { targetKey: "pr-1", file: "a.ts", line: 3, side: "RIGHT" });
  await save({ author: "agent", severity: "nit", body: "Rename it." });
  expect((await store.getDraft("pr-1")).comments).toEqual([{ file: "a.ts", line: 3, side: "RIGHT", author: "agent", severity: "nit", body: "Rename it." }]);
});

test("the agent is told evidence's 600-character cap, on adding and on editing", async () => {
  const { harness } = await host();
  const { tools } = await harness.behavior.resolveAgentConfiguration({
    pluginMetadata: {}, thread: { id: "assistant", title: "Review agent: pr-1", parentThreadId: null, sourceThreadId: null },
    project: { id: "p1", kind: "personal", name: "Personal", gitRemoteUrl: null },
    environment: { id: "env-1", name: null, path: null, workspaceProvisionType: "unmanaged", branchName: null },
    host: { id: "host-1", name: "h" }, provider: { id: "claude-code", model: "opus", capabilities: { supportsNativeUserQuestion: false } },
    origin: { kind: null, pluginId: "code-review-workspace" },
  } as any);
  for (const name of ["add_draft_comment", "edit_draft_comment"]) {
    const schema = tools.find((tool) => tool.name === name)?.inputSchema as { properties: { evidence: { description: string; maxLength: number } } };
    expect({ name, cap: schema.properties.evidence.maxLength, told: schema.properties.evidence.description.includes("under 600 characters") }).toEqual({ name, cap: 600, told: true });
  }
});

test("what an agent writes for GitHub is capped under GitHub's 65,536 characters", async () => {
  const { harness, store, add } = await host();
  const { tools } = await harness.behavior.resolveAgentConfiguration({
    pluginMetadata: {}, thread: { id: "assistant", title: "Review agent: pr-1", parentThreadId: null, sourceThreadId: null },
    project: { id: "p1", kind: "personal", name: "Personal", gitRemoteUrl: null },
    environment: { id: "env-1", name: null, path: null, workspaceProvisionType: "unmanaged", branchName: null },
    host: { id: "host-1", name: "h" }, provider: { id: "claude-code", model: "opus", capabilities: { supportsNativeUserQuestion: false } },
    origin: { kind: null, pluginId: "code-review-workspace" },
  } as any);
  const cap = (tool: string, field: string) => (tools.find((t) => t.name === tool)?.inputSchema as { properties: Record<string, { maxLength?: number }> }).properties[field].maxLength;
  expect([["add_draft_comment", "body"], ["edit_draft_comment", "body"], ["set_review_summary", "body"], ["reply_in_discussion", "body"], ["draft_thread_reply", "body"], ["assess_feedback", "suggestedBody"]]
    .map(([tool, field]) => [tool, cap(tool, field)])).toEqual([["add_draft_comment", 65_000], ["edit_draft_comment", 65_000], ["set_review_summary", 65_000], ["reply_in_discussion", 65_000], ["draft_thread_reply", 65_000], ["assess_feedback", 65_000]]);
  await expect(add({ file: "a.ts", line: 3, code: "const c = b * 2;", body: "x".repeat(65_001) })).rejects.toThrow("Too big");
  expect((await store.getDraft("pr-1")).comments).toEqual([]);
});

test("an agent's comment keeps how it checked it, an edit replaces or keeps that, Undo puts it back, and the reviewer's edit drops it", async () => {
  const { harness, store, call, add, error } = await host();
  const at = { file: "a.ts", line: 3, side: "RIGHT" as const };
  expect(error(await add({ ...at, code: "const c = b * 2;", body: "This overflows.", evidence: " Read a.ts:3; `b` is unbounded from a.ts:2. " }))).toBeNull();
  expect((await store.getDraft("pr-1")).comments).toEqual([{ ...at, author: "agent", body: "This overflows.", evidence: "Read a.ts:3; `b` is unbounded from a.ts:2." }]);
  await expect(add({ file: "a.ts", line: 1, code: "const a = 1;", body: "x", evidence: "x".repeat(601) })).rejects.toThrow();
  await store.addDiscussionMessage("pr-1", at, "reviewer", "Shorter?");
  expect(error(await call("edit_draft_comment", { ...at, body: "Overflows." }))).toBeNull();
  expect((await store.getDraft("pr-1")).comments[0].evidence).toBe("Read a.ts:3; `b` is unbounded from a.ts:2.");
  expect(error(await call("edit_draft_comment", { ...at, body: "Overflows.", evidence: "Ran it with b = 2^31." }))).toBeNull();
  expect((await store.getDraft("pr-1")).comments[0].evidence).toBe("Ran it with b = 2^31.");
  await harness.behavior.callRpc("undoAgentChange", { targetKey: "pr-1", ...at });
  expect((await store.getDraft("pr-1")).comments[0].evidence).toBe("Read a.ts:3; `b` is unbounded from a.ts:2.");
  expect(error(await call("delete_draft_comment", at))).toBeNull();
  await harness.behavior.callRpc("undoAgentChange", { targetKey: "pr-1", ...at });
  expect((await store.getDraft("pr-1")).comments[0]).toEqual({ ...at, author: "agent", body: "Overflows.", evidence: "Read a.ts:3; `b` is unbounded from a.ts:2." });
  // The reviewer's words now: what the agent checked was for its own.
  const { revision } = await harness.behavior.callRpc("getReviewBundle", { targetKey: "pr-1" }) as any;
  const saved = await harness.behavior.callRpc("saveDraftComment", { targetKey: "pr-1", revision, comment: { ...at, body: "Overflows for large b." } }) as any;
  expect(saved.draft.comments).toEqual([{ ...at, body: "Overflows for large b." }]);
});

test("a comment on code the PR didn't change keeps introduced: false through add, edit, the reviewer's save, and undo", async () => {
  const { harness, store, call, add } = await host();
  await add({ file: "a.ts", line: 3, code: "const c = b * 2;", severity: "blocking", body: "b was never checked.", introduced: false });
  expect((await store.getDraft("pr-1")).comments[0]).toMatchObject({ severity: "blocking", introduced: false });
  expect(await call("list_draft_comments", {})).toContain("a.ts:3 RIGHT · added by an agent · blocking · pre-existing");
  await store.addDiscussionMessage("pr-1", { file: "a.ts", line: 3, side: "RIGHT" }, "reviewer", "Is it new?");
  // An edit without it keeps the mark; true marks it as from this PR.
  await call("edit_draft_comment", { file: "a.ts", line: 3, body: "b is never checked." });
  expect((await store.getDraft("pr-1")).comments[0].introduced).toBe(false);
  await call("edit_draft_comment", { file: "a.ts", line: 3, body: "b is never checked.", introduced: true });
  expect((await store.getDraft("pr-1")).comments[0]).not.toHaveProperty("introduced");
  // Undo puts the mark back with the text.
  await harness.behavior.callRpc("undoAgentChange", { targetKey: "pr-1", file: "a.ts", line: 3, side: "RIGHT" });
  expect((await store.getDraft("pr-1")).comments[0]).toMatchObject({ body: "b is never checked.", introduced: false });
  // The reviewer's toggle saves the comment with it, or without it.
  const { revision } = await harness.behavior.callRpc("getReviewBundle", { targetKey: "pr-1" }) as any;
  const comment = { file: "a.ts", line: 2, side: "LEFT", body: "Old bug.", introduced: false };
  await harness.behavior.callRpc("saveDraftComment", { targetKey: "pr-1", revision, comment });
  expect((await store.getDraft("pr-1")).comments[1]).toEqual({ file: "a.ts", line: 2, side: "LEFT", body: "Old bug.", introduced: false });
  const { introduced: _introduced, ...fromThisPr } = comment;
  await harness.behavior.callRpc("saveDraftComment", { targetKey: "pr-1", revision, replaces: "Old bug.", comment: fromThisPr });
  expect((await store.getDraft("pr-1")).comments[1]).not.toHaveProperty("introduced");
});
