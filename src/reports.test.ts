// Reports on the comments you sent (src/reports.ts): bb review report and bb review ready from any thread, the review
// Ready to re-review only once every comment out is reported or ready ran, never on idle alone, one Check fixes the
// plugin starts per Send, unattended, and what a restart missed read again.
import { expect, test, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";

const runGh = vi.hoisted(() => vi.fn(async () => ({ stdout: "", stderr: "no GitHub here", code: 1 })));
vi.mock("./gh", async (orig) => ({ ...(await orig<any>()), runGh }));
vi.mock("./store-queue", async (original) => {
  const actual = await original<typeof import("./store-queue")>();
  return { ...actual, queueStore: vi.fn(actual.queueStore) };
});

import { agentChat } from "./agent-chat.test-support";
import { startPlugin } from "./plugin-store.test-support";
import { createClassifier } from "./asking";
import { assess, startVerification } from "./verification";
import { toolText } from "./fake-host.test-support";
import { defaultPreferences } from "./preferences";
import type { AsyncStore } from "./store-queue";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

const LINES = ["a", "b", "c", "d", "e", "f"];
const PATCH = ["diff --git a/src/a.ts b/src/a.ts", "--- a/src/a.ts", "+++ b/src/a.ts", "@@ -0,0 +1,6 @@", ...LINES.map((l) => `+const ${l} = 1;`)].join("\n");
const AT = LINES.map((_, i) => ({ file: "src/a.ts", line: i + 1, side: "RIGHT" as const }));

/** What the main thread was asked, as bb's events have it: its requests, newest last. */
type Requested = { createdAt: number; data: { input: Array<{ text: string }> } };
interface Coder { busy: boolean; status: string; queue: string[]; queued: Map<string, Requested["data"]["input"]>; requests: Requested[]; archivedAt: number | null; reply: string }

/**
 * A BB with the review's main thread, `coder`, its subagent `sub`, and the review agent's chat, `agent`. The main thread
 * queues what's sent while it's busy, and keeps what it takes as requests; its last reply is `reply`.
 */
function threadsSdk(chat: ReturnType<typeof agentChat>, state: Coder) {
  let queued = 0;
  return {
    get: async ({ threadId }: { threadId: string }) => {
      if (threadId === "agent") return { id: "agent", title: "Review agent: repo:feature", archivedAt: null, deletedAt: null, status: "idle", queuedMessageCount: 0, visibility: "hidden" };
      if (threadId !== "coder" && threadId !== "sub") throw Object.assign(new Error("HTTP 404: Thread not found"), { status: 404 });
      return { id: threadId, title: threadId === "coder" ? "Retry uploads" : "Subagent", titleFallback: null, archivedAt: threadId === "coder" ? state.archivedAt : null, deletedAt: null, environmentId: null, status: state.status, queuedMessageCount: state.queue.length, visibility: "visible", originPluginId: null, parentThreadId: threadId === "sub" ? "coder" : null };
    },
    send: async (args: any) => {
      if (args.threadId === "agent") return chat.sdk.send(args);
      if (!state.busy) { state.requests.push({ createdAt: Date.now(), data: { input: args.input } }); return { ok: true, delivery: "sent" }; }
      const id = `q${++queued}`;
      state.queue.push(id);
      state.queued.set(id, args.input);
      return { ok: true, delivery: "queued", queuedMessage: { id } };
    },
    spawn: chat.sdk.spawn,
    events: { list: async (args: { threadId: string; order?: string; types?: string[]; limit?: string }) => args.threadId === "agent" ? chat.sdk.events.list(args) : [...state.requests].reverse() },
    output: async ({ threadId }: { threadId: string }) => ({ output: threadId === "coder" ? state.reply : null }),
    queuedMessages: { list: async ({ threadId }: { threadId: string }) => threadId === "coder" ? state.queue.map((id) => ({ id, threadId })) : [] },
    experimental_listAncestors: async ({ threadIds }: { threadIds: string[] }) => ({ threads: threadIds.map((id) => ({ threadId: id, ancestorIds: id === "sub" ? ["coder"] : [] })) }),
    stop: async () => ({}),
  };
}

/** Needs You, which takes alerts. */
const inbox = (published: any[]) => async ({ method, input }: { method: string; input: any }) => {
  if (method === "activityCapabilities") return { version: 1 };
  if (method === "publishActivity") { published.push(input); return { accepted: true, id: `a${published.length}`, duplicate: false }; }
  return { ok: true };
};

function host() {
  const chat = agentChat("agent");
  const state: Coder = { busy: false, status: "idle", queue: [], queued: new Map(), requests: [], archivedAt: null, reply: "Renamed a; left the rest." };
  const published: any[] = [];
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace", sdk: {
    threads: threadsSdk(chat, state),
    plugins: { callRpc: inbox(published) },
    projects: { defaultExecutionOptions: async () => ({ providerId: "codex", model: "gpt-6", reasoningLevel: "low", permissionMode: "auto" }) },
  } as any });
  return { bb, harness, chat, state, published };
}

