// The review agent's write tools: what each posts, exactly, and only once the reviewer clicks Post or says yes.
import { beforeEach, expect, test, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { toolFailed, toolText } from "./fake-host.test-support";

const runGh = vi.hoisted(() => vi.fn());
vi.mock("./gh", async (orig) => ({ ...(await orig<any>()), runGh, runGit: vi.fn(async () => ({ stdout: "", stderr: "", code: 0 })) }));
// Who's asking, when a test says: the real reading of the agent's timeline otherwise.
const asking = vi.hoisted(() => ({ override: null as null | { asking: "direct" | "relayed" | "unattended"; message: null } }));
vi.mock("./asking", async (original) => {
  const actual = await original<typeof import("./asking")>();
  return { ...actual, directOnly: (bb: any) => { const real = actual.directOnly(bb); return async (threadId: string) => asking.override ?? await real(threadId); } };
});
vi.mock("./store-queue", async (original) => {
  const actual = await original<typeof import("./store-queue")>();
  return { ...actual, queueStore: vi.fn(actual.queueStore) };
});

import { startPlugin } from "./plugin-store.test-support";
import { ONLY_WITH_THESE_TOOLS } from "./review-agent-tools";
import { ASSISTANT_WRITE_TOOL_NAMES } from "./server-modules";

const KEY = "pr-86f279ce9c29f106-1";
const patch = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n";
const ok = (stdout = "") => ({ stdout, stderr: "", code: 0 });
/** A message in the review agent's chat: typed, or relayed from `sender`. */
let seq = 0;
const message = (text: string, at = Date.now(), sender: string | null = null) => ({ kind: "conversation", role: "user", initiator: sender ? "agent" : "user", text, createdAt: at, messageSeq: ++seq, senderThreadId: sender });

/** alice's PR acme/web#1, reviewed at sha1 by you, "me", with one draft comment; its agent is "agent". */
beforeEach(() => { asking.override = null; });

async function setup({ head = "sha1", author = "alice", ownPr = false } = {}) {
  runGh.mockReset();
  // The repo's merge settings and the PR, as GitHub's REST API gives them; a test changes them before merging.
  const github: { repo: Record<string, unknown> | null; pull: Record<string, unknown> } = {
    repo: { squashMergeCommitTitle: "PR_TITLE", squashMergeCommitMessage: "BLANK", mergeCommitTitle: "MERGE_MESSAGE", mergeCommitMessage: "PR_TITLE" },
    pull: { title: "Cache reads", body: "Reads from the cache.", commits: { totalCount: 2 }, headRefName: "cache", headRepositoryOwner: { login: "alice" } },
  };
  runGh.mockImplementation(async (args: string[]) => {
    if (args[0] === "auth") return ok("token");
    if (args[0] === "api" && args[1] === "user") return ok("me\n");
    if (args[0] === "api" && args[1] === "graphql" && args.some((a) => a.includes("viewerPermission"))) {
      return ok(JSON.stringify({ data: { viewer: { login: "me" }, repository: { viewerPermission: "WRITE", pullRequest: { state: "OPEN", headRefOid: head, author: { login: author } } }, node: { viewerCanReply: true, viewerCanResolve: true, viewerCanUnresolve: true } } }));
    }
    if (args[0] === "pr" && args[1] === "view") return ok(JSON.stringify({ headRefOid: head, baseRefName: "main", state: args.includes("state,headRefOid") ? "MERGED" : "OPEN" }));
    if (args.includes("repos/acme/web/pulls/1/reviews")) return ok(JSON.stringify({ node_id: "R1", html_url: "https://github.com/acme/web/pull/1#pullrequestreview-1", user: { login: "me" } }));
    if (args[0] === "api" && args[1]?.startsWith("repos/acme/web/compare/")) return ok("2\n");
    // The merge settings read: what a viewer can't see comes back null, beside GitHub's errors.
    if (args[0] === "api" && args[1] === "graphql" && args.some((a) => a.includes("squashMergeCommitTitle"))) {
      const unseen = { squashMergeCommitTitle: null, squashMergeCommitMessage: null, mergeCommitTitle: null, mergeCommitMessage: null };
      return { stdout: JSON.stringify({ data: { repository: { ...github.repo ?? unseen, pullRequest: github.pull } } }), stderr: "", code: github.repo ? 0 : 1 };
    }
    if (args.some((a) => a.endsWith("/replies"))) return ok(JSON.stringify({ html_url: "https://github.com/acme/web/pull/1#discussion_r9" }));
    if (args[0] === "pr" && args[1] === "comment") return ok("https://github.com/acme/web/pull/1#issuecomment-5\n");
    return ok();
  });
  let rows: unknown[] = [message("Approve it")];
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace", sdk: {
    threads: {
      get: async ({ threadId }: { threadId: string }) => ({ archivedAt: null, deletedAt: null, status: "idle", title: threadId === "agent" ? `Review agent: ${KEY}` : "Fix login race" }), send: async () => ({}), stop: async () => ({}), update: async () => ({}), archive: async () => ({}),
      timeline: async () => ({ rows }),
    },
  } as any });
  const store = await startPlugin(bb);
  await store.saveReview({ targetKey: KEY, kind: "pr", repo: "acme/web", number: 1, url: "https://github.com/acme/web/pull/1", author, base: "main", head: "cache", headSha: "sha1", createdAt: 1, status: "ready", projectId: "p1" });
  await store.savePatch(KEY, patch);
  await store.setLifecycle(KEY, { prState: "OPEN", ownPr });
  await store.setAssistantThread(KEY, "agent");
  await store.upsertDraftComment(KEY, { file: "a.ts", line: 1, side: "RIGHT", body: "Rename this." });
  await store.setVerdict(KEY, "COMMENT", "Looks fine.");
  await store.saveFeedbackThreads(KEY, [{ id: "t1", commentId: 7, reviewId: null, path: "a.ts", line: 1, originalLine: 1, startLine: null, side: "RIGHT", subjectType: "LINE", body: "Rename this.", createdAt: 1, isResolved: false, resolvedBy: null, isOutdated: false, replies: [], status: "open" } as any], null);
  const tool = (name: string, input: Record<string, unknown>) => harness.behavior.callAgentTool(name, input, { threadId: "agent" });
  /** The Post form waiting in the agent's chat, once it opens. */
  const form = async () => {
    for (let i = 0; i < 200 && !harness.inspection.pendingInteractions.length; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    return harness.inspection.pendingInteractions[0];
  };
  const writes = () => runGh.mock.calls.map(([args]) => args as string[]).filter((args) => args.includes("POST") || (args[0] === "pr" && !["view", "diff", "checks"].includes(args[1])) || args.some((a) => /resolveReviewThread|unresolveReviewThread/.test(a)));
  return { bb, harness, store, tool, form, writes, github, say: (...messages: unknown[]) => { rows = [...rows, ...messages]; }, quiet: () => { rows = []; } };
}

