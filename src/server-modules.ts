// The server's seams. Each area of the server is a module whose `register(deps)` registers its agent tools and returns
// what servePlugin merges: its RPC handlers, its listeners to BB's events, and the bb review subcommands it runs.
import type { BbPluginApi, PluginAgentToolResult, PluginCliCommandInfo, PluginCliContext, PluginCliResult, PluginRpcHandlers, PluginThreadEventHandler, PluginThreadEventName } from "@get-bb/plugin-sdk";
import type { rpcContract } from "./rpc-contract";
import type { releaseRpc } from "./plugin-updates";
import type { QueuedStore } from "./store-queue";
import type { ReviewMeta } from "./store";
import type { runGh, runGit } from "./gh";
import type { postReceipts } from "./post-receipts";
import type { createReviewSubmitter } from "./submit-review";
import type { GithubWrites } from "./github-writes";
import type { completionNotifications } from "./completion-notifications";
import type { createInstructionSuggester } from "./learning";
import type { createReviewSync } from "./review-lifecycle";
import type { codeOwners } from "./codeowners";
import type { Classify } from "./asking";

/** What servePlugin gives each module: the open store, gh, and what it started on them. */
export interface ServeDeps {
  bb: BbPluginApi;
  store: QueuedStore;
  gh: { runGh: typeof runGh; runGit: typeof runGit };
  receipts: ReturnType<typeof postReceipts>;
  submitReview: ReturnType<typeof createReviewSubmitter>;
  /** The server's one line of writes to GitHub, paced. */
  githubWrites: GithubWrites;
  notifications: ReturnType<typeof completionNotifications>;
  suggester: ReturnType<typeof createInstructionSuggester>;
  sync: ReturnType<typeof createReviewSync>;
  /** Tell the review's open pages, and the lists, that it changed. */
  changed(targetKey: string): void;
  /** Re-read your threads on a PR now. */
  refreshThreads(review: ReviewMeta): Promise<void>;
  /** The review's changed `files` with CODEOWNERS owners, marking yours. */
  reviewOwners(review: ReviewMeta, files: string[]): ReturnType<typeof codeOwners>;
  /** Who's asking in the turn running on a review agent: what its write tools, and its edits to your comments, may do. */
  classify: Classify;
  /** Whether a thread is one of this plugin's agents, or one they started (null: can't be told): what it runs isn't yours. */
  fromOwnAgent(threadId: string): Promise<boolean | null>;
}

/** The RPC handlers the modules give, merged into the one object BB registers; the release's own are plugin-updates'. */
export type RpcHandlers = Omit<PluginRpcHandlers<typeof rpcContract>, keyof typeof releaseRpc>;

type Merged<T extends object[]> = T extends [infer First, ...infer Rest extends object[]] ? First & Merged<Rest> : unknown;

/** The modules' handlers, or subcommands, in one object. Two modules giving the same name is a mistake, so it throws. */
export function merge<T extends object[]>(...parts: T): Merged<T> {
  const merged: Record<string, unknown> = {};
  for (const part of parts) for (const [name, value] of Object.entries(part)) {
    if (Object.hasOwn(merged, name)) throw new Error(`Two of the server's modules give ${name}.`);
    merged[name] = value;
  }
  return merged as Merged<T>;
}

/** A module's listeners to BB's events. */
export type EventListeners = { [E in PluginThreadEventName]?: PluginThreadEventHandler<E>[] };

/** Register each module's listeners with BB, in order. BB runs every listener on its own. */
export function listen(bb: BbPluginApi, modules: EventListeners[]) {
  const on = <E extends PluginThreadEventName>(event: E, listeners: EventListeners[E]) => {
    for (const listener of listeners ?? []) {
      // An experimental event a bb doesn't have yet goes unheard there.
      try { bb.events.on(event, listener); } catch (error) { if (!event.startsWith("experimental_")) throw error; }
    }
  };
  for (const listeners of modules) for (const event of Object.keys(listeners) as PluginThreadEventName[]) on(event, listeners[event]);
}

/** Runs `bb review <name> …` with the arguments after the name; `ownReview` is the calling thread's own review, if it has one. */
export type Subcommands = Record<string, (args: string[], ctx: PluginCliContext, ownReview: string | undefined) => PluginCliResult | Promise<PluginCliResult>>;

/**
 * bb review's subcommands, as its help lists them. A module runs each by its name, but `review`, which is any PR or ref,
 * and `storage`, which answers before the store opens.
 */
export const SUBCOMMANDS: PluginCliCommandInfo[] = [
  { name: "review", summary: "Review this thread's folder, or a PR or ref", usage: "bb review [<pr-url | owner/repo#n | pr-number | git-ref> [--base <ref>]] [--context <text>] [--name <text>]" },
  { name: "comment", summary: "List, add, edit, or delete a review's local draft comments; never posts to GitHub", usage: "bb review comment <list | add | edit | delete> <review> [<file>:<line>] [--side LEFT|RIGHT] [--code <text>] [--body <text>] [--severity <severity>] [--evidence <text>] [--pre-existing] [--json]" },
  { name: "summary", summary: "Show or write a review's local review summary and suggested verdict; never posts to GitHub", usage: "bb review summary <review> [--json] | [--body <text> [--suggest APPROVE|COMMENT|REQUEST_CHANGES]]" },
  { name: "list", summary: "List your reviews, in Needs review's order, with whose turn it is", usage: "bb review list [--json]" },
  { name: "ask", summary: "Send a message to a review's agent, relayed from this thread, starting the agent if needed", usage: "bb review ask <review> <text>" },
  { name: "approve", summary: "Line PRs' approvals up in Needs review for the reviewer's click; never posts", usage: "bb review approve <review…> [--body <text>]" },
  { name: "report", summary: "Say what you did with a comment the reviewer sent you: done or declined", usage: "bb review report <id> done|declined [--note <text>] [--commit <sha>]" },
  { name: "ready", summary: "Say you've finished with the comments the reviewer sent you, for them to re-review", usage: "bb review ready [<review>]" },
  { name: "storage", summary: "Show where the reviews are kept, and move them between SQLite and Postgres", usage: "bb review storage <status | verify | migrate | export-sqlite [--replace-data-db]>" },
];

/** The tools a review's guide writer gets. */
export const WRITER_TOOL_NAMES = ["read_review_patch", "list_review_files", "read_changes_since_review", "read_pr_context", "generate_review_guide"];
/** The tools a review's assistant gets. When they change, raise ASSISTANT_TOOLS, so idle assistants restart with them. */
export const ASSISTANT_TOOL_NAMES = ["read_review_patch", "list_review_files", "list_draft_comments", "add_draft_comment", "edit_draft_comment", "delete_draft_comment", "set_review_summary", "reply_in_discussion",
  "list_feedback", "read_changes_since_review", "read_pr_context", "read_file", "assess_feedback", "draft_thread_reply"];
/**
 * The tools that act on GitHub or send to other threads, given besides only while Settings lets the review agent act
 * when asked (reviewAgentActs). Each also checks the knob when it runs, since a running agent keeps the tools it started with.
 */
export const ASSISTANT_WRITE_TOOL_NAMES = ["submit_review", "post_reply", "resolve_thread", "github_pr", "open_pr", "send_now"];
// Raise when the review assistant's tools, or their instructions, change.
export const ASSISTANT_TOOLS = 16;

/** A tool's answer that it failed, with why. */
export const failed = (text: string): PluginAgentToolResult => ({ content: [{ type: "text", text }], isError: true });
