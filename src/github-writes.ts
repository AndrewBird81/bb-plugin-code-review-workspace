// Writes to GitHub: one at a time, paced and retried as GitHub asks; GitHub's refusals in words the reviewer can act on;
// what the account may do on a PR, read just before writing; and the writes that need a second look: assignees, merge.
import { ghErrorMessage, runGh } from "./gh";

type Run = typeof runGh;
type RunResult = Awaited<ReturnType<Run>>;

/** GitHub asks for at least a second between writes. */
const GAP_MS = 1_000;
/** A rate limit with no time to wait says nothing of how long: at least a minute, doubling. */
const FIRST_BACKOFF_MS = 60_000;
const RETRIES = 3;
/** Longer than this, GitHub's limit outlasts anyone waiting on the write: it's refused instead. */
const MAX_WAIT_MS = 5 * 60_000;
/** As Submit's: a write killed then may still land, so it's never retried. */
const WRITE_TIMEOUT_MS = 5 * 60_000;
/**
 * How long a write the page waits on may wait to start: it's refused instead, before the page gives up on it while
 * it's still queued to post, and the reviewer posts it again.
 */
export const PAGE_BUDGET_MS = 20_000;

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** `gh api` with `-i`: the response's status line and headers, for its rate limit, then its body. */
function withHeaders(args: string[]): string[] {
  return args[0] === "api" && !args.includes("-i") ? [...args, "-i"] : args;
}
/** The headers `-i` printed, lower-cased, and the result with only the body left in stdout. */
function splitHeaders(result: RunResult): { headers: Record<string, string>; result: RunResult } {
  if (!/^HTTP\/[\d.]+ \d{3}/.test(result.stdout)) return { headers: {}, result };
  const end = result.stdout.search(/\r?\n\r?\n/);
  const head = end < 0 ? result.stdout : result.stdout.slice(0, end);
  const headers: Record<string, string> = {};
  for (const line of head.split(/\r?\n/).slice(1)) {
    const colon = line.indexOf(":");
    if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  headers[":status"] = head.split(" ")[1];
  return { headers, result: { ...result, stdout: end < 0 ? "" : result.stdout.slice(end).replace(/^\r?\n\r?\n/, "") } };
}

/**
 * What a failed write's refusal is read from, never the PR's own text: for `gh api`, GitHub's HTTP status and its error
 * message; for `gh pr`, which echoes the PR's title, gh's error output with any `#n (title)` taken out.
 */
function refusalOf(args: string[], result: { stdout: string; stderr: string }, headers: Record<string, string> = {}): { status?: number; text: string } {
  if (args[0] === "api") {
    const status = Number(headers[":status"] ?? result.stderr.match(/\(HTTP (\d{3})\)/)?.[1]) || undefined;
    return { status, text: `${ghErrorMessage({ stdout: result.stdout, stderr: "" })}\n${result.stderr}` };
  }
  return { text: result.stderr.replace(/#\d+ \(.*\)/g, "#") };
}

/** GitHub's rate limits, primary and secondary, and its abuse detection. */
const RATE_LIMITED = /rate limit|abuse detection/i;
/** A 429, or a 403 (or GraphQL's 200) saying it's a rate limit; from gh pr, its error saying so. */
function rateLimited(args: string[], refusal: { status?: number; text: string }): boolean {
  if (args[0] !== "api") return RATE_LIMITED.test(refusal.text);
  return refusal.status === 429 || ((refusal.status === 403 || (args[1] === "graphql" && refusal.status === 200)) && RATE_LIMITED.test(refusal.text));
}

/** How long GitHub asked to wait (`asked`): `retry-after`, else until `x-ratelimit-reset` when none are left; else a minute, doubling. */
function backoff(headers: Record<string, string>, attempt: number, now: number): { ms: number; asked: boolean } {
  const after = Number(headers["retry-after"]);
  if (headers["retry-after"] && Number.isFinite(after)) return { ms: Math.max(after * 1000, GAP_MS), asked: true };
  const reset = Number(headers["x-ratelimit-reset"]);
  if (headers["x-ratelimit-remaining"] === "0" && Number.isFinite(reset)) return { ms: Math.max(reset * 1000 - now, GAP_MS), asked: true };
  return { ms: FIRST_BACKOFF_MS * 2 ** attempt, asked: false };
}

const about = (ms: number) => ms < 60_000 ? `${Math.ceil(ms / 1000)} s` : `${Math.ceil(ms / 60_000)} min`;
/** A rate limit, with how long it lasts when that's known. */
function limited(detail: string, waitMs?: number): WriteRefusal {
  return {
    ok: false, kind: "rate-limited", detail,
    error: waitMs ? `GitHub is limiting how fast this account can post. Try again in about ${about(waitMs)}.` : "GitHub is limiting how fast this account can post, and didn't say for how long. Wait a minute, then try again.",
  };
}

/** A write that succeeded: the response's body, with any headers gh printed for it taken off. */
export type WriteResult = { ok: true; stdout: string } | WriteRefusal;

/**
 * The server's one line of writes to GitHub: each starts at least a second after the last ended. `post` retries one
 * GitHub rate-limited, up to three times, waiting as long as it asked, up to five minutes; the writes behind it wait
 * too. `pace` runs a write once, for those that must never be repeated blind, such as the page's Submit, which looks
 * for its review on GitHub instead. A write given `budgetMs` (the page's: PAGE_BUDGET_MS) that can't start within it,
 * or would wait longer for a rate limit, is refused at once and never posts.
 */
export function createGithubWrites() {
  let tail: Promise<unknown> = Promise.resolve();
  let lastEnded = 0;
  /** When GitHub's last rate limit ends, as far as is known. */
  let limitedUntil = 0;
  function pace<T>(write: (deadline: number) => Promise<T>, budgetMs?: number): Promise<T | WriteRefusal> {
    const asked = Date.now();
    const deadline = budgetMs === undefined ? Infinity : asked + budgetMs;
    if (limitedUntil > deadline) return Promise.resolve(limited("", limitedUntil - asked));
    let started = false, gaveUp = false;
    const turn = tail.then(async () => {
      if (gaveUp) return undefined as T;
      started = true;
      const gap = lastEnded + GAP_MS - Date.now();
      if (gap > 0) await wait(gap);
      try { return await write(deadline); } finally { lastEnded = Date.now(); }
    });
    tail = turn.catch(() => {});
    if (budgetMs === undefined) return turn;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (started) return;
        gaveUp = true;
        const now = Date.now();
        resolve(limitedUntil > now ? limited("", limitedUntil - now) : { ok: false, kind: "busy", error: "An earlier post to GitHub is still going out. Try again in a moment.", detail: "" });
      }, budgetMs);
      turn.then((value) => { clearTimeout(timer); if (!gaveUp) resolve(value); }, (error) => { clearTimeout(timer); if (!gaveUp) reject(error); });
    });
  }
  /** One write through `run`; `action` words its refusal. */
  function post(run: Run, args: string[], { stdin, action, budgetMs }: { stdin?: string; action?: WriteAction; budgetMs?: number } = {}): Promise<WriteResult> {
    return pace(async (deadline): Promise<WriteResult> => {
      for (let attempt = 0; ; attempt++) {
        const { headers, result } = splitHeaders(await run(withHeaders(args), { timeoutMs: WRITE_TIMEOUT_MS, ...(stdin !== undefined ? { stdin } : {}) }));
        if (result.code === 0) return { ok: true, stdout: result.stdout };
        if (result.code === 124 || !rateLimited(args, refusalOf(args, result, headers))) return classifyWriteError(result, { args, action });
        const { ms, asked } = backoff(headers, attempt, Date.now());
        const giveUp = attempt === RETRIES || ms > MAX_WAIT_MS || Date.now() + ms > deadline;
        // The writes the page waits on then know it, and don't wait in line for it.
        if (asked || !giveUp) limitedUntil = Math.max(limitedUntil, Date.now() + ms);
        if (giveUp) return limited(ghErrorMessage(result), asked ? ms : undefined);
        await wait(ms);
      }
    }, budgetMs);
  }
  return { pace, post };
}
export type GithubWrites = ReturnType<typeof createGithubWrites>;

