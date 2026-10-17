// What the review's assistant read through Guided Review, which Finish review counts beside its verdict.
import { expect, test, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { createStore } from "./store";
import { runGh } from "./gh";
import { createReviewSubmitter } from "./submit-review";

vi.mock("./gh", async (original) => ({ ...await original<typeof import("./gh")>(), runGh: vi.fn(async () => ({ code: 0, stdout: "x\n", stderr: "" })) }));

const file = (path: string) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`;
const patch = file("a.ts") + file("b.ts") + file("c.ts");

async function host() {
  const { bb, harness } = createFakePluginHost({ pluginId: "guided-review" });
  await plugin(bb);
  const store = createStore(bb);
  store.saveReview({ targetKey: "pr-1", kind: "pr", number: 1, repo: "acme/web", status: "ready", createdAt: 1, headSha: "sha1" });
  store.savePatch("pr-1", patch);
  store.setAssistantThread("pr-1", "assistant");
  const call = (tool: string, input: Record<string, unknown>, threadId = "assistant") => harness.behavior.callAgentTool(tool, input, { threadId });
  return { harness, store, call };
}

test("the assistant's diff pages, one file's diff, and read_file of a changed file are recorded for its review's head", async () => {
  const { store, call } = await host();
  // A page of a.ts and b.ts.
  await call("read_review_patch", { targetKey: "pr-1", limit: file("a.ts").length + file("b.ts").length });
  expect(store.getReview("pr-1")?.agentReads).toEqual({ head: "sha1", files: ["a.ts", "b.ts"] });
  await call("read_review_patch", { targetKey: "pr-1", file: "b.ts" });
  await call("read_file", { path: "c.ts" });
  // A file the PR didn't change isn't one of its files.
  await call("read_file", { path: "README.md" });
  expect(store.getReview("pr-1")?.agentReads).toEqual({ head: "sha1", files: ["a.ts", "b.ts", "c.ts"] });
});

test("a new head starts the reads again, and a read file that failed isn't counted", async () => {
  const { store, call } = await host();
  await call("read_review_patch", { targetKey: "pr-1", file: "a.ts" });
  store.saveReview({ ...store.getReview("pr-1")!, headSha: "sha2" });
  await call("read_review_patch", { targetKey: "pr-1", file: "b.ts" });
  expect(store.getReview("pr-1")?.agentReads).toEqual({ head: "sha2", files: ["b.ts"] });
  vi.mocked(runGh).mockResolvedValueOnce({ code: 1, stdout: "", stderr: "not found" });
  await call("read_file", { path: "c.ts" });
  expect(store.getReview("pr-1")?.agentReads?.files).toEqual(["b.ts"]);
});

test("the guide writer's reads don't count, and All reviews' list doesn't carry the reads", async () => {
  const { harness, store, call } = await host();
  store.setGenerationWorker("pr-1", store.beginGeneration("pr-1"), "writer");
  expect(await call("read_review_patch", { targetKey: "pr-1" }, "writer")).toContain("+new");
  expect(store.getReview("pr-1")?.agentReads).toBeUndefined();
  await call("read_review_patch", { targetKey: "pr-1", file: "a.ts" });
  const { reviews } = await harness.behavior.callRpc("listReviews", null) as any;
  expect(reviews[0]).not.toHaveProperty("agentReads");
  expect((await harness.behavior.callRpc("getReviewBundle", { targetKey: "pr-1" }) as any).review.agentReads).toEqual({ head: "sha1", files: ["a.ts"] });
});

test("what the agent says it didn't check is kept with its summary, stays without it, and never posts", async () => {
  const { store, call } = await host();
  await call("set_review_summary", { body: "Looks right.", verdict: "APPROVE", unchecked: ["Didn't run the tests", "Skipped c.ts"] });
  expect(store.getDraft("pr-1").unchecked).toEqual(["Didn't run the tests", "Skipped c.ts"]);
  await call("set_review_summary", { body: "Still looks right.", verdict: "APPROVE" });
  expect(store.getDraft("pr-1").unchecked).toEqual(["Didn't run the tests", "Skipped c.ts"]);
  await expect(call("set_review_summary", { body: "x", unchecked: ["1", "2", "3", "4", "5", "6"] })).rejects.toThrow();
  const run = vi.fn(async (args: string[]) => ({ code: 0, stderr: "", stdout: args[0] === "pr" ? JSON.stringify({ headRefOid: "sha1" }) : "{}" }));
  const { comments, body, verdict } = store.getDraft("pr-1");
  expect(await createReviewSubmitter(store, run as any)("pr-1", undefined, undefined, comments, { body, verdict })).toEqual({ ok: true });
  const posted = (run.mock.calls.at(-1) as any)[1].stdin as string;
  expect(posted).toContain("Still looks right.");
  expect(posted).not.toContain("Didn't run the tests");
  expect(store.getDraft("pr-1")).not.toHaveProperty("unchecked");
});

test("after the upgrade that adds unchecked and introduced, idle review assistants restart once to pick up the tools", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "guided-review", sdk: { threads: { get: async () => ({ status: "idle", archivedAt: null, deletedAt: null }), stop: async () => ({}) } } as any });
  const store = createStore(bb);
  store.saveReview({ targetKey: "pr-1", kind: "pr", number: 1, repo: "acme/web", status: "ready", createdAt: 1, headSha: "sha1" });
  store.setAssistantThread("pr-1", "assistant");
  // The version 0.7.0's tools were recorded at.
  await bb.storage.kv.set("assistant-tools", 7);
  await plugin(bb);
  await vi.waitFor(async () => expect(await bb.storage.kv.get("assistant-tools")).toBeGreaterThan(7));
  expect(harness.inspection.sdk.callsTo("threads.stop").map(([args]) => (args as any).threadId)).toEqual(["assistant"]);
});

test("a local review's bundle drops the reads of its diff before a rebuild; a PR's at the same head keeps them", async () => {
  const { harness, store, call } = await host();
  const bundled = async (targetKey: string) => (await harness.behavior.callRpc("getReviewBundle", { targetKey }) as any).review.agentReads;
  store.saveReview({ targetKey: "ref-1", kind: "ref", gitRef: "main...feature", cwd: "/repo", status: "ready", createdAt: 1 });
  store.savePatch("ref-1", patch);
  store.setAssistantThread("ref-1", "local-assistant");
  await call("read_review_patch", { targetKey: "ref-1", file: "a.ts" }, "local-assistant");
  expect(await bundled("ref-1")).toEqual({ head: expect.stringMatching(/^diff:/), files: ["a.ts"] });
  // Update guide reads the diff again, unchanged.
  store.savePatch("ref-1", patch);
  expect((await bundled("ref-1"))?.files).toEqual(["a.ts"]);
  store.savePatch("ref-1", file("a.ts") + file("d.ts"));
  expect(await bundled("ref-1")).toBeNull();
  await call("read_review_patch", { targetKey: "pr-1", file: "a.ts" });
  expect(await bundled("pr-1")).toEqual({ head: "sha1", files: ["a.ts"] });
});

test("a read past the end fails, naming the length, and isn't counted", async () => {
  const { store, call } = await host();
  const page = await call("read_review_patch", { targetKey: "pr-1", offset: 90_000 }) as any;
  expect(page.isError).toBe(true);
  expect(page.content[0].text).toBe(`offset 90000 is past the end of the diff (${patch.length} bytes).`);
  const one = await call("read_review_patch", { targetKey: "pr-1", file: "a.ts", offset: 500 }) as any;
  expect(one.isError).toBe(true);
  expect(one.content[0].text).toBe(`offset 500 is past the end of a.ts's diff (${file("a.ts").length} bytes).`);
  // Each file holds one line.
  const lines = await call("read_file", { path: "b.ts", startLine: 5 }) as any;
  expect(lines.isError).toBe(true);
  expect(lines.content[0].text).toBe("startLine 5 is past the end: b.ts at sha1 has 1 line.");
  expect((await call("read_file", { path: "b.ts", startLine: 3, endLine: 2 }) as any).isError).toBe(true);
  expect(store.getReview("pr-1")?.agentReads).toBeUndefined();
});

