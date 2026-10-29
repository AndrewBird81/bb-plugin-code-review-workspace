// Writes to GitHub: paced, retried only as GitHub asks, refused at once when the page can't wait, refusals worded for
// the reviewer from GitHub's words and never the PR's, and the writes read back.
import { afterEach, expect, test, vi } from "vitest";
import type { runGh } from "./gh";
import { addAssignees, classifyWriteError, createGithubWrites, mergePr, missingScopes, PAGE_BUDGET_MS, pushback, readWriteFacts, type WriteFacts } from "./github-writes";

afterEach(() => { vi.useRealTimers(); });

type Result = Awaited<ReturnType<typeof runGh>>;
const ok = (stdout = "{}"): Result => ({ code: 0, stdout, stderr: "" });
const limited = (headers: string[]): Result => ({
  code: 1, stderr: "gh: You have exceeded a secondary rate limit. (HTTP 403)",
  stdout: ["HTTP/2.0 403 Forbidden", ...headers, "", JSON.stringify({ message: "You have exceeded a secondary rate limit." })].join("\r\n"),
});
const refused = (errors: unknown[], status = 422): Result => ({
  code: 1, stderr: `gh: Unprocessable Entity (HTTP ${status})`, stdout: JSON.stringify({ message: "Unprocessable Entity", errors }),
});
const replyArgs = ["api", "-X", "POST", "repos/acme/web/pulls/1/comments/21/replies", "--input", "-"];
const prArgs = ["pr", "merge", "4", "-R", "acme/web", "--squash"];

test("a rate-limited write waits as long as retry-after says, then posts again, with the headers read through -i", async () => {
  vi.useFakeTimers();
  const run = vi.fn<typeof runGh>().mockResolvedValueOnce(limited(["Retry-After: 30"])).mockResolvedValueOnce(ok("HTTP/2.0 201 Created\r\nX-Thing: 1\r\n\r\n{\"id\":5}"));
  const posted = createGithubWrites().post(run, replyArgs, { stdin: "{}" });
  await vi.advanceTimersByTimeAsync(29_000);
  expect(run).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(run).toHaveBeenCalledTimes(2);
  // The body alone comes back, as without -i.
  expect(await posted).toEqual({ ok: true, stdout: "{\"id\":5}" });
  // A write that hangs is given up on after five minutes, as Submit's is.
  expect(run).toHaveBeenLastCalledWith([...replyArgs, "-i"], { timeoutMs: 300_000, stdin: "{}" });
});

test("with no retry-after, a write waits for x-ratelimit-reset when none are left, else a minute and doubling, and stops after three retries", async () => {
  vi.useFakeTimers();
  const resetAt = Math.floor(Date.now() / 1000) + 90;
  const run = vi.fn<typeof runGh>().mockResolvedValueOnce(limited(["X-Ratelimit-Remaining: 0", `X-Ratelimit-Reset: ${resetAt}`])).mockResolvedValueOnce(ok());
  const reset = createGithubWrites().post(run, replyArgs);
  await vi.advanceTimersByTimeAsync(85_000);
  expect(run).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(5_000);
  expect((await reset).ok).toBe(true);

  const always = vi.fn<typeof runGh>().mockResolvedValue(limited([]));
  const gaveUp = createGithubWrites().post(always, replyArgs);
  for (const [wait, calls] of [[60_000, 2], [120_000, 3], [240_000, 4]]) {
    await vi.advanceTimersByTimeAsync(wait - 1);
    expect(always).toHaveBeenCalledTimes(calls - 1);
    await vi.advanceTimersByTimeAsync(1);
    expect(always).toHaveBeenCalledTimes(calls);
  }
  // GitHub never said how long, so neither does the message.
  expect(await gaveUp).toMatchObject({ ok: false, kind: "rate-limited", error: "GitHub is limiting how fast this account can post, and didn't say for how long. Wait a minute, then try again." });
  expect(always).toHaveBeenCalledTimes(4);
});

