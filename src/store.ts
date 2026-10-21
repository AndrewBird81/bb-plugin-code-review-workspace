import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { renameOverviewChapter, type Guide } from "./guide";
import { sameLocation, type CommentLocation, type Discussion, type DiscussionEntry, type Draft, type DraftComment, type Severity, type Verdict } from "./draft";
import { createHash, randomUUID } from "node:crypto";
import { preferencesSchema, readPreferences, unknownKnobs, type PreferencesRecord, type ReviewPreferences, type ReviewerNotesRecord } from "./preferences";
import type { AssessmentSummary, TurnSignals } from "../lib/turn";
import type { AssessmentItem, AssessmentRun, ReplyDraft } from "../lib/feedback";
import type { FeedbackThread } from "./github/types";
import { diffPositions, rangeProblem, type FilePositions } from "./review-positions";
import { reanchorIn } from "./reanchor";
import { renamedPaths } from "./patch";
import { fileHashCache, type FileHashes } from "./file-views";
import { agentCommentStore, type AgentCommentStore } from "./learning";
import { importFormerInstall } from "./former-install";
import { sqliteSql, type Sql } from "./db/sql";

export interface ReviewLifecycle {
  prState?: "OPEN" | "CLOSED" | "MERGED";
  /** The PR's state as gh read it when the review last started or rebuilt, until the sync reads the PR. Only the sync writes prState. */
  startedPrState?: "OPEN" | "CLOSED" | "MERGED" | null;
  archivedAt?: number | null;
  /** Archived by the reviewer. GitHub sync owns archivedAt and never changes this. */
  userArchivedAt?: number | null;
  /** Pinned by the reviewer, into BB's Pinned group in the thread list, since this time. */
  pinnedAt?: number | null;
  /** The reviewer's own name for the review, shown in place of its PR's title or ref (lib/review-name.ts); null for none. */
  name?: string | null;
  /** The thread `bb review` last ran in for this review, since `sourceThreadAt`: where the change was made. Never one of this plugin's agents. */
  sourceThreadId?: string | null;
  sourceThreadAt?: number | null;
  /** The draft comments last sent to the source thread, each since when, and the thread's title then. Sending submits nothing. */
  sent?: { at: number; threadId: string; title: string | null; comments: Array<CommentLocation & { at: number; body?: string }> } | null;
  submittedVerdict?: Verdict | null;
  submittedAt?: number | null;
  submittedHeadSha?: string | null;
  reviewer?: string | null;
  latestHeadSha?: string;
  /** The PR's base branch as the sync last read it; `base` stays the one the guide was written against. */
  latestBase?: string;
  /** Why the last guide failed: its last rejection, or what stopped its writer. Cleared when a guide starts or is accepted. */
  guideError?: { at: number; text: string } | null;
  /** What GitHub says about whose turn it is. */
  signals?: TurnSignals | null;
  /** Snoozed until the author responds: hidden from Needs review until a newer signal. */
  snoozedAt?: number | null;
  /** Snooze until: hidden from Needs review until this time, or a newer signal. */
  snoozedUntil?: number | null;
  /** The assistant's latest check of your feedback. */
  assessment?: AssessmentSummary | null;
  /** The changed files the review's assistant read through Code Review Workspace, at `head`: a PR's head commit, or "diff:" and a local review's diff hash (src/agent-reads.ts). */
  agentReads?: { head: string; files: string[] } | null;
  /** The signal that last alerted Needs You, so one event alerts once. */
  notifiedSignal?: string | null;
  /** The head commit the automatic re-review or check last ran for. */
  autoRunHead?: string | null;
  /** The group the review was last in, so leaving Needs review clears its alert. */
  turnGroup?: "needs" | "waiting" | "reviewed" | "archive" | null;
  /** An alert waiting for its re-review to be prepared. */
  pendingAlert?: { signal: string; since: number } | null;
  /** The assistant is checking your feedback, since this time. */
  verifyingSince?: number | null;
  /** The feedback check's message while it waits in the assistant's queue; cleared once it dispatches, so its own turn ends the check. */
  verifyingMessageId?: string | null;
  /** When the automatic re-review or check last finished. */
  preparedAt?: number | null;
  /** Your latest review summaries, newest last, for the assistant. */
  reviewBodies?: Array<{ state: string; at: number; body: string }>;
  /**
   * The reviewer asked on the review summary. Their summary is open to the turn that carries the ask, on
   * this conversation thread (null until a new one is spawned): "sending" until the send returns,
   * "queued" while the message waits in the thread's queue as `queuedMessageId`, "running" once its
   * turn is under way, since `at`.
   */
  summaryAsk?: Ask | null;
  /** The reviewer asked the assistant to dig deeper into this chapter (src/deep-dive.ts), until the turn that carries it ends. */
  deepDive?: { chapterId: string; ask: Ask } | null;
  /** The reviewer asked on draft comments: each opens the reviewer's comment there as summaryAsk opens the summary. */
  commentAsks?: Array<CommentLocation & { ask: Ask }>;
  /** When bb first read the PR's state. Earlier events don't alert or start work. */
  watchingSince?: number | null;
  /** Found on GitHub with a request for your review that you haven't been told about. */
  newRequest?: boolean | null;
  /** A turn from a passing state (feedback handled, looks ready) that holds until you act. */
  heldTurn?: { reason: import("../lib/turn").TurnReason; label: string; signal: string; at: number } | null;
  /** The GitHub id of the review submitted here, to recognize it once GitHub reports it. */
  submittedReviewId?: string | null;
  /** The head commit the assistant is checking. */
  verifyingHead?: string | null;
  /** The head commit when bb first read the PR; pushes before it are history. */
  watchedHead?: string | null;
  /** The turn signal whose re-review was prepared, or needed none. */
  preparedSignal?: string | null;
  /** When preparing a re-review was last tried, to retry a failed start now and then. */
  prepareTriedAt?: number | null;
  /** When checking the author's settled pushes was last tried, to retry a failed start now and then. */
  pushCheckTriedAt?: number | null;
  /** A guide a reload interrupted waits, since this time, for its writer's machine to reconnect (src/interrupted-guides.ts). */
  restartPending?: { since: number } | null;
  /** The PR's author is the GitHub account reading it. */
  ownPr?: boolean | null;
  /** How the PR's author is related to its repository, as GitHub last said (OWNER, MEMBER, …). Unset until read. */
  authorAssociation?: string | null;
  /** Who owns the fork the head branch is in, when that's neither the author nor you: they can push to it (lib/trust.ts). "" for a fork GitHub no longer shows; null for none. */
  foreignHeadOwner?: string | null;
  /** The head commit you started agents on (lib/trust.ts): runs that follow on it start with no click, whoever the author. */
  approvedHead?: string | null;
  /** When you started agents on approvedHead; an edit to the PR's text after it needs a new click (lib/trust.ts). */
  approvedAt?: number | null;
  /** When the PR's title or description was last edited, as GitHub last said; null for never. */
  prEditedAt?: number | null;
  /**
   * A run that didn't start on its own because the author isn't trusted, or (why "settings") Start agents on their own
   * is off, or (why "failed") it couldn't start, saying `error`, for the reviewer to start with one click.
   */
  skippedRun?: { run: "guide" | "review" | "check"; head: string | null; at: number; why?: "settings" | "failed"; error?: string } | null;
  /** Lines added and deleted, and files changed, as GitHub last said. */
  prSize?: { additions: number; deletions: number; files: number } | null;
  /** GitHub can't find the PR, or refuses access, since this time. */
  unreachable?: { since: number; reason: "not-found" | "forbidden" } | null;
  /** The open PR whose head is this PR's base branch, as GitHub last said; null for none. Unset until read. */
  stackParent?: { number: number; title: string; url: string } | null;
}

/** The turn of the reviewer's ask on the summary or a draft comment (src/asks.ts). */
export type Ask = { threadId: string | null; state: "sending" | "queued" | "running"; queuedMessageId?: string; at: number };

export interface ReviewMeta extends ReviewLifecycle {
  targetKey: string;
  kind: "pr" | "ref";
  number?: number;
  repo?: string;
  title?: string;
  author?: string;
  base?: string;
  head?: string;
  gitRef?: string;
  url?: string;
  /** tracked: found on GitHub, with no guide yet. */
  status: "generating" | "ready" | "error" | "tracked";
  createdAt: number;
  projectId?: string;
  headSha?: string;
  cwd?: string;
}

export interface FileView {
  file: string;
  hash: string;
  viewedAt: number;
}

export interface AgentMessageContext {
  file?: string;
  startLine?: number;
  endLine?: number;
  /** Which column a line range was picked on (new vs old file). */
  side?: "additions" | "deletions";
  code?: string;
  chapterId?: string;
}

