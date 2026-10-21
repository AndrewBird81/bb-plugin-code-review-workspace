// The review assistant's check of whether your feedback was addressed: how it
// starts, and what its tools return. Nothing here writes to GitHub.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { ReviewMeta } from "./store";
import { ghErrorMessage, type runGh, type runGit } from "./gh";
import { messageAssistant } from "./agent";
import { reReviewCheckPrompt } from "./preferences";
import { baselineOf, diffAt, feedbackView, headOf, isSummaryItem, summarize } from "./feedback-view";
import { describeInterdiff, interdiff } from "./interdiff";
import type { AssessmentItem, AssessmentVerdict } from "../lib/feedback";
import type { Verdict } from "./draft";
import { untrusted } from "./untrusted";
import { threadLabel } from "./github/threads";
import type { AsyncStore } from "./store-queue";

type Run = typeof runGh;
const short = (sha: string | null | undefined) => sha ? sha.slice(0, 7) : "unknown";
const date = (ms: number | null | undefined) => ms ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "an earlier time";

/** What the assistant needs to know before checking, sent only to it. */
export function verificationContext(review: ReviewMeta, reason: string): string {
  const baseline = baselineOf(review);
  const head = headOf(review);
  const s = review.signals ?? {};
  return [
    `Why now: ${reason}.`,
    `The reviewer's last review: ${baseline.verdict ?? "a review"} on commit ${short(baseline.sha)} (${date(baseline.at)}). The PR's head is now ${short(head)}${s.commitsSince ? `, ${s.commitsSince} commit${s.commitsSince === 1 ? "" : "s"} later` : ""}.`,
    review.headSha && head && review.headSha !== head
      ? `The guide and read_review_patch still show commit ${short(review.headSha)}. For the code now, use read_changes_since_review and read_file with ref "current". add_draft_comment only accepts lines in the diff at ${short(review.headSha)}; put new problems in your reply and in assess_feedback's suggestedBody, as file:line at ${short(head)}.`
      : "read_review_patch shows the PR as it is now.",
    `Use list_feedback for the reviewer's feedback, read_changes_since_review for what changed since their review, and record every item with assess_feedback (it applies to head ${short(head)}). Only the reviewer posts to GitHub.`,
  ].join("\n");
}

/**
 * Queued messages BB said it dispatched, or that were deleted from the queue, that were no check: one may be a check
 * whose send hasn't returned yet. The last hundred are enough for the moments a send takes.
 */
const leftQueue = new Map<string, "dispatched" | "cancelled">();
export function noteLeftQueue(messageId: string, how: "dispatched" | "cancelled") {
  leftQueue.set(messageId, how);
  if (leftQueue.size > 100) leftQueue.delete(leftQueue.keys().next().value!);
}

/** Ask the review's assistant to check your feedback. False when it's turned off or can't start. */
export async function startVerification(bb: BbPluginApi, store: AsyncStore, targetKey: string, reason: string): Promise<boolean> {
  const prompt = reReviewCheckPrompt((await store.getPreferences()).preferences);
  const review = await store.getReview(targetKey);
  if (!prompt || !review || review.kind !== "pr" || !baselineOf(review).at) return false;
  let sent: Awaited<ReturnType<typeof messageAssistant>>;
  try {
    sent = await messageAssistant(bb, store, targetKey, prompt, verificationContext(review, reason));
  } catch (error) {
    bb.log.warn(`The feedback check for ${targetKey} didn't start: ${String(error)}`);
    return false;
  }
  // The check is about this commit, even if the author pushes while it runs. Already dispatched, as BB can say before the
  // send returns, it's no longer waiting in the queue (70-review #3); already deleted from it, it never runs. Read in a
  // turn of the queue, after an event's that came first has noted it.
  await store.exclusive(async (tx) => {
    const left = sent.queuedMessageId ? leftQueue.get(sent.queuedMessageId) : undefined;
    const queued = sent.queuedMessageId && !left ? sent.queuedMessageId : null;
    if (left !== "cancelled") await tx.setLifecycle(targetKey, { verifyingSince: Date.now(), verifyingHead: headOf(review), verifyingMessageId: queued });
  });
  bb.realtime.publish(`conversation:${targetKey}`, {});
  return true;
}

