// Every comment-like thing in a review, built once: the draft's comments and its discussions with the agent,
// everyone's threads on GitHub, and your feedback (your threads' status, the agent's check, drafted replies, the
// asks from your review summary). A thread joins its feedback by node id, the same in both. Pure, so the list, the
// code, the title bar and Finish show and count the same things.
import { isSummary, linesOf, sameLocation, SEVERITIES, severityCounts, type CommentLocation, type Discussion, type Draft, type DraftComment, type Severity, type Verdict } from "../src/draft";
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
  // Your thread on GitHub; someone else's is open or resolved.
  | "waiting" | "replied" | "question" | "resolved" | "open"
  // An ask from your earlier review summary.
  | "summary-ask";

export const STATE_LABEL: Record<CommentState, string> = {
  draft: "Draft · not submitted", "agent-draft": "Agent draft · not submitted", "older-diff": "Older diff · not submitted",
  private: "Private · with the agent",
  waiting: "Waiting on author", replied: "Author replied", question: "Question for you", resolved: "Resolved", open: "Open",
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
export const NEEDS = ["older-diff", "question", "check", "replied", "reply-drafted"] as const;
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
  /** Its header's words: STATE_LABEL of its state. */
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
  state: "waiting" | "replied" | "question" | "resolved" | "open";
  /** You started it. */
  mine: boolean;
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
  /** The thread as GitHub listed it, and your feedback on it; at least one is there. */
  thread: ReviewThread | null;
  feedback: FeedbackItem | null;
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
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const keyOf = (location: CommentLocation) => `${location.file}:${location.line}:${location.side}`;
const speaker = (author: Author) => author === "agent" ? "Agent" : "You";
const STATE_OF: Record<"open" | "answered" | "question", ThreadItem["state"]> = { open: "waiting", answered: "replied", question: "question" };

function checkOf(feedback: FeedbackItem | null): CommentCheck | null {
  const assessment = feedback?.assessment;
  if (!assessment) return null;
  const { verdict, evidence, file, line } = assessment;
  return { verdict, label: CHECK_LABEL[verdict], evidence, fix: file && line ? { file, line } : null };
}

/** Every comment-like item in a review, once each, in reading order: the whole PR's first, then by chapter, file and line. */
export function buildItems(sources: CommentSources): CommentItem[] {
  const { draft, threads, feedback, sections, patch, closed = false } = sources;
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
  const add = (item: CommentItem, line = item.at?.line ?? 0) => placed.push({
    item, line, place: !item.at ? -1 : item.chapterId === null ? order.length : order.indexOf(`${item.chapterId}\0${item.at.file}`),
  });

  const comments = draft?.draft.comments ?? [];
  const stale = draft?.stale ?? [];
  const discussions = draft?.discussions ?? [];
  for (const comment of comments) {
    const older = stale.some((location) => sameLocation(location, comment));
    const state = older ? "older-diff" : comment.author === "agent" ? "agent-draft" : "draft";
    const who = speaker(comment.author ?? "reviewer");
    add({
      kind: "draft", id: `draft:${keyOf(comment)}`, state, label: STATE_LABEL[state], ...needing(older ? "older-diff" : null, "not-submitted"),
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
      kind: "private", id: `private:${keyOf(discussion)}`, state: "private", label: STATE_LABEL.private, group: "private", needs: null,
      // The lines asked about; their start may be either end.
      at: { file, line, side, lines: startLine === undefined || startLine === line ? `${line}` : `${Math.min(startLine, line)}–${Math.max(startLine, line)}` },
      chapterId: chapterOf(file, line, side), who: speaker(discussion.entries[0]?.author ?? "reviewer"),
      latest: message ? { who: speaker(message.author), body: message.body, at: message.createdAt } : null, nonBlocking: false, discussion,
    });
  }

  const feedbackById = new Map((feedback?.items ?? []).map((item) => [item.id, item]));
  const viewer = sources.viewer || threads.find((live) => feedbackById.has(live.id) && live.comments.length)?.comments[0].author || null;
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
        { author: viewer ?? "", who: "You", mine: true, bot: false, body: stored.body, createdAt: stored.createdAt },
        ...stored.replies.map((reply) => ({ author: reply.author, who: person(reply.author, reply.mine), mine: reply.mine, bot: reply.bot, body: reply.body, createdAt: reply.createdAt })),
      ] : [];
    const mine = !!item || !!messages[0]?.mine;
    // GitHub's read says whether it's resolved now; your feedback says who answered since your last comment.
    const resolved = live ? live.isResolved : stored!.isResolved;
    const state = resolved ? "resolved" : !mine ? "open" : stored && stored.status !== "resolved" ? STATE_OF[stored.status] : "waiting";
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
    const needs = state === "question" ? "question" : check && UNADDRESSED.has(check.verdict) ? "check" : state === "replied" ? "replied" : reply?.author === "agent" ? "reply-drafted" : null;
    const tag = threadLabel(messages[0]?.body ?? "");
    const replyTo = live?.comments[0]?.databaseId ?? stored?.commentId ?? null;
    const last = messages.at(-1);
    add({
      kind: "thread", id, state, label: STATE_LABEL[state], ...needing(needs, "on-github"),
      at: path ? { file: path, line, side, lines: fileComment || shown === null ? null : line !== null && startLine !== null && startLine !== line ? `${startLine}–${line}` : `${shown}` } : null,
      chapterId: path ? chapterOf(path, line, side) : null,
      who: messages[0]?.who ?? person("unknown", mine), latest: last ? { who: last.who, body: last.body, at: last.createdAt } : null, nonBlocking: !!tag?.nonBlocking,
      mine, replyTo, messages, resolvedBy: live?.resolvedBy ?? stored?.resolvedBy ?? null, outdated, fileComment, tag: tag?.label ?? null, check,
      replyDraft: reply ? { ...reply, label: REPLY_DRAFT_LABEL[reply.author] } : null,
      url: stored?.url ?? (sources.prUrl && replyTo !== null ? `${sources.prUrl}#discussion_r${replyTo}` : null),
      thread: live, feedback: item,
    }, shown ?? 0);
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
    .sort((a, b) => a.place - b.place || (a.item.at?.file ?? "").localeCompare(b.item.at?.file ?? "") || a.line - b.line)
    .map(({ item }) => item);
}