/** A local review of /repo, main...feature, whose main thread is `coder`, with six comments, all sent in Send 1. */
async function sentSix(h: ReturnType<typeof host>, store: AsyncStore) {
  await store.saveReview({ targetKey: "ref-1", kind: "ref", gitRef: "main...feature", status: "ready", createdAt: 1, projectId: "p1", cwd: "/repo" });
  await store.setLifecycle("ref-1", { sourceThreadId: "coder" });
  await store.savePatch("ref-1", PATCH);
  await store.setAssistantThread("ref-1", "agent");
  for (const at of AT) await store.upsertDraftComment("ref-1", { ...at, body: `Fix line ${at.line}.` });
  const sent = await h.harness.behavior.callRpc("sendToSourceThread", { targetKey: "ref-1", comments: AT }) as any;
  expect(sent).toMatchObject({ ok: true, sendN: 1 });
}

const cli = (h: { harness: ReturnType<typeof host>["harness"] }, threadId: string | undefined, ...argv: string[]) => h.harness.behavior.runCli(argv, { ...threadId ? { threadId } : {}, projectId: "p1" });
const turnOf = async (h: { harness: ReturnType<typeof host>["harness"] }) => ((await h.harness.behavior.callRpc("listReviews", null)) as any).reviews.find((review: any) => review.targetKey === "ref-1").turn;
const agentMessages = (h: ReturnType<typeof host>) => h.chat.events.filter((event) => event.type === "client/turn/requested");
const classify = (bb: BbPluginApi) => createClassifier(bb, (id) => id === "agent");

test("bb review report, from any thread, records the claim it names, attributed, and says which review and how many are reported", async () => {
  const h = host();
  const store = await startPlugin(h.bb);
  await sentSix(h, store);
  // The main thread's subagent reports for it.
  expect(await cli(h, "sub", "report", "c1", "done", "--note", "Renamed it.", "--commit", "ABC1234")).toEqual({ exitCode: 0, stdout: "Reported c1 done on repo:feature. 1 of 6 reported. Report the rest, then run `bb review ready`.", stderr: "" });
  expect(await cli(h, "coder", "report", "c2", "declined", "--note", "Out of scope.")).toMatchObject({ exitCode: 0, stdout: "Reported c2 declined on repo:feature. 2 of 6 reported. Report the rest, then run `bb review ready`." });
  const { comments } = await store.getDraft("ref-1");
  expect(comments[0]!.claim).toEqual({ outcome: "done", note: "Renamed it.", commit: "abc1234", threadId: "sub", at: expect.any(Number) });
  expect(comments[1]!.claim).toMatchObject({ outcome: "declined", note: "Out of scope.", threadId: "coder" });
  // Still sent, and not ready: four are out unreported.
  expect(comments.map((comment) => comment.state)).toEqual(Array(6).fill("sent"));
  expect((await store.getReview("ref-1"))!.fixes).toEqual({ sent: 6, reported: 2, inferred: 0, checked: 0, fixed: 0 });
  expect(h.harness.inspection.realtimeSignals.map((signal) => signal.channel)).toEqual(expect.arrayContaining(["review:ref-1", "draft:ref-1"]));
});