/** list_feedback: your threads, their replies and state, and your review summaries. */
export async function describeFeedback(store: AsyncStore, review: ReviewMeta): Promise<string> {
  const view = await feedbackView(store, review);
  const threads = view.items.filter((item) => item.thread);
  const lines: string[] = [];
  for (const { thread, assessment } of threads) {
    if (!thread) continue;
    const where = thread.path ? `${thread.path}${thread.line ? `:${thread.line}` : thread.originalLine ? ` (was line ${thread.originalLine}; the code there changed)` : ""}${thread.side === "LEFT" ? " (LEFT side)" : ""}` : "the PR";
    const state = [thread.status === "resolved" ? `resolved${thread.resolvedBy ? ` by @${thread.resolvedBy}` : ""}` : thread.status === "question" ? "the author asked a question" : thread.status === "answered" ? "the author replied" : "no reply yet",
      thread.isOutdated ? "code changed since the comment" : ""].filter(Boolean).join(", ");
    lines.push("", `[${thread.id}] ${where} · ${state}`, ...thread.body.split("\n").map((l) => `  > ${l}`));
    for (const reply of thread.replies.slice(-5)) lines.push(`  @${reply.author}${reply.mine ? " (reviewer)" : ""}${reply.bot ? " (bot)" : ""}: ${reply.body.replace(/\s+/g, " ").slice(0, 1500)}`);
    if (assessment) lines.push(`  Earlier check: ${assessment.verdict} — ${assessment.evidence}`);
  }
  const out = [threads.length ? `${threads.length} review thread${threads.length === 1 ? "" : "s"} the reviewer started:\n${untrusted("review threads", lines.join("\n").trim())}` : "The reviewer started no review threads."];
  const bodies = review.reviewBodies ?? [];
  if (bodies.length) {
    const summaries = bodies.flatMap((body) => ["", `(${body.state}, ${date(body.at)})`, ...body.body.split("\n").map((l) => `  > ${l}`)]);
    out.push("", "The reviewer's review summaries, newest last. Record each distinct ask in them as an item with id \"summary:1\", \"summary:2\", … and a short title:", untrusted("review summaries", summaries.join("\n").trim()));
  }
  return out.join("\n");
}

/** The commit a running check is about, as assess_feedback records it; otherwise the PR's head. */
const checkedHead = (review: ReviewMeta) => review.verifyingSince && review.verifyingHead ? review.verifyingHead : headOf(review);

/** read_changes_since_review: the diff of diffs since your review, with the commits made since. */
export async function changesSinceReview(store: AsyncStore, run: Run, review: ReviewMeta, file?: string): Promise<string> {
  const baseline = baselineOf(review);
  const head = checkedHead(review);
  if (!baseline.sha || !head) return "The reviewer hasn't reviewed this PR yet, so there's nothing to compare.";
  if (baseline.sha === head) return `No commits since the reviewer's last review (${short(head)}).`;
  const [before, now] = await Promise.all([diffAt(store, run, review, baseline.sha), diffAt(store, run, review, head)]);
  const commits = await commitsSince(run, review, baseline.sha).catch(() => null);
  return [
    `Changes to the PR between the reviewer's last review (${short(baseline.sha)}) and now (${short(head)}), diffed PR to PR so rebases and base-branch merges don't show.`,
    commits ? `Commits since:\n${commits}` : "",
    describeInterdiff(interdiff(before, now), { file }),
  ].filter(Boolean).join("\n\n");
}

/** GitHub lists at most 250 of a PR's commits. */
const LISTED_COMMITS = 250;

async function commitsSince(run: Run, review: ReviewMeta, sha: string): Promise<string> {
  const out = await run(["api", "--paginate", `repos/${review.repo}/pulls/${review.number}/commits?per_page=100`, "--jq", ".[] | [.sha, (.commit.message | split(\"\\n\")[0])] | @tsv"]);
  if (out.code !== 0) throw new Error(out.stderr);
  const rows = out.stdout.trim().split("\n").filter(Boolean).map((row) => row.split("\t"));
  const index = rows.findIndex(([oid]) => oid === sha);
  // After a force-push the reviewed commit may be gone from the PR, or past the commits GitHub lists; show them all.
  const after = index >= 0 ? rows.slice(index + 1) : rows;
  const missing = rows.length >= LISTED_COMMITS
    ? `\n(The reviewed commit isn't among the first ${LISTED_COMMITS} commits, the most GitHub lists, so this list may be cut short; it may also have been rebased or force-pushed away.)`
    : "\n(The reviewed commit is no longer on the branch; it was rebased or force-pushed.)";
  return after.length ? untrusted("commit messages", after.map(([oid, message]) => `- ${short(oid)} ${message}`).join("\n")) + (index < 0 ? missing : "") : "None.";
}

