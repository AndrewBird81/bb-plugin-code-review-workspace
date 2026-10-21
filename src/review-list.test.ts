import { test, expect } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { testStore } from "./test-store.test-support";

test("the list carries each review's lifecycle and turn, without its review summaries, and the sync's health", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace" });
  await plugin(bb);
  const store = testStore(bb);
  await store.saveReview({ targetKey: "pr-1", kind: "pr", number: 1, repo: "acme/web", status: "ready", createdAt: 1 });
  await store.saveReview({ targetKey: "pr-2", kind: "pr", number: 2, repo: "acme/web", status: "ready", createdAt: 2 });
  await store.setLifecycle("pr-1", { submittedVerdict: "APPROVE", submittedAt: 5, reviewBodies: [{ state: "APPROVED", at: 5, body: "Ship it" }] });
  const { reviews, sync } = await harness.behavior.callRpc("listReviews", null) as any;
  expect(reviews.map((r: any) => [r.targetKey, r.submittedVerdict ?? null, r.turn.group])).toEqual([["pr-2", null, "needs"], ["pr-1", "APPROVE", "reviewed"]]);
  expect(reviews[1]).not.toHaveProperty("reviewBodies");
  expect(sync).toEqual({ lastReadAt: null, error: null });
  // A single review still has them, for the assistant's tools.
  expect((await store.getReview("pr-1"))?.reviewBodies).toHaveLength(1);
});

test("reviews leave the server with their place in a stack, in the list and alone", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace" });
  await plugin(bb);
  const store = testStore(bb);
  await store.saveReview({ targetKey: "pr-1", kind: "pr", number: 1, repo: "acme/web", base: "main", head: "feat-a", status: "ready", createdAt: 1 });
  await store.saveReview({ targetKey: "pr-2", kind: "pr", number: 2, repo: "acme/web", base: "feat-a", head: "feat-b", status: "tracked", createdAt: 2 });
  const { reviews } = await harness.behavior.callRpc("listReviews", null) as any;
  expect(reviews.find((r: any) => r.targetKey === "pr-2").stack).toMatchObject({ index: 1, parent: { number: 1, targetKey: "pr-1" } });
  const { review } = await harness.behavior.callRpc("getReviewBundle", { targetKey: "pr-1" }) as any;
  expect(review.stack).toMatchObject({ index: 0, children: [{ number: 2, targetKey: "pr-2", status: "tracked" }] });
  expect(review.stack.members).toHaveLength(2);
});

test("bb review list gives a renamed review's name beside its title, quoted, and in its JSON", async () => {
  const { runListCommand } = await import("./list-command");
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace" });
  await plugin(bb);
  const store = testStore(bb);
  await store.saveReview({ targetKey: "pr-1", kind: "pr", number: 1, repo: "acme/web", title: "Expire cache entries", status: "ready", createdAt: 1 });
  await store.saveReview({ targetKey: "pr-2", kind: "pr", number: 2, repo: "acme/web", title: "Fix login", status: "ready", createdAt: 2 });
  await store.setLifecycle("pr-1", { name: "Cache expiry" });
  const { reviews } = await harness.behavior.callRpc("listReviews", null) as any;
  const lines = runListCommand(reviews, []).stdout!.split("\n");
  expect(lines.find((line) => line.startsWith("pr-1"))).toBe(`pr-1  "Expire cache entries" named "Cache expiry" · Needs review (Ready) · guide ready`);
  expect(lines.find((line) => line.startsWith("pr-2"))).toBe(`pr-2  "Fix login" · Needs review (Ready) · guide ready`);
  const json = JSON.parse(runListCommand(reviews, ["--json"]).stdout!).reviews;
  expect(json.find((row: any) => row.key === "pr-1")).toMatchObject({ title: "Expire cache entries", name: "Cache expiry" });
  expect(json.find((row: any) => row.key === "pr-2")).not.toHaveProperty("name");
});

test("bb review list keeps a stack's reviews together, bottom first, where its first one is, as All reviews does", async () => {
  const { runListCommand } = await import("./list-command");
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace" });
  await plugin(bb);
  const store = testStore(bb);
  await store.saveReview({ targetKey: "pr-1", kind: "pr", number: 1, repo: "acme/web", base: "main", head: "feat-a", status: "ready", createdAt: 1 });
  await store.saveReview({ targetKey: "pr-2", kind: "pr", number: 2, repo: "acme/web", base: "main", head: "other", status: "ready", createdAt: 2 });
  await store.saveReview({ targetKey: "pr-3", kind: "pr", number: 3, repo: "acme/web", base: "feat-a", head: "feat-b", status: "ready", createdAt: 3 });
  const { reviews } = await harness.behavior.callRpc("listReviews", null) as any;
  const keys = (stdout: string) => (JSON.parse(stdout) as { reviews: { key: string }[] }).reviews.map((review) => review.key);
  const listed = keys(runListCommand(reviews, ["--json"]).stdout!);
  // Wherever the section puts the stack's first review, its bottom comes right before its top.
  expect(listed).toHaveLength(3);
  expect(listed.indexOf("pr-3") - listed.indexOf("pr-1")).toBe(1);
  expect(runListCommand(reviews, []).stdout!.split("\n").map((line) => line.split(" ")[0])).toEqual(listed);
});
