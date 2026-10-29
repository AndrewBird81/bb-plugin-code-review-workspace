// The review agent's tools that act on GitHub when the reviewer asks: submit_review, post_reply, resolve_thread,
// github_pr and open_pr. What posts under the reviewer's name shows first, exactly, in the Post form
// (src/post-preview.ts), and one click posts it; their "yes" typed in the review does too. Who's asking (src/asking.ts)
// decides what a turn may do. Every write goes through the server's line of writes to GitHub (src/github-writes.ts) and
// onto the review's activity. Settings' Let the review agent act when you ask (reviewAgentActs) gives these tools, and
// each checks it.
import { createHash } from "node:crypto";
import type { PluginAgentToolResult } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { assistantReview } from "./draft-comments";
import { linesOf, postedBody, sameComments, VERDICT_LABEL, type DraftComment, type Verdict } from "./draft";
import { writeSummary } from "./draft-summary";
import { ghReplyThreadArgs, ghResolveThreadArgs, ghUnresolveThreadArgs, runGh } from "./gh";
import { readReviewThreads } from "./github-threads-rpc";
import { addAssignees, mergePr, pushback, readMergeSettings, readWriteFacts, refusalText, type WriteAction, type WriteFacts, type WriteRefusal } from "./github-writes";
import { becomeOpened, branchOnGithub, createPr, FORK, notPushed, openable, prBase, type FolderReview } from "./open-pr";
import { postDraftedReply } from "./post-receipts";
import { affirms, justPost, POST_PREVIEW_RENDERER, shownText, type JustVerb, type PostButton, type PostShown } from "./post-preview";
import { holdForApproval } from "./relays";
import type { Turn, TurnMessage } from "./asking";
import type { ActivityEntry, ReviewMeta } from "./store";
import type { SubmitResult, SubmitWarning } from "./submit-review";
import { failed, type ServeDeps } from "./server-modules";

/** In every write tool's instructions (MF3): the tools are the only way it posts. */
export const ONLY_WITH_THESE_TOOLS = "Post, approve, merge, close or push only with these tools, never with gh, gh api or git push in your shell.";
/** How long the Post form waits for the reviewer. */
const FORM_TIMEOUT_MS = 30 * 60_000;

type Comment = Pick<DraftComment, "file" | "line" | "side" | "startLine" | "startSide" | "severity" | "introduced" | "body">;
type Review = ReviewMeta & { repo: string; number: number };
/** What a write is on: a PR's review, or, to open its PR, a local review's branch. */
type Target = Review | FolderReview;
/** What github_pr changes without text: labels, reviewers, assignees, open or closed, ready or draft. */
const META = ["add-label", "remove-label", "add-reviewer", "remove-reviewer", "add-assignee", "remove-assignee", "reopen", "ready", "draft"] as const;
type MetaAction = typeof META[number];
/** What each change is called on its form, whose words are the yes to it. */
const META_LABEL: Record<MetaAction, string> = {
  "add-label": "Add label", "remove-label": "Remove label", "add-reviewer": "Request review", "remove-reviewer": "Remove review request",
  "add-assignee": "Assign", "remove-assignee": "Unassign", reopen: "Reopen", ready: "Mark ready", draft: "Mark as draft",
};
/** A write to GitHub, as its preview's token names it: the review it's on, at the head it was reviewed at. */
type Write =
  | { kind: "review"; verdict: Verdict; body: string; comments: Comment[]; was: { body: string; verdict: Verdict }; force: SubmitWarning[]; headSha: string | null }
  | { kind: "reply"; thread: string; commentId: number; at: string | null; body: string }
  | { kind: "comment"; body: string }
  | { kind: "edit"; title?: string; body?: string }
  | { kind: "merge"; method: "merge" | "squash" | "rebase"; auto: boolean; deleteBranch: boolean; headSha: string; subject?: string; body?: string }
  | { kind: "close" }
  | { kind: "meta"; action: MetaAction; names: string[] }
  | { kind: "resolve"; thread: string; resolved: boolean; at: string | null }
  | { kind: "open-pr"; head: string; base: string; title: string; body: string; headSha: string };
/**
 * The post an agent's Post form shows, kept until it's posted: one per review agent. `from`, for a relayed ask, is the
 * thread it was shown to instead, whose yes confirms it; unset when it was shown to the reviewer in the review.
 */
interface Preview { token: string; targetKey: string; account: string | null; at: number; write: Write; shown: PostShown; usedAt?: number; from?: string | null }
/** What a write did: the line for the agent, the review's activity, and where it is on GitHub. */
type Done = { ok: true; text: string; activity: string; url?: string } | { ok: false; text: string };

const confirm = z.enum(["yes", "just-post-it"]).optional().describe("\"yes\": the reviewer, or the thread it was sent to, answered yes to exactly what was shown; give the same input again. \"just-post-it\": the reviewer's own message, or the relayed one, says to post it without showing it first (\"just post it\"; for request changes, the message is only that command: \"just request changes\").");
/** What a relayed approve, merge or close says it did: it waits for the reviewer's click. */
const HELD = (what: string) => `Nothing was done: ${what} needs the reviewer's own click. It waits in their Needs review as Ready to approve, showing exactly what posts. Tell the thread that asked.`;
const UNATTENDED = "This turn wasn't started by the reviewer, so nothing went to GitHub.";
const OFF = "Settings has the review agent drafting only now, so nothing went to GitHub. Put it in the reviewer's draft instead.";
const TEAMMATES = "On someone else's PR, push back once before changing its labels, reviewers, assignees, title or description, resolving its threads, or closing it, and offer a comment instead; then do what the reviewer says.";
/** The token of exactly this write, on this review, as this account. */
const previewToken = (targetKey: string, account: string | null, write: Write) => createHash("sha256").update(JSON.stringify([targetKey, account, write])).digest("hex").slice(0, 16);
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
const sentence = (refusal: WriteRefusal) => refusalText(refusal);
/** The review on the form: its repo with its owner, as Submit's foot names it. */
const where = (review: Review) => `${review.repo}#${review.number}`;
const VERDICT_BUTTON: Record<Verdict, PostButton> = { APPROVE: "Approve", REQUEST_CHANGES: "Request changes", COMMENT: "Post" };
const DOING: Record<Verdict, string> = { APPROVE: "Approving", REQUEST_CHANGES: "Requesting changes", COMMENT: "Commenting" };

