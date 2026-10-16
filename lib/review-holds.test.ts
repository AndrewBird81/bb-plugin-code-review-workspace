import { expect, test, vi } from "vitest";
import { holdReview } from "./review-holds";

test("a review's state is forgotten when the last workspace showing it goes, not before", () => {
  const forget = vi.fn();
  const old = holdReview("draft", "pr-7", forget);
  const fresh = holdReview("draft", "pr-7", forget);
  old();
  expect(forget).not.toHaveBeenCalled();
  fresh();
  expect(forget).toHaveBeenCalledTimes(1);
});

test("each part and review counts its own holders", () => {
  const forget = vi.fn();
  const comments = holdReview("comments", "pr-7", forget);
  holdReview("draft", "pr-7", vi.fn());
  holdReview("comments", "pr-8", vi.fn());
  comments();
  expect(forget).toHaveBeenCalledTimes(1);
});
