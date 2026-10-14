import { expect, test } from "vitest";
import type { FileViewFlags } from "../components/DiffViewer";
import { approveDoubts, approveGuard } from "./approve-guard";
import { changedLines } from "./review-size";
import type { Chapter } from "./workspace-context";

const MINUTE = 60_000;
/** A file's diff adding `n` lines. */
const added = (file: string, n: number) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -0,0 +1,${n} @@\n${Array.from({ length: n }, (_, i) => `+line ${i}`).join("\n")}\n`;
const patch = [added("src/auth.ts", 300), added("src/session.ts", 200), added("src/ui.ts", 400), added("package-lock.json", 900), added("README.md", 10)].join("");
const lines = changedLines(patch);
const chapter = (id: string, risk: Chapter["risk"], ...files: string[]): Chapter => ({ id, title: id, overview: "", risk, diffs: files.map((file) => ({ file })) });
const sections = [chapter("auth", "high", "src/auth.ts", "src/session.ts", "package-lock.json"), chapter("ui", "medium", "src/ui.ts"), chapter("docs", "low", "README.md")];
const viewed = (marks: Record<string, number>) => new Map<string, FileViewFlags>(Object.entries(marks).map(([file, viewedAt]) => [file, { viewed: true, stale: false, viewedAt }]));
const guard = (marks: Record<string, number>, views = viewed(marks)) => approveGuard(sections, views, patch, lines);

test("files in high-risk chapters not viewed are doubts, but not lockfiles, nor low- or medium-risk chapters", () => {
  expect(guard({}).unviewed).toEqual(["src/auth.ts", "src/session.ts"]);
  expect(guard({ "src/auth.ts": 0 }).unviewed).toEqual(["src/session.ts"]);
  // Viewed before its diff changed counts as not viewed.
  expect(guard({}, new Map([["src/auth.ts", { viewed: false, stale: true, viewedAt: 0 }], ["src/session.ts", { viewed: true, stale: false, viewedAt: 0 }]])).unviewed).toEqual(["src/auth.ts"]);
  expect(approveDoubts(guard({ "src/auth.ts": 0 }))).toEqual(["1 file in a high-risk chapter not viewed."]);
  expect(approveDoubts(guard({}))).toEqual(["2 files in high-risk chapters not viewed."]);
});

test("a chapter is read from the mark before it to its last mark, and over 500 lines an hour is a doubt", () => {
  // The docs, then auth's 500 lines in 30 minutes (1,000 an hour), then ui's 400 lines in 60 minutes.
  const marks = { "README.md": 0, "src/auth.ts": 20 * MINUTE, "src/session.ts": 30 * MINUTE, "src/ui.ts": 90 * MINUTE };
  expect(guard(marks).rushed).toEqual([{ id: "auth", number: 1, risk: "high", lines: 500, minutes: 30 }]);
  expect(approveDoubts(guard(marks))).toEqual(["Chapter 1 (high risk): 500 lines marked viewed in 30 min."]);
  // Mark chapter viewed, at once, after an hour in it.
  expect(guard({ "README.md": 0, "src/auth.ts": 60 * MINUTE, "src/session.ts": 60 * MINUTE }).rushed).toEqual([]);
  // ...or as soon as the docs were done.
  expect(approveDoubts(guard({ "README.md": 0, "src/auth.ts": 10_000, "src/session.ts": 10_000 }))).toEqual(["Chapter 1 (high risk): 500 lines marked viewed in under a minute."]);
});

test("the review's first marks have no reading time to measure, so they don't count against it", () => {
  // auth.ts was read for as long as it took before anything else was marked; session.ts's 200 lines took 10 minutes.
  expect(guard({ "src/auth.ts": 0, "src/session.ts": 10 * MINUTE }).rushed).toEqual([{ id: "auth", number: 1, risk: "high", lines: 200, minutes: 10 }]);
  expect(guard({ "src/auth.ts": 0, "src/session.ts": 30 * MINUTE }).rushed).toEqual([]);
  expect(guard({ "src/auth.ts": 0, "src/session.ts": 0 }).rushed).toEqual([]);
  // Low-risk chapters and lockfiles are never judged on pace.
  expect(guard({ "src/auth.ts": 0, "package-lock.json": 1, "README.md": 2 }).rushed).toEqual([]);
});

test("a chapter with under 50 lines to read isn't judged on pace", () => {
  const small = [chapter("tiny", "high", "README.md")];
  expect(approveGuard(small, viewed({ "src/ui.ts": 0, "README.md": 1000 }), patch, lines).rushed).toEqual([]);
});
