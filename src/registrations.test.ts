// What the plugin registers with BB: its RPC methods, agent tools, CLI subcommands, event listeners, services and
// schedules, and the tools each kind of thread gets. Moving code between the server's modules changes none of it.
import { test, expect, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type { PluginAgentConfigurationContext } from "@get-bb/plugin-sdk";
import { startPlugin } from "./plugin-store.test-support";
import { merge, SUBCOMMANDS } from "./server-modules";

vi.mock("./store-queue", async (original) => {
  const actual = await original<typeof import("./store-queue")>();
  return { ...actual, queueStore: vi.fn(actual.queueStore) };
});

const context = (threadId: string, pluginId: string | null = "code-review-workspace") => ({
  pluginMetadata: {},
  thread: { id: threadId, title: "Thread", parentThreadId: null, sourceThreadId: null },
  project: { id: "p1", kind: "personal", name: "Personal", gitRemoteUrl: null },
  environment: { id: "env-1", name: null, path: null, workspaceProvisionType: "unmanaged", branchName: null },
  host: { id: "host-1", name: "test-host" },
  provider: { id: "claude-code", model: "opus", capabilities: { supportsNativeUserQuestion: false } },
  origin: { kind: null, pluginId },
}) as PluginAgentConfigurationContext;

test("the plugin registers the same RPC methods, tools, CLI subcommands, listeners, services and schedules", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace", agentSkillIds: ["code-review-workspace", "code-review-workspace-generate"] });
  const store = await startPlugin(bb);
  const registered = harness.inspection.registrations;

  expect([...registered.rpcMethods].sort()).toMatchInlineSnapshot(`
    [
      "applyPluginUpdate",
      "approveReady",
      "archiveReview",
      "askAgent",
      "checkFeature",
      "checkFeedback",
      "checkFixes",
      "checkForUpdates",
      "checkPluginUpdates",
      "checkPr",
      "checkRepoAccess",
      "deleteFilterView",
      "deleteReview",
      "digDeeper",
      "discardReplyDraft",
      "dismissDiscussion",
      "dismissFlagged",
      "dismissInstructionSuggestion",
      "dismissKeptBranch",
      "dismissPush",
      "dismissReady",
      "getAgentDefaults",
      "getAgentLearning",
      "getCheckFailures",
      "getCheckLog",
      "getChecks",
      "getCodeOwners",
      "getConversation",
      "getDraft",
      "getFeedback",
      "getFileContents",
      "getFileViews",
      "getGeneratedFiles",
      "getGhAccounts",
      "getNotPushed",
      "getPrCommits",
      "getPreferences",
      "getProviderModes",
      "getReleaseStatus",
      "getReplyDrafts",
      "getReviewBundle",
      "getReviewThreads",
      "getReviewerNotes",
      "getSetupStatus",
      "getSinceReview",
      "getSourceThread",
      "includeHidden",
      "listFilterViews",
      "listMachines",
      "listReviews",
      "markSeen",
      "moveToSummary",
      "newConversation",
      "noteInserted",
      "openPr",
      "pinReview",
      "push",
      "refreshFeedback",
      "refreshReviews",
      "removeDraftComment",
      "renameReview",
      "reopenComment",
      "replyToFeedback",
      "replyToThread",
      "rereview",
      "resolveComment",
      "resolveThread",
      "reviewFolderBranch",
      "reviewThreadChanges",
      "rewriteGuide",
      "runSkipped",
      "saveDraftComment",
      "saveFilterView",
      "savePreferences",
      "saveReplyDraft",
      "saveReviewerNotes",
      "saveSummary",
      "sendApprovalToSourceThread",
      "sendNow",
      "sendToSourceThread",
      "setAutomaticUpdates",
      "setFileViewed",
      "setFilesViewed",
      "setLetPush",
      "setMainThread",
      "setRemovalReason",
      "setReviewPresence",
      "setVerdict",
      "snoozeReview",
      "startConversation",
      "startFixThread",
      "startReview",
      "startTrackedReview",
      "stopGuide",
      "submitReview",
      "suggestAssistantInstructions",
      "switchGhAccount",
      "threadLinks",
      "threadReview",
      "undoAgentChange",
      "unresolveThread",
      "updateFeature",
      "useSuggestedVerdict",
    ]
  `);
  expect(registered.agentTools.map((tool) => tool.name)).toMatchInlineSnapshot(`
    [
      "read_review_patch",
      "list_review_files",
      "list_draft_comments",
      "add_draft_comment",
      "edit_draft_comment",
      "delete_draft_comment",
      "set_review_summary",
      "reply_in_discussion",
      "list_feedback",
      "read_changes_since_review",
      "read_pr_context",
      "read_file",
      "assess_feedback",
      "draft_thread_reply",
      "submit_review",
      "post_reply",
      "resolve_thread",
      "github_pr",
      "open_pr",
      "generate_review_guide",
      "send_now",
      "push",
    ]
  `);
  // What agents read of each tool, word for word.
  expect(registered.agentTools.map(({ name, description, instructions, presentation, inputSchema }) => ({ name, description, instructions, presentation, inputSchema }))).toMatchSnapshot();
  const { run: _run, ...cli } = registered.cli!;
  expect(cli).toMatchInlineSnapshot(`
    {
      "commands": [
        {
          "name": "review",
          "summary": "Review this thread's folder, or a PR or ref",
          "usage": "bb review [<pr-url | owner/repo#n | pr-number | git-ref> [--base <ref>]] [--context <text>] [--name <text>]",
        },
        {
          "name": "comment",
          "summary": "List, add, edit, or delete a review's local draft comments; never posts to GitHub",
          "usage": "bb review comment <list | add | edit | delete> <review> [<file>:<line>] [--side LEFT|RIGHT] [--code <text>] [--body <text>] [--severity <severity>] [--evidence <text>] [--pre-existing] [--json]",
        },
        {
          "name": "summary",
          "summary": "Show or write a review's local review summary and suggested verdict; never posts to GitHub",
          "usage": "bb review summary <review> [--json] | [--body <text> [--suggest APPROVE|COMMENT|REQUEST_CHANGES]]",
        },
        {
          "name": "list",
          "summary": "List your reviews, in Needs review's order, with whose turn it is",
          "usage": "bb review list [--json]",
        },
        {
          "name": "ask",
          "summary": "Send a message to a review's agent, relayed from this thread, starting the agent if needed",
          "usage": "bb review ask <review> <text>",
        },
        {
          "name": "approve",
          "summary": "Line PRs' approvals up in Needs review for the reviewer's click; never posts",
          "usage": "bb review approve <review…> [--body <text>]",
        },
        {
          "name": "report",
          "summary": "Say what you did with a comment the reviewer sent you, done or declined, or which commit Push pushes",
          "usage": "bb review report <id> done|declined [--note <text>] [--commit <sha>] | --commit <sha>",
        },
        {
          "name": "ready",
          "summary": "Say you've finished with the comments the reviewer sent you, for them to re-review",
          "usage": "bb review ready [<review>]",
        },
        {
          "name": "storage",
          "summary": "Show where the reviews are kept, and move them between SQLite and Postgres",
          "usage": "bb review storage <status | verify | migrate | export-sqlite [--replace-data-db]>",
        },
      ],
      "name": "review",
      "rendersHelp": true,
      "summary": "Open a review of a GitHub PR or local git ref in Code Review Workspace, or change its local draft",
    }
  `);
  // Only the events it listens to: the SDK lists every event it knows.
  expect(Object.fromEntries(Object.entries(registered.threadEventHandlers).filter(([, count]) => count > 0))).toMatchInlineSnapshot(`
    {
      "experimental_environment.removed": 2,
      "experimental_thread.events": 1,
      "message.cancelled": 3,
      "message.dispatched": 3,
      "thread.active": 1,
      "thread.archived": 2,
      "thread.deleted": 3,
      "thread.failed": 5,
      "thread.idle": 5,
      "thread.unarchived": 1,
    }
  `);
  expect(registered.services.map(({ name }) => name)).toMatchInlineSnapshot(`
    [
      "plugin-updates",
      "review-state",
    ]
  `);
  expect(registered.schedules.map(({ name, cron }) => ({ name, cron }))).toMatchInlineSnapshot(`
    [
      {
        "cron": "17 4 * * *",
        "name": "prune-old-diffs",
      },
    ]
  `);

  // The tools and skills each thread gets: a review's assistant and guide writer, another thread of the plugin's, and yours.
  await store.saveReview({ targetKey: "pr-1", kind: "pr", number: 1, status: "ready", createdAt: 1, projectId: "p1" });
  await store.setAssistantThread("pr-1", "assistant");
  const generation = await store.beginGeneration("pr-1");
  await store.setGenerationWorker("pr-1", generation, "writer");
  const configure = registered.agentConfigurationProvider!;
  const given = (asked: PluginAgentConfigurationContext) => {
    const { tools, skills } = configure(asked);
    return { tools, skills };
  };
  expect({
    assistant: given(context("assistant")),
    writer: given(context("writer")),
    other: given(context("other")),
    yours: given(context("yours", null)),
  }).toMatchInlineSnapshot(`
    {
      "assistant": {
        "skills": [],
        "tools": [
          "read_review_patch",
          "list_review_files",
          "list_draft_comments",
          "add_draft_comment",
          "edit_draft_comment",
          "delete_draft_comment",
          "set_review_summary",
          "reply_in_discussion",
          "list_feedback",
          "read_changes_since_review",
          "read_pr_context",
          "read_file",
          "assess_feedback",
          "draft_thread_reply",
          "submit_review",
          "post_reply",
          "resolve_thread",
          "github_pr",
          "open_pr",
          "send_now",
          "push",
        ],
      },
      "other": {
        "skills": [],
        "tools": [],
      },
      "writer": {
        "skills": [
          "code-review-workspace-generate",
        ],
        "tools": [
          "read_review_patch",
          "list_review_files",
          "read_changes_since_review",
          "read_pr_context",
          "generate_review_guide",
        ],
      },
      "yours": {
        "skills": [
          "code-review-workspace",
        ],
        "tools": [],
      },
    }
  `);
});

