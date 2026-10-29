// The review assistant's check of whether your feedback was addressed: how it
// starts, and what its tools return. Nothing here writes to GitHub.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { FeatureReview, ReviewMeta } from "./store";
import { isSecretPath, symlinkTarget } from "../lib/folder-files";
import { changedLinkNow, pathAndFolders } from "./env-diff";
import { splitPatchByFile } from "./patch";
import { posix } from "node:path";
import { readFeatureFile } from "./file-contents";
import { existsSync } from "node:fs";
import { ghErrorMessage, gitDiffArgs, type runGh, type runGit } from "./gh";
import { ensureGitHeaders } from "./patch";
import { readFeatureDiff, type HiddenFile } from "./env-diff";
import { messageAssistant } from "./agent";
import type { TurnKind } from "./asking";
import { reReviewCheckPrompt } from "./preferences";
import { baselineOf, diffAt, feedbackView, headOf, isSummaryItem, summarize } from "./feedback-view";
import { describeInterdiff, interdiff } from "./interdiff";
import { sendBaselineOf, sendKey } from "../lib/send-baseline";
import { commentsOut, reported, type OutComment } from "../lib/fixes";
import { settleFixes } from "./fix-tally";
import type { AssessmentItem, AssessmentVerdict } from "../lib/feedback";
import type { Claim, CommentLocation, Verdict } from "./draft";
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
    `Use list_feedback for the reviewer's feedback, read_changes_since_review for what changed since their review, and record every item with assess_feedback (it applies to head ${short(head)}). Post nothing to GitHub for the check itself.`,
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

/** How long a main thread's last reply may be, as the check reads it. */
const REPLY_LIMIT = 6_000;

/**
 * What the assistant needs to know to check the fixes of the comments out with the thread that fixes them (src/reports.ts):
 * each against the diff its Send went at, with the main thread's last reply, someone else's words, to read for what it
 * didn't report.
 */
async function fixesContext(bb: BbPluginApi, review: ReviewMeta, out: readonly OutComment[]): Promise<string> {
  const send = review.sends?.at(-1);
  const reply = send ? await bb.sdk.threads.output({ threadId: send.threadId }).then(({ output }) => output?.trim() || null, () => null) : null;
  const unreported = out.filter((comment) => !reported(comment.claim)).length;
  return [
    `The reviewer sent ${out.length} comment${out.length === 1 ? "" : "s"} to the main thread, the thread that fixes the code; list_feedback lists them with what it reported${unreported ? `, ${unreported} not yet` : ""}. Check each against what changed since its Send, with read_changes_since_review and its send number, and judge the fix itself.`,
    "Record each with assess_feedback by its id (c12): addressed, partial, not_addressed, disputed (the thread declined it; say whether it's right), or unclear. For one the thread didn't report, add claimed, done or declined, when its last reply or the changes show which; otherwise leave claimed out. Send nothing to the main thread for the check itself.",
    ...reply ? [`The main thread's last reply, for what it didn't report:\n${untrusted("main thread's reply", reply.length > REPLY_LIMIT ? `${reply.slice(0, REPLY_LIMIT)}…` : reply)}`] : [],
  ].join("\n");
}

/**
 * Ask the review's assistant to check your feedback on a PR you reviewed: on your click (`kind` ask), or as the plugin
 * starts it on its own (automatic). With `fixes`, Check fixes instead: the comments you sent to fix, each against its
 * Send's diff, which no other check reads. False when it's turned off, there's nothing to check, or it can't start.
 */
