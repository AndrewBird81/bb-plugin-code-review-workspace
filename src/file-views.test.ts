import { test, expect, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import type { FileView } from "./store";
import { computeFileViewState, fileHashCache, hashForFile } from "./file-views";
import { hashFileDiff, normalizedFileHash } from "./diff-hash";
import { rpcContract } from "./rpc-contract";
import { testStore } from "./test-store.test-support";

vi.mock("./diff-hash", async (original) => {
  const actual = await original<typeof import("./diff-hash")>();
  return { ...actual, normalizedFileHash: vi.fn(actual.normalizedFileHash), hashFileDiff: vi.fn(actual.hashFileDiff) };
});

/** computeFileViewState against a patch's hashes. */
const viewStateOf = (stored: FileView[], patch: string) => computeFileViewState(stored, fileHashCache(() => patch));

const patch = "diff --git a/a.ts b/a.ts\n+one\n" + "diff --git a/b.ts b/b.ts\n+two\n";

test("a file marked viewed at its current hash reads as viewed, not stale", () => {
  const hash = hashForFile(patch, "a.ts")!;
  const state = viewStateOf([{ file: "a.ts", hash, viewedAt: 1 }], patch);
  expect(state).toEqual([{ file: "a.ts", viewed: true, stale: false, viewedAt: 1 }]);
});

test("a file whose diff changed since viewing reads as stale, not viewed", () => {
  const state = viewStateOf([{ file: "a.ts", hash: "old-hash", viewedAt: 1 }], patch);
  expect(state).toEqual([{ file: "a.ts", viewed: false, stale: true, viewedAt: 1 }]);
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
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace" });
  await plugin(bb);
  const store = testStore(bb);
  await store.saveReview({ targetKey: "pr-1", kind: "pr", number: 1, repo: "acme/web", status: "ready", createdAt: 1, headSha: "sha1", projectId: "p1" });
  await store.savePatch("pr-1", patch + "diff --git a/c.ts b/c.ts\n+three\n");
  vi.mocked(normalizedFileHash).mockClear();
  expect(await harness.behavior.callRpc("setFilesViewed", { targetKey: "pr-1", files: ["a.ts", "b.ts"] })).toEqual({ ok: true, previous: [] });
  expect(normalizedFileHash).toHaveBeenCalledTimes(2);
  expect(await harness.behavior.callRpc("getFileViews", { targetKey: "pr-1" })).toEqual({ views: [
    { file: "a.ts", viewed: true, stale: false, viewedAt: expect.any(Number) },
    { file: "b.ts", viewed: true, stale: false, viewedAt: expect.any(Number) },
  ] });
  // A file gone from the patch can't be marked.
  expect(await harness.behavior.callRpc("setFilesViewed", { targetKey: "pr-1", files: ["c.ts", "gone.ts"] })).toEqual({ ok: false, previous: [] });
  expect((await store.getFileViews("pr-1")).map((view) => view.file).sort()).toEqual(["a.ts", "b.ts", "c.ts"]);
});

test("setFilesViewed with viewed false unmarks a chapter's files at once, for Undo", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace" });
  await plugin(bb);
  const store = testStore(bb);
  await store.saveReview({ targetKey: "pr-1", kind: "pr", number: 1, repo: "acme/web", status: "ready", createdAt: 1, headSha: "sha1", projectId: "p1" });
  await store.savePatch("pr-1", patch + "diff --git a/c.ts b/c.ts\n+three\n");
  expect(await harness.behavior.callRpc("setFilesViewed", { targetKey: "pr-1", files: ["a.ts", "b.ts", "c.ts"], viewed: true })).toEqual({ ok: true, previous: [] });
  expect(await harness.behavior.callRpc("setFilesViewed", { targetKey: "pr-1", files: ["a.ts", "b.ts", "gone.ts"], viewed: false })).toEqual({ ok: true });
  expect(await harness.behavior.callRpc("getFileViews", { targetKey: "pr-1" })).toEqual({ views: [{ file: "c.ts", viewed: true, stale: false, viewedAt: expect.any(Number) }] });
});

