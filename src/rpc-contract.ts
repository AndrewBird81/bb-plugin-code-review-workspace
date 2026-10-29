import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { releaseRpc } from "./plugin-updates";
import { COMMENT_STATES, SEVERITIES, SUBMIT_WARNINGS } from "./draft";
import { REMOVAL_NOTE_LIMIT, REMOVAL_REASONS } from "../lib/removal-reasons";
import { NAME_LIMIT } from "../lib/review-name";
import { DATE_FIELDS, VALUE_FIELDS, VIEW_NAME_LIMIT } from "../lib/filter-fields";
import { agentChoiceSchema, agentExecutionSchema, knobsSchema, preferencesSchema } from "./preferences";

// The RPC data plane between the panel (app.tsx) and the backend (server.ts).
// app.tsx imports the TYPE of this contract only; the backend module never enters the frontend bundle.
const targetKey = z.object({ targetKey: z.string() }).strict();
/** A line, as Postgres's integer column holds it; 0 is the summary's place (src/draft.ts SUMMARY_AT). */
const lineNumber = z.number().int().min(0).max(2_147_483_647);
/** A range's first line. */
const startLine = z.number().int().min(1).max(2_147_483_647);
/** A time in epoch ms, as the store keeps it: an integer a JavaScript number holds exactly. */
const epochMs = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/** A saved view of All reviews' filters, as lib/review-filters.ts makes it. */
const filterViewShape = z.object({
  id: z.string().min(1).max(100),
  name: z.string().trim().min(1).max(VIEW_NAME_LIMIT),
  filters: z.array(z.union([
    z.object({ field: z.enum(VALUE_FIELDS), values: z.array(z.string().max(500)).max(200), negate: z.boolean().optional() }).strict(),
    z.object({ field: z.enum(DATE_FIELDS), days: z.number().int().min(1).max(3650), before: z.boolean().optional() }).strict(),
  ])).max(VALUE_FIELDS.length + DATE_FIELDS.length),
}).strict();

const commentShape = z
  .object({
    file: z.string(),
    line: lineNumber,
    side: z.enum(["LEFT", "RIGHT"]),
    // A range's first line, and its side when it isn't `side` (src/draft.ts DraftComment).
    startLine: startLine.optional(),
    startSide: z.enum(["LEFT", "RIGHT"]).optional(),
    chapterId: z.string().optional(),
    // Undo after Remove puts an agent's comment back as the agent's.
    author: z.literal("agent").optional(),
    // A label the body starts with sets it instead (src/draft.ts severityOf).
    severity: z.enum(SEVERITIES).optional(),
    body: z.string().min(1),
    // And with how the agent checked it; an edit in the panel sends none, so it goes.
    evidence: z.string().max(600).optional(),
    // A problem in code the PR didn't change (Settings' Keep pre-existing problems apart).
    introduced: z.literal(false).optional(),
    // A page that sends a comment back as it read it sends the server's own fields too; the saved comment's stand.
    id: z.string().optional(), state: z.enum(COMMENT_STATES).optional(), sendN: z.number().int().optional(), claim: z.unknown().optional(),
    editedBy: z.literal("agent").optional(),
  })
  .strict();

const location = { file: z.string(), line: lineNumber, side: z.enum(["LEFT", "RIGHT"]) };
// What Send to thread adds to what it sends (src/fix-handoff.ts): your message, as long as a summary may be, and the summary.
const sendExtras = { message: z.string().max(65_000).optional(), includeSummary: z.boolean().optional() };
// Where a Send goes past its warning (src/loop.ts): force, past it, as on a PR you don't own; thread, when the main
// thread is archived or deleted, or its folder gone, as the warning offered: unarchive it and send, or a fresh thread;
// on a PR with no thread working on it, a fresh thread at its head, or a fork of the thread that wrote it.
const routeChoices = { force: z.boolean().optional(), thread: z.enum(["unarchive", "fresh", "fork"]).optional() };
// A Send's own choices: letPush, Let it push when done for this Send, else the review's setting, and where it goes.
const sendChoices = { letPush: z.boolean().optional(), ...routeChoices };
/**
 * A Send that didn't go: why, and what it offers. anyway: the same call with force sends it; unarchive, fresh and fork:
 * with force and that thread.
 */
