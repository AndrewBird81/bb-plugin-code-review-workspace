// Every comment-like thing in a review, built once: the draft's comments and its discussions with the agent,
// everyone's threads on GitHub, and your feedback (your threads' status, the agent's check, drafted replies, the
// asks from your review summary). A thread joins its feedback by node id, the same in both. Pure, so the list, the
// code, the title bar and Finish show and count the same things.
import type { ReviewLifecycle, SendEntry } from "../src/store";
import type { PrConversationItem } from "../src/github/types";
import type { Claim } from "../src/draft";
import { isPreExisting, isSummary, linesOf, sameLocation, SEVERITIES, severityCounts, type CommentLocation, type Discussion, type Draft, type DraftComment, type Severity, type Verdict } from "../src/draft";
import { threadLabel } from "../src/github/threads";
import { chapterAt } from "../src/hunks";
import { splitPatchByFile } from "../src/patch";
import type { ReviewThread } from "../src/threads";
import type { AssessmentVerdict, FeedbackItem, FeedbackView, ReplyDraft } from "./feedback";

type Side = "LEFT" | "RIGHT";
type Author = ReplyDraft["author"];

/** Where an item stands, as its header says. */
export type CommentState =
  // A draft comment: yours, the agent's, or one drafted against an older diff, whoever wrote it.
  | "draft" | "agent-draft" | "older-diff"
  // A discussion with the agent at a line without a comment.
  | "private"
  // Your thread on GitHub; someone else's is open or resolved. On your own PR, any thread whose latest comment isn't
  // yours or a bot's needs your reply.
  | "waiting" | "replied" | "question" | "resolved" | "open" | "needs-reply"
  // An ask from your earlier review summary.
  | "summary-ask";

export const STATE_LABEL: Record<CommentState, string> = {
  draft: "Draft · not submitted", "agent-draft": "Agent draft · not submitted", "older-diff": "Older diff · not submitted",
  private: "Private · with the agent",
  waiting: "Waiting on author", replied: "Author replied", question: "Question for you", resolved: "Resolved", open: "Open", "needs-reply": "Needs your reply",
  "summary-ask": "From your review summary",
};
/** Shown beside a thread's state. */
export const THREAD_FLAG_LABEL = { outdated: "Outdated", fileComment: "File comment" } as const;
/** The agent's check of your feedback, after its ✦. */
export const CHECK_LABEL: Record<AssessmentVerdict, string> = {
  addressed: "Addressed", partial: "Partial", not_addressed: "Not addressed", disputed: "Author disagrees", unclear: "Unclear",
};
export const REPLY_DRAFT_LABEL: Record<Author, string> = { reviewer: "Reply draft · not sent", agent: "Agent reply draft · not sent" };
export const SUMMARY_LABEL: Record<Author, string> = { reviewer: "Summary · not submitted", agent: "Agent summary · not submitted" };

/** Why an item needs you, most urgent first. */
export const NEEDS = ["older-diff", "question", "needs-reply", "check", "replied", "reply-drafted"] as const;
export type NeedReason = typeof NEEDS[number];
// What the agent's check says needs another look.
const UNADDRESSED = new Set<AssessmentVerdict>(["not_addressed", "partial", "disputed"]);

export type GroupId = "needs-you" | "not-submitted" | "on-github" | "private";
export const GROUP_TITLE: Record<GroupId, string> = {
  "needs-you": "Needs you", "not-submitted": "Not submitted · only in BB", "on-github": "On GitHub", private: "Private · with the agent",
};
/** The list's chips: everything, or one group. */
export type CommentFilter = "all" | "needs-you" | "not-submitted" | "on-github";
export const FILTER_LABEL: Record<CommentFilter, string> = { all: "All", "needs-you": "Needs you", "not-submitted": "Not submitted", "on-github": "On GitHub" };

/** Where an item is in the diff. */
export interface CommentPlace {
  file: string;
  /** Its line in this diff; null on a file comment or a thread whose code changed, which show in their file's fold. */
  line: number | null;
  side: Side;
  /** Its lines as a row names them, "16" or "10–16", or where an outdated thread was; null on a file comment. */
  lines: string | null;
}

/** A comment in a thread on GitHub. */
export interface ThreadMessage {
  /** The GitHub login; empty when it isn't known. */
  author: string;
  /** "You" or "@login". */
  who: string;
  mine: boolean;
  bot: boolean;
  body: string;
  createdAt: number | null;
}