test("read_file counts a changed file read as the change leaves it, not at its base or the reviewed commit", async () => {
  const { store, call } = await host();
  store.setLifecycle("pr-1", { submittedHeadSha: "sha0", submittedAt: 10, submittedVerdict: "COMMENT" });
  store.saveReview({ ...store.getReview("pr-1")!, base: "main" });
  const original = vi.mocked(runGh).getMockImplementation()!;
  vi.mocked(runGh).mockImplementation(async (args: string[]) => ({ code: 0, stderr: "", stdout: args.some((a) => a.includes("/compare/")) ? "base1\n" : "x\n" }));
  try {
    expect(await call("read_file", { path: "a.ts", ref: "base" })).toContain("a.ts at base1");
    expect(await call("read_file", { path: "b.ts", ref: "reviewed" })).toContain("b.ts at sha0");
  } finally { vi.mocked(runGh).mockImplementation(original); }
  expect(store.getReview("pr-1")?.agentReads).toBeUndefined();
  await call("read_file", { path: "c.ts", ref: "current" });
  expect(store.getReview("pr-1")?.agentReads?.files).toEqual(["c.ts"]);
});

test("list_review_files reads on from an offset, and says when the offset is past the end", async () => {
  const { call } = await host();
  expect(await call("list_review_files", { targetKey: "pr-1", offset: 1, limit: 1 })).toMatch(/^3 files .*\nb\.ts · modified .*\n\[Files 2–2 of 3 — call again with offset=2\]$/);
  expect(await call("list_review_files", { targetKey: "pr-1", offset: 3 })).toMatchObject({ isError: true, content: [{ text: "offset 3 is past the end of the list (3 files)." }] });
});

test("list_review_files' description names every status, the sources renames and copies name, and its pages", async () => {
  const { harness } = await host();
  const { tools } = await harness.behavior.resolveAgentConfiguration({
    pluginMetadata: {}, thread: { id: "assistant", title: "Review agent: pr-1", parentThreadId: null, sourceThreadId: null },
    project: { id: "p1", kind: "personal", name: "Personal", gitRemoteUrl: null },
    environment: { id: "env-1", name: null, path: null, workspaceProvisionType: "unmanaged", branchName: null },
    host: { id: "host-1", name: "h" }, provider: { id: "claude-code", model: "opus", capabilities: { supportsNativeUserQuestion: false } },
    origin: { kind: null, pluginId: "guided-review" },
  } as any);
  const description = tools.find((tool) => tool.name === "list_review_files")?.description;
  for (const said of ["added, deleted, modified, \"renamed from ‹path›\" or \"copied from ‹path›\", naming the source", "call again with the offset it gives"]) expect(description).toContain(said);
});
