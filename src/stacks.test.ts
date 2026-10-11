import { expect, test } from "vitest";
import { findStacks, type StackInput } from "../lib/stacks";

const pr = (number: number, base: string, head: string, extra: Partial<StackInput> = {}): StackInput =>
  ({ targetKey: `pr-${number}`, kind: "pr", repo: "acme/live-api", number, base, head, title: `PR ${number}`, url: `https://github.com/acme/live-api/pull/${number}`, status: "ready", ...extra });
const numbers = (place: ReturnType<typeof findStacks> extends Map<string, infer P> ? P | undefined : never) => place?.members.map((m) => m.number);

test("a review whose base is another open review's head stacks on it, bottom first", () => {
  const stacks = findStacks([
    pr(2654, "feat-b", "feat-c"), pr(2645, "main", "feat-a", { submittedVerdict: "APPROVE" }), pr(2648, "feat-a", "feat-b"), pr(12, "main", "other"),
  ]);
  expect(numbers(stacks.get("pr-2648"))).toEqual([2645, 2648, 2654]);
  expect(stacks.get("pr-2648")).toMatchObject({ index: 1, parent: { number: 2645, targetKey: "pr-2645", reviewed: true }, children: [{ number: 2654, targetKey: "pr-2654" }] });
  expect(stacks.get("pr-2645")).toMatchObject({ index: 0, parent: null });
  expect(stacks.get("pr-2654")).toMatchObject({ index: 2, children: [] });
  expect(stacks.has("pr-12")).toBe(false);
});

test("only open PRs in the same repository stack", () => {
  const stacks = findStacks([
    pr(1, "main", "feat-a", { prState: "MERGED" }), pr(2, "feat-a", "feat-b"),
    pr(3, "main", "feat-x", { repo: "acme/web" }), pr(4, "feat-x", "feat-y"),
  ]);
  expect(stacks.size).toBe(0);
});

test("GitHub's word on a PR's parent wins, and a parent not in your list still counts", () => {
  const stacks = findStacks([
    // GitHub found an open PR for the base branch that you don't have.
    pr(2651, "feat-a", "feat-b", { stackParent: { number: 2647, title: "Add the queue", url: "https://github.com/acme/live-api/pull/2647" } }),
    // GitHub says no open PR heads this base, whatever the saved branches say.
    pr(20, "main", "deploy"), pr(21, "deploy", "fix", { stackParent: null }),
  ]);
  expect(stacks.get("pr-2651")).toMatchObject({ index: 1, parent: { number: 2647, targetKey: null, title: "Add the queue", reviewed: false } });
  expect(numbers(stacks.get("pr-2651"))).toEqual([2647, 2651]);
  expect(stacks.has("pr-21")).toBe(false);
});

test("a parent you wrote, or a branching stack, still reads in order", () => {
  const stacks = findStacks([pr(1, "main", "a", { ownPr: true }), pr(3, "a", "c"), pr(2, "a", "b")]);
  expect(numbers(stacks.get("pr-3"))).toEqual([1, 2, 3]);
  expect(stacks.get("pr-1")?.children.map((c) => c.number)).toEqual([2, 3]);
  expect(stacks.get("pr-2")?.parent).toMatchObject({ reviewed: true });
});