export async function startVerification(bb: BbPluginApi, store: AsyncStore, targetKey: string, reason: string, kind: TurnKind, { fixes = false }: { fixes?: boolean } = {}): Promise<boolean> {
  const { prompt, review, out } = await store.exclusive(async (tx) => {
    const review = await tx.getReview(targetKey);
    return { prompt: reReviewCheckPrompt((await tx.getPreferences()).preferences), review, out: review ? commentsOut((await tx.getDraft(targetKey)).comments, review.threadSends) : [] };
  });
  if (!prompt || !review || (fixes ? !out.length : review.kind !== "pr" || !baselineOf(review).at)) return false;
  const context = fixes ? [`Why now: ${reason}.`, await fixesContext(bb, review, out)].join("\n") : verificationContext(review, reason);
  let sent: Awaited<ReturnType<typeof messageAssistant>>;
  try {
    sent = await messageAssistant(bb, store, targetKey, prompt, context, { kind });
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
    // A check of the fixes still to run keeps them in the check's reach.
    const running = await tx.getReview(targetKey);
    const withFixes = fixes || !!running?.verifyingSince && !!running.verifyingFixes;
    if (left !== "cancelled") await tx.setLifecycle(targetKey, { verifyingSince: Date.now(), verifyingHead: headOf(review), verifyingMessageId: queued, verifyingFixes: withFixes || null });
  });
  bb.realtime.publish(`conversation:${targetKey}`, {});
  return true;
}

/** Where a comment out is, as list_feedback says it: its line, or the GitHub thread it is. */
type Sent = OutComment & { at?: CommentLocation & { body: string }; thread?: string };

/** The comments out with the thread that fixes them, by id: draft comments with their place, and GitHub threads. */
async function sentComments(store: AsyncStore, review: ReviewMeta): Promise<Map<string, Sent>> {
  const { comments } = await store.getDraft(review.targetKey);
  const sent = new Map<string, Sent>();
  for (const comment of comments) if (comment.state === "sent" && comment.id && comment.sendN !== undefined) sent.set(comment.id, { id: comment.id, sendN: comment.sendN, claim: comment.claim, at: comment });
  for (const [thread, entry] of Object.entries(review.threadSends ?? {})) sent.set(entry.id, { ...entry, thread });
  return sent;
}

/** list_feedback's part for the comments sent to the main thread: each, where, its Send, and what the thread reported. */
function describeSent(sent: ReadonlyMap<string, Sent>): string {
  const lines: string[] = [];
  for (const comment of sent.values()) {
    const where = comment.at ? `${comment.at.file}:${comment.at.line}${comment.at.side === "LEFT" ? " (old line)" : ""}` : `the GitHub thread ${comment.thread}`;
    const claim = comment.claim;
    const said = !claim ? "not reported" : `${claim.inferred ? "not reported; an earlier check inferred" : "reported"} ${claim.outcome}${claim.note ? `: ${claim.note.replace(/\s+/g, " ")}` : ""}${claim.commit ? ` (commit ${short(claim.commit)})` : ""}`;
    lines.push("", `[${comment.id}] ${where} · Send ${comment.sendN} · ${said}`, ...(comment.at?.body.split("\n") ?? []).map((l) => `  > ${l}`));
  }
  return `${sent.size} comment${sent.size === 1 ? "" : "s"} the reviewer sent to the main thread to fix, with what it reported. Compare each with read_changes_since_review and its Send:\n${untrusted("comments sent and reports", lines.join("\n").trim())}`;
}

/** A check of your feedback only is running: the comments you sent to fix aren't its to read or record. */
const feedbackCheck = (review: ReviewMeta) => !!review.verifyingSince && !review.verifyingFixes;

/**
 * list_feedback: your threads, their replies and state, and your review summaries; and the comments you sent to fix,
 * but in a check of your feedback only.
 */
