// Every way a Send can reach a PR's fixer, in every state a review can be in (lib/fixer.ts): where it goes, and what it
// says. A fixer is never told to check out the PR's branch, every message to one says what the quoted words are, and
// each fixer's first message gives it the push command, quoted. Cells that can't happen say why.
import { expect, test, vi } from "vitest";

const runGh = vi.hoisted(() => vi.fn(async () => ({ stdout: "", stderr: "no GitHub here", code: 1 })));
vi.mock("./gh", async (orig) => ({ ...(await orig<any>()), runGh }));
vi.mock("./store-queue", async (original) => {
  const actual = await original<typeof import("./store-queue")>();
  return { ...actual, queueStore: vi.fn(actual.queueStore) };
});

import { startPlugin } from "./plugin-store.test-support";
import { folderHost } from "./env-diff.test-support";
import { agentChat } from "./agent-chat.test-support";
import { toolText } from "./fake-host.test-support";
import { UNTRUSTED_NOTE } from "./own-pr";
import type { ReviewLifecycle, ReviewMeta } from "./store";

const SHA = "1f2e3d4c5b6a79881f2e3d4c5b6a79881f2e3d4c";
const PATCH = ["diff --git a/src/a.ts b/src/a.ts", "--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1,3 +1,4 @@", " const a = 1;", "-const b = 2;", "+const b = 3;", "+const c = 4;", " export { a };"].join("\n");
const A = { file: "src/a.ts", line: 3, side: "RIGHT" as const };
const B = { file: "src/a.ts", line: 2, side: "LEFT" as const };
const REFSPEC = "'HEAD:refs/heads/retry-uploads'";
const fixerRecord = { sha: SHA, at: 2 };

type State = "local-folder" | "own-folder" | "own-none" | "own-rehomed" | "own-rehomed-archived" | "own-fork-unsent" | "own-fixer-unmade" | "teammate-none";
type Route = "send" | "later" | "rest" | "send-now" | "agent" | "start-fresh" | "fork" | "unarchive" | "fix-new";
interface T { title: string; archivedAt?: number | null; environmentId?: string | null }

const folder = { environmentId: "env1", hostId: "host_max", machine: "MaxBook", path: "/Users/me/src/web", branch: "retry-uploads", baseRef: "main", repo: "acme/web" };
const rehomed = { ...folder, environmentId: "env_fix1", path: "/Users/me/.bb/worktrees/env_fix1", workBranch: "bb/env_fix1" };
const coder = { threadId: "coder", environmentId: "env_old", origin: "adopted" as const, since: 1 };
const fixer1 = { threadId: "fixer1", environmentId: "env_fix1", origin: "fresh" as const, since: 2, branch: "bb/env_fix1", fixer: fixerRecord };

/** Each state: the review, its lifecycle, and the threads BB has. */
const STATES: Record<State, { key: string; review: Partial<ReviewMeta>; lifecycle: ReviewLifecycle; threads: Record<string, T> }> = {
  "local-folder": { key: "br-1", review: { kind: "ref", gitRef: "retry-uploads", repo: undefined, number: undefined, head: undefined, headSha: undefined }, threads: { coder: { title: "Retry uploads", environmentId: "env1" } },
    lifecycle: { feature: folder, mainThread: { ...coder, environmentId: "env1" }, sourceThreadId: "coder" } },
  "own-folder": { key: "pr-1", review: {}, threads: { coder: { title: "Retry uploads", environmentId: "env1" } },
    lifecycle: { ownPr: true, feature: folder, mainThread: { ...coder, environmentId: "env1" }, sourceThreadId: "coder" } },
  "own-none": { key: "pr-1", review: {}, threads: {}, lifecycle: { ownPr: true } },
  "own-rehomed": { key: "pr-1", review: {}, threads: { coder: { title: "Retry uploads", archivedAt: 1, environmentId: "env_old" }, fixer1: { title: "Fixes 1", environmentId: "env_fix1" } },
    lifecycle: { ownPr: true, feature: rehomed, mainThread: fixer1, implementers: [coder], sourceThreadId: "fixer1", sends: [{ n: 1, at: 2, threadId: "fixer1", ids: [] }] } },
  "own-rehomed-archived": { key: "pr-1", review: {}, threads: { coder: { title: "Retry uploads", archivedAt: 1, environmentId: "env_old" }, fixer1: { title: "Fixes 1", archivedAt: 3, environmentId: "env_fix1" } },
    lifecycle: { ownPr: true, feature: rehomed, mainThread: fixer1, implementers: [coder], sourceThreadId: "fixer1", sends: [{ n: 1, at: 2, threadId: "fixer1", ids: [] }] } },
  "own-fork-unsent": { key: "pr-1", review: {}, threads: { coder: { title: "Retry uploads", archivedAt: 1, environmentId: "env_old" }, fixer1: { title: "Fixes 1", archivedAt: 3, environmentId: "env_fix1" }, forked1: { title: "Fixes 2", environmentId: "env_fork1" } },
    lifecycle: { ownPr: true, feature: rehomed, mainThread: { threadId: "forked1", environmentId: "env_fork1", origin: "forked", since: 4, fixer: fixerRecord }, implementers: [coder, fixer1], sourceThreadId: "forked1", sends: [{ n: 1, at: 2, threadId: "fixer1", ids: [] }] } },
  "own-fixer-unmade": { key: "pr-1", review: {}, threads: { fixer2: { title: "Fixes 1", environmentId: null } },
    lifecycle: { ownPr: true, mainThread: { threadId: "fixer2", environmentId: null, origin: "fresh", since: 2, fixer: fixerRecord }, sourceThreadId: "fixer2", sends: [{ n: 1, at: 2, threadId: "fixer2", ids: [] }] } },
  "teammate-none": { key: "pr-1", review: { author: "per" }, threads: {}, lifecycle: { ownPr: false } },
};

