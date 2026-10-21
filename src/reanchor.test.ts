import { test, expect, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { lineText, reanchor } from "./reanchor";
import { createStore, reanchorDraft } from "./store";
import { queueStore, type AsyncStore } from "./store-queue";

// Count whole-diff parses.
const parses = vi.hoisted(() => ({ count: 0 }));
vi.mock("./review-positions", async (original) => {
  const actual = await original<typeof import("./review-positions")>();
  return { ...actual, diffPositions: (patch: string) => { parses.count++; return actual.diffPositions(patch); } };
});

const diff = (...lines: string[]) => lines.join("\n") + "\n";
const headers = ["diff --git a/src/app.ts b/src/app.ts", "index 1111111..2222222 100644", "--- a/src/app.ts", "+++ b/src/app.ts"];

const previous = diff(
  ...headers,
  "@@ -10,5 +10,6 @@ export function start() {",
  "   const a = 1;", // new 10 / old 10
  "   const b = 2;", // new 11 / old 11
  "-  run(a);", // old 12
  "+  run(a, b);", // new 12
  '+  log("started");', // new 13
  "   return a;", // new 14 / old 13
  " }",
);

// A fix-up inserted two lines above, so everything after moved down by 2.
const shifted = diff(
  ...headers,
  "@@ -10,5 +10,8 @@ export function start() {",
  "   const a = 1;",
  "   const b = 2;",
  "+  check(a);",
  "+  check(b);",
  "-  run(a);", // old 12
  "+  run(a, b);", // new 14
  '+  log("started");', // new 15
  "   return a;",
  " }",
);

test("lineText reads RIGHT by new-file number and LEFT by old-file number", () => {
  expect(lineText(previous, "src/app.ts", 12, "RIGHT")).toBe("  run(a, b);");
  expect(lineText(previous, "src/app.ts", 12, "LEFT")).toBe("  run(a);");
  expect(lineText(previous, "src/app.ts", 14, "RIGHT")).toBe("  return a;");
  expect(lineText(previous, "src/app.ts", 99, "RIGHT")).toBeUndefined();
  expect(lineText(previous, "other.ts", 1, "RIGHT")).toBeUndefined();
});

test("a line still at its number (whitespace aside) is the same", () => {
  const reindented = previous.replace("+  run(a, b);", "+    run(a,  b);");
  expect(reanchor({ file: "src/app.ts", line: 12, side: "RIGHT" }, previous, reindented)).toEqual({ status: "same" });
  expect(reanchor({ file: "src/app.ts", line: 12, side: "LEFT" }, previous, shifted)).toEqual({ status: "same" });
});

test("a line that moved follows its code", () => {
  expect(reanchor({ file: "src/app.ts", line: 13, side: "RIGHT" }, previous, shifted)).toEqual({ status: "moved", line: 15 });
});

test("stored code wins over the previous diff", () => {
  const comment = { file: "src/app.ts", line: 12, side: "RIGHT" as const, code: '  log("started");' };
  expect(reanchor(comment, "", shifted)).toEqual({ status: "moved", line: 15 });
});

test("the nearest matching line wins; a tie is lost", () => {
  const twice = diff(...headers, "@@ -0,0 +1,5 @@", "+x();", "+a();", "+y();", "+a();", "+x();");
  expect(reanchor({ file: "src/app.ts", line: 3, side: "RIGHT", code: "x();" }, "", twice)).toEqual({ status: "lost" });
  expect(reanchor({ file: "src/app.ts", line: 4, side: "RIGHT", code: "x();" }, "", twice)).toEqual({ status: "moved", line: 5 });
});

test("lost when the code is gone, unknown, or the file left the diff", () => {
  const rewritten = previous.replace('+  log("started");', '+  log("ready");');
  expect(reanchor({ file: "src/app.ts", line: 13, side: "RIGHT" }, previous, rewritten)).toEqual({ status: "lost" });
  expect(reanchor({ file: "src/app.ts", line: 99, side: "RIGHT" }, previous, previous)).toEqual({ status: "lost" });
  expect(reanchor({ file: "src/app.ts", line: 12, side: "RIGHT" }, previous, "")).toEqual({ status: "lost" });
});

const shiftedFile = (i: number, shift: number) => [
  `diff --git a/f${i}.ts b/f${i}.ts`, `--- a/f${i}.ts`, `+++ b/f${i}.ts`, `@@ -1,0 +1,${200 + shift} @@`,
  ...Array.from({ length: shift }, (_, n) => `+inserted ${n}`),
  ...Array.from({ length: 200 }, (_, n) => `+line ${i}.${n}`),
].join("\n");
const shiftedPatch = (shift: number) => Array.from({ length: 300 }, (_, i) => shiftedFile(i, shift)).join("\n") + "\n";

test("re-anchoring 100 stored comments on a 60k-line diff parses each diff once", async () => {
  const { bb } = createFakePluginHost({ pluginId: "code-review-workspace" });
  const store = queueStore(createStore(bb));
  await store.saveReview({ targetKey: "pr-1", kind: "pr", number: 1, status: "ready", createdAt: 1 });
  const before = shiftedPatch(0);
  await store.savePatch("pr-1", before);
  for (let i = 0; i < 100; i++) await store.upsertDraftComment("pr-1", { file: `f${i}.ts`, line: 10, side: "RIGHT", body: "x" });
  // One range too, whose start is placed as well.
  await store.upsertDraftComment("pr-1", { file: "f200.ts", line: 20, startLine: 18, side: "RIGHT", body: "x" });
  const after = shiftedPatch(2);
  await store.savePatch("pr-1", after);
  parses.count = 0;
  const placements = await reanchorDraft(store, "pr-1", before, after);
  expect(placements.filter((p) => p.line === 12)).toHaveLength(100);
  expect(placements.find((p) => p.at.file === "f200.ts")).toMatchObject({ line: 22, startLine: 20 });
  expect(parses.count).toBeLessThanOrEqual(2);
});

test("re-anchoring 50 comments with no stored code on a 2,000-file diff parses each diff once", async () => {
  const out: string[] = [];
  for (let f = 0; f < 2000; f++) {
    out.push(`diff --git a/src/f${f}.ts b/src/f${f}.ts`, `--- a/src/f${f}.ts`, `+++ b/src/f${f}.ts`, "@@ -1,100 +1,100 @@");
    for (let i = 0; i < 100; i++) out.push(i % 4 === 0 ? `-old ${f} ${i}` : i % 4 === 1 ? `+new ${f} ${i}` : ` same ${f} ${i}`);
  }
  const patch = out.join("\n") + "\n";
  const comments = Array.from({ length: 50 }, (_, i) => ({ file: `src/f${i * 7}.ts`, line: 3, side: "RIGHT" as const, body: "x" }));
  const store = { getDraft: async () => ({ comments }), draftCommentCode: async () => undefined } as unknown as Pick<AsyncStore, "getDraft" | "draftCommentCode">;
  parses.count = 0;
  expect(await reanchorDraft(store, "k", patch, patch)).toHaveLength(50);
  expect(parses.count).toBeLessThanOrEqual(2);
});

// bug bash DFT-2: a line whose code, with indentation dropped, matched another's at the same number counted as the
// same, so a comment on a function's `}` landed on an inner block's `}` after a commit added a line above it.
const added = (lines: string[]) => `diff --git a/a.ts b/a.ts\nnew file mode 100644\n--- /dev/null\n+++ b/a.ts\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}\n`;
const fn = added(["function a() {", "  if (x) {", "    y();", "  }", "}"]);
const fnGrown = added(["function a() {", "  if (x) {", "    y();", "    z();", "  }", "}"]);

async function rebuilt(comment: { line: number; startLine?: number; body: string }) {
  const { bb } = createFakePluginHost({ pluginId: "code-review-workspace" });
  const store = queueStore(createStore(bb));
  await store.saveReview({ targetKey: "pr-test", kind: "pr", repo: "acme/web", number: 7, status: "ready", createdAt: 1, headSha: "sha1" });
  await store.savePatch("pr-test", fn);
  await store.upsertDraftComment("pr-test", { file: "a.ts", side: "RIGHT", ...comment });
  // As rebuildReview does for a new commit.
  await store.savePatch("pr-test", fnGrown);
  await store.rebaseDraftComments("pr-test", await reanchorDraft(store, "pr-test", fn, fnGrown));
  return { moved: (await store.getDraft("pr-test")).comments[0], stale: (await store.staleDraftComments("pr-test")).length > 0 };
}

test("a comment on a function's closing brace follows it, not an inner block's brace, after a rebuild", async () => {
  expect(await rebuilt({ line: 5, body: "a() never returns a value." })).toMatchObject({ moved: { line: 6 }, stale: false });
});

test("a suggestion over a whole function keeps covering the function after a rebuild", async () => {
  expect(await rebuilt({ startLine: 1, line: 5, body: "```suggestion\nconst a = () => x && y();\n```" })).toMatchObject({ moved: { startLine: 1, line: 6 }, stale: false });
});

test("code found more than once is the same line only where the lines around it are too", () => {
  const blocks = added(["if (a) {", "  x();", "}", "if (b) {", "  y();", "}"]);
  // y() became z(), so the `}` on line 6 has a new neighbour, and the file has another `}`.
  const changed = blocks.replace("+  y();", "+  z();");
  expect(reanchor({ file: "a.ts", line: 6, side: "RIGHT" }, blocks, blocks)).toEqual({ status: "same" });
  expect(reanchor({ file: "a.ts", line: 6, side: "RIGHT" }, blocks, changed)).toEqual({ status: "lost" });
  expect(reanchor({ file: "a.ts", line: 2, side: "RIGHT" }, blocks, changed)).toEqual({ status: "same" });
});