test("with the review agent acting, each write tool's instructions say it posts only with these tools, never from its shell (MF3)", async () => {
  const { harness } = await setup();
  const { tools } = await harness.behavior.resolveAgentConfiguration({
    pluginMetadata: {}, thread: { id: "agent", title: `Review agent: ${KEY}`, parentThreadId: null, sourceThreadId: null },
    project: { id: "p1", kind: "personal", name: "Personal", gitRemoteUrl: null }, environment: { id: "e", name: null, path: null, workspaceProvisionType: "unmanaged", branchName: null },
    host: { id: "h", name: "h" }, provider: { id: "claude-code", model: "opus", capabilities: { supportsNativeUserQuestion: false } }, origin: { kind: null, pluginId: "code-review-workspace" },
  } as any);
  for (const name of ASSISTANT_WRITE_TOOL_NAMES) expect(tools.find((t) => t.name === name)?.instructions, name).toContain(ONLY_WITH_THESE_TOOLS);
  expect(ONLY_WITH_THESE_TOOLS).toBe("Post, approve, merge, close or push only with these tools, never with gh, gh api or git push in your shell.");
});

test("submit_review shows exactly what posts, led by the verdict, and one click on Approve posts it on the reviewed commit", async () => {
  const { harness, store, tool, form, writes } = await setup();
  const call = tool("submit_review", { verdict: "APPROVE", body: "Ship it." });
  const waiting = await form();
  expect(waiting).toMatchObject({ threadId: "agent", rendererId: "post-preview", title: "Approve acme/web#1 as @me", payload: {
    title: "Approve acme/web#1 as @me", action: "Approve", button: "Approve", notes: [],
    parts: [{ label: "Summary", body: "Ship it." }, { label: "a.ts:1", body: "Rename this.", path: true }],
  } });
  expect(writes()).toEqual([]);
  harness.behavior.submitInteraction(waiting.id, { post: true });
  expect(toolText(await call)).toBe("Posted the review to GitHub: https://github.com/acme/web/pull/1#pullrequestreview-1");
  const [post] = runGh.mock.calls.filter(([args]) => args.includes("repos/acme/web/pulls/1/reviews"));
  expect(JSON.parse(post[1].stdin)).toEqual({ event: "APPROVE", body: "Ship it.", commit_id: "sha1", comments: [{ path: "a.ts", line: 1, side: "RIGHT", body: "Rename this." }] });
  expect((await store.getReview(KEY))?.activity).toEqual([expect.objectContaining({ text: "Submitted Approve with 1 comment", asking: "direct", url: "https://github.com/acme/web/pull/1#pullrequestreview-1" })]);
});