/**
 * GitHub's refusals the reviewer can act on, matched by substring on GitHub's or gh's error (refusalOf), first match
 * wins. Most of the wording comes from reports, not GitHub's docs (notes/design/H2-github-api.md): those are marked
 * unverified, to check against a scratch repo and adjust here.
 */
const REFUSALS: { kind: string; match: RegExp; error: string | ((text: string, action?: WriteAction) => string) }[] = [
  // unverified (H2): self-approve wording
  { kind: "own-pr", match: /can ?not approve your own pull request/i, error: "GitHub won't let you approve your own PR. Post it as a comment instead?" },
  // unverified (H2): self-request-changes wording
  { kind: "own-pr", match: /can ?not request changes on your own pull request/i, error: "GitHub won't let you request changes on your own PR. Post it as a comment instead?" },
  // unverified (H2): the pending-review conflict
  { kind: "pending-review", match: /pending review/i, error: "You have an unsent review on this PR on GitHub, and GitHub allows one at a time. Submit or discard it on GitHub, then try again." },
  // unverified (H2): a Comment review with an empty body
  { kind: "body-required", match: /\bbody\b.*\b(blank|required|missing|empty)|\b(blank|missing|empty)\b.*\bbody\b/i, error: "GitHub needs a summary for this review. Add a line, then post again." },
  // unverified (H2): a comment outside the diff, and whether it fails the whole review
  { kind: "outside-diff", match: /must be part of the (diff|same hunk)|could not be resolved|diff_hunk/i, error: "GitHub couldn't place a comment: its line isn't part of the PR's changes, so nothing was posted. Move it into the summary, then post again." },
  // unverified (H2): reviews and merges on a closed or merged PR
  { kind: "closed", match: /pull request is closed|(already|was) merged|already closed/i, error: "This PR is already closed or merged on GitHub, so nothing changed." },
  // unverified (H2): --match-head-commit on a moved head
  { kind: "head-moved", match: /head branch was modified|head commit .*(does not|doesn't) match/i, error: "The PR has commits you haven't reviewed, so GitHub didn't merge it. Review them, then merge again." },
  // unverified (H2): merge conflicts
  { kind: "conflicts", match: /merge commit cannot be cleanly created|merge conflict/i, error: "GitHub can't merge this PR: its branch has conflicts with the base branch. Resolve them on the branch, then merge again." },
  // unverified (H2): a branch the repo requires to be up to date
  { kind: "not-up-to-date", match: /head branch is not up to date|not up to date with the base/i, error: "GitHub can't merge this PR yet: the repo requires its branch to be up to date with the base branch. Update the branch, then merge again." },
  // unverified (H2): auto-merge off for the repo
  { kind: "auto-merge-off", match: /auto-?merge is not allowed|auto merge is not allowed|enablePullRequestAutoMerge/i, error: "This repo doesn't allow auto-merge. Merge it once its checks pass, or ask a maintainer to turn on Allow auto-merge." },
  // unverified (H2): pending checks or reviews without --auto
  { kind: "not-mergeable", match: /not mergeable|base branch policy prohibits/i, error: "GitHub can't merge this PR yet: required checks or reviews haven't passed. Merge it automatically once they do?" },
  // unverified (H2): a classic token without a scope, such as read:org for team reviewers
  { kind: "missing-scope", match: /organization teams|required scopes?|not been granted|needs the "[^"]+" scope/i, error: (text) => {
    const scope = text.match(/scopes? \[([^\]]+)\]/i)?.[1] ?? text.match(/needs the "([^"]+)" scope/i)?.[1] ?? (/organization teams/i.test(text) ? "read:org" : undefined);
    return scope
      ? `The GitHub login on the BB server is missing the ${scope} scope. Run gh auth refresh -h github.com -s ${scope.replace(/\s+/g, "")} there, then try again.`
      : "The GitHub login on the BB server is missing a scope this needs. Run gh auth status there to see its scopes.";
  } },
  // unverified (H2): SAML single sign-on refusals
  { kind: "sso", match: /SAML|single sign-on/i, error: "This organization requires single sign-on, and the GitHub login on the BB server isn't authorized for it. Authorize it on GitHub, then try again." },
  // unverified (H2): a token that can't reach the repo
  { kind: "token", match: /not accessible by (personal access token|integration)/i, error: "The GitHub token on the BB server isn't allowed to do this on this repo. Give it access, or sign in again with gh auth login, then try again." },
  // unverified (H2): role refusals beyond HTTP 403
  { kind: "forbidden", match: /must have (admin|push|write|maintain)|does not have (the correct )?permissions?|\bFORBIDDEN\b/i, error: (_, action) => forbidden(action) },
];
const forbidden = (action?: WriteAction) => `Your GitHub role on this repo doesn't allow that. ${action === "review" ? "Leave a comment instead?" : "Ask someone with write access to do it."}`;

