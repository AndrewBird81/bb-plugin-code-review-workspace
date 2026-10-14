import { test, expect } from "vitest";
import {
  ghPrViewArgs, ghPrDiffArgs, ghRepoViewArgs, ghSubmitReviewArgs, gitDiffArgs,
  ghPrChecksJsonArgs, ghPrHeadArgs, ghReviewThreadsArgs, ghReplyThreadArgs,
  ghResolveThreadArgs, ghUnresolveThreadArgs, ghErrorMessage, runGit,
} from "./gh";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changedFiles } from "./patch";

test("ghErrorMessage surfaces GitHub's message + field errors from a 422 body", () => {
  const stderr =
    'gh: Unprocessable Entity (HTTP 422)\n{"message":"Validation Failed","errors":[{"resource":"PullRequestReviewComment","field":"line","code":"invalid","message":"line must be part of the diff"}]}';
  const msg = ghErrorMessage({ stdout: "", stderr });
  expect(msg).toContain("Validation Failed");
  expect(msg).toContain("line must be part of the diff");
  expect(msg).not.toContain("HTTP 422"); // the opaque prefix is dropped
});

test("ghErrorMessage reads the body from stdout (where gh api writes it)", () => {
  // gh api puts the JSON body on stdout and only the terse summary on stderr.
  const r = {
    stdout: '{"message":"Unprocessable Entity","documentation_url":"https://docs.github.com"}',
    stderr: "gh: Unprocessable Entity (HTTP 422)",
  };
  expect(ghErrorMessage(r)).toBe("Unprocessable Entity");
});

test("ghErrorMessage falls back to the raw text without the 'gh:' prefix", () => {
  expect(ghErrorMessage({ stdout: "", stderr: "gh: could not resolve host" })).toBe("could not resolve host");
});

test("pr view requests the json fields we need, with optional -R", () => {
  expect(ghPrViewArgs(12)).toEqual([
    "pr", "view", "12", "--json", "number,title,body,author,baseRefName,headRefName,url,headRefOid",
  ]);
  expect(ghPrViewArgs(12, "acme/web")).toContain("-R");
});

test("pr diff targets the number", () => {
  expect(ghPrDiffArgs(12)).toEqual(["pr", "diff", "12", "--color", "never"]);
});

test("repo view returns nameWithOwner", () => {
  expect(ghRepoViewArgs()).toEqual(["repo", "view", "--json", "nameWithOwner"]);
});

test("submit review posts to the reviews endpoint reading json from stdin", () => {
  expect(ghSubmitReviewArgs("acme/web", 12)).toEqual([
    "api", "-X", "POST", "repos/acme/web/pulls/12/reviews", "--input", "-",
  ]);
});

test("git diff builds a range", () => {
  const standard = ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--src-prefix=a/", "--dst-prefix=b/", "--no-relative"];
  expect(gitDiffArgs("feature/x", "main")).toEqual([...standard, "main...feature/x", "--"]);
  expect(gitDiffArgs("main...HEAD")).toEqual([...standard, "main...HEAD", "--"]);
});