export function register(deps: ServeDeps, { submit }: {
  /** draft-rpc's Submit: it posts, then records what follows. */
  submit: (targetKey: string, revision: undefined, account: string | undefined, comments: Comment[], summary: { body: string; verdict: Verdict }, force?: readonly SubmitWarning[]) => Promise<SubmitResult>;
}) {
  const { bb, store, receipts, githubWrites, submitReview, sync, changed, refreshThreads, classify } = deps;
  const key = (threadId: string) => `post-preview:${threadId}`;
  /** The message that last confirmed a write, by bb's id for its request, and when it was sent: each message confirms one. */
  const confirmedKey = (threadId: string) => `post-confirmed:${threadId}`;
  /** Whether `message` may confirm a write: not the one that confirmed the last, nor older. */
  const fresh = async (threadId: string, message: TurnMessage) => {
    const last = await bb.storage.kv.get<{ id: string; at: number }>(confirmedKey(threadId));
    return !last || (message.id !== last.id && message.at >= last.at);
  };
  /** Each open Post form, by its token, to cancel when a yes in chat posts it, or a newer one replaces it. */
  const forms = new Map<string, AbortController>();

  /** The review the agent on `threadId` is for, if it's still one's. */
  const reviewFor = (threadId: string) => store.exclusive(async (tx) => {
    const targetKey = await assistantReview(tx, threadId);
    return targetKey ? await tx.getReview(targetKey) : null;
  });
  /** The PR review the agent on `threadId` is for, or why it has none to act on. */
  async function reviewOf(threadId: string): Promise<Review | string> {
    const review = await reviewFor(threadId);
    if (!review) return "This conversation is no longer a review's agent.";
    if (review.kind !== "pr" || !review.repo || !review.number) return review.feature?.repo ? "This is a local review, with no PR yet: nothing in it goes to GitHub until open_pr opens its PR." : "This is a local review: nothing in it goes to GitHub.";
    return { ...review, repo: review.repo, number: review.number };
  }
  const acting = async () => (await store.getPreferences()).preferences.knobs.reviewAgentActs;
  const login = async () => await sync.login().catch(() => null) || null;
  /** Whose PR it is, as GitHub said just now, else as the review knows it. Unknown is someone else's. */
  const ownPr = (review: Review, facts?: WriteFacts) => facts ? !!facts.author && facts.author.toLowerCase() === facts.viewer.toLowerCase() : review.ownPr === true;

  /** Add what the agent did to the review's activity. */
  async function noteActivity(targetKey: string, turn: Turn, text: string, url?: string) {
    const from = turn.message?.senderThreadId ?? null;
    const fromTitle = from ? await bb.sdk.threads.get({ threadId: from }).then((thread) => thread.title ?? undefined, () => undefined) : undefined;
    const entry: ActivityEntry = { at: Date.now(), text, asking: turn.asking, ...(from ? { from } : {}), ...(fromTitle ? { fromTitle } : {}), ...(url ? { url } : {}) };
    await store.exclusive(async (tx) => {
      const review = await tx.getReview(targetKey);
      if (review) await tx.setLifecycle(targetKey, { activity: [...review.activity ?? [], entry] });
    });
    changed(targetKey);
  }

  /**
   * Mark the preview with `token` used, once, in one turn: null when it's not there, or already used. `message`, the one
   * that confirmed it, confirms no other: "message" when it already did. A click (null) needs none.
   */
  async function consume(threadId: string, token: string, message: TurnMessage | null): Promise<Preview | null | "message"> {
    return store.exclusive(async () => {
      const preview = await bb.storage.kv.get<Preview>(key(threadId));
      if (!preview || preview.token !== token || preview.usedAt) return null;
      if (message) {
        if (!await fresh(threadId, message)) return "message";
        await bb.storage.kv.set(confirmedKey(threadId), { id: message.id, at: message.at });
      }
      await bb.storage.kv.set(key(threadId), { ...preview, usedAt: Date.now() });
      return preview;
    });
  }
  /** Take `message` as the confirmation of one write: false when it already confirmed one. */
  async function claim(threadId: string, message: TurnMessage): Promise<boolean> {
    return store.exclusive(async () => {
      if (!await fresh(threadId, message)) return false;
      await bb.storage.kv.set(confirmedKey(threadId), { id: message.id, at: message.at });
      return true;
    });
  }
  /** Post a consumed preview, and add it to the activity. */
  async function post(review: Target, preview: Preview, turn: Turn): Promise<Done> {
    const done = await write(review, preview.write, preview.account);
    if (done.ok) await noteActivity(review.targetKey, turn, done.activity, done.url);
    return done;
  }

  /** Do one write on GitHub as the server's account. */
  async function write(target: Target, w: Write, account: string | null): Promise<Done> {
    if (w.kind === "open-pr") return openedPr(target as FolderReview, w);
    const review = target as Review;
    const { repo, number, targetKey } = review;
    const pr = [String(number), "-R", repo];
    const via = async (args: string[], action: WriteAction, stdin?: string) => await githubWrites.post(runGh, args, { action, ...(stdin === undefined ? {} : { stdin }) });
    switch (w.kind) {
      case "review": {
        // The summary and verdict asked for go into the draft it posts from, if it still reads as it did when shown,
        // on the head it was shown on.
        const ready = await store.exclusive(async (tx) => {
          if (((await tx.getReview(targetKey))?.headSha ?? null) !== w.headSha) return false;
          const draft = await tx.getDraft(targetKey);
          if (!sameComments(draft.comments, w.comments)) return false;
          if (draft.body === w.body && draft.verdict === w.verdict) return true;
          if (draft.body !== w.was.body || draft.verdict !== w.was.verdict) return false;
          await tx.setVerdict(targetKey, w.verdict, w.body);
          return true;
        });
        if (!ready) return { ok: false, text: "The draft or the review changed since it was shown, so nothing was posted. Call submit_review again to show it as it is now." };
        bb.realtime.publish(`draft:${targetKey}`, {});
        const result = await submit(targetKey, undefined, account ?? undefined, w.comments, { body: w.body, verdict: w.verdict }, w.force);
        if (result.ok) return { ok: true, text: `Posted the review to GitHub${result.url ? `: ${result.url}` : "."}`, activity: `Submitted ${VERDICT_LABEL[w.verdict]}${w.comments.length ? ` with ${plural(w.comments.length, "comment")}` : ""}`, ...(result.url ? { url: result.url } : {}) };
        if (result.warning) return { ok: false, text: `Nothing was posted. ${result.warning} Tell the reviewer; if they want it posted anyway, call submit_review again with force: true.` };
        if (result.offers?.includes("comment")) return { ok: false, text: `Nothing was posted. ${result.error} Offer to post it as a Comment review instead.` };
        return { ok: false, text: `Nothing was posted. ${result.error ?? "GitHub didn't take the review."}` };
      }
      case "reply": {
        let url: string | undefined;
        const replied = await postDraftedReply(receipts, store, targetKey, w.thread, w.body, async () => {
          const r = await via(ghReplyThreadArgs(repo, number, w.commentId), "reply", JSON.stringify({ body: w.body }));
          if (!r.ok) return { ok: false, error: sentence(r) };
          try { url = JSON.parse(r.stdout)?.html_url; } catch { /* posted all the same */ }
          return { ok: true };
        });
        if (!replied.ok) return { ok: false, text: `Nothing was posted. ${replied.error}` };
        await refreshThreads(review).catch(() => {});
        bb.realtime.publish(`feedback:${targetKey}`, { ts: Date.now() });
        if (replied.alreadyPosted) return { ok: false, text: "GitHub already has this reply, posted in the last 15 minutes, so it wasn't posted again." };
        return { ok: true, text: `Posted the reply${url ? `: ${url}` : "."}`, activity: `Posted reply${w.at ? ` on ${w.at}` : ""}`, ...(url ? { url } : {}) };
      }
      case "comment": {
        const r = await via(["pr", "comment", ...pr, "--body-file", "-"], "comment", w.body);
        if (!r.ok) return { ok: false, text: `Nothing was posted. ${sentence(r)}` };
        const url = r.stdout.trim().split("\n").find((line) => line.startsWith("https://"));
        return { ok: true, text: `Posted the comment${url ? `: ${url}` : "."}`, activity: "Posted a PR comment", ...(url ? { url } : {}) };
      }
      case "edit": {
        if (w.title !== undefined) {
          const r = await via(["pr", "edit", ...pr, "--title", w.title], "edit");
          if (!r.ok) return { ok: false, text: `Nothing was changed. ${sentence(r)}` };
        }
        if (w.body !== undefined) {
          const r = await via(["pr", "edit", ...pr, "--body-file", "-"], "edit", w.body);
          if (!r.ok) return { ok: false, text: `${w.title !== undefined ? "The title changed, but not the description. " : "Nothing was changed. "}${sentence(r)}` };
        }
        const what = w.title !== undefined && w.body !== undefined ? "the title and description" : w.title !== undefined ? "the title" : "the description";
        return { ok: true, text: `Changed ${what}.`, activity: `Changed ${what}` };
      }
      case "merge": {
        const r = await mergePr(githubWrites, runGh, repo, number, { headSha: w.headSha, method: w.method, auto: w.auto, deleteBranch: w.deleteBranch, ...(w.subject === undefined ? {} : { subject: w.subject }), ...(w.body === undefined ? {} : { body: w.body }) });
        if (!r.ok) return { ok: false, text: `Not merged. ${sentence(r)}` };
        if (!r.merged) return { ok: true, text: r.note ?? "GitHub will merge it once its checks and reviews pass.", activity: `Turned on auto-merge (${w.method})` };
        return { ok: true, text: `Merged.${r.note ? ` ${r.note}` : ""}`, activity: `Merged (${w.method})` };
      }
      case "close": {
        const r = await via(["pr", "close", ...pr], "close");
        return r.ok ? { ok: true, text: "Closed the PR.", activity: "Closed the PR" } : { ok: false, text: `Not closed. ${sentence(r)}` };
      }
      case "resolve": {
        const r = await githubWrites.post(runGh, w.resolved ? ghResolveThreadArgs(w.thread) : ghUnresolveThreadArgs(w.thread), { action: w.resolved ? "resolve" : "unresolve" });
        if (!r.ok) return { ok: false, text: `Nothing changed. ${sentence(r)}` };
        await refreshThreads(review).catch(() => {});
        bb.realtime.publish(`feedback:${targetKey}`, { ts: Date.now() });
        const done = `${w.resolved ? "Resolved" : "Unresolved"} the thread${w.at ? ` on ${w.at}` : ""}`;
        return { ok: true, text: `${done}.`, activity: done };
      }
      case "meta": {
        const people = w.names.map((n) => n.includes("/") ? n : `@${n.replace(/^@/, "")}`).join(", ");
        const list = w.names.join(",");
        if (w.action === "add-assignee") {
          const r = await addAssignees(githubWrites, runGh, repo, number, w.names);
          if (!r.ok) return { ok: false, text: `Nothing changed. ${sentence(r)}` };
          const stuck = w.names.filter((n) => !r.ignored.includes(n));
          if (!stuck.length) return { ok: false, text: r.note ?? "GitHub assigned no one." };
          const assigned = `Assigned ${stuck.map((n) => `@${n.replace(/^@/, "")}`).join(", ")}`;
          return { ok: true, text: r.note ?? `${assigned}.`, activity: assigned };
        }
        const [args, activity] = ({
          "add-label": [[`--add-label=${list}`], `Added label ${list}`], "remove-label": [[`--remove-label=${list}`], `Removed label ${list}`],
          "add-reviewer": [[`--add-reviewer=${list}`], `Requested review from ${people}`], "remove-reviewer": [[`--remove-reviewer=${list}`], `Removed the review request from ${people}`],
          "remove-assignee": [[`--remove-assignee=${list}`], `Unassigned ${people}`],
          reopen: [null, "Reopened the PR"], ready: [null, "Marked ready for review"], draft: [null, "Marked as a draft"],
        } as Record<Exclude<MetaAction, "add-assignee">, [string[] | null, string]>)[w.action];
        const command = args ? ["pr", "edit", ...pr, ...args] : w.action === "reopen" ? ["pr", "reopen", ...pr] : ["pr", "ready", ...pr, ...w.action === "draft" ? ["--undo"] : []];
        const r = await via(command, metaAction(w.action));
        return r.ok ? { ok: true, text: `${activity}.`, activity } : { ok: false, text: `Nothing changed. ${sentence(r)}` };
      }
    }
  }

  /**
   * Open the PR the form showed, while GitHub's branch is at the commit it showed and has no PR yet, and make this
   * review its review.
   */
  async function openedPr(review: FolderReview, w: Extract<Write, { kind: "open-pr" }>): Promise<Done> {
    const { repo } = review.feature;
    const now = await branchOnGithub(runGh, repo, w.head);
    if ("error" in now) return { ok: false, text: `No PR was opened. ${now.error}` };
    if ("fork" in now) return { ok: false, text: `No PR was opened. ${FORK}` };
    if ("missing" in now) return { ok: false, text: `No PR was opened. ${notPushed(w.head)}` };
    if (now.pr) return { ok: false, text: `${w.head} has PR #${now.pr.number} on GitHub already, so none was opened. ${await becomeOpened(deps, review, now.pr)}` };
    if (now.sha !== w.headSha) return { ok: false, text: `${w.head} moved on GitHub since it was shown (${w.headSha.slice(0, 7)} then, ${now.sha.slice(0, 7)} now), so no PR was opened. Call open_pr again to show it as it is now.` };
    const made = await createPr(githubWrites, runGh, { repo, head: w.head, base: w.base, title: w.title, body: w.body });
    // One opened since the read: this review becomes it, as when the read finds it.
    if (!made.ok && made.kind === "pr-exists") {
      const since = await branchOnGithub(runGh, repo, w.head);
      if ("sha" in since && since.pr) return { ok: false, text: `${w.head} has PR #${since.pr.number} on GitHub already, so none was opened. ${await becomeOpened(deps, review, since.pr)}` };
    }
    if (!made.ok) return { ok: false, text: `No PR was opened. ${sentence(made)}` };
    return { ok: true, text: `Opened ${repo}#${made.number}: ${made.url}. ${await becomeOpened(deps, review, made)}`, activity: `Opened PR #${made.number}`, url: made.url };
  }

  /**
   * Post `w` as the reviewer asked: shown first in the Post form, unless they said yes in chat to exactly what it
   * showed, or their own message said to post it without showing it. Asked from another of their threads, it's shown
   * to that thread instead, with no form, and its yes, or the reviewer's, posts it. Each message confirms one write, and
   * one carrying text the plugin put in it, such as a quote from the PR, none. The form's click posts it; its result
   * reaches the agent when it comes.
   */
  async function previewed(threadId: string, signal: AbortSignal, review: Target, turn: Turn, w: Write, verb: JustVerb, shown: (account: string | null) => PostShown, answer: "yes" | "just-post-it" | undefined): Promise<PluginAgentToolResult> {
    const account = await login();
    const token = previewToken(review.targetKey, account, w);
    const preview: Preview = { token, targetKey: review.targetKey, account, at: Date.now(), write: w, shown: shown(account) };
    // Who asked: the reviewer in the review, or their other thread, relaying; a turn no one started has no one to ask.
    const message = turn.asking === "unattended" ? null : turn.message;
    const relayed = turn.asking === "relayed";
    const usedUp = "That message already confirmed another post. Nothing more was posted: show it to them first.";
    const quoting = "That message carries text the plugin put in it, such as a quote from the PR, so it confirms no post. Nothing was posted:";
    if (answer === "just-post-it") {
      if (message?.inserted) return failed(`${quoting} call again without confirm to show it to them.`);
      if (!message || !justPost(message.text, verb)) return failed(verb === "post"
        ? "Only the reviewer's own message, or one relayed from their thread, saying \"just post it\", skips the form. Nothing was posted: call again without confirm to show it to them."
        : `Only a message that is just the command, such as "just ${verb === "request-changes" ? "request changes" : `${verb} it`}", skips the form. Nothing was posted: call again without confirm to show it to them.`);
      // Taken without touching a form that's open for something else: a refused one leaves it be.
      if (!await claim(threadId, message)) return failed(usedUp);
      // The form open for exactly this is answered by it: used now and closed, so its click can't post it again.
      const open = await bb.storage.kv.get<Preview>(key(threadId));
      if (open?.token === token) {
        if (!await consume(threadId, token, null)) return failed("That was posted already, from the form. Nothing more was posted.");
        forms.get(token)?.abort("confirmed");
      }
      const done = await post(review, preview, turn);
      return done.ok ? done.text : failed(done.text);
    }
    const open = await bb.storage.kv.get<Preview>(key(threadId));
    if (answer === "yes" && open?.token === token) {
      if (open.usedAt) return failed("That was posted already, from the Post form. Nothing more was posted.");
      // A yes since it was shown: the reviewer's in the review, or the thread's it was sent to.
      const fromThem = !relayed || (open.from !== undefined && message?.senderThreadId === open.from);
      if (message?.inserted && message.at > open.at) return failed(`${quoting} ask them for a yes in a message of their own, or wait for their click.`);
      if (!message || message.at <= open.at || !fromThem || !affirms(message.text, open.shown.button, open.shown.action)) return failed(`No yes to it has come since it was shown, from the reviewer in this review or the thread it was sent to: only a short yes${open.shown.button === "Post" ? "" : ` or "${open.shown.button.toLowerCase()} it"`} counts. Nothing was posted: ask them, or wait for their click.`);
      const used = await consume(threadId, token, message);
      if (used === "message") return failed(usedUp);
      if (!used) return failed("That was posted already, from the Post form. Nothing more was posted.");
      forms.get(token)?.abort("confirmed");
      const done = await post(review, used, turn);
      return done.ok ? done.text : failed(done.text);
    }
    if (open?.token === token && !open.usedAt && forms.has(token)) return failed("The form for exactly this is already open. Wait for the reviewer's click, or their answer in chat.");
    const sender = message?.senderThreadId ?? null;
    await replace(threadId, relayed ? { ...preview, from: sender } : preview);
    const changedSince = answer === "yes" ? "It changed since it was shown, so it's shown again. " : "";
    // Relayed, it goes back to the thread that asked: a form in this hidden chat would wait for no one.
    if (relayed) return `${changedSince}Nothing was posted yet. ${sender ? `Send exactly this to the thread that asked, with \`bb thread tell ${sender}\`` : "Show exactly this in your reply"}, then end your turn. When it says yes, call again with the same input and confirm: "yes".\n\n${shownText(preview.shown)}`;
    const inChat = `Show the reviewer exactly this, then ask. When they say yes, call again with the same input and confirm: "yes".\n\n${shownText(preview.shown)}`;
    if (!bb.ui?.requestInput) return `${changedSince}${inChat}`;
    const form = new AbortController();
    forms.set(token, form);
    try {
      const result = await bb.ui.requestInput({
        threadId, rendererId: POST_PREVIEW_RENDERER, title: preview.shown.title.slice(0, 160), payload: { ...preview.shown },
        timeoutMs: FORM_TIMEOUT_MS,
        // The row says what you did, not what GitHub did: the agent's answer says that.
        presentation: { label: { pending: `Waiting for your ${preview.shown.button}`, completed: `You clicked ${preview.shown.button}` } },
      }, { signal: AbortSignal.any([signal, form.signal]) });
      if (result.outcome === "cancelled") {
        if (form.signal.reason === "confirmed") return failed("The reviewer answered in chat instead, so this form closed.");
        if (form.signal.reason === "replaced") return failed("A newer post replaced this one, so this wasn't posted.");
        return failed(result.reason === "timeout" ? "The form waited 30 minutes with no answer, so nothing was posted." : "The reviewer closed the form, so nothing was posted.");
      }
      // A click once Settings has the agent drafting only posts nothing.
      if (!await acting()) return OFF;
      const used = await consume(threadId, token, null);
      if (!used || used === "message") return failed("That was posted already. Nothing more was posted.");
      // As text either way, so it reaches the agent even once idle, and it tells the reviewer what GitHub did.
      return (await post(review, used, turn)).text;
    } catch (error) {
      // A host that can't show the form: the reviewer answers in chat.
      return `${changedSince}The form couldn't open (${error instanceof Error ? error.message : String(error)}). ${inChat}`;
    } finally {
      forms.delete(token);
    }
  }
  /** Keep `preview` as the agent's one waiting post, closing the form of the one it replaces. */
  async function replace(threadId: string, preview: Preview) {
    const before = await store.exclusive(async () => {
      const before = await bb.storage.kv.get<Preview>(key(threadId));
      await bb.storage.kv.set(key(threadId), preview);
      return before;
    });
    if (before && before.token !== preview.token) forms.get(before.token)?.abort("replaced");
  }

  /**
   * A change without text: done when asked, but shown first when another thread relayed it and the PR isn't the
   * reviewer's, where relays count as theirs only for their own PRs, or when the ask came into a turn no one asked for,
   * such as the automatic review's, which the PR's text may have steered before it came.
   */
  async function change(threadId: string, signal: AbortSignal, review: Review, turn: Turn, w: Extract<Write, { kind: "meta" | "resolve" }>, facts: WriteFacts, what: string, answer: "yes" | "just-post-it" | undefined): Promise<PluginAgentToolResult> {
    const relayedOnTheirs = turn.asking === "relayed" && !ownPr(review, facts);
    if (relayedOnTheirs || turn.joined) {
      return previewed(threadId, signal, review, turn, w, "post", (account) => ({
        title: `Change ${where(review)}${account ? ` as @${account}` : ""}`, action: w.kind === "resolve" ? (w.resolved ? "Resolve thread" : "Unresolve thread") : META_LABEL[w.action], button: "Apply",
        parts: [], notes: [relayedOnTheirs ? "Asked from another thread, on someone else's PR." : "Asked while the agent was on a turn you didn't start."], details: [what],
      }), answer);
    }
    const done = await write(review, w, await login());
    if (!done.ok) return failed(done.text);
    await noteActivity(review.targetKey, turn, done.activity, done.url);
    return done.text;
  }

  /** A write tool's start: the review it acts on, and who's asking; or why it does nothing. */
  async function start(threadId: string): Promise<{ review: Review; turn: Turn } | { refused: PluginAgentToolResult }> {
    if (!await acting()) return { refused: failed(OFF) };
    const review = await reviewOf(threadId);
    if (typeof review === "string") return { refused: failed(review) };
    return { review, turn: await classify(threadId) };
  }
  const by = (account: string | null) => account ? ` as @${account}` : "";

  bb.agents.registerTool({
    name: "submit_review",
    description: "Submit the reviewer's review of this PR to GitHub: their draft's comments, with the verdict, and the summary given or the draft's. The reviewer sees exactly what posts, with a button naming the verdict, before it posts.",
    instructions: `When the reviewer asks you to submit their review, approve, or request changes, call submit_review. It opens a form showing them exactly what posts: say it's there, and end your turn. If they answer with a short yes in chat instead, call it again with the same input and confirm: "yes". Pass confirm: "just-post-it" only when their own message says to post without showing it, and for an approval names it ("approve it, just post it"). Asked from another of their threads, it gives you the text to send back there, and an approval waits for the reviewer's click in Needs review. If it comes back with a warning, such as new commits since they reviewed, tell them in a line, and call again with force: true only if they want it posted anyway. In a turn the reviewer didn't start, it only marks your suggested verdict. ${ONLY_WITH_THESE_TOOLS}`,
    parameters: z.object({
      verdict: z.enum(["APPROVE", "REQUEST_CHANGES", "COMMENT"]),
      body: z.string().trim().max(65_000).optional().describe("The summary to post with it, in GitHub Markdown, replacing the draft's when it posts. Without it, the draft's summary posts."),
      force: z.boolean().optional().describe("true: post past the warning you told the reviewer about, as they asked."),
      confirm,
    }),
    async execute({ verdict, body, force, confirm: answer }, { threadId, signal }) {
      const started = await start(threadId);
      if ("refused" in started) return started.refused;
      const { review, turn } = started;
      const k = review.targetKey;
      // Only the reviewer picks the verdict: a turn they didn't start marks it, and writes the summary only where it may.
      if (turn.asking === "unattended") {
        const saved = body ? await writeSummary(store, k, { body, verdict }, threadId) : null;
        if (!saved?.ok) await store.updateSummary(k, { suggestedVerdict: verdict });
        bb.realtime.publish(`draft:${k}`, {});
        return `Marked ${VERDICT_LABEL[verdict]} as your suggested verdict in the reviewer's draft${saved?.ok ? ", with your summary" : ""}. ${UNATTENDED}`;
      }
      const { draft, preExisting } = await store.exclusive(async (tx) => ({ draft: await tx.getDraft(k), preExisting: (await tx.getPreferences()).preferences.knobs.preExistingFindings }));
      const comments: Comment[] = draft.comments.map(({ file, line, side, startLine, startSide, severity, introduced, body }) => ({ file, line, side, body, ...(startLine === undefined ? {} : { startLine, startSide }), ...(severity ? { severity } : {}), ...(introduced === false ? { introduced } : {}) }));
      const summary = body ?? draft.body;
      // What GitHub refuses, said before anything is shown.
      if (verdict !== "COMMENT" && review.ownPr) return failed("GitHub allows only a Comment review on your own PR, so nothing was posted. Offer to post it as a Comment review instead.");
      // Relayed, an approval waits for the reviewer's own click, with the summary alone: the draft's comments stay.
      if (turn.asking === "relayed" && verdict === "APPROVE") {
        if (!review.headSha) return failed("The commit the reviewer reviewed isn't known, so there's nothing to approve yet. Nothing was done.");
        await holdForApproval(bb, store, { ...review, headSha: review.headSha }, { action: "approve", verdict, body: summary, from: turn.message?.senderThreadId ?? null });
        changed(k);
        return HELD("approving");
      }
      // What would stop it or warn, before it's shown: a warning is the one pushback, and with force it's in the form,
      // in the form's own words, with the summary as it would post.
      const checked = await submitReview(k, undefined, (await login()) ?? undefined, comments, { body: summary, verdict }, { check: true });
      if (!checked.ok && !checked.warning) return failed(`Nothing was posted. ${checked.error}${checked.offers?.includes("comment") ? " Offer to post it as a Comment review instead." : ""}`);
      const unseen = checked.newCommits?.count;
      const notes = (checked.warnings ?? []).map((kind) =>
        kind === "new-commits" ? `${unseen ? plural(unseen, "new commit") : "New commits"} since you reviewed. ${verdict === "APPROVE" ? "Approving now covers them unseen." : `${DOING[verdict]} now posts on the version you reviewed.`}`
        : kind === "older-diff" ? "Comments drafted on an older diff post in the summary, as shown."
        : kind === "outside-diff" ? "Comments outside the diff post in the summary, as shown."
        : checked.texts?.[kind] ?? "");
      if (checked.warning && !force) return failed(`Nothing was posted. ${notes.join(" ")} Tell the reviewer; if they want it posted anyway, call submit_review again with force: true.`);
      const posting = checked.posting ?? { body: summary, comments: draft.comments };
      const w: Write = { kind: "review", verdict, body: summary, comments, was: { body: draft.body, verdict: draft.verdict }, force: checked.warnings ?? [], headSha: review.headSha ?? null };
      return previewed(threadId, signal, review, turn, w, verdict === "APPROVE" ? "approve" : verdict === "REQUEST_CHANGES" ? "request-changes" : "post", (account) => ({
        title: `${verdict === "APPROVE" ? "Approve" : verdict === "REQUEST_CHANGES" ? "Request changes on" : "Post to"} ${where(review)}${by(account)}`, action: VERDICT_LABEL[verdict], button: VERDICT_BUTTON[verdict],
        parts: [...posting.body.trim() ? [{ label: "Summary", body: posting.body }] : [], ...posting.comments.map((c) => ({ label: `${c.file}:${linesOf(c)}`, body: postedBody(c, preExisting), path: true }))],
        notes: [...notes, ...!posting.body.trim() && !posting.comments.length ? ["No summary or comments: the verdict alone."] : []],
      }), answer);
    },
  });

  bb.agents.registerTool({
    name: "post_reply",
    description: "Reply on a review thread on this PR, as the reviewer. They see exactly what posts, with a Post button, before it posts.",
    instructions: `When the reviewer asks you to reply on a thread, call post_reply with the thread's id; it opens the Post form, and a yes works as with submit_review. ${ONLY_WITH_THESE_TOOLS}`,
    parameters: z.object({
      threadId: z.string().min(1).describe("The thread's id, from list_feedback or read_pr_context."),
      body: z.string().trim().min(1).max(65_000).describe("The reply, in GitHub Markdown."),
      confirm,
    }),
    async execute({ threadId: thread, body, confirm: answer }, { threadId, signal }) {
      const started = await start(threadId);
      if ("refused" in started) return started.refused;
      const { review, turn } = started;
      const k = review.targetKey;
      const yours = (await store.listFeedbackThreads(k)).find((t) => t.id === thread);
      if (turn.asking === "unattended") {
        if (!yours) return failed(`${UNATTENDED} Suggest the reply in chat.`);
        // A reply the reviewer drafted there stays theirs.
        const drafted = await store.exclusive(async (tx) => {
          if ((await tx.listReplyDrafts(k)).get(thread)?.author === "reviewer") return false;
          await tx.setReplyDraft(k, thread, body, "agent");
          return true;
        });
        if (!drafted) return failed(`The reviewer has a reply drafted on that thread, so it stays as they wrote it. ${UNATTENDED} Suggest yours in chat.`);
        bb.realtime.publish(`feedback:${k}`, { ts: Date.now() });
        return `Drafted the reply on the thread, for the reviewer to send. ${UNATTENDED}`;
      }
      const found = yours ? { commentId: yours.commentId, path: yours.path, line: yours.line } : await (async () => {
        const t = (await readReviewThreads(review.repo, review.number, runGh)).threads.find((t) => t.id === thread);
        return t?.comments[0] ? { commentId: t.comments[0].databaseId, path: t.path, line: t.line } : null;
      })();
      if (!found) return failed(`There's no thread ${thread} on this PR. Use an id from list_feedback or read_pr_context.`);
      const facts = await readWriteFacts(runGh, review.repo, review.number, thread);
      const held = "error" in facts ? null : pushback("reply", facts, review.repo);
      if (held) return failed(held);
      const at = found.path ? `${found.path}${found.line ? `:${found.line}` : ""}` : null;
      return previewed(threadId, signal, review, turn, { kind: "reply", thread, commentId: found.commentId, at, body }, "post",
        (account) => ({ title: `Post to ${where(review)}${by(account)}`, action: "Reply", button: "Post", parts: [{ label: at ? `Reply on ${at}` : "Reply", body }], notes: [] }), answer);
    },
  });

  bb.agents.registerTool({
    name: "resolve_thread",
    description: "Resolve, or with resolved: false unresolve, a review thread on this PR on GitHub.",
    instructions: `Resolve or unresolve a thread when the reviewer asks, with resolve_thread. ${TEAMMATES} ${ONLY_WITH_THESE_TOOLS}`,
    parameters: z.object({ threadId: z.string().min(1).describe("The thread's id, from list_feedback or read_pr_context."), resolved: z.boolean().optional().describe("false to unresolve it."), confirm }),
    async execute({ threadId: thread, resolved = true, confirm: answer }, { threadId, signal }) {
      const started = await start(threadId);
      if ("refused" in started) return started.refused;
      const { review, turn } = started;
      if (turn.asking === "unattended") return failed(`${UNATTENDED} Suggest it to the reviewer.`);
      const facts = await readWriteFacts(runGh, review.repo, review.number, thread);
      if ("error" in facts) return failed(facts.error);
      if (!facts.thread) return failed(`There's no thread ${thread} on this PR. Use an id from list_feedback or read_pr_context.`);
      const held = pushback(resolved ? "resolve" : "unresolve", facts, review.repo);
      if (held) return failed(held);
      const t = (await store.listFeedbackThreads(review.targetKey)).find((t) => t.id === thread);
      const at = t?.path ? `${t.path}${t.line ? `:${t.line}` : ""}` : null;
      return change(threadId, signal, review, turn, { kind: "resolve", thread, resolved, at }, facts, `${resolved ? "Resolves" : "Unresolves"} the thread${at ? ` on ${at}` : ""}.`, answer);
    },
  });

  bb.agents.registerTool({
    name: "github_pr",
    description: "Act on this PR on GitHub as the reviewer: comment; edit its title or description; add or remove labels, reviewers (a team as org/slug) or assignees; close, reopen or merge it; mark it ready for review or a draft. A comment, an edit, closing and merging show the reviewer exactly what happens, with a button naming it, first.",
    instructions: `Use github_pr when the reviewer asks for one of these. ${TEAMMATES} Ask before merging while checks are still running, and offer auto: true, which merges once they pass. Force-pushing is the main thread's job: offer to send it there. The form and a yes work as with submit_review. ${ONLY_WITH_THESE_TOOLS}`,
    parameters: z.object({
      action: z.enum(["comment", "edit", "close", "merge", ...META]),
      body: z.string().trim().max(65_000).optional().describe("comment: the comment. edit: the new description. merge: the merge commit's description, else none. GitHub Markdown."),
      title: z.string().trim().min(1).max(256).optional().describe("edit: the new title. merge: the merge commit's title, else the PR's title and number."),
      names: z.array(z.string().trim().min(1)).max(50).optional().describe("Labels, logins, or teams as org/slug, for the add and remove actions."),
      method: z.enum(["merge", "squash", "rebase"]).optional().describe("merge: how. Ask the reviewer if they didn't say."),
      auto: z.boolean().optional().describe("merge: once checks and reviews pass."),
      deleteBranch: z.boolean().optional().describe("merge: delete the branch after."),
      confirm,
    }),
    async execute({ action, body, title: newTitle, names, method, auto = false, deleteBranch = false, confirm: answer }, { threadId, signal }) {
      const started = await start(threadId);
      if ("refused" in started) return started.refused;
      const { review, turn } = started;
      if (turn.asking === "unattended") return failed(`${UNATTENDED} Suggest it to the reviewer.`);
      const facts = await readWriteFacts(runGh, review.repo, review.number);
      if ("error" in facts) return failed(facts.error);
      const held = pushback(action === "comment" || action === "edit" || action === "merge" || action === "close" ? action : metaAction(action), facts, review.repo);
      if (held) return failed(held);
      const shown = (verb: string, label: string, button: PostButton, parts: PostShown["parts"], details: string[] = []) => (account: string | null): PostShown =>
        ({ title: `${verb} ${where(review)}${by(account)}`, action: label, button, parts, notes: [], ...details.length ? { details } : {} });
      switch (action) {
        case "comment":
          if (!body) return failed("Give the comment as body.");
          return previewed(threadId, signal, review, turn, { kind: "comment", body }, "post", shown("Post to", "PR comment", "Post", [{ label: "Comment", body }]), answer);
        case "edit":
          if (newTitle === undefined && body === undefined) return failed("Give the new title, the new description as body, or both.");
          return previewed(threadId, signal, review, turn, { kind: "edit", ...(newTitle === undefined ? {} : { title: newTitle }), ...(body === undefined ? {} : { body }) }, "post",
            shown("Post to", "Edit", "Post", [...newTitle === undefined ? [] : [{ label: "Title", body: newTitle }], ...body === undefined ? [] : [{ label: "Description", body }]]), answer);
        case "merge": {
          if (!method) return failed("Say how to merge it: merge, squash or rebase. Ask the reviewer if they didn't say.");
          if (!review.headSha) return failed("The commit the reviewer reviewed isn't known, so it can't be merged at it. Update the review first.");
          if (facts.headSha !== review.headSha) return failed(`The PR has commits the reviewer hasn't reviewed (${review.headSha.slice(0, 7)} reviewed, ${facts.headSha.slice(0, 7)} now), so nothing was merged. Tell them: they Update the review and read those first.`);
          // Relayed, it waits for the reviewer's own click, with GitHub's commit message for it.
          if (turn.asking === "relayed") {
            await holdForApproval(bb, store, { ...review, headSha: review.headSha }, { action: "merge", verdict: null, body: "", merge: { method, auto, deleteBranch }, from: turn.message?.senderThreadId ?? null });
            changed(review.targetKey);
            return HELD("merging");
          }
          // What lands on the base branch, shown and given to GitHub as is: a rebase lands the commits themselves.
          const message: { subject?: string; body?: string; fallback?: string } = method === "rebase" ? {} : await mergeMessage(review, method, { title: newTitle, body });
          const known = { ...message.subject === undefined ? {} : { subject: message.subject }, ...message.body === undefined ? {} : { body: message.body } };
          return previewed(threadId, signal, review, turn, { kind: "merge", method, auto, deleteBranch, headSha: review.headSha, ...known }, "merge", shown("Merge", "Merge", "Merge",
            [...message.subject === undefined ? [] : [{ label: "Commit title", body: message.subject }], ...message.body ? [{ label: "Commit description", body: message.body }] : []],
            [`${method === "merge" ? "A merge commit" : method === "squash" ? "Squashed into one commit" : "Rebased: its commits land as they are"}, at ${review.headSha.slice(0, 7)}, the commit you reviewed.`,
              ...message.fallback === undefined ? [] : message.subject === undefined && message.body === undefined ? [`Commit message: ${message.fallback}.`]
                : [...message.subject === undefined ? [`Commit title: ${message.fallback}.`] : [], ...message.body === undefined ? [`Commit description: ${message.fallback}.`] : !message.body ? ["No commit description."] : []],
              ...auto ? ["It merges once checks and reviews pass."] : [], ...deleteBranch ? ["Then it deletes the branch."] : []]), answer);
        }
        case "close":
          if (turn.asking === "relayed") {
            if (!review.headSha) return failed("The commit the reviewer reviewed isn't known. Nothing was done.");
            await holdForApproval(bb, store, { ...review, headSha: review.headSha }, { action: "close", verdict: null, body: "", from: turn.message?.senderThreadId ?? null });
            changed(review.targetKey);
            return HELD("closing");
          }
          return previewed(threadId, signal, review, turn, { kind: "close" }, "close", shown("Close", "Close", "Close", [], ["Closes the PR without merging it."]), answer);
      }
      if (action.startsWith("add-") || action.startsWith("remove-")) {
        if (!names?.length) return failed("Give the names.");
      }
      const list = (names ?? []).map((n) => n.includes("/") ? n : action.endsWith("label") ? n : `@${n.replace(/^@/, "")}`).join(", ");
      const what = ({
        "add-label": `Adds the label ${list}.`, "remove-label": `Removes the label ${list}.`, "add-reviewer": `Requests a review from ${list}.`, "remove-reviewer": `Removes the review request from ${list}.`,
        "add-assignee": `Assigns ${list}.`, "remove-assignee": `Unassigns ${list}.`, reopen: "Reopens the PR.", ready: "Marks it ready for review.", draft: "Marks it as a draft.",
      } as Record<MetaAction, string>)[action];
      return change(threadId, signal, review, turn, { kind: "meta", action, names: names ?? [] }, facts, what, answer);
    },
  });

  bb.agents.registerTool({
    name: "open_pr",
    description: "Open a PR on GitHub from this local review's branch, as the reviewer, with the title and description you give. They see exactly what opens, with an Open PR button, first. Once it's open, this review becomes the PR's review.",
    instructions: `When the reviewer asks you to open a PR, draft its title and description from the review, then call open_pr; it opens the Post form, and a yes works as with submit_review. The branch must be on GitHub first: if it isn't, tell the reviewer to push it with Push in Finish review, and never push it yourself. ${ONLY_WITH_THESE_TOOLS}`,
    parameters: z.object({
      title: z.string().trim().min(1).max(256).describe("The PR's title."),
      body: z.string().trim().max(65_000).optional().describe("The PR's description, in GitHub Markdown."),
      base: z.string().trim().min(1).max(255).optional().describe("The branch it goes into, when the reviewer names one; else the review's base."),
      confirm,
    }),
    async execute({ title, body = "", base: named, confirm: answer }, { threadId, signal }) {
      if (!await acting()) return failed(OFF);
      const found = await reviewFor(threadId);
      const review = found ? openable(found) : "This conversation is no longer a review's agent.";
      if (typeof review === "string") return failed(review);
      // Opening a PR posts under the reviewer's name: a turn they didn't start opens none.
      const turn = await classify(threadId);
      if (turn.asking === "unattended") return failed(`${UNATTENDED} Suggest the PR's title and description in chat instead.`);
      const { repo, branch } = review.feature;
      const base = prBase(named ?? review.feature.baseRef);
      if (!base) return failed("This review's base is a commit, not a branch, so the PR's base isn't known. Ask the reviewer which branch it goes into, then pass it as base.");
      if (base === branch) return failed(`The PR can't go into ${branch}, its own branch. Ask the reviewer which branch it goes into.`);
      const pushed = await branchOnGithub(runGh, repo, branch);
      if ("error" in pushed) return failed(pushed.error);
      if ("fork" in pushed) return failed(`${FORK} Tell the reviewer.`);
      if ("missing" in pushed) return failed(`${notPushed(branch)} Tell the reviewer; never push it yourself.`);
      if (pushed.pr) return failed(`${branch} has PR #${pushed.pr.number} on GitHub already, so none was opened. ${await becomeOpened(deps, review, pushed.pr)}`);
      return previewed(threadId, signal, review, turn, { kind: "open-pr", head: branch, base, title, body, headSha: pushed.sha }, "post", (account) => ({
        title: `Open a PR from ${branch} into ${base}${by(account)}`, action: "Open PR", button: "Open PR",
        parts: [{ label: "Title", body: title }, ...body ? [{ label: "Description", body }] : []],
        notes: [], details: [`${repo}: ${base} ← ${branch}, at ${pushed.sha.slice(0, 7)} on GitHub.`, ...body ? [] : ["No description."]],
      }), answer);
    },
  });
}