export interface AgentMessage {
  id: number;
  role: "user" | "assistant";
  text: string;
  context: AgentMessageContext | null;
  createdAt: number;
}

export interface Store extends AgentCommentStore {
  getPreferences(): Promise<PreferencesRecord>;
  savePreferences(preferences: ReviewPreferences, revision: number): Promise<PreferencesRecord>;
  getReviewerNotes(targetKey: string): Promise<ReviewerNotesRecord>;
  saveReviewerNotes(targetKey: string, body: string, revision: number): Promise<ReviewerNotesRecord>;
  saveReview(meta: ReviewMeta): Promise<void>;
  getReview(targetKey: string): Promise<ReviewMeta | null>;
  listReviews(): Promise<ReviewMeta[]>;
  setStatus(targetKey: string, status: ReviewMeta["status"]): Promise<void>;
  setLifecycle(targetKey: string, state: ReviewLifecycle): Promise<void>;
  /** Context for the assistant's automatic review, from `bb review --context`. */
  getReviewContext(targetKey: string): Promise<string | null>;
  /** null removes it. */
  setReviewContext(targetKey: string, text: string | null): Promise<void>;
  /** Remove the review and everything stored for it. */
  deleteReview(targetKey: string): Promise<void>;
  savePatch(targetKey: string, patch: string): Promise<void>;
  patch(targetKey: string): Promise<string>;
  /** Whether the review has a diff stored; pruneOldDiffs drops it. */
  hasPatch(targetKey: string): Promise<boolean>;
  /** Forget the review's diff and any guide kept for a rebuild, to read the diff again when it's opened. */
  dropPatch(targetKey: string): Promise<void>;
  /** SHA-256 of the stored patch, kept since it was saved. */
  patchHash(targetKey: string): Promise<string>;
  /** The stored patch's commentable lines by file, parsed once per patch. Read-only. */
  diffPositions(targetKey: string): Promise<Map<string, FilePositions>>;
  /** The stored patch's file hashes, each taken once per patch. */
  fileHashes(targetKey: string): Promise<FileHashes>;
  saveGuide(targetKey: string, guide: Guide): Promise<void>;
  getGuide(targetKey: string): Promise<Guide | null>;
  beginGeneration(targetKey: string): Promise<string>;
  /** Keep the current guide and diff, to put back if regenerating them fails. */
  backupGuide(targetKey: string): Promise<void>;
  /** Put the kept guide and diff back. False when there's nothing kept. */
  restoreGuide(targetKey: string): Promise<boolean>;
  /** The head commit of the guide kept by backupGuide, if any. */
  guideBackupHead(targetKey: string): Promise<string | null>;
  dropGuideBackup(targetKey: string): Promise<void>;
  isCurrentGeneration(targetKey: string, generationId: string): Promise<boolean>;
  /** Record the hidden thread writing a generation's guide, to stop it if the plugin reloads first. */
  setGenerationWorker(targetKey: string, generationId: string, workerId: string): Promise<void>;
  /** The review whose current generation's guide this thread writes, if any. */
  generationOf(workerId: string): Promise<string | null>;
  /** The hidden thread writing the review's current generation's guide, if one was recorded. */
  generationWorker(targetKey: string): Promise<string | null>;
  /** Every generation's recorded worker, by review: what generationOf answers, for src/configure-view.ts. */
  listGenerationWorkers(): Promise<Array<{ targetKey: string; workerId: string }>>;
  /** End the generations a reload interrupted, putting back their previous guides. Returns them, with their workers. */
  interruptGenerations(): Promise<Array<{ targetKey: string; workerId: string | null }>>;
  getDraft(targetKey: string): Promise<Draft>;
  upsertDraftComment(targetKey: string, c: DraftComment): Promise<Draft>;
  /**
   * Change only a comment's text, with `severity` its severity, and with `evidence` how the agent checked it (null
   * for none of either), and with `introduced` whether the PR introduced it, keeping who added it and the diff it was
   * drafted against. Null when there's no comment there.
   */
  editDraftComment(targetKey: string, at: CommentLocation, body: string, severity?: Severity | null, evidence?: string | null, introduced?: boolean): Promise<Draft | null>;
  /** Null when there's no comment there. */
  deleteDraftComment(targetKey: string, at: CommentLocation): Promise<Draft | null>;
  /** The reviewer picks a verdict. With body, they also write the summary. */
  setVerdict(targetKey: string, verdict: Verdict, body?: string): Promise<Draft>;
  /** Change the summary and its verdicts. A field given as undefined is cleared. */
  updateSummary(targetKey: string, change: SummaryChange): Promise<Draft>;
  staleDraftComments(targetKey: string): Promise<DraftComment[]>;
  clearSubmittedDraft(draft: Draft): Promise<void>;
  // Discussions with the review assistant at lines of the diff.
  listDiscussions(targetKey: string): Promise<Discussion[]>;
  /** A reviewer's message waits for the assistant; the assistant's answers it. */
  addDiscussionMessage(targetKey: string, at: CommentLocation, author: DiscussionEntry["author"], body: string, startLine?: number): Promise<void>;
  /**
   * Record an agent's change to the draft comment or summary at a discussion, which answers it:
   * `body`, the text it left, and `previous`, what was there before, to undo it.
   */
  noteDiscussionChange(targetKey: string, at: CommentLocation, kind: "added" | "edited" | "removed", change?: { body: string; previous: PreviousState }): Promise<void>;
  /** The latest entry at a discussion, when it's an agent's change that recorded what came before. */
  lastDiscussionChange(targetKey: string, at: CommentLocation): Promise<{ kind: "added" | "edited" | "removed"; body: string; previous: PreviousState } | null>;
  /** Record that the reviewer undid the agent's latest change there. */
  noteDiscussionRestored(targetKey: string, at: CommentLocation): Promise<void>;
  deleteDiscussion(targetKey: string, at: CommentLocation): Promise<void>;
  clearDiscussions(targetKey: string): Promise<void>;
  /** Stop waiting for answers, for example once the assistant finishes. False when none were waiting. */
  stopWaiting(targetKey: string): Promise<boolean>;
  // Per-file "Viewed" state.
  getFileViews(targetKey: string): Promise<FileView[]>;
  /** `viewedAt`, when Undo puts back a view as it was; otherwise now. */
  setFileViewed(targetKey: string, file: string, hash: string, viewedAt?: number): Promise<void>;
  unsetFileViewed(targetKey: string, file: string): Promise<void>;
  // Legacy review-agent worker and plugin-stored chat log, read-only since
  // conversations moved into bb threads.
  getAgentThread(targetKey: string): Promise<string | null>;
  clearAgentThread(targetKey: string): Promise<void>;
  listAgentMessages(targetKey: string): Promise<AgentMessage[]>;
  clearAgentMessages(targetKey: string): Promise<void>;
  // The hidden bb thread behind a review's assistant chat.
  getAssistantThread(targetKey: string): Promise<string | null>;
  setAssistantThread(targetKey: string, threadId: string): Promise<void>;
  clearAssistantThread(targetKey: string): Promise<void>;
  listAssistantThreads(): Promise<Array<{ targetKey: string; threadId: string }>>;
  // The PR's diff at commits you reviewed or the sync read, for "since your review".
  saveSnapshot(targetKey: string, headSha: string, patch: string): Promise<void>;
  getSnapshot(targetKey: string, headSha: string): Promise<string | null>;
  /** Keep only these heads' snapshots. */
  pruneSnapshots(targetKey: string, keep: readonly string[]): Promise<void>;
  // Your review threads on the PR, as last read from GitHub.
  /** Returns whether the threads changed: the first read always does. */
  saveFeedbackThreads(targetKey: string, threads: FeedbackThread[], prUpdatedAt: number | null): Promise<boolean>;
  listFeedbackThreads(targetKey: string): Promise<Array<FeedbackThread & { resolvedSeenAt: number | null }>>;
  feedbackFetched(targetKey: string): Promise<{ fetchedAt: number; prUpdatedAt: number | null } | null>;
  /** Forget when every review's threads were read, so they're read again (after a GitHub account switch). */
  clearFeedbackFetches(): Promise<void>;
  // The assistant's check of your feedback, per head commit.
  saveAssessmentItems(targetKey: string, headSha: string, items: AssessmentItem[]): Promise<void>;
  saveAssessmentRun(targetKey: string, run: AssessmentRun): Promise<void>;
  getAssessment(targetKey: string, headSha: string): Promise<{ items: AssessmentItem[]; run: AssessmentRun | null }>;
  /** The latest run for any head. */
  latestAssessmentRun(targetKey: string): Promise<AssessmentRun | null>;
  // Replies to your threads, drafted here and posted only when you send them.
  setReplyDraft(targetKey: string, threadId: string, body: string, author: ReplyDraft["author"]): Promise<void>;
  listReplyDrafts(targetKey: string): Promise<Map<string, ReplyDraft>>;
  deleteReplyDraft(targetKey: string, threadId: string): Promise<void>;
  // PRs you deleted from the list, which discovery mustn't add back.
  ignoreDiscovery(targetKey: string): Promise<void>;
  unignoreDiscovery(targetKey: string): Promise<void>;
  isDiscoveryIgnored(targetKey: string): Promise<boolean>;
  /** The text a draft comment's line, or with "start" its range's first line, had when it was drafted. */
  draftCommentCode(targetKey: string, at: CommentLocation, end?: "start" | "line"): Promise<string | undefined>;
  /**
   * Mark draft comments as drafted against the current diff, each at a possibly new line, all at once.
   * A comment whose new place another comment ends up on stays where it was, drafted against the older diff.
   */
  rebaseDraftComments(targetKey: string, placements: ReadonlyArray<{ at: CommentLocation; line: number; startLine?: number }>): Promise<void>;
}

