import { test, expect, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { createStore } from "./store";
import { computeFileViewState, hashForFile } from "./file-views";
import { hashFileDiff, normalizedFileHash } from "./diff-hash";

vi.mock("./diff-hash", async (original) => {
  const actual = await original<typeof import("./diff-hash")>();
  return { ...actual, normalizedFileHash: vi.fn(actual.normalizedFileHash) };
});

const patch = "diff --git a/a.ts b/a.ts\n+one\n" + "diff --git a/b.ts b/b.ts\n+two\n";

test("a file marked viewed at its current hash reads as viewed, not stale", () => {
  const hash = hashForFile(patch, "a.ts")!;
  const state = computeFileViewState([{ file: "a.ts", hash, viewedAt: 1 }], patch);
  expect(state).toEqual([{ file: "a.ts", viewed: true, stale: false }]);
});

test("a file whose diff changed since viewing reads as stale, not viewed", () => {
  const state = computeFileViewState([{ file: "a.ts", hash: "old-hash", viewedAt: 1 }], patch);
  expect(state).toEqual([{ file: "a.ts", viewed: false, stale: true }]);
});

test("hashForFile returns null for a file not in the patch", () => {
  expect(hashForFile(patch, "missing.ts")).toBeNull();
});

test("hashForFile hashes only the file asked for", () => {
  vi.mocked(normalizedFileHash).mockClear();
  hashForFile(patch, "b.ts");
  expect(normalizedFileHash).toHaveBeenCalledTimes(1);
});

test("setFilesViewed marks a chapter's files in one call, hashing just those", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "guided-review" });
  await plugin(bb);
  const store = createStore(bb);
  store.saveReview({ targetKey: "pr-1", kind: "pr", number: 1, repo: "acme/web", status: "ready", createdAt: 1, headSha: "sha1", projectId: "p1" });
  store.savePatch("pr-1", patch + "diff --git a/c.ts b/c.ts\n+three\n");
  vi.mocked(normalizedFileHash).mockClear();
  expect(await harness.behavior.callRpc("setFilesViewed", { targetKey: "pr-1", files: ["a.ts", "b.ts"] })).toEqual({ ok: true });
  expect(normalizedFileHash).toHaveBeenCalledTimes(2);
  expect(await harness.behavior.callRpc("getFileViews", { targetKey: "pr-1" })).toEqual({ views: [
    { file: "a.ts", viewed: true, stale: false },
    { file: "b.ts", viewed: true, stale: false },
  ] });
  // A file gone from the patch can't be marked.
  expect(await harness.behavior.callRpc("setFilesViewed", { targetKey: "pr-1", files: ["c.ts", "gone.ts"] })).toEqual({ ok: false });
  expect(store.getFileViews("pr-1").map((view) => view.file).sort()).toEqual(["a.ts", "b.ts", "c.ts"]);
});

test("setFilesViewed with viewed false unmarks a chapter's files at once, for Undo", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "guided-review" });
  await plugin(bb);
  const store = createStore(bb);
  store.saveReview({ targetKey: "pr-1", kind: "pr", number: 1, repo: "acme/web", status: "ready", createdAt: 1, headSha: "sha1", projectId: "p1" });
  store.savePatch("pr-1", patch + "diff --git a/c.ts b/c.ts\n+three\n");
  expect(await harness.behavior.callRpc("setFilesViewed", { targetKey: "pr-1", files: ["a.ts", "b.ts", "c.ts"], viewed: true })).toEqual({ ok: true });
  expect(await harness.behavior.callRpc("setFilesViewed", { targetKey: "pr-1", files: ["a.ts", "b.ts", "gone.ts"], viewed: false })).toEqual({ ok: true });
  expect(await harness.behavior.callRpc("getFileViews", { targetKey: "pr-1" })).toEqual({ views: [{ file: "c.ts", viewed: true, stale: false }] });
});

const appDiff = (index: string, at: string, context: string, added = "+  run(a, b);") =>
  [
    "diff --git a/src/app.ts b/src/app.ts",
    `index ${index} 100644`,
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    at,
    context,
    "-  run(a);",
    added,
    " }",
    "",
  ].join("\n");
const reviewed = appDiff("1111111..2222222", "@@ -10,3 +10,3 @@", "   const a = 1;");

test("a rebase (new @@ numbers, index, context) keeps a file viewed", () => {
  const hash = hashForFile(reviewed, "src/app.ts")!;
  const rebased = appDiff("3333333..4444444", "@@ -20,3 +20,3 @@ start()", "   const a = 10;");
  expect(computeFileViewState([{ file: "src/app.ts", hash, viewedAt: 1 }], rebased)).toEqual([
    { file: "src/app.ts", viewed: true, stale: false },
  ]);
});

test("changing an added line makes a viewed file stale", () => {
  const hash = hashForFile(reviewed, "src/app.ts")!;
  const edited = appDiff("1111111..2222222", "@@ -10,3 +10,3 @@", "   const a = 1;", "+  run(a, c);");
  expect(computeFileViewState([{ file: "src/app.ts", hash, viewedAt: 1 }], edited)).toEqual([
    { file: "src/app.ts", viewed: false, stale: true },
  ]);
});

test("a mark saved with the legacy whole-diff hash still counts as viewed", () => {
  const legacy = hashFileDiff(reviewed);
  expect(computeFileViewState([{ file: "src/app.ts", hash: legacy, viewedAt: 1 }], reviewed)).toEqual([
    { file: "src/app.ts", viewed: true, stale: false },
  ]);
});

test("a binary stays viewed across a rebase but goes stale when replaced", () => {
  const bin = (index: string) => `diff --git a/x.png b/x.png\nindex ${index} 100644\nBinary files a/x.png and b/x.png differ\n`;
  const hash = hashForFile(bin("aaaaaaa..bbbbbbb"), "x.png")!;
  const view = [{ file: "x.png", hash, viewedAt: 1 }];
  expect(computeFileViewState(view, bin("ccccccc..bbbbbbb"))[0]).toMatchObject({ viewed: true, stale: false });
  expect(computeFileViewState(view, bin("aaaaaaa..ddddddd"))[0]).toMatchObject({ viewed: false, stale: true });
});