const sendWarning = z.object({
  ok: z.literal(false), warning: z.string(), offers: z.array(z.enum(["anyway", "unarchive", "fresh", "fork"])).optional(),
  // With fresh offered: where that thread starts, "in ~/src/api".
  freshWhere: z.string().optional(),
  // With fork offered: the thread it forks, by its title.
  forkFrom: z.string().optional(),
  // On a PR, where the Send can go, as a choice (src/loop.ts FixerChoice).
  choice: z.object({
    why: z.enum(["archived", "deleted", "none", "folder-gone"]), thread: z.string().nullable(), machine: z.string().nullable(),
    folder: z.string().optional(), note: z.string().optional(),
  }).optional(),
});
const syncHealth = z.object({
  lastReadAt: z.number().nullable(),
  error: z.object({ kind: z.enum(["auth", "rate-limit", "partial", "teams", "gh-missing", "other"]), at: z.number(), count: z.number().optional(), retryAt: z.number().optional() }).nullable(),
});
const discussion = z.object({
  ...location,
  entries: z.array(z.object({ author: z.enum(["reviewer", "agent"]), kind: z.enum(["message", "added", "edited", "removed", "restored"]), body: z.string(), createdAt: z.number() })),
  startLine: z.number().int().optional(),
  waiting: z.boolean(),
  undoable: z.boolean().optional(),
});

// A file's viewed mark as stored: the hash of its diff when you viewed it (src/store.ts FileView).
const fileView = z.object({ file: z.string(), hash: z.string(), viewedAt: epochMs });

// A draft, where its comments were drafted against an older diff, and the discussions at its lines.
const draftOutput = z.object({
  draft: z.any(),
  stale: z.array(z.object(location)),
  discussions: z.array(discussion),
});

