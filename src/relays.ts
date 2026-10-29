// What your other threads ask of a review: `bb review ask`, which relays a message to its agent, starting one if it has
// none, and `bb review approve`, which lines approvals up. A relayed approve, merge or close, from these or one the agent
// is asked for (src/review-agent-tools.ts), never posts: it waits in Needs review as Ready to approve, with exactly what
// it posts, for your own click (Part 2 §6).
import { createHash } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { messageAssistant } from "./agent";
import { runGh } from "./gh";
import { mergePr, pushback, readWriteFacts, refusalText } from "./github-writes";
import { parseTarget, prReviewKey } from "./targets";
import { reviewIdentity } from "../lib/review-identity";
import type { Verdict } from "./draft";
import type { ActivityEntry, ReadyToApprove, ReviewMeta } from "./store";
import type { SubmitResult, SubmitWarning } from "./submit-review";
import type { AsyncStore } from "./store-queue";
import type { RpcHandlers, ServeDeps, Subcommands } from "./server-modules";

export const ASK_USAGE = [
  "usage: bb review ask <review> <text>",
  "",
  "Sends <text> to the review's agent as relayed from this thread, starting the agent if the review has none. It answers this thread.",
  "  <review>  a GitHub PR URL, owner/repo#n, or a review key (pr-…, ref-…)",
  "A review with an agent can take `bb thread tell <agentThreadId>` too, with the id from `bb review list --json`.",
].join("\n");
export const APPROVE_USAGE = [
  "usage: bb review approve <review…> [--body <text>]",
  "",
  "Lines each PR's approval up in Needs review as Ready to approve. Nothing posts until the reviewer approves it there.",
  "  <review>  a GitHub PR URL, owner/repo#n, or a review key (pr-…)",
  "  --body    the summary to approve with, the same for each; without it, the approval alone",
].join("\n");
/** GitHub takes up to 65,536 characters in a review body. */
const BODY_LIMIT = 65_000;

type Hold = Pick<ReadyToApprove, "action" | "verdict" | "body" | "from"> & Pick<Partial<ReadyToApprove>, "merge">;
/** The token of exactly this row's post, on this review. */
const readyToken = (targetKey: string, row: Omit<ReadyToApprove, "token" | "from" | "at">) => createHash("sha256").update(JSON.stringify([targetKey, row.action, row.verdict, row.body, row.comments, row.headSha, row.merge ?? null])).digest("hex").slice(0, 16);

/**
 * Line `hold` up as the review's Ready to approve row, replacing one waiting there: on the review's head, with no line
 * comments, the draft's staying in it, and the title of the thread that asked.
 */
export async function holdForApproval(bb: BbPluginApi, store: AsyncStore, review: ReviewMeta & { headSha: string }, hold: Hold): Promise<ReadyToApprove> {
  const asked = { action: hold.action, verdict: hold.verdict, body: hold.body, comments: [], headSha: review.headSha, ...(hold.merge ? { merge: hold.merge } : {}) };
  const fromTitle = hold.from ? await bb.sdk.threads.get({ threadId: hold.from }).then((thread) => thread.title ?? undefined, () => undefined) : undefined;
  const row: ReadyToApprove = { ...asked, token: readyToken(review.targetKey, asked), from: hold.from, ...(fromTitle ? { fromTitle } : {}), at: Date.now() };
  await store.setLifecycle(review.targetKey, { readyToApprove: row });
  return row;
}

type Outcome = { outcome: "posted"; url?: string } | { outcome: "held" | "failed"; error: string; commits?: number | null };