/** A write GitHub refused, or that couldn't go yet: what happened and what to do (`error`), and GitHub's own words (`detail`). */
export interface WriteRefusal { ok: false; kind: string; error: string; detail: string }

/** `args` is the write's gh command, to read its refusal from; `action` words a refusal for a missing role. */
export function classifyWriteError(result: { code?: number; stdout: string; stderr: string }, { args = ["api"], action }: { args?: string[]; action?: WriteAction } = {}): WriteRefusal {
  const detail = ghErrorMessage(result);
  if (result.code === 124) return { ok: false, kind: "timeout", error: "GitHub didn't answer in time. It may have posted; check before sending again.", detail };
  const refusal = refusalOf(args, result);
  if (rateLimited(args, refusal)) return limited(detail);
  const known = REFUSALS.find(({ match }) => match.test(refusal.text));
  if (known) return { ok: false, kind: known.kind, error: typeof known.error === "string" ? known.error : known.error(refusal.text, action), detail };
  if (refusal.status === 403) return { ok: false, kind: "forbidden", error: forbidden(action), detail };
  return { ok: false, kind: "other", error: detail, detail };
}
/** A refusal as one line for the page: the words to act on, then GitHub's, when there are any of its own. */
export function refusalText(refusal: WriteRefusal): string {
  return !refusal.detail || refusal.error === refusal.detail ? refusal.error : `${refusal.error} (GitHub: ${refusal.detail})`;
}