test("an unknown id names the comments sent, the calling thread's review first; bad arguments say how; a review's own agent can't report", async () => {
  const h = host();
  const store = await startPlugin(h.bb);
  await sentSix(h, store);
  expect(await cli(h, "coder", "report", "c99", "done")).toEqual({ exitCode: 1, stdout: "", stderr: "No sent comment has the id c99. Comments sent: c1, c2, c3, c4, c5, c6 on repo:feature." });
  expect(await cli(h, "coder", "report", "c1", "maybe")).toMatchObject({ exitCode: 2, stderr: expect.stringMatching(/^maybe isn't done or declined\.\nusage: bb review report/) });
  expect(await cli(h, "coder", "report", "c1")).toMatchObject({ exitCode: 2, stderr: expect.stringContaining("Give the comment's id and done or declined.") });
  expect(await cli(h, "coder", "report", "c1", "done", "--commit", "main")).toMatchObject({ exitCode: 2, stderr: expect.stringContaining("main isn't a commit's SHA.") });
  expect(await cli(h, "coder", "report", "--help")).toMatchObject({ exitCode: 0, stdout: expect.stringContaining("usage: bb review report <id> done|declined") });
  expect(await cli(h, "agent", "report", "c1", "done")).toMatchObject({ exitCode: 2, stderr: expect.stringContaining("A review's own agent can't report on fixes") });
  expect(await cli(h, "agent", "ready")).toMatchObject({ exitCode: 2, stderr: expect.stringContaining("A review's own agent can't report on fixes") });
  expect((await store.getDraft("ref-1")).comments.every((comment) => !comment.claim)).toBe(true);
});

test("the main thread going idle with 1 of 6 reported isn't Ready: the review waits on it, 1 of 6 reported, and nothing is checked", async () => {
  const h = host();
  const store = await startPlugin(h.bb);
  await sentSix(h, store);
  expect(await turnOf(h)).toMatchObject({ group: "waiting", reason: "fixes-sent", label: "0 of 6 reported" });
  await cli(h, "coder", "report", "c1", "done");
  await h.harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "coder" }), lastAssistantText: "Waiting on my subagents." });
  const [send] = (await store.getReview("ref-1"))!.sends!;
  expect(send).toMatchObject({ n: 1, stopped: { at: expect.any(Number), why: "idle" } });
  expect(send!.readyAt).toBeUndefined();
  expect(await turnOf(h)).toMatchObject({ group: "waiting", reason: "fixes-sent", label: "1 of 6 reported" });
  // Working again, as its subagents finish, it isn't stopped; idle again, it is.
  await h.harness.behavior.emitThreadEvent("thread.active", { thread: makeThreadResponse({ id: "coder" }) });
  expect((await store.getReview("ref-1"))!.sends![0]!.stopped).toBeUndefined();
  await h.harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "coder" }), lastAssistantText: null });
  expect((await store.getReview("ref-1"))!.sends![0]!.stopped).toMatchObject({ why: "idle" });
  // Archived, then back from the archive, it's idle again, not working.
  await h.harness.behavior.emitThreadEvent("thread.archived", { thread: makeThreadResponse({ id: "coder" }) });
  await h.harness.behavior.emitThreadEvent("thread.unarchived", { thread: makeThreadResponse({ id: "coder" }) });
  expect((await store.getReview("ref-1"))!.sends![0]!.stopped).toMatchObject({ why: "idle" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(agentMessages(h)).toEqual([]);
});

test("every comment reported makes it Ready to re-review, with exactly one Check fixes, which the plugin started, so unattended; the alert waits for it and names the review", async () => {
  const h = host();
  const store = await startPlugin(h.bb);
  await sentSix(h, store);
  for (const id of ["c1", "c2", "c3", "c4", "c5"]) await cli(h, "coder", "report", id, "done");
  expect(agentMessages(h)).toEqual([]);
  expect(await cli(h, "coder", "report", "c6", "declined", "--note", "Not ours.")).toMatchObject({ exitCode: 0, stdout: "Reported c6 declined on repo:feature. That was the last one: the review goes back to the reviewer to re-review." });
  await vi.waitFor(() => expect(agentMessages(h)).toHaveLength(1));
  // The alert waits for the check, once it has started.
  await vi.waitFor(async () => expect((await store.getReview("ref-1"))!.pendingAlert).toMatchObject({ signal: "fixes-ready:1" }));
  const review = (await store.getReview("ref-1"))!;
  expect(review.sends![0]).toMatchObject({ readyAt: expect.any(Number), checkedAt: expect.any(Number) });
  expect(review.verifyingSince).toEqual(expect.any(Number));
  expect(review.verifyingFixes).toBe(true);
  expect((await classify(h.bb)("agent")).asking).toBe("unattended");
  // What it's asked to check, for the agent only: each comment against its Send, and the main thread's last reply, fenced.
  const context = (agentMessages(h)[0]!.data.input as any[]).map((part) => part.text).join("\n");
  expect(context).toContain("The reviewer sent 6 comments to the main thread");
  expect(context).toContain('<untrusted source="main thread\'s reply">\nRenamed a; left the rest.\n</untrusted>');
  expect(await turnOf(h)).toMatchObject({ group: "needs", reason: "fixes-ready", label: "Ready to re-review", signal: "fixes-ready:1" });
  expect(h.published).toEqual([]);
  // Reported again, or ready, nothing more is checked.
  await cli(h, "coder", "report", "c3", "declined");
  expect(await cli(h, "coder", "ready")).toMatchObject({ exitCode: 1, stderr: expect.stringContaining("No review's comments are waiting on this thread") });
  expect(await cli(h, "coder", "ready", "repo:feature")).toMatchObject({ exitCode: 0, stdout: "repo:feature is already back with the reviewer to re-review: 6 of 6 reported." });
  // The check records what it found; once its turn ends, the alert goes, titled with the review's id, saying who did
  // what and what the check found.
  await h.harness.behavior.callAgentTool("assess_feedback", { items: ["c1", "c2", "c3", "c4", "c5", "c6"].map((id) => ({ id, verdict: id === "c6" ? "disputed" : "addressed", evidence: "Read it." })) }, { threadId: "agent" });
  expect((await store.getReview("ref-1"))!.fixes).toEqual({ sent: 6, reported: 6, inferred: 0, checked: 6, fixed: 5 });
  await h.harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "agent" }), lastAssistantText: "Checked." });
  await vi.waitFor(() => expect(h.published).toHaveLength(1));
  expect(h.published[0]).toMatchObject({ title: expect.stringMatching(/^repo:feature/), body: "The main thread reported all 6 of your comments. Checked: 5 look fixed, 1 doesn't" });
  expect((await store.getReview("ref-1"))!.verifyingFixes ?? null).toBeNull();
  expect(agentMessages(h)).toHaveLength(1);
});

