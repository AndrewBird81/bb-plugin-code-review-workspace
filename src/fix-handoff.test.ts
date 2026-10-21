import { expect, test, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";

const runGh = vi.hoisted(() => vi.fn());
vi.mock("./gh", async (orig) => ({ ...(await orig<any>()), runGh }));

import { createStore } from "./store";
import { fixMessage, sendToSourceThread, sourceThread, startFixThread } from "./fix-handoff";
import plugin from "../server";
import { defaultPreferences } from "./preferences";
import { queueStore, type AsyncStore } from "./store-queue";

const PATCH = [
  "diff --git a/src/a.ts b/src/a.ts", "--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1,3 +1,4 @@",
  " const a = 1;", "-const b = 2;", "+const b = 3;", "+const c = ```;", " export { a };",
].join("\n");

function host(spawn: (args: any) => Promise<unknown> = async () => ({ id: "fixer" }), projectDefaults: unknown = { providerId: "codex", model: "gpt-6", reasoningLevel: "low", permissionMode: "auto" }) {
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace", sdk: {
    threads: { spawn },
    projects: { defaultExecutionOptions: async () => projectDefaults },
  } as any });
  const store = queueStore(createStore(bb));
  return { bb, harness, store, spawns: () => harness.inspection.sdk.callsTo("threads.spawn").map((call) => call[0] as any) };
}

async function ownPr(store: AsyncStore, over: Record<string, unknown> = {}) {
  await store.saveReview({ targetKey: "pr-1", kind: "pr", repo: "acme/web", number: 12, title: "Retry uploads", author: "alice", head: "retry-uploads", headSha: "abc1234def5678", status: "ready", createdAt: 1, projectId: "p1" } as any);
  await store.setLifecycle("pr-1", { ownPr: true, ...over });
  await store.savePatch("pr-1", PATCH);
  await store.upsertDraftComment("pr-1", { file: "src/a.ts", line: 2, side: "LEFT", body: "Why change b?" });
  await store.upsertDraftComment("pr-1", { file: "src/a.ts", line: 3, side: "RIGHT", body: "Name this better." });
}