/** What GitHub lets the account do on a PR, read just before a write: never by the threads query every page reads. */
export interface WriteFacts {
  viewer: string;
  author: string | null;
  /** ADMIN, MAINTAIN, WRITE, TRIAGE or READ; null when GitHub didn't say. */
  permission: string | null;
  state: "OPEN" | "CLOSED" | "MERGED";
  headSha: string;
  thread?: { canReply: boolean; canResolve: boolean; canUnresolve: boolean };
}

export async function readWriteFacts(run: Run, repo: string, number: number, threadId?: string): Promise<WriteFacts | { error: string }> {
  const [owner, name] = repo.split("/");
  const query = `query($owner:String!,$repo:String!,$number:Int!${threadId ? ",$thread:ID!" : ""}){ viewer{login}
    repository(owner:$owner,name:$repo){ viewerPermission pullRequest(number:$number){ state headRefOid author{login} } }
    ${threadId ? "node(id:$thread){ ... on PullRequestReviewThread { viewerCanReply viewerCanResolve viewerCanUnresolve } }" : ""} }`;
  const r = await run(["api", "graphql", "-f", `query=${query}`, "-f", `owner=${owner}`, "-f", `repo=${name}`, "-F", `number=${number}`, ...(threadId ? ["-f", `thread=${threadId}`] : [])]);
  let data: any;
  try { data = JSON.parse(r.stdout)?.data; } catch { /* reported below */ }
  const pr = data?.repository?.pullRequest;
  if (r.code !== 0 || !pr || typeof data?.viewer?.login !== "string") return { error: `Couldn't check what GitHub lets you do on this PR: ${ghErrorMessage(r)}` };
  const node = data.node;
  return {
    viewer: data.viewer.login, author: pr.author?.login ?? null, permission: data.repository.viewerPermission ?? null, state: pr.state, headSha: pr.headRefOid,
    ...(threadId && node ? { thread: { canReply: !!node.viewerCanReply, canResolve: !!node.viewerCanResolve, canUnresolve: !!node.viewerCanUnresolve } } : {}),
  };
}

/** How the repo writes a merge's commit message, and the PR facts it's made from; a setting GitHub didn't give is null. */
export interface MergeSettings {
  squashTitle: string | null; squashMessage: string | null; mergeTitle: string | null; mergeMessage: string | null;
  title: string; body: string; commits: number;
  /** The head branch as `owner/branch`, by the head repo's owner, as GitHub names a fork's. Null when unknown. */
  from: string | null;
}