test("bb review ready, from the main thread's subagent, makes it Ready with what's reported; with two reviews waiting, it asks which", async () => {
  const h = host();
  const store = await startPlugin(h.bb);
  await sentSix(h, store);
  await cli(h, "coder", "report", "c1", "done");
  expect(await cli(h, undefined, "ready")).toMatchObject({ exitCode: 1, stderr: "No review's comments are waiting on this thread. Pass the review: bb review ready <review>." });
  expect(await cli(h, "sub", "ready")).toEqual({ exitCode: 0, stdout: "Sent repo:feature back to the reviewer to re-review: 1 of 6 reported.", stderr: "" });
  await vi.waitFor(() => expect(agentMessages(h)).toHaveLength(1));
  expect(await turnOf(h)).toMatchObject({ group: "needs", reason: "fixes-ready", label: "Ready to re-review" });
  // A second review's comments sent to the same thread.
  await store.saveReview({ targetKey: "ref-2", kind: "ref", gitRef: "main...other", status: "ready", createdAt: 2, projectId: "p1", cwd: "/repo" });
  await store.setLifecycle("ref-2", { sourceThreadId: "coder" });
  await store.savePatch("ref-2", PATCH);
  await store.upsertDraftComment("ref-2", { ...AT[0]!, body: "Here too." });
  await h.harness.behavior.callRpc("sendToSourceThread", { targetKey: "ref-2", comments: [AT[0]] });
  await h.harness.behavior.callRpc("sendToSourceThread", { targetKey: "ref-1", comments: [AT[1]] });
  expect(await cli(h, "coder", "ready")).toMatchObject({ exitCode: 2, stderr: "Comments from 2 reviews wait on this thread: repo:other, repo:feature. Pass one: bb review ready <review>." });
  expect(await cli(h, "coder", "ready", "ref-2")).toMatchObject({ exitCode: 0, stdout: "Sent repo:other back to the reviewer to re-review: 0 of 1 reported." });
});

test("a clicked Check now asks the review agent as you; the check infers what the main thread didn't report, marked, and never over its report", async () => {
  const h = host();
  const store = await startPlugin(h.bb);
  await sentSix(h, store);
  await cli(h, "coder", "report", "c1", "done", "--note", "Renamed.");
  expect(await h.harness.behavior.callRpc("checkFixes", { targetKey: "ref-1" })).toEqual({ ok: true });
  await vi.waitFor(() => expect(agentMessages(h)).toHaveLength(1));
  expect((await classify(h.bb)("agent")).asking).toBe("direct");
  // A clicked check isn't the one the plugin runs once ready.
  expect((await store.getReview("ref-1"))!.sends![0]!.checkedAt).toBeUndefined();
  const listed = toolText(await h.harness.behavior.callAgentTool("list_feedback", {}, { threadId: "agent" }));
  expect(listed).toContain("[c1] src/a.ts:1 · Send 1 · reported done: Renamed.");
  expect(listed).toContain("[c2] src/a.ts:2 · Send 1 · not reported");
  const assessed = toolText(await h.harness.behavior.callAgentTool("assess_feedback", { items: [
    { id: "c1", verdict: "addressed", evidence: "Renamed at a.ts:1.", claimed: "declined" },
    { id: "c2", verdict: "addressed", evidence: "Fixed in the reply's commit.", claimed: "done" },
    { id: "c3", verdict: "not_addressed", evidence: "Unchanged." },
  ] }, { threadId: "agent" }));
  expect(assessed).toBe("Recorded 3 sent comments: 2 of 3 addressed; 1 the main thread didn't report now read \"Looks done\" or \"Looks declined\". The reviewer sees them on the comments.");
  const [c1, c2, c3] = (await store.getDraft("ref-1")).comments;
  expect(c1!.claim).toMatchObject({ outcome: "done", note: "Renamed.", threadId: "coder" });
  expect(c2!.claim).toEqual({ outcome: "done", note: "Fixed in the reply's commit.", threadId: "agent", at: expect.any(Number), inferred: true });
  expect(c3!.claim).toBeUndefined();
  expect((await store.getAssessment("ref-1", "send:1")).items.map(({ id, verdict }) => ({ id, verdict }))).toEqual([{ id: "c1", verdict: "addressed" }, { id: "c2", verdict: "addressed" }, { id: "c3", verdict: "not_addressed" }]);
  // An inferred claim isn't a report: still 1 of 6, and not ready.
  expect((await store.getReview("ref-1"))!.fixes).toEqual({ sent: 6, reported: 1, inferred: 1, checked: 3, fixed: 2 });
  expect(await turnOf(h)).toMatchObject({ group: "waiting", label: "1 of 6 reported" });
  // An unknown id is still refused, naming what it takes.
  expect(toolText(await h.harness.behavior.callAgentTool("assess_feedback", { items: [{ id: "t1", verdict: "addressed", evidence: "x" }] }, { threadId: "agent" })))
    .toContain("Unknown item ids: t1. Use the sent comments' ids from list_feedback (c12).");
});

