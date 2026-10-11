import { expect, test, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createStore, type ReviewMeta } from "./store";
import { runGit } from "./gh";
import { splitPatchByFile } from "./patch";
import { readFileContents, readGeneratedFiles } from "./file-contents";

const runGh = vi.hoisted(() => vi.fn());
vi.mock("./gh", async (original) => ({ ...await original<typeof import("./gh")>(), runGh }));
import plugin from "../server";

const ok = (stdout: string) => ({ stdout, stderr: "", code: 0 });
const pr: ReviewMeta = { targetKey: "pr-1", kind: "pr", repo: "acme/web", number: 1, base: "main", headSha: "head1", status: "ready", createdAt: 1 };
const patch = "diff --git a/src/a.ts b/src/a.ts\nindex 1..2 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -2,2 +2,2 @@ fn\n two\n-three\n+THREE\n";
const oldText = "one\ntwo\nthree\nfour\n";
const newText = "one\ntwo\nTHREE\nfour\n";
const fileOf = (text: string) => splitPatchByFile(text)[0]!;
const noGit = vi.fn(async () => ok(""));

/** GitHub, as gh api answers: the merge base, then each file at a commit. */
function github(files: Record<string, string>) {
  return vi.fn(async (args: string[]) => {
    const url = args.at(-1)!;
    if (args.some((arg) => arg.includes("/compare/"))) return ok("base1\n");
    const text = files[url.replace(/^repos\/acme\/web\/contents\//, "")];
    return text === undefined ? { stdout: "", stderr: "HTTP 404: Not Found", code: 1 } : ok(text);
  });
}

test("a PR's file is read at the merge base and at the reviewed head", async () => {
  const gh = github({ "src/a.ts?ref=base1": oldText, "src/a.ts?ref=head1": newText });
  expect(await readFileContents({ runGh: gh, runGit: noGit }, pr, fileOf(patch))).toEqual({ ok: true, old: oldText, new: newText });
  expect(gh.mock.calls[0][0]).toEqual(["api", "repos/acme/web/compare/main...head1", "--jq", ".merge_base_commit.sha"]);
  // Both are cached: a commit's file never changes.
  gh.mockClear();
  expect(await readFileContents({ runGh: gh, runGit: noGit }, pr, fileOf(patch))).toEqual({ ok: true, old: oldText, new: newText });
  expect(gh).not.toHaveBeenCalled();
});

test("a renamed file's old side is read at its old path, and an added file has no old side", async () => {
  const renamed = "diff --git a/src/old.ts b/src/new.ts\nsimilarity index 90%\nrename from src/old.ts\nrename to src/new.ts\n--- a/src/old.ts\n+++ b/src/new.ts\n@@ -1 +1 @@\n-x\n+y\n";
  const gh = github({ "src/old.ts?ref=base1": "x\n", "src/new.ts?ref=head2": "y\n" });
  expect(await readFileContents({ runGh: gh, runGit: noGit }, { ...pr, headSha: "head2" }, fileOf(renamed))).toEqual({ ok: true, old: "x\n", new: "y\n" });
  const added = "diff --git a/b.ts b/b.ts\nnew file mode 100644\n--- /dev/null\n+++ b/b.ts\n@@ -0,0 +1 @@\n+b\n";
  const ghAdded = github({ "b.ts?ref=head3": "b\n" });
  expect(await readFileContents({ runGh: ghAdded, runGit: noGit }, { ...pr, headSha: "head3" }, fileOf(added))).toEqual({ ok: true, old: null, new: "b\n" });
  expect(ghAdded.mock.calls.some(([args]) => args.some((arg: string) => arg.includes("/compare/")))).toBe(false);
});

test("contents that don't match the diff, binary files, and huge files stay as the diff, saying why", async () => {
  const moved = github({ "src/a.ts?ref=base1": oldText, "src/a.ts?ref=head4": "one\ntwo\nthree, again\nfour\n" });
  expect(await readFileContents({ runGh: moved, runGit: noGit }, { ...pr, headSha: "head4" }, fileOf(patch))).toEqual({ ok: false, error: "The file doesn’t match the diff, so only the diff shows." });
  const binary = "diff --git a/logo.png b/logo.png\nindex 1..2 100644\nBinary files a/logo.png and b/logo.png differ\n";
  expect(await readFileContents({ runGh: github({}), runGit: noGit }, pr, fileOf(binary))).toEqual({ ok: false, error: "A binary file shows as the diff only." });
  const huge = vi.fn(async (args: string[]) => args.some((arg) => arg.includes("/compare/")) ? ok("base1\n") : { stdout: "", stderr: "gh printed more than 2 MB, too much to read.", code: 1 });
  expect(await readFileContents({ runGh: huge, runGit: noGit }, { ...pr, headSha: "head5" }, fileOf(patch))).toEqual({ ok: false, error: "src/a.ts is too large to show in full." });
  expect(huge.mock.calls[1][1]).toMatchObject({ maxBuffer: 2 * 1024 * 1024 });
});

test("a local review's file is read with git on either side of its range, or from the working tree", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "gr-file-contents-"));
  try {
    const git = (...args: string[]) => runGit(args, { cwd });
    await git("init", "-q", "-b", "main");
    await git("config", "user.email", "t@example.com");
    await git("config", "user.name", "t");
    await writeFile(join(cwd, "a.ts"), "one\n");
    await git("add", ".");
    await git("commit", "-qm", "base");
    await git("checkout", "-qb", "feature");
    await writeFile(join(cwd, "a.ts"), "two\n");
    await git("commit", "-qam", "change");
    const local: ReviewMeta = { targetKey: "ref-1", kind: "ref", gitRef: "main...feature", cwd, status: "ready", createdAt: 1 };
    const diff = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-one\n+two\n";
    expect(await readFileContents({ runGh: vi.fn(), runGit }, local, fileOf(diff))).toEqual({ ok: true, old: "one\n", new: "two\n" });
    await writeFile(join(cwd, "a.ts"), "three\n");
    const worktree = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-two\n+three\n";
    expect(await readFileContents({ runGh: vi.fn(), runGit }, { ...local, gitRef: "HEAD" }, fileOf(worktree))).toEqual({ ok: true, old: "two\n", new: "three\n" });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("getFileContents reads a file of the review's diff", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "guided-review" });
  await plugin(bb);
  const store = createStore(bb);
  store.saveReview({ ...pr, headSha: "head6" });
  store.savePatch("pr-1", patch);
  runGh.mockImplementation(github({ "src/a.ts?ref=base1": oldText, "src/a.ts?ref=head6": newText }));
  expect(await harness.behavior.callRpc("getFileContents", { targetKey: "pr-1", file: "src/a.ts" })).toEqual({ ok: true, old: oldText, new: newText });
  expect(await harness.behavior.callRpc("getFileContents", { targetKey: "pr-1", file: "src/b.ts" })).toEqual({ ok: false, error: "src/b.ts isn’t in this review’s diff." });
});

