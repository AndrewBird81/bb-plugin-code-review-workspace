import { expect, test, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { createStore, type ReviewMeta } from "./store";
import { runGit } from "./gh";
import { readFileAt } from "./verification";
import { localRevs } from "./file-contents";

vi.mock("./gh", async (original) => ({ ...await original<typeof import("./gh")>(), runGh: vi.fn() }));

const ok = (stdout: string) => ({ stdout, stderr: "", code: 0 });
const pr: ReviewMeta = { targetKey: "pr-1", kind: "pr", repo: "acme/web", number: 1, base: "main", headSha: "sha2", status: "ready", createdAt: 1 };
const noGit = vi.fn(async () => ok(""));
/** What read_file returns, or its error. */
const read = async (gh: any, review: ReviewMeta, ...args: [string, "current" | "base" | "reviewed", number?, number?]) => {
  const result = await readFileAt(gh, review.kind === "pr" ? noGit : runGit, review, ...args);
  return result.ok ? result.text : result.error;
};

test("read_file counts a file's last line once", async () => {
  const gh = vi.fn(async () => ok("a\nb\n"));
  expect(await readFileAt(gh, noGit, pr, "a.ts", "current")).toEqual({ ok: true, text: "a.ts at sha2, lines 1–2 of 2:\n    1  a\n    2  b" });
});

test("read_file returns at most 400 lines, even for a later endLine", async () => {
  const gh = vi.fn(async () => ok(Array.from({ length: 1000 }, (_, i) => `l${i + 1}`).join("\n") + "\n"));
  const text = await read(gh, pr, "a.ts", "current", 1, 5000);
  expect(text).toContain("lines 1–400 of 1000");
  expect(text).toContain("[Call again with startLine=401 for more.]");
  expect(await read(gh, pr, "a.ts", "current", 10, 12)).toContain("lines 10–12 of 1000");
});

test("read_file reads a PR's file at the commit its diff starts from", async () => {
  const gh = vi.fn(async (args: string[]) => args.some((a) => a.includes("/compare/")) ? ok("base1\n") : ok("old\n"));
  expect(await read(gh, pr, "src/a.ts", "base")).toContain("src/a.ts at base1, lines 1–1 of 1:\n    1  old");
  expect(gh.mock.calls[0][0]).toEqual(["api", "repos/acme/web/compare/main...sha2", "--jq", ".merge_base_commit.sha"]);
  expect(gh.mock.calls[1][0].at(-1)).toBe("repos/acme/web/contents/src/a.ts?ref=base1");
});

test("read_file reads a local review's files with git, from either side of its diff", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "gr-read-file-"));
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
    await git("checkout", "-q", "main");
    await writeFile(join(cwd, "a.ts"), "main moved on\n");
    await git("commit", "-qam", "later");
    const local: ReviewMeta = { targetKey: "ref-1", kind: "ref", gitRef: "main...feature", cwd, status: "ready", createdAt: 1 };
    expect(await readFileAt(vi.fn(), runGit, local, "a.ts", "current")).toEqual({ ok: true, text: "a.ts at feature, lines 1–1 of 1:\n    1  two" });
    expect(await read(vi.fn(), local, "a.ts", "base")).toContain("    1  one");
    expect(await read(vi.fn(), { ...local, gitRef: "main..feature" }, "a.ts", "base")).toContain("    1  main moved on");
    const worktree = { ...local, gitRef: "HEAD" };
    expect(await read(vi.fn(), worktree, "a.ts", "base")).toContain("    1  main moved on");
    expect(await readFileAt(vi.fn(), runGit, worktree, "a.ts", "current")).toMatchObject({ ok: false, error: expect.stringContaining("working tree") });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

// read_file, and a local review's CODEOWNERS and file contents, passed the range's right side to `git show <to>:<path>`
// and `git merge-base <from> <to>` first among their arguments (bug bash SEC-9).
test("a local review whose range has a side that reads as an option runs no git", async () => {
  const git = vi.fn(async () => ok(""));
  const local: ReviewMeta = { targetKey: "ref-1", kind: "ref", gitRef: "HEAD~1..--output=/tmp/x", cwd: "/tmp", status: "ready", createdAt: 1 };
  for (const ref of ["current", "base"] as const) expect(await readFileAt(vi.fn(), git, local, "a.ts", ref)).toEqual({ ok: false, error: "HEAD~1..--output=/tmp/x isn't a git ref or range." });
  expect(await localRevs(git, { ...local, gitRef: "-p...main" })).toEqual({ error: "-p...main isn’t a git ref or range." });
  expect(await localRevs(git, { ...local, gitRef: "main...--output=x" })).toEqual({ error: "main...--output=x isn’t a git ref or range." });
  expect(git).not.toHaveBeenCalled();
});

test("the assistant of a local review can read files", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "gr-read-file-"));
  try {
    for (const args of [["init", "-q"], ["config", "user.email", "t@example.com"], ["config", "user.name", "t"]]) await runGit(args, { cwd });
    await writeFile(join(cwd, "a.ts"), "one\n");
    await runGit(["add", "."], { cwd });
    await runGit(["commit", "-qm", "base"], { cwd });
    const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace" });
    await plugin(bb);
    const store = createStore(bb);
    store.saveReview({ targetKey: "ref-1", kind: "ref", gitRef: "HEAD", cwd, status: "ready", createdAt: 1 });
    store.setAssistantThread("ref-1", "assistant");
    expect(await harness.behavior.callAgentTool("read_file", { path: "a.ts", ref: "base" }, { threadId: "assistant" })).toContain("    1  one");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("read_file fails, naming the file's length, for a startLine past its end or an endLine before startLine", async () => {
  const gh = vi.fn(async () => ok(Array.from({ length: 120 }, (_, i) => `l${i + 1}`).join("\n") + "\n"));
  expect(await readFileAt(gh, noGit, pr, "a.ts", "current", 500)).toEqual({ ok: false, error: "startLine 500 is past the end: a.ts at sha2 has 120 lines." });
  expect(await readFileAt(gh, noGit, pr, "a.ts", "current", 50, 10)).toEqual({ ok: false, error: "endLine 10 is before startLine 50." });
  expect(await read(gh, pr, "a.ts", "current", 120)).toBe("a.ts at sha2, lines 120–120 of 120:\n  120  l120");
});