test("a typed yes after the form opened posts it once and closes the form; a second yes, or the form, posts nothing more (SF6)", async () => {
  const { harness, tool, form, writes, say } = await setup();
  const input = { action: "comment", body: "CI is flaky; rerunning." };
  const call = tool("github_pr", input);
  await form();
  // A yes typed before the form showed it isn't one.
  expect(toolFailed(await tool("github_pr", { ...input, confirm: "yes" }))).toBe(true);
  say(message("yes, post it", Date.now() + 1_000));
  expect(toolText(await tool("github_pr", { ...input, confirm: "yes" }))).toBe("Posted the comment: https://github.com/acme/web/pull/1#issuecomment-5");
  // The form it answered closed, without posting.
  expect(harness.inspection.pendingInteractions).toEqual([]);
  expect(toolFailed(await call)).toBe(true);
  expect(toolText(await tool("github_pr", { ...input, confirm: "yes" }))).toMatch(/posted already/);
  expect(writes()).toEqual([["pr", "comment", "1", "-R", "acme/web", "--body-file", "-"]]);
});

test("only a short yes to the form's own action counts: a condition, a change, a no, or another verb doesn't", async () => {
  const { harness, tool, form, writes, say } = await setup();
  const ask = async (input: Record<string, unknown>, answer: string, at: number) => {
    void tool(input.action ? "github_pr" : "submit_review", input);
    await form();
    say(message(answer, at));
    const result = await tool(input.action ? "github_pr" : "submit_review", { ...input, confirm: "yes" });
    harness.behavior.cancelInteraction(harness.inspection.pendingInteractions[0].id);
    await vi.waitFor(() => expect(harness.inspection.pendingInteractions).toEqual([]));
    return result;
  };
  let at = Date.now() + 1_000;
  const comment = { action: "comment", body: "Thanks!" };
  for (const answer of ["ok, but change the summary first", "go away", "Don't post it", "wait", "yes?", "sure, and add that CI is flaky"]) {
    expect(toolFailed(await ask(comment, answer, at += 1_000)), answer).toBe(true);
  }
  expect(toolFailed(await ask({ action: "merge", method: "squash" }, "close it", at += 1_000)), "close it, to a Merge").toBe(true);
  expect(toolFailed(await ask({ verdict: "APPROVE" }, "post it as a comment instead", at += 1_000)), "a Comment, to an Approve").toBe(true);
  expect(writes()).toEqual([]);
  for (const answer of ["yes", "Go ahead!", "ok", "ship it", "approve it"]) {
    const { affirms } = await import("./post-preview");
    expect(affirms(answer, "Approve"), answer).toBe(true);
  }
});

test("a yes to text that changed since it was shown shows it again, and posts nothing", async () => {
  const { harness, tool, form, writes, say } = await setup();
  void tool("post_reply", { threadId: "t1", body: "Fixed in abc." });
  await form();
  say(message("yes", Date.now() + 1_000));
  // The agent's text isn't what the form showed: the yes isn't for it.
  const again = tool("post_reply", { threadId: "t1", body: "Fixed in abc123.", confirm: "yes" });
  await vi.waitFor(() => expect(harness.inspection.pendingInteractions[0]?.payload).toMatchObject({ parts: [{ body: "Fixed in abc123." }] }));
  expect(harness.inspection.pendingInteractions).toHaveLength(1);
  expect(writes()).toEqual([]);
  harness.behavior.cancelInteraction(harness.inspection.pendingInteractions[0].id);
  expect(toolText(await again)).toBe("The reviewer closed the form, so nothing was posted.");
});

test("a draft that changed after the form showed it isn't posted by the click", async () => {
  const { harness, store, tool, form, writes } = await setup();
  const call = tool("submit_review", { verdict: "COMMENT" });
  const waiting = await form();
  await store.upsertDraftComment(KEY, { file: "a.ts", line: 1, side: "LEFT", body: "And this." });
  harness.behavior.submitInteraction(waiting.id, {});
  expect(toolText(await call)).toBe("The draft or the review changed since it was shown, so nothing was posted. Call submit_review again to show it as it is now.");
  expect(writes()).toEqual([]);
});