/** What needs you, most urgent first, then blocking before non-blocking, then in reading order. */
export function needsYou(items: readonly CommentItem[]): CommentItem[] {
  return items.filter((item) => item.needs).sort((a, b) => NEEDS.indexOf(a.needs!) - NEEDS.indexOf(b.needs!) || Number(a.nonBlocking) - Number(b.nonBlocking));
}

export interface CommentGroup {
  id: GroupId;
  title: string;
  /** Every item in it, folded ones too: its chip's count. */
  count: number;
  /** The line under its title: "1 blocking · 1 should fix · 2 nits" for drafts, "Yours: 2 of 2 handled +1 nit" on GitHub. */
  summary: string | null;
  items: CommentItem[];
  /** On GitHub, its resolved and outdated threads, folded under `label`: "2 resolved · 1 outdated". */
  folded: { label: string; items: CommentItem[] } | null;
}

/**
 * The list's groups in order, each in its own order, empty ones too so every chip has a count. They don't overlap:
 * Needs you, then drafts, then GitHub (yours first), then private discussions. Pass the items the list shows.
 */
export function groups(items: readonly CommentItem[]): CommentGroup[] {
  const home = (id: GroupId) => items.filter((item) => item.group === id);
  const group = (id: GroupId, shown: CommentItem[], summary: string | null): CommentGroup => ({ id, title: GROUP_TITLE[id], count: shown.length, summary, items: shown, folded: null });
  const drafts = home("not-submitted");
  const github = home("on-github");
  const yours = (item: CommentItem) => item.kind === "ask" || item.kind === "thread" && item.mine;
  const folds = (item: CommentItem) => item.kind === "thread" && (item.state === "resolved" || item.outdated);
  const ordered = [...github.filter(yours), ...github.filter((item) => !yours(item))];
  const folded = ordered.filter(folds);
  const resolved = folded.filter((item) => item.state === "resolved").length;
  return [
    group("needs-you", needsYou(items), null),
    group("not-submitted", drafts, severityCounts(drafts.flatMap((item) => item.kind === "draft" ? [item.comment] : [])) || null),
    {
      ...group("on-github", ordered.filter((item) => !folds(item)), yoursTally(items)), count: github.length,
      folded: folded.length ? { label: [resolved ? `${resolved} resolved` : "", folded.length - resolved ? `${folded.length - resolved} outdated` : ""].filter(Boolean).join(" · "), items: folded } : null,
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

/** Where ] and [ go: a stop per item, in the list's order and filter. */
export interface CommentStop { id: string; at: CommentPlace | null; chapterId: string | null; group: GroupId }

/** The list's items in its order, for one chip or all; On GitHub's folded threads only while they show. */
export function commentStops(items: readonly CommentItem[], filter: CommentFilter = "all", showFolded = false): CommentStop[] {
  return groups(items)
    .filter(({ id }) => filter === "all" || id === filter)
    .flatMap((group) => [...group.items, ...(showFolded ? group.folded?.items ?? [] : [])])
    .map(({ id, at, chapterId, group }) => ({ id, at, chapterId, group }));
}
