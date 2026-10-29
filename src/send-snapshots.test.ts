// Each Send's diff, kept as the snapshot send:<n> while the review keeps the Send; Since your last Send, which compares
// with it without a head or GitHub; and Update, which shows a local review's new diff without the guide writer.
import { expect, test, vi } from "vitest";

const NOW = vi.hoisted(() => ({ diff: "" }));
vi.mock("./gh", async (orig) => {
  const real = await orig<typeof import("./gh")>();
  return {
    ...real,
    runGh: vi.fn(async () => ({ stdout: "", stderr: "no GitHub here", code: 1 })),
    runGit: vi.fn(async () => ({ stdout: NOW.diff, stderr: "", code: 0 })),
  };
});
vi.mock("./store-queue", async (original) => {
  const actual = await original<typeof import("./store-queue")>();
  return { ...actual, queueStore: vi.fn(actual.queueStore) };
});

import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { pruneDiffs, sinceReview } from "./feedback-view";
import { sendBaselineOf } from "../lib/send-baseline";
import type { ReviewMeta, SendEntry, SnapshotFiles } from "./store";
import { testStore } from "./test-store.test-support";
import type { AsyncStore } from "./store-queue";
import { startPlugin } from "./plugin-store.test-support";
import { toolFailed, toolText } from "./fake-host.test-support";
import * as gh from "./gh";