export const rpcContract = defineRpcContract({
  ...releaseRpc,
  /** missingScopes: the scopes posting needs that gh's token lacks; "unlisted" when GitHub didn't list them, as for a fine-grained token; null when it couldn't be asked. */
  getSetupStatus: { input: z.null(), output: z.object({ account: z.string().nullable(), githubCli: z.boolean(), agentAvailable: z.boolean().nullable(), projectAvailable: z.boolean().nullable(), missingScopes: z.union([z.array(z.string()), z.literal("unlisted")]).nullable().optional() }) },
  /** patch is null when it's the one knownRevision names, which the page already shows. */
  getReviewBundle: {
    input: z.object({ targetKey: z.string(), knownRevision: z.string().optional() }).strict(),
    // diffError: why a pruned review's diff couldn't be read again; the rest still loads.
    output: z.object({ review: z.any().nullable(), guide: z.any().nullable(), patch: z.string().nullable(), revision: z.string(), diffError: z.string().optional() }),
  },
  getPreferences: { input: z.null(), output: z.object({ preferences: preferencesSchema, revision: z.number().int() }) },
  savePreferences: {
    // Pages open from before 0.5.1 send settings without threadListReviews, from before 0.6.0 without rereviewShows,
    // and from before 1.5.0 without markdownFiles; the saved value stands. Pages from before knobs send none, and any page may send some: the saved
    // ones stand for the rest.
    input: z.object({ preferences: preferencesSchema.extend({ knobs: knobsSchema.partial().optional() }).partial({ threadListReviews: true, rereviewShows: true, markdownFiles: true }), revision: z.number().int().min(0) }).strict(),
    output: z.object({ preferences: preferencesSchema, revision: z.number().int() }),
  },
  // Seeds a custom agent selection with the panel project's remembered defaults, and a custom guide writer with the
  // mode it runs at on them (src/generate.ts guideWriterMode); without one, the project's own.
  getAgentDefaults: { input: z.null(), output: z.object({ defaults: agentExecutionSchema.nullable(), guideWriterMode: z.enum(["accept-edits", "auto"]).optional() }) },
  // A machine's providers and the permission modes each runs in, so Settings can say when an agent can't be restricted.
  // The bb server's without a hostId; none when they can't be read.
  getProviderModes: {
    input: z.object({ hostId: z.string().optional() }).strict(),
    output: z.object({ providers: z.array(z.object({ id: z.string(), name: z.string(), permissionModes: z.array(z.string()) })) }),
  },
  listMachines: {
    input: z.null(),
    output: z.object({ machines: z.array(z.object({ hostId: z.string(), name: z.string(), connected: z.boolean(), server: z.boolean() })) }),
  },
  // How the agent's draft comments fared in submitted reviews, and its proposal for the assistant's instructions (src/learning.ts).
  getAgentLearning: {
    input: z.null(),
    output: z.object({
      total: z.number().int(), kept: z.number().int(), edited: z.number().int(), removed: z.number().int(),
      // Optional: an older server sends none.
      reasons: z.array(z.object({ reason: z.enum(REMOVAL_REASONS), count: z.number().int() })).optional(),
      recentRemoved: z.array(z.object({ repo: z.string(), file: z.string(), line: z.string(), at: z.number() })),
      canSuggest: z.boolean(),
      suggestion: z.object({ state: z.enum(["idle", "running", "ready", "failed"]), at: z.number().optional(), text: z.string().optional(), error: z.string().optional() }),
    }),
  },
  /** Ask the review assistant's agent to propose instruction lines; the proposal arrives through getAgentLearning. */
  suggestAssistantInstructions: { input: z.null(), output: z.object({ ok: z.boolean(), error: z.string().optional() }) },
  /** Forget a finished proposal, once the reviewer adds it to their instructions or discards it. */
  dismissInstructionSuggestion: { input: z.null(), output: z.object({ ok: z.boolean() }) },
  // Saved views of All reviews' filters. A view's filters are read back loosely: a newer version's may be there.
  listFilterViews: { input: z.null(), output: z.object({ views: z.array(z.object({ id: z.string(), name: z.string(), filters: z.array(z.unknown()) })) }) },
  saveFilterView: { input: filterViewShape, output: z.object({ ok: z.literal(true) }) },
  deleteFilterView: { input: z.object({ id: z.string().min(1).max(100) }).strict(), output: z.object({ ok: z.literal(true) }) },
  getReviewerNotes: { input: targetKey, output: z.object({ body: z.string(), revision: z.number().int() }) },
  saveReviewerNotes: {
    input: z.object({ targetKey: z.string(), body: z.string().max(100000), revision: z.number().int().min(0) }).strict(),
    output: z.object({ body: z.string(), revision: z.number().int() }),
  },

  // Panel: start a review by pasting a GitHub PR URL
  startReview: {
    input: z.object({ input: z.string().min(1) }).strict(),
    output: z.object({ ok: z.boolean(), error: z.string().optional(), targetKey: z.string().optional() }),
  },

  // Read. sync: how reading GitHub went (src/review-lifecycle.ts SyncHealth).
  listReviews: { input: z.null(), output: z.object({ reviews: z.array(z.any()), sync: syncHealth.optional() }) },
  /** force: false reads only what's due, as the background sync does; true or null reads everything now. */
  refreshReviews: { input: z.object({ force: z.boolean() }).strict().nullable(), output: z.object({ reviews: z.array(z.any()), sync: syncHealth.optional() }) },
  getChecks: { input: targetKey, output: z.object({ bucket: z.string(), checks: z.array(z.any()) }) },
  /** Failure annotations of the reviewed head's failed check runs, to show on their lines. */
  getCheckFailures: {
    input: targetKey,
    output: z.object({ failures: z.array(z.object({ file: z.string(), line: z.number().int(), check: z.string(), title: z.string().nullable(), message: z.string(), url: z.string() })) }),
  },
  /** The end of a failed GitHub Actions run's log, at most 200 lines and 20,000 characters; read only when the reviewer asks. */
  getCheckLog: {
    input: z.object({ targetKey: z.string(), runId: z.number().int().positive() }).strict(),
    output: z.object({ ok: z.boolean(), log: z.string().optional(), error: z.string().optional() }),
  },
  /** The changed files the repo's .gitattributes marks linguist-generated or linguist-vendored. */
  getGeneratedFiles: { input: targetKey, output: z.object({ files: z.array(z.string()) }) },
  /** The changed files CODEOWNERS (a PR's base branch, a local review's new side) gives owners, and whether you or a team you're on is one; error: it couldn't be read. */
  getCodeOwners: {
    input: targetKey,
    output: z.object({ files: z.array(z.object({ file: z.string(), owners: z.array(z.string()), mine: z.boolean() })), error: z.string().optional() }),
  },
  /** A changed file's whole old and new contents (null on a side it doesn't exist), or why only its diff can show. */
  getFileContents: {
    input: z.object({ targetKey: z.string(), file: z.string() }).strict(),
    output: z.union([z.object({ ok: z.literal(true), old: z.string().nullable(), new: z.string().nullable() }), z.object({ ok: z.literal(false), error: z.string() })]),
  },

  // GitHub threads, reply/resolve, staleness, re-review
  /** error: GitHub couldn't be read, or not every page; threads holds what was. */
  getReviewThreads: { input: targetKey, output: z.object({ threads: z.array(z.any()), error: z.string().optional() }) },
  /**
   * With threadId, a posted reply also clears that thread's drafted reply. account: the GitHub account the page
   * verified, which replies and resolves post as; without it they're refused. Optional only so 0.7.0's pages are told to reload.
   */
  replyToThread: {
    input: z.object({ targetKey: z.string(), inReplyTo: z.number().int(), body: z.string().min(1), threadId: z.string().optional(), account: z.string().optional() }).strict(),
    // alreadyPosted: GitHub has this reply, posted in the last 15 minutes, so it wasn't sent again and its draft stays.
    output: z.object({ ok: z.boolean(), error: z.string().optional(), alreadyPosted: z.boolean().optional() }),
  },
  /** Only a thread of this review's PR. */
  resolveThread: {
    input: z.object({ targetKey: z.string(), threadId: z.string(), account: z.string().optional() }).strict(),
    output: z.object({ ok: z.boolean(), error: z.string().optional() }),
  },
  unresolveThread: {
    input: z.object({ targetKey: z.string(), threadId: z.string(), account: z.string().optional() }).strict(),
    output: z.object({ ok: z.boolean(), error: z.string().optional() }),
  },
  /** hasNewCommits: the guide is behind the PR, by new commits or, with baseChanged, a new base branch. */
  checkForUpdates: {
    input: targetKey,
    // localChanged: a local review's diff, run again, differs from the diff it shows.
    output: z.object({ hasNewCommits: z.boolean(), current: z.string().optional(), stored: z.string().optional(), baseChanged: z.object({ from: z.string(), to: z.string() }).optional(), localChanged: z.boolean().optional() }),
  },
  rereview: {
    input: targetKey,
    output: z.object({ ok: z.boolean(), error: z.string().optional() }),
  },
  /** Stop the review's guide while it builds, once it's finalized: restored when a rebuild has its previous guide back. */
  stopGuide: {
    input: targetKey,
    output: z.object({ ok: z.boolean(), error: z.string().optional(), restored: z.boolean().optional() }),
  },

  // Reviewer-managed archive, pin, and name, and permanent deletion of a review's saved data
  archiveReview: {
    input: z.object({ targetKey: z.string(), archived: z.boolean() }).strict(),
    output: z.object({ ok: z.boolean(), error: z.string().optional() }),
  },
  pinReview: {
    input: z.object({ targetKey: z.string(), pinned: z.boolean() }).strict(),
    output: z.object({ ok: z.boolean(), error: z.string().optional() }),
  },
  /** An empty name, or the PR's title, puts the PR's title back. */
  renameReview: {
    input: z.object({ targetKey: z.string(), name: z.string().trim().max(NAME_LIMIT) }).strict(),
    output: z.object({ ok: z.boolean(), error: z.string().optional() }),
  },
  deleteReview: { input: targetKey, output: z.object({ ok: z.boolean(), error: z.string().optional() }) },

  // Draft and submit
  getDraft: { input: targetKey, output: draftOutput },
  saveDraftComment: {
    // `replaces`: the line's comment the box saw, null for none; a save over another one, written since, is refused.
    input: z.object({ targetKey: z.string(), revision: z.string().optional(), comment: commentShape, replaces: z.string().nullable().optional() }).strict(),
    output: draftOutput,
  },
  removeDraftComment: {
    input: z.object({ targetKey: z.string(), ...location }).strict(),
    output: draftOutput,
  },
  // A message from a line's discussion, or the summary's (src/draft.ts SUMMARY_AT), to the review assistant, which answers there.
  // inserted: the plugin wrote any of body, by filling the box or composing it, so it confirms no post.
  askAgent: {
    input: z.object({ targetKey: z.string(), ...location, startLine: startLine.optional(), body: z.string().trim().min(1).max(20_000), inserted: z.boolean() }).strict(),
    output: draftOutput,
  },
  /** Ask the review agent for a closer pass over a medium- or high-risk chapter, at high effort; its comments arrive in the draft. */
  digDeeper: {
    input: z.object({ targetKey: z.string(), chapterId: z.string().min(1) }).strict(),
    output: z.object({ ok: z.boolean(), error: z.string().optional() }),
  },
  dismissDiscussion: { input: z.object({ targetKey: z.string(), ...location }).strict(), output: draftOutput },
  /** Undo the agent's latest change in the discussion at a line, or the summary's. */
  undoAgentChange: { input: z.object({ targetKey: z.string(), ...location }).strict(), output: draftOutput },
  /** Why the reviewer removed the agent's comment at a line, on its latest removal there; not ok when there's none, or they aren't asked. */
  setRemovalReason: {
    input: z.object({ targetKey: z.string(), ...location, reason: z.enum(REMOVAL_REASONS), note: z.string().trim().max(REMOVAL_NOTE_LIMIT).optional() }).strict(),
    output: z.object({ ok: z.boolean() }),
  },
  /** The reviewer picks a verdict. */
  setVerdict: {
    input: z
      .object({
        targetKey: z.string(),
        revision: z.string().optional(),
        verdict: z.enum(["APPROVE", "REQUEST_CHANGES", "COMMENT"]),
      })
      .strict(),
    output: z.object({ draft: z.any() }),
  },
  /** The reviewer writes, edits, or (with an empty body) removes the review summary. */
  saveSummary: {
    input: z.object({ targetKey: z.string(), revision: z.string().optional(), body: z.string().max(65_000) }).strict(),
    output: draftOutput,
  },
  /** A comment on an older diff becomes a line at the end of the summary, which is then the reviewer's, and leaves the draft. */
  moveToSummary: { input: z.object({ targetKey: z.string(), revision: z.string().optional(), ...location }).strict(), output: draftOutput },
  submitReview: {
    input: z.object({
      targetKey: z.string(), revision: z.string().optional(), account: z.string().optional(),
      // The comments, summary, and verdict the page shows; submission refuses a draft that no longer matches.
      comments: z.array(z.object({ file: z.string(), line: z.number().int(), side: z.enum(["LEFT", "RIGHT"]), startLine: z.number().int().optional(), startSide: z.enum(["LEFT", "RIGHT"]).optional(), severity: z.enum(SEVERITIES).optional(), introduced: z.literal(false).optional(), body: z.string() })),
      body: z.string(),
      verdict: z.enum(["APPROVE", "REQUEST_CHANGES", "COMMENT"]),
      // Submit anyway: past the warnings it names, as the page showed them, such as new commits since you read it. What
      // GitHub refuses still stops it.
      force: z.union([z.boolean(), z.array(z.enum(SUBMIT_WARNINGS))]).optional(),
      // Submit as Comment: the draft's verdict becomes Comment, then it's submitted, as on your own PR.
      asComment: z.boolean().optional(),
    }).strict(),
    // url: the posted review on GitHub. warning: it didn't post, and force posts it. offers: what the page can do next,
    // beside the warning or the error: Submit anyway, Submit as Comment, Open it on GitHub.
    // warnings: what each warning is, to pass back as force. newCommits: how many, and GitHub's compare of them.
    output: z.object({
      ok: z.boolean(), error: z.string().optional(), url: z.string().optional(), warning: z.string().optional(), offers: z.array(z.enum(["anyway", "comment", "github"])).optional(),
      warnings: z.array(z.enum(SUBMIT_WARNINGS)).optional(), newCommits: z.object({ count: z.number().nullable(), url: z.string() }).optional(),
    }),
  },

  // Per-file "Viewed" state
  getFileViews: {
    input: targetKey,
    output: z.object({
      views: z.array(z.object({ file: z.string(), viewed: z.boolean(), stale: z.boolean(), viewedAt: z.number() })),
    }),
  },
  setFileViewed: {
    input: z.object({ targetKey: z.string(), file: z.string(), viewed: z.boolean() }).strict(),
    output: z.object({ ok: z.boolean() }),
  },
  // Marks a chapter's files viewed at once, returning the views it replaced. With viewed: false (Undo), puts back
  // `previous`, such as a file viewed at an older version, and unmarks the rest.
  setFilesViewed: {
    input: z.object({ targetKey: z.string(), files: z.array(z.string()), viewed: z.boolean().optional(), previous: z.array(fileView).optional() }).strict(),
    output: z.object({ ok: z.boolean(), previous: z.array(fileView).optional() }),
  },

  // Review assistant: one hidden bb thread per review, shown with ThreadChat
  getConversation: {
    input: targetKey,
    output: z.object({
      threadId: z.string().nullable(), legacy: z.array(z.any()), defaults: agentChoiceSchema.nullable(),
      machine: z.object({ name: z.string(), connected: z.boolean() }).nullable(),
    }),
  },
  startConversation: {
    // typed: what you typed, without the file or lines quoted after it, which are the PR's words. inserted: the plugin put
    // a quote or context in it, so it confirms no post.
    input: z.object({ targetKey: z.string(), text: z.string().min(1), typed: z.string(), inserted: z.boolean(), agent: agentChoiceSchema }).strict(),
    output: z.object({ threadId: z.string() }),
  },
  // Text the dock is about to put in the conversation's composer: a message that carries it confirms no post.
  noteInserted: {
    input: z.object({ targetKey: z.string(), threadId: z.string().min(1), text: z.string().min(1).max(200_000) }).strict(),
    output: z.object({ ok: z.literal(true) }),
  },
  newConversation: { input: targetKey, output: z.object({ ok: z.boolean() }) },
  // A visible coding thread that fixes draft comments; the draft stays. On a PR you don't own it warns, and force starts it.
  startFixThread: {
    input: z.object({ targetKey: z.string(), comments: z.array(z.object(location).strict()).min(1), force: z.boolean().optional() }).strict(),
    output: z.union([z.object({ ok: z.literal(true), threadId: z.string(), title: z.string() }), sendWarning]),
  },
  // The review's main thread, which its Sends go to (src/loop.ts): the top thread in its folder, or the thread `bb review`
  // ran in, and the machine it works on when that's known.
  getSourceThread: {
    input: targetKey,
    output: z.object({ thread: z.object({ threadId: z.string(), title: z.string().nullable(), state: z.enum(["open", "archived", "gone"]), machine: z.string().nullable().optional() }).nullable() }),
  },
  // Send: the comments, each with an id, to the main thread, threadId (a fresh one, when it started one), as Send sendN.
  // threads: on your own PR, threads, review summaries and comments on GitHub that go with them, by GitHub's id.
  sendToSourceThread: {
    input: z.object({ targetKey: z.string(), comments: z.array(z.object(location).strict()), threads: z.array(z.string().min(1)).max(100).optional(), ...sendExtras, ...sendChoices }).strict()
      .refine((input) => input.comments.length > 0 || !!input.threads?.length, "Choose a comment to send."),
    // skipped: GitHub items left out, as the review no longer has them.
    output: z.union([z.object({ ok: z.literal(true), delivery: z.enum(["sent", "queued"]), title: z.string().nullable(), threadId: z.string().optional(), sendN: z.number().int().optional(), skipped: z.number().int().optional() }), sendWarning]),
  },
  // Tells the main thread you approve the change as is, at the revision the page shows. With comments not yet sent, or
  // told already for this diff, it warns.
  sendApprovalToSourceThread: {
    input: z.object({ targetKey: z.string(), revision: z.string().optional(), ...sendExtras, ...routeChoices }).strict(),
    // recorded: no thread could be told, the main thread being gone, so it's only recorded, as you chose.
    output: z.union([z.object({ ok: z.literal(true), delivery: z.enum(["sent", "queued"]), title: z.string().nullable(), threadId: z.string().optional(), recorded: z.literal(true).optional() }), sendWarning]),
  },

  // The loop with the thread that fixes your change: Send now, the fixes' states, a local review's folder, push and
  // open a PR. `warning`: it didn't act, and the same call with `force` does.
  /**
   * Send one comment to the review's main thread now, a draft comment or, on your own PR, a GitHub thread: it gets an
   * id the thread reports on. letPush, force and thread are this Send's, as on sendToSourceThread.
   */
  sendNow: {
    input: z.object({
      targetKey: z.string(),
      comment: z.union([z.object(location).strict(), z.object({ threadId: z.string().min(1) }).strict()]),
      ...sendChoices,
    }).strict(),
    // sent: the comment's id, the Send's number, and the thread it went to.
    output: z.object({
      ok: z.boolean(), error: z.string().optional(), warning: z.string().optional(), offers: sendWarning.shape.offers, freshWhere: sendWarning.shape.freshWhere, forkFrom: sendWarning.shape.forkFrom, choice: sendWarning.shape.choice,
      sent: z.object({ id: z.string(), sendN: z.number().int(), threadId: z.string(), title: z.string().nullable(), delivery: z.enum(["sent", "queued"]) }).optional(),
    }),
  },
  /** The reviewer resolves a comment as fixed, or dismisses it as won't fix: nothing else does. */
  resolveComment: {
    input: z.object({ targetKey: z.string(), ...location, state: z.enum(["resolved", "dismissed"]) }).strict(),
    output: draftOutput,
  },
  /** Open a sent, resolved or dismissed comment again: it goes with the next Send. */
  reopenComment: { input: z.object({ targetKey: z.string(), ...location }).strict(), output: draftOutput },
  /** Ask the review agent to check the fixes of the comments sent, each against the diff it was sent at. */
  checkFixes: { input: targetKey, output: z.object({ ok: z.boolean(), error: z.string().optional() }) },
  /** Read a local review's folder again, and move the comments with their lines; the guide stays. */
  updateFeature: { input: targetKey, output: z.object({ ok: z.boolean(), error: z.string().optional() }) },
  /** Write a local review's guide again, for its diff now. */
  rewriteGuide: { input: targetKey, output: z.object({ ok: z.boolean(), error: z.string().optional() }) },
  /**
   * Have the main thread commit the changes you reviewed, then push that commit. force: push past the warning that
   * files changed since you reviewed; the push itself is never a force-push.
   */
  push: {
    input: z.object({ targetKey: z.string(), force: z.boolean().optional() }).strict(),
    output: z.object({ ok: z.boolean(), error: z.string().optional(), warning: z.string().optional(), delivery: z.enum(["sent", "queued"]).optional() }),
  },
  /**
   * Ask the review agent to draft the PR's title and description, shown in a Post form whose Post opens the PR. note:
   * what happened instead, as when the branch has a PR already, which the review then becomes; or, not ok, what has to
   * happen first, as pushing the branch.
   */
  openPr: { input: targetKey, output: z.object({ ok: z.boolean(), error: z.string().optional(), note: z.string().optional() }) },
  /** The review's Let it push when done: on, a Send leaves out "Don't push until I say", unless it says otherwise. */
  setLetPush: {
    input: z.object({ targetKey: z.string(), letPush: z.boolean() }).strict(),
    output: z.object({ ok: z.boolean(), error: z.string().optional() }),
  },
  /** Send to this thread from now on: one working in the review's folder; with fresh, a new one started there. */
  setMainThread: {
    input: z.union([z.object({ targetKey: z.string(), threadId: z.string().min(1) }).strict(), z.object({ targetKey: z.string(), fresh: z.literal(true) }).strict()]),
    output: z.object({ ok: z.boolean(), error: z.string().optional() }),
  },
  /**
   * Not pushed yet, on a PR: what the folder of its main thread, a fixer's or its own, has that the PR's head on GitHub
   * doesn't, committed or not (src/own-pr.ts); or, with no such folder, or one that can't be read now, why.
   */
  getNotPushed: {
    input: targetKey,
    output: z.union([
      z.object({
        state: z.literal("available"), patch: z.string(), base: z.string(), branch: z.string(), machine: z.string().nullable(), threadId: z.string(),
        hidden: z.array(z.object({ path: z.string(), reason: z.enum(["secret", "binary", "large"]) })), notice: z.string().nullable(),
      }),
      z.object({ state: z.enum(["none", "offline", "gone", "unavailable"]), message: z.string() }),
    ]),
  },
  /** Stop showing Branch kept for a fixer's branch, once you've deleted it or chosen to keep it. */
  dismissKeptBranch: {
    input: z.object({ targetKey: z.string(), branch: z.string().min(1) }).strict(),
    output: z.object({ ok: z.boolean(), error: z.string().optional() }),
  },
  /** Include files the secrets filter keeps out of a local review's diff, by path; with included false, keep them out again. */
  includeHidden: {
    input: z.object({ targetKey: z.string(), files: z.array(z.string().min(1)).min(1).max(1000), included: z.boolean() }).strict(),
    output: z.object({ ok: z.boolean(), error: z.string().optional() }),
  },
  /**
   * A local review's folder now, for its notices: as the review shows it, `changedFiles` changed since, paused on
   * another `branch`, its machine offline, gone, or unreadable (`message`); the other threads working there; the files it
   * keeps out, and committed ones that look like secrets; the review its PR had already, if any; and, paused, the review
   * of the branch the folder is on, if any (src/feature-review.ts).
   */
  checkFeature: {
    input: targetKey,
    output: z.object({
      state: z.enum(["current", "changed", "paused", "offline", "gone", "unavailable"]),
      changedFiles: z.number().int().optional(),
      branch: z.string().nullable().optional(),
      message: z.string().optional(),
      alsoActive: z.array(z.object({ threadId: z.string(), title: z.string() })),
      hidden: z.array(z.object({ path: z.string(), reason: z.enum(["secret", "binary", "large"]) })),
      flagged: z.array(z.string()),
      prReview: z.string().optional(),
      branchReview: z.string().optional(),
    }),
  },
  /** Got it: stop warning about these committed files that look like secrets, in this review. */
  dismissFlagged: {
    input: z.object({ targetKey: z.string(), files: z.array(z.string().min(1)).min(1).max(1000) }).strict(),
    output: z.object({ ok: z.boolean(), error: z.string().optional() }),
  },
  /** Review the branch a local review's folder is on now, in that branch's own review, addressed to the same main thread. */
  reviewFolderBranch: { input: targetKey, output: z.object({ ok: z.boolean(), error: z.string().optional(), targetKey: z.string().optional() }) },

  // What posts as you on GitHub from the review agent's work.
  /**
   * Post Ready to approve rows, each the one its token names, one after another, never past a warning. A row whose PR
   * has commits since it was asked is held, unless alsoHeld (Approve them too), which posts it on the head it was asked on.
   */
  approveReady: {
    input: z.object({ rows: z.array(z.object({ targetKey: z.string(), token: z.string().min(1) }).strict()).min(1).max(100), alsoHeld: z.boolean().optional() }).strict(),
    // commits: a held row's commits since it was asked, when GitHub said.
    output: z.object({ results: z.array(z.object({ targetKey: z.string(), outcome: z.enum(["posted", "held", "failed"]), error: z.string().optional(), url: z.string().optional(), commits: z.number().nullable().optional() })) }),
  },
  /** Don't approve: take a Ready to approve row, the one its token names, out of Needs review. */
  dismissReady: {
    input: z.object({ targetKey: z.string(), token: z.string().min(1) }).strict(),
    output: z.object({ ok: z.boolean(), error: z.string().optional() }),
  },

  // GitHub account indicator + switcher
  getGhAccounts: {
    input: z.null(),
    output: z.object({
      active: z.string().nullable(),
      accounts: z.array(z.object({ login: z.string(), active: z.boolean() })),
    }),
  },
  switchGhAccount: {
    input: z.object({ login: z.string().min(1) }).strict(),
    output: z.object({ ok: z.boolean(), active: z.string().nullable(), error: z.string().optional() }),
  },
  // accessible is false only where GitHub refused the account; badCredentials, refused for its credentials. error: access
  // couldn't be checked, such as with GitHub unreachable or rate-limited, and accessible is true.
  checkRepoAccess: {
    input: z.object({ targetKey: z.string() }).strict(),
    output: z.object({ accessible: z.boolean(), repo: z.string().nullable(), account: z.string().nullable(), badCredentials: z.boolean().optional(), error: z.string().optional() }),
  },

  // Whose turn. Reviews carry `turn` (lib/turn.ts Turn) and `progress` from the server.
  /** Snooze until the author responds: back to Waiting on author until a newer signal; with `until` (epoch ms), also until then. snoozed: false undoes it. */
  snoozeReview: {
    input: z.object({ targetKey: z.string(), snoozed: z.boolean(), until: epochMs.nullable().optional() }).strict(),
    output: z.object({ ok: z.boolean(), error: z.string().optional() }),
  },
  /** The reviewer opened the review: clear its Needs You alert. */
  markSeen: { input: targetKey, output: z.object({ ok: z.boolean() }) },
  /** Generate the guide for a review found on GitHub (status "tracked"). */
  startTrackedReview: { input: targetKey, output: z.object({ ok: z.boolean(), error: z.string().optional() }) },
  /** Start what didn't run on its own because of the PR's author (skippedRun), approving agents on its head. */
  runSkipped: { input: targetKey, output: z.object({ ok: z.boolean(), error: z.string().optional() }) },

  // Your feedback and the assistant's check of it (lib/feedback.ts FeedbackView).
  getFeedback: { input: targetKey, output: z.object({ feedback: z.any() }) },
  /** Re-read your threads from GitHub first. */
  refreshFeedback: { input: targetKey, output: z.object({ feedback: z.any() }) },
  /** Ask the assistant to check your feedback against the PR now. */
  checkFeedback: { input: targetKey, output: z.object({ ok: z.boolean(), error: z.string().optional() }) },
  /** Post a reply to one of your threads on GitHub, as the account the page verified (see replyToThread), and clear its drafted reply. */
  replyToFeedback: {
    input: z.object({ targetKey: z.string(), threadId: z.string(), body: z.string().trim().min(1).max(65_000), account: z.string().optional() }).strict(),
    output: z.object({ ok: z.boolean(), error: z.string().optional(), feedback: z.any().optional(), alreadyPosted: z.boolean().optional() }),
  },
  saveReplyDraft: {
    input: z.object({ targetKey: z.string(), threadId: z.string(), body: z.string().max(65_000) }).strict(),
    output: z.object({ ok: z.boolean() }),
  },
  discardReplyDraft: { input: z.object({ targetKey: z.string(), threadId: z.string() }).strict(), output: z.object({ ok: z.boolean() }) },
  /** The drafted replies on any of the PR's threads, yours or the assistant's. */
  getReplyDrafts: {
    input: targetKey,
    output: z.object({ drafts: z.array(z.object({ threadId: z.string(), body: z.string(), author: z.enum(["agent", "reviewer"]), updatedAt: z.number() })) }),
  },
  /**
   * Put the assistant's suggested verdict and summary in the draft ("suggested"), or a
   * Request changes listing the feedback that isn't addressed yet ("remaining").
   */
  useSuggestedVerdict: {
    input: z.object({ targetKey: z.string(), revision: z.string().optional(), mode: z.enum(["suggested", "remaining"]) }).strict(),
    output: z.object({ ok: z.boolean(), error: z.string().optional(), draft: z.any().optional() }),
  },

  /**
   * The displayed diff compared with the diff at your last review (src/interdiff.ts FileInterdiff[]).
   * baseline null: you haven't reviewed it, or it's the same commit. A Send's baseline has `sha` "send:<n>".
   */
  getSinceReview: {
    // from: compare with the diff at this commit instead, one of getPrCommits', or at a Send, as "send:<n>".
    input: z.object({ targetKey: z.string(), from: z.string().regex(/^([0-9a-f]{7,40}|send:\d+)$/).optional() }).strict(),
    output: z.object({
      baseline: z.object({ sha: z.string(), at: z.number().nullable(), verdict: z.string().nullable() }).nullable(),
      files: z.array(z.any()),
      error: z.string().optional(),
    }),
  },
  /** A PR's commits up to the diff shown, newest first, for picking where a comparison starts; none for a local review. */
  getPrCommits: {
    input: targetKey,
    output: z.object({ commits: z.array(z.object({ sha: z.string(), headline: z.string(), committedAt: z.number().nullable() })), error: z.string().optional() }),
  },
});