test("Check now with nothing out, or the re-review check off, says so and asks nothing", async () => {
  const h = host();
  const store = await startPlugin(h.bb);
  await store.saveReview({ targetKey: "ref-1", kind: "ref", gitRef: "main...feature", status: "ready", createdAt: 1, projectId: "p1", cwd: "/repo" });
  expect(await h.harness.behavior.callRpc("checkFixes", { targetKey: "ref-1" })).toEqual({ ok: false, error: "No comments are out with the main thread to check." });
  await store.setLifecycle("ref-1", { sourceThreadId: "coder" });
  await store.savePatch("ref-1", PATCH);
  await store.setAssistantThread("ref-1", "agent");
  await store.upsertDraftComment("ref-1", { ...AT[0]!, body: "Fix it." });
  await h.harness.behavior.callRpc("sendToSourceThread", { targetKey: "ref-1", comments: [AT[0]] });
  await store.savePreferences({ ...defaultPreferences, knobs: { ...defaultPreferences.knobs, runReReviewCheck: false } }, (await store.getPreferences()).revision);
  expect(await h.harness.behavior.callRpc("checkFixes", { targetKey: "ref-1" })).toEqual({ ok: false, error: "The re-review check is off. Turn it on in Review settings." });
  // Ready with the check off: the alert comes at once, and nothing is checked.
  await cli(h, "coder", "report", "c1", "done");
  await vi.waitFor(() => expect(h.published).toHaveLength(1));
  expect(agentMessages(h)).toEqual([]);
});

test("a Send again clears the comment's old report: it waits for a new one", async () => {
  const h = host();
  const store = await startPlugin(h.bb);
  await sentSix(h, store);
  await cli(h, "coder", "report", "c1", "done");
  // Edited after its report, it's open again; sent again, its report is the new Send's to make.
  await store.upsertDraftComment("ref-1", { ...AT[0]!, body: "Fix line 1, and its test." });
  await h.harness.behavior.callRpc("sendToSourceThread", { targetKey: "ref-1", comments: [AT[0]] });
  const [c1] = (await store.getDraft("ref-1")).comments;
  expect(c1).toMatchObject({ id: "c1", state: "sent", sendN: 2 });
  expect(c1!.claim).toBeUndefined();
  expect((await store.getReview("ref-1"))!.fixes).toEqual({ sent: 6, reported: 0, inferred: 0, checked: 0, fixed: 0 });
});

test("archived or deleted, the main thread won't report the rest: they're back with you, with no alert or check; unarchived, it's idle", async () => {
  const h = host();
  h.state.busy = true;
  const store = await startPlugin(h.bb);
  await sentSix(h, store);
  await cli(h, "coder", "report", "c1", "done");
  expect((await store.getReview("ref-1"))!.sends![0]).toMatchObject({ queued: "q1" });
  // Idle with the Send still queued for it isn't idle on it.
  await h.harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "coder" }), lastAssistantText: null });
  expect((await store.getReview("ref-1"))!.sends![0]!.stopped).toBeUndefined();
  await h.harness.behavior.emitThreadEvent("thread.archived", { thread: makeThreadResponse({ id: "coder" }) });
  expect((await store.getReview("ref-1"))!.sends![0]!.stopped).toEqual({ at: expect.any(Number), why: "archived" });
  expect(await turnOf(h)).toMatchObject({ group: "needs", reason: "fixes-stopped", label: "Main thread archived · 1 of 6 reported", signal: null });
  await h.harness.behavior.callRpc("refreshReviews", { force: false });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(h.published).toEqual([]);
  expect(agentMessages(h)).toEqual([]);
  // Back from the archive, it isn't archived: the review waits on it again, idle once it has taken the Send.
  await h.harness.behavior.emitThreadEvent("thread.unarchived", { thread: makeThreadResponse({ id: "coder" }) });
  expect((await store.getReview("ref-1"))!.sends![0]!.stopped).toBeUndefined();
  expect(await turnOf(h)).toMatchObject({ group: "waiting", reason: "fixes-sent" });
  await h.harness.behavior.emitThreadEvent("thread.deleted", { thread: makeThreadResponse({ id: "coder" }) });
  expect(await turnOf(h)).toMatchObject({ group: "needs", reason: "fixes-stopped", label: "Main thread deleted · 1 of 6 reported" });
});