test("starts a visible thread in the review's project that names the PR, its branch and head, each comment's line and code, and forbids GitHub changes", async () => {
  const { bb, store, spawns } = host();
  await ownPr(store);
  const before = await store.getDraft("pr-1");
  const started = await startFixThread(bb, store, "pr-1", [{ file: "src/a.ts", line: 2, side: "LEFT" }, { file: "src/a.ts", line: 3, side: "RIGHT" }]);
  expect(started).toEqual({ threadId: "fixer", title: "Fix review comments: #12 Retry uploads" });
  const [spawn] = spawns();
  expect(spawn).toMatchObject({ projectId: "p1", environment: { type: "project-default" }, title: "Fix review comments: #12 Retry uploads" });
  expect(spawn.visibility).toBeUndefined();
  // No review agent is chosen, so the project's defaults apply.
  expect(spawn.providerId).toBeUndefined();
  const text: string = spawn.prompt;
  expect(text).toContain("acme/web PR #12 (Retry uploads)");
  expect(text).toContain("Check out the branch `retry-uploads`, or stay on it if it's already checked out. I reviewed commit `abc1234`.");
  expect(text).toContain("`src/a.ts:2` (old line)\n```diff\n-const b = 2;\n```\nWhy change b?");
  // A fence longer than any backtick run in the code keeps the block whole.
  expect(text).toContain("`src/a.ts:3`\n````diff\n+const c = ```;\n````\nName this better.");
  expect(text).toMatch(/Don't push, open or update a PR, or change anything on GitHub unless I ask in this thread\.$/);
  expect(await store.getDraft("pr-1")).toEqual(before);
});

test("sends only the comments you chose, with the review agent's execution", async () => {
  const { bb, store, spawns } = host();
  await ownPr(store);
  await store.savePreferences({ ...(await store.getPreferences()).preferences, assistantAgent: { hostId: "h1", providerId: "claude", model: "opus", reasoningLevel: "high", permissionMode: "accept-edits" } }, (await store.getPreferences()).revision);
  await startFixThread(bb, store, "pr-1", [{ file: "src/a.ts", line: 3, side: "RIGHT" }]);
  const [spawn] = spawns();
  expect(spawn).toMatchObject({ projectId: "p1", environment: { type: "project-default" }, providerId: "claude", model: "opus", reasoningLevel: "high", permissionMode: "accept-edits" });
  expect(spawn.prompt).toContain("Name this better.");
  expect(spawn.prompt).not.toContain("Why change b?");
});

test("a renamed review's fix thread has the name you gave it, and its message names the PR by its title", async () => {
  const { bb, store, spawns } = host();
  await ownPr(store, { name: "Upload retries" });
  expect((await startFixThread(bb, store, "pr-1", [{ file: "src/a.ts", line: 3, side: "RIGHT" }])).title).toBe("Fix review comments: #12 Upload retries");
  expect(spawns()[0].prompt).toContain("acme/web PR #12 (Retry uploads)");
  expect(spawns()[0].prompt).not.toContain("Upload retries");
});

test("a local review names its diff and directory and says which branch to work on", async () => {
  const { bb, store, spawns } = host();
  await store.saveReview({ targetKey: "ref-1", kind: "ref", gitRef: "main...feature", status: "ready", createdAt: 1, projectId: "p1", cwd: "/repo" } as any);
  await store.savePatch("ref-1", PATCH);
  await store.upsertDraftComment("ref-1", { file: "src/a.ts", line: 3, side: "RIGHT", body: "Name this better." });
  const started = await startFixThread(bb, store, "ref-1", [{ file: "src/a.ts", line: 3, side: "RIGHT" }]);
  expect(started.title).toBe("Fix review comments: main...feature");
  expect(spawns()[0].prompt).toContain("Fix these comments from my review of `git diff main...feature` in `/repo`.\nCheck out `feature`, or stay on it if it's already checked out.");
});

test("a range comment quotes its lines across both sides, and a comment on an older diff has no code", () => {
  const review = { targetKey: "pr-1", kind: "pr", repo: "acme/web", number: 12, head: "retry-uploads", status: "ready", createdAt: 1 } as const;
  const text = fixMessage(review, [
    { file: "src/a.ts", startLine: 2, startSide: "LEFT", line: 2, side: "RIGHT", body: "Keep b." },
    { file: "src/a.ts", line: 4, side: "RIGHT", body: "Moved?" },
  ], PATCH, [{ file: "src/a.ts", line: 4, side: "RIGHT" }]);
  expect(text).toContain("`src/a.ts:2–2` (old line 2 to new line 2)\n```diff\n-const b = 2;\n+const b = 3;\n```\nKeep b.");
  expect(text).toContain("`src/a.ts:4`, written against an older diff, so the line may have moved:\nMoved?");
});

test("refuses someone else's PR, asking gh who you are when the sync doesn't know yet", async () => {
  const { bb, store, spawns } = host();
  await ownPr(store, { ownPr: false });
  await expect(startFixThread(bb, store, "pr-1", [{ file: "src/a.ts", line: 3, side: "RIGHT" }])).rejects.toThrow("only for your own PR or a local review");
  await ownPr(store, { ownPr: null });
  runGh.mockResolvedValue({ stdout: "bob\n", stderr: "", code: 0 });
  await expect(startFixThread(bb, store, "pr-1", [{ file: "src/a.ts", line: 3, side: "RIGHT" }])).rejects.toThrow("only for your own PR or a local review");
  expect(spawns()).toHaveLength(0);
  runGh.mockResolvedValue({ stdout: "Alice\n", stderr: "", code: 0 });
  await expect(startFixThread(bb, store, "pr-1", [{ file: "src/a.ts", line: 3, side: "RIGHT" }])).resolves.toMatchObject({ threadId: "fixer" });
});

test("says why the thread couldn't start", async () => {
  const offline = host(async () => { throw new Error("The machine is offline."); });
  await ownPr(offline.store);
  await expect(startFixThread(offline.bb, offline.store, "pr-1", [{ file: "src/a.ts", line: 3, side: "RIGHT" }])).rejects.toThrow("Couldn’t start the thread: The machine is offline.");
  const noAgent = host(undefined, null);
  await ownPr(noAgent.store);
  await expect(startFixThread(noAgent.bb, noAgent.store, "pr-1", [{ file: "src/a.ts", line: 3, side: "RIGHT" }])).rejects.toThrow("bb has no default agent for the review's project. Choose an agent for the Review agent in Review settings.");
  expect(noAgent.spawns()).toHaveLength(0);
});

test("each comment keeps its severity, a block below the label", () => {
  const review = { targetKey: "pr-1", kind: "pr", repo: "acme/web", number: 12, head: "retry-uploads", status: "ready", createdAt: 1 } as const;
  const text = fixMessage(review, [
    { file: "src/a.ts", line: 3, side: "RIGHT", severity: "blocking", body: "Name this better." },
    { file: "src/a.ts", line: 4, side: "RIGHT", severity: "nit", body: "```suggestion\nconst d = 1;\n```" },
  ], PATCH, [{ file: "src/a.ts", line: 4, side: "RIGHT" }]);
  expect(text).toContain("````\n**Blocking:** Name this better.");
  expect(text).toContain("may have moved:\n**Nit:**\n\n```suggestion");
});

test("a problem the PR didn't introduce says so, as it would post, while Keep pre-existing problems apart is on (70-review #11)", () => {
  const review = { targetKey: "pr-1", kind: "pr", repo: "acme/web", number: 12, head: "retry-uploads", status: "ready", createdAt: 1 } as const;
  const comments = [{ file: "src/a.ts", line: 3, side: "RIGHT", severity: "should-fix", introduced: false, body: "Already racy." }] as const;
  expect(fixMessage(review, comments, PATCH, [], true)).toContain("**Pre-existing:** **Should fix:** Already racy.");
  expect(fixMessage(review, comments, PATCH, [], false)).not.toContain("Pre-existing");
});

test("Fix in a new thread and Send to thread mark a pre-existing problem while Settings keeps them apart, and not while it doesn't", async () => {
  for (const preExistingFindings of [true, false]) {
    const { bb, store, spawns } = host();
    await ownPr(store, { sourceThreadId: "coder", sourceThreadAt: 1 });
    await store.upsertDraftComment("pr-1", { file: "src/a.ts", line: 3, side: "RIGHT", introduced: false, body: "Name this better." });
    await store.savePreferences({ ...defaultPreferences, knobs: { ...defaultPreferences.knobs, preExistingFindings } }, (await store.getPreferences()).revision);
    await startFixThread(bb, store, "pr-1", [{ file: "src/a.ts", line: 3, side: "RIGHT" }]);
    expect(spawns()[0].prompt.includes("**Pre-existing:** Name this better.")).toBe(preExistingFindings);
    const sending = sendHost({ coder: { title: "Retry uploads" } });
    await ownPr(sending.store, { sourceThreadId: "coder", sourceThreadAt: 1 });
    await sending.store.upsertDraftComment("pr-1", { file: "src/a.ts", line: 3, side: "RIGHT", introduced: false, body: "Name this better." });
    await sending.store.savePreferences({ ...defaultPreferences, knobs: { ...defaultPreferences.knobs, preExistingFindings } }, (await sending.store.getPreferences()).revision);
    await sendToSourceThread(sending.bb, sending.store, "pr-1", [{ file: "src/a.ts", line: 3, side: "RIGHT" }]);
    expect(sending.sends()[0].input[0].text.includes("**Pre-existing:** Name this better.")).toBe(preExistingFindings);
  }
});

/** A host whose BB has the threads in `threads`, by id, and whose send answers `delivery`. */
function sendHost(threads: Record<string, { title: string | null; archivedAt?: number | null; deletedAt?: number | null }>, delivery: "sent" | "queued" = "sent") {
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace", sdk: { threads: {
    get: async ({ threadId }: { threadId: string }) => {
      const thread = threads[threadId];
      if (!thread) throw Object.assign(new Error("HTTP 404: Thread not found"), { status: 404 });
      return { id: threadId, archivedAt: null, deletedAt: null, status: "idle", ...thread };
    },
    send: async () => delivery === "queued" ? { ok: true, delivery, queuedMessage: { id: "q1" } } : { ok: true, delivery },
  } } as any });
  const store = queueStore(createStore(bb));
  return { bb, harness, store, sends: () => harness.inspection.sdk.callsTo("threads.send").map((call) => call[0] as any) };
}

