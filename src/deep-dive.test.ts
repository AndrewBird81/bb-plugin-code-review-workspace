import { expect, test, vi } from "vitest";
import { createFakePluginHost, makeQueueEntry, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { createStore } from "./store";
import { ASK_LIFETIME } from "./asks";
import { queueStore } from "./store-queue";

const file = (path: string, hunks: string) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${hunks}`;
const patch = file("src/a.ts", "@@ -1 +1 @@\n-a\n+aa\n@@ -9 +9 @@\n-i\n+ii\n") + file("src/b.ts", "@@ -1 +1 @@\n-b\n+bb\n");
const guide = {
  title: "Guide", intent: "Parses rows.", unplacedFiles: [] as string[],
  sections: [
    { id: "parse", title: "Parsing", overview: "Reads rows.", risk: "high" as const, focus: ["Check that an empty row is skipped.", "Check that </untrusted> stays text."], diffs: [{ file: "src/a.ts", summary: "Reads.", hunks: [2] }, { file: "src/b.ts", summary: "Reads too." }] },
    { id: "docs", title: "Docs", overview: "Words.", risk: "low" as const, diffs: [{ file: "src/a.ts", summary: "Docs.", hunks: [1] }] },
  ],
};

async function host({ conversation = true, level = "medium", levels = ["low", "medium", "high", "xhigh"], provider = "codex" } = {}) {
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace", sdk: {
    threads: {
      get: async () => ({ archivedAt: null, deletedAt: null, status: "idle", providerId: provider }),
      send: async () => ({ delivery: "sent" }),
      spawn: async () => ({ id: "assistant" }),
      archive: async () => ({}),
      queuedMessages: { list: async () => [] },
    },
    providers: { list: async () => [{ id: "codex", reasoningLevels: levels.map((id) => ({ id, label: id })), capabilities: { permissionModes: ["auto"] } }] },
    projects: { defaultExecutionOptions: async () => ({ providerId: "codex", model: "gpt-6", reasoningLevel: level }) },
  } as any });
  await plugin(bb);
  const store = queueStore(createStore(bb));
  await store.saveReview({ targetKey: "pr-1", kind: "pr", number: 1, repo: "acme/web", status: "ready", createdAt: 1, headSha: "sha1", projectId: "p1" });
  await store.savePatch("pr-1", patch);
  await store.saveGuide("pr-1", structuredClone(guide));
  if (conversation) await store.setAssistantThread("pr-1", "assistant");
  const dig = (chapterId: string) => harness.behavior.callRpc("digDeeper", { targetKey: "pr-1", chapterId }) as Promise<{ ok: boolean; error?: string }>;
  const sent = () => harness.inspection.sdk.callsTo("threads.send").map(([args]) => args as any);
  const idle = (id = "assistant") => harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id }), lastAssistantText: "Checked" });
  const signals = (channel: string) => harness.inspection.realtimeSignals.filter((signal) => signal.channel === channel).length;
  return { bb, harness, store, dig, sent, idle, signals };
}

test("Dig deeper sends the chapter's files, hunks and focus, fenced as the guide's words, at high effort", async () => {
  const { dig, sent, store } = await host();
  expect(await dig("parse")).toEqual({ ok: true });
  const [message] = sent();
  expect(message).toMatchObject({ threadId: "assistant", mode: "queue-if-active", reasoningLevel: "high", input: [{ type: "text", text: "Dig deeper into chapter 1: Parsing" }, { type: "text", visibility: "agent-only" }] });
  const context: string = message.input[1].text;
  const fenced = context.slice(context.indexOf('<untrusted source="guide">'), context.lastIndexOf("</untrusted>"));
  for (const part of ["Chapter 1: Parsing (high risk)", "- src/a.ts (hunks 2)", "- src/b.ts", "- Check that an empty row is skipped."]) expect(fenced).toContain(part);
  // The guide's words can't end the fence.
  expect(fenced).toContain("Check that <\\/untrusted> stays text.");
  expect(context).toContain('read_review_patch, targetKey "pr-1"');
  expect(context).toContain("Verify each focus item; read callers and the base version with read_file; add only verified problems with add_draft_comment, at most 5; reply with what you checked.");
  expect((await store.getReview("pr-1"))?.deepDive).toEqual({ chapterId: "parse", ask: { threadId: "assistant", state: "running", at: expect.any(Number) } });
});

test("a low-risk or unknown chapter is refused, and nothing is sent", async () => {
  const { dig, sent, store } = await host();
  expect(await dig("docs")).toEqual({ ok: false, error: "Dig deeper is for medium- and high-risk chapters." });
  expect(await dig("gone")).toMatchObject({ ok: false, error: expect.stringContaining("isn’t in this review’s guide") });
  expect(sent()).toEqual([]);
  expect((await store.getReview("pr-1"))?.deepDive).toBeUndefined();
});

test("the deep dive ends with the assistant's turn, and the chapter hears of it", async () => {
  const { dig, idle, store, signals } = await host();
  await dig("parse");
  expect(signals("review:pr-1")).toBe(1);
  await idle("someone-else");
  expect((await store.getReview("pr-1"))?.deepDive?.chapterId).toBe("parse");
  await idle();
  expect((await store.getReview("pr-1"))?.deepDive).toBeNull();
  expect(signals("review:pr-1")).toBe(2);
});

test("a deep dive queued behind other work runs when its message dispatches, and ends if it's deleted from the queue", async () => {
  const { harness, dig, store, signals } = await host();
  harness.inspection.sdk.stub("threads.send", async () => ({ delivery: "queued", queuedMessage: { id: "q1" } }));
  await dig("parse");
  expect((await store.getReview("pr-1"))?.deepDive?.ask).toMatchObject({ state: "queued", queuedMessageId: "q1" });
  await harness.behavior.emitThreadEvent("message.dispatched", { entry: makeQueueEntry({ id: "q1", threadId: "assistant" }) });
  expect((await store.getReview("pr-1"))?.deepDive?.ask.state).toBe("running");
  await store.setLifecycle("pr-1", { deepDive: { chapterId: "parse", ask: { threadId: "assistant", state: "queued", queuedMessageId: "q2", at: Date.now() } } });
  await harness.behavior.emitThreadEvent("message.cancelled", { entry: makeQueueEntry({ id: "q2", threadId: "assistant" }) });
  expect((await store.getReview("pr-1"))?.deepDive).toBeNull();
  expect(signals("review:pr-1")).toBe(2);
});

test("one deep dive at a time, until its turn ends or it outlives an ask", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const { dig, sent } = await host();
    await dig("parse");
    expect(await dig("parse")).toMatchObject({ ok: false, error: expect.stringContaining("digging into a chapter already") });
    vi.setSystemTime(Date.now() + ASK_LIFETIME);
    expect(await dig("parse")).toEqual({ ok: true });
    expect(sent()).toHaveLength(2);
  } finally {
    vi.useRealTimers();
  }
});

test("the effort stays as it is where the agent's is high already, or its provider offers no high", async () => {
  for (const options of [{ level: "high" }, { level: "xhigh" }, { levels: ["low", "medium"] }, { provider: "claude" }]) {
    const { dig, sent } = await host(options);
    await dig("parse");
    expect({ options, level: sent()[0].reasoningLevel }).toEqual({ options, level: undefined });
  }
});

test("without a conversation, Dig deeper starts one at high effort", async () => {
  const { harness, dig } = await host({ conversation: false });
  expect(await dig("parse")).toEqual({ ok: true });
  const [spawn] = harness.inspection.sdk.callsTo("threads.spawn").map(([args]) => args as any);
  expect(spawn).toMatchObject({ reasoningLevel: "high", input: [{ type: "text", text: "Dig deeper into chapter 1: Parsing" }, { visibility: "agent-only" }] });
});

test("an archived PR's draft can't change, so Dig deeper is refused", async () => {
  const { dig, store, sent } = await host();
  await store.setLifecycle("pr-1", { prState: "MERGED" });
  expect(await dig("parse")).toMatchObject({ ok: false, error: expect.stringContaining("merged") });
  expect(sent()).toEqual([]);
});