/** The plugin started again on `first`'s data, with `first`'s threads, and the review-state service run until `ready`. */
async function restarted(first: ReturnType<typeof host>, ready: (store: AsyncStore) => Promise<void>) {
  const next = await first.harness.lifecycle.reload(async () => {});
  for (const [name, fn] of Object.entries(threadsSdk(first.chat, first.state))) if (typeof fn === "function") next.harness.inspection.sdk.stub(`threads.${name}` as any, fn as any);
  next.harness.inspection.sdk.stub("threads.events.list" as any, (async (args: { threadId: string; order?: string; types?: string[]; limit?: string }) => args.threadId === "agent" ? first.chat.sdk.events.list(args) : [...first.state.requests].reverse()) as any);
  next.harness.inspection.sdk.stub("threads.queuedMessages.list" as any, (async () => first.state.queue.map((id) => ({ id }))) as any);
  next.harness.inspection.sdk.stub("threads.experimental_listAncestors" as any, (async ({ threadIds }: { threadIds: string[] }) => ({ threads: threadIds.map((id) => ({ threadId: id, ancestorIds: [] })) })) as any);
  next.harness.inspection.sdk.stub("plugins.callRpc", inbox(first.published) as any);
  next.harness.inspection.sdk.stub("projects.defaultExecutionOptions", (async () => ({ providerId: "codex", model: "gpt-6", reasoningLevel: "low", permissionMode: "auto" })) as any);
  const store = await startPlugin(next.bb);
  // Nothing read it yet; the review-state service does as it starts.
  expect((await store.getReview("ref-1"))!.sends![0]).toMatchObject({ queued: "q1" });
  const service = next.harness.runService("review-state");
  await vi.waitFor(() => ready(store));
  service.controller.abort();
  await service.done;
  return { ...next, store };
}

test("a restart in between: the main thread that took the Send and went idle while the plugin was down is read again", async () => {
  const first = host();
  first.state.busy = true;
  const store = await startPlugin(first.bb);
  await sentSix(first, store);
  await cli(first, "coder", "report", "c1", "done");
  expect((await store.getReview("ref-1"))!.sends![0]).toMatchObject({ queued: "q1" });
  // While the plugin is down, the main thread takes the Send, works, and goes idle: no event reaches it.
  first.state.busy = false;
  first.state.requests.push({ createdAt: Date.now(), data: { input: first.state.queued.get("q1")! } });
  first.state.queue.length = 0;
  const next = await restarted(first, async (reloaded) => expect((await reloaded.getReview("ref-1"))!.sends![0]).toMatchObject({ stopped: { why: "idle" } }));
  const [send] = (await next.store.getReview("ref-1"))!.sends!;
  expect(send!.queued).toBeUndefined();
  expect(await turnOf(next)).toMatchObject({ group: "waiting", label: "1 of 6 reported" });
  // The rest reported after the restart: Ready, checked once.
  for (const id of ["c2", "c3", "c4", "c5", "c6"]) await cli(next, "coder", "report", id, "done");
  await vi.waitFor(() => expect(agentMessages(first)).toHaveLength(1));
  expect(await turnOf(next)).toMatchObject({ group: "needs", reason: "fixes-ready" });
});

test("a restart in between: a Send deleted from the queue while the plugin was down never went, so its comments are open again", async () => {
  const first = host();
  first.state.busy = true;
  const store = await startPlugin(first.bb);
  await sentSix(first, store);
  // While the plugin is down, you delete the queued message: the thread never gets it.
  first.state.busy = false;
  first.state.queue.length = 0;
  const next = await restarted(first, async (reloaded) => expect((await reloaded.getReview("ref-1"))!.sends ?? []).toEqual([]));
  expect((await next.store.getDraft("ref-1")).comments.map(({ id, state, sendN }) => ({ id, state, sendN }))).toEqual(AT.map((_, i) => ({ id: `c${i + 1}`, state: "open", sendN: undefined })));
  expect((await next.store.getReview("ref-1"))!.fixes).toMatchObject({ sent: 0 });
});


test("a GitHub thread sent from your own PR keeps its report on the review (S5), and counts toward Ready", async () => {
  const h = host();
  const store = await startPlugin(h.bb);
  await store.saveReview({ targetKey: "pr-1", kind: "pr", repo: "acme/web", number: 12, title: "Retry uploads", author: "me", headSha: "abc1234", status: "ready", createdAt: 1, projectId: "p1" });
  await store.setLifecycle("pr-1", { ownPr: true, sourceThreadId: "coder", sends: [{ n: 1, at: 1, threadId: "coder", ids: ["c9"] }], threadSends: { PRRT_1: { id: "c9", sendN: 1 } } });
  expect(await cli(h, "coder", "report", "c9", "done", "--note", "Replied and fixed.")).toMatchObject({ exitCode: 0, stdout: "Reported c9 done on web#12. That was the last one: the review goes back to the reviewer to re-review." });
  const review = (await store.getReview("pr-1"))!;
  expect(review.threadSends).toEqual({ PRRT_1: { id: "c9", sendN: 1, claim: { outcome: "done", note: "Replied and fixed.", threadId: "coder", at: expect.any(Number) } } });
  expect(review.fixes).toEqual({ sent: 1, reported: 1, inferred: 0, checked: 0, fixed: 0 });
  expect(review.sends![0]!.readyAt).toEqual(expect.any(Number));
});