/** The repo's merge commit settings and the PR's title, body, commits and head, in one read, just before a merge form shows. */
export async function readMergeSettings(run: Run, repo: string, number: number): Promise<MergeSettings | null> {
  const [owner, name] = repo.split("/");
  const query = `query($owner:String!,$repo:String!,$number:Int!){ repository(owner:$owner,name:$repo){
    squashMergeCommitTitle squashMergeCommitMessage mergeCommitTitle mergeCommitMessage
    pullRequest(number:$number){ title body headRefName headRepositoryOwner{login} commits{totalCount} } } }`;
  const r = await run(["api", "graphql", "-f", `query=${query}`, "-f", `owner=${owner}`, "-f", `repo=${name}`, "-F", `number=${number}`]);
  let data: any;
  // GitHub answers what it can, with errors beside it: a setting it withholds is null.
  try { data = JSON.parse(r.stdout)?.data; } catch { return null; }
  const repository = data?.repository;
  const pr = repository?.pullRequest;
  if (!pr || typeof pr.title !== "string") return null;
  const text = (value: unknown) => typeof value === "string" ? value : null;
  return {
    squashTitle: text(repository.squashMergeCommitTitle), squashMessage: text(repository.squashMergeCommitMessage), mergeTitle: text(repository.mergeCommitTitle), mergeMessage: text(repository.mergeCommitMessage),
    title: pr.title, body: text(pr.body) ?? "", commits: typeof pr.commits?.totalCount === "number" ? pr.commits.totalCount : 0,
    from: pr.headRepositoryOwner?.login && pr.headRefName ? `${pr.headRepositoryOwner.login}/${pr.headRefName}` : null,
  };
}

export type WriteAction = "comment" | "review" | "reply" | "resolve" | "unresolve" | "label" | "assign" | "request-review" | "close" | "reopen" | "edit" | "merge";
const ROLES = ["READ", "TRIAGE", "WRITE", "MAINTAIN", "ADMIN"];
/** The role GitHub requires: Triage for labels, assignees, review requests, close and reopen; Write to merge or edit another's PR. */
const NEEDS: Partial<Record<WriteAction, string>> = { label: "TRIAGE", assign: "TRIAGE", "request-review": "TRIAGE", close: "TRIAGE", reopen: "TRIAGE", merge: "WRITE" };
const ROLE_NAMES: Record<string, string> = { TRIAGE: "Triage", WRITE: "Write" };

/**
 * Why GitHub won't take this write from this account, as the one pushback, offering what it will take; null when
 * nothing stands in the way, or GitHub didn't say enough to tell, so its own answer decides.
 */
export function pushback(action: WriteAction, facts: WriteFacts, repo: string): string | null {
  const own = !!facts.author && facts.author.toLowerCase() === facts.viewer.toLowerCase();
  if (action === "merge" && facts.state !== "OPEN") return `This PR is already ${facts.state.toLowerCase()}, so there's nothing to merge.`;
  if (action === "close" && facts.state !== "OPEN") return `This PR is already ${facts.state.toLowerCase()}.`;
  if (action === "reopen" && facts.state !== "CLOSED") return facts.state === "MERGED" ? "This PR is merged, so it can't be reopened." : "This PR is already open.";
  if (action === "reply" && facts.thread && !facts.thread.canReply) return "GitHub won't let you reply on this thread; the conversation may be locked. Leave a PR comment instead?";
  if ((action === "resolve" && facts.thread && !facts.thread.canResolve) || (action === "unresolve" && facts.thread && !facts.thread.canUnresolve)) {
    return "GitHub lets only the PR's author or someone with write access resolve threads. Reply instead?";
  }
  const needs = action === "edit" && !own ? "WRITE" : NEEDS[action];
  const role = facts.permission ? ROLES.indexOf(facts.permission) : -1;
  if (!needs || role < 0 || role >= ROLES.indexOf(needs)) return null;
  return `That needs the ${ROLE_NAMES[needs]} role on ${repo}, which this account doesn't have. Suggest it in a comment instead?`;
}

/** GitHub takes up to 10 assignees a call. */
const ASSIGNEES_PER_CALL = 10;

/**
 * Assign people to the PR. GitHub drops anyone without push access without saying so, so the assignees are read back
 * and `ignored` lists who didn't stick. `@me` and `@copilot` aren't checked.
 */
