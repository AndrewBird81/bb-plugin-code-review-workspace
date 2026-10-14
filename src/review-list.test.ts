import { test, expect } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { createStore } from "./store";

test("the list carries each review's lifecycle and turn, without its review summaries, and the sync's health", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "guided-review" });
  await plugin(bb);
  const store = createStore(bb);
  store.saveReview({ targetKey: "pr-1", kind: "pr", number: 1, repo: "acme/web", status: "ready", createdAt: 1 });
  store.saveReview({ targetKey: "pr-2", kind: "pr", number: 2, repo: "acme/web", status: "ready", createdAt: 2 });
  store.setLifecycle("pr-1", { submittedVerdict: "APPROVE", submittedAt: 5, reviewBodies: [{ state: "APPROVED", at: 5, body: "Ship it" }] });
  const { reviews, sync } = await harness.behavior.callRpc("listReviews", null) as any;
  expect(reviews.map((r: any) => [r.targetKey, r.submittedVerdict ?? null, r.turn.group])).toEqual([["pr-2", null, "needs"], ["pr-1", "APPROVE", "reviewed"]]);
  expect(reviews[1]).not.toHaveProperty("reviewBodies");
  expect(sync).toEqual({ lastReadAt: null, error: null });
  // A single review still has them, for the assistant's tools.
  expect(store.getReview("pr-1")?.reviewBodies).toHaveLength(1);
});

test("reviews leave the server with their place in a stack, in the list and alone", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "guided-review" });
  await plugin(bb);
  const store = createStore(bb);
  store.saveReview({ targetKey: "pr-1", kind: "pr", number: 1, repo: "acme/web", base: "main", head: "feat-a", status: "ready", createdAt: 1 });
  store.saveReview({ targetKey: "pr-2", kind: "pr", number: 2, repo: "acme/web", base: "feat-a", head: "feat-b", status: "tracked", createdAt: 2 });
  const { reviews } = await harness.behavior.callRpc("listReviews", null) as any;
  expect(reviews.find((r: any) => r.targetKey === "pr-2").stack).toMatchObject({ index: 1, parent: { number: 1, targetKey: "pr-1" } });
  const { review } = await harness.behavior.callRpc("getReviewBundle", { targetKey: "pr-1" }) as any;
  expect(review.stack).toMatchObject({ index: 0, children: [{ number: 2, targetKey: "pr-2", status: "tracked" }] });
  expect(review.stack.members).toHaveLength(2);
});