/** A summary change: any of these fields, where undefined clears it. */
export type SummaryChange = Partial<Pick<Draft, "verdict" | "body" | "bodyAuthor" | "suggestedVerdict" | "written" | "verdictChosen" | "unchecked">>;

/** What a comment or the summary was before an agent changed it; null when there was none. */
/**
 * What a comment or the summary was before an agent changed it; null when there was none. For a summary
 * change that suggested a verdict, `suggested` is that verdict and `suggestedVerdict` the one before (null for none).
 * For a comment's edit, `startCode` is the code its first line was drafted on.
 */
export type PreviousState = { body: string; author?: "agent"; severity?: Severity; evidence?: string; introduced?: false; chapterId?: string; startLine?: number; startSide?: "LEFT" | "RIGHT"; startCode?: string; relined?: true; written?: Draft["written"]; suggestedVerdict?: Verdict | null; suggested?: Verdict } | null;

/**
 * The statements bb.storage.migrate applies to the plugin's SQLite database, each at its index for good, and mirrored
 * by src/db/pg-migrations.ts. _bb_migrations records each one's SHA-256, so its text stays as it is, indentation and all.
 */
export const SQLITE_MIGRATIONS: readonly string[] = [
    `CREATE TABLE IF NOT EXISTS reviews (
      target_key TEXT PRIMARY KEY, kind TEXT NOT NULL, number INTEGER, repo TEXT,
      title TEXT, author TEXT, base TEXT, head TEXT, git_ref TEXT, url TEXT,
      status TEXT NOT NULL, created_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS patches (target_key TEXT PRIMARY KEY, patch TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS guides (target_key TEXT PRIMARY KEY, guide TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS drafts (target_key TEXT PRIMARY KEY, verdict TEXT NOT NULL, body TEXT NOT NULL, comments TEXT NOT NULL)`,
    `ALTER TABLE reviews ADD COLUMN project_id TEXT`,
    `ALTER TABLE reviews ADD COLUMN head_sha TEXT`,
    `ALTER TABLE reviews ADD COLUMN cwd TEXT`,
    `CREATE TABLE IF NOT EXISTS file_views (
      target_key TEXT NOT NULL, file TEXT NOT NULL,
      hash TEXT NOT NULL, viewed_at INTEGER NOT NULL,
      PRIMARY KEY (target_key, file))`,
    `CREATE TABLE IF NOT EXISTS agent_threads (
      target_key TEXT PRIMARY KEY, thread_id TEXT NOT NULL, created_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS agent_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, target_key TEXT NOT NULL,
      role TEXT NOT NULL, text TEXT NOT NULL, context TEXT, created_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS generations (target_key TEXT PRIMARY KEY, generation_id TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS draft_comment_revisions (
      target_key TEXT NOT NULL, file TEXT NOT NULL, line INTEGER NOT NULL, side TEXT NOT NULL,
      patch_hash TEXT NOT NULL, PRIMARY KEY (target_key, file, line, side))`,
    `CREATE TABLE IF NOT EXISTS review_lifecycle (target_key TEXT PRIMARY KEY, state TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS review_preferences (id INTEGER PRIMARY KEY CHECK (id=1), value TEXT NOT NULL, revision INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS reviewer_notes (target_key TEXT PRIMARY KEY, body TEXT NOT NULL, revision INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS assistant_threads (target_key TEXT PRIMARY KEY, thread_id TEXT NOT NULL, created_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS review_context (target_key TEXT PRIMARY KEY, text TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS discussion_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT, target_key TEXT NOT NULL,
      file TEXT NOT NULL, line INTEGER NOT NULL, side TEXT NOT NULL,
      author TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL, start_line INTEGER, created_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS discussion_waits (
      target_key TEXT NOT NULL, file TEXT NOT NULL, line INTEGER NOT NULL, side TEXT NOT NULL,
      PRIMARY KEY (target_key, file, line, side))`,
    `CREATE TABLE IF NOT EXISTS review_snapshots (
      target_key TEXT NOT NULL, head_sha TEXT NOT NULL, patch TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY (target_key, head_sha))`,
    `CREATE TABLE IF NOT EXISTS feedback_threads (
      target_key TEXT NOT NULL, thread_id TEXT NOT NULL, data TEXT NOT NULL, resolved_seen_at INTEGER,
      PRIMARY KEY (target_key, thread_id))`,
    `CREATE TABLE IF NOT EXISTS feedback_fetches (target_key TEXT PRIMARY KEY, fetched_at INTEGER NOT NULL, pr_updated_at INTEGER)`,
    `CREATE TABLE IF NOT EXISTS assessment_items (
      target_key TEXT NOT NULL, head_sha TEXT NOT NULL, item_id TEXT NOT NULL, data TEXT NOT NULL,
      PRIMARY KEY (target_key, head_sha, item_id))`,
    `CREATE TABLE IF NOT EXISTS assessment_runs (
      target_key TEXT NOT NULL, head_sha TEXT NOT NULL, data TEXT NOT NULL, assessed_at INTEGER NOT NULL,
      PRIMARY KEY (target_key, head_sha))`,
    `CREATE TABLE IF NOT EXISTS reply_drafts (
      target_key TEXT NOT NULL, thread_id TEXT NOT NULL, body TEXT NOT NULL, author TEXT NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (target_key, thread_id))`,
    `CREATE TABLE IF NOT EXISTS discovery_ignores (target_key TEXT PRIMARY KEY, ignored_at INTEGER NOT NULL)`,
    `ALTER TABLE draft_comment_revisions ADD COLUMN code TEXT`,
    `CREATE TABLE IF NOT EXISTS guide_backups (target_key TEXT PRIMARY KEY, data TEXT NOT NULL)`,
    // Who wrote the summary, and the verdicts around it (Draft's bodyAuthor, suggestedVerdict, written, verdictChosen).
    `ALTER TABLE drafts ADD COLUMN meta TEXT`,
    // Before an agent's change, the comment or summary it replaced, as JSON.
    `ALTER TABLE discussion_entries ADD COLUMN previous TEXT`,
    `ALTER TABLE generations ADD COLUMN worker_id TEXT`,
    // SHA-256 of the patch, so a click doesn't read and hash the whole patch for it.
    `ALTER TABLE patches ADD COLUMN hash TEXT`,
    // A range comment's first line's text when it was drafted.
    `ALTER TABLE draft_comment_revisions ADD COLUMN start_code TEXT`,
    // The reviewer's removals and edits of agents' draft comments (src/learning.ts), and their outcomes once submitted.
    `CREATE TABLE IF NOT EXISTS agent_comment_changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, target_key TEXT NOT NULL, file TEXT NOT NULL, line INTEGER NOT NULL, side TEXT NOT NULL,
      kind TEXT NOT NULL, code TEXT, body TEXT NOT NULL, removed TEXT, at INTEGER NOT NULL, recorded INTEGER NOT NULL DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS agent_comment_outcomes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, repo TEXT NOT NULL, file TEXT NOT NULL, outcome TEXT NOT NULL, body TEXT NOT NULL, edited TEXT, at INTEGER NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS discussion_entries_location ON discussion_entries (target_key, file, line, side)`,
    // Settings knobs as JSON, kept out of value so an older release's strict read of value still parses.
    `ALTER TABLE review_preferences ADD COLUMN knobs TEXT`,
    // Why the reviewer removed an agent's comment, and their line about it, as JSON (lib/removal-reasons.ts).
    `ALTER TABLE agent_comment_changes ADD COLUMN reason TEXT`,
];