test("a click once Settings has the agent drafting only posts nothing", async () => {
  const { harness, store, tool, form, writes } = await setup();
  const call = tool("github_pr", { action: "comment", body: "Thanks!" });
  const waiting = await form();
  const { preferences, revision } = await store.getPreferences();
  await store.savePreferences({ ...preferences, knobs: { ...preferences.knobs, reviewAgentActs: false } }, revision);
  harness.behavior.submitInteraction(waiting.id, {});
  expect(toolText(await call)).toMatch(/^Settings has the review agent drafting only now/);
  expect(writes()).toEqual([]);
});

test("just post it, in the reviewer's own message, posts without the form, once per message; anything else doesn't", async () => {
  const { harness, tool, writes, say } = await setup();
  expect(toolFailed(await tool("github_pr", { action: "comment", body: "Thanks!", confirm: "just-post-it" }))).toBe(true);
  for (const text of ["Don't just post it, show me", "there's no preview", "no, just post it"]) {
    say(message(text, Date.now() + 500));
    expect(toolFailed(await tool("github_pr", { action: "comment", body: "Thanks!", confirm: "just-post-it" })), text).toBe(true);
  }
  say(message("say thanks on the PR, just post it", Date.now() + 1_000));
  expect(toolText(await tool("github_pr", { action: "comment", body: "Thanks!", confirm: "just-post-it" }))).toMatch(/^Posted the comment/);
  // The same message doesn't post a second write.
  expect(toolText(await tool("github_pr", { action: "comment", body: "And thanks again!", confirm: "just-post-it" }))).toMatch(/already confirmed another post/);
  // An approval, merge or close skips the form only when the message names it.
  say(message("thanks, just post it", Date.now() + 2_000));
  expect(toolText(await tool("github_pr", { action: "merge", method: "squash", confirm: "just-post-it" }))).toMatch(/just the command, such as "just merge it"/);
  expect(harness.inspection.pendingInteractions).toEqual([]);
  expect(writes()).toHaveLength(1);
});

test("new commits since the review are the one pushback; asked again with force, the form says so in its own words and Approve posts on the reviewed commit", async () => {
  const { harness, tool, form, writes } = await setup({ head: "sha2" });
  const pushed = await tool("submit_review", { verdict: "APPROVE", body: "LGTM" });
  expect(toolText(pushed)).toBe("Nothing was posted. 2 new commits since you reviewed. Approving now covers them unseen. Tell the reviewer; if they want it posted anyway, call submit_review again with force: true.");
  const call = tool("submit_review", { verdict: "APPROVE", body: "LGTM", force: true });
  const waiting = await form();
  expect(waiting.payload).toMatchObject({ notes: ["2 new commits since you reviewed. Approving now covers them unseen."] });
  harness.behavior.submitInteraction(waiting.id, {});
  expect(toolText(await call)).toMatch(/^Posted the review/);
  const [post] = runGh.mock.calls.filter(([args]) => args.includes("repos/acme/web/pulls/1/reviews"));
  expect(JSON.parse(post[1].stdin).commit_id).toBe("sha1");
  expect(writes()).toHaveLength(1);
});

test("submitted anyway, comments GitHub can't place show in the summary, as they post", async () => {
  const { harness, store, tool, form } = await setup();
  await store.upsertDraftComment(KEY, { file: "a.ts", line: 9, side: "RIGHT", body: "Not in the diff." });
  const call = tool("submit_review", { verdict: "COMMENT", force: true });
  const waiting = await form();
  expect(waiting.payload).toMatchObject({
    notes: ["Comments outside the diff post in the summary, as shown."],
    parts: [{ label: "Summary", body: "Looks fine.\n\n- On `a.ts:9` (an earlier diff): Not in the diff." }, { label: "a.ts:1", body: "Rename this." }],
  });
  harness.behavior.cancelInteraction(waiting.id);
  await call;
});

test("on your own PR, an approval is refused before anything shows, offering a Comment review", async () => {
  const { tool, writes, harness } = await setup({ author: "me", ownPr: true });
  expect(toolText(await tool("submit_review", { verdict: "APPROVE" }))).toBe("GitHub allows only a Comment review on your own PR, so nothing was posted. Offer to post it as a Comment review instead.");
  expect(harness.inspection.pendingInteractions).toEqual([]);
  expect(writes()).toEqual([]);
});

