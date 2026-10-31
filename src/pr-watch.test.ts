// Watching a local review's branch for its PR (src/pr-watch.ts): a thread in the folder that pushes or opens a PR (T1),
// the poll every 2 minutes (T3), and the review's open page (T4) each find it, from a fork too, with one GitHub read for
// any number of reviews; Push's own read (T2) is in push.test.ts.
import { afterEach, expect, test, vi } from "vitest";
import { folderHost, type Folder } from "./env-diff.test-support";
import { testStore } from "./test-store.test-support";
import { featureKey } from "./targets";
import { pushedName, register } from "./pr-watch";
import type { SyncHealth } from "./review-lifecycle";

afterEach(() => { vi.useRealTimers(); });

const KEY = featureKey("env1", "feat/qa");
const OTHER = featureKey("env2", "feat/x");
const FOLDER_PATCH = "diff --git a/src/a.ts b/src/a.ts\nindex 1111111..3333333 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n";
const PR_DIFF = "diff --git a/src/a.ts b/src/a.ts\nindex 1111111..2222222 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n";
const ok = (stdout: string) => ({ code: 0, stderr: "", stdout });

/** The branches a read asks GitHub for, by name. */
const branchesIn = (query: string) => [...query.matchAll(/b\d+: repository\(owner:"acme",name:"api"\)\{ ref\(qualifiedName:"refs\/heads\/([^"]+)"\)/g)].map((match) => match[1]).sort();

type Node = { number: number; repo?: string; head?: string; createdAt?: string };
/**
 * GitHub as the watch reads it: each branch by `repo:branch`, its head and its open PRs, and those from it into the repo
 * the repo was forked from (`parent`); `fail` fails every read.
 */
interface Github { branches: Record<string, { sha: string | null; prs?: Node[]; parent?: Node[] }>; fail: boolean; heads: Record<number, string> }

/** A local review of feat/qa in `repo`, in env1 on MaxBook, made at T0; the watch registered on it; time stands at T0. */
async function setup({ repo = "acme/api", folder = {} as Partial<Folder> } = {}) {
  vi.useFakeTimers({ toFake: ["Date"] });
  const T0 = Date.parse("2026-10-30T12:00:00Z");
  vi.setSystemTime(T0);
  const github: Github = { branches: {}, fail: false, heads: {} };
  const node = ({ number, repo: base = "acme/api", head = repo, createdAt = "2026-10-30T12:05:00Z" }: Node) => ({
    number, url: `https://github.com/${base}/pull/${number}`, createdAt, baseRepository: { nameWithOwner: base }, headRepository: { nameWithOwner: head },
  });
  const runGh = vi.fn(async (args: string[]) => {
    if (args[0] === "api" && args[1] === "graphql") {
      if (github.fail) return { code: 1, stderr: "HTTP 502: Bad gateway", stdout: "" };
      const query = args.find((a) => a.startsWith("query="))!;
      const data: Record<string, unknown> = {};
      for (const [, i, owner, name, branch] of query.matchAll(/b(\d+): repository\(owner:"([^"]+)",name:"([^"]+)"\)\{ ref\(qualifiedName:"refs\/heads\/([^"]+)"\)/g)) {
        const found = github.branches[`${owner}/${name}:${branch}`];
        data[`b${i}`] = {
          ref: found?.sha ? { target: { oid: found.sha }, associatedPullRequests: { nodes: (found.prs ?? []).map(node) } } : null,
          parent: found?.parent ? { pullRequests: { nodes: found.parent.map(node) } } : null,
        };
      }
      return ok(JSON.stringify({ data }));
    }
    const number = Number(args[2]);
    const at = args.indexOf("-R");
    const base = at >= 0 ? args[at + 1] : "acme/api";
    if (args[0] === "pr" && args[1] === "view") return ok(JSON.stringify({ number, title: "Snooze flaky checks", author: { login: "me" }, baseRefName: "main", headRefName: github.heads[number] ?? "feat/qa", url: `https://github.com/${base}/pull/${number}`, headRefOid: "c0ffee", state: "OPEN", createdAt: "2026-10-30T12:05:00Z" }));
    if (args[0] === "pr" && args[1] === "diff") return ok(PR_DIFF);
    return { code: 1, stderr: "unexpected gh call", stdout: "" };
  });
  const reads = () => runGh.mock.calls.filter(([args]) => args[1] === "graphql").map(([args]) => args.find((a) => a.startsWith("query="))!);
  // Each thread's commands, as bb's events give them: run now, or at `at`.
  const commands: Record<string, Array<string | { command: string; at: number }>> = {};
  const list = vi.fn(async ({ threadId, afterSeq }: { threadId: string; afterSeq?: string }) => (commands[threadId] ?? [])
    .map((run, i) => typeof run === "string" ? { command: run, at: Date.now(), i } : { ...run, i })
    .map(({ command, at, i }) => ({ id: `e${i}`, seq: i + 1, threadId, scope: {}, createdAt: at, type: "item/completed", data: { item: { type: "commandExecution", id: `i${i}`, command, cwd: "/Users/me/src/api", status: "completed" } } }))
    .filter((row) => afterSeq === undefined || row.seq > Number(afterSeq)));
  const host = folderHost({ files: [{ path: "src/a.ts" }], ...folder }, { threads: { events: { list } } });
  const store = testStore(host.bb);
  const review = async (key: string, environmentId: string, branch: string) => {
    await store.saveReview({ targetKey: key, kind: "ref", gitRef: branch, title: "Snooze flaky checks", createdAt: T0, status: "ready", projectId: "proj_api" });
    await store.setLifecycle(key, { feature: { environmentId, hostId: "host_max", machine: "MaxBook", path: "/Users/me/src/api", branch, baseRef: "main", repo }, mainThread: { threadId: "main", environmentId, origin: "adopted", since: 1 } });
    await store.savePatch(key, FOLDER_PATCH);
  };
  await review(KEY, "env1", "feat/qa");
  let health: SyncHealth = { lastReadAt: null, error: null };
  const deps = { bb: host.bb, store, gh: { runGh, runGit: vi.fn() }, changed: vi.fn(), sync: { one: vi.fn(async () => {}), health: () => health } };
  const watch = register(deps as any);
  const emit = (event: "experimental_thread.events" | "thread.idle" | "thread.failed", thread: { id: string; environmentId: string | null; visibility?: string }) =>
    (watch.events[event]![0] as (payload: unknown) => Promise<void>)({ thread: { visibility: "visible", ...thread }, sequence: 1, lastAssistantText: null });
  const kind = async (key = KEY) => (await store.getReview(key))?.kind;
  return { ...host, store, github, runGh, reads, commands, list, review, watch, emit, kind, deps, at: (seconds: number) => vi.setSystemTime(T0 + seconds * 1000), unhealthy: (next: SyncHealth["error"]) => { health = { lastReadAt: null, error: next }; } };
}

test("T1: a thread in the folder that opens a PR makes the review the PR's at once; other commands, hidden threads and other folders read no GitHub", async () => {
  const s = await setup();
  s.commands.coder = ["npm test", "git status"];
  await s.emit("experimental_thread.events", { id: "coder", environmentId: "env1" });
  expect(s.list).toHaveBeenCalledWith({ threadId: "coder", types: ["item/completed"], limit: "100", order: "desc" });
  // Hidden, it's one of the plugin's own; in another folder, no review watches it.
  s.commands.agent = ["gh pr create --fill"];
  await s.emit("thread.idle", { id: "agent", environmentId: "env1", visibility: "hidden" });
  s.commands.elsewhere = ["gh pr create --fill"];
  await s.emit("thread.idle", { id: "elsewhere", environmentId: "env9" });
  expect(s.list.mock.calls.map(([args]) => args.threadId)).toEqual(["coder"]);
  expect(s.reads()).toEqual([]);

  // Its next commands, from where the last read stopped.
  s.github.branches["acme/api:feat/qa"] = { sha: "c0ffee", prs: [{ number: 7 }] };
  s.commands.coder.push("gh pr create --draft --title 'Snooze flaky checks'");
  await s.emit("experimental_thread.events", { id: "coder", environmentId: "env1" });
  expect(s.list).toHaveBeenLastCalledWith({ threadId: "coder", types: ["item/completed"], limit: "100", afterSeq: "2", order: "asc" });
  expect(s.reads()).toHaveLength(1);
  expect(await s.store.getReview(KEY)).toMatchObject({ kind: "pr", repo: "acme/api", number: 7, ownPr: true, became: { number: 7, from: "api:feat/qa" } });
  expect(await s.store.patch(KEY)).toBe(PR_DIFF);
  expect(s.deps.sync.one).toHaveBeenCalledWith(KEY, true);
  // Once it's the PR's, nothing is watched.
  s.commands.coder.push("git push");
  await s.emit("thread.idle", { id: "coder", environmentId: "env1" });
  expect(s.reads()).toHaveLength(1);
});

test("T1: a thread that pushed under another name, then failed, makes the review its PR's through PR Status's PR for the folder", async () => {
  const s = await setup({ folder: { prBase: "main", pr: { number: 7, url: "https://github.com/acme/api/pull/7", headRefName: "feat/nice", state: "draft" } } });
  s.github.heads[7] = "feat/nice";
  // GitHub has no feat/qa: the folder's upstream is feat/nice.
  s.commands.other = ["git push -u origin HEAD:feat/nice"];
  await s.emit("thread.failed", { id: "other", environmentId: "env1" });
  expect(await s.store.getReview(KEY)).toMatchObject({ kind: "pr", number: 7, head: "feat/nice", feature: { branch: "feat/qa", remoteBranch: "feat/nice" } });
});

test("T1: a thread on a branch whose upstream is another branch's, with that branch's PR, leaves the review waiting for your click", async () => {
  // `git switch -c feat/qa origin/part1`: PR Status names part1's PR until feat/qa's first push -u.
  const s = await setup({ folder: { prBase: "main", pr: { number: 7, url: "https://github.com/acme/api/pull/7", headRefName: "part1", state: "open" } } });
  s.github.heads[7] = "part1";
  s.commands.other = ["git push origin HEAD:part1-wip", "gh pr create --fill"];
  await s.emit("thread.idle", { id: "other", environmentId: "env1" });
  expect(await s.store.getReview(KEY)).toMatchObject({ kind: "ref", prPending: { number: 7, why: "branch", head: "part1" }, feature: { pushedAs: "part1-wip" } });
});

// `git switch -c feat/qa origin/part1` after part1's thread pushed it and opened its PR: that history isn't this review's.
test("T1: a push or a new PR from before the review names no branch it was pushed as, so another branch's PR waits for your click, after a restart too", async () => {
  const s = await setup({ folder: { prBase: "main", pr: { number: 7, url: "https://github.com/acme/api/pull/7", headRefName: "part1", state: "open" } } });
  s.github.heads[7] = "part1";
  s.github.branches["acme/api:part1"] = { sha: "c0ffee", prs: [{ number: 7 }] };
  const before = Date.now() - 60 * 60_000;
  s.commands.part1 = [{ command: "git push origin HEAD:part1", at: before }, { command: "gh pr create --head part1 --fill", at: before }, "npm test"];
  s.commands.coder = ["gh pr create --fill"];
  await s.emit("thread.idle", { id: "part1", environmentId: "env1" });
  await s.emit("thread.idle", { id: "coder", environmentId: "env1" });
  const waiting = (await s.store.getReview(KEY))!;
  expect(waiting).toMatchObject({ kind: "ref", prPending: { number: 7, why: "branch", head: "part1" } });
  expect(waiting.feature?.pushedAs).toBeUndefined();
  expect(s.reads().map(branchesIn)).toEqual([["feat/qa"]]);
  // Not this one, then a restart: its threads are read from their latest commands again.
  await s.store.setLifecycle(KEY, { prPending: { ...waiting.prPending!, declined: true } });
  const restarted = register(s.deps as any);
  s.at(60);
  for (const id of ["part1", "coder"]) await (restarted.events["thread.idle"]![0] as (payload: unknown) => Promise<void>)({ thread: { id, environmentId: "env1", visibility: "visible" }, sequence: 1, lastAssistantText: null });
  expect(await s.store.getReview(KEY)).toMatchObject({ kind: "ref", prPending: { number: 7, why: "branch", declined: true } });
  expect((await s.store.getReview(KEY))?.feature?.pushedAs).toBeUndefined();
});

test("T1: git -C <dir> push, /usr/bin/git push, jj git push and gh stack push or submit each read the branch at once and have the poll read it again", async () => {
  const pushes = ["git -C ~/src/api push -u origin HEAD", "/usr/bin/git push", "jj git push --bookmark feat/qa", "gh stack push", "/bin/zsh -lc \"gh stack submit\""];
  for (const command of pushes) {
    const s = await setup();
    // feat/qa isn't on GitHub: the poll waits 10 minutes, until a thread pushes.
    await s.watch.poll();
    s.github.branches["acme/api:feat/qa"] = { sha: "c0ffee", prs: [] };
    s.at(10);
    s.commands.coder = [command];
    await s.emit("thread.idle", { id: "coder", environmentId: "env1" });
    expect(s.reads()).toHaveLength(2);
    s.github.branches["acme/api:feat/qa"] = { sha: "c0ffee", prs: [{ number: 7 }] };
    s.at(120);
    await s.watch.poll();
    expect(s.reads()).toHaveLength(3);
    expect(await s.kind()).toBe("pr");
  }
});

test("T1: a push under another name with no upstream reads that name on GitHub, at once and in the poll, and its PR makes the review its own", async () => {
  const s = await setup();
  s.github.heads[7] = "feat/nice";
  s.github.branches["acme/api:feat/nice"] = { sha: "c0ffee", prs: [] };
  s.commands.coder = ["git push origin HEAD:feat/nice"];
  await s.emit("thread.idle", { id: "coder", environmentId: "env1" });
  expect(s.reads().map(branchesIn)).toEqual([["feat/nice", "feat/qa"]]);
  expect(await s.kind()).toBe("ref");
  s.github.branches["acme/api:feat/nice"] = { sha: "c0ffee", prs: [{ number: 7 }] };
  s.at(120);
  await s.watch.poll();
  expect(s.reads().map(branchesIn)[1]).toEqual(["feat/nice", "feat/qa"]);
  expect(await s.store.getReview(KEY)).toMatchObject({ kind: "pr", number: 7, head: "feat/nice", feature: { branch: "feat/qa", remoteBranch: "feat/nice" } });
});

test("T1: a thread that pushes the branch under its own name, without a colon, drops the other name it had pushed it as", async () => {
  for (const command of ["git push -u origin feat/qa", "git push origin HEAD"]) {
    const s = await setup();
    const { feature } = (await s.store.getReview(KEY))!;
    await s.store.setLifecycle(KEY, { feature: { ...feature!, pushedAs: "feat/nice" } });
    s.commands.coder = [command];
    await s.emit("thread.idle", { id: "coder", environmentId: "env1" });
    expect((await s.store.getReview(KEY))?.feature?.pushedAs, command).toBeUndefined();
    // Its next read asks GitHub for that name alone.
    expect(s.reads().map(branchesIn), command).toEqual([["feat/qa"]]);
  }
});

test("T1: a thread's push reads nothing while GitHub limits reads or gh isn't signed in, nor within 5 seconds of its last read", async () => {
  const s = await setup();
  s.github.branches["acme/api:feat/qa"] = { sha: "c0ffee", prs: [] };
  s.unhealthy({ kind: "rate-limit", at: 0, retryAt: Date.now() + 60_000 });
  s.commands.coder = ["git push"];
  await s.emit("thread.idle", { id: "coder", environmentId: "env1" });
  s.unhealthy({ kind: "auth", at: 0 });
  s.commands.coder.push("git push");
  await s.emit("thread.idle", { id: "coder", environmentId: "env1" });
  expect(s.reads()).toEqual([]);
  s.unhealthy(null);
  s.commands.coder.push("git push");
  await s.emit("thread.idle", { id: "coder", environmentId: "env1" });
  expect(s.reads()).toHaveLength(1);
  s.at(3);
  s.commands.coder.push("gh pr create --fill");
  await s.emit("thread.idle", { id: "coder", environmentId: "env1" });
  expect(s.reads()).toHaveLength(1);
  s.at(6);
  s.commands.coder.push("gh pr create --fill");
  await s.emit("thread.idle", { id: "coder", environmentId: "env1" });
  expect(s.reads()).toHaveLength(2);
});

test("pushedName: the name a push or a new PR gives the branch on GitHub, never a remote's URL or a deleted branch", () => {
  expect(pushedName("/bin/zsh -lc \"git push -u origin HEAD:feat/nice\"")).toEqual({ from: null, as: "feat/nice" });
  expect(pushedName("git -C ~/src/api push origin part2:refs/heads/feat/nice && gh pr create")).toEqual({ from: "part2", as: "feat/nice" });
  expect(pushedName("gh pr create --head me:feat/nice --fill")).toEqual({ from: null, as: "feat/nice" });
  expect(pushedName("git push https://github.com/acme/api HEAD:feat/x")).toEqual({ from: null, as: "feat/x" });
  // Under its own name: the folder's (HEAD), or the branch it names.
  expect(pushedName("git push -u origin HEAD")).toEqual({ from: null, as: null });
  expect(pushedName("git push --force-with-lease -o ci.skip origin +refs/heads/feat/qa")).toEqual({ from: "feat/qa", as: "feat/qa" });
  for (const none of ["git push git@github.com:acme/api.git", "git push origin :old", "git push", "git push -u origin", "git push origin refs/tags/v1", "jj git push --bookmark feat/qa", "gh stack push", "npm test"]) expect(pushedName(none)).toBeNull();
});

test("forks: a fork's branch finds its PR in the repo it was forked from, never another fork's PR from a branch of the same name", async () => {
  const s = await setup({ repo: "me/api" });
  s.github.branches["me/api:feat/qa"] = { sha: "c0ffee", prs: [], parent: [{ number: 9, head: "you/api", createdAt: "2026-10-30T12:09:00Z" }, { number: 7, head: "me/api" }] };
  s.commands.coder = ["gh pr create --repo acme/api"];
  await s.emit("thread.idle", { id: "coder", environmentId: "env1" });
  expect(await s.store.getReview(KEY)).toMatchObject({ kind: "pr", repo: "acme/api", number: 7, url: "https://github.com/acme/api/pull/7" });
});

test("T3: the poll reads every local review in one request every 2 minutes; a branch not on GitHub waits 10 minutes, until a thread pushes", async () => {
  const s = await setup();
  await s.review(OTHER, "env2", "feat/x");
  s.github.branches["acme/api:feat/x"] = { sha: "beef", prs: [] };
  await s.watch.poll();
  expect(s.reads()).toHaveLength(1);
  expect(branchesIn(s.reads()[0]!)).toEqual(["feat/qa", "feat/x"]);
  // Not yet 2 minutes.
  s.at(60);
  await s.watch.poll();
  expect(s.reads()).toHaveLength(1);
  // feat/qa isn't on GitHub: only feat/x is read.
  s.at(120);
  await s.watch.poll();
  expect(s.reads()).toHaveLength(2);
  expect(branchesIn(s.reads()[1]!)).toEqual(["feat/x"]);
  // A thread in its folder pushes: it's read at once, and polled again.
  s.github.branches["acme/api:feat/qa"] = { sha: "c0ffee", prs: [] };
  s.commands.coder = ["git push -u origin feat/qa"];
  await s.emit("thread.idle", { id: "coder", environmentId: "env1" });
  expect(s.reads()).toHaveLength(3);
  // Then GitHub opens its PR, which the next poll finds.
  s.github.branches["acme/api:feat/qa"] = { sha: "c0ffee", prs: [{ number: 7 }] };
  s.at(240);
  await s.watch.poll();
  expect(branchesIn(s.reads()[3]!)).toEqual(["feat/qa", "feat/x"]);
  expect(await s.kind()).toBe("pr");
  expect(await s.kind(OTHER)).toBe("ref");
});

test("T3: a review kept apart from one PR's review is still watched for the branch's next PR", async () => {
  const s = await setup();
  await s.store.setLifecycle(KEY, { mergeDeclined: "pr:acme/api#6" });
  s.github.branches["acme/api:feat/qa"] = { sha: "c0ffee", prs: [{ number: 7 }] };
  await s.watch.poll();
  expect(await s.store.getReview(KEY)).toMatchObject({ kind: "pr", number: 7 });
});

test("T3: the poll waits while GitHub limits reads or gh isn't signed in, and 10 minutes after a read that failed", async () => {
  const s = await setup();
  s.github.branches["acme/api:feat/qa"] = { sha: "c0ffee", prs: [] };
  s.unhealthy({ kind: "rate-limit", at: 0, retryAt: Date.now() + 60_000 });
  await s.watch.poll();
  // A limit GitHub gave no time for is a limit too.
  s.unhealthy({ kind: "rate-limit", at: 0 });
  await s.watch.poll();
  s.unhealthy({ kind: "auth", at: 0 });
  await s.watch.poll();
  expect(s.reads()).toEqual([]);
  s.unhealthy({ kind: "partial", at: 0, count: 1 });
  s.github.fail = true;
  await s.watch.poll();
  expect(s.reads()).toHaveLength(1);
  s.github.fail = false;
  s.at(5 * 60);
  await s.watch.poll();
  expect(s.reads()).toHaveLength(1);
  s.at(10 * 60);
  await s.watch.poll();
  expect(s.reads()).toHaveLength(2);
});

test("T4: the page's check reads GitHub at most once every 25 seconds per review, never twice at once, and not within 15 seconds of a thread's", async () => {
  const s = await setup();
  s.github.branches["acme/api:feat/qa"] = { sha: "c0ffee", prs: [] };
  const check = () => s.watch.handlers.checkPr({ targetKey: KEY });
  expect(await Promise.all([check(), check()])).toEqual([{ ok: true }, { ok: true }]);
  expect(s.reads()).toHaveLength(1);
  s.at(20);
  await check();
  expect(s.reads()).toHaveLength(1);
  // A thread's push reads at once; the page's check just after it doesn't read again.
  s.at(30);
  s.commands.coder = ["git push"];
  await s.emit("thread.idle", { id: "coder", environmentId: "env1" });
  expect(s.reads()).toHaveLength(2);
  s.at(40);
  await check();
  expect(s.reads()).toHaveLength(2);
  s.github.branches["acme/api:feat/qa"] = { sha: "c0ffee", prs: [{ number: 7 }] };
  s.at(70);
  await check();
  expect(s.reads()).toHaveLength(3);
  expect(await s.kind()).toBe("pr");
});

test("T4: the page's check waits, as the poll does, while GitHub limits reads or gh isn't signed in, and 10 minutes after finding the branch not on GitHub", async () => {
  const s = await setup();
  const check = () => s.watch.handlers.checkPr({ targetKey: KEY });
  const errors = [{ kind: "rate-limit", at: 0, retryAt: Date.now() + 5 * 60_000 }, { kind: "rate-limit", at: 0 }, { kind: "auth", at: 0 }] as const;
  for (const [i, error] of errors.entries()) {
    s.at(i * 30);
    s.unhealthy(error);
    await check();
  }
  expect(s.reads()).toEqual([]);
  s.unhealthy(null);
  // feat/qa isn't on GitHub.
  s.at(90);
  await check();
  expect(s.reads()).toHaveLength(1);
  s.at(5 * 60);
  await check();
  expect(s.reads()).toHaveLength(1);
  s.at(12 * 60);
  await check();
  expect(s.reads()).toHaveLength(2);
});

test("a thread's events in a folder no review watches read the reviews once in a while, not at each event; a thread's place is dropped once its folder's review isn't watched", async () => {
  const s = await setup();
  const listed = vi.spyOn(s.store, "listReviews");
  for (let i = 0; i < 5; i++) await s.emit("experimental_thread.events", { id: "elsewhere", environmentId: "env9" });
  expect(listed).toHaveBeenCalledTimes(1);
  s.at(10);
  await s.emit("experimental_thread.events", { id: "elsewhere", environmentId: "env9" });
  expect(listed).toHaveBeenCalledTimes(2);
  // Read from where it stopped while the review watches its folder; from its latest commands once it watches it again.
  s.commands.coder = ["npm test"];
  await s.emit("thread.idle", { id: "coder", environmentId: "env1" });
  await s.store.setLifecycle(KEY, { archivedAt: 1 });
  s.at(20);
  await s.emit("thread.idle", { id: "coder", environmentId: "env1" });
  await s.store.setLifecycle(KEY, { archivedAt: null });
  s.at(30);
  await s.emit("thread.idle", { id: "coder", environmentId: "env1" });
  expect(s.list.mock.calls.map(([args]) => (args as { order?: string }).order)).toEqual(["desc", "desc"]);
});

test("a thread's idle in a new review's folder reads the reviews again, within 5 seconds of a read that didn't have it, so its gh pr create is found at once", async () => {
  const s = await setup();
  await s.emit("experimental_thread.events", { id: "elsewhere", environmentId: "env2" });
  await s.review(OTHER, "env2", "feat/x");
  s.github.branches["acme/api:feat/x"] = { sha: "c0ffee", prs: [{ number: 8 }] };
  s.commands.coder2 = ["gh pr create --fill"];
  s.at(2);
  await s.emit("thread.idle", { id: "coder2", environmentId: "env2" });
  expect(s.reads().map(branchesIn)).toEqual([["feat/x"]]);
});