test("bb review runs a subcommand by its own name only: a name every object has is a ref to review", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace" });
  await startPlugin(bb);
  for (const name of ["constructor", "toString", "__proto__"]) {
    // As git answers for any revision this checkout doesn't have.
    expect(await harness.behavior.runCli([name], { projectId: "p1", cwd: process.cwd() })).toEqual({ exitCode: 1, stdout: "", stderr: `fatal: bad revision '${name}'\n` });
  }
});

test("each subcommand bb review's help lists, but review and storage, runs from a module, never as a ref to review", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace" });
  await startPlugin(bb);
  for (const { name } of SUBCOMMANDS.filter(({ name }) => name !== "review" && name !== "storage")) {
    for (const argv of [[name], [name, "--help"]]) {
      const result = await harness.behavior.runCli(argv, { projectId: "p1", cwd: process.cwd() });
      expect(result.stderr, `bb review ${argv.join(" ")}`).not.toMatch(/bad revision|bb review failed/);
    }
  }
});

test("merging the modules' handlers refuses a name two modules give", () => {
  expect(merge({ a: 1 }, { b: 2 })).toEqual({ a: 1, b: 2 });
  expect(() => merge({ a: 1 }, { b: 2 }, { a: 3 })).toThrow("Two of the server's modules give a.");
});