test("Send to thread sends the comments you chose to the thread that made the change, after its turn, and marks them sent", async () => {
  const { bb, store, sends } = sendHost({ coder: { title: "Retry uploads" } }, "queued");
  await ownPr(store, { sourceThreadId: "coder", sourceThreadAt: 1 });
  const before = await store.getDraft("pr-1");
  expect(await sourceThread(bb, store, "pr-1")).toEqual({ threadId: "coder", title: "Retry uploads", state: "open" });
  expect(await sendToSourceThread(bb, store, "pr-1", [{ file: "src/a.ts", line: 3, side: "RIGHT" }])).toEqual({ ok: true, delivery: "queued", title: "Retry uploads" });
  const [send] = sends();
  expect(send).toMatchObject({ threadId: "coder", mode: "queue-if-active" });
  const text: string = send.input[0].text;
  expect(text).toContain("acme/web PR #12 (Retry uploads)");
  expect(text).toContain("Name this better.");
  expect(text).not.toContain("Why change b?");
  expect(text.endsWith("Reply in this thread with what you changed for each comment, as `file:line — done` or `not done (why)`. Don't push unless I ask.")).toBe(true);
  const sent = (await store.getReview("pr-1"))?.sent;
  expect(sent).toMatchObject({ threadId: "coder", title: "Retry uploads", comments: [{ file: "src/a.ts", line: 3, side: "RIGHT", body: "Name this better." }] });
  // Sending another keeps the first marked, each with when it was sent.
  await sendToSourceThread(bb, store, "pr-1", [{ file: "src/a.ts", line: 2, side: "LEFT" }]);
  expect((await store.getReview("pr-1"))?.sent?.comments.map(({ line, at }) => ({ line, at: typeof at }))).toEqual([{ line: 3, at: "number" }, { line: 2, at: "number" }]);
  // Sending submits nothing: the draft is as it was.
  expect(await store.getDraft("pr-1")).toEqual(before);
});

