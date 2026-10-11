import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { releaseRpc } from "./plugin-updates";
import { agentChoiceSchema, agentExecutionSchema, preferencesSchema } from "./preferences";

// The RPC data plane between the panel (app.tsx) and the backend (server.ts).
// Extended task-by-task (reads, draft/submit, viewed-state, agent). app.tsx imports the TYPE
// of this contract only; the backend module never enters the frontend bundle.
const targetKey = z.object({ targetKey: z.string() }).strict();

const commentShape = z
  .object({
    file: z.string(),
    line: z.number().int(),
    side: z.enum(["LEFT", "RIGHT"]),
    chapterId: z.string().optional(),
    body: z.string().min(1),
  })
  .strict();

const location = { file: z.string(), line: z.number().int(), side: z.enum(["LEFT", "RIGHT"]) };
const syncHealth = z.object({
  lastReadAt: z.number().nullable(),
  error: z.object({ kind: z.enum(["auth", "rate-limit", "partial", "teams", "other"]), at: z.number(), count: z.number().optional(), retryAt: z.number().optional() }).nullable(),
});
const discussion = z.object({
  ...location,
  entries: z.array(z.object({ author: z.enum(["reviewer", "agent"]), kind: z.enum(["message", "added", "edited", "removed", "restored"]), body: z.string(), createdAt: z.number() })),
  startLine: z.number().int().optional(),
  waiting: z.boolean(),
  undoable: z.boolean().optional(),
});

// A draft, where its comments were drafted against an older diff, and the discussions at its lines.
const draftOutput = z.object({
  draft: z.any(),
  stale: z.array(z.object(location)),
  discussions: z.array(discussion),
});

