// Push (src/push.ts): the main thread commits what you reviewed and reports the commit; the review checks it against
// what you reviewed, hidden files too, before the thread is told to push exactly it, never forced; a mismatch warns and
// waits for Push anyway. When the thread stops, GitHub is read: a branch not at the commit, or one that moved with no
// Push, is flagged. Only you, in the review, start a push; the plugin runs no git.
import { expect, test, vi } from "vitest";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { toolFailed, toolText } from "./fake-host.test-support";

const runGh = vi.hoisted(() => vi.fn());
const runGit = vi.hoisted(() => vi.fn());
vi.mock("./gh", async (orig) => ({ ...(await orig<any>()), runGh, runGit }));
vi.mock("./store-queue", async (original) => {
  const actual = await original<typeof import("./store-queue")>();
  return { ...actual, queueStore: vi.fn(actual.queueStore) };
});

import { BASE_SHA, folderHost } from "./env-diff.test-support";
import { agentChat } from "./agent-chat.test-support";
import { sendToAgent } from "./asking";
import { startPlugin } from "./plugin-store.test-support";
import { featureKey } from "./targets";
import { diffFilesHead } from "./env-diff";
import { pushCommand } from "../lib/push";

const KEY = featureKey("env1", "feat/qa");
const PATCH = "diff --git a/src/a.ts b/src/a.ts\nindex 1111111..2222222 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n";
const HEAD = "abc1234def5678abc1234def5678abc1234def56";
const OTHER = "f00dbabef00dbabef00dbabef00dbabef00dbabe";
const PR_HEAD = "9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e";
const OLD = "0ld0000000000000000000000000000000000000".replace(/l/g, "1");
/** The files the review read, as bb's revisions: a.ts shown, .env kept out by the secrets filter. */
const REVIEWED = { "src/a.ts": "100644:aaa:100644:bbb", ".env": "000000:000:100644:eee" };
const ok = (stdout = "") => ({ stdout, stderr: "", code: 0 });

/**
 * A local review of feat/qa in acme/api, in env1 on MaxBook, whose main thread is `coder` (with a subagent `sub`); the
 * review agent is `agent`. `folder` is what bb's Git plugin says of the folder: its head, whether it has changes not
 * committed, and what its branch commits; `github` is the branch's head on GitHub.
 */
