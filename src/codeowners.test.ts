import { describe, expect, test, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReviewMeta } from "./store";
import { codeOwners, describeOwnership, ownedBy, ownersOf, parseCodeowners, readCodeowners } from "./codeowners";

// GitHub's documented example file (docs.github.com, "About code owners"), trimmed of its comments.
const EXAMPLE = `
# These owners will be the default owners for everything in the repo.
*       @global-owner1 @global-owner2
*.js    @js-owner #This is an inline comment.
*.go docs@example.com
*.txt @octo-org/octocats
/build/logs/ @doctocat
docs/*  docs@example.com
apps/ @octocat
/docs/ @doctocat
/scripts/ @doctocat @octocat
**/logs @octocat
/apps/ @octocat
/apps/github
\\#notes.md @hash-owner
!negated @nobody
[Rr]eadme.md @nobody
`;
const rules = parseCodeowners(EXAMPLE);

describe("CODEOWNERS matches as GitHub documents it", () => {
  test.each([
    ["README.md", ["@global-owner1", "@global-owner2"]],
    // Later rules win over *.
    ["src/index.js", ["@js-owner"]],
    ["main.go", ["docs@example.com"]],
    ["notes/todo.txt", ["@octo-org/octocats"]],
    // /build/logs/ is at the root, with its subdirectories; **/logs (later) takes it.
    ["build/logs/2024/run.log", ["@octocat"]],
    // docs/* matches docs' own files only; /docs/ (later) owns docs and below.
    ["docs/getting-started.md", ["@doctocat"]],
    ["docs/build-app/troubleshooting.md", ["@doctocat"]],
    // apps/ matches an apps directory anywhere.
    ["src/apps/main.rb", ["@octocat"]],
    ["scripts/deploy.sh", ["@doctocat", "@octocat"]],
    ["deeply/nested/logs/today.log", ["@octocat"]],
    // A rule without owners leaves its files unowned.
    ["apps/github/index.rb", []],
    ["apps/other/index.rb", ["@octocat"]],
    // \\# is a literal #.
    ["#notes.md", ["@hash-owner"]],
  ])("%s", (path, owners) => {
    expect(ownersOf(rules, path)).toEqual(owners);
  });

  test("docs/* alone matches only docs' own files", () => {
    const only = parseCodeowners("docs/* @docs");
    expect(ownersOf(only, "docs/getting-started.md")).toEqual(["@docs"]);
    expect(ownersOf(only, "docs/build-app/troubleshooting.md")).toEqual([]);
    expect(ownersOf(only, "src/docs/a.md")).toEqual([]);
  });

  test("/build/logs/ is anchored at the root; a slash-free pattern matches at any depth", () => {
    const set = parseCodeowners("/build/logs/ @doctocat\n*.txt @txt");
    expect(ownersOf(set, "build/logs/a.log")).toEqual(["@doctocat"]);
    expect(ownersOf(set, "src/build/logs/a.log")).toEqual([]);
    expect(ownersOf(set, "a/b/c.txt")).toEqual(["@txt"]);
  });

  test("! and [ ] lines are skipped, as GitHub skips them", () => {
    expect(rules.some((rule) => rule.owners.includes("@nobody"))).toBe(false);
  });
});

test("you own a file as yourself or through a team you're on", () => {
  const teams = new Set(["octo-org/octocats"]);
  expect(ownedBy(["@OctoCat"], "octocat", new Set())).toBe(true);
  expect(ownedBy(["@octo-org/OctoCats"], "someone", teams)).toBe(true);
  expect(ownedBy(["@octo-org/others", "docs@example.com"], "someone", teams)).toBe(false);
});

const ok = (stdout: string) => ({ stdout, stderr: "", code: 0 });
const pr: ReviewMeta = { targetKey: "pr-1", kind: "pr", repo: "acme/web", number: 1, base: "main", headSha: "head1", status: "ready", createdAt: 1 };
const noGit = vi.fn(async () => ok(""));
/**
 * The PR's base branch at its tip, with CODEOWNERS in none, some, or all of its three places. As GitHub does,
 * each place without one is an error beside the data, and gh fails.
 */
const blobs = (...texts: (string | null)[]) => {
  const files = Object.fromEntries(["a", "b", "c"].map((alias, index) => [alias, texts[index] == null ? null : { object: { text: texts[index] } }]));
  const errors = ["a", "b", "c"].filter((alias) => !files[alias]).map((alias) => ({ type: "NOT_FOUND", path: ["repository", "pullRequest", "baseRef", "target", alias], message: "Could not resolve file for path" }));
  return { stdout: JSON.stringify({ data: { repository: { pullRequest: { baseRef: { target: { ...files } } } } }, ...(errors.length ? { errors } : {}) }), stderr: "", code: errors.length ? 1 : 0 };
};

test("a PR's CODEOWNERS is read at its base branch in one call, the first place found wins, and it's kept per head", async () => {
  const gh = vi.fn(async (_args: string[]) => blobs(null, "* @root", "* @docs"));
  expect(await readCodeowners({ runGh: gh, runGit: noGit }, pr)).toEqual({ text: "* @root" });
  const args = gh.mock.calls[0][0];
  expect(args.slice(0, 2)).toEqual(["api", "graphql"]);
  expect(args).toEqual(expect.arrayContaining(["owner=acme", "repo=web", "number=1"]));
  // GitHub takes code owners from the base branch, so the PR's author can't choose them.
  const query = args.find((arg) => arg.startsWith("query="))!;
  expect(query).toContain("baseRef{target{...on Commit{");
  expect(query).toContain('file(path:".github/CODEOWNERS")');
  expect(args.join(" ")).not.toContain("head1");
  expect(await readCodeowners({ runGh: gh, runGit: noGit }, pr)).toEqual({ text: "* @root" });
  expect(gh).toHaveBeenCalledTimes(1);
  // A new head reads again.
  gh.mockImplementation(async () => blobs("* @github"));
  expect(await readCodeowners({ runGh: gh, runGit: noGit }, { ...pr, headSha: "head2" })).toEqual({ text: "* @github" });
});

