import { expect, test, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";

const runGh = vi.hoisted(() => vi.fn());
vi.mock("./gh", async (orig) => ({ ...(await orig<any>()), runGh }));

import { createStore } from "./store";
import { fixMessage, startFixThread } from "./fix-handoff";

const PATCH = [
  "diff --git a/src/a.ts b/src/a.ts", "--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1,3 +1,4 @@",
  " const a = 1;", "-const b = 2;", "+const b = 3;", "+const c = ```;", " export { a };",
].join("\n");

function host(spawn: (args: any) => Promise<unknown> = async () => ({ id: "fixer" }), projectDefaults: unknown = { providerId: "codex", model: "gpt-6", reasoningLevel: "low", permissionMode: "auto" }) {
  const { bb, harness } = createFakePluginHost({ pluginId: "guided-review", sdk: {
    threads: { spawn },
    projects: { defaultExecutionOptions: async () => projectDefaults },
  } as any });
  const store = createStore(bb);
  return { bb, harness, store, spawns: () => harness.inspection.sdk.callsTo("threads.spawn").map((call) => call[0] as any) };
}

function ownPr(store: ReturnType<typeof createStore>, over: Record<string, unknown> = {}) {
  store.saveReview({ targetKey: "pr-1", kind: "pr", repo: "acme/web", number: 12, title: "Retry uploads", author: "alice", head: "retry-uploads", headSha: "abc1234def5678", status: "ready", createdAt: 1, projectId: "p1" } as any);
  store.setLifecycle("pr-1", { ownPr: true, ...over });
  store.savePatch("pr-1", PATCH);
  store.upsertDraftComment("pr-1", { file: "src/a.ts", line: 2, side: "LEFT", body: "Why change b?" });
  store.upsertDraftComment("pr-1", { file: "src/a.ts", line: 3, side: "RIGHT", body: "Name this better." });
}

test("starts a visible thread in the review's project that names the PR, its branch and head, each comment's line and code, and forbids GitHub changes", async () => {
  const { bb, store, spawns } = host();
  ownPr(store);
  const before = store.getDraft("pr-1");
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
  expect(store.getDraft("pr-1")).toEqual(before);
});

test("sends only the comments you chose, with the review agent's execution", async () => {
  const { bb, store, spawns } = host();
  ownPr(store);
  store.savePreferences({ ...store.getPreferences().preferences, assistantAgent: { hostId: "h1", providerId: "claude", model: "opus", reasoningLevel: "high", permissionMode: "accept-edits" } }, store.getPreferences().revision);
  await startFixThread(bb, store, "pr-1", [{ file: "src/a.ts", line: 3, side: "RIGHT" }]);
  const [spawn] = spawns();
  expect(spawn).toMatchObject({ projectId: "p1", environment: { type: "project-default" }, providerId: "claude", model: "opus", reasoningLevel: "high", permissionMode: "accept-edits" });
  expect(spawn.prompt).toContain("Name this better.");
  expect(spawn.prompt).not.toContain("Why change b?");
});

test("a local review names its diff and directory and says which branch to work on", async () => {
  const { bb, store, spawns } = host();
  store.saveReview({ targetKey: "ref-1", kind: "ref", gitRef: "main...feature", status: "ready", createdAt: 1, projectId: "p1", cwd: "/repo" } as any);
  store.savePatch("ref-1", PATCH);
  store.upsertDraftComment("ref-1", { file: "src/a.ts", line: 3, side: "RIGHT", body: "Name this better." });
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
  ownPr(store, { ownPr: false });
  await expect(startFixThread(bb, store, "pr-1", [{ file: "src/a.ts", line: 3, side: "RIGHT" }])).rejects.toThrow("only for your own PR or a local review");
  ownPr(store, { ownPr: null });
  runGh.mockResolvedValue({ stdout: "bob\n", stderr: "", code: 0 });
  await expect(startFixThread(bb, store, "pr-1", [{ file: "src/a.ts", line: 3, side: "RIGHT" }])).rejects.toThrow("only for your own PR or a local review");
  expect(spawns()).toHaveLength(0);
  runGh.mockResolvedValue({ stdout: "Alice\n", stderr: "", code: 0 });
  await expect(startFixThread(bb, store, "pr-1", [{ file: "src/a.ts", line: 3, side: "RIGHT" }])).resolves.toMatchObject({ threadId: "fixer" });
});

test("says why the thread couldn't start", async () => {
  const offline = host(async () => { throw new Error("The machine is offline."); });
  ownPr(offline.store);
  await expect(startFixThread(offline.bb, offline.store, "pr-1", [{ file: "src/a.ts", line: 3, side: "RIGHT" }])).rejects.toThrow("Couldn’t start the thread: The machine is offline.");
  const noAgent = host(undefined, null);
  ownPr(noAgent.store);
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
