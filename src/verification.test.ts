import { expect, test } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { startVerification, verificationContext } from "./verification";
import { createStore, type ReviewMeta } from "./store";
import { defaultPreferences } from "./preferences";

const review: ReviewMeta = {
  targetKey: "pr-1", kind: "pr", repo: "acme/web", number: 1, status: "ready", createdAt: 1, headSha: "aaaaaaa1",
  submittedVerdict: "REQUEST_CHANGES", submittedAt: 1000, submittedHeadSha: "0000000", signals: { lastReviewAt: 1000, lastReviewSha: "0000000" },
};

test("a check on a stale diff says where draft comments can go, and where new problems go instead", () => {
  const text = verificationContext({ ...review, latestHeadSha: "bbbbbbb2" }, "the author pushed");
  expect(text).toContain("add_draft_comment only accepts lines in the diff at aaaaaaa");
  expect(text).toContain("file:line at bbbbbbb");
  expect(text).toContain("suggestedBody");
  expect(verificationContext({ ...review, latestHeadSha: "aaaaaaa1" }, "the author pushed")).not.toContain("only accepts lines");
});

test("with Run the re-review check off, the check doesn't start, though the default prompt is saved", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "guided-review", sdk: { threads: {
    get: async () => ({ archivedAt: null, deletedAt: null, status: "idle" }), send: async () => ({}),
  } } as any });
  const store = createStore(bb);
  store.saveReview(review);
  store.setLifecycle("pr-1", { submittedVerdict: "REQUEST_CHANGES", submittedAt: 1000, submittedHeadSha: "0000000", signals: review.signals });
  store.setAssistantThread("pr-1", "assistant");
  store.savePreferences({ ...defaultPreferences, knobs: { ...defaultPreferences.knobs, runReReviewCheck: false } }, 0);
  expect(await startVerification(bb, store, "pr-1", "the reviewer asked for a check")).toBe(false);
  expect(harness.inspection.sdk.callsTo("threads.send")).toEqual([]);
  expect(store.getReview("pr-1")?.verifyingSince).toBeFalsy();
});