/** The plugin's SQLite database, a former install brought in and SQLITE_MIGRATIONS applied, as the Store opens it. */
export function migrateSqlite(bb: BbPluginApi) {
  const db = bb.storage.database();
  importFormerInstall(bb, db);
  bb.storage.migrate(db, [...SQLITE_MIGRATIONS]);
  return db;
}

export function createStore(bb: BbPluginApi): Store {
  return storeOn(sqliteSql(migrateSqlite(bb)));
}

/** The Store over `sql`, on the tables the migrations above make, or on Postgres those of src/db/pg-migrations.ts. */
export function storeOn(sql: Sql): Store {
  const at = (k: string, { file, line, side }: CommentLocation) => [k, file, line, side] as const;
  const hasDiscussion = async (k: string, location: CommentLocation) =>
    !!await sql.get(`SELECT 1 FROM discussion_entries WHERE target_key=? AND file=? AND line=? AND side=? LIMIT 1`, at(k, location));
  const stopWaitingAt = (k: string, location: CommentLocation) =>
    sql.run(`DELETE FROM discussion_waits WHERE target_key=? AND file=? AND line=? AND side=?`, at(k, location));
  const patchText = async (k: string) => (await sql.get<{ patch: string }>(`SELECT patch FROM patches WHERE target_key=?`, [k]))?.patch ?? "";
  // What's parsed from each review's patch, by the patch's hash, for the few reviews used last.
  const parsed = new Map<string, { hash: string; positions?: Map<string, FilePositions>; renamed?: Map<string, string>; followed?: boolean; fileHashes?: FileHashes }>();
  const parsedPatch = async (k: string) => {
    const hash = await storedPatchHash(k);
    let entry = parsed.get(k);
    parsed.delete(k);
    if (entry?.hash !== hash) entry = { hash };
    parsed.set(k, entry);
    if (parsed.size > PARSED_REVIEWS) parsed.delete(parsed.keys().next().value!);
    return { entry, patch: () => patchText(k) };
  };
  const storedPatchHash = async (k: string): Promise<string> => {
    const row = await sql.get<{ hash: string | null }>(`SELECT hash FROM patches WHERE target_key=?`, [k]);
    if (!row) return patchHash("");
    if (row.hash) return row.hash;
    // A patch saved before the hash was kept.
    const hash = patchHash(await patchText(k));
    await sql.run(`UPDATE patches SET hash=? WHERE target_key=?`, [hash, k]);
    return hash;
  };
  // Files were once keyed by their old path when renamed; what was saved then moves to the new path when read.
  const renamesOf = async (k: string) => {
    const { entry, patch } = await parsedPatch(k);
    return entry.renamed ??= renamedPaths(await patch());
  };
  // New writes use the new path, so the rows move once per diff.
  const followRenames = async (k: string) => {
    const { entry, patch } = await parsedPatch(k);
    const renamed = entry.renamed ??= renamedPaths(await patch());
    if (renamed.size && !entry.followed) await sql.transaction(async () => {
      for (const [from, to] of renamed) {
        // As UPDATE OR IGNORE did, a row whose key is taken at the new path stays at the old one. discussion_entries has no such key.
        await sql.run(`UPDATE draft_comment_revisions SET file=? WHERE target_key=? AND file=? AND NOT EXISTS (SELECT 1 FROM draft_comment_revisions x
          WHERE x.target_key=draft_comment_revisions.target_key AND x.file=? AND x.line=draft_comment_revisions.line AND x.side=draft_comment_revisions.side)`, [to, k, from, to]);
        await sql.run(`UPDATE discussion_entries SET file=? WHERE target_key=? AND file=?`, [to, k, from]);
        await sql.run(`UPDATE discussion_waits SET file=? WHERE target_key=? AND file=? AND NOT EXISTS (SELECT 1 FROM discussion_waits x
          WHERE x.target_key=discussion_waits.target_key AND x.file=? AND x.line=discussion_waits.line AND x.side=discussion_waits.side)`, [to, k, from, to]);
        await sql.run(`UPDATE file_views SET file=? WHERE target_key=? AND file=? AND NOT EXISTS (SELECT 1 FROM file_views x
          WHERE x.target_key=file_views.target_key AND x.file=?)`, [to, k, from, to]);
      }
    });
    entry.followed = true;
    return renamed;
  };
  const followDraftRenames = async (draft: Draft): Promise<Draft> => {
    if (!draft.comments.length) return draft;
    const renamed = await followRenames(draft.targetKey);
    if (!draft.comments.some((c) => renamed.has(c.file))) return draft;
    const moved = { ...draft, comments: draft.comments.map((c) => ({ ...c, file: renamed.get(c.file) ?? c.file })) };
    await writeDraft(sql, moved);
    return moved;
  };

  const rowToMeta = (r: any): ReviewMeta => ({
    targetKey: r.target_key, kind: r.kind, number: r.number ?? undefined, repo: r.repo ?? undefined,
    title: r.title ?? undefined, author: r.author ?? undefined, base: r.base ?? undefined,
    head: r.head ?? undefined, gitRef: r.git_ref ?? undefined, url: r.url ?? undefined,
    status: r.status, createdAt: r.created_at, projectId: r.project_id ?? undefined,
    headSha: r.head_sha ?? undefined, cwd: r.cwd ?? undefined,
    // The review's reads join its lifecycle in as `lifecycle`.
    ...JSON.parse(r.lifecycle ?? "{}"),
  });
  const reviewsWithLifecycle = `SELECT r.target_key, r.kind, r.number, r.repo, r.title, r.author, r.base, r.head, r.git_ref, r.url, r.status,
    r.created_at, r.project_id, r.head_sha, r.cwd, l.state AS lifecycle FROM reviews r LEFT JOIN review_lifecycle l ON l.target_key=r.target_key`;

  return {
    ...agentCommentStore(sql),
    async getPreferences() {
      const row = await sql.get<{ value: string; revision: number; knobs: string | null }>(`SELECT value, revision, knobs FROM review_preferences WHERE id=1`);
      // No row, or a value that won't parse: defaults, as fresh copies.
      let value = {};
      try { if (row) value = JSON.parse(row.value); } catch { /* reads as defaults */ }
      const preferences = readPreferences(value, row?.knobs ?? null);
      return { preferences, revision: row?.revision ?? 0 };
    },
    async savePreferences(preferences, revision) {
      const parsed = preferencesSchema.parse(preferences);
      const { knobs, ...rest } = parsed;
      // Knobs this version doesn't know, saved by a newer one before a rollback, stay for it.
      const raw = (await sql.get<{ knobs: string | null }>(`SELECT knobs FROM review_preferences WHERE id=1`))?.knobs;
      const value = JSON.stringify(rest), saved = JSON.stringify({ ...unknownKnobs(raw ?? null), ...knobs });
      const result = revision === 0
        ? await sql.run(`INSERT INTO review_preferences (id,value,revision,knobs) VALUES (1,?,1,?) ON CONFLICT DO NOTHING`, [value, saved])
        : await sql.run(`UPDATE review_preferences SET value=?,knobs=?,revision=revision+1 WHERE id=1 AND revision=?`, [value, saved, revision]);
      if (!result.changes) throw new Error("Settings changed in another window. Reload settings before saving.");
      return { preferences: parsed, revision: revision + 1 };
    },
    async getReviewerNotes(targetKey) {
      return await sql.get<ReviewerNotesRecord>(`SELECT body, revision FROM reviewer_notes WHERE target_key=?`, [targetKey]) ?? { body: "", revision: 0 };
    },
    async saveReviewerNotes(targetKey, body, revision) {
      if (!await this.getReview(targetKey)) throw new Error("Review not found.");
      const result = revision === 0
        ? await sql.run(`INSERT INTO reviewer_notes (target_key,body,revision) VALUES (?,?,1) ON CONFLICT DO NOTHING`, [targetKey, body])
        : await sql.run(`UPDATE reviewer_notes SET body=?,revision=revision+1 WHERE target_key=? AND revision=?`, [body, targetKey, revision]);
      if (!result.changes) throw new Error("Notes changed in another window. Your text is kept here; reload the saved notes to compare.");
      return { body, revision: revision + 1 };
    },
    async saveReview(m) {
      await sql.run(
        `INSERT INTO reviews (target_key,kind,number,repo,title,author,base,head,git_ref,url,status,created_at,project_id,head_sha,cwd)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(target_key) DO UPDATE SET
           kind=excluded.kind,number=excluded.number,repo=excluded.repo,title=excluded.title,author=excluded.author,
           base=excluded.base,head=excluded.head,git_ref=excluded.git_ref,url=excluded.url,status=excluded.status,
           created_at=excluded.created_at,project_id=excluded.project_id,head_sha=excluded.head_sha,cwd=excluded.cwd`,
        [
          m.targetKey, m.kind, m.number ?? null, m.repo ?? null, m.title ?? null, m.author ?? null, m.base ?? null, m.head ?? null,
          m.gitRef ?? null, m.url ?? null, m.status, m.createdAt, m.projectId ?? null, m.headSha ?? null, m.cwd ?? null,
        ],
      );
    },
    async getReview(k) {
      const r = await sql.get(`${reviewsWithLifecycle} WHERE r.target_key=?`, [k]);
      return r ? rowToMeta(r) : null;
    },
    async listReviews() {
      return (await sql.all(`${reviewsWithLifecycle} ORDER BY r.created_at DESC, r.target_key`)).map(rowToMeta);
    },
    async setStatus(k, status) {
      await sql.run(`UPDATE reviews SET status=? WHERE target_key=?`, [status, k]);
    },
    async setLifecycle(k, state) {
      const previous = JSON.parse((await sql.get<{ state: string }>(`SELECT state FROM review_lifecycle WHERE target_key=?`, [k]))?.state ?? "{}");
      await sql.run(`INSERT INTO review_lifecycle (target_key,state) VALUES (?,?) ON CONFLICT(target_key) DO UPDATE SET state=excluded.state`,
        [k, JSON.stringify({ ...previous, ...state })]);
    },
    async getReviewContext(k) {
      return (await sql.get<{ text: string }>(`SELECT text FROM review_context WHERE target_key=?`, [k]))?.text ?? null;
    },
    async setReviewContext(k, text) {
      if (text === null) await sql.run(`DELETE FROM review_context WHERE target_key=?`, [k]);
      else await sql.run(`INSERT INTO review_context (target_key,text) VALUES (?,?) ON CONFLICT(target_key) DO UPDATE SET text=excluded.text`, [k, text]);
    },
    async deleteReview(k) {
      await sql.transaction(async () => {
        for (const table of REVIEW_TABLES) await sql.run(`DELETE FROM ${table} WHERE target_key=?`, [k]);
      });
    },
    async savePatch(k, patch) {
      await sql.run(
        `INSERT INTO patches (target_key,patch,hash) VALUES (?,?,?)
         ON CONFLICT(target_key) DO UPDATE SET patch=excluded.patch, hash=excluded.hash`,
        [k, patch, patchHash(patch)],
      );
    },
    patch: patchText,
    async hasPatch(k) {
      return !!await sql.get(`SELECT 1 FROM patches WHERE target_key=? AND patch != ''`, [k]);
    },
    async dropPatch(k) {
      await sql.transaction(async () => {
        await sql.run(`DELETE FROM patches WHERE target_key=?`, [k]);
        await sql.run(`DELETE FROM guide_backups WHERE target_key=?`, [k]);
      });
    },
    patchHash: storedPatchHash,
    async diffPositions(k) {
      const { entry, patch } = await parsedPatch(k);
      return entry.positions ??= diffPositions(await patch());
    },
    async fileHashes(k) {
      const { entry, patch } = await parsedPatch(k);
      // The patch is read in this call's turn of the queue: its hashes are taken later, when asked for.
      if (!entry.fileHashes) {
        const text = await patch();
        entry.fileHashes = fileHashCache(() => text);
      }
      return entry.fileHashes;
    },
    async saveGuide(k, guide) {
      await sql.run(
        `INSERT INTO guides (target_key,guide) VALUES (?,?)
         ON CONFLICT(target_key) DO UPDATE SET guide=excluded.guide`,
        [k, JSON.stringify(guide)],
      );
    },
    async getGuide(k) {
      const row = await sql.get<{ guide: string }>(`SELECT guide FROM guides WHERE target_key=?`, [k]);
      if (!row) return null;
      const guide = renameOverviewChapter(JSON.parse(row.guide) as Guide);
      const renamed = await renamesOf(k);
      if (!renamed.size) return guide;
      return { ...guide, sections: guide.sections.map((s) => ({ ...s, diffs: s.diffs.map((d) => ({ ...d, file: renamed.get(d.file) ?? d.file })) })), unplacedFiles: guide.unplacedFiles.map((f) => renamed.get(f) ?? f) };
    },
    async beginGeneration(k) {
      const id = randomUUID();
      await sql.transaction(async () => {
        await sql.run(`INSERT INTO generations (target_key,generation_id) VALUES (?,?) ON CONFLICT(target_key) DO UPDATE SET generation_id=excluded.generation_id, worker_id=NULL`, [k, id]);
        await sql.run(`DELETE FROM guides WHERE target_key=?`, [k]);
        await sql.run(`UPDATE reviews SET status='generating' WHERE target_key=?`, [k]);
        // Restarting a review (new PR link, `bb review`, Re-review) takes it out of the reviewer's archive.
        if ((await this.getReview(k))?.userArchivedAt) await this.setLifecycle(k, { userArchivedAt: null });
      });
      return id;
    },
    async isCurrentGeneration(k, id) {
      return (await sql.get<{ generation_id: string }>(`SELECT generation_id FROM generations WHERE target_key=?`, [k]))?.generation_id === id;
    },
    async setGenerationWorker(k, id, workerId) {
      await sql.run(`UPDATE generations SET worker_id=? WHERE target_key=? AND generation_id=?`, [workerId, k, id]);
    },
    async generationOf(workerId) {
      // Worker ids are spawned threads', so one names one generation; the first review, as listGenerationWorkers orders them.
      return (await sql.get<{ target_key: string }>(`SELECT target_key FROM generations WHERE worker_id=? ORDER BY target_key LIMIT 1`, [workerId]))?.target_key ?? null;
    },
    async generationWorker(k) {
      return (await sql.get<{ worker_id: string | null }>(`SELECT worker_id FROM generations WHERE target_key=?`, [k]))?.worker_id ?? null;
    },
    async listGenerationWorkers() {
      return (await sql.all<{ target_key: string; worker_id: string }>(`SELECT target_key, worker_id FROM generations WHERE worker_id IS NOT NULL ORDER BY target_key, worker_id`))
        .map((row) => ({ targetKey: row.target_key, workerId: row.worker_id }));
    },
    async interruptGenerations() {
      const interrupted = (await sql.all<{ target_key: string; worker_id: string | null }>(`SELECT r.target_key, g.worker_id FROM reviews r LEFT JOIN generations g ON g.target_key=r.target_key WHERE r.status='generating' ORDER BY r.target_key`))
        .map((row) => ({ targetKey: row.target_key, workerId: row.worker_id ?? null }));
      await sql.transaction(async () => {
        // An interrupted rebuild gets its previous guide back.
        for (const { targetKey } of interrupted) await this.restoreGuide(targetKey);
        // Completed identities are also durable notification receipts. Only
        // workers interrupted by this reload lose the right to finalize.
        await sql.run(`DELETE FROM generations WHERE target_key IN (SELECT target_key FROM reviews WHERE status='generating')`);
        await sql.run(`UPDATE reviews SET status='error' WHERE status='generating'`);
      });
      return interrupted;
    },
    async backupGuide(k) {
      const guide = await this.getGuide(k);
      const review = await this.getReview(k);
      if (!guide || !review) return;
      const patch = await this.patch(k);
      await sql.run(`INSERT INTO guide_backups (target_key,data) VALUES (?,?) ON CONFLICT(target_key) DO UPDATE SET data=excluded.data`,
        [k, JSON.stringify({ guide, patch, headSha: review.headSha ?? null, base: review.base ?? null, head: review.head ?? null, gitRef: review.gitRef ?? null })]);
    },
    async restoreGuide(k) {
      const row = await sql.get<{ data: string }>(`SELECT data FROM guide_backups WHERE target_key=?`, [k]);
      if (!row) return false;
      // A guide the worker already submitted stands; only an empty review gets the kept one back.
      if (await this.getGuide(k)) {
        await this.dropGuideBackup(k);
        return false;
      }
      const kept = JSON.parse(row.data);
      const replaced = await this.patch(k);
      await sql.transaction(async () => {
        await this.savePatch(k, kept.patch);
        await this.saveGuide(k, kept.guide);
        await sql.run(`UPDATE reviews SET head_sha=?, base=?, head=?, git_ref=? WHERE target_key=?`, [kept.headSha, kept.base, kept.head, kept.gitRef, k]);
        await sql.run(`DELETE FROM guide_backups WHERE target_key=?`, [k]);
        // Unsent comments moved to the replaced diff move back with it.
        await this.rebaseDraftComments(k, await reanchorDraft(this, k, replaced, kept.patch));
      });
      return true;
    },
    async guideBackupHead(k) {
      const row = await sql.get<{ data: string }>(`SELECT data FROM guide_backups WHERE target_key=?`, [k]);
      return row ? JSON.parse(row.data).headSha ?? null : null;
    },
    async dropGuideBackup(k) {
      await sql.run(`DELETE FROM guide_backups WHERE target_key=?`, [k]);
    },
    async getDraft(k) {
      const row = await sql.get<{ verdict: Verdict; body: string; comments: string; meta: string | null }>(`SELECT verdict, body, comments, meta FROM drafts WHERE target_key=?`, [k]);
      if (!row) return { targetKey: k, verdict: "COMMENT", body: "", comments: [] };
      return followDraftRenames({ targetKey: k, verdict: row.verdict, body: row.body, comments: JSON.parse(row.comments), ...(row.meta ? JSON.parse(row.meta) : {}) });
    },
    async upsertDraftComment(k, c) {
      const d = await this.getDraft(k);
      const i = d.comments.findIndex((x) => x.file === c.file && x.line === c.line && x.side === c.side);
      if (i >= 0) d.comments[i] = c; else d.comments.push(c);
      await writeDraft(sql, d);
      const positions = (await this.diffPositions(k)).get(c.file);
      const code = positions?.[c.side === "LEFT" ? "left" : "right"].get(c.line) ?? null;
      const startCode = c.startLine === undefined ? null : positions?.[(c.startSide ?? c.side) === "LEFT" ? "left" : "right"].get(c.startLine) ?? null;
      await sql.run(`INSERT INTO draft_comment_revisions (target_key,file,line,side,patch_hash,code,start_code) VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(target_key,file,line,side) DO UPDATE SET patch_hash=excluded.patch_hash, code=excluded.code, start_code=excluded.start_code`,
        [k, c.file, c.line, c.side, await this.patchHash(k), code, startCode]);
      return d;
    },
    async editDraftComment(k, at, body, severity, evidence, introduced) {
      const d = await this.getDraft(k);
      const comment = d.comments.find((c) => sameLocation(c, at));
      if (!comment) return null;
      comment.body = body;
      if (severity) comment.severity = severity;
      else if (severity === null) delete comment.severity;
      if (evidence) comment.evidence = evidence;
      else if (evidence === null) delete comment.evidence;
      if (introduced === false) comment.introduced = false;
      else if (introduced) delete comment.introduced;
      await writeDraft(sql, d);
      return d;
    },
    async deleteDraftComment(k, at) {
      const d = await this.getDraft(k);
      const index = d.comments.findIndex((c) => sameLocation(c, at));
      if (index < 0) return null;
      d.comments.splice(index, 1);
      await writeDraft(sql, d);
      return d;
    },
    async setVerdict(k, verdict, body) {
      // A summary saved unchanged keeps whoever wrote it.
      const changed = body !== undefined && body !== (await this.getDraft(k)).body;
      return this.updateSummary(k, { verdict, verdictChosen: true, ...(changed ? { body, bodyAuthor: undefined, written: undefined } : {}) });
    },
    async updateSummary(k, change) {
      const d = { ...await this.getDraft(k), ...change };
      await writeDraft(sql, d);
      return this.getDraft(k);
    },
    async staleDraftComments(k) {
      const hash = await this.patchHash(k);
      const stale: DraftComment[] = [];
      for (const c of (await this.getDraft(k)).comments) {
        const row = await sql.get<{ patch_hash: string }>(`SELECT patch_hash FROM draft_comment_revisions WHERE target_key=? AND file=? AND line=? AND side=?`, [k, c.file, c.line, c.side]);
        if (row?.patch_hash !== hash) stale.push(c);
      }
      return stale;
    },
    async clearSubmittedDraft(submitted) {
      const current = await this.getDraft(submitted.targetKey);
      // A rebuild during the POST may have moved a submitted comment: one unchanged but for its lines is the same comment.
      const placeless = (c: DraftComment) => JSON.stringify([c.file, c.side, c.startSide, c.body, c.severity, c.introduced, c.author]);
      for (const old of submitted.comments) {
        let index = current.comments.findIndex((c) => JSON.stringify(c) === JSON.stringify(old));
        if (index < 0) index = current.comments.findIndex((c) => placeless(c) === placeless(old));
        if (index >= 0) current.comments.splice(index, 1);
      }
      if (current.body === submitted.body && current.verdict === submitted.verdict) {
        current.body = "";
        current.verdict = "COMMENT";
        delete current.bodyAuthor; delete current.suggestedVerdict; delete current.written; delete current.verdictChosen; delete current.unchecked;
      }
      await writeDraft(sql, current);
    },
    async listDiscussions(k) {
      // Startup asks of every review: one with no discussion reads no patch.
      if (!await sql.get(`SELECT 1 FROM discussion_entries WHERE target_key=? UNION ALL SELECT 1 FROM discussion_waits WHERE target_key=? LIMIT 1`, [k, k])) return [];
      await followRenames(k);
      const waiting = await sql.all<CommentLocation>(`SELECT file, line, side FROM discussion_waits WHERE target_key=? ORDER BY file, line, side`, [k]);
      const discussions: Discussion[] = [];
      const entries = await sql.all<{ file: string; line: number; side: CommentLocation["side"]; author: DiscussionEntry["author"]; kind: DiscussionEntry["kind"]; body: string; start_line: number | null; created_at: number }>(
        `SELECT file, line, side, author, kind, body, start_line, created_at FROM discussion_entries WHERE target_key=? ORDER BY id`, [k]);
      for (const row of entries) {
        const location: CommentLocation = { file: row.file, line: row.line, side: row.side };
        let discussion = discussions.find((d) => sameLocation(d, location));
        if (!discussion) discussions.push(discussion = { ...location, entries: [], waiting: waiting.some((w) => sameLocation(w, location)) });
        discussion.entries.push({ author: row.author, kind: row.kind, body: row.body, createdAt: row.created_at });
        if (row.start_line != null && discussion.startLine === undefined) discussion.startLine = row.start_line;
      }
      return discussions;
    },
    async addDiscussionMessage(k, location, author, body, startLine) {
      await sql.transaction(async () => {
        await sql.run(`INSERT INTO discussion_entries (target_key,file,line,side,author,kind,body,start_line,created_at) VALUES (?,?,?,?,?,'message',?,?,?)`,
          [...at(k, location), author, body, startLine ?? null, Date.now()]);
        if (author === "reviewer") await sql.run(`INSERT INTO discussion_waits (target_key,file,line,side) VALUES (?,?,?,?) ON CONFLICT DO NOTHING`, at(k, location));
        else await stopWaitingAt(k, location);
      });
    },
    async noteDiscussionChange(k, location, kind, change) {
      if (!await hasDiscussion(k, location)) return;
      await sql.transaction(async () => {
        await sql.run(`INSERT INTO discussion_entries (target_key,file,line,side,author,kind,body,created_at,previous) VALUES (?,?,?,?,'agent',?,?,?,?)`,
          [...at(k, location), kind, change?.body ?? "", Date.now(), change ? JSON.stringify(change.previous) : null]);
        await stopWaitingAt(k, location);
      });
    },
    async lastDiscussionChange(k, location) {
      const row = await sql.get<{ kind: string; body: string; previous: string | null }>(
        `SELECT kind, body, previous FROM discussion_entries WHERE target_key=? AND file=? AND line=? AND side=? AND kind != 'message' ORDER BY id DESC LIMIT 1`, at(k, location));
      if (!row || row.kind === "restored" || row.previous === null) return null;
      return { kind: row.kind as "added" | "edited" | "removed", body: row.body, previous: JSON.parse(row.previous) };
    },
    async noteDiscussionRestored(k, location) {
      await sql.run(`INSERT INTO discussion_entries (target_key,file,line,side,author,kind,body,created_at) VALUES (?,?,?,?,'reviewer','restored','',?)`,
        [...at(k, location), Date.now()]);
    },
    async deleteDiscussion(k, location) {
      await sql.transaction(async () => {
        await sql.run(`DELETE FROM discussion_entries WHERE target_key=? AND file=? AND line=? AND side=?`, at(k, location));
        await stopWaitingAt(k, location);
      });
    },
    async clearDiscussions(k) {
      await sql.transaction(async () => {
        await sql.run(`DELETE FROM discussion_entries WHERE target_key=?`, [k]);
        await sql.run(`DELETE FROM discussion_waits WHERE target_key=?`, [k]);
      });
    },
    async stopWaiting(k) {
      return (await sql.run(`DELETE FROM discussion_waits WHERE target_key=?`, [k])).changes > 0;
    },
    async getFileViews(k) {
      await followRenames(k);
      return (await sql.all<{ file: string; hash: string; viewed_at: number }>(`SELECT file, hash, viewed_at FROM file_views WHERE target_key=? ORDER BY file`, [k]))
        .map((r) => ({ file: r.file, hash: r.hash, viewedAt: r.viewed_at }));
    },
    async setFileViewed(k, file, hash, viewedAt = Date.now()) {
      await sql.run(
        `INSERT INTO file_views (target_key,file,hash,viewed_at) VALUES (?,?,?,?)
         ON CONFLICT(target_key,file) DO UPDATE SET hash=excluded.hash, viewed_at=excluded.viewed_at`,
        [k, file, hash, viewedAt],
      );
    },
    async unsetFileViewed(k, file) {
      await sql.run(`DELETE FROM file_views WHERE target_key=? AND file=?`, [k, file]);
    },
    async getAgentThread(k) {
      return (await sql.get<{ thread_id: string }>(`SELECT thread_id FROM agent_threads WHERE target_key=?`, [k]))?.thread_id ?? null;
    },
    async clearAgentThread(k) {
      await sql.run(`DELETE FROM agent_threads WHERE target_key=?`, [k]);
    },
    async listAgentMessages(k) {
      return (await sql.all<{ id: number; role: AgentMessage["role"]; text: string; context: string | null; created_at: number }>(
        `SELECT id, role, text, context, created_at FROM agent_messages WHERE target_key=? ORDER BY id ASC`, [k]))
        .map((r) => ({
          id: r.id,
          role: r.role,
          text: r.text,
          context: r.context ? (JSON.parse(r.context) as AgentMessageContext) : null,
          createdAt: r.created_at,
        }));
    },
    async clearAgentMessages(k) {
      await sql.run(`DELETE FROM agent_messages WHERE target_key=?`, [k]);
    },
    async getAssistantThread(k) {
      return (await sql.get<{ thread_id: string }>(`SELECT thread_id FROM assistant_threads WHERE target_key=?`, [k]))?.thread_id ?? null;
    },
    async setAssistantThread(k, threadId) {
      await sql.run(
        `INSERT INTO assistant_threads (target_key,thread_id,created_at) VALUES (?,?,?)
         ON CONFLICT(target_key) DO UPDATE SET thread_id=excluded.thread_id, created_at=excluded.created_at`,
        [k, threadId, Date.now()],
      );
    },
    async clearAssistantThread(k) {
      await sql.run(`DELETE FROM assistant_threads WHERE target_key=?`, [k]);
    },
    async listAssistantThreads() {
      return (await sql.all<{ target_key: string; thread_id: string }>(`SELECT target_key, thread_id FROM assistant_threads ORDER BY target_key`))
        .map((r) => ({ targetKey: r.target_key, threadId: r.thread_id }));
    },
    async saveSnapshot(k, headSha, patch) {
      await sql.run(`INSERT INTO review_snapshots (target_key,head_sha,patch,created_at) VALUES (?,?,?,?) ON CONFLICT(target_key,head_sha) DO UPDATE SET patch=excluded.patch`,
        [k, headSha, patch, Date.now()]);
    },
    async getSnapshot(k, headSha) {
      return (await sql.get<{ patch: string }>(`SELECT patch FROM review_snapshots WHERE target_key=? AND head_sha=?`, [k, headSha]))?.patch ?? null;
    },
    async pruneSnapshots(k, keep) {
      const rows = await sql.all<{ head_sha: string }>(`SELECT head_sha FROM review_snapshots WHERE target_key=? ORDER BY head_sha`, [k]);
      for (const { head_sha } of rows) if (!keep.includes(head_sha)) await sql.run(`DELETE FROM review_snapshots WHERE target_key=? AND head_sha=?`, [k, head_sha]);
    },
    async saveFeedbackThreads(k, threads, prUpdatedAt) {
      const now = Date.now();
      const saved = async () => JSON.stringify(await sql.all(`SELECT thread_id, data, resolved_seen_at FROM feedback_threads WHERE target_key=? ORDER BY thread_id`, [k]));
      return sql.transaction(async () => {
        const first = !await sql.get(`SELECT 1 FROM feedback_fetches WHERE target_key=?`, [k]);
        const before = await saved();
        const previous = new Map((await sql.all<{ thread_id: string; resolved_seen_at: number | null }>(`SELECT thread_id, resolved_seen_at FROM feedback_threads WHERE target_key=? ORDER BY thread_id`, [k]))
          .map((row) => [row.thread_id, row.resolved_seen_at]));
        await sql.run(`DELETE FROM feedback_threads WHERE target_key=?`, [k]);
        // When a thread was resolved isn't in GitHub's data; the first time bb saw it resolved stands in.
        // On the first read it was resolved some time before, so its last activity stands in instead.
        const seen = (thread: FeedbackThread) => previous.has(thread.id) ? previous.get(thread.id) ?? now
          : first ? Math.max(thread.createdAt, ...thread.replies.map((r) => r.createdAt)) : now;
        for (const thread of threads) {
          await sql.run(`INSERT INTO feedback_threads (target_key,thread_id,data,resolved_seen_at) VALUES (?,?,?,?)`,
            [k, thread.id, JSON.stringify(thread), thread.isResolved ? seen(thread) : null]);
        }
        await sql.run(`INSERT INTO feedback_fetches (target_key,fetched_at,pr_updated_at) VALUES (?,?,?) ON CONFLICT(target_key) DO UPDATE SET fetched_at=excluded.fetched_at, pr_updated_at=excluded.pr_updated_at`,
          [k, now, prUpdatedAt]);
        return first || await saved() !== before;
      });
    },
    async listFeedbackThreads(k) {
      return (await sql.all<{ data: string; resolved_seen_at: number | null }>(`SELECT data, resolved_seen_at FROM feedback_threads WHERE target_key=? ORDER BY thread_id`, [k]))
        .map((row) => ({ ...(JSON.parse(row.data) as FeedbackThread), resolvedSeenAt: row.resolved_seen_at ?? null }))
        .sort((a, b) => a.createdAt - b.createdAt);
    },
    async clearFeedbackFetches() {
      await sql.run(`DELETE FROM feedback_fetches`);
    },
    async feedbackFetched(k) {
      const row = await sql.get<{ fetched_at: number; pr_updated_at: number | null }>(`SELECT fetched_at, pr_updated_at FROM feedback_fetches WHERE target_key=?`, [k]);
      return row ? { fetchedAt: row.fetched_at, prUpdatedAt: row.pr_updated_at ?? null } : null;
    },
    async saveAssessmentItems(k, headSha, items) {
      await sql.transaction(async () => {
        for (const item of items) {
          await sql.run(`INSERT INTO assessment_items (target_key,head_sha,item_id,data) VALUES (?,?,?,?) ON CONFLICT(target_key,head_sha,item_id) DO UPDATE SET data=excluded.data`,
            [k, headSha, item.id, JSON.stringify(item)]);
        }
      });
    },
    async saveAssessmentRun(k, run) {
      await sql.run(`INSERT INTO assessment_runs (target_key,head_sha,data,assessed_at) VALUES (?,?,?,?) ON CONFLICT(target_key,head_sha) DO UPDATE SET data=excluded.data, assessed_at=excluded.assessed_at`,
        [k, run.headSha, JSON.stringify(run), run.assessedAt]);
    },
    async getAssessment(k, headSha) {
      const items = (await sql.all<{ data: string }>(`SELECT data FROM assessment_items WHERE target_key=? AND head_sha=? ORDER BY item_id`, [k, headSha]))
        .map((row) => JSON.parse(row.data) as AssessmentItem);
      const run = await sql.get<{ data: string }>(`SELECT data FROM assessment_runs WHERE target_key=? AND head_sha=?`, [k, headSha]);
      return { items, run: run ? JSON.parse(run.data) as AssessmentRun : null };
    },
    async latestAssessmentRun(k) {
      const row = await sql.get<{ data: string }>(`SELECT data FROM assessment_runs WHERE target_key=? ORDER BY assessed_at DESC, head_sha LIMIT 1`, [k]);
      return row ? JSON.parse(row.data) as AssessmentRun : null;
    },
    async setReplyDraft(k, threadId, body, author) {
      await sql.run(`INSERT INTO reply_drafts (target_key,thread_id,body,author,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(target_key,thread_id) DO UPDATE SET body=excluded.body, author=excluded.author, updated_at=excluded.updated_at`,
        [k, threadId, body, author, Date.now()]);
    },
    async listReplyDrafts(k) {
      return new Map((await sql.all<{ thread_id: string; body: string; author: ReplyDraft["author"]; updated_at: number }>(
        `SELECT thread_id, body, author, updated_at FROM reply_drafts WHERE target_key=? ORDER BY thread_id`, [k]))
        .map((row) => [row.thread_id, { body: row.body, author: row.author, updatedAt: row.updated_at } as ReplyDraft]));
    },
    async deleteReplyDraft(k, threadId) {
      await sql.run(`DELETE FROM reply_drafts WHERE target_key=? AND thread_id=?`, [k, threadId]);
    },
    async ignoreDiscovery(k) {
      await sql.run(`INSERT INTO discovery_ignores (target_key,ignored_at) VALUES (?,?) ON CONFLICT(target_key) DO UPDATE SET ignored_at=excluded.ignored_at`, [k, Date.now()]);
    },
    async unignoreDiscovery(k) {
      await sql.run(`DELETE FROM discovery_ignores WHERE target_key=?`, [k]);
    },
    async isDiscoveryIgnored(k) {
      return !!await sql.get(`SELECT 1 FROM discovery_ignores WHERE target_key=?`, [k]);
    },
    async draftCommentCode(k, { file, line, side }, end = "line") {
      const row = await sql.get<{ code: string | null; start_code: string | null }>(`SELECT code, start_code FROM draft_comment_revisions WHERE target_key=? AND file=? AND line=? AND side=?`, [k, file, line, side]);
      return (end === "start" ? row?.start_code : row?.code) ?? undefined;
    },
    async rebaseDraftComments(k, placements) {
      const positions = await this.diffPositions(k);
      const hash = await this.patchHash(k);
      await sql.transaction(async () => {
        const d = await this.getDraft(k);
        const moves = new Map<DraftComment, number>();
        const starts = new Map<DraftComment, number>();
        for (const { at, line, startLine } of placements) {
          const comment = d.comments.find((c) => sameLocation(c, at));
          if (comment) moves.set(comment, line);
          if (comment && startLine !== undefined) starts.set(comment, startLine);
        }
        // Collisions count only among final places; a comment that would share one keeps its old place.
        for (let clash = true; clash;) {
          clash = false;
          const places = new Map<string, DraftComment[]>();
          for (const c of d.comments) {
            const place = JSON.stringify([c.file, moves.get(c) ?? c.line, c.side]);
            places.set(place, [...(places.get(place) ?? []), c]);
          }
          for (const group of places.values()) {
            if (group.length > 1) for (const c of group) if (moves.has(c) && moves.get(c) !== c.line) { moves.delete(c); clash = true; }
          }
        }
        for (const c of moves.keys()) await sql.run(`DELETE FROM draft_comment_revisions WHERE target_key=? AND file=? AND line=? AND side=?`, [k, c.file, c.line, c.side]);
        await this.moveAgentCommentChanges(k, [...moves].map(([c, line]) => ({ at: { file: c.file, line: c.line, side: c.side }, line })));
        // Each comment's discussion, wait and ask move with it. Rows are found before any move, so comments that swap lines
        // don't merge their discussions.
        const discussions: Array<{ c: DraftComment; line: number; ids: Array<{ id: number }>; waiting: boolean }> = [];
        for (const [c, line] of moves) {
          discussions.push({
            c, line,
            ids: await sql.all<{ id: number }>(`SELECT id FROM discussion_entries WHERE target_key=? AND file=? AND line=? AND side=? ORDER BY id`, at(k, c)),
            waiting: (await stopWaitingAt(k, c)).changes > 0,
          });
        }
        for (const { c, line, ids, waiting } of discussions) {
          // A range's first line follows the comment's, or shifts with its last.
          for (const { id } of ids) {
            await sql.run(`UPDATE discussion_entries SET line=?, start_line=CASE WHEN start_line IS NULL THEN NULL ELSE COALESCE(?, start_line + ?) END WHERE id=?`,
              [line, starts.get(c) ?? null, line - c.line, id]);
          }
          if (waiting) await sql.run(`INSERT INTO discussion_waits (target_key,file,line,side) VALUES (?,?,?,?) ON CONFLICT DO NOTHING`, [k, c.file, line, c.side]);
        }
        const asks = (await this.getReview(k))?.commentAsks;
        if (asks?.length) {
          await this.setLifecycle(k, { commentAsks: asks.map((entry) => {
            const moved = [...moves].find(([c]) => sameLocation(c, entry));
            return moved ? { ...entry, line: moved[1] } : entry;
          }) });
        }
        for (const [c, line] of moves) {
          c.line = line;
          if (starts.has(c)) c.startLine = starts.get(c);
          const code = positions.get(c.file)?.[c.side === "LEFT" ? "left" : "right"].get(line) ?? null;
          const startCode = c.startLine === undefined ? null : positions.get(c.file)?.[(c.startSide ?? c.side) === "LEFT" ? "left" : "right"].get(c.startLine) ?? null;
          await sql.run(`INSERT INTO draft_comment_revisions (target_key,file,line,side,patch_hash,code,start_code) VALUES (?,?,?,?,?,?,?)
            ON CONFLICT(target_key,file,line,side) DO UPDATE SET patch_hash=excluded.patch_hash, code=excluded.code, start_code=excluded.start_code`,
            [k, c.file, line, c.side, hash, code, startCode]);
        }
        await writeDraft(sql, d);
      });
    },
  };
}