test("a limit that outlasts five minutes is reported with how long it lasts, not waited out", async () => {
  vi.useFakeTimers();
  const run = vi.fn<typeof runGh>().mockResolvedValue(limited(["Retry-After: 3000"]));
  expect(await createGithubWrites().post(run, replyArgs)).toMatchObject({ kind: "rate-limited", error: "GitHub is limiting how fast this account can post. Try again in about 50 min." });
  expect(run).toHaveBeenCalledTimes(1);
});

test("a page write is refused at once when GitHub's wait is longer than the page waits, and never posts later", async () => {
  vi.useFakeTimers();
  const writes = createGithubWrites();
  const run = vi.fn<typeof runGh>().mockResolvedValueOnce(limited(["Retry-After: 45"])).mockResolvedValue(ok());
  expect(await writes.post(run, replyArgs, { budgetMs: PAGE_BUDGET_MS })).toMatchObject({ kind: "rate-limited", error: "GitHub is limiting how fast this account can post. Try again in about 45 s." });
  // The next page write knows the wait without asking GitHub, and isn't queued.
  expect(await writes.post(run, replyArgs, { budgetMs: PAGE_BUDGET_MS })).toMatchObject({ kind: "rate-limited", error: expect.stringContaining("about 45 s") });
  await vi.advanceTimersByTimeAsync(120_000);
  expect(run).toHaveBeenCalledTimes(1);
  // Once it's over, page writes go again.
  expect(await writes.post(run, replyArgs, { budgetMs: PAGE_BUDGET_MS })).toEqual({ ok: true, stdout: "{}" });
});

test("a page write behind a write that's waiting out a limit, or one that's slow, gives up when the page would, and never posts later", async () => {
  vi.useFakeTimers();
  const writes = createGithubWrites();
  const run = vi.fn<typeof runGh>().mockResolvedValueOnce(limited(["Retry-After: 120"])).mockResolvedValue(ok());
  // The agent's write waits out two minutes.
  const agents = writes.post(run, ["api", "-X", "POST", "repos/acme/web/issues/1/comments"]);
  await vi.advanceTimersByTimeAsync(0);
  expect(await writes.post(run, replyArgs, { budgetMs: PAGE_BUDGET_MS })).toMatchObject({ kind: "rate-limited", error: "GitHub is limiting how fast this account can post. Try again in about 2 min." });
  await vi.advanceTimersByTimeAsync(130_000);
  expect((await agents).ok).toBe(true);
  expect(run.mock.calls.filter(([args]) => args.includes(replyArgs[3]))).toHaveLength(0);

  let answer!: (result: Result) => void;
  const slow = vi.fn<typeof runGh>(() => new Promise<Result>((resolve) => { answer = resolve; }));
  const held = writes.post(slow, ["pr", "edit", "1", "-R", "acme/web", "--add-label", "bug"]);
  await vi.advanceTimersByTimeAsync(2_000);
  const page = writes.post(run, replyArgs, { budgetMs: PAGE_BUDGET_MS });
  await vi.advanceTimersByTimeAsync(PAGE_BUDGET_MS);
  expect(await page).toEqual({ ok: false, kind: "busy", error: "An earlier post to GitHub is still going out. Try again in a moment.", detail: "" });
  answer(ok());
  await held;
  await vi.advanceTimersByTimeAsync(5_000);
  expect(run.mock.calls.filter(([args]) => args.includes(replyArgs[3]))).toHaveLength(0);
});

test("a write gh gave up on isn't retried, and says it may have posted", async () => {
  const run = vi.fn<typeof runGh>().mockResolvedValue({ code: 124, stdout: "", stderr: "gh timed out after 300s" });
  expect(await createGithubWrites().post(run, replyArgs)).toEqual({ ok: false, kind: "timeout", error: "GitHub didn't answer in time. It may have posted; check before sending again.", detail: "gh timed out after 300s" });
  expect(run).toHaveBeenCalledTimes(1);
});