test("a Check fixes that can't start is put back for a later try, and the alert comes at once", async () => {
  const h = host();
  h.harness.inspection.sdk.stub("projects.defaultExecutionOptions", (async () => null) as any);
  const store = await startPlugin(h.bb);
  await sentSix(h, store);
  // No review agent yet, and none to start it on.
  await store.clearAssistantThread("ref-1");
  for (const id of ["c1", "c2", "c3", "c4", "c5", "c6"]) await cli(h, "coder", "report", id, "done");
  await vi.waitFor(() => expect(h.published).toHaveLength(1));
  const review = (await store.getReview("ref-1"))!;
  expect(review.sends![0]).toMatchObject({ readyAt: expect.any(Number) });
  expect(review.sends![0]!.checkedAt).toBeUndefined();
  expect(review.verifyingSince ?? null).toBeNull();
  expect(agentMessages(h)).toEqual([]);
});

test("a thread bb can't place is refused, failing closed; a shell outside any thread may report", async () => {
  const h = host();
  const store = await startPlugin(h.bb);
  await sentSix(h, store);
  h.harness.inspection.sdk.stub("threads.experimental_listAncestors" as any, (async () => { throw new Error("offline"); }) as any);
  expect(await cli(h, "sub", "report", "c1", "done")).toEqual({ exitCode: 1, stdout: "", stderr: "bb couldn't say which threads this one was started from, so nothing was done. Try again in a moment." });
  expect(await cli(h, "sub", "ready")).toMatchObject({ exitCode: 1, stderr: expect.stringContaining("Try again in a moment") });
  expect((await store.getDraft("ref-1")).comments[0]!.claim).toBeUndefined();
  expect(await cli(h, undefined, "report", "c1", "done")).toMatchObject({ exitCode: 0, stdout: expect.stringMatching(/^Reported c1 done on repo:feature\./) });
  expect((await store.getDraft("ref-1")).comments[0]!.claim).toMatchObject({ outcome: "done", threadId: null });
});

test("bb review ready says who finished: the main thread, another thread by its title, or the command line", async () => {
  const h = host();
  h.harness.inspection.sdk.stub("threads.get" as any, (async ({ threadId }: { threadId: string }) => threadId === "other"
    ? { id: "other", title: "Release checklist", titleFallback: null, archivedAt: null, deletedAt: null, status: "idle", queuedMessageCount: 0, visibility: "visible" }
    : threadsSdk(h.chat, h.state).get({ threadId })) as any);
  const store = await startPlugin(h.bb);
  await sentSix(h, store);
  await cli(h, "coder", "report", "c1", "done");
  expect(await cli(h, "other", "ready", "repo:feature")).toMatchObject({ exitCode: 0, stdout: "Sent repo:feature back to the reviewer to re-review: 1 of 6 reported." });
  expect((await store.getReview("ref-1"))!.sends![0]!.readyBy).toEqual({ from: "thread", title: "Release checklist" });
  // Once the check is under way, its end lets the alert go.
  await vi.waitFor(async () => expect((await store.getReview("ref-1"))!.pendingAlert).toMatchObject({ signal: "fixes-ready:1" }));
  await h.harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "agent" }), lastAssistantText: null });
  await vi.waitFor(() => expect(h.published).toHaveLength(1));
  expect(h.published[0].body).toBe("Release checklist says it’s finished: 1 of 6 reported");
  // Sent again, and finished from a shell, then from the main thread's subagent.
  await store.upsertDraftComment("ref-1", { ...AT[1]!, body: "Fix line 2, please." });
  await h.harness.behavior.callRpc("sendToSourceThread", { targetKey: "ref-1", comments: [AT[1]] });
  await cli(h, undefined, "ready", "ref-1");
  expect((await store.getReview("ref-1"))!.sends![1]!.readyBy).toEqual({ from: "shell" });
  await store.upsertDraftComment("ref-1", { ...AT[2]!, body: "Fix line 3, please." });
  await h.harness.behavior.callRpc("sendToSourceThread", { targetKey: "ref-1", comments: [AT[2]] });
  await cli(h, "sub", "ready");
  expect((await store.getReview("ref-1"))!.sends![2]!.readyBy).toEqual({ from: "main" });
});

