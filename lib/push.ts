// What a review's Push says (src/push.ts), in Finish review, in the review's notices, and to the main thread alike.
// Branches and commits are in `backticks`, what matters most in **bold**: the page draws them (components/shell/PushNotices.tsx).
import type { PushRun, ReviewMeta } from "../src/store";
import { usesFixer } from "./fixer";

/** Where a Not pushed yet you opened keeps what it showed, beside the review's snapshots: Push checks a fixer's commit against it. */
export const NOT_PUSHED = "not-pushed";

/**
 * Where a review's Push goes: GitHub's repo and branch, the folder whose commit goes there, the remote it's pushed to
 * ("<remote>" for a fork's head, `forkOf`'s), and whether a fixer on your PR does it (`pr`, the PR's number).
 */
export interface PushTarget { repo: string; head: string; environmentId: string; remote: "origin" | "<remote>"; forkOf?: string; fixer: boolean; pr?: number }

type Pushable = Pick<ReviewMeta, "feature" | "mainThread" | "repo" | "number" | "head" | "ownPr" | "headFork"> & { kind?: "pr" | "ref" };

/**
 * The review's Push target, or why it has none: a local review of a folder's branch in a GitHub repo, from its folder, a
 * re-homed worktree too; or your own PR with a thread fixing it in a folder, a fixer or the folder it became a PR from.
 * Never someone else's PR.
 */
export function pushTarget(review: Pushable | null): PushTarget | string {
  if (!review) return "This review no longer exists.";
  const unsafe = (head: string) => `Push can’t write a safe command for ${JSON.stringify(head)}: its name has a quote. Push it from a terminal.`;
  if (review.kind === "pr") {
    const fixer = usesFixer(review);
    if (review.ownPr !== true || !fixer && !review.feature) return "Push works on a local review, or on your own PR with a thread fixing it.";
    const environmentId = review.mainThread?.environmentId;
    if (!review.repo || !review.number || !review.head || !environmentId) return "No thread is working on this PR in a folder, so there’s nothing to push.";
    if (pushCommand("HEAD", review.head) === null) return unsafe(review.head);
    const fork = review.headFork != null;
    return { repo: review.repo, head: review.head, environmentId, remote: fork ? "<remote>" : "origin", ...fork && review.headFork ? { forkOf: review.headFork } : {}, fixer, pr: review.number };
  }
  const feature = review.feature;
  if (!feature) return "Push works on a local review of a folder’s branch.";
  if (!feature.repo) return "This folder’s project has no GitHub repo, so there’s nowhere to push.";
  if (feature.folderGone) return "BB removed this review’s folder. Start a fresh thread from Main thread, then Push.";
  if (pushCommand("HEAD", feature.branch) === null) return unsafe(feature.branch);
  return { repo: feature.repo, head: feature.branch, environmentId: feature.environmentId, remote: "origin", fixer: false };
}

/**
 * The one command that pushes to `head` on GitHub, from `remote` ("origin", or for a fork's head "<remote>", which the
 * message names): `HEAD`, a fixer's own commits, as its brief says, or a commit's full SHA, as Push checked it. Quoted for
 * the shell, as a branch's name may hold ; | or $, and never forced; null for a SHA that isn't a full one, or a name
 * with a quote or a control character, which no quoting here makes safe.
 */
export function pushCommand(from: string, head: string, remote: "origin" | "<remote>" = "origin"): string | null {
  // eslint-disable-next-line no-control-regex
  if (from !== "HEAD" && !/^[0-9a-f]{40}$/.test(from) || /['\u0000-\u001f\u007f]/.test(head)) return null;
  return `git push ${remote} '${from}:refs/heads/${head}'`;
}

const sha = (full: string) => `\`${full.slice(0, 7)}\``;
const code = (text: string) => `\`${text}\``;
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** The text without its bold, for a thread to read. */
export const plainText = (text: string) => text.replace(/\*\*/g, "");

/**
 * A commit that isn't what you reviewed: how many `files` changed, and the `secrets` among what it would push, a
 * secret-looking file the review hid, committed now or by an earlier commit (`earlier`), that you never saw.
 */
export function mismatchText(files: readonly string[], secrets: readonly string[], earlier: boolean): string {
  const them = secrets.length === 1 ? "it" : "them";
  return [
    ...files.length ? [`${plural(files.length, "file")} changed since you reviewed.`] : [],
    ...secrets.length ? [`**${secrets.join(", ")} may hold secrets** and would go to GitHub. Ask the main thread to take ${them} out of the ${earlier ? "branch’s commits" : "commit"}, or Include ${them} to review ${them}.`] : [],
  ].join(" ");
}

/**
 * Whether a Push waits on Push anyway: a mismatch with a commit the check placed, or GitHub ahead of the folder before
 * any commit. The page, the review agent and the server all ask this.
 */
export const pushAnywayOffered = (run: PushRun | null | undefined): run is PushRun => run?.state === "mismatch" && (!!run.sha || !!run.behind);

/** What Push says when GitHub has commits the folder doesn't: a push without force would be refused. */
export const behindText = (head: string) => `GitHub has commits on ${code(head)} that this folder doesn’t. Pull first, or Push anyway to try.`;

/** What Push says when GitHub has the commit already. */
export const nothingToPush = (head: string, commit: string) => `Nothing to push. GitHub already has ${sha(commit)} on ${code(head)}.`;

/**
 * A flagged Push in words: GitHub isn't at the commit after the push, the branch moved with no Push, or the main thread
 * stopped first; null otherwise.
 */
export function pushFlagText(run: PushRun | null | undefined): string | null {
  if (run?.state !== "flagged") return null;
  if (run.flag === "unrequested") return `${code(run.head)} has new commits on GitHub (now ${sha(run.remote ?? "")}) that didn’t come from Push. ${run.fixer ? "The fixer, a teammate or CI" : "A teammate, CI or a thread"} may have pushed them.`;
  if (run.flag === "stopped") return `${code(run.head)} wasn’t pushed: the main thread ${run.why === "failed" ? "failed" : `was ${run.why ?? "stopped"}`} before it finished.`;
  if (!run.remote) return `${code(run.head)} isn’t on GitHub, so ${sha(run.sha ?? "")} wasn’t pushed. Check the main thread.`;
  return `GitHub’s ${code(run.head)} is at ${sha(run.remote)}, not ${sha(run.sha ?? "")}. The push may have failed: check the main thread.`;
}