test("a local diff keeps the standard format whatever the repo's git config says", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "gr-gitconfig-"));
  try {
    for (const args of [["init", "-q"], ["config", "user.email", "t@example.com"], ["config", "user.name", "t"]]) await runGit(args, { cwd });
    await mkdir(join(cwd, "sub"));
    await writeFile(join(cwd, "sub", "a.txt"), "one\n");
    await runGit(["add", "."], { cwd });
    await runGit(["commit", "-qm", "init"], { cwd });
    await writeFile(join(cwd, "sub", "a.txt"), "two\n");
    for (const [key, value] of [["diff.noprefix", "true"], ["diff.mnemonicPrefix", "true"], ["color.diff", "always"], ["color.ui", "always"], ["diff.relative", "true"]]) {
      await runGit(["config", key, value], { cwd });
    }
    const out = await runGit(gitDiffArgs("HEAD"), { cwd: join(cwd, "sub") });
    expect(out.code).toBe(0);
    expect(changedFiles(out.stdout)).toEqual(["sub/a.txt"]);
    expect(out.stdout).not.toContain("\x1b[");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("pr checks json requests the fields we need, with optional -R", () => {
  expect(ghPrChecksJsonArgs(12)).toEqual([
    "pr", "checks", "12", "--json", "name,state,bucket,link",
  ]);
  expect(ghPrChecksJsonArgs(12, "acme/web")).toEqual([
    "pr", "checks", "12", "--json", "name,state,bucket,link", "-R", "acme/web",
  ]);
});

test("pr head requests headRefOid and reviewDecision, with optional -R", () => {
  expect(ghPrHeadArgs(12)).toEqual([
    "pr", "view", "12", "--json", "headRefOid,baseRefName,reviewDecision,state",
  ]);
  expect(ghPrHeadArgs(12, "acme/web")).toEqual([
    "pr", "view", "12", "--json", "headRefOid,baseRefName,reviewDecision,state", "-R", "acme/web",
  ]);
});

test("review threads args page with a cursor", () => {
  expect(ghReviewThreadsArgs("acme", "web", 12).join(" ")).not.toContain("after=");
  expect(ghReviewThreadsArgs("acme", "web", 12, "c1").slice(-2)).toEqual(["-f", "after=c1"]);
  expect(ghReviewThreadsArgs("acme", "web", 12)[3]).toContain("pageInfo{hasNextPage endCursor}");
  expect(ghReviewThreadsArgs("acme", "web", 12)[3]).toContain("path line diffSide");
});

test("review threads args ask where each thread was, who resolved it, and who wrote each comment when", () => {
  const query = ghReviewThreadsArgs("acme", "web", 12)[3];
  for (const field of ["originalLine", "startLine", "subjectType", "resolvedBy{login}", "author{__typename login}", "createdAt"]) expect(query).toContain(field);
});

test("review threads args build a graphql query with owner/repo as -f strings and number as -F int", () => {
  const args = ghReviewThreadsArgs("acme", "web", 12);
  expect(args[0]).toBe("api");
  expect(args[1]).toBe("graphql");
  expect(args[2]).toBe("-f");
  expect(args[3]).toContain("query=");
  expect(args[3]).toContain("reviewThreads");
  expect(args).toContain("-f");
  expect(args).toContain("-F");
  expect(args).toEqual(expect.arrayContaining(["owner=acme", "repo=web", "number=12"]));
  // owner/repo must ride on -f (raw string) so gh doesn't coerce numeric-looking
  // names to JSON numbers against the GraphQL String! vars; number stays -F (Int!).
  expect(args.indexOf("-f")).toBeLessThan(args.indexOf("owner=acme"));
  const ownerIdx = args.indexOf("owner=acme");
  const repoIdx = args.indexOf("repo=web");
  const numberIdx = args.indexOf("number=12");
  expect(args[ownerIdx - 1]).toBe("-f");
  expect(args[repoIdx - 1]).toBe("-f");
  expect(args[numberIdx - 1]).toBe("-F");
});

test("reply thread args post to the pr comment replies endpoint reading json from stdin", () => {
  expect(ghReplyThreadArgs("acme/web", 12, 999)).toEqual([
    "api", "-X", "POST", "repos/acme/web/pulls/12/comments/999/replies", "--input", "-",
  ]);
});

test("resolve thread args build a graphql mutation with the thread id as a raw -f string", () => {
  const args = ghResolveThreadArgs("THREAD_ID");
  expect(args[0]).toBe("api");
  expect(args[1]).toBe("graphql");
  expect(args[2]).toBe("-f");
  expect(args[3]).toContain("resolveReviewThread");
  expect(args).toContain("id=THREAD_ID");
  expect(args[args.indexOf("id=THREAD_ID") - 1]).toBe("-f");
});

test("unresolve thread args build a graphql mutation with the thread id as a raw -f string", () => {
  const args = ghUnresolveThreadArgs("THREAD_ID");
  expect(args[0]).toBe("api");
  expect(args[1]).toBe("graphql");
  expect(args[2]).toBe("-f");
  expect(args[3]).toContain("unresolveReviewThread");
  expect(args).toContain("id=THREAD_ID");
  expect(args[args.indexOf("id=THREAD_ID") - 1]).toBe("-f");
});

test("a hung command is killed after its timeout", async () => {
  const { runGit } = await import("./gh");
  const started = Date.now();
  const result = await runGit(["-c", "alias.wait=!sleep 5", "wait"], { timeoutMs: 200 });
  expect(result.code).toBe(124);
  expect(result.stderr).toMatch(/timed out/);
  expect(Date.now() - started).toBeLessThan(3000);
});

test("a command's output keeps characters split across reads, and stops at the buffer limit", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "gr-run-"));
  try {
    await runGit(["init", "-q"], { cwd });
    const text = "x" + "é".repeat(300_000) + "\n";
    await writeFile(join(cwd, "big.txt"), text);
    const blob = (await runGit(["hash-object", "-w", "big.txt"], { cwd })).stdout.trim();
    expect((await runGit(["cat-file", "-p", blob], { cwd })).stdout).toBe(text);
    const capped = await runGit(["cat-file", "-p", blob], { cwd, maxBuffer: 1000 });
    expect(capped).toMatchObject({ stdout: "", code: 1 });
    expect(capped.stderr).toMatch(/^git printed more than \d+ MB, too much to read\.$/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