export const rpcContract = defineRpcContract({
  ...releaseRpc,
  getSetupStatus: { input: z.null(), output: z.object({ account: z.string().nullable(), githubCli: z.boolean(), agentAvailable: z.boolean().nullable(), projectAvailable: z.boolean().nullable() }) },
  getReviewBundle: { input: targetKey, output: z.object({ review: z.any().nullable(), guide: z.any().nullable(), patch: z.string(), revision: z.string() }) },
  getPreferences: { input: z.null(), output: z.object({ preferences: preferencesSchema, revision: z.number().int() }) },
  savePreferences: {
    input: z.object({ preferences: preferencesSchema, revision: z.number().int().min(0) }).strict(),
    output: z.object({ preferences: preferencesSchema, revision: z.number().int() }),
  },
  // Seeds a custom agent selection with the panel project's remembered defaults.
  getAgentDefaults: { input: z.null(), output: z.object({ defaults: agentExecutionSchema.nullable() }) },
  listMachines: {
    input: z.null(),
    output: z.object({ machines: z.array(z.object({ hostId: z.string(), name: z.string(), connected: z.boolean(), server: z.boolean() })) }),
  },
  getReviewerNotes: { input: targetKey, output: z.object({ body: z.string(), revision: z.number().int() }) },
  saveReviewerNotes: {
    input: z.object({ targetKey: z.string(), body: z.string().max(100000), revision: z.number().int().min(0) }).strict(),
    output: z.object({ body: z.string(), revision: z.number().int() }),
  },
  ping: { input: z.null(), output: z.object({ ok: z.boolean() }) },

  // Panel: start a review by pasting a GitHub PR URL
  startReview: {
    input: z.object({ input: z.string().min(1) }).strict(),
    output: z.object({ ok: z.boolean(), error: z.string().optional(), targetKey: z.string().optional() }),
  },

  // Task 10: read data plane. sync: how reading GitHub went (src/review-lifecycle.ts SyncHealth).
  listReviews: { input: z.null(), output: z.object({ reviews: z.array(z.any()), sync: syncHealth.optional() }) },
  /** force: false reads only what's due, as the background sync does; true or null reads everything now. */
  refreshReviews: { input: z.object({ force: z.boolean() }).strict().nullable(), output: z.object({ reviews: z.array(z.any()), sync: syncHealth.optional() }) },
  getReview: { input: targetKey, output: z.object({ review: z.any().nullable() }) },
  getGuide: { input: targetKey, output: z.object({ guide: z.any().nullable(), status: z.string() }) },
  getPatch: { input: targetKey, output: z.object({ patch: z.string() }) },
  getPr: { input: targetKey, output: z.object({ pr: z.any().nullable() }) },
  getThreads: { input: targetKey, output: z.object({ comments: z.array(z.any()) }) },
  getChecks: { input: targetKey, output: z.object({ bucket: z.string(), checks: z.array(z.any()) }) },
  /** A changed file's whole old and new contents (null on a side it doesn't exist), or why only its diff can show. */
  /** Failure annotations of the reviewed head's failed check runs, to show on their lines. */
  getCheckFailures: {
    input: targetKey,
    output: z.object({ failures: z.array(z.object({ file: z.string(), line: z.number().int(), check: z.string(), title: z.string().nullable(), message: z.string(), url: z.string() })) }),
  },
  /** The changed files the repo's .gitattributes marks linguist-generated or linguist-vendored. */
  getGeneratedFiles: { input: targetKey, output: z.object({ files: z.array(z.string()) }) },
  getFileContents: {
    input: z.object({ targetKey: z.string(), file: z.string() }).strict(),
    output: z.union([z.object({ ok: z.literal(true), old: z.string().nullable(), new: z.string().nullable() }), z.object({ ok: z.literal(false), error: z.string() })]),
  },

  // Phase 2: review threads, reply/resolve, staleness, re-review
  /** error: GitHub couldn't be read, or not every page; threads holds what was. */
  getReviewThreads: { input: targetKey, output: z.object({ threads: z.array(z.any()), error: z.string().optional() }) },
  replyToThread: {
    input: z.object({ targetKey: z.string(), inReplyTo: z.number().int(), body: z.string().min(1) }).strict(),
    output: z.object({ ok: z.boolean(), error: z.string().optional() }),
  },
  resolveThread: {
    input: z.object({ targetKey: z.string(), threadId: z.string() }).strict(),
    output: z.object({ ok: z.boolean(), error: z.string().optional() }),
  },
  unresolveThread: {
    input: z.object({ targetKey: z.string(), threadId: z.string() }).strict(),
    output: z.object({ ok: z.boolean(), error: z.string().optional() }),
  },
  checkForUpdates: {
    input: targetKey,
    output: z.object({ hasNewCommits: z.boolean(), current: z.string().optional(), stored: z.string().optional() }),
  },
  rereview: {
    input: targetKey,
    output: z.object({ ok: z.boolean(), error: z.string().optional() }),
  },

  // Reviewer-managed archive, and permanent deletion of a review's saved data
  archiveReview: {
    input: z.object({ targetKey: z.string(), archived: z.boolean() }).strict(),
    output: z.object({ ok: z.boolean(), error: z.string().optional() }),
  },
  deleteReview: { input: targetKey, output: z.object({ ok: z.boolean(), error: z.string().optional() }) },

  // Task 11: draft + submit
  getDraft: { input: targetKey, output: draftOutput },
  saveDraftComment: {
    input: z.object({ targetKey: z.string(), revision: z.string().optional(), comment: commentShape }).strict(),
    output: draftOutput,
  },
  removeDraftComment: {
    input: z.object({ targetKey: z.string(), file: z.string(), line: z.number().int(), side: z.enum(["LEFT", "RIGHT"]) }).strict(),
    output: draftOutput,
  },
  // A message from a line's discussion, or the summary's (src/draft.ts SUMMARY_AT), to the review assistant, which answers there.
  askAgent: {
    input: z.object({ targetKey: z.string(), ...location, startLine: z.number().int().min(1).optional(), body: z.string().trim().min(1).max(20_000) }).strict(),
    output: draftOutput,
  },
  dismissDiscussion: { input: z.object({ targetKey: z.string(), ...location }).strict(), output: draftOutput },
  /** Undo the agent's latest change in the discussion at a line, or the summary's. */
  undoAgentChange: { input: z.object({ targetKey: z.string(), ...location }).strict(), output: draftOutput },
  /** The reviewer picks a verdict. With body, from panels before the summary had its own box, it also saves the summary as theirs. */
  setVerdict: {
    input: z
      .object({
        targetKey: z.string(),
        revision: z.string().optional(),
        verdict: z.enum(["APPROVE", "REQUEST_CHANGES", "COMMENT"]),
        body: z.string().optional(),
      })
      .strict(),
    output: z.object({ draft: z.any() }),
  },
  /** The reviewer writes, edits, or (with an empty body) removes the review summary. */
  saveSummary: {
    input: z.object({ targetKey: z.string(), revision: z.string().optional(), body: z.string().max(65_000) }).strict(),
    output: draftOutput,
  },
  submitReview: {
    input: z.object({
      targetKey: z.string(), revision: z.string().optional(), account: z.string().optional(),
      // The comments, summary, and verdict the page shows; submission refuses a draft that no longer matches.
      comments: z.array(z.object({ file: z.string(), line: z.number().int(), side: z.enum(["LEFT", "RIGHT"]), body: z.string() })).optional(),
      body: z.string().optional(),
      verdict: z.enum(["APPROVE", "REQUEST_CHANGES", "COMMENT"]).optional(),
    }).strict(),
    // url: the posted review on GitHub.
    output: z.object({ ok: z.boolean(), error: z.string().optional(), url: z.string().optional() }),
  },

  // Feature 1: per-file "Viewed" state
  getFileViews: {
    input: targetKey,
    output: z.object({
      views: z.array(z.object({ file: z.string(), viewed: z.boolean(), stale: z.boolean() })),
    }),
  },
  setFileViewed: {
    input: z.object({ targetKey: z.string(), file: z.string(), viewed: z.boolean() }).strict(),
    output: z.object({ ok: z.boolean() }),
  },
  // Marks a chapter's files viewed at once.
  setFilesViewed: {
    input: z.object({ targetKey: z.string(), files: z.array(z.string()) }).strict(),
    output: z.object({ ok: z.boolean() }),
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
    input: z.object({ targetKey: z.string(), text: z.string().min(1), agent: agentChoiceSchema }).strict(),
    output: z.object({ threadId: z.string() }),
  },
  newConversation: { input: targetKey, output: z.object({ ok: z.boolean() }) },

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
  checkRepoAccess: {
    input: z.object({ targetKey: z.string() }).strict(),
    output: z.object({ accessible: z.boolean(), repo: z.string().nullable(), account: z.string().nullable() }),
  },

  // Whose turn. Reviews carry `turn` (lib/turn.ts Turn) and `progress` from the server.
  /** "Not yet": back to Waiting on author until a newer signal. snoozed: false undoes it. */
  snoozeReview: {
    input: z.object({ targetKey: z.string(), snoozed: z.boolean() }).strict(),
    output: z.object({ ok: z.boolean(), error: z.string().optional() }),
  },
  /** The reviewer opened the review: clear its Needs You alert. */
  markSeen: { input: targetKey, output: z.object({ ok: z.boolean() }) },
  /** Generate the guide for a review found on GitHub (status "tracked"). */
  startTrackedReview: { input: targetKey, output: z.object({ ok: z.boolean(), error: z.string().optional() }) },

  // Your feedback and the assistant's check of it (lib/feedback.ts FeedbackView).
  getFeedback: { input: targetKey, output: z.object({ feedback: z.any() }) },
  /** Re-read your threads from GitHub first. */
  refreshFeedback: { input: targetKey, output: z.object({ feedback: z.any() }) },
  /** Ask the assistant to check your feedback against the PR now. */
  checkFeedback: { input: targetKey, output: z.object({ ok: z.boolean(), error: z.string().optional() }) },
  /** Post a reply to one of your threads on GitHub and clear its drafted reply. */
  replyToFeedback: {
    input: z.object({ targetKey: z.string(), threadId: z.string(), body: z.string().trim().min(1).max(65_000) }).strict(),
    output: z.object({ ok: z.boolean(), error: z.string().optional(), feedback: z.any().optional() }),
  },
  saveReplyDraft: {
    input: z.object({ targetKey: z.string(), threadId: z.string(), body: z.string().max(65_000) }).strict(),
    output: z.object({ ok: z.boolean() }),
  },
  discardReplyDraft: { input: z.object({ targetKey: z.string(), threadId: z.string() }).strict(), output: z.object({ ok: z.boolean() }) },
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
   * baseline null: you haven't reviewed it, or it's the same commit.
   */
  getSinceReview: {
    input: targetKey,
    output: z.object({
      baseline: z.object({ sha: z.string(), at: z.number().nullable(), verdict: z.string().nullable() }).nullable(),
      files: z.array(z.any()),
      error: z.string().optional(),
    }),
  },
});