/** Where a route went: a choice to make, a fresh fixer at the head, a plain fresh thread, a fork, or a thread already there. */
type Went = "choice" | "fixer" | "fresh" | "fork" | `thread:${string}`;
/** What a cell expects of the message, or why the cell can't happen. */
type Cell = { went: Went; checkOut?: boolean; note?: boolean; refspec?: boolean } | { na: string };

const na = (why: string): Cell => ({ na: why });
/** To a fixer: no "Check out", the note; the refspec in its first message. */
const toFixer = (went: Went, first = false): Cell => ({ went, checkOut: false, note: true, refspec: first });
/** To the thread in your folder: no "Check out", no fixer's note. */
const toFolder = (went: Went): Cell => ({ went, checkOut: false, note: false, refspec: false });
const fixNew: Cell = { went: "fresh", checkOut: true, note: false, refspec: false };
const OPEN = "the main thread is open: a Send goes to it, whatever you choose";

const TABLE: Record<State, Record<Route, Cell>> = {
  "local-folder": {
    send: toFolder("thread:coder"), later: toFolder("thread:coder"), rest: na(OPEN), "send-now": toFolder("thread:coder"), agent: toFolder("thread:coder"),
    "start-fresh": toFolder("fresh"), fork: na("a local review has no fixers to fork"), unarchive: na(OPEN),
    // A local review's Fix in a new thread stays on its branch.
    "fix-new": { went: "fresh", checkOut: false, note: false, refspec: false },
  },
  "own-folder": {
    send: toFolder("thread:coder"), later: toFolder("thread:coder"), rest: na(OPEN), "send-now": toFolder("thread:coder"), agent: toFolder("thread:coder"),
    "start-fresh": toFolder("fresh"), fork: na(OPEN), unarchive: na(OPEN), "fix-new": fixNew,
  },
  "own-none": {
    send: { went: "choice" }, later: toFixer("thread:spawned1"), rest: na("no thread was sent anything, so none stopped"), "send-now": { went: "choice" }, agent: { went: "choice" },
    "start-fresh": toFixer("fixer", true), fork: na("no thread wrote the PR, so there's none to fork"), unarchive: na("no thread to unarchive"), "fix-new": fixNew,
  },
  "own-rehomed": {
    send: toFixer("thread:fixer1"), later: toFixer("thread:fixer1"), rest: na(OPEN), "send-now": toFixer("thread:fixer1"), agent: toFixer("thread:fixer1"),
    "start-fresh": toFixer("fixer", true), fork: na(OPEN), unarchive: na(OPEN), "fix-new": fixNew,
  },
  "own-rehomed-archived": {
    send: { went: "choice" }, later: toFixer("thread:spawned1"), rest: { went: "choice" }, "send-now": { went: "choice" }, agent: { went: "choice" },
    "start-fresh": toFixer("fixer", true), fork: toFixer("fork", true), unarchive: toFixer("thread:fixer1"), "fix-new": fixNew,
  },
  "own-fork-unsent": {
    // Nothing reached the fork: the first Send to it is its brief.
    send: toFixer("thread:forked1", true), later: toFixer("thread:forked1"), rest: na(OPEN), "send-now": toFixer("thread:forked1", true), agent: toFixer("thread:forked1", true),
    "start-fresh": toFixer("fixer", true), fork: na(OPEN), unarchive: na(OPEN), "fix-new": fixNew,
  },
  "own-fixer-unmade": {
    send: toFixer("thread:fixer2"), later: toFixer("thread:fixer2"), rest: na(OPEN), "send-now": toFixer("thread:fixer2"), agent: toFixer("thread:fixer2"),
    "start-fresh": toFixer("fixer", true), fork: na(OPEN), unarchive: na(OPEN), "fix-new": fixNew,
  },
  "teammate-none": {
    send: { went: "choice" }, later: toFixer("thread:spawned1"), rest: na("no thread was sent anything, so none stopped"), "send-now": { went: "choice" }, agent: { went: "choice" },
    "start-fresh": toFixer("fixer", true), fork: na("Fork is only for your own PRs"), unarchive: na("no thread to unarchive"), "fix-new": fixNew,
  },
};