/** The agent's check of one piece of your feedback. */
export interface CommentCheck {
  verdict: AssessmentVerdict;
  label: string;
  /** One line: what changed, or what's missing. */
  evidence: string;
  /** Where the fix is in this diff: Show the fix. */
  fix: { file: string; line: number } | null;
}

interface ItemBase {
  /** "draft:" or "private:" and its file, line and side; a thread's node id, which Resolve and its drafted reply use; or "summary:<n>". */
  id: string;
  /** Its header's words: STATE_LABEL of its state, and for one waiting for your reply, whose comment waits. */
  label: string;
  group: GroupId;
  needs: NeedReason | null;
  /** Null for the whole PR. */
  at: CommentPlace | null;
  /** The chapter that shows it; null for the whole PR, or a file no chapter shows, such as one gone from the PR. */
  chapterId: string | null;
  /** Who wrote it, or started its thread: "You", "Agent", or "@login". */
  who: string;
  /** Its latest message, for a row's second line. */
  latest: { who: string; body: string; at: number | null } | null;
  /** A nit, FYI, or optional point: after blocking ones in Needs you, and a "+1 nit" in tallies. */
  nonBlocking: boolean;
}

export interface DraftItem extends ItemBase {
  kind: "draft";
  state: "draft" | "agent-draft" | "older-diff";
  /** Where its fix stands, once sent, on your own change (draftStatus). */
  mark?: FixMark;
  comment: DraftComment;
  /** Your discussion with the agent about it, shown under it. */
  discussion: Discussion | null;
}

export interface PrivateItem extends ItemBase {
  kind: "private";
  state: "private";
  discussion: Discussion;
}

export interface ThreadItem extends ItemBase {
  kind: "thread";
  state: "waiting" | "replied" | "question" | "resolved" | "open" | "needs-reply";
  /** You started it. */
  mine: boolean;
  /** On your own PR, only bots wrote in it: On GitHub folds it, with the resolved and outdated. */
  bot: boolean;
  /** Waiting for your reply: whose comment waits, "@sam". */
  waitingOn: string | null;
  /** The first comment's database id, which a reply answers. */
  replyTo: number | null;
  /** The first comment, then its replies, oldest first. */
  messages: ThreadMessage[];
  resolvedBy: string | null;
  /** The code it's on changed since. */
  outdated: boolean;
  /** On the whole file, not a line. */
  fileComment: boolean;
  /** The label its first comment starts with: "Blocking", "Nit", "FYI"… */
  tag: string | null;
  check: CommentCheck | null;
  replyDraft: (ReplyDraft & { label: string }) | null;
  /** The thread on GitHub. */
  url: string | null;
  /** The thread as GitHub listed it, and your feedback on it; at least one is there, but for a review summary or comment. */
  thread: ReviewThread | null;
  feedback: FeedbackItem | null;
  /** On your own PR, a review summary or comment on the PR rather than a thread on a line, and a review's state; null for a thread. */
  topLevel: { kind: "review" | "comment"; state: string | null } | null;
  /** On your own PR, where its last Send took it, and what the thread reported (githubSendStatus); null if never sent. */
  sendStatus: { label: string; at?: number; mark: FixMark } | null;
}

export interface AskItem extends ItemBase {
  kind: "ask";
  state: "summary-ask";
  /** The ask, briefly. */
  title: string;
  check: CommentCheck | null;
  feedback: FeedbackItem;
}

export type CommentItem = DraftItem | PrivateItem | ThreadItem | AskItem;

