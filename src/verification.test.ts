import { expect, test } from "vitest";
import { verificationContext } from "./verification";
import type { ReviewMeta } from "./store";

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