test("a 403 that isn't a rate limit is never retried, and says whether it's the role, the token or single sign-on", async () => {
  vi.useFakeTimers();
  const run = vi.fn<typeof runGh>().mockResolvedValue({ code: 1, stdout: "HTTP/2.0 403 Forbidden\r\n\r\n{\"message\":\"Must have admin rights to Repository.\"}", stderr: "gh: Must have admin rights to Repository. (HTTP 403)" });
  expect(await createGithubWrites().post(run, replyArgs, { action: "reply" })).toEqual({ ok: false, kind: "forbidden", error: "Your GitHub role on this repo doesn't allow that. Ask someone with write access to do it.", detail: "Must have admin rights to Repository." });
  expect(run).toHaveBeenCalledTimes(1);
  const forbidden = (message: string) => ({ stdout: JSON.stringify({ message }), stderr: `gh: ${message} (HTTP 403)` });
  expect(classifyWriteError(forbidden("Something else"), { args: replyArgs, action: "review" }).error).toBe("Your GitHub role on this repo doesn't allow that. Leave a comment instead?");
  expect(classifyWriteError(forbidden("Resource not accessible by personal access token"), { args: replyArgs })).toMatchObject({ kind: "token", error: expect.stringContaining("The GitHub token on the BB server isn't allowed") });
  expect(classifyWriteError(forbidden("Resource not accessible by integration"), { args: replyArgs })).toMatchObject({ kind: "token" });
  expect(classifyWriteError(forbidden("Resource protected by organization SAML enforcement. You must grant your OAuth token access to this organization."), { args: replyArgs })).toMatchObject({ kind: "sso" });
});

test("a PR's title never makes a write retry or picks its message: only GitHub's status and words, or gh's error, do", async () => {
  vi.useFakeTimers();
  const title = "Fix rate limit and pending review (HTTP 403)";
  // gh merged it, printing the title, then failed to delete the branch.
  const run = vi.fn<typeof runGh>(async (args) => args[1] === "view" ? ok("{\"state\":\"MERGED\",\"headRefOid\":\"abc123\"}")
    : { code: 1, stdout: `✓ Squashed and merged pull request acme/web#4 (${title})\n`, stderr: `! Pull request acme/web#4 (${title}) was merged\nfailed to delete remote branch: HTTP 422` });
  expect(await mergePr(createGithubWrites(), run, "acme/web", 4, { headSha: "abc123", method: "squash", deleteBranch: true })).toMatchObject({ ok: true, merged: true });
  expect(run.mock.calls.filter(([args]) => args[1] === "merge")).toHaveLength(1);
  expect(classifyWriteError({ stdout: "", stderr: `X Pull request acme/web#4 (${title}) is not mergeable: the base branch policy prohibits the merge.` }, { args: prArgs })).toMatchObject({ kind: "not-mergeable" });
  // A gh api error is read from GitHub's status and message, not what the request carried.
  expect(classifyWriteError({ stdout: JSON.stringify({ message: "Validation Failed", errors: [{ message: "Something about the review" }] }), stderr: "gh: Validation Failed (HTTP 422)" }, { args: replyArgs }).kind).toBe("other");
});