/** How many reviews' parsed patches stay in memory. */
const PARSED_REVIEWS = 8;

// Every table keyed by target_key. A new per-review table belongs here too.
const REVIEW_TABLES = [
  "reviews", "patches", "guides", "drafts", "file_views", "agent_threads", "agent_messages",
  "generations", "draft_comment_revisions", "review_lifecycle", "reviewer_notes", "assistant_threads", "review_context",
  "discussion_entries", "discussion_waits", "review_snapshots", "feedback_threads", "feedback_fetches",
  "assessment_items", "assessment_runs", "reply_drafts", "guide_backups", "agent_comment_changes",
] as const;

type Placement = { at: CommentLocation; line: number; startLine?: number };

/**
 * Where each unsent comment's line is in `next`, for rebaseDraftComments, and its range's first line. Comments whose
 * lines are gone are left out, as are ranges that lost an end or would no longer be a range GitHub takes. It reads
 * the draft and each comment's code first.
 */
export async function reanchorDraft(store: Pick<Store, "getDraft" | "draftCommentCode">, k: string, previous: string, next: string): Promise<Placement[]> {
  const { comments } = await store.getDraft(k);
  const codes = new Map<DraftComment, { line?: string; start?: string }>();
  for (const comment of comments) {
    codes.set(comment, { line: await store.draftCommentCode(k, comment), start: comment.startLine === undefined ? undefined : await store.draftCommentCode(k, comment, "start") });
  }
  return placeComments(comments, (comment, end) => codes.get(comment)![end ?? "line"], previous, next);
}