const hunk = (line: number, before: string, after: string) => `@@ -${line} +${line} @@\n-${before}\n+${after}\n`;
const file = (path: string, ...hunks: string[]) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${hunks.join("")}`;
// At Send 1, then after the main thread changed one hunk of b.ts.
const SENT = file("a.ts", hunk(1, "a", "A")) + file("b.ts", hunk(1, "x", "X"), hunk(20, "y", "Y"));
const FIXED = file("a.ts", hunk(1, "a", "A")) + file("b.ts", hunk(1, "x", "X"), hunk(20, "y", "Y-fixed"));
const FILES: SnapshotFiles = { revisions: { "a.ts": "r1", "b.ts": "r2" }, hidden: [{ path: ".env", reason: "secret" }] };
const send = (n: number, at = n * 1000): SendEntry => ({ n, at, threadId: "thr_main", ids: [`c${n}`] });
const noGitHub = vi.fn(async () => { throw new Error("GitHub was read"); });

/** `writing`: a guide writer stays at work, as one does for minutes. */
function host({ writing = false } = {}) {
  const spawn = vi.fn(async () => ({ id: "writer-1" }));
  const h = createFakePluginHost({ pluginId: "code-review-workspace", sdk: { threads: {
    get: async () => ({ title: null, archivedAt: null, deletedAt: null, status: writing ? "running" : "idle" }),
    spawn, wait: writing ? () => new Promise(() => {}) : async () => ({}), archive: async () => ({}), stop: async () => ({}),
  } } as any });
  return { ...h, spawn };
}

/** A local review of a checkout, with no head commit, whose diff was sent as Send 1. */
async function localReview(store: AsyncStore, sends: SendEntry[] = [send(1)]) {
  await store.saveReview({ targetKey: "ref-1", kind: "ref", gitRef: "main...feature", cwd: process.cwd(), status: "ready", createdAt: 1, projectId: "p1" });
  await store.savePatch("ref-1", FIXED);
  await store.saveSnapshot("ref-1", "send:1", SENT);
  await store.setLifecycle("ref-1", { sends });
  return (await store.getReview("ref-1"))!;
}

test("pruneDiffs keeps each Send's snapshot and its files while the review keeps the Send, and drops those the 20-Send cap dropped", async () => {
  const store = testStore(host().bb);
  await store.saveReview({ targetKey: "pr-1", kind: "pr", repo: "acme/web", number: 1, headSha: "sha1", status: "ready", createdAt: 1 });
  await store.savePatch("pr-1", SENT);
  await store.saveSnapshot("pr-1", "sha1", SENT);
  await store.upsertDraftComment("pr-1", { file: "a.ts", line: 1, side: "RIGHT", body: "Name it." });
  // Send 1's comment is still sent, so the review keeps Send 1 past the cap; Send 2 isn't named, so it goes.
  await store.trackComments("pr-1", [{ at: { file: "a.ts", line: 1, side: "RIGHT" }, id: "c1", state: "sent", sendN: 1 }]);
  await store.setLifecycle("pr-1", { sends: Array.from({ length: 22 }, (_, i) => send(i + 1)) });
  for (const n of [1, 2, 22]) {
    await store.saveSnapshot("pr-1", `send:${n}`, SENT);
    await store.saveSnapshotFiles("pr-1", `send:${n}`, FILES);
  }
  await pruneDiffs(store, (await store.getReview("pr-1"))!);
  for (const n of [1, 22]) {
    expect(await store.getSnapshot("pr-1", `send:${n}`)).toBe(SENT);
    expect(await store.getSnapshotFiles("pr-1", `send:${n}`)).toEqual(FILES);
  }
  expect([await store.getSnapshot("pr-1", "send:2"), await store.getSnapshotFiles("pr-1", "send:2")]).toEqual([null, null]);
  expect(await store.getSnapshot("pr-1", "sha1")).toBe(SENT);
});

test("each comment's baseline is the Send it went in; without one it's the last Send, and a Send the review no longer keeps is none", () => {
  const review: Pick<ReviewMeta, "sends"> = { sends: [send(1, 100), send(3, 300)] };
  expect(sendBaselineOf(review, 1)).toEqual({ n: 1, key: "send:1", at: 100 });
  expect(sendBaselineOf(review, 3)).toEqual({ n: 3, key: "send:3", at: 300 });
  expect(sendBaselineOf(review)).toEqual({ n: 3, key: "send:3", at: 300 });
  expect(sendBaselineOf(review, 2)).toBeNull();
  expect(sendBaselineOf({})).toBeNull();
});

test("Since your last Send on a local review with no head shows only the hunk that changed, without reading GitHub", async () => {
  const store = testStore(host().bb);
  const review = await localReview(store);
  const since = await sinceReview(store, noGitHub, review, "send:1");
  expect(since?.baseline).toEqual({ sha: "send:1", at: 1000, verdict: null });
  expect(since?.files.map((f) => [f.file, f.status])).toEqual([["a.ts", "unchanged"], ["b.ts", "changed"]]);
  const b = since!.files.find((f) => f.file === "b.ts")!;
  expect(b.patch).toContain("+Y-fixed");
  expect(b.patch).not.toContain("+X");
  expect(noGitHub).not.toHaveBeenCalled();
});

test("a Send whose diff isn't kept, as after 1.7.0's prune, fails to compare instead of saying nothing changed", async () => {
  const store = testStore(host().bb);
  const review = await localReview(store, [send(1), send(2)]);
  await expect(sinceReview(store, noGitHub, review, "send:2")).rejects.toThrow("The diff Send 2 went at isn’t kept anymore.");
  await expect(sinceReview(store, noGitHub, review, "send:7")).rejects.toThrow("Send 7 isn’t kept anymore.");
  expect(noGitHub).not.toHaveBeenCalled();
});

test("on a PR with Sends, Since your review still compares with your review, and the page can ask for the last Send", async () => {
  const { bb, harness } = host();
  const store = await startPlugin(bb);
  await store.saveReview({ targetKey: "pr-1", kind: "pr", repo: "acme/web", number: 1, headSha: "sha2", status: "ready", createdAt: 1 });
  await store.savePatch("pr-1", FIXED);
  await store.saveSnapshot("pr-1", "sha1", SENT);
  await store.saveSnapshot("pr-1", "send:1", FIXED);
  await store.setLifecycle("pr-1", { signals: { lastReviewAt: 10, lastReviewSha: "sha1" } as ReviewMeta["signals"], sends: [send(1)] });
  const call = (input: unknown) => harness.behavior.callRpc("getSinceReview", input) as Promise<any>;
  const review = await call({ targetKey: "pr-1" });
  expect(review.baseline.sha).toBe("sha1");
  expect(review.files.find((f: any) => f.file === "b.ts").status).toBe("changed");
  const sent = await call({ targetKey: "pr-1", from: "send:1" });
  expect(sent.baseline).toEqual({ sha: "send:1", at: 1000, verdict: null });
  expect(sent.files.every((f: any) => f.status === "unchanged")).toBe(true);
  await expect(call({ targetKey: "pr-1", from: "send:x" })).rejects.toThrow();
});

test("read_changes_since_review compares a local review with its last Send, or the Send asked for, and says when that diff is gone", async () => {
  const { bb, harness } = host();
  const store = await startPlugin(bb);
  NOW.diff = FIXED;
  await localReview(store, [send(1), send(2)]);
  await store.setAssistantThread("ref-1", "agent-1");
  const read = (input: Record<string, unknown>) => harness.behavior.callAgentTool("read_changes_since_review", input, { threadId: "agent-1" });
  // Send 2's diff isn't kept: the last Send can't be compared, and it doesn't say nothing changed.
  const gone = await read({});
  expect(toolFailed(gone)).toBe(true);
  expect(toolText(gone)).toContain("The diff Send 2 went at isn't kept anymore");
  expect(toolText(gone)).not.toMatch(/No changes/);
  const first = await read({ send: 1 });
  expect(toolFailed(first)).toBe(false);
  expect(toolText(first)).toContain("Since Send 1: 1 changed, 0 added, 0 removed, 1 unchanged files.");
  expect(toolText(first)).toContain("+Y-fixed");
  const unknown = await read({ send: 5 });
  expect(toolFailed(unknown)).toBe(true);
  expect(toolText(unknown)).toContain("This review keeps no Send 5.");
});

test("read_changes_since_review compares a Send with the code now, not the diff the review shows, which Update or a rebuild hasn't caught up", async () => {
  const { bb, harness } = host();
  const store = await startPlugin(bb);
  const read = (input: Record<string, unknown>) => harness.behavior.callAgentTool("read_changes_since_review", input, { threadId: "agent-1" });
  // A local review whose diff is still Send 1's: the main thread fixed b.ts since, and nobody clicked Update.
  await localReview(store);
  await store.savePatch("ref-1", SENT);
  await store.setAssistantThread("ref-1", "agent-1");
  NOW.diff = FIXED;
  const local = toolText(await read({ send: 1 }));
  expect(local).toContain("Since Send 1: 1 changed");
  expect(local).toContain("+Y-fixed");
  // The checkout can't be read: it fails, rather than compare with the diff shown.
  vi.mocked(gh.runGit).mockResolvedValueOnce({ stdout: "", stderr: "fatal: not a git repository", code: 128 });
  const unread = await read({ send: 1 });
  expect(toolFailed(unread)).toBe(true);
  expect(toolText(unread)).toContain("not a git repository");

  // Your own PR, its guide at sha1, which Send 1 went at; the fixer pushed sha2.
  await store.saveReview({ targetKey: "pr-1", kind: "pr", repo: "acme/web", number: 1, headSha: "sha1", status: "ready", createdAt: 1 });
  await store.savePatch("pr-1", SENT);
  await store.saveSnapshot("pr-1", "send:1", SENT);
  await store.saveSnapshot("pr-1", "sha2", FIXED);
  await store.setLifecycle("pr-1", { latestHeadSha: "sha2", sends: [send(1)] });
  await store.setAssistantThread("pr-1", "agent-2");
  const pr = toolText(await harness.behavior.callAgentTool("read_changes_since_review", {}, { threadId: "agent-2" }));
  expect(pr).toContain("and the code now (sha2)");
  expect(pr).toContain("+Y-fixed");
});

test("Rewrite guide keeps an archived review's guide, as Update guide does", async () => {
  const { bb, harness, spawn } = host();
  const store = await startPlugin(bb);
  await localReview(store);
  await store.saveGuide("ref-1", { title: "T", intent: "I", unplacedFiles: [], sections: [], hotspots: [] } as any);
  await store.setLifecycle("ref-1", { archivedAt: 5 });
  expect(await harness.behavior.callRpc("rewriteGuide", { targetKey: "ref-1" })).toMatchObject({ ok: false, error: expect.stringContaining("archived") });
  expect(spawn).not.toHaveBeenCalled();
});

test("Update shows a local review's new diff, moving its comments, and keeps the guide without starting the guide writer", async () => {
  const { bb, harness, spawn } = host({ writing: true });
  const store = await startPlugin(bb);
  await localReview(store);
  await store.savePatch("ref-1", SENT);
  const guide = { title: "T", intent: "I", unplacedFiles: [], sections: [{ id: "s", title: "S", overview: "o", risk: "low", diffs: [{ file: "b.ts", summary: "s" }] }], hotspots: [] };
  await store.saveGuide("ref-1", guide as any);
  await store.upsertDraftComment("ref-1", { file: "b.ts", line: 20, side: "RIGHT", body: "Check y." });
  // Two lines added above it: the comment follows its line.
  NOW.diff = file("a.ts", hunk(1, "a", "A")) + file("b.ts", hunk(1, "x", "X"), "@@ -20 +20,3 @@\n-y\n+new1\n+new2\n+Y\n");
  expect(await harness.behavior.callRpc("updateFeature", { targetKey: "ref-1" })).toEqual({ ok: true });
  expect(await store.patch("ref-1")).toBe(NOW.diff);
  expect(await store.getGuide("ref-1")).toMatchObject({ title: "T" });
  expect((await store.getReview("ref-1"))!.status).toBe("ready");
  expect((await store.getDraft("ref-1")).comments.map((c) => [c.line, c.body])).toEqual([[22, "Check y."]]);
  // Send 1's diff stays for Since your last Send.
  expect(await store.getSnapshot("ref-1", "send:1")).toBe(SENT);
  expect(spawn).not.toHaveBeenCalled();
  // Rewrite guide does start it.
  expect(await harness.behavior.callRpc("rewriteGuide", { targetKey: "ref-1" })).toEqual({ ok: true });
  expect(spawn).toHaveBeenCalledTimes(1);
  expect((await store.getReview("ref-1"))!.status).toBe("generating");
  // While it writes, Update waits for it.
  expect(await harness.behavior.callRpc("updateFeature", { targetKey: "ref-1" })).toMatchObject({ ok: false, error: expect.stringContaining("Update once it’s done") });
});

test("Update is a local review's: a PR updates with Update guide", async () => {
  const { bb, harness } = host();
  const store = await startPlugin(bb);
  await store.saveReview({ targetKey: "pr-1", kind: "pr", repo: "acme/web", number: 1, headSha: "sha1", status: "ready", createdAt: 1 });
  expect(await harness.behavior.callRpc("updateFeature", { targetKey: "pr-1" })).toMatchObject({ ok: false, error: expect.stringContaining("Update guide") });
});