test("a turn the reviewer didn't start only marks the suggested verdict, never the verdict, opening no form and posting nothing (SF5)", async () => {
  const { store, tool, writes, harness } = await setup();
  asking.override = { asking: "unattended", message: null };
  expect(toolText(await tool("submit_review", { verdict: "APPROVE" }))).toMatch(/^Marked Approve as your suggested verdict/);
  expect(await store.getDraft(KEY)).toMatchObject({ verdict: "COMMENT", suggestedVerdict: "APPROVE", body: "Looks fine." });
  expect(toolFailed(await tool("github_pr", { action: "add-label", names: ["bug"] }))).toBe(true);
  expect(toolFailed(await tool("resolve_thread", { threadId: "t1" }))).toBe(true);
  expect(toolFailed(await tool("github_pr", { action: "comment", body: "Hi", confirm: "just-post-it" }))).toBe(true);
  expect(harness.inspection.pendingInteractions).toEqual([]);
  expect(writes()).toEqual([]);
});

test("a relayed approve, merge or close is refused: the reviewer approves in the review", async () => {
  const { tool, say, quiet, writes, harness } = await setup();
  quiet();
  say(message("approve it", Date.now(), "thr_orchestrator"));
  for (const [name, input] of [["submit_review", { verdict: "APPROVE" }], ["github_pr", { action: "merge", method: "squash" }], ["github_pr", { action: "close" }]] as const) {
    expect(toolText(await tool(name, input)), name).toBe("Approving, merging and closing need the reviewer's own message or click in this review. Nothing was done: ask them here.");
  }
  expect(harness.inspection.pendingInteractions).toEqual([]);
  expect(writes()).toEqual([]);
});

test("relayed, a label or a resolve on someone else's PR waits for the reviewer's click; on their own PR it's done", async () => {
  const { harness, store, tool, form, quiet, say, writes } = await setup();
  quiet();
  say(message("label it needs-qa", Date.now(), "thr_orchestrator"));
  const call = tool("github_pr", { action: "add-label", names: ["needs-qa"] });
  const waiting = await form();
  expect(waiting).toMatchObject({ title: "Change acme/web#1 as @me", payload: { button: "Apply", details: ["Adds the label needs-qa."], notes: ["Asked from another thread, on someone else's PR."] } });
  expect(writes()).toEqual([]);
  harness.behavior.submitInteraction(waiting.id, {});
  expect(toolText(await call)).toBe("Added label needs-qa.");
  expect(writes()).toEqual([["pr", "edit", "1", "-R", "acme/web", "--add-label=needs-qa"]]);
  expect((await store.getReview(KEY))?.activity?.at(-1)).toMatchObject({ text: "Added label needs-qa", asking: "relayed", from: "thr_orchestrator", fromTitle: "Fix login race" });
  const resolve = tool("resolve_thread", { threadId: "t1" });
  await form();
  expect(writes()).toHaveLength(1);
  harness.behavior.cancelInteraction(harness.inspection.pendingInteractions[0].id);
  expect(toolFailed(await resolve)).toBe(true);
  // Your own PR: a relay counts as yours.
  const own = await setup({ author: "me", ownPr: true });
  own.quiet();
  own.say(message("label it", Date.now(), "thr_orchestrator"));
  expect(toolText(await own.tool("github_pr", { action: "add-label", names: ["bug"] }))).toBe("Added label bug.");
  expect(own.harness.inspection.pendingInteractions).toEqual([]);
}, 15_000);

test("with Settings' switch off, the tools a running agent kept do nothing", async () => {
  const { store, tool, writes } = await setup();
  const { preferences } = await store.getPreferences();
  await store.savePreferences({ ...preferences, knobs: { ...preferences.knobs, reviewAgentActs: false } }, (await store.getPreferences()).revision);
  expect(toolText(await tool("github_pr", { action: "add-label", names: ["bug"] }))).toMatch(/^Settings has the review agent drafting only now/);
  expect(writes()).toEqual([]);
});

test("labels, reviewers, assignees, reopen and ready go to gh as fixed argument lists, each onto the review's activity", async () => {
  const { store, tool, writes } = await setup();
  const cases: [Record<string, unknown>, string[], string][] = [
    [{ action: "add-label", names: ["bug", "ux"] }, ["pr", "edit", "1", "-R", "acme/web", "--add-label=bug,ux"], "Added label bug,ux"],
    [{ action: "add-reviewer", names: ["flocasts/live-dev"] }, ["pr", "edit", "1", "-R", "acme/web", "--add-reviewer=flocasts/live-dev"], "Requested review from flocasts/live-dev"],
    [{ action: "remove-assignee", names: ["bob"] }, ["pr", "edit", "1", "-R", "acme/web", "--remove-assignee=bob"], "Unassigned @bob"],
    [{ action: "draft" }, ["pr", "ready", "1", "-R", "acme/web", "--undo"], "Marked as a draft"],
  ];
  for (const [input, args, activity] of cases) {
    runGh.mockClear();
    expect(toolFailed(await tool("github_pr", input)), JSON.stringify(input)).toBe(false);
    expect(writes()).toEqual([args]);
    expect((await store.getReview(KEY))?.activity?.at(-1)?.text).toBe(activity);
  }
}, 15_000);

