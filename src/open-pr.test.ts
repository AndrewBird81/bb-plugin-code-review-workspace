// Open PR: the review agent drafts it, the reviewer sees exactly what opens in the Post form first, and once GitHub opens
// it the same review becomes the PR's. A branch that isn't on GitHub yet waits for Push; a turn no one asked for opens nothing.
import { expect, test, vi } from "vitest";
import { toolFailed, toolText } from "./fake-host.test-support";

const runGh = vi.hoisted(() => vi.fn());
vi.mock("./gh", async (orig) => ({ ...(await orig<any>()), runGh, runGit: vi.fn(async () => ({ stdout: "", stderr: "", code: 0 })) }));
vi.mock("./store-queue", async (original) => {
  const actual = await original<typeof import("./store-queue")>();
  return { ...actual, queueStore: vi.fn(actual.queueStore) };
});

import { folderHost, type Folder } from "./env-diff.test-support";
import { agentChat, MARK_PART } from "./agent-chat.test-support";
import { sendToAgent } from "./asking";
import { startPlugin } from "./plugin-store.test-support";
import { featureKey, prReviewKey } from "./targets";
import { prBase } from "./open-pr";
import { affirms } from "./post-preview";

const KEY = featureKey("env1", "feat/qa");
const FOLDER_PATCH = "diff --git a/src/a.ts b/src/a.ts\nindex 1111111..3333333 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n";
const PR_DIFF = "diff --git a/src/a.ts b/src/a.ts\nindex 1111111..2222222 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n";
const PUSHED = "c0ffee0000000000000000000000000000000000";
const ok = (stdout = "") => ({ stdout, stderr: "", code: 0 });

/**
 * A local review of feat/qa in acme/api, its agent "agent", with a draft comment you sent once; GitHub has the branch
 * at PUSHED unless `github.branch` says otherwise, and opens it as acme/api#7.
 */