/** A PR's file at a commit: its head now, your reviewed commit, or the commit its diff starts from. */
async function prFile(run: Run, review: ReviewMeta, path: string, ref: FileRef): Promise<{ at: string; text: string } | string> {
  let sha = ref === "reviewed" ? baselineOf(review).sha : checkedHead(review);
  if (ref === "base") {
    const head = review.headSha ?? headOf(review);
    if (!head || !review.base || !review.repo) return "There's no such commit for this review.";
    const out = await run(["api", `repos/${review.repo}/compare/${encodeURIComponent(review.base)}...${head}`, "--jq", ".merge_base_commit.sha"]);
    if (out.code !== 0 || !out.stdout.trim()) return `Couldn't find the PR's base commit: ${ghErrorMessage(out)}`;
    sha = out.stdout.trim();
  }
  if (!sha || !review.repo) return "There's no such commit for this review.";
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  const out = await run(["api", "-H", "Accept: application/vnd.github.raw", `repos/${review.repo}/contents/${encoded}?ref=${sha}`]);
  if (out.code !== 0) return `Couldn't read ${path} at ${short(sha)}: ${out.stderr.trim() || "not found"}`;
  return { at: short(sha), text: out.stdout };
}

/** A local review's file on either side of its diff: `a...b` starts from their merge base, `a..b` from a, and a single ref is compared with the working tree. */
async function localFile(git: typeof runGit, review: ReviewMeta, path: string, ref: FileRef): Promise<{ at: string; text: string } | string> {
  if (!review.cwd || !review.gitRef) return "There's no such commit for this review.";
  if (ref === "reviewed") return "A local review has no reviewed commit. Use ref \"current\" or \"base\".";
  // Each side goes to git first among its arguments, so none may read as an option.
  if (review.gitRef.split(/\.\.\.?/).some((side) => side.startsWith("-"))) return `${review.gitRef} isn't a git ref or range.`;
  const [, from, dots, to] = review.gitRef.match(/^(.*?)(\.\.\.?)(.*)$/) ?? [];
  let rev: string;
  if (ref === "current") {
    if (!dots) return `This review compares ${review.gitRef} with the working tree, so read ${path} from the working tree in ${review.cwd}.`;
    rev = to || "HEAD";
  } else if (!dots) rev = review.gitRef;
  else if (dots === "..") rev = from || "HEAD";
  else {
    const base = await git(["merge-base", from || "HEAD", to || "HEAD"], { cwd: review.cwd });
    if (base.code !== 0) return `Couldn't find where ${review.gitRef} starts: ${base.stderr.trim()}`;
    rev = base.stdout.trim();
  }
  const out = await git(["show", "--no-textconv", `${rev}:${path}`], { cwd: review.cwd });
  if (out.code !== 0) return `Couldn't read ${path} at ${rev}: ${out.stderr.trim() || "not found"}`;
  return { at: /^[0-9a-f]{40}$/.test(rev) ? short(rev) : rev, text: out.stdout };
}

type FileRef = "base" | "current" | "reviewed";
const MAX_FILE_LINES = 400;

/** read_file: a file at the diff's base, your reviewed commit, or the PR's head (a local review's new side), with line numbers. */
export async function readFileAt(run: Run, git: typeof runGit, review: ReviewMeta, path: string, ref: FileRef, startLine = 1, endLine?: number): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  // A repo-relative path only: no "." or ".." segments that could reach another GitHub endpoint.
  const segments = path.split("/");
  if (path.startsWith("/") || segments.some((segment) => !segment || segment === "." || segment === "..")) return { ok: false, error: `${path} isn't a repo-relative file path.` };
  const from = Math.max(1, startLine);
  if (endLine !== undefined && endLine < from) return { ok: false, error: `endLine ${endLine} is before startLine ${from}.` };
  const file = review.kind === "pr" ? await prFile(run, review, path, ref) : await localFile(git, review, path, ref);
  if (typeof file === "string") return { ok: false, error: file };
  const lines = file.text.replace(/\n$/, "").split("\n");
  if (from > lines.length) return { ok: false, error: `startLine ${from} is past the end: ${path} at ${file.at} has ${lines.length} line${lines.length === 1 ? "" : "s"}.` };
  const to = Math.min(lines.length, from + MAX_FILE_LINES - 1, endLine ?? Infinity);
  const body = lines.slice(from - 1, to).map((line, i) => `${String(from + i).padStart(5)}  ${line}`).join("\n");
  return { ok: true, text: `${path} at ${file.at}, lines ${from}–${to} of ${lines.length}:\n${body}${to < lines.length ? `\n[Call again with startLine=${to + 1} for more.]` : ""}` };
}

