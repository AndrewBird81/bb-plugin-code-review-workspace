import { expect, test, vi } from "vitest";
import { registerCommentStepper, stepComment } from "./comment-stops";

test("] and [ step with what each review's comments list registered, and a withdrawn one doesn't take its successor along", () => {
  expect(stepComment("pr-42", 1, "src/a.ts")).toBe(false);
  const first = vi.fn(), second = vi.fn();
  const withdrawFirst = registerCommentStepper("pr-42", first);
  expect(stepComment("pr-42", 1, "src/a.ts")).toBe(true);
  expect(first).toHaveBeenCalledWith(1, "src/a.ts");
  expect(stepComment("pr-43", -1, undefined)).toBe(false);
  // The list mounted again: the old one's cleanup comes after the new one registered.
  const withdrawSecond = registerCommentStepper("pr-42", second);
  withdrawFirst();
  expect(stepComment("pr-42", -1, undefined)).toBe(true);
  expect(second).toHaveBeenCalledWith(-1, undefined);
  expect(first).toHaveBeenCalledTimes(1);
  withdrawSecond();
  expect(stepComment("pr-42", 1, "src/a.ts")).toBe(false);
});