test("Send to thread refuses someone else's PR, a review no thread started, and a thread that's gone or archived", async () => {
  const { bb, store, sends } = sendHost({ coder: { title: "Retry uploads" }, old: { title: "Old work", archivedAt: 5 } });
  const at = [{ file: "src/a.ts", line: 3, side: "RIGHT" as const }];
  await ownPr(store, { ownPr: false, sourceThreadId: "coder" });
  await expect(sendToSourceThread(bb, store, "pr-1", at)).rejects.toThrow("Send to thread is only for your own PR or a local review.");
  await ownPr(store, { ownPr: true, sourceThreadId: null });
  await expect(sendToSourceThread(bb, store, "pr-1", at)).rejects.toThrow("This review has no thread to send to.");
  await ownPr(store, { sourceThreadId: "deleted" });
  expect(await sourceThread(bb, store, "pr-1")).toEqual({ threadId: "deleted", title: null, state: "gone" });
  await expect(sendToSourceThread(bb, store, "pr-1", at)).rejects.toThrow("The thread that started this review was deleted.");
  await ownPr(store, { sourceThreadId: "old" });
  await expect(sendToSourceThread(bb, store, "pr-1", at)).rejects.toThrow("Old work is archived.");
  // This plugin's own agent is never a source thread.
  await store.setAssistantThread("pr-1", "coder");
  await ownPr(store, { sourceThreadId: "coder" });
  expect(await sourceThread(bb, store, "pr-1")).toBeNull();
  expect(sends()).toHaveLength(0);
  expect((await store.getReview("pr-1"))?.sent).toBeUndefined();
});

test("sendToSourceThread tells the review's page, and with Send to thread off neither RPC offers or sends", async () => {
  const { bb, harness, store, sends } = sendHost({ coder: { title: "Retry uploads" } });
  await plugin(bb);
  await ownPr(store, { sourceThreadId: "coder" });
  const comments = [{ file: "src/a.ts", line: 3, side: "RIGHT" }];
  expect(await harness.behavior.callRpc("getSourceThread", { targetKey: "pr-1" })).toEqual({ thread: { threadId: "coder", title: "Retry uploads", state: "open" } });
  expect(await harness.behavior.callRpc("sendToSourceThread", { targetKey: "pr-1", comments })).toEqual({ ok: true, delivery: "sent", title: "Retry uploads" });
  expect(harness.inspection.realtimeSignals.map((signal) => signal.channel)).toContain("review:pr-1");
  await store.savePreferences({ ...defaultPreferences, knobs: { ...defaultPreferences.knobs, sendToThread: false } }, (await store.getPreferences()).revision);
  expect(await harness.behavior.callRpc("getSourceThread", { targetKey: "pr-1" })).toEqual({ thread: null });
  await expect(harness.behavior.callRpc("sendToSourceThread", { targetKey: "pr-1", comments })).rejects.toThrow("Send to thread is off in Review settings.");
  expect(sends()).toHaveLength(1);
});