/** A BB in `state`, the plugin started on it, the review saved, and how to see what each route did. */
async function inState(state: State) {
  const s = STATES[state];
  const threads: Record<string, T> = structuredClone(s.threads);
  const chat = agentChat("agent");
  let spawned = 0;
  let forked = 0;
  const env = (id: string) => ({
    id, hostId: "host_max", path: `/Users/me/${id === "env1" ? "src/web" : `.bb/worktrees/${id}`}`, status: "ready", isGitRepo: true,
    branchName: id === "env1" ? "retry-uploads" : `bb/${id}`, mergeBaseBranch: "main", baseBranch: null, defaultBranch: "main", projectId: "p1",
    workspaceProvisionType: id === "env1" || id === "env_old" ? "unmanaged" : "managed-worktree",
  });
  const h = folderHost({ files: [] }, {
    environments: { get: async ({ environmentId }: { environmentId: string }) => env(environmentId) },
    threads: {
      events: chat.sdk.events, experimental_listAncestors: chat.sdk.experimental_listAncestors,
      get: async ({ threadId }: { threadId: string }) => {
        if (threadId === "agent") return { id: "agent", archivedAt: null, deletedAt: null, status: "idle", title: "Review agent", environmentId: null, visibility: "hidden" };
        const thread = threads[threadId];
        if (!thread) throw Object.assign(new Error("HTTP 404: Thread not found"), { status: 404 });
        return { id: threadId, archivedAt: null, deletedAt: null, environmentId: null, status: "idle", titleFallback: null, visibility: "visible", originPluginId: null, ...thread };
      },
      send: async (args: any) => args.threadId === "agent" ? chat.sdk.send(args) : { ok: true, delivery: "sent" },
      spawn: async (args: any) => {
        const id = `spawned${++spawned}`;
        const envId = args.environment.type === "reuse" ? args.environment.environmentId : `env_${id}`;
        threads[id] = { title: args.title, environmentId: envId };
        return { id, title: args.title, environmentId: envId };
      },
      fork: async (args: any) => {
        const id = `fork${++forked}`;
        threads[id] = { title: args.title, environmentId: `env_${id}` };
        return { id, title: args.title, environmentId: `env_${id}` };
      },
      unarchive: async ({ threadId }: { threadId: string }) => { threads[threadId]!.archivedAt = null; return { ok: true }; },
    },
    projects: {
      defaultExecutionOptions: async () => ({ providerId: "codex", model: "gpt-6", reasoningLevel: "low", permissionMode: "auto" }),
      get: async () => ({ id: "p1", gitRemoteUrl: "git@github.com:acme/web.git", sources: [{ hostId: "host_max", path: "/Users/me/src/web", isDefault: true }] }),
      list: async () => [{ id: "p1", kind: "standard", gitRemoteUrl: "git@github.com:acme/web.git" }],
    },
  });
  const store = await startPlugin(h.bb);
  await store.saveReview({ targetKey: s.key, kind: "pr", repo: "acme/web", number: 12, title: "Retry uploads", author: "me", head: "retry-uploads", headSha: SHA, status: "ready", createdAt: 1, projectId: "p1", ...s.review } as ReviewMeta);
  await store.setLifecycle(s.key, { prConversation: [], ...s.lifecycle });
  await store.savePatch(s.key, PATCH);
  await store.upsertDraftComment(s.key, { ...A, body: "Name this better." });
  await store.upsertDraftComment(s.key, { ...B, body: "Why change b?" });
  await store.setAssistantThread(s.key, "agent");
  const calls = (method: string) => h.harness.inspection.sdk.callsTo(method).map((c) => c[0] as any);
  const rpc = (method: string, input: Record<string, unknown>) => h.harness.behavior.callRpc(method, { targetKey: s.key, ...input }) as Promise<any>;
  /** What happened since `mark`: where it went, and the message it carried. */
  const counts = () => ({ spawn: calls("threads.spawn").length, fork: calls("threads.fork").length, send: calls("threads.send").filter((args) => args.threadId !== "agent").length });
  const since = (mark: ReturnType<typeof counts>, result: any): { went: Went; text: string } => {
    if (result && (result.ok === false && result.choice || typeof result === "string" && result.includes("Not sent yet"))) return { went: "choice", text: "" };
    if (calls("threads.fork").length > mark.fork) {
      const forkId = `fork${calls("threads.fork").length}`;
      return { went: "fork", text: calls("threads.send").filter((args) => args.threadId === forkId).at(-1).input[0].text };
    }
    if (calls("threads.spawn").length > mark.spawn) {
      const spawn = calls("threads.spawn").at(-1);
      const atHead = spawn.environment.type === "host" && spawn.environment.workspace?.baseBranch?.name === SHA;
      return { went: atHead ? "fixer" : "fresh", text: spawn.prompt };
    }
    const sends = calls("threads.send").filter((args) => args.threadId !== "agent");
    if (sends.length > mark.send) return { went: `thread:${sends.at(-1).threadId}`, text: sends.at(-1).input[0].text };
    throw new Error(`Nothing went: ${JSON.stringify(result)}`);
  };
  return { s, store, rpc, chat, h, counts, since };
}