/** What the items are built from: the panel's reads. */
export interface CommentSources {
  /** getDraft; null until it loads. */
  draft: { draft: Draft; stale: CommentLocation[]; discussions?: Discussion[] } | null;
  /** getReviewThreads: everyone's threads. */
  threads: readonly ReviewThread[];
  /** getFeedback: your threads, the agent's check of them, and the asks from your review summary. */
  feedback: FeedbackView | null;
  /** getReplyDrafts; without it, the drafted replies getFeedback has on your threads. */
  replyDrafts?: ReadonlyArray<ReplyDraft & { threadId: string }> | null;
  /** The chapters as the review shows them, and its diff, for reading order. */
  sections: Array<{ id: string; diffs: Array<{ file: string; hunks?: number[] }> }>;
  patch: string;
  /** Your GitHub login; without it, the author of your threads' first comments. */
  viewer?: string | null;
  /** The PR on GitHub, to link threads your feedback has no link for. */
  prUrl?: string | null;
  /** A closed or merged PR: nothing on it needs you. */
  closed?: boolean;
  /** Your own PR: everyone's threads are yours to answer, and `viewer` must be given, as `feedback` holds them all. */
  ownPr?: boolean;
  /** On your own PR, others' review summaries and comments on the PR, as the review last read them. */
  conversation?: readonly PrConversationItem[] | null;
  /** What a draft comment's status line says of the review; without it, as before 1.8.0. */
  status?: StatusFacts;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const keyOf = (location: CommentLocation) => `${location.file}:${location.line}:${location.side}`;
/** The id of the item for the draft comment at a place, and for the private discussion there. */
export const draftItemId = (at: CommentLocation) => `draft:${keyOf(at)}`;
export const privateItemId = (at: CommentLocation) => `private:${keyOf(at)}`;
const speaker = (author: Author) => author === "agent" ? "Agent" : "You";
const STATE_OF: Record<"open" | "answered" | "question", ThreadItem["state"]> = { open: "waiting", answered: "replied", question: "question" };

// A draft comment's one status line, the same on its card, its row and its pill. Where its comments post to GitHub (a
// PR), an open one is a draft not submitted. On your own change a Send carries it to the main thread (src/loop.ts), so
// it reads Open, Queued for or Sent to ‹thread› · Send n, Done or Declined as the thread reported, or Resolved; on a PR
// you don't own a sent comment still posts, so it stays not submitted too.

/** What a status line needs of its review: whether its comments post to GitHub, whether the change is yours, its Sends. */
export interface StatusFacts {
  /** A PR's review: open comments post with Submit. */
  posts: boolean;
  /** Your own change: a local review, a folder's review that became its PR, or your own PR. */
  own: boolean;
  sends?: readonly SendEntry[] | null;
  /** 1.7.0's record of the last Send, which names its thread and lists what went before 1.8.0. */
  sent?: ReviewLifecycle["sent"];
  /** On your own PR, the threads, review summaries and comments on GitHub sent, by GitHub's id. */
  threadSends?: ReviewLifecycle["threadSends"] | null;
}

/** As before 1.8.0: every comment posts, and none is yours to send. */
export const POSTS: StatusFacts = { posts: true, own: false };

/**
 * Where a sent comment's fix stands, as its icon shows it: sent (or queued), done or declined as the thread reported, or
 * as the review agent's check found it did without a report.
 */
export type FixMark = "sent" | "done" | "declined" | "looks-done" | "looks-declined";

/**
 * A thread's report on a comment it was sent, as a status line says it: done or declined with its note, the thread's
 * words without their closing full stop; one the review agent's check inferred, as the thread didn't report it, says so.
 */
function reportStatus(claim: Claim): { label: string; at: number; mark: FixMark } {
  const done = claim.outcome === "done";
  if (claim.inferred) return { label: `${done ? "Looks done" : "Looks declined"} · not reported`, at: claim.at, mark: done ? "looks-done" : "looks-declined" };
  const note = claim.note?.trim().replace(/(?<!\.)\.$/, "");
  return { label: `${done ? "Done" : "Declined"}${note ? ` · ${note}` : ""}`, at: claim.at, mark: done ? "done" : "declined" };
}

/**
 * The status line, and when what it says happened, for a card to add how long ago; and on your own change, where a sent
 * comment's fix stands (`mark`). A report's note is the thread's words, without its closing full stop.
 */
export function draftStatus(comment: DraftComment, state: DraftItem["state"], facts: StatusFacts): { label: string; at?: number; mark?: FixMark } {
  const draft = facts.posts && (!facts.own || !comment.state || comment.state === "open");
  const base = draft ? STATE_LABEL[state] : state === "older-diff" ? "Older diff" : comment.author === "agent" ? "Agent · Open" : "Open";
  if (comment.state === "resolved") return { label: "Resolved" };
  if (comment.state === "dismissed") return { label: "Dismissed" };
  // The thread's report on what it was sent; an edit opens it again, for the next Send.
  if (comment.claim && comment.state === "sent") return reportStatus(comment.claim);
  const send = comment.state === "sent" && comment.sendN !== undefined ? facts.sends?.find((entry) => entry.n === comment.sendN) : undefined;
  if (send) {
    const to = (facts.sent?.threadId === send.threadId ? facts.sent.title : null) ?? "the main thread";
    const went = `${send.queued ? `Queued for ${to}` : `Sent to ${to}`} · Send ${send.n}`;
    return { label: draft ? `${base} · ${went}` : went, at: send.at, ...draft ? {} : { mark: "sent" as const } };
  }
  // Sent before 1.8.0, as it reads now: 1.7.0's record.
  const before = !comment.state ? facts.sent?.comments.find((entry) => sameLocation(entry, comment) && (entry.body === undefined || entry.body === comment.body)) : undefined;
  if (before && facts.sent) {
    const went = `Sent to ${facts.sent.title ?? "the thread that made the change"}`;
    return { label: facts.posts ? `${base} · ${went}` : went, at: before.at };
  }
  return { label: base };
}

/**
 * Where a thread, review summary or comment on GitHub went with a Send, and what the thread that took it reported: "Sent
 * to Fixes for web#12 · Send 2", "Done · Renamed it". Null when it was never sent.
 */
export function githubSendStatus(id: string, facts: StatusFacts): { label: string; at?: number; mark: FixMark } | null {
  const sent = facts.threadSends?.[id];
  if (!sent) return null;
  if (sent.claim) return reportStatus(sent.claim);
  const send = facts.sends?.find((entry) => entry.n === sent.sendN);
  if (!send) return null;
  const to = (facts.sent?.threadId === send.threadId ? facts.sent.title : null) ?? "the main thread";
  return { label: `${send.queued ? `Queued for ${to}` : `Sent to ${to}`} · Send ${send.n}`, at: send.at, mark: "sent" };
}

/** A review's state as its summary's header says it. */
const REVIEW_STATE: Record<string, string> = { CHANGES_REQUESTED: "Requested changes", COMMENTED: "Review", APPROVED: "Approved" };
/** What a review summary or a comment on the PR is, in a word or two: "Requested changes", "Comment on the PR". */
export const topLevelLabel = (topLevel: NonNullable<ThreadItem["topLevel"]>) => topLevel.kind === "comment" ? "Comment on the PR" : REVIEW_STATE[topLevel.state ?? ""] ?? "Review";

/** A draft comment's state: on an older diff whoever wrote it, else the agent's or yours. */
export function draftState(comment: DraftComment, stale: readonly CommentLocation[]): DraftItem["state"] {
  return stale.some((location) => sameLocation(location, comment)) ? "older-diff" : comment.author === "agent" ? "agent-draft" : "draft";
}

function checkOf(feedback: FeedbackItem | null): CommentCheck | null {
  const assessment = feedback?.assessment;
  if (!assessment) return null;
  const { verdict, evidence, file, line } = assessment;
  return { verdict, label: CHECK_LABEL[verdict], evidence, fix: file && line ? { file, line } : null };
}

/** Every comment-like item in a review, once each, in reading order: the whole PR's first, then by chapter, file and line. */
export function buildItems(sources: CommentSources): CommentItem[] {
  const { draft, threads, feedback, sections, patch, closed = false, ownPr = false } = sources;
  const status = sources.status ?? POSTS;
  const order = sections.flatMap((section) => section.diffs.map((diff) => `${section.id}\0${diff.file}`));
  // For a file in more than one chapter, chapterAt splits the patch it's given: split it once here, and give it just that file's diff.
  let texts: Map<string, string> | undefined;
  const chapterOf = (file: string, line: number | null, side: Side) => {
    const split = sections.filter((section) => section.diffs.some((diff) => diff.file === file)).length > 1;
    const text = split ? (texts ??= new Map(splitPatchByFile(patch).map((f) => [f.path, f.text]))).get(file) ?? "" : "";
    return chapterAt(sections, text, { file, line: line ?? 0, side })?.id ?? null;
  };
  const needing = (needs: NeedReason | null, home: GroupId) => closed || !needs ? { needs: null, group: home } : { needs, group: "needs-you" as const };
  const placed: Array<{ item: CommentItem; place: number; line: number }> = [];
  // At the same line number, the old line before the new one, as a split diff reads.
  const sideOf = (item: CommentItem) => item.at?.side === "LEFT" ? 0 : 1;
  const add = (item: CommentItem, line = item.at?.line ?? 0) => placed.push({
    item, line, place: !item.at ? -1 : item.chapterId === null ? order.length : order.indexOf(`${item.chapterId}\0${item.at.file}`),
  });

  const comments = draft?.draft.comments ?? [];
  const stale = draft?.stale ?? [];
  const discussions = draft?.discussions ?? [];
  for (const comment of comments) {
    const state = draftState(comment, stale);
    const who = speaker(comment.author ?? "reviewer");
    const { label, mark } = draftStatus(comment, state, sources.status ?? POSTS);
    add({
      kind: "draft", id: draftItemId(comment), state, label, ...mark ? { mark } : {}, ...needing(state === "older-diff" ? "older-diff" : null, "not-submitted"),
      at: { file: comment.file, line: comment.line, side: comment.side, lines: linesOf(comment) }, chapterId: chapterOf(comment.file, comment.line, comment.side),
      who, latest: { who, body: comment.body, at: null }, nonBlocking: comment.severity === "nit",
      comment, discussion: discussions.find((discussion) => sameLocation(discussion, comment)) ?? null,
    });
  }
  for (const discussion of discussions) {
    if (isSummary(discussion) || comments.some((comment) => sameLocation(comment, discussion))) continue;
    const { file, line, side, startLine } = discussion;
    const message = discussion.entries.filter((entry) => entry.kind === "message").at(-1);
    add({
      kind: "private", id: privateItemId(discussion), state: "private", label: STATE_LABEL.private, group: "private", needs: null,
      // The lines asked about; their start may be either end.
      at: { file, line, side, lines: startLine === undefined || startLine === line ? `${line}` : `${Math.min(startLine, line)}–${Math.max(startLine, line)}` },
      chapterId: chapterOf(file, line, side), who: speaker(discussion.entries[0]?.author ?? "reviewer"),
      latest: message ? { who: speaker(message.author), body: message.body, at: message.createdAt } : null, nonBlocking: false, discussion,
    });
  }

  const feedbackById = new Map((feedback?.items ?? []).map((item) => [item.id, item]));
  const viewer = sources.viewer || (ownPr ? null : threads.find((live) => feedbackById.has(live.id) && live.comments.length)?.comments[0].author) || null;
  const replyDrafts = sources.replyDrafts ? new Map(sources.replyDrafts.map(({ threadId, ...reply }) => [threadId, reply])) : null;
  const person = (login: string, mine: boolean) => mine ? "You" : `@${login}`;
  /** A thread as GitHub listed it, your feedback on it, or both. */
  function addThread(live: ReviewThread | null, item: FeedbackItem | null) {
    // Your thread as the server last read it.
    const stored = item?.thread ?? null;
    const id = live?.id ?? item!.id;
    const messages: ThreadMessage[] = live?.comments.length
      ? live.comments.map((comment) => {
        const mine = !!viewer && same(comment.author, viewer);
        return { author: comment.author, who: person(comment.author, mine), mine, bot: comment.bot ?? comment.author.toLowerCase().endsWith("[bot]"), body: comment.body, createdAt: comment.createdAt ?? null };
      })
      : stored ? [
        // On your own PR, someone else may have started it.
        stored.author
          ? { author: stored.author, who: person(stored.author, false), mine: false, bot: !!stored.authorBot, body: stored.body, createdAt: stored.createdAt }
          : { author: viewer ?? "", who: "You", mine: true, bot: false, body: stored.body, createdAt: stored.createdAt },
        ...stored.replies.map((reply) => ({ author: reply.author, who: person(reply.author, reply.mine), mine: reply.mine, bot: reply.bot, body: reply.body, createdAt: reply.createdAt })),
      ] : [];
    const mine = ownPr ? !!messages[0]?.mine : !!item || !!messages[0]?.mine;
    // GitHub's read says whether it's resolved now; your feedback says who answered since your last comment. On your
    // own PR, the thread's latest comment that isn't a bot's says whether it waits for your reply.
    const resolved = live ? live.isResolved : stored!.isResolved;
    const latestPerson = messages.filter((message) => !message.bot).at(-1);
    const state = resolved ? "resolved" : ownPr ? latestPerson && !latestPerson.mine ? "needs-reply" : "open"
      : !mine ? "open" : stored && stored.status !== "resolved" ? STATE_OF[stored.status] : "waiting";
    const outdated = live ? live.isOutdated : stored!.isOutdated;
    const fileComment = (live?.subjectType ?? stored?.subjectType) === "FILE";
    const path = live ? live.path : stored!.path;
    const line = outdated || fileComment ? null : live ? live.line : stored!.line;
    const startLine = live?.startLine ?? stored?.startLine ?? null;
    const side = live?.side ?? stored?.side ?? "RIGHT";
    // Where an outdated thread was.
    const shown = line ?? live?.originalLine ?? stored?.originalLine ?? null;
    const reply = replyDrafts ? replyDrafts.get(id) ?? null : item?.replyDraft ?? null;
    const check = checkOf(item);
    // Resolved, it's settled, whatever an earlier check said.
    const needs = state === "resolved" ? null : state === "question" ? "question" : state === "needs-reply" ? "needs-reply" : check && UNADDRESSED.has(check.verdict) ? "check" : state === "replied" ? "replied" : reply?.author === "agent" ? "reply-drafted" : null;
    const tag = threadLabel(messages[0]?.body ?? "");
    const replyTo = live?.comments[0]?.databaseId ?? stored?.commentId ?? null;
    const last = messages.at(-1);
    add({
      // Waiting for your reply, it names whose comment waits: "Needs your reply to @sam".
      kind: "thread", id, state, label: state === "needs-reply" ? `${STATE_LABEL[state]} to ${latestPerson!.who}` : STATE_LABEL[state], ...needing(needs, "on-github"),
      waitingOn: state === "needs-reply" ? latestPerson!.who : null,
      at: path ? { file: path, line, side, lines: fileComment || shown === null ? null : line !== null && startLine !== null && startLine !== line ? `${startLine}–${line}` : `${shown}` } : null,
      chapterId: path ? chapterOf(path, line, side) : null,
      who: messages[0]?.who ?? person("unknown", mine), latest: last ? { who: last.who, body: last.body, at: last.createdAt } : null, nonBlocking: !!tag?.nonBlocking,
      mine, bot: ownPr && messages.length > 0 && messages.every((message) => message.bot), replyTo, messages, resolvedBy: live?.resolvedBy ?? stored?.resolvedBy ?? null, outdated, fileComment, tag: tag?.label ?? null, check,
      replyDraft: reply ? { ...reply, label: REPLY_DRAFT_LABEL[reply.author] } : null,
      url: stored?.url ?? (sources.prUrl && replyTo !== null ? `${sources.prUrl}#discussion_r${replyTo}` : null),
      thread: live, feedback: item, topLevel: null, sendStatus: ownPr ? githubSendStatus(id, status) : null,
    }, shown ?? 0);
  }
  // On your own PR, others' review summaries and comments on the PR: one waits for your reply as a thread does.
  for (const said of ownPr ? sources.conversation ?? [] : []) {
    const who = `@${said.author}`;
    const topLevel = { kind: said.kind, state: said.state ?? null };
    add({
      kind: "thread", id: said.id, state: said.waiting ? "needs-reply" : "open", label: said.waiting ? `${STATE_LABEL["needs-reply"]} to ${who}` : topLevelLabel(topLevel),
      ...needing(said.waiting ? "needs-reply" : null, "on-github"), waitingOn: said.waiting ? who : null,
      at: null, chapterId: null, who, latest: { who, body: said.body, at: said.at }, nonBlocking: false,
      mine: false, bot: said.bot, replyTo: null, messages: [{ author: said.author, who, mine: false, bot: said.bot, body: said.body, createdAt: said.at }],
      resolvedBy: null, outdated: false, fileComment: false, tag: null, check: null, replyDraft: null, url: said.url,
      thread: null, feedback: null, topLevel, sendStatus: githubSendStatus(said.id, status),
    });
  }
  for (const live of threads) addThread(live, feedbackById.get(live.id) ?? null);
  const listed = new Set(threads.map((live) => live.id));
  for (const item of feedback?.items ?? []) {
    // One GitHub didn't list, such as when it couldn't be read.
    if (item.kind === "thread" && item.thread && !listed.has(item.id)) addThread(null, item);
    if (item.kind !== "summary") continue;
    const check = checkOf(item);
    add({
      kind: "ask", id: item.id, state: "summary-ask", label: STATE_LABEL["summary-ask"], ...needing(check && UNADDRESSED.has(check.verdict) ? "check" : null, "on-github"),
      at: null, chapterId: null, who: "You", latest: { who: "You", body: item.title, at: null }, nonBlocking: false, title: item.title, check, feedback: item,
    });
  }
  // Files no chapter shows come last, by name.
  return placed
    .sort((a, b) => a.place - b.place || (a.item.at?.file ?? "").localeCompare(b.item.at?.file ?? "") || a.line - b.line || sideOf(a.item) - sideOf(b.item))
    .map(({ item }) => item);
}

/** What needs you, most urgent first, then blocking before non-blocking, then in reading order. */
export function needsYou(items: readonly CommentItem[]): CommentItem[] {
  return items.filter((item) => item.needs).sort((a, b) => NEEDS.indexOf(a.needs!) - NEEDS.indexOf(b.needs!) || Number(a.nonBlocking) - Number(b.nonBlocking));
}

export interface CommentGroup {
  id: GroupId;
  title: string;
  /** What its chip shows, folded items too: its chip's count. Not submitted counts every draft comment, as Submit does. */
  count: number;
  /** The line under its title: "1 blocking · 1 should fix · 2 nits" for drafts, "Yours: 2 of 2 handled +1 nit" on GitHub. */
  summary: string | null;
  /** What All shows in it, each item once. */
  items: CommentItem[];
  /** Counted here but shown in Needs you under All: draft comments on an older diff. */
  elsewhere: number;
  /** On GitHub, its resolved and outdated threads, and on your own PR bots', folded under `label`: "2 resolved · 1 outdated · 3 from bots". */
  folded: { label: string; items: CommentItem[] } | null;
}

/**
 * The list's groups in order, each in its own order, empty ones too so every chip has a count. Under All each item
 * shows once: Needs you, then drafts, then GitHub (yours first), then private discussions. Not submitted's chip also
 * shows the drafts on an older diff, which All shows under Needs you, so its count is what Submit sends. Pass the
 * items the list shows. `preExisting` (Settings' Keep pre-existing problems apart) adds Not submitted's "1 pre-existing".
 * On your own PR (`ownPr`), On GitHub has no "Yours: …handled": no one answers your feedback there.
 */
export function groups(items: readonly CommentItem[], preExisting = false, ownPr = false): CommentGroup[] {
  const home = (id: GroupId) => items.filter((item) => item.group === id);
  const group = (id: GroupId, shown: CommentItem[], summary: string | null): CommentGroup => ({ id, title: GROUP_TITLE[id], count: shown.length, summary, items: shown, elsewhere: 0, folded: null });
  const drafts = home("not-submitted");
  const everyDraft = items.filter((item) => item.kind === "draft");
  const github = home("on-github");
  const yours = (item: CommentItem) => item.kind === "ask" || item.kind === "thread" && item.mine;
  const folds = (item: CommentItem) => item.kind === "thread" && (item.state === "resolved" || item.outdated || item.bot);
  const ordered = [...github.filter(yours), ...github.filter((item) => !yours(item))];
  const folded = ordered.filter(folds);
  const resolved = folded.filter((item) => item.state === "resolved").length;
  const outdated = folded.filter((item) => item.kind === "thread" && item.state !== "resolved" && item.outdated).length;
  const bots = folded.length - resolved - outdated;
  const draftComments = everyDraft.flatMap((item) => item.kind === "draft" ? [item.comment] : []);
  const apart = preExisting ? draftComments.filter(isPreExisting).length : 0;
  return [
    group("needs-you", needsYou(items), null),
    {
      ...group("not-submitted", drafts, [severityCounts(draftComments), apart ? `${apart} pre-existing` : ""].filter(Boolean).join(" · ") || null),
      count: everyDraft.length, elsewhere: everyDraft.length - drafts.length,
    },
    {
      ...group("on-github", ordered.filter((item) => !folds(item)), ownPr ? null : yoursTally(items)), count: github.length,
      folded: folded.length ? { label: [resolved ? `${resolved} resolved` : "", outdated ? `${outdated} outdated` : "", bots ? `${bots} from bots` : ""].filter(Boolean).join(" · "), items: folded } : null,
    },
    group("private", home("private"), null),
  ];
}

/** "Yours: 2 of 2 handled +1 nit": your blocking threads resolved or answered on GitHub, then your non-blocking ones. */
function yoursTally(items: readonly CommentItem[]): string | null {
  const threads = items.filter((item) => item.kind === "thread" && item.mine);
  if (!threads.length) return null;
  const blocking = threads.filter((item) => !item.nonBlocking);
  const nits = threads.length - blocking.length;
  const handled = blocking.filter((item) => item.state === "resolved" || item.state === "replied").length;
  return `Yours: ${[blocking.length ? `${handled} of ${blocking.length} handled` : "", nits ? `${blocking.length ? "+" : ""}${nits} nit${nits === 1 ? "" : "s"}` : ""].filter(Boolean).join(" ")}`;
}

/** The check strip's "2 of 3 addressed": your blocking feedback the agent's check says is addressed. Null before a check. */
export function checkTally(items: readonly CommentItem[]): string | null {
  const yours = items.filter((item): item is ThreadItem | AskItem => (item.kind === "ask" || item.kind === "thread" && item.mine) && !item.nonBlocking);
  if (!yours.some((item) => item.check)) return null;
  return `${yours.filter((item) => item.check?.verdict === "addressed").length} of ${yours.length} addressed`;
}

/** A file header's ▤ n: its draft comments, and its threads on GitHub that aren't resolved. Pass every item. */
export function fileCounts(items: readonly CommentItem[]): Map<string, { notSubmitted: number; onGitHub: number }> {
  const counts = new Map<string, { notSubmitted: number; onGitHub: number }>();
  for (const item of items) {
    if (!item.at || !(item.kind === "draft" || item.kind === "thread" && item.state !== "resolved")) continue;
    const count = counts.get(item.at.file) ?? { notSubmitted: 0, onGitHub: 0 };
    if (item.kind === "draft") count.notSubmitted++;
    else count.onGitHub++;
    counts.set(item.at.file, count);
  }
  return counts;
}

/** What Submit posts, from the draft whatever the list shows, and the drafted replies, which post on their own. */
export interface ToSend {
  verdict: Verdict;
  /** The draft's comments, with those on an older diff, which hold Submit until they're edited or removed. */
  comments: number;
  bySeverity: Record<Severity, number>;
  /** "1 blocking · 1 should fix · 2 nits". */
  severities: string;
  byAuthor: { you: number; agent: number };
  olderDiff: number;
  /** Drafted replies on the threads shown; Send reply posts each. */
  replyDrafts: number;
  /** Who wrote the summary that goes with the verdict; null without one. */
  summary: Author | null;
}

export function toSend({ draft, threads, feedback, replyDrafts }: CommentSources): ToSend {
  const comments = draft?.draft.comments ?? [];
  const stale = draft?.stale ?? [];
  const agent = comments.filter((comment) => comment.author === "agent").length;
  const known = new Set([...threads.map((thread) => thread.id), ...(feedback?.items ?? []).map((item) => item.id)]);
  const replies = replyDrafts ?? (feedback?.items ?? []).flatMap((item) => item.replyDraft ? [{ threadId: item.id }] : []);
  return {
    verdict: draft?.draft.verdict ?? "COMMENT",
    comments: comments.length,
    bySeverity: Object.fromEntries(SEVERITIES.map((severity) => [severity, comments.filter((comment) => comment.severity === severity).length])) as Record<Severity, number>,
    severities: severityCounts(comments),
    byAuthor: { you: comments.length - agent, agent },
    olderDiff: comments.filter((comment) => stale.some((location) => sameLocation(location, comment))).length,
    replyDrafts: replies.filter((reply) => known.has(reply.threadId)).length,
    summary: draft?.draft.body.trim() ? draft.draft.bodyAuthor === "agent" ? "agent" : "reviewer" : null,
  };
}

/**
 * What the list shows for one chip, or for All, in its order: All each item once by group; Not submitted every draft
 * comment in reading order; On GitHub's folded threads only while they show.
 */
export function shownItems(items: readonly CommentItem[], filter: CommentFilter = "all", showFolded = false): CommentItem[] {
  if (filter === "not-submitted") return items.filter((item) => item.kind === "draft");
  return groups(items)
    .filter(({ id }) => filter === "all" || id === filter)
    .flatMap((group) => [...group.items, ...(showFolded ? group.folded?.items ?? [] : [])]);
}