/** The role GitHub needs for a change without text, as github-writes words its refusals. */
function metaAction(action: MetaAction): WriteAction {
  return action.endsWith("label") ? "label" : action.endsWith("reviewer") ? "request-review" : action.endsWith("assignee") ? "assign" : action === "reopen" ? "reopen" : "edit";
}

/**
 * The merge or squash commit's title and description as this repo's settings make them, read just before the form
 * shows: given (`asked`), or worked out from the PR where the setting says exactly what. Undefined where it leaves them
 * to the commits, or GitHub didn't say, so GitHub writes its own default and nothing is sent for it; `fallback` then
 * says what that default is.
 */
async function mergeMessage(review: Review, method: "merge" | "squash", asked: { title?: string; body?: string }): Promise<{ subject?: string; body?: string; fallback: string }> {
  const settings = await readMergeSettings(runGh, review.repo, review.number);
  const n = review.number;
  const fallback = method === "squash" ? "this repo's default (the commits' messages)" : `GitHub's default, "Merge pull request #${n}${settings?.from ? ` from ${settings.from}` : ""}"`;
  if (!settings) return { ...asked.title === undefined ? {} : { subject: asked.title }, ...asked.body === undefined ? {} : { body: asked.body }, fallback };
  const titled = `${settings.title} (#${n})`;
  const subject = method === "squash"
    ? settings.squashTitle === "PR_TITLE" || (settings.squashTitle === "COMMIT_OR_PR_TITLE" && settings.commits > 1) ? titled : undefined
    : settings.mergeTitle === "PR_TITLE" ? titled : settings.mergeTitle === "MERGE_MESSAGE" && settings.from ? `Merge pull request #${n} from ${settings.from}` : undefined;
  const setting = method === "squash" ? settings.squashMessage : settings.mergeMessage;
  const body = setting === "PR_BODY" ? settings.body : setting === "BLANK" ? "" : setting === "PR_TITLE" && method === "merge" ? settings.title : undefined;
  return { subject: asked.title ?? subject, body: asked.body ?? body, fallback };
}