test("an edit, a close and a merge show first, the merge with the commit message that lands, and post their fixed argument lists on the click", async () => {
  const { harness, store, tool, form, writes } = await setup();
  await store.saveReview({ ...(await store.getReview(KEY))!, title: "Cache reads" });
  const edit = tool("github_pr", { action: "edit", title: "Fix login race" });
  harness.behavior.submitInteraction((await form()).id, {});
  expect(toolText(await edit)).toBe("Changed the title.");
  const merge = tool("github_pr", { action: "merge", method: "squash", deleteBranch: true });
  const waiting = await form();
  expect(waiting).toMatchObject({ title: "Merge acme/web#1 as @me", payload: { button: "Merge", notes: [],
    parts: [{ label: "Commit title", body: "Cache reads (#1)" }],
    details: ["Squashed into one commit, at sha1, the commit you reviewed.", "No commit description.", "Then it deletes the branch."] } });
  harness.behavior.submitInteraction(waiting.id, {});
  expect(toolText(await merge)).toBe("Merged.");
  const close = tool("github_pr", { action: "close" });
  expect((await form())).toMatchObject({ title: "Close acme/web#1 as @me", payload: { button: "Close" } });
  harness.behavior.cancelInteraction(harness.inspection.pendingInteractions[0].id);
  expect(toolFailed(await close)).toBe(true);
  expect(writes()).toEqual([
    ["pr", "edit", "1", "-R", "acme/web", "--title", "Fix login race"],
    ["pr", "merge", "1", "-R", "acme/web", "--squash", "--match-head-commit", "sha1", "--subject", "Cache reads (#1)", "--body", "", "--delete-branch"],
  ]);
}, 15_000);

test("a reply shows where it goes, and the click posts it onto the activity", async () => {
  const { harness, store, tool, form, writes } = await setup();
  const call = tool("post_reply", { threadId: "t1", body: "Done in abc123." });
  const waiting = await form();
  expect(waiting.payload).toMatchObject({ action: "Reply", button: "Post", parts: [{ label: "Reply on a.ts:1", body: "Done in abc123." }] });
  harness.behavior.submitInteraction(waiting.id, {});
  expect(toolText(await call)).toBe("Posted the reply: https://github.com/acme/web/pull/1#discussion_r9");
  expect(writes()).toEqual([["api", "-X", "POST", "repos/acme/web/pulls/1/comments/7/replies", "--input", "-", "-i"]]);
  expect((await store.getReview(KEY))?.activity?.at(-1)?.text).toBe("Posted reply on a.ts:1");
});

test("asked in chat, the agent may change the reviewer's own comment, marked as its edit; in a turn the reviewer didn't start it may not", async () => {
  const { store, tool, quiet } = await setup();
  const at = { file: "a.ts", line: 1, side: "RIGHT" };
  expect(toolText(await tool("edit_draft_comment", { ...at, body: "Rename this to cacheKey." }))).toBe("Updated the reviewer's draft comment on a.ts:1, as they asked.");
  expect((await store.getDraft(KEY)).comments[0]).toMatchObject({ body: "Rename this to cacheKey.", editedBy: "agent" });
  quiet();
  expect(toolFailed(await tool("edit_draft_comment", { ...at, body: "Something else." }))).toBe(true);
  expect(toolFailed(await tool("delete_draft_comment", at))).toBe(true);
  expect((await store.getDraft(KEY)).comments).toHaveLength(1);
});