test("ready with nothing out says so and changes nothing; an unknown review names the ones with comments out; a report after Ready doesn't ask for ready again", async () => {
  const h = host();
  const store = await startPlugin(h.bb);
  await sentSix(h, store);
  expect(await cli(h, "coder", "ready", "web#9")).toEqual({ exitCode: 1, stdout: "", stderr: "No review web#9. Reviews with comments out: repo:feature. Give its id as the message that sent you its comments names it, or its key." });
  await cli(h, "coder", "report", "c1", "done");
  await cli(h, "coder", "ready");
  expect(await cli(h, "coder", "report", "c2", "declined")).toMatchObject({ stdout: "Reported c2 declined on repo:feature. 2 of 6 reported." });
  // A review whose comments were all sent again elsewhere, or resolved: nothing is out.
  await store.saveReview({ targetKey: "ref-2", kind: "ref", gitRef: "main...other", status: "ready", createdAt: 2, projectId: "p1", cwd: "/repo" });
  await store.setLifecycle("ref-2", { sourceThreadId: "coder", sends: [{ n: 1, at: 1, threadId: "coder", ids: ["c40"] }] });
  expect(await cli(h, "coder", "ready", "ref-2")).toEqual({ exitCode: 0, stdout: "No comments from repo:other are out with a thread, so there's nothing to finish.", stderr: "" });
  expect((await store.getReview("ref-2"))!.sends![0]!.readyAt).toBeUndefined();
});

test("an inferred claim never replaces a report that came while the check ran, on a GitHub thread too", async () => {
  const h = host();
  const store = await startPlugin(h.bb);
  await store.saveReview({ targetKey: "pr-1", kind: "pr", repo: "acme/web", number: 12, title: "Retry uploads", author: "me", headSha: "abc1234", status: "ready", createdAt: 1, projectId: "p1" });
  await store.setLifecycle("pr-1", { ownPr: true, sourceThreadId: "coder", sends: [{ n: 1, at: 1, threadId: "coder", ids: ["c9"] }], threadSends: { PRRT_1: { id: "c9", sendN: 1 } } });
  // The check read the review before the report landed.
  const stale = (await store.getReview("pr-1"))!;
  await cli(h, "coder", "report", "c9", "done", "--note", "Fixed and replied.");
  const recorded = await assess(store, stale, { items: [{ id: "c9", verdict: "partial", evidence: "Half done.", claimed: "declined" }] }, "agent");
  expect(recorded.ok).toBe(true);
  expect((await store.getReview("pr-1"))!.threadSends!.PRRT_1!.claim).toMatchObject({ outcome: "done", note: "Fixed and replied.", threadId: "coder" });
  expect((await store.getAssessment("pr-1", "send:1")).items).toMatchObject([{ id: "c9", verdict: "partial" }]);
});

test("a check of your feedback, as on a re-request, reads no sent comments and infers no claims; Check fixes waits while the agent answers you", async () => {
  const h = host();
  const store = await startPlugin(h.bb);
  await store.saveReview({ targetKey: "pr-1", kind: "pr", repo: "acme/web", number: 12, title: "Retry uploads", author: "dana", headSha: "abc1234", status: "ready", createdAt: 1, projectId: "p1" });
  await store.setLifecycle("pr-1", { ownPr: false, sourceThreadId: "coder", submittedAt: 5, submittedVerdict: "REQUEST_CHANGES", submittedHeadSha: "abc1234" });
  await store.savePatch("pr-1", PATCH);
  await store.setAssistantThread("pr-1", "agent");
  await store.upsertDraftComment("pr-1", { ...AT[0]!, body: "Fix it." });
  expect(await h.harness.behavior.callRpc("sendToSourceThread", { targetKey: "pr-1", comments: [AT[0]], force: true })).toMatchObject({ ok: true });
  expect(await startVerification(h.bb, store, "pr-1", "the author re-requested the reviewer's review", "automatic")).toBe(true);
  const context = (agentMessages(h)[0]!.data.input as any[]).map((part) => part.text).join("\n");
  expect(context).not.toContain("comment to the main thread");
  expect((await store.getReview("pr-1"))!.verifyingFixes ?? null).toBeNull();
  expect(toolText(await h.harness.behavior.callAgentTool("list_feedback", {}, { threadId: "agent" }))).not.toContain("[c1]");
  expect(toolText(await h.harness.behavior.callAgentTool("assess_feedback", { items: [{ id: "c1", verdict: "addressed", evidence: "x", claimed: "done" }] }, { threadId: "agent" }))).toContain("Unknown item ids: c1");
  expect((await store.getDraft("pr-1")).comments[0]!.claim).toBeUndefined();
  // While the agent answers you, Check fixes waits, as Check again does.
  h.harness.inspection.sdk.stub("threads.get" as any, (async ({ threadId }: { threadId: string }) => threadId === "agent"
    ? { id: "agent", archivedAt: null, deletedAt: null, status: "active", queuedMessageCount: 0, visibility: "hidden" }
    : threadsSdk(h.chat, h.state).get({ threadId })) as any);
  expect(await h.harness.behavior.callRpc("checkFixes", { targetKey: "pr-1" })).toEqual({ ok: false, error: "The assistant is still answering. Try again when it finishes." });
});