function placeComments(comments: DraftComment[], codeOf: (comment: DraftComment, end?: "start") => string | undefined, previous: string, next: string): Placement[] {
  if (!comments.length) return [];
  // Each diff parsed once, not per comment.
  const [before, after] = [diffPositions(previous), diffPositions(next)];
  return comments.flatMap((comment) => {
    const placed = reanchorIn({ ...comment, code: codeOf(comment) }, before, after);
    if (placed.status === "lost") return [];
    const line = placed.status === "moved" ? placed.line : comment.line;
    if (comment.startLine === undefined) return [{ at: comment, line }];
    const start = reanchorIn({ file: comment.file, line: comment.startLine, side: comment.startSide ?? comment.side, code: codeOf(comment, "start") }, before, after);
    if (start.status === "lost") return [];
    const startLine = start.status === "moved" ? start.line : comment.startLine;
    return rangeProblem(next, { ...comment, line, startLine }) ? [] : [{ at: comment, line, startLine }];
  });
}

function patchHash(patch: string) { return createHash("sha256").update(patch).digest("hex"); }

async function writeDraft(sql: Sql, d: Draft) {
  const { bodyAuthor, suggestedVerdict, written, verdictChosen, unchecked } = d;
  // JSON leaves out the undefined ones, which a change clears.
  const meta = JSON.stringify({ bodyAuthor, suggestedVerdict, written, verdictChosen, unchecked });
  await sql.run(
    `INSERT INTO drafts (target_key,verdict,body,comments,meta) VALUES (?,?,?,?,?)
     ON CONFLICT(target_key) DO UPDATE SET verdict=excluded.verdict,body=excluded.body,comments=excluded.comments,meta=excluded.meta`,
    [d.targetKey, d.verdict, d.body, JSON.stringify(d.comments), meta === "{}" ? null : meta],
  );
}
