import { expect, test } from "vitest";
import { changedLines, LINES_PER_HOUR, readingLines, readingTime } from "../lib/review-size";

const patch = [
  "diff --git a/src/a.ts b/src/a.ts", "--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1,3 +1,3 @@", " keep", "-old", "+new", "+more", "",
  "diff --git a/src/old.ts b/src/renamed.ts", "similarity index 90%", "rename from src/old.ts", "rename to src/renamed.ts", "--- a/src/old.ts", "+++ b/src/renamed.ts", "@@ -1 +1 @@", "--- a/x", "+++ b/x", "",
  "diff --git a/package-lock.json b/package-lock.json", "--- a/package-lock.json", "+++ b/package-lock.json", "@@ -1 +1,2 @@", "-a", "+b", "+c", "",
].join("\n");

test("changed lines count each file's additions and deletions, by its path after the change", () => {
  expect(changedLines(patch)).toEqual(new Map([["src/a.ts", 3], ["src/renamed.ts", 2], ["package-lock.json", 3]]));
});

test("lockfiles and generated files don't count toward reading", () => {
  const lines = new Map([["src/a.ts", 3], ["package-lock.json", 3000], ["dist/app.min.js", 900]]);
  expect(readingLines(["src/a.ts", "package-lock.json", "dist/app.min.js"], lines)).toBe(3);
});

test("reading time is a rough estimate at LINES_PER_HOUR", () => {
  expect(LINES_PER_HOUR).toBe(400);
  expect(readingTime(10)).toBe("a few minutes");
  expect(readingTime(100)).toBe("about 15 min");
  expect(readingTime(400)).toBe("about 1 h");
  expect(readingTime(1000)).toBe("about 2.5 h");
});