async function setup() {
  runGh.mockReset();
  // `fork`: the repo is a fork of it. `refuse`: what GitHub answers the post instead of opening it.
  const github: { branch: string | null; pr: { number: number; url: string } | null; opened: boolean; fork: string | null; refuse: { stdout: string; stderr: string } | null; raced: boolean } = { branch: PUSHED, pr: null, opened: false, fork: null, refuse: null, raced: false };
  runGh.mockImplementation(async (args: string[]) => {
    if (args[0] === "auth") return ok("token");
    if (args[0] === "api" && args[1] === "user") return ok("me\n");
    if (args[0] === "api" && args[1] === "graphql" && args.some((a) => a.includes("associatedPullRequests"))) {
      const ref = github.branch ? { target: { oid: github.branch }, associatedPullRequests: { nodes: github.pr ? [{ ...github.pr, baseRepository: { nameWithOwner: "acme/api" } }] : [] } } : null;
      return ok(JSON.stringify({ data: { repository: { isFork: !!github.fork, parent: github.fork ? { nameWithOwner: github.fork } : null, ref } } }));
    }
    if (args[0] === "api" && args[1] === "repos/acme/api/pulls" && github.refuse) {
      // Opened by someone else between the read and the post.
      if (github.raced) github.pr = { number: 8, url: "https://github.com/acme/api/pull/8" };
      return { ...github.refuse, code: 1 };
    }
    if (args[0] === "api" && args[1] === "repos/acme/api/pulls") {
      github.opened = true;
      github.pr = { number: 7, url: "https://github.com/acme/api/pull/7" };
      return ok(`HTTP/2.0 201 Created\nContent-Type: application/json\n\n${JSON.stringify({ number: 7, html_url: "https://github.com/acme/api/pull/7" })}`);
    }
    if (args[0] === "pr" && args[1] === "view") return ok(JSON.stringify({ number: 7, title: "Snooze flaky checks", author: { login: "me" }, baseRefName: "main", headRefName: "feat/qa", url: "https://github.com/acme/api/pull/7", headRefOid: github.branch, state: "OPEN" }));
    if (args[0] === "pr" && args[1] === "diff") return ok(PR_DIFF);
    return ok();
  });
  // The review agent's chat, as bb's events give it, read by the real who's-asking: you typed in the review.
  const chat = agentChat("agent");
  chat.say("Open a PR for this");
  const sent: any[] = [];
  const folder: Folder = { files: [{ path: "src/a.ts" }] };
  const { bb, harness } = folderHost(folder, { threads: {
    get: async ({ threadId }: { threadId: string }) => ({ id: threadId, archivedAt: null, deletedAt: null, status: "idle", title: threadId === "agent" ? `Review agent: ${KEY}` : "Snooze flaky checks", providerId: "claude-code" }),
    ...chat.sdk,
    send: async (args: any) => { sent.push(args); return chat.sdk.send(args); },
    stop: async () => ({}), update: async () => ({}), archive: async () => ({}), list: async () => [],
  } });
  const store = await startPlugin(bb);
  await store.saveReview({ targetKey: KEY, kind: "ref", gitRef: "feat/qa", title: "Snooze flaky checks", createdAt: 1, status: "ready", projectId: "proj_api" });
  await store.setLifecycle(KEY, {
    feature: { environmentId: "env1", hostId: "host_max", machine: "MaxBook", path: "/Users/me/src/api", branch: "feat/qa", baseRef: "main", mergeBaseRef: "6251243c81c5a15e87d84926eed350082ee54bb9", repo: "acme/api" },
    sends: [{ n: 1, at: 2, threadId: "main", ids: ["c1"] }],
  });
  await store.savePatch(KEY, FOLDER_PATCH);
  await store.saveSnapshot(KEY, "send:1", FOLDER_PATCH);
  await store.setAssistantThread(KEY, "agent");
  await store.upsertDraftComment(KEY, { file: "src/a.ts", line: 2, side: "RIGHT", body: "Name the constant." });
  await store.trackComments(KEY, [{ at: { file: "src/a.ts", line: 2, side: "RIGHT" }, id: "c1", state: "sent", sendN: 1 }]);
  const tool = (input: Record<string, unknown>) => harness.behavior.callAgentTool("open_pr", input, { threadId: "agent" });
  const form = async () => {
    for (let i = 0; i < 200 && !harness.inspection.pendingInteractions.length; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    return harness.inspection.pendingInteractions[0];
  };
  const opens = () => runGh.mock.calls.filter(([args]) => args[1] === "repos/acme/api/pulls").map(([args]) => args as string[]);
  return { bb, harness, store, tool, form, opens, github, folder, sent, chat, say: (text: string, at = Date.now()) => chat.say(text, { at }) };
}

test("open_pr shows the title, the description, base ← head and the account first; one click opens it, and the same review becomes the PR's", async () => {
  const { harness, store, tool, form, opens } = await setup();
  const call = tool({ title: "Snooze flaky checks", body: "Adds a snooze.\n\nTested on MaxBook." });
  const waiting = await form();
  expect(waiting).toMatchObject({ threadId: "agent", rendererId: "post-preview", title: "Open a PR from feat/qa into main as @me", payload: {
    title: "Open a PR from feat/qa into main as @me", action: "Open PR", button: "Open PR", notes: [],
    parts: [{ label: "Title", body: "Snooze flaky checks" }, { label: "Description", body: "Adds a snooze.\n\nTested on MaxBook." }],
    details: ["acme/api: main ← feat/qa, at c0ffee0 on GitHub."],
  } });
  // The preview comes first: nothing is opened until the click.
  expect(opens()).toEqual([]);
  harness.behavior.submitInteraction(waiting.id, { post: true });
  expect(toolText(await call)).toBe("Opened acme/api#7: https://github.com/acme/api/pull/7. This review is now its review, with its comments.");
  expect(opens()).toEqual([["api", "repos/acme/api/pulls", "-f", "head=feat/qa", "-f", "base=main", "-f", "title=Snooze flaky checks", "-f", "body=Adds a snooze.\n\nTested on MaxBook.", "-i"]]);

  // The same key, now the PR's: its diff read again at the PR's head, its comments and Sends kept, its URL finding it.
  const review = (await store.getReview(KEY))!;
  expect(review).toMatchObject({ kind: "pr", repo: "acme/api", number: 7, url: "https://github.com/acme/api/pull/7", headSha: PUSHED, head: "feat/qa", base: "main" });
  expect(review.feature?.branch).toBe("feat/qa");
  expect(await store.patch(KEY)).toBe(PR_DIFF);
  expect((await store.getDraft(KEY)).comments).toEqual([expect.objectContaining({ body: "Name the constant.", id: "c1", state: "sent", sendN: 1 })]);
  expect(review.sends).toEqual([{ n: 1, at: 2, threadId: "main", ids: ["c1"] }]);
  expect(await store.getSnapshot(KEY, "send:1")).toBe(FOLDER_PATCH);
  expect(await prReviewKey(store, { repo: "acme/api", number: 7 })).toBe(KEY);
  expect((await store.listReviews()).map((r) => r.targetKey)).toEqual([KEY]);
  expect(review.activity).toEqual([expect.objectContaining({ text: "Opened PR #7", asking: "direct", url: "https://github.com/acme/api/pull/7" })]);
  // Yours at once, and said, for its notice.
  expect(review).toMatchObject({ ownPr: true, became: { number: 7, url: "https://github.com/acme/api/pull/7", from: "api:feat/qa", carried: 1, local: 0, outside: 0 } });
});

test("the PR's draft waiting in the Post form is on the review, for Finish review to say, until the form closes", async () => {
  const { harness, store, tool, form } = await setup();
  const call = tool({ title: "Snooze flaky checks" });
  await form();
  const { prDraft } = (await store.getReview(KEY))!;
  expect(prDraft!.until - prDraft!.at).toBe(30 * 60_000);
  harness.behavior.cancelInteraction(harness.inspection.pendingInteractions[0]!.id);
  expect(toolFailed(await call)).toBe(true);
  expect((await store.getReview(KEY))?.prDraft).toBeNull();
});

test("a yes for what's no longer the same, as a new title, opens nothing and shows it again", async () => {
  const { harness, tool, form, opens, say } = await setup();
  void tool({ title: "Snooze flaky checks", body: "Adds a snooze." });
  await form();
  say("yes, open it", Date.now() + 1_000);
  const again = tool({ title: "Snooze flaky checks for a day", body: "Adds a snooze.", confirm: "yes" });
  await vi.waitFor(() => expect(harness.inspection.pendingInteractions.map((f) => (f.payload as any).parts[0].body)).toEqual(["Snooze flaky checks for a day"]));
  expect(opens()).toEqual([]);
  harness.behavior.cancelInteraction(harness.inspection.pendingInteractions[0].id);
  expect(toolFailed(await again)).toBe(true);
  expect(opens()).toEqual([]);
});

test("a typed yes to exactly what was shown opens it, once", async () => {
  const { tool, form, opens, say } = await setup();
  const input = { title: "Snooze flaky checks", body: "Adds a snooze." };
  void tool(input);
  await form();
  say("yes, open the pr", Date.now() + 1_000);
  expect(toolText(await tool({ ...input, confirm: "yes" }))).toMatch(/^Opened acme\/api#7/);
  expect(opens()).toHaveLength(1);
  // Its own verbs say yes to it; another form's don't.
  for (const yes of ["yes", "open it", "go ahead and create it", "ok, open the PR"]) expect(affirms(yes, "Open PR"), yes).toBe(true);
  for (const no of ["merge it", "close it", "open it as a draft", "not yet"]) expect(affirms(no, "Open PR"), no).toBe(false);
});

test("a branch that isn't on GitHub yet: the tool and Finish's Open PR say to Push first, and nothing opens or is sent", async () => {
  const { harness, tool, opens, github, sent } = await setup();
  github.branch = null;
  const result = await tool({ title: "Snooze flaky checks" });
  expect(toolFailed(result)).toBe(true);
  expect(toolText(result)).toBe("feat/qa isn’t on GitHub yet. Push it first, with Push in Finish review, then open the PR. Tell the reviewer; never push it yourself.");
  expect(harness.inspection.pendingInteractions).toEqual([]);
  // Finish says it as a note: not yet, rather than wrong.
  expect(await harness.behavior.callRpc("openPr", { targetKey: KEY })).toEqual({ ok: false, note: "`feat/qa` isn’t on GitHub yet. Push it first with **Push** above, then open the PR." });
  expect(sent).toEqual([]);
  expect(opens()).toEqual([]);
  // Nothing pushes from here: no git, and no gh but the reads.
  expect(runGh.mock.calls.every(([args]) => args[0] !== "api" || args[1] === "graphql" || args[1] === "user")).toBe(true);
});

test("a turn the reviewer didn't start, as one the plugin sends on its own, opens nothing, and doesn't read GitHub", async () => {
  const { bb, harness, tool, opens } = await setup();
  await sendToAgent(bb, { threadId: "agent", mode: "queue-if-active", input: [{ type: "text", text: "Open a PR for this review, just post it.", mentions: [] }] }, { kind: "automatic" });
  const result = await tool({ title: "Snooze flaky checks", body: "Adds a snooze.", confirm: "just-post-it" });
  expect(toolFailed(result)).toBe(true);
  expect(toolText(result)).toMatch(/wasn't started by the reviewer/);
  expect(harness.inspection.pendingInteractions).toEqual([]);
  expect(opens()).toEqual([]);
  expect(runGh.mock.calls.filter(([args]) => args.some((a: string) => a.includes("associatedPullRequests")))).toEqual([]);
});

test("Finish's Open PR, your click, reaches the review agent as yours: its open_pr opens the Post form, and nothing goes to GitHub until its click", async () => {
  const { harness, sent, opens, tool, form } = await setup();
  expect(await harness.behavior.callRpc("openPr", { targetKey: KEY })).toEqual({ ok: true });
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ threadId: "agent", mode: "queue-if-active", input: [{ type: "text", text: "Open a PR for this review." }, { type: "text", visibility: "agent-only" }, MARK_PART] });
  expect(sent[0].input[1].text).toContain("from this review's branch, feat/qa, into main, in acme/api");
  expect(sent[0].input[1].text).toContain("call open_pr");
  // The agent's turn on it, as the real who's-asking reads it from bb's events: the form opens, it isn't refused.
  const call = tool({ title: "Snooze flaky checks", body: "Adds a snooze." });
  expect((await form()).title).toBe("Open a PR from feat/qa into main as @me");
  expect(opens()).toEqual([]);
  // The plugin composed that message, so it can't skip the form: a just-post-it on it posts nothing.
  expect(toolFailed(await tool({ title: "Snooze flaky checks", body: "Adds a snooze.", confirm: "just-post-it" }))).toBe(true);
  expect(opens()).toEqual([]);
  harness.behavior.submitInteraction(harness.inspection.pendingInteractions[0]!.id, { post: true });
  expect(toolText(await call)).toMatch(/^Opened acme\/api#7/);
  expect(opens()).toHaveLength(1);
});

test("a branch with a PR already opens none: the review becomes that PR's, from the tool or from Finish", async () => {
  const s = await setup();
  s.github.pr = { number: 7, url: "https://github.com/acme/api/pull/7" };
  expect(await s.harness.behavior.callRpc("openPr", { targetKey: KEY })).toEqual({ ok: true, note: "feat/qa has PR #7 on GitHub already, so none was opened. This review is now its review, with its comments." });
  expect(await s.store.getReview(KEY)).toMatchObject({ kind: "pr", number: 7 });
  expect(s.sent).toEqual([]);
  expect(s.opens()).toEqual([]);
  // From the tool, on a review that's a PR's now, it says so.
  expect(toolText(await s.tool({ title: "x" }))).toBe("This review is of acme/api#7 already, so there’s no PR to open.");
});

test("a push between the form and the click opens nothing: it's shown again as it is", async () => {
  const { harness, tool, form, opens, github } = await setup();
  const call = tool({ title: "Snooze flaky checks" });
  const waiting = await form();
  github.branch = "beef000000000000000000000000000000000000";
  harness.behavior.submitInteraction(waiting.id, { post: true });
  expect(toolText(await call)).toBe("feat/qa moved on GitHub since it was shown (c0ffee0 then, beef000 now), so no PR was opened. Call open_pr again to show it as it is now.");
  expect(opens()).toEqual([]);
});

test("with the review agent drafting only, neither the tool nor Finish opens a PR", async () => {
  const { harness, store, tool, sent, opens } = await setup();
  const { preferences, revision } = await store.getPreferences();
  await store.savePreferences({ ...preferences, knobs: { ...preferences.knobs, reviewAgentActs: false } }, revision);
  expect(toolFailed(await tool({ title: "Snooze flaky checks" }))).toBe(true);
  expect(await harness.behavior.callRpc("openPr", { targetKey: KEY })).toMatchObject({ ok: false });
  expect(sent).toEqual([]);
  expect(opens()).toEqual([]);
});

test("the PR's base is the review's base as a branch; a commit asks for one, and the reviewer's named base wins", async () => {
  expect(prBase("main")).toBe("main");
  expect(prBase("origin/release/1.8.0")).toBe("release/1.8.0");
  expect(prBase("upstream/main")).toBe("main");
  expect(prBase("refs/remotes/fork/main")).toBe("main");
  expect(prBase("release/1.8.0")).toBe("release/1.8.0");
  expect(prBase("refs/heads/develop")).toBe("develop");
  expect(prBase("6251243c81c5a15e87d84926eed350082ee54bb9")).toBeNull();
  const { store, tool, form } = await setup();
  const review = (await store.getReview(KEY))!;
  await store.setLifecycle(KEY, { feature: { ...review.feature!, baseRef: "6251243c81c5a15e87d84926eed350082ee54bb9" } });
  expect(toolText(await tool({ title: "Snooze flaky checks" }))).toMatch(/base is a commit, not a branch/);
  void tool({ title: "Snooze flaky checks", base: "release/1.8.0" });
  expect((await form()).title).toBe("Open a PR from feat/qa into release/1.8.0 as @me");
});

test("in a fork's folder, Open PR opens nothing, from the tool or from Finish: its PR goes to the repo it was forked from", async () => {
  const { harness, tool, opens, github, sent, store } = await setup();
  github.fork = "upstream/api";
  github.pr = { number: 9, url: "https://github.com/acme/api/pull/9" };
  const result = await tool({ title: "Snooze flaky checks" });
  expect(toolFailed(result)).toBe(true);
  expect(toolText(result)).toBe("This folder’s repo is a fork; open its PR on GitHub. Tell the reviewer.");
  expect(await harness.behavior.callRpc("openPr", { targetKey: KEY })).toEqual({ ok: false, error: "This folder’s repo is a fork; open its PR on GitHub." });
  expect(harness.inspection.pendingInteractions).toEqual([]);
  expect(sent).toEqual([]);
  expect(opens()).toEqual([]);
  expect((await store.getReview(KEY))?.kind).toBe("ref");
});

test("Push's plan: Push and open PR on a branch with no PR, on GitHub or not; none with a PR, in a fork, or on a PR's review; GitHub's compare link to open one by hand; and whether the folder has anything to push", async () => {
  const { harness, github, store, folder } = await setup();
  const plan = () => harness.behavior.callRpc("pushPlan", { targetKey: KEY });
  const compare = "https://github.com/acme/api/compare/main...feat/qa?expand=1";
  // The folder unread: it may have.
  expect(await plan()).toEqual({ openable: true, onGithub: true, pr: false, compare, toPush: true });
  const status = { sha: PUSHED, dirty: false };
  folder.answers = { workspaceStatus: () => ({ outcome: "available", workspace: { checkout: { kind: "branch", headSha: status.sha }, workingTree: { hasUncommittedChanges: status.dirty, fileCount: 0 } } }) };
  expect(await plan()).toEqual({ openable: true, onGithub: true, pr: false, compare, toPush: false });
  status.dirty = true;
  expect(await plan()).toMatchObject({ toPush: true });
  Object.assign(status, { sha: "f".repeat(40), dirty: false });
  expect(await plan()).toMatchObject({ toPush: true });
  github.branch = null;
  expect(await plan()).toEqual({ openable: true, onGithub: false, pr: false, compare, toPush: true });
  github.branch = PUSHED;
  github.pr = { number: 7, url: "https://github.com/acme/api/pull/7" };
  expect(await plan()).toEqual({ openable: true, onGithub: true, pr: true, compare, toPush: true });
  github.fork = "upstream/api";
  expect(await plan()).toEqual({ openable: false, onGithub: false, pr: false });
  await store.saveReview({ targetKey: "pr-7", kind: "pr", repo: "acme/api", number: 7, title: "Snooze flaky checks", createdAt: 1, status: "ready" });
  expect(await harness.behavior.callRpc("pushPlan", { targetKey: "pr-7" })).toEqual({ openable: false, onGithub: false, pr: false });
});

/** open_pr's form, clicked, with GitHub answering the post with `refuse`. */
async function refused(refuse: { stdout: string; stderr: string }, raced = false) {
  const s = await setup();
  Object.assign(s.github, { refuse, raced });
  const call = s.tool({ title: "Snooze flaky checks" });
  s.harness.behavior.submitInteraction((await s.form()).id, { post: true });
  return { ...s, result: await call };
}
const status = (code: number, body: unknown) => ({ stdout: `HTTP/2.0 ${code} X\nContent-Type: application/json\n\n${JSON.stringify(body)}`, stderr: `gh: ${JSON.stringify(body)} (HTTP ${code})` });

test("a PR opened between the read and the post: GitHub's 422 is read again, and the review becomes that PR's", async () => {
  const { result, store, opens } = await refused(status(422, { message: "Validation Failed", errors: [{ resource: "PullRequest", code: "custom", message: "A pull request already exists for acme:feat/qa." }] }), true);
  expect(toolText(result)).toBe("feat/qa has PR #8 on GitHub already, so none was opened. This review is now its review, with its comments.");
  expect(opens()).toHaveLength(1);
  expect(await store.getReview(KEY)).toMatchObject({ kind: "pr", number: 8 });
});

test("GitHub's refusals in plain words: no commits beyond the base, no role, no such repo", async () => {
  const none = await refused(status(422, { message: "Validation Failed", errors: [{ resource: "PullRequest", code: "custom", message: "No commits between main and feat/qa" }] }));
  expect(toolText(none.result)).toBe("No PR was opened. The branch on GitHub has no commits beyond main yet. Commit and push your work first. (GitHub: Validation Failed — No commits between main and feat/qa)");
  expect((await none.store.getReview(KEY))?.kind).toBe("ref");
  const role = await refused(status(403, { message: "Resource not accessible" }));
  expect(toolText(role.result)).toBe("No PR was opened. Your GitHub role on this repo doesn't allow that. Ask someone with write access to do it. (GitHub: Resource not accessible)");
  const gone = await refused(status(404, { message: "Not Found" }));
  expect(toolText(gone.result)).toBe("No PR was opened. GitHub can’t find acme/api, or the GitHub login on the BB server can’t see it. Check its access with gh auth status there. (GitHub: Not Found)");
});