test("setFilesViewed returns the views it replaced, and Undo with them puts a file viewed at an older version back as changed since", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace" });
  await plugin(bb);
  const store = testStore(bb);
  await store.saveReview({ targetKey: "pr-1", kind: "pr", number: 1, repo: "acme/web", status: "ready", createdAt: 1, headSha: "sha1", projectId: "p1" });
  await store.savePatch("pr-1", patch);
  // a.ts was viewed before its diff last changed.
  await store.setFileViewed("pr-1", "a.ts", "old-hash", 1);
  const before = { file: "a.ts", hash: "old-hash", viewedAt: 1 };
  const marked = await harness.behavior.callRpc("setFilesViewed", { targetKey: "pr-1", files: ["a.ts", "b.ts"] }) as { ok: boolean; previous: unknown[] };
  expect(marked).toEqual({ ok: true, previous: [before] });
  expect(await harness.behavior.callRpc("getFileViews", { targetKey: "pr-1" })).toEqual({ views: [
    { file: "a.ts", viewed: true, stale: false, viewedAt: expect.any(Number) },
    { file: "b.ts", viewed: true, stale: false, viewedAt: expect.any(Number) },
  ] });
  expect(await harness.behavior.callRpc("setFilesViewed", { targetKey: "pr-1", files: ["a.ts", "b.ts"], viewed: false, previous: rpcContract.setFilesViewed.output.parse(marked).previous })).toEqual({ ok: true });
  expect(await store.getFileViews("pr-1")).toEqual([before]);
  expect(await harness.behavior.callRpc("getFileViews", { targetKey: "pr-1" })).toEqual({ views: [{ file: "a.ts", viewed: false, stale: true, viewedAt: 1 }] });
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
  expect(viewStateOf([{ file: "src/app.ts", hash, viewedAt: 1 }], rebased)).toEqual([
    { file: "src/app.ts", viewed: true, stale: false, viewedAt: 1 },
  ]);
});

test("changing an added line makes a viewed file stale", () => {
  const hash = hashForFile(reviewed, "src/app.ts")!;
  const edited = appDiff("1111111..2222222", "@@ -10,3 +10,3 @@", "   const a = 1;", "+  run(a, c);");
  expect(viewStateOf([{ file: "src/app.ts", hash, viewedAt: 1 }], edited)).toEqual([
    { file: "src/app.ts", viewed: false, stale: true, viewedAt: 1 },
  ]);
});

test("a mark saved with the legacy whole-diff hash still counts as viewed", () => {
  const legacy = hashFileDiff(reviewed);
  expect(viewStateOf([{ file: "src/app.ts", hash: legacy, viewedAt: 1 }], reviewed)).toEqual([
    { file: "src/app.ts", viewed: true, stale: false, viewedAt: 1 },
  ]);
});

test("a binary stays viewed across a rebase but goes stale when replaced", () => {
  const bin = (index: string) => `diff --git a/x.png b/x.png\nindex ${index} 100644\nBinary files a/x.png and b/x.png differ\n`;
  const hash = hashForFile(bin("aaaaaaa..bbbbbbb"), "x.png")!;
  const view = [{ file: "x.png", hash, viewedAt: 1 }];
  expect(viewStateOf(view, bin("ccccccc..bbbbbbb"))[0]).toMatchObject({ viewed: true, stale: false });
  expect(viewStateOf(view, bin("aaaaaaa..ddddddd"))[0]).toMatchObject({ viewed: false, stale: true });
});

const manyFiles = (files: number, changed = -1) => Array.from({ length: files }, (_, f) =>
  [`diff --git a/src/f${f}.ts b/src/f${f}.ts`, `--- a/src/f${f}.ts`, `+++ b/src/f${f}.ts`, "@@ -1,2 +1,2 @@", `-old${f}`, f === changed ? "+changed" : `+new${f}`, " same", ""].join("\n")).join("");

test("reading Viewed marks on a 2,000-file review hashes only the marked files, once per patch", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace" });
  await plugin(bb);
  const store = testStore(bb);
  await store.saveReview({ targetKey: "pr-1", kind: "pr", number: 1, repo: "acme/web", status: "ready", createdAt: 1 });
  await store.savePatch("pr-1", manyFiles(2000));
  const call = (name: "setFileViewed" | "getFileViews", input: object) => harness.behavior.callRpc(name, input as never);
  for (let i = 0; i < 6; i++) expect(await call("setFileViewed", { targetKey: "pr-1", file: `src/f${i}.ts`, viewed: true })).toEqual({ ok: true });
  // A mark from an older diff, checked against the legacy hash too.
  await store.setFileViewed("pr-1", "src/f9.ts", "old-hash", 1);
  vi.mocked(normalizedFileHash).mockClear();
  vi.mocked(hashFileDiff).mockClear();
  for (let i = 0; i < 3; i++) {
    const { views } = await call("getFileViews", { targetKey: "pr-1" }) as { views: Array<{ file: string; viewed: boolean; stale: boolean }> };
    expect(views.filter((view) => view.viewed)).toHaveLength(6);
    expect(views.find((view) => view.file === "src/f9.ts")).toMatchObject({ viewed: false, stale: true });
  }
  expect(vi.mocked(normalizedFileHash).mock.calls.length + vi.mocked(hashFileDiff).mock.calls.length).toBeLessThanOrEqual(7);
  // A new diff hashes again: f0 changed since it was viewed.
  await store.savePatch("pr-1", manyFiles(2000, 0));
  const { views } = await call("getFileViews", { targetKey: "pr-1" }) as { views: Array<{ file: string; viewed: boolean; stale: boolean }> };
  expect(views.find((view) => view.file === "src/f0.ts")).toMatchObject({ viewed: false, stale: true });
  expect(views.find((view) => view.file === "src/f1.ts")).toMatchObject({ viewed: true, stale: false });
});