export async function describeFeedback(store: AsyncStore, review: ReviewMeta): Promise<string> {
  const sent = feedbackCheck(review) ? new Map<string, Sent>() : await sentComments(store, review);
  if (review.kind !== "pr") return sent.size ? describeSent(sent) : "The reviewer sent no comments to the main thread, so there's nothing to check.";
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
  if (sent.size) out.push("", describeSent(sent));
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

/** What reads the code now: GitHub for a PR, git for a checkout's review, BB for a folder's. */
export interface CodeReaders { bb: BbPluginApi; run: Run; git: typeof runGit }

/**
 * read_changes_since_review for a Send: the code now compared with the diff Send `n` went at, or the last Send's. Only
 * the Send's own snapshot counts: without it, it fails, never saying that nothing changed. The code now is a PR's diff
 * at its head, a folder's read again on its machine, or a checkout's run again; one that can't be read fails too. A
 * folder's Send also needs what it kept out of the diff, which a file shown on one side only would otherwise misread.
 */
export async function changesSinceSend(store: AsyncStore, readers: CodeReaders, review: ReviewMeta, n: number | undefined, file?: string): Promise<string> {
  const send = sendBaselineOf(review, n);
  if (!send) throw new Error(n === undefined ? "Nothing has been sent from this review yet, so there's nothing to compare." : `This review keeps no Send ${n}.`);
  const [before, sentFiles] = await store.exclusive(async (tx) => [await tx.getSnapshot(review.targetKey, send.key), await tx.getSnapshotFiles(review.targetKey, send.key)] as const);
  if (before === null) throw new Error(`The diff Send ${send.n} went at isn't kept anymore, so what changed since can't be told. Read the whole diff with read_review_patch.`);
  const folder = review.feature && review.kind === "ref";
  if (folder && !sentFiles) throw new Error(`Which files Send ${send.n} kept out of the diff isn't known anymore, so what changed since can't be told. Read the whole diff with read_review_patch.`);
  const now = await codeNow(store, readers, review);
  const hiddenThen = new Set(sentFiles?.hidden.map((hidden) => hidden.path) ?? []);
  const hiddenNow = new Set(now.hidden?.map((hidden) => hidden.path) ?? []);
  const shownNow = [...hiddenThen].filter((path) => !hiddenNow.has(path));
  const keptOutNow = [...hiddenNow].filter((path) => !hiddenThen.has(path));
  return [
    `Changes between the diff Send ${send.n} went at (${date(send.at)}) and the code now${now.at ? ` (${short(now.at)})` : ""}, file by file.`,
    folder && (shownNow.length || keptOutNow.length) ? [
      shownNow.length ? `Kept out of the diff at Send ${send.n}, shown now, so read as added: ${shownNow.join(", ")}.` : "",
      keptOutNow.length ? `Kept out of the diff now, shown at Send ${send.n}, so read as removed: ${keptOutNow.join(", ")}.` : "",
    ].filter(Boolean).join(" ") : "",
    describeInterdiff(interdiff(before, now.patch), { file, since: `Send ${send.n}` }),
  ].filter(Boolean).join("\n\n");
}

/**
 * The review's diff as the code is now: a PR's at the head being checked, a folder's read again on its machine, with
 * the files it keeps out, or a checkout's run again.
 */
async function codeNow(store: AsyncStore, { bb, run, git }: CodeReaders, review: ReviewMeta): Promise<{ patch: string; at?: string; hidden?: HiddenFile[] }> {
  if (review.feature && review.kind === "ref") {
    const read = await readFeatureDiff(bb, review.feature, review.includeHidden ?? []);
    if (read.outcome !== "available") throw new Error(`Couldn't read the folder now, so what changed since the Send can't be told: ${read.message}`);
    return { patch: read.patch, hidden: read.hidden };
  }
  if (review.kind === "pr") {
    const head = checkedHead(review);
    if (head && head !== review.headSha) return { patch: await diffAt(store, run, review, head), at: head };
    return { patch: await store.patch(review.targetKey) };
  }
  // Without its checkout, the code now can't be told from the diff shown.
  if (!review.cwd || !review.gitRef || !existsSync(review.cwd)) throw new Error("Couldn't read this local review's code now, so what changed since the Send can't be told.");
  const diff = await git(gitDiffArgs(review.gitRef), { cwd: review.cwd });
  if (diff.code !== 0) throw new Error(`Couldn't read this local review's code now: ${diff.stderr.trim() || "git diff failed"}`);
  return { patch: ensureGitHeaders(diff.stdout) };
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

/** The most of a folder's file read_file reads, as the diff's whole files. */
const MAX_FOLDER_FILE_BYTES = 2 * 1024 * 1024;

/**
 * Why `path` isn't read: it goes through `link`, a changed link, itself or a folder above it. The agent reads where it
 * points instead, which the same checks then meet, as a link to a link or to a secret.
 */
function throughLink(path: string, link: { path: string; target: string }): string {
  if (!link.target) return `${link.path} is a link BB didn't say the target of, so it isn't read.`;
  const resolved = posix.normalize(posix.join(posix.dirname(link.path), link.target, path.slice(link.path.length)));
  if (link.target.startsWith("/") || resolved === ".." || resolved.startsWith("../")) return `${link.path} links to ${link.target}, outside the folder, so it isn't read.`;
  // Named from the folder's top, where the target as written is relative to the link.
  return `${link.path} links to ${link.target}; read ${resolved === link.target ? "that" : resolved} instead.`;
}

/**
 * A folder's review's file, on the folder's machine: as the folder has it now, read through BB inside the folder; or
 * where its diff starts. A secret-looking file the review doesn't show stays unread unless the reviewer included it
 * (src/env-diff.ts). It never reads through a changed link, the file's own or a folder's above it, as the review's
 * diff (`patch`) or the folder's diff now shows one: it names where the link points instead. Paths compare in any
 * case, as a Mac's folders do. BB reads through a link inside the folder and answers with the link's own path, so only
 * a diff tells a link apart: a link committed before the diff's base, and unchanged since, still reads as its target,
 * and so does a path through one into a changed link (an old `o → sub` with a new `sub/x → ../.env`: `o/x`). This is a
 * filter for the plugin's own tool; the agent's shell reads what it likes.
 */
async function folderFile(folder: { bb: BbPluginApi; patch?: string }, review: ReviewMeta & { feature: FeatureReview }, path: string, ref: FileRef): Promise<{ at: string; text: string } | string> {
  const { feature } = review;
  if (ref === "reviewed") return "A local review has no reviewed commit. Use ref \"current\" or \"base\".";
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const included = review.includeHidden ?? [];
  const files = splitPatchByFile(folder.patch ?? "");
  if (isSecretPath(path) && !files.some((file) => same(file.path, path)) && !included.some((at) => same(at, path))) return `${path} looks like a secret, so it isn't read for agents. The reviewer can include it from the review.`;
  if (ref === "base") {
    const read = await readFeatureFile(folder.bb, feature, "old", path);
    return "error" in read ? read.error : { at: short(feature.mergeBaseRef), text: read.text };
  }
  if (feature.folderGone) return `BB removed this review's folder, so ${path} can't be read as it is now. Use ref "base".`;
  // A link the review's diff shows: every block of each, as a file replaced by a link has two.
  for (const at of pathAndFolders(path)) {
    const blocks = files.filter((file) => same(file.path, at));
    const target = blocks.length ? symlinkTarget(blocks.map((file) => file.text).join("\n")) : null;
    if (target !== null) return throughLink(path, { path: blocks[0]!.path, target });
  }
  // A link made, or pointed elsewhere, since the review read the folder shows only in its diff now.
  const now = await changedLinkNow(folder.bb, feature, path);
  if ("error" in now) return `Couldn't check ${path} in the folder before reading it: ${now.error}`;
  if (now.link) return throughLink(path, now.link);
  const root = feature.path.replace(/\/+$/, "");
  try {
    const out = await folder.bb.sdk.files.read({ hostId: feature.hostId, rootPath: root, path: `${root}/${path}` });
    if (out.sizeBytes > MAX_FOLDER_FILE_BYTES) return `${path} is too large to read here.`;
    if (out.contentEncoding !== "utf8") return `${path} isn't text.`;
    return { at: "the working tree", text: out.content };
  } catch (error) {
    return `Couldn't read ${path} from ${feature.machine}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

type FileRef = "base" | "current" | "reviewed";
const MAX_FILE_LINES = 400;

/**
 * read_file: a file at the diff's base, your reviewed commit, or the PR's head (a local review's new side), with line
 * numbers. A folder's review reads its folder through `folder` (folderFile).
 */
export async function readFileAt(run: Run, git: typeof runGit, review: ReviewMeta, path: string, ref: FileRef, startLine = 1, endLine?: number, folder?: { bb: BbPluginApi; patch?: string }): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  // A repo-relative path only: no "." or ".." segments that could reach another GitHub endpoint, and no backslashes, which
  // a Windows folder takes as separators.
  const segments = path.split("/");
  if (path.startsWith("/") || path.includes("\\") || segments.some((segment) => !segment || segment === "." || segment === "..")) return { ok: false, error: `${path} isn't a repo-relative file path.` };
  const from = Math.max(1, startLine);
  if (endLine !== undefined && endLine < from) return { ok: false, error: `endLine ${endLine} is before startLine ${from}.` };
  const file = review.kind === "pr" ? await prFile(run, review, path, ref)
    : review.feature ? folder ? await folderFile(folder, review as ReviewMeta & { feature: FeatureReview }, path, ref) : "This review's folder can't be read from here."
    : await localFile(git, review, path, ref);
  if (typeof file === "string") return { ok: false, error: file };
  const lines = file.text.replace(/\n$/, "").split("\n");
  if (from > lines.length) return { ok: false, error: `startLine ${from} is past the end: ${path} at ${file.at} has ${lines.length} line${lines.length === 1 ? "" : "s"}.` };
  const to = Math.min(lines.length, from + MAX_FILE_LINES - 1, endLine ?? Infinity);
  const body = lines.slice(from - 1, to).map((line, i) => `${String(from + i).padStart(5)}  ${line}`).join("\n");
  return { ok: true, text: `${path} at ${file.at}, lines ${from}–${to} of ${lines.length}:\n${body}${to < lines.length ? `\n[Call again with startLine=${to + 1} for more.]` : ""}` };
}

export interface AssessInput {
  /** `claimed`: for a comment sent to the main thread that it didn't report, what the check found it did. */
  items: Array<{ id: string; verdict: AssessmentVerdict; evidence: string; title?: string; file?: string; line?: number; claimed?: Claim["outcome"] }>;
  summary?: string;
  suggestedVerdict?: Verdict;
  suggestedBody?: string;
}

/**
 * assess_feedback: record the assistant's verdicts: on your feedback, for the PR's head; on a comment you sent, for the
 * Send that carried it. A sent comment the thread didn't report gets what the check found it did, `claimed`, marked as
 * inferred, never over the thread's own report. `checker` is the review agent's thread.
 */
export async function assess(store: AsyncStore, caller: ReviewMeta, input: AssessInput, checker: string | null = null): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  return store.exclusive(async (tx) => {
    // As it is now, in this turn: a report may have come since the caller read it.
    const review = (await tx.getReview(caller.targetKey)) ?? caller;
    const sent = feedbackCheck(review) ? new Map<string, Sent>() : await sentComments(tx, review);
    const fixes = input.items.filter((item) => sent.has(item.id));
    const feedback = input.items.filter((item) => !sent.has(item.id));
    const ids = sent.size ? ", or a sent comment's id (c12)" : "";
    if (feedback.length && review.kind !== "pr") return { ok: false, error: `Unknown item ids: ${feedback.map((item) => item.id).join(", ")}. Use the sent comments' ids from list_feedback (c12). Nothing was recorded.` };
    // During a check, verdicts belong to the commit it started on; the author may have pushed since.
    const head = review.verifyingSince && review.verifyingHead ? review.verifyingHead : headOf(review);
    if (feedback.length && !head) return { ok: false, error: "This review has no commit to check against." };
    const threads = feedback.length ? await tx.listFeedbackThreads(review.targetKey) : [];
    const threadIds = threads.map((t) => t.id);
    const unknown = feedback.filter((item) => !threadIds.includes(item.id) && !isSummaryItem(item.id)).map((item) => item.id);
    if (unknown.length) return { ok: false, error: `Unknown item ids: ${unknown.join(", ")}. Use the thread ids from list_feedback, or "summary:<n>" for asks in a review summary${ids}. Nothing was recorded.` };
    const untitled: AssessInput["items"] = [];
    for (const item of feedback) if (isSummaryItem(item.id) && !item.title?.trim() && !(await tx.getAssessment(review.targetKey, head!)).items.some((i) => i.id === item.id && i.title)) untitled.push(item);
    if (untitled.length) return { ok: false, error: `Give each summary ask a title: ${untitled.map((i) => i.id).join(", ")}. Nothing was recorded.` };
    const now = Date.now();
    // Where the evidence is, only as a line the current diff shows on its new side, so it links to code the reviewer sees.
    const positions = await tx.diffPositions(review.targetKey);
    const shown = (file?: string, line?: number) => !!file && !!line && !!positions.get(file)?.right.has(line);
    const recorded = (item: AssessInput["items"][number]): AssessmentItem => ({
      id: item.id, verdict: item.verdict, evidence: item.evidence.trim().slice(0, 1000), assessedAt: now,
      ...(item.title?.trim() ? { title: item.title.trim().slice(0, 300) } : {}),
      ...(shown(item.file, item.line) ? { file: item.file, line: item.line } : {}),
    });
    const said: string[] = [];
    if (fixes.length) {
      // Each with its Send, whose diff it was checked against.
      const bySend = new Map<number, AssessmentItem[]>();
      for (const item of fixes) bySend.set(sent.get(item.id)!.sendN, [...bySend.get(sent.get(item.id)!.sendN) ?? [], recorded(item)]);
      for (const [n, items] of bySend) await tx.saveAssessmentItems(review.targetKey, sendKey(n), items);
      const inferred = fixes.filter((item) => item.claimed && !reported(sent.get(item.id)!.claim));
      for (const item of inferred) {
        const comment = sent.get(item.id)!;
        const claim: Claim = { outcome: item.claimed!, note: item.evidence.trim().slice(0, 1000), threadId: checker, at: now, inferred: true };
        if (comment.at) await tx.trackComments(review.targetKey, [{ at: comment.at, claim }]);
        else {
          // A report always stands over what a check found.
          const threadSends = (await tx.getReview(review.targetKey))?.threadSends ?? {};
          const thread = threadSends[comment.thread!];
          if (thread && !reported(thread.claim)) await tx.setLifecycle(review.targetKey, { threadSends: { ...threadSends, [comment.thread!]: { ...thread, claim } } });
        }
      }
      // Counted again: what the check found shows on the review, and in its alert.
      await settleFixes(tx, review.targetKey);
      const addressed = fixes.filter((item) => item.verdict === "addressed").length;
      said.push(`Recorded ${fixes.length} sent comment${fixes.length === 1 ? "" : "s"}: ${addressed} of ${fixes.length} addressed${inferred.length ? `; ${inferred.length} the main thread didn't report now read "Looks done" or "Looks declined"` : ""}. The reviewer sees them on the comments.`);
    }
    if (feedback.length) {
      const items = feedback.map(recorded);
      await tx.saveAssessmentItems(review.targetKey, head!, items);
      const previous = (await tx.getAssessment(review.targetKey, head!)).run;
      await tx.saveAssessmentRun(review.targetKey, {
        headSha: head!, assessedAt: now,
        summary: input.summary?.trim() ?? previous?.summary ?? "",
        suggestedVerdict: input.suggestedVerdict ?? previous?.suggestedVerdict ?? null,
        suggestedBody: input.suggestedBody?.trim() ?? previous?.suggestedBody ?? "",
      });
      // Non-blocking threads are checked too, but don't count toward what's addressed.
      const summary = summarize(head!, (await tx.getAssessment(review.targetKey, head!)).items, threads.filter((t) => !threadLabel(t.body)?.nonBlocking).map((t) => t.id));
      await tx.setLifecycle(review.targetKey, { assessment: summary });
      const missing = summary.total - summary.addressed - summary.partial - summary.notAddressed - summary.disputed - summary.unclear;
      said.unshift(`Recorded ${items.length} item${items.length === 1 ? "" : "s"} for ${short(head)}: ${summary.addressed} of ${summary.total} addressed.${missing ? ` ${missing} item${missing === 1 ? " has" : "s have"} no verdict yet.` : ""} The reviewer sees them in Comments.`);
    }
    return { ok: true, text: said.join(" ") };
  });
}