export interface AssessInput {
  items: Array<{ id: string; verdict: AssessmentVerdict; evidence: string; title?: string; file?: string; line?: number }>;
  summary?: string;
  suggestedVerdict?: Verdict;
  suggestedBody?: string;
}

/** assess_feedback: record the assistant's verdicts for the PR's head. */
export async function assess(store: AsyncStore, review: ReviewMeta, input: AssessInput): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  return store.exclusive(async (tx) => {
    // During a check, verdicts belong to the commit it started on; the author may have pushed since.
    const head = review.verifyingSince && review.verifyingHead ? review.verifyingHead : headOf(review);
    if (!head) return { ok: false, error: "This review has no commit to check against." };
    const threads = await tx.listFeedbackThreads(review.targetKey);
    const threadIds = threads.map((t) => t.id);
    const unknown = input.items.filter((item) => !threadIds.includes(item.id) && !isSummaryItem(item.id)).map((item) => item.id);
    if (unknown.length) return { ok: false, error: `Unknown item ids: ${unknown.join(", ")}. Use the thread ids from list_feedback, or "summary:<n>" for asks in a review summary. Nothing was recorded.` };
    const untitled: AssessInput["items"] = [];
    for (const item of input.items) if (isSummaryItem(item.id) && !item.title?.trim() && !(await tx.getAssessment(review.targetKey, head)).items.some((i) => i.id === item.id && i.title)) untitled.push(item);
    if (untitled.length) return { ok: false, error: `Give each summary ask a title: ${untitled.map((i) => i.id).join(", ")}. Nothing was recorded.` };
    const now = Date.now();
    // Where the evidence is, only as a line the current diff shows on its new side, so it links to code the reviewer sees.
    const positions = await tx.diffPositions(review.targetKey);
    const shown = (file?: string, line?: number) => !!file && !!line && !!positions.get(file)?.right.has(line);
    const items: AssessmentItem[] = input.items.map((item) => ({
      id: item.id, verdict: item.verdict, evidence: item.evidence.trim().slice(0, 1000), assessedAt: now,
      ...(item.title?.trim() ? { title: item.title.trim().slice(0, 300) } : {}),
      ...(shown(item.file, item.line) ? { file: item.file, line: item.line } : {}),
    }));
    await tx.saveAssessmentItems(review.targetKey, head, items);
    const previous = (await tx.getAssessment(review.targetKey, head)).run;
    await tx.saveAssessmentRun(review.targetKey, {
      headSha: head, assessedAt: now,
      summary: input.summary?.trim() ?? previous?.summary ?? "",
      suggestedVerdict: input.suggestedVerdict ?? previous?.suggestedVerdict ?? null,
      suggestedBody: input.suggestedBody?.trim() ?? previous?.suggestedBody ?? "",
    });
    // Non-blocking threads are checked too, but don't count toward what's addressed.
    const summary = summarize(head, (await tx.getAssessment(review.targetKey, head)).items, threads.filter((t) => !threadLabel(t.body)?.nonBlocking).map((t) => t.id));
    await tx.setLifecycle(review.targetKey, { assessment: summary });
    const missing = summary.total - summary.addressed - summary.partial - summary.notAddressed - summary.disputed - summary.unclear;
    return { ok: true, text: `Recorded ${items.length} item${items.length === 1 ? "" : "s"} for ${short(head)}: ${summary.addressed} of ${summary.total} addressed.${missing ? ` ${missing} item${missing === 1 ? " has" : "s have"} no verdict yet.` : ""} The reviewer sees them in Comments.` };
  });
}