/** Run `route` in `state`, and say where it went and what it said. */
async function run(state: State, route: Route): Promise<{ went: Went; text: string }> {
  const t = await inState(state);
  const own = STATES[state].lifecycle.ownPr === true;
  const go = async (input: Record<string, unknown>) => {
    const mark = t.counts();
    return t.since(mark, await t.rpc("sendToSourceThread", input));
  };
  if (route === "send") return go({ comments: [A] });
  if (route === "later") {
    const first = await t.rpc("sendToSourceThread", { comments: [A] });
    if (!first.ok) expect(await t.rpc("sendToSourceThread", { comments: [A], force: true, thread: "fresh" })).toMatchObject({ ok: true });
    return go({ comments: [B], force: true });
  }
  if (route === "rest") {
    // As Send the rest asks: on your PR's fixer it lets the server ask where; else a fresh thread.
    const { usesFixer } = await import("../lib/fixer");
    const review = (await t.store.getReview(t.s.key))!;
    return go({ comments: [A], force: true, ...own && usesFixer(review) ? {} : { thread: "fresh" } });
  }
  if (route === "send-now" || route === "fork" || route === "unarchive") {
    const mark = t.counts();
    const choice = route === "fork" ? { force: true, thread: "fork" } : route === "unarchive" ? { force: true, thread: "unarchive" } : {};
    return t.since(mark, await t.rpc("sendNow", { comment: A, ...choice }));
  }
  if (route === "agent") {
    t.chat.say("Fix the name on line 3.");
    const mark = t.counts();
    return t.since(mark, toolText(await t.h.harness.behavior.callAgentTool("send_now", { ...A }, { threadId: "agent" })));
  }
  if (route === "start-fresh") {
    const mark = t.counts();
    expect(await t.rpc("setMainThread", { fresh: true })).toEqual({ ok: true });
    return t.since(mark, null);
  }
  const mark = t.counts();
  expect(await t.rpc("startFixThread", { comments: [A], force: true })).toMatchObject({ ok: true });
  return t.since(mark, null);
}

const cells = Object.entries(TABLE).flatMap(([state, routes]) => Object.entries(routes).map(([route, cell]) => ({ state: state as State, route: route as Route, cell })));

test("the table covers every state and every route", () => {
  expect(cells).toHaveLength(Object.keys(STATES).length * 9);
});

test.each(cells.filter(({ cell }) => !("na" in cell)))("$state × $route", async ({ state, route, cell }) => {
  if ("na" in cell) return;
  const { went, text } = await run(state, route);
  expect(went).toBe(cell.went);
  if (went === "choice") return;
  // The brief says not to ("don't run git switch or check out …"); a message that says to starts "Check out the branch".
  expect(/check out the branch/i.test(text), "Check out").toBe(cell.checkOut);
  expect(text.includes(UNTRUSTED_NOTE), "the untrusted note").toBe(cell.note);
  expect(text.includes(REFSPEC), "the quoted refspec").toBe(cell.refspec);
});