test("a message bb gives no messageSeq can't be told apart, so it confirms nothing", async () => {
  const { tool, say, writes } = await setup();
  const { messageSeq: _seq, ...unnumbered } = message("say thanks, just post it", Date.now() + 1_000);
  say(unnumbered);
  expect(toolText(await tool("github_pr", { action: "comment", body: "Thanks!", confirm: "just-post-it" }))).toMatch(/can't be told apart/);
  expect(writes()).toEqual([]);
});

// The rule: an approve, request changes, merge or close skips the form only when the whole message is a short command
// for exactly that. Matching intent in free text keeps missing cases, so these take an allowlist.
test("an approve, request changes, merge or close skips the form only when the whole message is its short command", async () => {
  const { justPost } = await import("./post-preview");
  for (const text of ["merge it after CI, just post it a reply", 'Reply "LGTM, just merge it" to Sam', "don't merge it, just post it", "Comment that it's ready to merge, just post it",
    "We can't merge until CI is green, say so, just post it", "merge it once CI passes", "merge it if checks pass"]) expect(justPost(text, "merge"), text).toBe(false);
  for (const text of ["Comment: approve it later. Just post it", "Reply that I approve of the approach, just post it", "just merge it"]) expect(justPost(text, "approve"), text).toBe(false);
  for (const text of ["just merge it", "ok, merge it, just post it", "Merge it, thanks!"]) expect(justPost(text, "merge"), text).toBe(true);
  for (const text of ["approve it and just post it", "just approve it please", "approve it, just post it"]) expect(justPost(text, "approve"), text).toBe(true);
  expect(justPost("just request changes", "request-changes")).toBe(true);
  expect(justPost("just close it", "close")).toBe(true);
  // A named action authorizes only itself.
  for (const verb of ["post", "request-changes", "close"] as const) expect(justPost("just merge it", verb), verb).toBe(false);
  for (const text of ["please just post it", "ok just post it", "say thanks, just post it"]) expect(justPost(text, "post"), text).toBe(true);
  // A question, or anything but words and punctuation, isn't a bare command.
  for (const text of ["merge it?", "merge it ❌", "merge it 10:30", "merge it не"]) expect(justPost(text, "merge"), text).toBe(false);
  expect(justPost("just approve it?", "approve")).toBe(false);
  expect(justPost("close it?", "close")).toBe(false);
  // An approve, request changes, merge or close command authorizes no other post.
  for (const text of ["approve it, just post it", "merge it, just post it", "request changes, just post it", "close it and just post it"]) expect(justPost(text, "post"), text).toBe(false);
});

test("genuine yeses count, each to its own form: go for it, go ahead and post it, approved; remove it isn't a yes to Add label", async () => {
  const { affirms } = await import("./post-preview");
  expect(affirms("go for it", "Post")).toBe(true);
  expect(affirms("go ahead and post it", "Post")).toBe(true);
  expect(affirms("approved", "Approve")).toBe(true);
  expect(affirms("approved", "Merge")).toBe(false);
  expect(affirms("add it", "Apply", "Add label")).toBe(true);
  expect(affirms("remove it", "Apply", "Add label")).toBe(false);
  expect(affirms("request review", "Apply", "Remove review request")).toBe(false);
  expect(affirms("remove it", "Apply", "Remove review request")).toBe(true);
});

test("the reviewer's own command merges without the form, and a mention of merging doesn't", async () => {
  const { tool, say, writes, harness } = await setup();
  say(message("Comment that it's ready to merge, just post it", Date.now() + 1_000));
  expect(toolFailed(await tool("github_pr", { action: "merge", method: "squash", confirm: "just-post-it" }))).toBe(true);
  say(message("checks passed, just merge it", Date.now() + 2_000));
  expect(toolFailed(await tool("github_pr", { action: "merge", method: "squash", confirm: "just-post-it" }))).toBe(true);
  say(message("Just merge it.", Date.now() + 3_000));
  expect(toolText(await tool("github_pr", { action: "merge", method: "squash", confirm: "just-post-it" }))).toBe("Merged.");
  expect(harness.inspection.pendingInteractions).toEqual([]);
  expect(writes()).toEqual([["pr", "merge", "1", "-R", "acme/web", "--squash", "--match-head-commit", "sha1", "--subject", "Cache reads (#1)", "--body", ""]]);
});

test("approve it, just post it approves without the form", async () => {
  const { tool, say, harness } = await setup();
  say(message("approve it, just post it", Date.now() + 1_000));
  expect(toolText(await tool("submit_review", { verdict: "APPROVE", confirm: "just-post-it" }))).toMatch(/^Posted the review/);
  expect(harness.inspection.pendingInteractions).toEqual([]);
});

test("a refused just post it leaves the form that's open be", async () => {
  const { tool, form, say, harness } = await setup();
  void tool("github_pr", { action: "comment", body: "Thanks!" });
  const waiting = await form();
  say(message("thanks, just post it", Date.now() + 1_000));
  expect(toolFailed(await tool("github_pr", { action: "merge", method: "squash", confirm: "just-post-it" }))).toBe(true);
  expect(harness.inspection.pendingInteractions.map((f) => f.id)).toEqual([waiting.id]);
  harness.behavior.cancelInteraction(waiting.id);
});

// The merge commit's message, as this repo's settings make it.
const mergeForm = async (setupDone: Awaited<ReturnType<typeof setup>>, method: string) => {
  void setupDone.tool("github_pr", { action: "merge", method });
  const waiting = await setupDone.form();
  setupDone.harness.behavior.submitInteraction(waiting.id, {});
  await vi.waitFor(() => expect(setupDone.writes().length).toBe(1));
  return { payload: waiting.payload as any, args: setupDone.writes()[0] };
};

test("a squash set to the PR's title and description shows both and sends both", async () => {
  const s = await setup();
  s.github.repo = { squashMergeCommitTitle: "PR_TITLE", squashMergeCommitMessage: "PR_BODY" };
  const { payload, args } = await mergeForm(s, "squash");
  expect(payload.parts).toEqual([{ label: "Commit title", body: "Cache reads (#1)" }, { label: "Commit description", body: "Reads from the cache." }]);
  expect(args).toEqual(["pr", "merge", "1", "-R", "acme/web", "--squash", "--match-head-commit", "sha1", "--subject", "Cache reads (#1)", "--body", "Reads from the cache."]);
});

test("a squash left to the commits' messages sends the title only, and the form says the description is the repo's default", async () => {
  const s = await setup();
  s.github.repo = { squashMergeCommitTitle: "PR_TITLE", squashMergeCommitMessage: "COMMIT_MESSAGES" };
  const { payload, args } = await mergeForm(s, "squash");
  expect(payload.details).toContain("Commit description: this repo's default (the commits' messages).");
  expect(args).toEqual(["pr", "merge", "1", "-R", "acme/web", "--squash", "--match-head-commit", "sha1", "--subject", "Cache reads (#1)"]);
});

test("a one-commit squash titled by its commit, or a repo whose settings GitHub didn't give, sends no message at all", async () => {
  const s = await setup();
  s.github.repo = { squashMergeCommitTitle: "COMMIT_OR_PR_TITLE", squashMergeCommitMessage: "COMMIT_MESSAGES" };
  s.github.pull = { ...s.github.pull, commits: { totalCount: 1 } };
  const { payload, args } = await mergeForm(s, "squash");
  expect(payload.parts).toEqual([]);
  expect(payload.details).toContain("Commit message: this repo's default (the commits' messages).");
  expect(args).toEqual(["pr", "merge", "1", "-R", "acme/web", "--squash", "--match-head-commit", "sha1"]);
  const t = await setup();
  t.github.repo = null;
  expect((await mergeForm(t, "squash")).args).toEqual(["pr", "merge", "1", "-R", "acme/web", "--squash", "--match-head-commit", "sha1"]);
});

test("a merge commit from a fork names the fork's owner, as GitHub does", async () => {
  const s = await setup();
  s.github.pull = { ...s.github.pull, headRepositoryOwner: { login: "alice-fork" } };
  const { payload, args } = await mergeForm(s, "merge");
  expect(payload.parts).toEqual([{ label: "Commit title", body: "Merge pull request #1 from alice-fork/cache" }, { label: "Commit description", body: "Cache reads" }]);
  expect(args).toEqual(["pr", "merge", "1", "-R", "acme/web", "--merge", "--match-head-commit", "sha1", "--subject", "Merge pull request #1 from alice-fork/cache", "--body", "Cache reads"]);
});

test("a merge commit whose settings GitHub didn't give shows GitHub's default, and sends no message", async () => {
  const s = await setup();
  s.github.repo = null;
  const { payload, args } = await mergeForm(s, "merge");
  expect(payload.details).toContain('Commit message: GitHub\'s default, "Merge pull request #1 from alice/cache".');
  expect(args).toEqual(["pr", "merge", "1", "-R", "acme/web", "--merge", "--match-head-commit", "sha1"]);
});

test("just post it, typed while the form for that same post is open, posts it once and closes the form", async () => {
  const { harness, tool, form, say, writes } = await setup();
  const input = { action: "comment", body: "Thanks!" };
  const call = tool("github_pr", input);
  const waiting = await form();
  say(message("thanks, just post it", Date.now() + 1_000));
  expect(toolText(await tool("github_pr", { ...input, confirm: "just-post-it" }))).toMatch(/^Posted the comment/);
  expect(harness.inspection.pendingInteractions).toEqual([]);
  expect(toolFailed(await call)).toBe(true);
  // A click that raced it posts nothing more.
  expect(() => harness.behavior.submitInteraction(waiting.id, {})).toThrow();
  expect(writes()).toHaveLength(1);
});