export function register(deps: ServeDeps, { submit }: {
  /** draft-rpc's Submit: it posts, then records what follows. */
  submit: (targetKey: string, revision: undefined, account: undefined, comments: [], summary: { body: string; verdict: Verdict }, force: readonly SubmitWarning[], options: { alone: boolean; reviewed: string }) => Promise<SubmitResult>;
}) {
  const { bb, store, githubWrites, changed } = deps;
  /** Why a command can't run from here: a review's own agent, or a thread one started, would be relaying to itself. */
  const notFromAgents = async (ownReview: string | undefined, threadId: string | undefined, refusal: string) => {
    if (ownReview !== undefined) return { exitCode: 2, stderr: refusal };
    const own = threadId === undefined ? false : await deps.fromOwnAgent(threadId);
    if (own === null) return { exitCode: 1, stderr: "bb couldn't say which threads this one was started from, so nothing was done. Try again in a moment." };
    return own ? { exitCode: 2, stderr: refusal } : null;
  };
  /** The reviews being approved now: a second click waits for the first's answer. */
  const posting = new Set<string>();

  /** The review `given` names, as the other subcommands find it: a PR's link, owner/repo#n, or a key. */
  async function reviewNamed(given: string): Promise<ReviewMeta | null> {
    const target = parseTarget(given);
    const key = target.kind === "pr" && target.repo ? await prReviewKey(store, { repo: target.repo, number: target.number }) : given.trim();
    return await store.getReview(key);
  }
  const named = (review: ReviewMeta) => `${reviewIdentity(review).id} (${review.targetKey})`;

  /** Post one row, if it's still the one waiting: held, without `alsoHeld`, when the PR has commits since it was asked. */
  async function approveOne(targetKey: string, token: string, alsoHeld: boolean): Promise<Outcome> {
    const review = await store.getReview(targetKey);
    const row = review?.readyToApprove;
    if (!review || !row || row.token !== token) return { outcome: "failed", error: "This isn't waiting for your approval anymore: it was approved, dismissed, or asked again." };
    if (review.kind !== "pr" || !review.repo || !review.number) return { outcome: "failed", error: "This review isn't of a PR, so there's nothing to approve on GitHub." };
    const { repo, number } = review;
    let done: Outcome;
    if (row.action === "approve") {
      // On the head it was asked on, checked in the submitter's own turn; the live head, as it reads it, holds it; nothing
      // else is passed: any other warning stops it.
      const result = await submit(targetKey, undefined, undefined, [], { body: row.body, verdict: "APPROVE" }, alsoHeld ? ["new-commits"] : [], { alone: true, reviewed: row.headSha });
      if (result.ok) done = { outcome: "posted", ...(result.url ? { url: result.url } : {}) };
      else if (result.warnings?.length && result.warnings.every((warning) => warning === "new-commits")) return { outcome: "held", error: result.warning!, commits: result.newCommits?.count ?? null };
      else return { outcome: "failed", error: result.warning ? `${result.warning} Approve it from the review.` : result.error ?? "GitHub didn't take the approval." };
    } else {
      const facts = await readWriteFacts(runGh, repo, number);
      if ("error" in facts) return { outcome: "failed", error: facts.error };
      const held = pushback(row.action, facts, repo);
      if (held) return { outcome: "failed", error: held };
      if (row.action === "merge") {
        if (facts.headSha !== row.headSha) {
          return alsoHeld ? { outcome: "failed", error: "It merges only at the commit you reviewed, and the PR has commits since. Update the review, then merge it there." }
            : { outcome: "held", error: `The PR has commits you haven't reviewed (${row.headSha.slice(0, 7)} reviewed, ${facts.headSha.slice(0, 7)} now).` };
        }
        const merge = row.merge ?? { method: "merge" as const, auto: false, deleteBranch: false };
        const r = await mergePr(githubWrites, runGh, repo, number, { headSha: row.headSha, ...merge });
        if (!r.ok) return { outcome: "failed", error: `Not merged. ${refusalText(r)}` };
      } else {
        const r = await githubWrites.post(runGh, ["pr", "close", String(number), "-R", repo], { action: "close" });
        if (!r.ok) return { outcome: "failed", error: `Not closed. ${refusalText(r)}` };
      }
      done = { outcome: "posted" };
    }
    // Done: the row goes, and the review's activity says so, asked from the thread that relayed it.
    const entry: ActivityEntry = { at: Date.now(), text: row.action === "approve" ? "Approved" : row.action === "merge" ? `Merged (${row.merge?.method ?? "merge"})` : "Closed the PR", asking: "relayed", from: row.from, ...(done.outcome === "posted" && done.url ? { url: done.url } : {}) };
    await store.exclusive(async (tx) => {
      const now = await tx.getReview(targetKey);
      await tx.setLifecycle(targetKey, { ...now?.readyToApprove?.token === token ? { readyToApprove: null } : {}, activity: [...now?.activity ?? [], entry] });
    });
    changed(targetKey);
    return done;
  }

  const handlers = {
    // Approve and Approve all shown, one row after another, and Approve them too, for the rows held.
    async approveReady({ rows, alsoHeld = false }) {
      const results = [];
      for (const { targetKey, token } of rows) {
        if (posting.has(targetKey)) { results.push({ targetKey, outcome: "failed" as const, error: "It's being approved already." }); continue; }
        posting.add(targetKey);
        try {
          results.push({ targetKey, ...await approveOne(targetKey, token, alsoHeld) });
        } catch (error) {
          results.push({ targetKey, outcome: "failed" as const, error: error instanceof Error ? error.message : "Couldn't approve it." });
        } finally {
          posting.delete(targetKey);
        }
      }
      return { results };
    },
    async dismissReady({ targetKey, token }) {
      const dismissed = await store.exclusive(async (tx) => {
        if ((await tx.getReview(targetKey))?.readyToApprove?.token !== token) return false;
        await tx.setLifecycle(targetKey, { readyToApprove: null });
        return true;
      });
      if (!dismissed) return { ok: false, error: "This isn't waiting for your approval anymore." };
      changed(targetKey);
      return { ok: true };
    },
  } satisfies Partial<RpcHandlers>;

  const commands = {
    async ask(args, ctx, ownReview) {
      if (args[0] === "--help" || args[0] === "-h") return { exitCode: 0, stdout: ASK_USAGE };
      // An agent of the plugin's own, or a thread it started, would relay to itself.
      const refused = await notFromAgents(ownReview, ctx.threadId, "A review's own agent, or a thread it started, can't relay messages to a review's agent.");
      if (refused) return refused;
      const [given, ...words] = args;
      const text = words.join(" ").trim();
      if (!given || !text) return { exitCode: 2, stderr: `Give the review and the message.\n${ASK_USAGE}` };
      const review = await reviewNamed(given);
      if (!review) return { exitCode: 1, stderr: `No saved review for ${given}. Pass the PR's URL or the review's key.` };
      const from = ctx.threadId ?? null;
      const context = from
        ? `Relayed with bb review ask from thread ${from}, one of the reviewer's. Answer that thread with \`bb thread tell ${from}\`.`
        : "Relayed with bb review ask from a shell outside any bb thread. Answer in your reply.";
      try {
        const sent = await messageAssistant(bb, store, review.targetKey, text, context, { kind: "relay", from, said: text });
        return { exitCode: 0, stdout: `${sent.started ? "Started the review agent of" : "Sent to the review agent of"} ${named(review)}. ${from ? "It answers this thread." : "It answers in the review."}` };
      } catch (error) {
        return { exitCode: 1, stderr: `Couldn't send to the review agent of ${named(review)}: ${error instanceof Error ? error.message : String(error)}` };
      }
    },
    async approve(args, ctx, ownReview) {
      if (args.includes("--help") || args.includes("-h")) return { exitCode: 0, stdout: APPROVE_USAGE };
      // A review's own agent, or a thread it started, read the PR's text.
      const refused = await notFromAgents(ownReview, ctx.threadId, "A review's own agent, or a thread it started, can't line up approvals.");
      if (refused) return refused;
      const given: string[] = [];
      let body: string | undefined;
      for (let i = 0; i < args.length; i++) {
        if (args[i] !== "--body") {
          if (args[i].startsWith("--")) return { exitCode: 2, stderr: `Unexpected argument: ${args[i]}\n${APPROVE_USAGE}` };
          given.push(args[i]);
          continue;
        }
        if (body !== undefined || i + 1 >= args.length) return { exitCode: 2, stderr: "--body needs text, given once." };
        body = args[++i].trim();
        if (body.length > BODY_LIMIT) return { exitCode: 2, stderr: "--body is limited to 65,000 characters." };
      }
      if (!given.length) return { exitCode: 2, stderr: `Give the reviews to approve.\n${APPROVE_USAGE}` };
      const lines: string[] = [];
      let failures = 0;
      for (const each of given) {
        const review = await reviewNamed(each);
        const refused = !review ? `${each}: no saved review. Pass the PR's URL or the review's key.`
          : review.kind !== "pr" ? `${named(review)}: a local review has nothing to approve on GitHub.`
          : review.prState === "MERGED" || review.prState === "CLOSED" ? `${named(review)}: the PR is ${review.prState.toLowerCase()}, so there's nothing to approve.`
          : review.ownPr ? `${named(review)}: it's the reviewer's own PR, and GitHub allows only a Comment review on it.`
          : !review.headSha ? `${named(review)}: the review hasn't read the PR's code yet. Build its guide first.`
          : null;
        if (refused) { failures++; lines.push(refused); continue; }
        await holdForApproval(bb, store, { ...review!, headSha: review!.headSha! }, { action: "approve", verdict: "APPROVE", body: body ?? "", from: ctx.threadId ?? null });
        changed(review!.targetKey);
        lines.push(`${named(review!)}: Ready to approve in Needs review. Nothing posts until the reviewer approves it there.`);
      }
      return failures ? { exitCode: 1, stdout: lines.join("\n") } : { exitCode: 0, stdout: lines.join("\n") };
    },
  } satisfies Subcommands;
  return { handlers, commands };
}