test("GitHub's refusals say what happened and what to do, and keep GitHub's words", () => {
  expect(classifyWriteError(refused(["User can only have one pending review per pull request"]))).toEqual({
    ok: false, kind: "pending-review", detail: "Unprocessable Entity — User can only have one pending review per pull request",
    error: "You have an unsent review on this PR on GitHub, and GitHub allows one at a time. Submit or discard it on GitHub, then try again.",
  });
  expect(classifyWriteError(refused(["Review Can not approve your own pull request"]))).toMatchObject({ kind: "own-pr", error: "GitHub won't let you approve your own PR. Post it as a comment instead?" });
  expect(classifyWriteError(refused(["Review Can not request changes on your own pull request"]))).toMatchObject({ kind: "own-pr", error: expect.stringContaining("request changes on your own PR") });
  expect(classifyWriteError(refused([{ resource: "PullRequestReviewComment", field: "pull_request_review_thread.line", code: "invalid", message: "pull_request_review_thread.line must be part of the diff" }]))).toMatchObject({ kind: "outside-diff" });
  expect(classifyWriteError(refused([{ resource: "PullRequestReview", field: "body", code: "missing_field" }]))).toMatchObject({ kind: "body-required" });
  const merge = (stderr: string) => classifyWriteError({ stdout: "", stderr }, { args: prArgs });
  expect(merge("X Pull request acme/web#4 is not mergeable: the base branch policy prohibits the merge.")).toMatchObject({ kind: "not-mergeable", error: expect.stringContaining("Merge it automatically once they do?") });
  expect(merge("X Pull request acme/web#4 is not mergeable: the merge commit cannot be cleanly created.")).toMatchObject({ kind: "conflicts", error: "GitHub can't merge this PR: its branch has conflicts with the base branch. Resolve them on the branch, then merge again." });
  expect(merge("X Pull request acme/web#4 is not mergeable: the head branch is not up to date with the base branch.")).toMatchObject({ kind: "not-up-to-date" });
  // The scope GitHub names, not always the same two.
  expect(classifyWriteError({ stdout: "", stderr: "error: your authentication token is missing required scopes [read:project]\nTo request it, run:  gh auth refresh -s read:project" }, { args: ["pr", "edit", "4"] }))
    .toMatchObject({ kind: "missing-scope", error: "The GitHub login on the BB server is missing the read:project scope. Run gh auth refresh -h github.com -s read:project there, then try again." });
  expect(classifyWriteError({ stdout: "", stderr: "error fetching organization teams: GraphQL: Your token has not been granted the required scopes" }, { args: ["pr", "edit", "4"] }).error).toContain("-s read:org ");
  // Anything else is GitHub's own message.
  expect(classifyWriteError({ stdout: "", stderr: "HTTP 502: Bad Gateway" })).toEqual({ ok: false, kind: "other", error: "HTTP 502: Bad Gateway", detail: "HTTP 502: Bad Gateway" });
});

test("six writes post one at a time, each at least a second after the last ended", async () => {
  vi.useFakeTimers();
  const spans: [number, number][] = [];
  const run = vi.fn<typeof runGh>(async () => {
    const start = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 200));
    spans.push([start, Date.now()]);
    return ok();
  });
  const writes = createGithubWrites();
  const all = Promise.all(Array.from({ length: 6 }, (_, i) => writes.post(run, ["pr", "edit", String(i), "--add-label", "bug"])));
  await vi.advanceTimersByTimeAsync(10_000);
  await all;
  expect(spans).toHaveLength(6);
  for (let i = 1; i < 6; i++) expect(spans[i][0] - spans[i - 1][1]).toBeGreaterThanOrEqual(1_000);
  // In the order they were asked for.
  expect(run.mock.calls.map(([args]) => args[2])).toEqual(["0", "1", "2", "3", "4", "5"]);
});

test("paced writes run once, even rate-limited, and a failed one doesn't stop the line", async () => {
  vi.useFakeTimers();
  const writes = createGithubWrites();
  const run = vi.fn<typeof runGh>().mockResolvedValue(limited(["Retry-After: 1"]));
  const once = writes.pace(() => run(replyArgs));
  const failed = writes.pace(() => Promise.reject(new Error("boom")));
  const next = writes.pace(async () => "next");
  await Promise.all([expect(failed).rejects.toThrow("boom"), vi.advanceTimersByTimeAsync(5_000)]);
  expect(await once).toMatchObject({ code: 1 });
  expect(await next).toBe("next");
  expect(run).toHaveBeenCalledTimes(1);
});

const facts = (over: Partial<WriteFacts> = {}): WriteFacts => ({ viewer: "me", author: "per", permission: "WRITE", state: "OPEN", headSha: "abc", ...over });