test("a PR's .gitattributes at its head says which changed files are generated, once per commit", async () => {
  const gh = github({ ".gitattributes?ref=head7": "gen/** linguist-generated\n" });
  expect(await readGeneratedFiles({ runGh: gh, runGit: noGit }, { ...pr, headSha: "head7" }, ["gen/a.ts", "src/b.ts"])).toEqual(["gen/a.ts"]);
  expect(await readGeneratedFiles({ runGh: gh, runGit: noGit }, { ...pr, headSha: "head7" }, ["gen/a.ts", "src/b.ts"])).toEqual(["gen/a.ts"]);
  expect(gh).toHaveBeenCalledTimes(1);
  // No .gitattributes: nothing is declared generated, and that's kept too.
  const none = github({});
  expect(await readGeneratedFiles({ runGh: none, runGit: noGit }, { ...pr, headSha: "head8" }, ["gen/a.ts"])).toEqual([]);
  expect(await readGeneratedFiles({ runGh: none, runGit: noGit }, { ...pr, headSha: "head8" }, ["gen/a.ts"])).toEqual([]);
  expect(none).toHaveBeenCalledTimes(1);
});

test("a local review reads .gitattributes from the end of its range, or the working tree", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "gr-gitattributes-"));
  try {
    const git = (...args: string[]) => runGit(args, { cwd });
    await git("init", "-q", "-b", "main");
    await git("config", "user.email", "t@example.com");
    await git("config", "user.name", "t");
    await writeFile(join(cwd, ".gitattributes"), "*.gen.ts linguist-generated\n");
    await git("add", ".");
    await git("commit", "-qm", "base");
    const local: ReviewMeta = { targetKey: "ref-1", kind: "ref", gitRef: "main..main", cwd, status: "ready", createdAt: 1 };
    expect(await readGeneratedFiles({ runGh: vi.fn(), runGit }, local, ["a.gen.ts", "b.ts"])).toEqual(["a.gen.ts"]);
    await writeFile(join(cwd, ".gitattributes"), "b.ts linguist-vendored\n");
    expect(await readGeneratedFiles({ runGh: vi.fn(), runGit }, { ...local, gitRef: "HEAD" }, ["a.gen.ts", "b.ts"])).toEqual(["b.ts"]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("getGeneratedFiles lists the review's changed files its repo declares generated", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "guided-review" });
  await plugin(bb);
  const store = createStore(bb);
  store.saveReview({ ...pr, headSha: "head9" });
  store.savePatch("pr-1", patch);
  runGh.mockImplementation(github({ ".gitattributes?ref=head9": "src/a.ts linguist-generated\n" }));
  expect(await harness.behavior.callRpc("getGeneratedFiles", { targetKey: "pr-1" })).toEqual({ files: ["src/a.ts"] });
});