async function setup({ branch = "feat/qa", workBranch, pr }: { branch?: string; workBranch?: string; pr?: { fork?: string } } = {}) {
  // Your PR, acme/api#12 from feat/qa, at PR_HEAD, with a fixer, "fixer", in its own worktree, env1, on its own branch.
  const key = pr ? "pr-12" : KEY;
  const base = pr ? PR_HEAD : BASE_SHA;
  const main = pr ? "fixer" : "coder";
  runGh.mockReset();
  runGit.mockReset();
  const folder = {
    head: HEAD, dirty: true, committed: { ...REVIEWED, ".env": undefined } as Record<string, string | undefined>,
    // The branch's commits since the review's base, oldest first, each with what it changed.
    commits: [{ sha: HEAD, files: { "src/a.ts": "modified" } }] as Array<{ sha: string; files: Record<string, string> }>,
    // GitHub's head has commits the folder doesn't.
    behind: false,
    // On your PR, what Not pushed yet reads: the fixer's folder against the PR's head.
    shown: { "src/a.ts": REVIEWED["src/a.ts"] } as Record<string, string>,
    // Asked about GitHub's head, BB can't read the folder, as when its machine sleeps.
    unreadable: false,
  };
  const github: { sha: string | null } = { sha: OLD };
  runGh.mockImplementation(async (args: string[]) => {
    if (args[0] === "api" && args[1] === "graphql" && args.some((a) => a.includes("ref(qualifiedName"))) {
      return ok(JSON.stringify({ data: { repository: { ref: github.sha ? { target: { oid: github.sha } } : null } } }));
    }
    if (args[0] === "api" && args[1] === "graphql" && args.some((a) => a.includes("pullRequest(number"))) {
      expect(args).toContain("n=12");
      return ok(JSON.stringify({ data: { repository: { pullRequest: { headRefOid: github.sha } } } }));
    }
    return { stdout: "", stderr: "not here", code: 1 };
  });
  const chat = agentChat("agent");
  const sent: any[] = [];
  const { bb, harness, calls } = folderHost({
    files: [{ path: "src/a.ts" }],
    env: { branchName: pr ? "bb/fixes-thr_fix" : workBranch ?? branch },
    answers: {
      workspaceStatus: (input) => folder.unreadable && input.mergeBaseBranch && input.mergeBaseBranch !== base ? { outcome: "unavailable", failure: { code: "host_offline", message: "MaxBook is asleep" } } : ({ outcome: "available", workspace: {
        workingTree: { hasUncommittedChanges: folder.dirty, fileCount: folder.dirty ? 1 : 0 }, checkout: { kind: "branch", headSha: folder.head },
        // Against the review's base, the branch's commits; against GitHub's head, whether GitHub has commits the folder doesn't.
        mergeBase: !input.mergeBaseBranch ? null : input.mergeBaseBranch === base ? { aheadCount: folder.commits.length, behindCount: folder.behind ? 2 : 0, commits: folder.commits.map(({ sha }) => ({ sha })) }
          : { aheadCount: 1, behindCount: folder.behind ? 2 : 0, commits: [] },
      } }),
      files: (input) => {
        if (input.target.type === "commit") {
          const commit = folder.commits.find((c) => c.sha === input.target.sha)!;
          return { outcome: "available", truncated: false, files: Object.entries(commit.files).map(([path, changeKind]) => ({ path, revision: "r", changeKind })) };
        }
        if (input.target.type === "all") {
          const files = Object.entries(folder.shown).map(([path, revision]) => ({ path, previousPath: null, changeKind: "modified", binary: false, origin: "tracked", loadMode: "auto", revision }));
          return { outcome: "available", truncated: false, mergeBaseRef: input.target.mergeBaseBranch, files, initialPatches: files.map(({ path }) => ({ path, patch: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-a\n+b\n`, truncated: false })) };
        }
        expect(input.target).toEqual({ type: "branch_committed", mergeBaseBranch: base });
        return { outcome: "available", truncated: false, files: Object.entries(folder.committed).flatMap(([path, revision]) => revision ? [{ path, revision }] : []) };
      },
    },
  }, { threads: {
    get: async ({ threadId }: { threadId: string }) => ({ id: threadId, archivedAt: null, deletedAt: null, status: "idle", title: threadId === "coder" ? "Snooze flaky checks" : threadId, environmentId: "env1", visibility: threadId === "agent" ? "hidden" : "visible" }),
    ...chat.sdk,
    send: async (args: any) => { if (args.threadId === "agent") return chat.sdk.send(args); sent.push(args); return { ok: true, delivery: "sent" }; },
    list: async () => [],
    experimental_listAncestors: async ({ threadIds }: { threadIds: string[] }) => ({ threads: threadIds.map((id) => ({ threadId: id, ancestorIds: id === "sub" ? ["coder"] : [] })) }),
  } });
  const store = await startPlugin(bb);
  if (pr) {
    await store.saveReview({ targetKey: key, kind: "pr", repo: "acme/api", number: 12, head: branch, base: "main", headSha: PR_HEAD, title: "Snooze flaky checks", createdAt: 1, status: "ready", projectId: "proj_api" });
    await store.setLifecycle(key, { ownPr: true, ...pr.fork ? { headFork: pr.fork } : { headFork: null }, mainThread: { threadId: "fixer", environmentId: "env1", origin: "fresh", since: 1, branch: "bb/fixes-thr_fix", fixer: { sha: PR_HEAD, at: 1 } } });
    await store.savePatch(key, PATCH);
  } else {
    await store.saveReview({ targetKey: KEY, kind: "ref", gitRef: branch, title: "Snooze flaky checks", createdAt: 1, status: "ready", projectId: "proj_api" });
    await store.setLifecycle(KEY, {
      feature: { environmentId: "env1", hostId: "host_max", machine: "MaxBook", path: "/Users/me/src/api", branch, baseRef: "main", mergeBaseRef: BASE_SHA, repo: "acme/api", ...workBranch ? { workBranch } : {} },
      mainThread: { threadId: "coder", environmentId: "env1", origin: workBranch ? "fresh" : "adopted", since: 1 },
    });
    await store.savePatch(KEY, PATCH);
    await store.saveSnapshotFiles(KEY, diffFilesHead(await store.patchHash(KEY)), { revisions: REVIEWED, hidden: [{ path: ".env", reason: "secret" }] });
  }
  await store.setAssistantThread(key, "agent");

  const cli = (threadId: string, ...argv: string[]) => harness.behavior.runCli(argv, { threadId, projectId: "proj_api" });
  const idle = (threadId = main, queuedMessageCount = 0) => harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: threadId, queuedMessageCount }), lastAssistantText: null });
  const run = async () => (await store.getReview(key))!.push;
  // Push, or Push anyway on the warning the page shows now, unless `at` says another.
  const push = async (force?: boolean, sha?: string, at?: number) => harness.behavior.callRpc("push", { targetKey: key, ...force ? { force, at: at ?? (await run())?.at } : {}, ...sha ? { sha } : {} }) as Promise<any>;
  const text = (i: number) => sent[i].input[0].text as string;
  return { bb, harness, store, folder, github, sent, chat, calls, push, cli, idle, run, text, key };
}

/** The command the thread is told, quoted for its shell. */
const refspec = (sha: string, head = "feat/qa") => `git push origin '${sha}:refs/heads/${head}'`;

test("Push asks the main thread to commit and report, not push; a reported commit that matches is told to push exactly it, quoted, and GitHub at it is pushed", async () => {
  const { sent, push, cli, idle, run, text, github, calls } = await setup();
  expect(await push()).toEqual({ ok: true, delivery: "sent" });
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ threadId: "coder", mode: "queue-if-active" });
  expect(text(0)).toMatch(/^Review api:feat\/qa "Snooze flaky checks" on MaxBook in `\/Users\/me\/src\/api`, from Code Review Workspace:\n\n/);
  expect(text(0)).toContain("Commit the changes I reviewed, all of them, in this folder. Then run `bb review report --commit <sha>`");
  expect(text(0)).toContain("Don’t push");
  expect(text(0)).not.toContain("git push");
  expect(await run()).toMatchObject({ state: "committing", threadId: "coder", repo: "acme/api", head: "feat/qa" });

  // Its subagent reports for it, by a short SHA: the full one is what's pushed.
  const reported = await cli("sub", "report", "--commit", HEAD.slice(0, 9).toUpperCase());
  expect(reported).toEqual({ exitCode: 0, stderr: "", stdout: `Checked abc1234 for api:feat/qa: it’s what the reviewer reviewed. Push it now, exactly this commit:\n  ${refspec(HEAD)}\nDon’t force-push unless the reviewer says so.` });
  expect(await run()).toMatchObject({ state: "pushing", sha: HEAD });
  // Nothing else is told, and the plugin reads through bb, never git.
  expect(sent).toHaveLength(1);
  expect(runGit).not.toHaveBeenCalled();
  expect(calls.map((call) => call.method)).toEqual(expect.arrayContaining(["workspaceStatus", "files"]));

  github.sha = HEAD;
  await idle();
  expect(await run()).toMatchObject({ state: "pushed", sha: HEAD });
});

test("a folder with nothing to commit is checked at its head: a match tells the thread to push it; GitHub at it already has nothing to push", async () => {
  const { sent, push, run, text, folder, github } = await setup();
  folder.dirty = false;
  expect(await push()).toEqual({ ok: true, delivery: "sent" });
  expect(text(0)).toContain(`Push \`abc1234\` to \`feat/qa\` on GitHub, exactly this commit:\n\n\`\`\`sh\n${refspec(HEAD)}\n\`\`\`\n\nDon’t force-push unless I say so.`);
  expect(await run()).toMatchObject({ state: "pushing", sha: HEAD });

  const again = await setup();
  again.folder.dirty = false;
  again.github.sha = HEAD;
  expect(await again.push()).toEqual({ ok: true, note: "Nothing to push. GitHub already has `abc1234` on `feat/qa`." });
  expect(again.sent).toEqual([]);
  expect(await again.run()).toBeNull();
  void sent; void github;
});

test("a commit that isn't what you reviewed warns, a committed .env the review hid included, and nothing is pushed until Push anyway", async () => {
  const { sent, push, cli, run, folder } = await setup();
  await push();
  folder.committed = { "src/a.ts": "100644:aaa:100644:ccc", ".env": REVIEWED[".env"] };
  const reported = await cli("coder", "report", "--commit", HEAD);
  expect(reported.stdout).toBe("Recorded abc1234 for api:feat/qa, but it isn’t what the reviewer reviewed: 2 files changed since you reviewed. .env may hold secrets and would go to GitHub. Ask the main thread to take it out of the commit, or Include it to review it. Don’t push: the reviewer chooses Push anyway or Update first in the review, and you’ll be told.");
  expect(reported.stdout).not.toContain("git push");
  expect(await run()).toMatchObject({ state: "mismatch", sha: HEAD, files: [".env", "src/a.ts"], secrets: [".env"], warning: "2 files changed since you reviewed. **.env may hold secrets** and would go to GitHub. Ask the main thread to take it out of the commit, or Include it to review it." });
  expect(sent).toHaveLength(1);

  // Push anyway: exactly the commit reported, still never forced.
  expect(await push(true)).toEqual({ ok: true, delivery: "sent" });
  expect(sent).toHaveLength(2);
  expect(sent[1].input[0].text).toContain(refspec(HEAD));
  expect(sent[1].input[0].text).not.toMatch(/--force|-f\b|\+abc/);
  expect(await run()).toMatchObject({ state: "pushing", sha: HEAD });
  expect((await run())!.warning).toBeUndefined();
});

test("only a committed .env warns too, and a folder not at the reported commit warns without reading its files", async () => {
  const { push, cli, run, folder } = await setup();
  await push();
  folder.committed = { ...REVIEWED };
  await cli("coder", "report", "--commit", HEAD);
  expect(await run()).toMatchObject({ state: "mismatch", files: [".env"], secrets: [".env"], warning: "1 file changed since you reviewed. **.env may hold secrets** and would go to GitHub. Ask the main thread to take it out of the commit, or Include it to review it." });

  // A short SHA the folder isn't at: never checked, so nothing can push it, Push anyway included.
  const moved = await setup();
  await moved.push();
  moved.folder.head = OTHER;
  await moved.cli("coder", "report", "--commit", HEAD.slice(0, 7));
  const stale = (await moved.run())!;
  expect(stale).toMatchObject({ state: "mismatch", warning: "The folder is at `f00dbab`, not `abc1234`, the commit reported.", files: [] });
  expect(stale.sha).toBeUndefined();
  expect(moved.calls.filter((call) => call.method === "files")).toEqual([]);
  expect(await moved.push(true)).toEqual({ ok: false, error: "No commit is waiting on Push anyway. Push to start again." });
  expect(moved.sent).toHaveLength(1);
  expect(pushCommand(HEAD.slice(0, 7), "feat/qa")).toBeNull();
});

test("after the push, a branch on GitHub that isn't at the commit is flagged, and is pushed once it is", async () => {
  const { push, cli, idle, run, github } = await setup();
  await push();
  await cli("coder", "report", "--commit", HEAD);
  github.sha = OTHER;
  await idle();
  expect(await run()).toMatchObject({ state: "flagged", flag: "differs", sha: HEAD, remote: OTHER });
  github.sha = HEAD;
  await idle();
  expect(await run()).toMatchObject({ state: "pushed", sha: HEAD });
  expect((await run())!.flag).toBeUndefined();
});

test("a branch that moves on GitHub with no Push is flagged as a push no one asked for; one a Send let the thread make isn't; Got it clears it", async () => {
  const { store, harness, idle, run, github } = await setup();
  // The first read only notes where it is.
  await idle();
  expect(await run()).toBeUndefined();
  expect((await store.getReview(KEY))!.remoteHead).toMatchObject({ repo: "acme/api", head: "feat/qa", sha: OLD });
  github.sha = OTHER;
  await idle();
  expect(await run()).toMatchObject({ state: "flagged", flag: "unrequested", remote: OTHER, threadId: "coder" });
  expect(await harness.behavior.callRpc("dismissPush", { targetKey: KEY })).toEqual({ ok: true });
  expect(await run()).toBeNull();

  // A Send with Let it push when done asked for it.
  await store.setLifecycle(KEY, { sends: [{ n: 1, at: Date.now() + 1, threadId: "coder", ids: ["c1"], letPush: true }] });
  github.sha = HEAD;
  await idle();
  expect(await run()).toBeNull();
  // Another thread's idle reads nothing.
  runGh.mockClear();
  await idle("someone-else");
  expect(runGh).not.toHaveBeenCalled();
});

test("\"push\" to the review agent starts Push only when you typed it in the review: a turn the plugin started, or a relayed one, sends nothing", async () => {
  const { bb, harness, chat, sent, run } = await setup();
  const tool = (input: Record<string, unknown> = {}) => harness.behavior.callAgentTool("push", input, { threadId: "agent" });
  await sendToAgent(bb, { threadId: "agent", mode: "queue-if-active", input: [{ type: "text", text: "New commits: push them.", mentions: [] }] }, { kind: "automatic" });
  let result = await tool();
  expect(toolFailed(result)).toBe(true);
  expect(toolText(result)).toMatch(/^Not pushed: only the reviewer starts a push, with a message in this review that's just "push"/);
  chat.say("push it", { sender: "thr_orchestrator" });
  result = await tool({ force: true });
  expect(toolFailed(result)).toBe(true);
  expect(sent).toEqual([]);
  expect(await run()).toBeUndefined();

  chat.say("push it");
  result = await tool();
  expect(toolFailed(result)).toBe(false);
  expect(toolText(result)).toContain("The main thread was told to commit what the reviewer reviewed");
  expect(sent).toHaveLength(1);
  expect(await run()).toMatchObject({ state: "committing" });
});

test("a re-homed folder, on its fresh thread's own branch, pushes to the review's branch", async () => {
  const { push, cli, sent } = await setup({ workBranch: "bb/snooze-thr_fresh1" });
  await push();
  const reported = await cli("coder", "report", "--commit", HEAD);
  expect(reported.stdout).toContain(refspec(HEAD, "feat/qa"));
  expect(reported.stdout).not.toContain("bb/snooze");
  expect(sent).toHaveLength(1);
});

test("a hostile branch name is quoted whole for the shell, or, with a quote in it, refused before anything is asked", async () => {
  const hostile = "feat/a;b|c$(id)&`x`";
  const { push, cli } = await setup({ branch: hostile });
  await push();
  expect((await cli("coder", "report", "--commit", HEAD)).stdout).toContain(`  git push origin '${HEAD}:refs/heads/${hostile}'\n`);

  const quoted = await setup({ branch: "x;echo$IFS'hi'" });
  expect(await quoted.push()).toEqual({ ok: false, error: "Push can’t write a safe command for \"x;echo$IFS'hi'\": its name has a quote. Push it from a terminal." });
  expect(quoted.sent).toEqual([]);
  expect(pushCommand(HEAD, "a'b")).toBeNull();
  expect(pushCommand(HEAD, "a\nb")).toBeNull();
});

test("a commit report with no Push waiting, from a review's own agent, or after Cancel, pushes nothing", async () => {
  const { push, cli, run, harness } = await setup();
  expect(await cli("coder", "report", "--commit", HEAD)).toMatchObject({ exitCode: 1, stderr: expect.stringContaining("No Push is waiting on a commit from this thread.") });
  await push();
  expect(await cli("agent", "report", "--commit", HEAD)).toMatchObject({ exitCode: 2, stderr: expect.stringContaining("A review's own agent can't report") });
  expect(await cli("coder", "report", "--commit", HEAD, "--note", "x")).toMatchObject({ exitCode: 2, stderr: expect.stringContaining("--note goes with a comment's id.") });
  expect(await push()).toEqual({ ok: false, error: "Push is waiting on the main thread already, to commit. Cancel in Finish review, then Push again." });
  await harness.behavior.callRpc("dismissPush", { targetKey: KEY });
  expect(await cli("coder", "report", "--commit", HEAD)).toMatchObject({ exitCode: 1 });
  expect(await run()).toBeNull();
});

test("a reported commit GitHub has already is nothing to push, and the thread is told so", async () => {
  const { push, cli, run, github } = await setup();
  await push();
  github.sha = HEAD;
  expect((await cli("coder", "report", "--commit", HEAD)).stdout).toBe("Nothing to push. GitHub already has `abc1234` on `feat/qa`.");
  expect(await run()).toMatchObject({ state: "pushed", sha: HEAD });
});

test("a secret an earlier commit added warns, though a later one removed it: the push takes the history to GitHub; a branch too long to check warns too", async () => {
  const { push, cli, run, folder } = await setup();
  await push();
  folder.commits = [{ sha: "e".repeat(40), files: { ".env.local": "added" } }, { sha: HEAD, files: { "src/a.ts": "modified", ".env.local": "deleted" } }];
  await cli("coder", "report", "--commit", HEAD);
  expect(await run()).toMatchObject({ state: "mismatch", sha: HEAD, files: [], secrets: [".env.local"], warning: "**.env.local may hold secrets** and would go to GitHub. Ask the main thread to take it out of the branch’s commits, or Include it to review it." });

  const long = await setup();
  await long.push();
  long.folder.commits = [...Array.from({ length: 50 }, (_, i) => ({ sha: `${i}`.padStart(40, "0"), files: {} })), { sha: HEAD, files: {} }];
  await long.cli("coder", "report", "--commit", HEAD);
  expect(await long.run()).toMatchObject({ state: "mismatch", sha: HEAD, warning: "Couldn’t check `abc1234` against what you reviewed: BB couldn’t list the branch’s 51 commits to check each for secrets." });
});

test("a commit reported by a short SHA is pushed by its full one, and GitHub at it reads as pushed", async () => {
  const { push, cli, run, idle, github, sent, folder } = await setup();
  await push();
  folder.committed = { "src/a.ts": "100644:aaa:100644:ccc" };
  await cli("coder", "report", "--commit", HEAD.slice(0, 7));
  expect(await run()).toMatchObject({ state: "mismatch", sha: HEAD });
  await push(true);
  expect(sent[1].input[0].text).toContain(refspec(HEAD));
  github.sha = HEAD;
  await idle();
  expect(await run()).toMatchObject({ state: "pushed", sha: HEAD });
});

test("the review agent's push needs the reviewer's own words: push, and for Push anyway, anyway, with a commit waiting on it", async () => {
  const { harness, chat, sent, run, push, cli, folder } = await setup();
  const tool = (input: Record<string, unknown> = {}) => harness.behavior.callAgentTool("push", input, { threadId: "agent" });
  chat.say("looks good");
  expect(toolFailed(await tool())).toBe(true);
  chat.say("push it anyway");
  expect(toolText(await tool({ force: true }))).toBe("Not pushed: No commit is waiting on Push anyway. Push to start again.");
  expect(sent).toEqual([]);
  await push();
  folder.committed = { "src/a.ts": "100644:aaa:100644:ccc" };
  await cli("coder", "report", "--commit", HEAD);
  chat.say("push it");
  expect(toolFailed(await tool({ force: true }))).toBe(true);
  chat.say("push it anyway");
  expect(toolText(await tool({ force: true }))).toBe("The main thread was told to push the commit as it is. Tell the reviewer; Push in Finish review shows where it stands.");
  expect(await run()).toMatchObject({ state: "pushing", sha: HEAD });
  expect(sent.at(-1).input[0].text).toContain(refspec(HEAD));
});

test("with Send to thread off, GitHub's head is only noted: a push then isn't flagged once it's back on", async () => {
  const { store, idle, run, github } = await setup();
  await idle();
  const knob = async (sendToThread: boolean) => {
    const { preferences, revision } = await store.getPreferences();
    await store.savePreferences({ ...preferences, knobs: { ...preferences.knobs, sendToThread } }, revision);
  };
  await knob(false);
  github.sha = OTHER;
  await idle();
  expect(await run()).toBeUndefined();
  await knob(true);
  await idle();
  expect(await run()).toBeUndefined();
  expect((await store.getReview(KEY))!.remoteHead?.sha).toBe(OTHER);
});

test("commits GitHub has already aren't checked for secrets again", async () => {
  const { push, cli, run, folder, github } = await setup();
  await push();
  github.sha = OLD;
  folder.commits = [{ sha: OLD, files: { ".env.local": "added" } }, { sha: HEAD, files: { "src/a.ts": "modified", ".env.local": "deleted" } }];
  await cli("coder", "report", "--commit", HEAD);
  expect(await run()).toMatchObject({ state: "pushing", sha: HEAD });
});

test("a large lockfile and an image the review hid are compared by revision: as reviewed, no warning; changed, an ordinary one", async () => {
  const { store, push, cli, run, folder } = await setup();
  const LOCK = "100644:l1:100644:l2";
  const IMAGE = "000000:000:100644:i1";
  await store.saveSnapshotFiles(KEY, diffFilesHead(await store.patchHash(KEY)), {
    revisions: { ...REVIEWED, "package-lock.json": LOCK, "logo.png": IMAGE },
    hidden: [{ path: ".env", reason: "secret" }, { path: "package-lock.json", reason: "large" }, { path: "logo.png", reason: "binary" }],
  });
  folder.committed = { "src/a.ts": REVIEWED["src/a.ts"], "package-lock.json": LOCK, "logo.png": IMAGE };
  await push();
  await cli("coder", "report", "--commit", HEAD);
  expect(await run()).toMatchObject({ state: "pushing", sha: HEAD });

  const changed = await setup();
  await changed.store.saveSnapshotFiles(KEY, diffFilesHead(await changed.store.patchHash(KEY)), { revisions: { "src/a.ts": REVIEWED["src/a.ts"], "package-lock.json": LOCK }, hidden: [{ path: "package-lock.json", reason: "large" }] });
  changed.folder.committed = { "src/a.ts": REVIEWED["src/a.ts"], "package-lock.json": "100644:l1:100644:l3" };
  await changed.push();
  await changed.cli("coder", "report", "--commit", HEAD);
  const after = await changed.run();
  expect(after).toMatchObject({ state: "mismatch", files: ["package-lock.json"], warning: "1 file changed since you reviewed." });
  expect(after!.secrets).toBeUndefined();
});

test("the agent's push takes only a short command of the reviewer's own: not a negation, a question, another word, a quote the plugin put in, or a message joined to its own turn", async () => {
  const { bb, harness, chat, sent, run, push, cli, folder } = await setup();
  const tool = (input: Record<string, unknown> = {}) => harness.behavior.callAgentTool("push", input, { threadId: "agent" });
  for (const said of ["don't push", "why did the push fail?", "pushback on the naming", "please don't push yet", "push it, then merge"]) {
    chat.say(said);
    expect(toolFailed(await tool()), said).toBe(true);
  }
  await sendToAgent(bb, { threadId: "agent", mode: "queue-if-active", input: [{ type: "text", text: "push", mentions: [] }] }, { kind: "ask", said: "push", inserted: true });
  expect(toolFailed(await tool())).toBe(true);
  await sendToAgent(bb, { threadId: "agent", mode: "queue-if-active", input: [{ type: "text", text: "Review this change.", mentions: [] }] }, { kind: "automatic" });
  chat.say("push", { joins: true });
  expect(toolFailed(await tool())).toBe(true);
  expect(sent).toEqual([]);
  expect(await run()).toBeUndefined();

  await push();
  folder.committed = { "src/a.ts": "100644:aaa:100644:ccc" };
  await cli("coder", "report", "--commit", HEAD);
  for (const said of ["push", "push it, but stop if it still warns", "push it still", "push regardless"]) {
    chat.say(said);
    expect(toolFailed(await tool({ force: true })), said).toBe(true);
  }
  expect(await run()).toMatchObject({ state: "mismatch" });
  chat.say("Push it anyway.");
  expect(toolFailed(await tool({ force: true }))).toBe(false);
});

test("GitHub with commits the folder doesn't warns before the thread is told anything; Push anyway goes on, and isn't asked again", async () => {
  const { push, cli, run, folder, sent } = await setup();
  folder.behind = true;
  expect(await push()).toEqual({ ok: true, warning: "GitHub has commits on `feat/qa` that this folder doesn’t. Pull first, or Push anyway to try." });
  expect(sent).toEqual([]);
  const behind = (await run())!;
  expect(behind).toMatchObject({ state: "mismatch", behind: true });
  expect(behind.sha).toBeUndefined();
  expect(await push(true)).toEqual({ ok: true, delivery: "sent" });
  expect(sent[0].input[0].text).toContain("bb review report --commit");
  expect(await run()).toMatchObject({ state: "committing", pastBehind: true });
  expect((await cli("coder", "report", "--commit", HEAD)).stdout).toContain(refspec(HEAD));

  // Ahead at Push, behind by the report: it warns then, with the checked commit to push anyway.
  const later = await setup();
  await later.push();
  later.folder.behind = true;
  expect((await later.cli("coder", "report", "--commit", HEAD)).stdout).toBe("Recorded abc1234 for api:feat/qa, but it can’t go yet: GitHub has commits on `feat/qa` that this folder doesn’t. Pull first, or Push anyway to try. Don’t push: the reviewer chooses Push anyway or Update first in the review, and you’ll be told.");
  expect(await later.run()).toMatchObject({ state: "mismatch", behind: true, sha: HEAD });
  expect(await later.push(true, HEAD)).toEqual({ ok: true, delivery: "sent" });
  expect(later.sent.at(-1).input[0].text).toContain(refspec(HEAD));
});

test("Push anyway acts on the warning shown, and only while the folder is still at its commit", async () => {
  const { push, cli, run, folder, sent } = await setup();
  await push();
  folder.committed = { "src/a.ts": "100644:aaa:100644:ccc" };
  await cli("coder", "report", "--commit", HEAD);
  expect(await push(true, OTHER)).toEqual({ ok: false, error: "Push changed meanwhile. Look again, then choose." });
  folder.head = OTHER;
  expect(await push(true, HEAD)).toEqual({ ok: false, error: "The folder isn’t at abc1234 any more: it’s at f00dbab. Push to check it again." });
  expect(sent).toHaveLength(1);
  expect(await run()).toMatchObject({ state: "mismatch", sha: HEAD });
});

test("bb's commits in either order: the newest first still finds an earlier secret, and the cap counts only commits GitHub hasn't", async () => {
  const { push, cli, run, folder } = await setup();
  await push();
  folder.commits = [{ sha: HEAD, files: { "src/a.ts": "modified", ".env.local": "deleted" } }, { sha: "e".repeat(40), files: { ".env.local": "added" } }];
  await cli("coder", "report", "--commit", HEAD);
  expect(await run()).toMatchObject({ state: "mismatch", secrets: [".env.local"] });

  const long = await setup();
  long.github.sha = `${20}`.padStart(40, "0");
  await long.push();
  long.folder.commits = [...Array.from({ length: 60 }, (_, i) => ({ sha: `${i}`.padStart(40, "0"), files: {} })), { sha: HEAD, files: {} }];
  await long.cli("coder", "report", "--commit", HEAD);
  expect(await long.run()).toMatchObject({ state: "pushing", sha: HEAD });
});

test("Push can't get stuck: a main thread archived while it commits stops it, one that failed after the push reads GitHub, and a queued push isn't called failed", async () => {
  const { harness, push, cli, run, idle, github } = await setup();
  await push();
  await harness.behavior.emitThreadEvent("thread.archived", { thread: makeThreadResponse({ id: "coder" }) } as any);
  expect(await run()).toMatchObject({ state: "flagged", flag: "stopped", why: "archived" });

  const failed = await setup();
  await failed.push();
  await failed.cli("coder", "report", "--commit", HEAD);
  await failed.harness.behavior.emitThreadEvent("thread.failed", { thread: makeThreadResponse({ id: "coder" }) } as any);
  expect(await failed.run()).toMatchObject({ state: "flagged", flag: "differs", remote: OLD });

  // The push message waits in the queue: the idle that ends the turn before it says nothing yet.
  const queued = await setup();
  await queued.push();
  await queued.cli("coder", "report", "--commit", HEAD);
  await queued.idle("coder", 1);
  expect(await queued.run()).toMatchObject({ state: "pushing" });
  void cli; void idle; void github;
});

test("a push a Send let the thread make isn't flagged, though the thread went idle in between", async () => {
  const { store, idle, run, github } = await setup();
  await idle();
  const seen = (await store.getReview(KEY))!.remoteHead!.at;
  await new Promise((resolve) => setTimeout(resolve, 5));
  await store.setLifecycle(KEY, { sends: [{ n: 1, at: Date.now(), threadId: "coder", ids: ["c1"], letPush: true }] });
  await new Promise((resolve) => setTimeout(resolve, 5));
  // Idle while its subagents work: GitHub hasn't moved, so when it was first seen there stays.
  await idle();
  expect((await store.getReview(KEY))!.remoteHead!.at).toBe(seen);
  github.sha = HEAD;
  await idle();
  expect(await run()).toBeUndefined();
});


test("on your PR, the fixer's commit is checked against what Not pushed yet showed you, at the PR's head, and pushed by its full SHA from the fixer's folder", async () => {
  const { harness, push, cli, run, sent, calls, idle, github, key } = await setup({ pr: {} });
  github.sha = PR_HEAD;
  // Not pushed yet, opened: what it shows is what you reviewed.
  expect(await harness.behavior.callRpc("getNotPushed", { targetKey: key })).toMatchObject({ state: "available", base: PR_HEAD });
  expect(await push()).toEqual({ ok: true, delivery: "sent" });
  expect(sent[0]).toMatchObject({ threadId: "fixer" });
  expect(sent[0].input[0].text).toContain("bb review report --commit");
  const reported = await cli("fixer", "report", "--commit", HEAD);
  expect(reported.stdout).toContain(`  git push origin '${HEAD}:refs/heads/feat/qa'\n`);
  expect(calls.filter((call) => call.method === "files").map((call) => call.input.target)).toContainEqual({ type: "branch_committed", mergeBaseBranch: PR_HEAD });
  expect(await run()).toMatchObject({ state: "pushing", sha: HEAD, repo: "acme/api", head: "feat/qa" });
  github.sha = HEAD;
  await idle();
  expect(await run()).toMatchObject({ state: "pushed", sha: HEAD });
});

test("on your PR, a fixer commit that isn't what Not pushed yet showed warns, as does one before you opened it", async () => {
  const unseen = await setup({ pr: {} });
  await unseen.push();
  await unseen.cli("fixer", "report", "--commit", HEAD);
  expect(await unseen.run()).toMatchObject({ state: "mismatch", warning: "Couldn’t check `abc1234` against what you reviewed: you haven’t opened Not pushed yet for this folder, so nothing in it was reviewed. Open it first." });

  const { harness, push, cli, run, folder, key } = await setup({ pr: {} });
  await harness.behavior.callRpc("getNotPushed", { targetKey: key });
  folder.committed = { "src/a.ts": "100644:aaa:100644:ccc" };
  await push();
  await cli("fixer", "report", "--commit", HEAD);
  expect(await run()).toMatchObject({ state: "mismatch", sha: HEAD, files: ["src/a.ts"], warning: "1 file changed since you reviewed." });
});

test("a fixer's own push, a commit its folder has, isn't a push no one asked for: it says the fixer pushed it; a head nobody can place is still flagged", async () => {
  const { idle, run, github, folder } = await setup({ pr: {} });
  github.sha = PR_HEAD;
  await idle();
  github.sha = HEAD;
  await idle();
  expect(await run()).toMatchObject({ state: "pushed", byFixer: true, sha: HEAD, threadId: "fixer" });

  const unknown = await setup({ pr: {} });
  unknown.github.sha = PR_HEAD;
  await unknown.idle();
  unknown.folder.behind = true;
  unknown.github.sha = OTHER;
  await unknown.idle();
  expect(await unknown.run()).toMatchObject({ state: "flagged", flag: "unrequested", remote: OTHER });
  void folder;
});

test("a fork's PR is pushed to the fork's remote, named in the message", async () => {
  const { harness, push, cli, key } = await setup({ pr: { fork: "dana" } });
  await harness.behavior.callRpc("getNotPushed", { targetKey: key });
  await push();
  const reported = await cli("fixer", "report", "--commit", HEAD);
  expect(reported.stdout).toContain(`  git push <remote> '${HEAD}:refs/heads/feat/qa'\n\`<remote>\` is the remote for @dana's fork. Don’t force-push`);
});

test("the one push command: HEAD for a fixer's brief or a full SHA for Push, quoted, never forced, and refusing what it can't quote", () => {
  expect(pushCommand("HEAD", "feat/a;b|c$d")).toBe("git push origin 'HEAD:refs/heads/feat/a;b|c$d'");
  expect(pushCommand(HEAD, "feat/qa", "<remote>")).toBe(`git push <remote> '${HEAD}:refs/heads/feat/qa'`);
  for (const [from, head] of [[HEAD.slice(0, 12), "feat/qa"], ["main", "feat/qa"], [`+${HEAD}`, "feat/qa"], [HEAD, "a'b"], ["HEAD", "a\nb"], ["HEAD", "a\u007fb"]]) expect(pushCommand(from, head), `${from} ${head}`).toBeNull();
  expect(pushCommand(HEAD, "feat/qa")).not.toMatch(/--force|-f\b|\+/);
});

test("Push anyway from the page goes only on the warning it shows: a later one, as a secret it never showed, isn't pushed", async () => {
  const { push, cli, run, folder, sent, harness, key } = await setup();
  folder.behind = true;
  await push();
  const shown = (await run())!.at;
  // Meanwhile, the page not reloaded: GitHub catches up, Push runs again, and the commit has a secret in it.
  folder.behind = false;
  await harness.behavior.callRpc("dismissPush", { targetKey: key });
  await new Promise((resolve) => setTimeout(resolve, 2));
  await push();
  folder.committed = { ...REVIEWED };
  await cli("coder", "report", "--commit", HEAD);
  expect(await run()).toMatchObject({ state: "mismatch", secrets: [".env"] });
  expect(await push(true, undefined, shown)).toEqual({ ok: false, error: "Push changed meanwhile. Look again, then choose." });
  expect(await harness.behavior.callRpc("push", { targetKey: key, force: true })).toEqual({ ok: false, error: "Push anyway needs the warning it answers. Reload, then choose." });
  expect(sent).toHaveLength(1);
});

test("a folder Push can't read says so plainly, not that GitHub is ahead, and still pushes nothing", async () => {
  const { push, run, sent, folder } = await setup();
  folder.unreadable = true;
  expect(await push()).toEqual({ ok: true, warning: "Couldn’t read the folder on MaxBook. Try again, or Push anyway." });
  expect(await run()).toMatchObject({ state: "mismatch", behind: true });
  expect(sent).toEqual([]);
});