test("the write-only read asks for the thread's permissions only when there's a thread", async () => {
  const run = vi.fn<typeof runGh>().mockResolvedValue(ok(JSON.stringify({ data: {
    viewer: { login: "me" }, repository: { viewerPermission: "TRIAGE", pullRequest: { state: "OPEN", headRefOid: "abc", author: { login: "per" } } },
    node: { viewerCanReply: true, viewerCanResolve: false, viewerCanUnresolve: false },
  } })));
  expect(await readWriteFacts(run, "acme/web", 4, "PRRT_1")).toEqual({ ...facts({ permission: "TRIAGE" }), thread: { canReply: true, canResolve: false, canUnresolve: false } });
  expect(run.mock.calls[0][0].join(" ")).toContain("viewerCanResolve");
  expect(run.mock.calls[0][0]).toContain("thread=PRRT_1");
  await readWriteFacts(run, "acme/web", 4);
  expect(run.mock.calls[1][0].join(" ")).not.toContain("viewerCanResolve");
  run.mockResolvedValueOnce({ code: 1, stdout: "", stderr: "gh: Could not resolve to a Repository (HTTP 404)" });
  expect(await readWriteFacts(run, "acme/web", 4)).toEqual({ error: expect.stringContaining("Couldn't check what GitHub lets you do on this PR") });
});

test("a missing role or permission is one pushback offering what GitHub will take", () => {
  expect(pushback("label", facts({ permission: "READ" }), "acme/web")).toBe("That needs the Triage role on acme/web, which this account doesn't have. Suggest it in a comment instead?");
  expect(pushback("label", facts({ permission: "TRIAGE" }), "acme/web")).toBeNull();
  expect(pushback("merge", facts({ permission: "TRIAGE" }), "acme/web")).toContain("Write role");
  // A teammate's title needs Write; your own doesn't.
  expect(pushback("edit", facts({ permission: "TRIAGE" }), "acme/web")).toContain("Write role");
  expect(pushback("edit", facts({ permission: "READ", author: "Me" }), "acme/web")).toBeNull();
  expect(pushback("resolve", facts({ thread: { canReply: true, canResolve: false, canUnresolve: false } }), "acme/web")).toBe("GitHub lets only the PR's author or someone with write access resolve threads. Reply instead?");
  expect(pushback("reply", facts({ thread: { canReply: false, canResolve: true, canUnresolve: true } }), "acme/web")).toContain("Leave a PR comment instead?");
  expect(pushback("merge", facts({ state: "MERGED" }), "acme/web")).toBe("This PR is already merged, so there's nothing to merge.");
  // GitHub not saying leaves it to GitHub.
  expect(pushback("merge", facts({ permission: null }), "acme/web")).toBeNull();
  expect(pushback("review", facts({ permission: "READ" }), "acme/web")).toBeNull();
});

test("an assignee GitHub ignored, without push access, is reported, and more than ten go ten at a time", async () => {
  const run = vi.fn<typeof runGh>(async (args) => args[1] === "view" ? ok(JSON.stringify({ assignees: [{ login: "Alice" }] })) : ok(""));
  expect(await addAssignees(createGithubWrites(), run, "acme/web", 4, ["alice", "bob", "@me"])).toEqual({
    ok: true, ignored: ["bob"], note: "GitHub didn't assign @bob: only people with push access to acme/web can be assigned.",
  });
  expect(run.mock.calls[0][0]).toEqual(["pr", "edit", "4", "-R", "acme/web", "--add-assignee", "alice,bob,@me"]);
  expect(await addAssignees(createGithubWrites(), run, "acme/web", 4, ["alice"])).toEqual({ ok: true, ignored: [] });

  vi.useFakeTimers();
  run.mockClear();
  const twelve = Array.from({ length: 12 }, (_, i) => `u${i}`);
  const assigned = addAssignees(createGithubWrites(), run, "acme/web", 4, twelve);
  await vi.advanceTimersByTimeAsync(2_000);
  await assigned;
  expect(run.mock.calls.filter(([args]) => args[1] === "edit").map(([args]) => args.at(-1)!.split(",").length)).toEqual([10, 2]);
});

