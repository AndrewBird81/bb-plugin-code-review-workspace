import { expect, test } from "vitest";
import { isMissingThread } from "./thread-errors";

test("a thread BB no longer has is missing, by its 404 status or its message", () => {
  expect(isMissingThread(Object.assign(new Error("Not found"), { status: 404 }))).toBe(true);
  expect(isMissingThread(new Error("HTTP 404: Thread not found"))).toBe(true);
  expect(isMissingThread("HTTP 404: Thread not found")).toBe(true);
});

test("a permission or connection failure isn't a missing thread", () => {
  expect(isMissingThread(Object.assign(new Error("Forbidden"), { status: 403 }))).toBe(false);
  expect(isMissingThread(new Error("HTTP 404: Project not found"))).toBe(false);
  expect(isMissingThread(new TypeError("fetch failed"))).toBe(false);
  expect(isMissingThread(null)).toBe(false);
  expect(isMissingThread(undefined)).toBe(false);
});