test("a PR whose base branch is gone has no CODEOWNERS", async () => {
  const gh = vi.fn(async () => ok(JSON.stringify({ data: { repository: { pullRequest: { baseRef: null } } } })));
  expect(await readCodeowners({ runGh: gh, runGit: noGit }, { ...pr, headSha: "head6" })).toEqual({ text: "" });
});

test("an error other than a missing place fails the read", async () => {
  const gh = vi.fn(async () => {
    const body = JSON.parse(blobs("* @root").stdout);
    return { stdout: JSON.stringify({ ...body, errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] }), stderr: "", code: 1 };
  });
  expect(await readCodeowners({ runGh: gh, runGit: noGit }, { ...pr, headSha: "head7" })).toEqual({ error: expect.stringContaining("Couldn’t read CODEOWNERS") });
});

test("a failed read isn't kept, so it's tried again", async () => {
  const gh = vi.fn(async () => ({ stdout: "", stderr: "HTTP 502", code: 1 }));
  const review = { ...pr, headSha: "head3" };
  expect(await readCodeowners({ runGh: gh, runGit: noGit }, review)).toEqual({ error: expect.stringContaining("HTTP 502") });
  gh.mockImplementation(async () => blobs(null));
  expect(await readCodeowners({ runGh: gh, runGit: noGit }, review)).toEqual({ text: "" });
  expect(gh).toHaveBeenCalledTimes(2);
});

test("codeOwners lists the changed files with owners and marks yours", async () => {
  const gh = vi.fn(async () => blobs("* @acme/web\nsrc/api/ @me\n/docs/\n"));
  const viewer = vi.fn(async () => ({ login: "me", teams: new Set<string>() as ReadonlySet<string> }));
  const files = await codeOwners({ runGh: gh, runGit: noGit }, { ...pr, headSha: "head4" }, ["src/api/a.ts", "src/b.ts", "docs/c.md"], viewer);
  expect(files).toEqual([
    { file: "src/api/a.ts", owners: ["@me"], mine: true },
    { file: "src/b.ts", owners: ["@acme/web"], mine: false },
  ]);
  expect(describeOwnership(files)).toBe("CODEOWNERS: the reviewer owns 1 of the changed files, directly or through a team: src/api/a.ts. Look hardest at those.");
  // Without CODEOWNERS, nothing to say and no need to know who you are.
  viewer.mockClear();
  gh.mockImplementation(async () => blobs(null));
  expect(await codeOwners({ runGh: gh, runGit: noGit }, { ...pr, headSha: "head5" }, ["src/b.ts"], viewer)).toEqual([]);
  expect(viewer).not.toHaveBeenCalled();
  expect(describeOwnership([])).toBeNull();
});

test("a local review reads CODEOWNERS from its checkout: the working tree for a single ref, else the ref", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "gr-owners-"));
  try {
    await mkdir(join(cwd, "docs"));
    await writeFile(join(cwd, "docs", "CODEOWNERS"), "* @tree\n");
    const local: ReviewMeta = { targetKey: "local-1", kind: "ref", cwd, gitRef: "HEAD", status: "ready", createdAt: 1 };
    expect(await readCodeowners({ runGh: vi.fn(), runGit: noGit }, local)).toEqual({ text: "* @tree\n" });
    const runGit = vi.fn(async (args: string[]) => args[2] === "main:CODEOWNERS" ? ok("* @ref\n") : { stdout: "", stderr: "fatal: not found", code: 128 });
    expect(await readCodeowners({ runGh: vi.fn(), runGit }, { ...local, gitRef: "base..main" })).toEqual({ text: "* @ref\n" });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

// Each "*" was a backtracking [^/]* in a regular expression, so a rule of many stars against a long name stalled the
// plugin server for minutes, at the start of every guide; a local review's branch writes both (bug bash SEC-4).
test("a hostile CODEOWNERS rule and file name are matched in linear time", async () => {
  const rule = `${"*a".repeat(14)}zz @someone`;
  const runGit = vi.fn(async (args: string[]) => args[0] === "merge-base"
    ? ok(`${"0".repeat(40)}\n`)
    : args[0] === "show" && args.at(-1)!.endsWith(":.github/CODEOWNERS") ? ok(rule) : { stdout: "", stderr: "not found", code: 128 });
  const review: ReviewMeta = { targetKey: "ref-1", kind: "ref", gitRef: "main...feature", cwd: "/tmp", status: "ready", createdAt: 0 };
  const started = performance.now();
  const owned = await codeOwners({ runGh: vi.fn(), runGit }, review, ["a".repeat(40)], async () => ({ login: null, teams: new Set<string>() }));
  expect(performance.now() - started).toBeLessThan(250);
  expect(owned).toEqual([]);
  expect(ownersOf(parseCodeowners(rule), `${"a".repeat(30)}zz`)).toEqual(["@someone"]);
}, 60_000);
