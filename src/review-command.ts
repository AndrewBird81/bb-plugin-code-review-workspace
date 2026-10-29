import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { ReviewMeta } from "./store";
import { parseTarget, prReviewKey, targetKey } from "./targets";
import { ensureGitHeaders } from "./patch";
import { beginGuide, guideWriterUnavailable } from "./generate";
import { readPrSnapshot } from "./pr-snapshot";
import { rebuildReview, upToDate } from "./rereview";
import { recordPrState } from "./start-review";
import { automaticReviewPrompt, type ReviewPreferences } from "./preferences";
import { baselineOf } from "../lib/turn";
import { readAuthorTrust } from "./author-trust";
import { mayRunUnattended } from "../lib/trust";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import {
  ghRepoViewArgs, gitDiffArgs, ghErrorMessage,
} from "./gh";
import type { AsyncStore } from "./store-queue";
import { defaultName, NAME_LIMIT } from "../lib/review-name";
import { identityIn, placeFacts, type PlaceFacts } from "./review-places";

interface Deps {
  bb: BbPluginApi;
  store: AsyncStore;
  gh: { runGh: typeof import("./gh").runGh; runGit: typeof import("./gh").runGit };
}
interface Ctx { projectId?: string; threadId?: string; cwd?: string }

/** The usage, with `bb review list` while Help agents in your threads use bb review is on. */
const usage = (list: boolean) => [
  "usage: bb review <pr-url | owner/repo#n | pr-number | git-ref> [--base <ref>] [--context <text>] [--name <text>]",
  "       bb review comment <list | add | edit | delete> …   (see bb review comment --help)",
  "       bb review summary <review> [--body <text>] …        (see bb review summary --help)",
  ...list ? ["       bb review list [--json]                             (see bb review list --help)"] : [],
  "       bb review storage <status | verify | migrate | export-sqlite>  (see bb review storage --help)",
  "",
  "  A git ref named comment, summary, list or storage is given as refs/heads/<name>.",
  "  --context  text for the assistant's automatic review, such as the ticket the change implements. It's kept with the review; '' removes it.",
  "  --name     your name for the review, shown in bb instead of the PR's title or the ref; '' puts that back. GitHub, and the agents, keep the PR's title.",
].join("\n");
const CONTEXT_LIMIT = 12_000;

/** The refusal a review's own agent gets for a command on another review. */
export const NOT_OWN_REVIEW = "This agent can change only its own review.";

/**
 * `ownReview` is set when a review's own assistant or guide writer, or one replaced, runs the command: it may start only that review,
 * and its guide is unattended, so it doesn't approve agents on the PR's head as your click does.
 */
