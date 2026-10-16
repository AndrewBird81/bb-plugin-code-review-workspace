import { expect, test } from "vitest";
import { changedLines, chapterReadingLines, LINES_PER_HOUR, readingLines, readingTime } from "../lib/review-size";

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
  // Nor do files the repo's .gitattributes marks generated.
  expect(readingLines(["src/a.ts", "package-lock.json"], lines, new Set(["src/a.ts"]))).toBe(0);
});

test("each chapter reads its files' changed lines, a split file only its hunks there, and no lockfiles", () => {
  const split = ["diff --git a/src/b.ts b/src/b.ts", "--- a/src/b.ts", "+++ b/src/b.ts", "@@ -1 +1 @@", "-a", "+aa", "@@ -20,2 +20,2 @@", "-b", "-c", "+bb", "+cc", ""].join("\n");
  const sections = [
    { id: "c1", diffs: [{ file: "src/a.ts" }, { file: "src/b.ts", hunks: [1] }] },
    { id: "c2", diffs: [{ file: "src/b.ts", hunks: [2] }, { file: "package-lock.json" }] },
  ];
  const all = patch + split;
  expect(chapterReadingLines(sections, all, changedLines(all))).toEqual(new Map([["c1", 3 + 2], ["c2", 4]]));
});

test("reading time is a rough estimate at LINES_PER_HOUR, said as one, and in days past a day", () => {
  expect(LINES_PER_HOUR).toBe(400);
  expect(readingTime(10)).toBe("a few minutes to read");
  expect(readingTime(100)).toBe("about 15 min to read");
  expect(readingTime(400)).toBe("about 1 h to read");
  expect(readingTime(1000)).toBe("about 2.5 h to read");
  expect(readingTime(LINES_PER_HOUR * 23.5)).toBe("about 23.5 h to read");
  expect(readingTime(LINES_PER_HOUR * 24)).toBe("about 1 day to read");
  // Not "about 60.5 h".
  expect(readingTime(LINES_PER_HOUR * 60.4)).toBe("about 2.5 days to read");
});