export async function addAssignees(writes: GithubWrites, run: Run, repo: string, number: number, logins: string[]): Promise<{ ok: true; ignored: string[]; note?: string } | WriteRefusal> {
  for (let i = 0; i < logins.length; i += ASSIGNEES_PER_CALL) {
    const posted = await writes.post(run, ["pr", "edit", String(number), "-R", repo, "--add-assignee", logins.slice(i, i + ASSIGNEES_PER_CALL).join(",")], { action: "assign" });
    if (!posted.ok) return posted;
  }
  const read = await run(["pr", "view", String(number), "-R", repo, "--json", "assignees"]);
  let assigned: string[] | null = null;
  try { assigned = (JSON.parse(read.stdout).assignees as { login: string }[]).map((a) => a.login.toLowerCase()); } catch { /* unknown */ }
  if (read.code !== 0 || !assigned) return { ok: true, ignored: [], note: "GitHub took the assignees, but they couldn't be read back. Check the PR to see who stuck." };
  const ignored = logins.filter((login) => !login.startsWith("@") && !assigned.includes(login.toLowerCase()));
  if (!ignored.length) return { ok: true, ignored };
  const who = ignored.map((login) => `@${login}`).join(", ");
  return { ok: true, ignored, note: `GitHub didn't assign ${who}: only people with push access to ${repo} can be assigned.` };
}

/** `subject` and `body`: the merge or squash commit's message, as shown before merging; a rebase has none. */
export interface MergeOptions { headSha: string; method: "merge" | "squash" | "rebase"; auto?: boolean; deleteBranch?: boolean; subject?: string; body?: string }

/**
 * Merge the PR, only at the head that was reviewed. With `auto`, GitHub merges once checks and reviews pass. A merge
 * gh reports as failed is read back: GitHub's MERGED at that head wins, as `--delete-branch` can fail after the merge
 * went through; at another head, someone else merged it.
 */
export async function mergePr(writes: GithubWrites, run: Run, repo: string, number: number, options: MergeOptions): Promise<{ ok: true; merged: boolean; note?: string } | WriteRefusal> {
  const args = ["pr", "merge", String(number), "-R", repo, `--${options.method}`, "--match-head-commit", options.headSha,
    ...(options.subject !== undefined ? ["--subject", options.subject] : []), ...(options.body !== undefined ? ["--body", options.body] : []),
    ...(options.auto ? ["--auto"] : []), ...(options.deleteBranch ? ["--delete-branch"] : [])];
  const posted = await writes.post(run, args, { action: "merge" });
  const read = await run(["pr", "view", String(number), "-R", repo, "--json", "state,headRefOid"]);
  let pr: { state?: unknown; headRefOid?: unknown } = {};
  try { pr = JSON.parse(read.stdout) ?? {}; } catch { /* unknown */ }
  if (posted.ok) {
    // Left open, it's waiting: on auto-merge, or in the merge queue.
    const waiting = pr.state === "OPEN" || (pr.state !== "MERGED" && options.auto);
    return waiting ? { ok: true, merged: false, note: "GitHub will merge it once its checks and reviews pass." } : { ok: true, merged: true };
  }
  if (pr.state === "MERGED" && pr.headRefOid !== options.headSha) {
    return { ok: false, kind: "merged-elsewhere", error: "Someone else already merged this PR, at a commit you didn't review.", detail: posted.detail };
  }
  if (pr.state === "MERGED") return { ok: true, merged: true, ...(options.deleteBranch ? { note: "Merged, but gh couldn't confirm the branch was deleted. Check it on GitHub." } : {}) };
  return posted;
}

/** The scopes Code Review Workspace's writes need from a classic token: `repo`, and `read:org` for team reviewers. */
const NEEDED_SCOPES: { scope: string; covered: string[] }[] = [
  { scope: "repo", covered: ["repo"] },
  { scope: "read:org", covered: ["read:org", "write:org", "admin:org"] },
];

/**
 * The needed scopes the server's gh token lacks, read from GitHub's `X-OAuth-Scopes` header: none missing is [].
 * "unlisted" when GitHub didn't list them, as for fine-grained tokens; null when gh couldn't ask.
 */
export async function missingScopes(run: Run): Promise<string[] | "unlisted" | null> {
  const r = await run(["api", "-i", "user"]);
  if (r.code !== 0) return null;
  const { headers } = splitHeaders(r);
  if (!headers[":status"]) return null;
  const listed = headers["x-oauth-scopes"];
  if (listed === undefined) return "unlisted";
  const scopes = listed.split(",").map((s) => s.trim()).filter(Boolean);
  return NEEDED_SCOPES.filter(({ covered }) => !covered.some((s) => scopes.includes(s))).map(({ scope }) => scope);
}