export async function runReviewCommand(deps: Deps, argv: string[], ctx: Ctx, ownReview?: string) {
  const inThreads = (await deps.store.getPreferences()).preferences.knobs.reviewCommandInThreads;
  const USAGE = usage(inThreads);
  let input: string | undefined;
  let base: string | undefined;
  let context: string | undefined;
  let name: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (value === "--help" || value === "-h") return { exitCode: 0, stdout: USAGE };
    if (value === "--base") {
      if (base || !argv[i + 1] || argv[i + 1].startsWith("-")) return { exitCode: 2, stderr: "--base requires a git ref." };
      base = argv[++i];
    } else if (value === "--context") {
      // Any text, including text that starts with "-", such as a bulleted list.
      if (context !== undefined || i + 1 >= argv.length) return { exitCode: 2, stderr: "--context requires text, given once. Pass '' to remove a review's context." };
      context = argv[++i];
      if (context.length > CONTEXT_LIMIT) return { exitCode: 2, stderr: "--context is limited to 12,000 characters." };
    } else if (value === "--name") {
      if (name !== undefined || i + 1 >= argv.length) return { exitCode: 2, stderr: "--name requires text, given once. Pass '' to go back to the PR's title or the ref." };
      // On one line, as a title is.
      name = argv[++i].replace(/\s+/g, " ").trim();
      if (name.length > NAME_LIMIT) return { exitCode: 2, stderr: `--name is limited to ${NAME_LIMIT} characters.` };
    } else if (value.trim().startsWith("-") || input !== undefined) {
      return { exitCode: 2, stderr: `Unexpected argument: ${value}` };
    } else input = value.trim();
  }
  if (!input) return { exitCode: 2, stderr: USAGE };
  if (!ctx.projectId) return { exitCode: 2, stderr: "Run `bb review` inside a project thread." };
  const target = parseTarget(input, base);
  if (target.kind === "pr" && base) return { exitCode: 2, stderr: "--base is only supported for local git refs." };
  if (target.kind === "ref" && base && target.gitRef.includes("..")) return { exitCode: 2, stderr: "--base goes with a single ref, not a range." };
  if (target.kind === "ref" || !target.repo) {
    if (!ctx.cwd) return { exitCode: 2, stderr: "A local ref or PR number needs a working directory. Run `bb review` in the repository." };
    // The caller's directory may be on another machine; git and gh run on the bb server.
    if (!existsSync(resolve(ctx.cwd))) return { exitCode: 2, stderr: `A local ref or PR number needs a checkout on the bb server, and ${ctx.cwd} isn't on it. Pass the PR's URL instead, or run \`bb review\` in a checkout on the server.` };
  }
  const unavailable = await guideWriterUnavailable(deps.bb, deps.store);
  if (unavailable) return { exitCode: 1, stderr: unavailable };
  const cwd = ctx.cwd ? resolve(ctx.cwd) : undefined;
  let key = targetKey(target, cwd ? { projectId: ctx.projectId, cwd } : undefined);
  if (ownReview !== undefined && target.kind === "ref" && key !== ownReview) return { exitCode: 2, stderr: NOT_OWN_REVIEW };
  // The context reaches its agents as from the thread that started the review: a review's own agent read the PR's text.
  if (ownReview !== undefined && context !== undefined) return { exitCode: 2, stderr: "A review's own agent can't set the review's context." };
  // Your name for it is yours: a review's own agent read the PR's text.
  if (ownReview !== undefined && name !== undefined) return { exitCode: 2, stderr: "A review's own agent can't rename the review." };
  // Where local reviews' code is, for what the command says (src/review-places.ts): asked of bb before the store's lock.
  const facts: PlaceFacts = await placeFacts(deps.bb, [target]);
  const now = Date.now();
  let unattended = ownReview !== undefined;

  let patch = "";
  let prState: string | undefined;
  const meta: any = { targetKey: key, kind: target.kind, status: "generating", createdAt: now };
  // A review already building, or showing this diff, just opens, as below.
  const opensAsIs = async (tx: AsyncStore, existing: ReviewMeta | null) => !!existing && (existing.status === "generating" || await upToDate(tx, existing, meta.headSha, patch));
  meta.projectId = ctx.projectId;
  meta.cwd = cwd;
  /** The guide the command begins, which builds on once the turn that began it ends. */
  let run: (() => Promise<void>) | undefined;
  /**
   * The rest of the command, in the caller's block: what it finds, starts, rebuilds or opens as is, and what it says
   * about it, in one turn, so a second start finds this one.
   */
  const finish = async (tx: AsyncStore): Promise<{ exitCode: number; stdout?: string; stderr?: string; told?: boolean }> => {
    if (!patch.trim()) return { exitCode: 1, stderr: "No changes found for that target." };

    if (context !== undefined) await tx.setReviewContext(key, context.trim() || null);
    // The thread that ran it made the change, unless it's this plugin's own agent; a later run from another thread replaces it.
    if (ctx.threadId && ownReview === undefined) await tx.setLifecycle(key, { sourceThreadId: ctx.threadId, sourceThreadAt: now });

    // A review already building, or showing this diff, just opens; another existing one rebuilds as Re-review does.
    const existing = await tx.getReview(key);
    // Starting it again keeps when the review was created.
    if (existing) meta.createdAt = existing.createdAt;
    const building = existing?.status === "generating";
    const current = !!existing && !building && await upToDate(tx, existing, meta.headSha, patch);
    if (building || current) {
      if (existing!.userArchivedAt) await tx.setLifecycle(key, { userArchivedAt: null });
    } else if (existing) {
      await recordPrState(tx, key, prState);
      run = await rebuildReview(deps, tx, meta, patch, { unattended });
    } else {
      // The diff first: a review saved generating without one would stay so.
      await tx.savePatch(key, ensureGitHeaders(patch));
      await tx.saveReview(meta);
      await recordPrState(tx, key, prState);
      await tx.unignoreDiscovery(key);
      // The panel refetches on the realtime signal.
      run = await beginGuide(deps.bb, tx, deps.store, key, ctx.projectId!, { unattended });
    }

    // A link to the review where BB has an address for its app.
    const appUrl = inThreads ? deps.bb.server.experimental_appUrl : null;
    const open = appUrl ? `Open ${appUrl.replace(/\/+$/, "")}/plugins/${deps.bb.pluginId}/review/${key}` : "Open the Code Review Workspace panel";
    // What the automatic review goes by (src/agent.ts startAutomaticReview, src/generate.ts): no review runs on a merged
    // or closed PR, nor once you've reviewed it, and one skipped for your click runs when you click Run review.
    // No name, or the one it has anyway, goes back to the PR's title or ref, as Rename does.
    let unnamed = false;
    if (name !== undefined) {
      const named = await tx.getReview(key);
      unnamed = !!named?.name && !name;
      if (named) await tx.setLifecycle(key, { name: name && name !== defaultName(named) ? name : null });
    }
    const review = await tx.getReview(key);
    const state = review?.startedPrState ?? review?.prState;
    // Which review, as its window's title says it, with its key, which other commands take. The name is quoted, as a
    // PR's title is its author's words.
    const identity = review && identityIn(facts, await tx.listReviews(), review);
    const which = identity ? `${identity.id}${identity.line === identity.id || identity.name === key ? "" : ` ${JSON.stringify(identity.name)}`} (${key})` : key;
    const ended = state === "MERGED" || state === "CLOSED" ? state.toLowerCase() : null;
    const watch = ended ? "to watch it build" : "to watch it build and review";
    const lines = [current ? `The review of ${which} is up to date. ${open} to review it.`
      : building ? `The review of ${which} is already building. ${open} ${watch}.`
      : `Review started for ${which}. ${open} ${watch}.`];
    if (unnamed) lines.push("Removed your name for the review.");
    if (context !== undefined && !context.trim()) lines.push("Removed the review's context.");
    else if (context !== undefined) lines.push(
      !automaticReviewPrompt((await tx.getPreferences()).preferences) ? "Automatic review is off in Review settings, so no review starts with this context. The assistant can still read it with the PR's."
      : ended ? `This PR is ${ended}, so the automatic review won't run. Paste the context into Ask agent instead.`
      : await tx.getAssistantThread(key) ? "This review already has an assistant conversation, so the automatic review won't run. The assistant can read this context with the PR's; paste it into Ask agent to have it act on it."
      : review && baselineOf(review).at ? "You've already reviewed this PR, so the automatic review won't run. Paste the context into Ask agent instead."
      : current && review?.skippedRun?.run === "review" ? "The automatic review is waiting for you to click Run review, and will include this context."
      : current ? "The guide is current, so the automatic review won't run again. Paste the context into Ask agent instead."
      : "The assistant's automatic review will include this context.");
    // Open pages hear of a review started, rebuilding, or back from Archive at once, not when its guide is done.
    return { exitCode: 0, stdout: lines.join("\n"), told: !(building || current) || !!existing!.userArchivedAt || name !== undefined };
  };
  let done: Awaited<ReturnType<typeof finish>> | undefined;
  /** Settings, when GitHub must say first whether the PR's author lets agents start. */
  let asking: ReviewPreferences | undefined;

  if (target.kind === "pr") {
    let repo = target.repo;
    if (!repo) {
      const r = await deps.gh.runGh(ghRepoViewArgs(), { cwd });
      if (r.code !== 0) return { exitCode: 1, stderr: ghErrorMessage(r) };
      try {
        repo = JSON.parse(r.stdout).nameWithOwner as string;
      } catch {
        return { exitCode: 1, stderr: "Unexpected gh output (couldn't parse JSON)." };
      }
    }
    if (!repo || !/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return { exitCode: 1, stderr: "Couldn't resolve the GitHub repository." };
    key = await prReviewKey(deps.store, { repo, number: target.number });
    if (ownReview !== undefined && key !== ownReview) return { exitCode: 2, stderr: NOT_OWN_REVIEW };
    meta.targetKey = key;
    let snapshot: Awaited<ReturnType<typeof readPrSnapshot>>;
    try {
      // The repo is known, so gh needs no checkout. The caller's directory may be on another machine.
      snapshot = await readPrSnapshot(deps.gh.runGh, target.number, repo);
    } catch (error) {
      return { exitCode: 1, stderr: error instanceof Error ? error.message : "Couldn't load the PR." };
    }
    const { pr } = snapshot;
    Object.assign(meta, {
      number: target.number, repo, title: pr.title, author: pr.author?.login,
      base: pr.baseRefName, head: pr.headRefName, url: pr.url, gitRef: `${pr.baseRefName}...${pr.headRefName}`,
      headSha: pr.headRefOid,
    });
    patch = snapshot.patch;
    prState = pr.state;
    // An agent in one of your threads may have been steered by what it read: on a PR where agents wouldn't start on
    // their own, or whose trust GitHub didn't say, Run stays your click. With Unattended authors set to Anyone and Start
    // agents on their own on, or a review that just opens below, GitHub isn't asked, and the rest runs in the same turn.
    try {
      await deps.store.exclusive(async (tx) => {
        const preferences = (await tx.getPreferences()).preferences;
        const everyone = preferences.unattendedAuthors === "anyone" && preferences.knobs.unattendedAgents !== false;
        if (!unattended && ctx.threadId && !everyone && !await opensAsIs(tx, await tx.getReview(key))) asking = preferences;
        else done = await finish(tx);
      });
    } finally {
      void run?.();
    }
    // No head: whether the author alone lets agents start, not an earlier click.
    if (asking) unattended = !mayRunUnattended(await readAuthorTrust(deps.gh.runGh, repo, target.number) ?? { kind: "pr" }, asking, null);
  } else {
    const diff = await deps.gh.runGit(gitDiffArgs(target.gitRef, target.base), { cwd });
    if (diff.code !== 0) return { exitCode: 1, stderr: diff.stderr || "git diff failed" };
    patch = diff.stdout;
    meta.gitRef = target.base ? `${target.base}...${target.gitRef}` : target.gitRef;
    meta.base = target.base;
  }

  if (!done) {
    try {
      done = await deps.store.exclusive(finish);
    } finally {
      void run?.();
    }
  }
  const { told, ...result } = done;
  if (told) {
    deps.bb.realtime.publish(`review:${key}`, { ts: now });
    deps.bb.realtime.publish("reviews", { ts: now });
  }
  return result;
}