test("a merge goes only at the reviewed head; pending checks are a pushback offering auto-merge", async () => {
  vi.useFakeTimers();
  const run = vi.fn<typeof runGh>(async (args) => args[1] === "view" ? ok("{\"state\":\"OPEN\"}") : { code: 1, stdout: "", stderr: "X Pull request acme/web#4 is not mergeable: the base branch policy prohibits the merge.\nTo have the pull request merged after all the requirements have been met, add the `--auto` flag." });
  const merged = mergePr(createGithubWrites(), run, "acme/web", 4, { headSha: "abc123", method: "squash" });
  await vi.advanceTimersByTimeAsync(0);
  expect(await merged).toMatchObject({ ok: false, kind: "not-mergeable", error: "GitHub can't merge this PR yet: required checks or reviews haven't passed. Merge it automatically once they do?" });
  expect(run.mock.calls[0][0]).toEqual(["pr", "merge", "4", "-R", "acme/web", "--squash", "--match-head-commit", "abc123"]);
  // Not retried: a refusal isn't a rate limit.
  expect(run.mock.calls.filter(([args]) => args[1] === "merge")).toHaveLength(1);

  run.mockImplementation(async (args) => ok(args[1] === "view" ? "{\"state\":\"OPEN\"}" : ""));
  expect(await mergePr(createGithubWrites(), run, "acme/web", 4, { headSha: "abc123", method: "squash", auto: true })).toEqual({ ok: true, merged: false, note: "GitHub will merge it once its checks and reviews pass." });
  expect(run.mock.calls.at(-2)![0]).toContain("--auto");
});

test("a --delete-branch failure after GitHub merged at the reviewed head counts as merged; at another head, someone else merged it", async () => {
  const run = vi.fn<typeof runGh>(async (args) => args[1] === "view" ? ok("{\"state\":\"MERGED\",\"headRefOid\":\"abc123\"}") : { code: 1, stdout: "", stderr: "failed to delete local branch feat: cannot delete branch used by worktree" });
  expect(await mergePr(createGithubWrites(), run, "acme/web", 4, { headSha: "abc123", method: "merge", deleteBranch: true })).toEqual({
    ok: true, merged: true, note: "Merged, but gh couldn't confirm the branch was deleted. Check it on GitHub.",
  });
  expect(run.mock.calls[0][0]).toContain("--delete-branch");
  run.mockImplementation(async (args) => args[1] === "view" ? ok("{\"state\":\"MERGED\",\"headRefOid\":\"def456\"}") : { code: 1, stdout: "", stderr: "Head branch was modified. Review and try the merge again." });
  expect(await mergePr(createGithubWrites(), run, "acme/web", 4, { headSha: "abc123", method: "merge" })).toMatchObject({ ok: false, kind: "merged-elsewhere", error: "Someone else already merged this PR, at a commit you didn't review." });
});

test("the token-scope probe lists what a classic token lacks, says when a token doesn't list them, and when it couldn't ask", async () => {
  const user = (scopes?: string) => vi.fn<typeof runGh>().mockResolvedValue(ok(["HTTP/2.0 200 OK", ...(scopes === undefined ? [] : [`X-Oauth-Scopes: ${scopes}`]), "", "{\"login\":\"me\"}"].join("\r\n")));
  expect(await missingScopes(user("repo, read:org, workflow"))).toEqual([]);
  expect(await missingScopes(user("repo"))).toEqual(["read:org"]);
  expect(await missingScopes(user("admin:org, gist"))).toEqual(["repo"]);
  expect(await missingScopes(user(""))).toEqual(["repo", "read:org"]);
  expect(await missingScopes(user())).toBe("unlisted");
  const probe = user("repo");
  await missingScopes(probe);
  expect(probe).toHaveBeenCalledWith(["api", "-i", "user"]);
  expect(await missingScopes(vi.fn<typeof runGh>().mockResolvedValue({ code: 1, stdout: "", stderr: "gh: not logged in" }))).toBeNull();
});
