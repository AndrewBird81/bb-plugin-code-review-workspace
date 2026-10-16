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
