// Push (notes/design/E7-plan.md Part 2 §10): the commit you reviewed goes to GitHub, and only on your say. Push, or
// "push" typed to the review agent, tells the main thread to commit what you reviewed and report the commit, `bb review
// report --commit <sha>`, without pushing. The review checks that commit before anything goes out: the folder is at
// it, and each file it commits is as you reviewed it, hidden files too, so a committed .env warns. A match tells the
// thread to push exactly that commit, `git push origin '<sha>:refs/heads/<branch>'`, never forced; a mismatch warns, and
// waits for Push anyway or Update first. When the thread stops, the review reads GitHub: a branch that isn't at the
// commit is flagged, and so is one that moved with no Push. The plugin runs no git: threads push, and reads go through
// bb's Git plugin and GitHub.
import { z } from "zod";
import { mainThreadLink } from "./loop";
import { callGit, diffFilesHead, isSecretPath } from "./env-diff";
import { fenced, header, placed } from "./fix-handoff";
import { ghErrorMessage, type runGh } from "./gh";
import { assistantReview, mergedAway } from "./draft-comments";
import type { Turn } from "./asking";
import { reviewIdentity } from "../lib/review-identity";
import { behindText, mismatchText, pushAnywayOffered, pushFlagText, NOT_PUSHED, nothingToPush, plainText, pushCommand, pushTarget, type PushTarget } from "../lib/push";
import { command } from "./post-preview";
import { inlineCode } from "./untrusted";
import type { PushRun, ReviewLifecycle, ReviewMeta, SendEntry } from "./store";
import { failed, type EventListeners, type RpcHandlers, type ServeDeps } from "./server-modules";
import { ONLY_WITH_THESE_TOOLS } from "./review-agent-tools";
import { becomeFound, readBranches } from "./pr-watch";
import { updateFeature } from "./feature-review";

type Run = typeof runGh;
type Deps = Pick<ServeDeps, "bb" | "store" | "gh" | "changed">;

const short = (sha: string) => sha.slice(0, 7);
const error = (failure: unknown) => failure instanceof Error ? failure.message : String(failure);
/** For a fork's head, which remote `<remote>` is. */
const forkRemote = (place: Place) => place.remote === "<remote>" ? `\`<remote>\` is the remote for ${place.forkOf ? `@${place.forkOf}'s fork` : "the fork the PR's branch is in"}. ` : "";
const UNSAFE = "Push can’t write a safe command for that commit. Push it from a terminal.";
const OFF = "Send to thread is off in Review settings, so Push can’t tell the main thread. Turn it on there.";

/** Where a review pushes (lib/push.ts). */
type Place = PushTarget;
const pushPlace = pushTarget;

/**
 * The branch's head commit on GitHub, null for no such branch: on your PR, the PR's head, which a fork's head is in
 * too; else the branch's.
 */
export async function githubHead(run: Run, place: Pick<Place, "repo" | "head" | "pr">): Promise<{ sha: string | null } | { error: string }> {
  const [owner, name] = place.repo.split("/");
  const query = place.pr
    ? "query($owner:String!,$repo:String!,$n:Int!){ repository(owner:$owner,name:$repo){ pullRequest(number:$n){ headRefOid } } }"
    : "query($owner:String!,$repo:String!,$ref:String!){ repository(owner:$owner,name:$repo){ ref(qualifiedName:$ref){ target{ oid } } } }";
  const r = await run(["api", "graphql", "-f", `query=${query}`, "-f", `owner=${owner}`, "-f", `repo=${name}`, ...place.pr ? ["-F", `n=${place.pr}`] : ["-f", `ref=refs/heads/${place.head}`]]);
  let data: any;
  try { data = JSON.parse(r.stdout)?.data; } catch { /* reported below */ }
  if (r.code !== 0 || !data?.repository) return { error: `Couldn’t read ${place.head} on GitHub: ${ghErrorMessage(r)}` };
  return { sha: (place.pr ? data.repository.pullRequest?.headRefOid : data.repository.ref?.target?.oid) ?? null };
}

const statusOutput = z.object({
  outcome: z.string(),
  workspace: z.object({
    workingTree: z.object({ hasUncommittedChanges: z.boolean(), fileCount: z.number() }),
    checkout: z.object({ kind: z.string(), headSha: z.string().nullable().optional() }),
    mergeBase: z.object({ aheadCount: z.number(), behindCount: z.number().optional(), commits: z.array(z.object({ sha: z.string() })) }).nullable().optional(),
  }).optional(),
});
const filesOutput = z.object({
  outcome: z.string(),
  files: z.array(z.object({ path: z.string(), revision: z.string(), changeKind: z.string().optional() })).optional(),
  truncated: z.boolean().optional(),
});
/** The most commits the check reads one by one for secrets; past it, it can't say. */
const MAX_COMMITS = 50;

/**
 * The folder's head commit, and whether it has changes not committed; with `base`, the branch's commits since it, in
 * bb's order, and how many there are. Null when bb can't say.
 */
async function folderHead(deps: Deps, environmentId: string, base?: string): Promise<{ sha: string | null; dirty: boolean; commits?: { shas: string[]; count: number } } | null> {
  const read = await callGit(deps.bb, "workspaceStatus", { environmentId, ...base ? { mergeBaseBranch: base } : {} }, statusOutput).catch(() => null);
  if (read?.outcome !== "available" || !read.workspace) return null;
  const { workingTree, checkout, mergeBase } = read.workspace;
  return {
    sha: checkout.headSha ?? null, dirty: workingTree.hasUncommittedChanges || workingTree.fileCount > 0,
    ...mergeBase ? { commits: { shas: mergeBase.commits.map((commit) => commit.sha), count: mergeBase.aheadCount } } : {},
  };
}

/**
 * Whether GitHub's head of the branch, `remote`, has commits the folder doesn't ("ahead"), so a push without force would
 * be refused, one it hasn't fetched included; or the folder couldn't be read to say ("unread"); false for neither, or an
 * unknown head.
 */
async function behindGithub(deps: Deps, environmentId: string, remote: string | null | undefined): Promise<"ahead" | "unread" | false> {
  if (!remote) return false;
  const read = await callGit(deps.bb, "workspaceStatus", { environmentId, mergeBaseBranch: remote }, statusOutput).catch(() => null);
  if (read?.outcome !== "available" || !read.workspace) return "unread";
  return read.workspace.mergeBase?.behindCount === 0 ? false : "ahead";
}

/** What Push says before it goes on, GitHub ahead of the folder or the folder unread, on `machine`. */
const behindWarning = (behind: "ahead" | "unread", place: Place, machine: string) =>
  behind === "ahead" ? behindText(place.head) : `Couldn’t read the folder on ${machine}. Try again, or Push anyway.`;
/** The machine the folder Push reads is on, as the review names it. */
const machineOf = (review: ReviewMeta, place: Place) => review.feature?.environmentId === place.environmentId ? review.feature.machine : "its machine";

type Github = { repo: string; head: string; sha: string | null };

/**
 * GitHub's head, read, against the last head you accepted (`remoteHead`), whatever stands with Push: the same; one to
 * accept, the first read, which is where watching starts (unless `first` is "skip"), or a move a Let it push Send
 * covers; or a move nothing explains, to flag. Besides these, only Push landing on exactly its checked commit, and Got
 * it on a flag, move what's accepted. A branch gone from GitHub pushed nothing. `write` is what the read changes,
 * whatever it finds.
 *
 * A Let it push Send covers moves from its time on. Once it's ready, the next read still counts, as the thread may
 * report and then push in the same turn, and then its cover is closed, for good. Its thread failing, or being archived
 * or deleted, closes it at once (readAfter does so on the event itself). An idle thread may be waiting on its
 * subagents, so its Send stays open. A covered move keeps the accepted head's time, so the Send covers the thread's next
 * push too. A read that finds no change while no cover is open stamps the time again.
 */
function judge(now: ReviewMeta, github: Github, first: "accept" | "skip" = "accept"): { verdict: "same" | "accept" | "flag"; write: ReviewLifecycle } {
  const was = now.remoteHead?.repo === github.repo && now.remoteHead.head === github.head ? now.remoteHead : null;
  const sends = now.sends ?? [];
  const gone = (send: SendEntry) => !!send.stopped && send.stopped.why !== "idle";
  const open = sends.filter((send) => send.letPush && !send.coverClosed && !gone(send) && (!was || send.at > was.at));
  const closing = sends.filter((send) => send.letPush && !send.coverClosed && (gone(send) || open.includes(send) && send.readyAt !== undefined));
  const write: ReviewLifecycle = closing.length ? { sends: sends.map((send) => closing.includes(send) ? { ...send, coverClosed: true as const } : send) } : {};
  if (!was) return { verdict: "same", write: { ...write, ...first === "accept" ? accepted(github) : {} } };
  if (github.sha === null || was.sha === github.sha) return { verdict: "same", write: { ...write, ...!open.length && github.sha !== null ? accepted(github) : {} } };
  if (open.length) return { verdict: "accept", write: { ...write, remoteHead: { ...github, at: was.at } } };
  return { verdict: "flag", write };
}
const accepted = (github: Github) => ({ remoteHead: { ...github, at: Date.now() } });
/** A move on GitHub that didn't come from Push: said plainly, naming a fixer on your PR among who may have made it. */
const moved = (place: Place, sha: string | null, threadId: string): PushRun => ({ state: "flagged", flag: "unrequested", at: Date.now(), threadId, repo: place.repo, head: place.head, remote: sha, ...place.fixer ? { fixer: true as const } : {} });

/**
 * What the check found: the commit as you reviewed it, by its full SHA; or how it isn't, the files that differ, and the
 * secret-looking ones you never saw that it would push, with its full SHA when the folder is at it.
 */
type Checked = { ok: true; sha: string } | { ok: false; warning: string; files: string[]; secrets?: string[]; sha?: string };

/** Files a commit list names. */
const listed = (read: z.infer<typeof filesOutput>) => read.outcome === "available" && read.files && !read.truncated ? read.files : null;

/**
 * Check the commit `sha` the main thread reported against what the review shows: the folder is at it; each file its
 * branch commits, against the review's merge base, is at the revision the review read, with no secret it hid; and no
 * commit on the way there, since `onGithub`, GitHub's head, has a secret-looking file the review doesn't show, which the
 * push would take to GitHub even if a later commit removes it. A read that fails can't say, so it warns too.
 */
async function checkCommit(deps: Deps, review: ReviewMeta, place: Place, sha: string, onGithub?: string | null): Promise<Checked> {
  const { bb, store } = deps;
  const cannot = (why: string, full?: string): Checked => ({ ok: false, warning: `Couldn’t check \`${short(sha)}\` against what you reviewed: ${why}`, files: [], ...full ? { sha: full } : {} });
  // What you reviewed: the folder's diff the review shows; on your PR, what Not pushed yet showed you, from this folder.
  const seen = review.notPushedSeen;
  const reviewed = place.pr ? seen?.environmentId === place.environmentId ? { base: seen.base, files: NOT_PUSHED } : null
    : review.feature?.mergeBaseRef ? { base: review.feature.mergeBaseRef, files: "" } : null;
  const kept = reviewed && await store.exclusive(async (tx) => tx.getSnapshotFiles(review.targetKey, reviewed.files || diffFilesHead(await tx.patchHash(review.targetKey))));
  if (!reviewed || !kept) return cannot(place.pr ? "you haven’t opened Not pushed yet for this folder, so nothing in it was reviewed. Open it first." : "the review has no record of the files it shows. Update first.");
  const head = await folderHead(deps, place.environmentId, reviewed.base);
  if (!head?.sha) return cannot("BB couldn’t read the folder’s head commit.");
  // Only a full SHA goes in the command the thread runs.
  if (!pushCommand(head.sha, place.head, place.remote)) return { ok: false, warning: UNSAFE, files: [] };
  if (!head.sha.toLowerCase().startsWith(sha.toLowerCase())) return { ok: false, warning: `The folder is at \`${short(head.sha)}\`, not \`${short(sha)}\`, the commit reported.`, files: [] };
  const read = (target: Record<string, string>) => callGit(bb, "files", { environmentId: place.environmentId, target, ignoreWhitespace: false }, filesOutput);
  const included = new Set(review.includeHidden ?? []);
  let committed: Record<string, string>;
  const earlier = new Set<string>();
  try {
    const files = listed(await read({ type: "branch_committed", mergeBaseBranch: reviewed.base }));
    if (!files) return cannot("BB couldn’t list the commit’s files whole.", head.sha);
    committed = Object.fromEntries(files.map((file) => [file.path, file.revision]));
    const commits = head.commits;
    if (!commits) return cannot("BB couldn’t list the branch’s commits to check each for secrets.", head.sha);
    // Oldest first, whichever way bb lists them: the folder's head is the newest.
    const shas = commits.shas.length > 1 && commits.shas[0] === head.sha ? [...commits.shas].reverse() : commits.shas;
    if (shas.length && shas.at(-1) !== head.sha) return cannot("BB listed the branch’s commits in an order it can’t read.", head.sha);
    // Those GitHub has already went out before.
    const pushed = onGithub ? shas.indexOf(onGithub) : -1;
    const fresh = shas.slice(pushed + 1);
    if (pushed < 0 && shas.length !== commits.count || fresh.length > MAX_COMMITS) return cannot(`BB couldn’t list the branch’s ${pushed < 0 ? commits.count : fresh.length} commits to check each for secrets.`, head.sha);
    for (const commit of fresh) {
      const each = listed(await read({ type: "commit", sha: commit }));
      if (!each) return cannot(`BB couldn’t list the files of commit \`${short(commit)}\`.`, head.sha);
      for (const file of each) if (file.changeKind !== "deleted" && isSecretPath(file.path) && !included.has(file.path) && !(file.path in committed)) earlier.add(file.path);
    }
  } catch (failure) {
    return cannot(error(failure), head.sha);
  }
  // Secrets the review hid, as a .env: you never saw them, so committed they differ. A large or binary file it hid is
  // compared by its revision, as any other.
  const hid = new Set(kept.hidden.filter((file) => file.reason === "secret" && !included.has(file.path)).map((file) => file.path));
  const paths = [...new Set([...Object.keys(kept.revisions), ...Object.keys(committed)])].sort();
  const files = paths.filter((path) => hid.has(path) ? path in committed : committed[path] !== kept.revisions[path]);
  if (!files.length && !earlier.size) return { ok: true, sha: head.sha };
  const secrets = [...files.filter((path) => hid.has(path)), ...[...earlier].sort()];
  return { ok: false, files, ...secrets.length ? { secrets } : {}, sha: head.sha, warning: mismatchText(files, secrets, earlier.size > 0) };
}

/** What the main thread is told to push, exactly: one commit, to the branch, never forced; null when that can't be written safely. */
function pushText(place: Place, sha: string): string | null {
  const command = pushCommand(sha, place.head, place.remote);
  return command && [`Push \`${short(sha)}\` to ${inlineCode(place.head)} on GitHub, exactly this commit:`, fenced(command, "sh"), `${forkRemote(place)}Don’t force-push unless I say so.`].join("\n\n");
}

/** Save the review's Push as `run`; null clears it. */
async function savePush(deps: Deps, key: string, run: PushRun | null) {
  await deps.store.setLifecycle(key, { push: run });
  deps.changed(key);
}

/**
 * In one block: when `from` says the review's Push is as expected, make it `to`, and return it as it was; else return
 * why not. A Push already waiting on the thread, or one you cancelled meanwhile, isn't overwritten.
 */
async function swapPush(deps: Deps, key: string, from: (run: PushRun | null) => string | null, to: PushRun | null): Promise<{ was: PushRun | null } | { error: string }> {
  const swapped = await deps.store.exclusive(async (tx) => {
    const run = (await tx.getReview(key))?.push ?? null;
    const why = from(run);
    if (why) return { error: why };
    await tx.setLifecycle(key, { push: to });
    return { was: run };
  });
  if ("was" in swapped) deps.changed(key);
  return swapped;
}

/** Send `text` to the main thread, after its turn if it's busy, under the review's header. */
async function tell(deps: Deps, review: ReviewMeta, threadId: string, text: string): Promise<"sent" | "queued"> {
  const shown = await placed(deps.bb, deps.store, review);
  const sent = await deps.bb.sdk.threads.send({ threadId, mode: "queue-if-active", input: [{ type: "text", text: `${header(shown)}\n\n${text}`, mentions: [] }] });
  return sent?.delivery === "queued" ? "queued" : "sent";
}

/**
 * What Push answers: what it asked the thread, to commit, to push, or to push anyway; or `note`, nothing was asked; or
 * `warning`, it waits for your choice; or an error.
 */
type Started = { ok: boolean; error?: string; warning?: string; note?: string; delivery?: "sent" | "queued"; asked?: "commit" | "push" | "anyway"; at?: number };

const BUSY = (run: PushRun | null) => run?.state === "committing" || run?.state === "pushing" ? `Push is waiting on the main thread already, to ${run.state === "committing" ? "commit" : "push"}. ${run.state === "committing" ? "Cancel" : "Stop waiting"} in Finish review, then Push again.` : null;

/**
 * Push: tell the main thread to commit what you reviewed and report the commit; or, the folder having nothing to
 * commit, check its head now. GitHub already at the commit has nothing to push; GitHub with commits the folder doesn't
 * warns first. With `force`, Push anyway, on the warning shown (`sha`, when the page shows one): the checked commit goes
 * as it is, if the folder is still at it; or, past GitHub being ahead, Push goes on without asking that again.
 */
export async function startPush(deps: Deps, targetKey: string, { force = false, sha, at }: { force?: boolean; sha?: string; at?: number } = {}): Promise<Started> {
  const { store, gh } = deps;
  if (!(await store.getPreferences()).preferences.knobs.sendToThread) return { ok: false, error: OFF };
  const review = await store.getReview(targetKey);
  const place = pushPlace(review);
  if (typeof place === "string") return { ok: false, error: place };
  const failedTo = (failure: unknown, was: PushRun | null) => savePush(deps, targetKey, was).then(() => ({ ok: false, error: `Couldn’t tell the main thread: ${error(failure)}` }));
  let pastBehind = false;
  if (force) {
    const run = review!.push;
    if (!pushAnywayOffered(run)) return { ok: false, error: "No commit is waiting on Push anyway. Push to start again." };
    // The warning shown, not one that came since.
    if (sha !== undefined && sha !== run.sha || at !== undefined && at !== run.at) return { ok: false, error: "Push changed meanwhile. Look again, then choose." };
    if (run.sha) {
      const text = pushText(place, run.sha);
      if (!text) return { ok: false, error: UNSAFE };
      // The folder may have moved on since the check.
      const head = await folderHead(deps, place.environmentId);
      if (head?.sha !== run.sha) return { ok: false, error: `The folder isn’t at ${short(run.sha)} any more${head?.sha ? `: it’s at ${short(head.sha)}` : ""}. Push to check it again.` };
      const swapped = await swapPush(deps, targetKey, (now) => now?.state === "mismatch" && now.at === run.at ? null : "Push changed meanwhile. Look again, then choose.", { ...run, state: "pushing", at: Date.now(), warning: undefined, files: undefined, secrets: undefined, behind: undefined });
      if ("error" in swapped) return { ok: false, error: swapped.error };
      try {
        return { ok: true, delivery: await tell(deps, review!, run.threadId, text), asked: "anyway" };
      } catch (failure) {
        return failedTo(failure, swapped.was);
      }
    }
    // GitHub was ahead, before any commit: go on, and don't ask that again.
    pastBehind = true;
  }
  const main = await mainThreadLink(deps, targetKey).catch(() => null);
  if (!main) return { ok: false, error: "This review has no main thread to commit and push. Choose one in Main thread." };
  if (main.state !== "open") return { ok: false, error: `${main.title ?? "The main thread"} is ${main.state === "archived" ? "archived. Unarchive it" : "deleted. Start a fresh thread from Main thread"}, then Push.` };
  const run: PushRun = { state: "committing", at: Date.now(), threadId: main.threadId, repo: place.repo, head: place.head, ...pastBehind ? { pastBehind: true as const } : {} };
  const claimed = await swapPush(deps, targetKey, BUSY, run);
  if ("error" in claimed) return { ok: false, error: claimed.error };
  const [head, remote] = await Promise.all([folderHead(deps, place.environmentId), githubHead(gh.runGh, place)]);
  const github = "sha" in remote ? { repo: place.repo, head: place.head, sha: remote.sha } : undefined;
  // A move on GitHub nothing explains is said before anything is asked: Got it accepts it, then Push.
  const seen = github && await store.exclusive(async (tx) => {
    const now = await tx.getReview(targetKey);
    if (!now) return "same";
    const { verdict, write } = judge(now, github);
    await tx.setLifecycle(targetKey, { ...write, ...verdict === "flag" && now.push?.state === "committing" && now.push.at === run.at ? { push: moved(place, github.sha, main.threadId) } : {} });
    return verdict;
  });
  if (seen === "flag") {
    deps.changed(targetKey);
    return { ok: false, error: `Not pushed: ${plainText(pushFlagText(moved(place, github!.sha, main.threadId))!).replace(/`/g, "")} Got it accepts them; then Push.` };
  }
  // Unless you cancelled meanwhile.
  const ours = (now: PushRun | null) => now?.state === "committing" && now.at === run.at ? null : "Push was cancelled.";
  try {
    // Nothing to commit, and GitHub has the folder's head.
    if (head?.sha && !head.dirty && github?.sha === head.sha) {
      await savePush(deps, targetKey, null);
      return { ok: true, note: nothingToPush(place.head, head.sha) };
    }
    // GitHub has commits the folder doesn't: said before the thread is told anything.
    const behind = pastBehind ? false : await behindGithub(deps, place.environmentId, github?.sha);
    if (behind) {
      const warning = behindWarning(behind, place, machineOf(review!, place));
      const swapped = await swapPush(deps, targetKey, ours, { ...run, state: "mismatch", behind: true, warning });
      return "error" in swapped ? { ok: false, error: swapped.error } : { ok: true, warning: plainText(warning), at: run.at };
    }
    // Nothing to commit: the folder's head is the commit.
    if (head?.sha && !head.dirty) {
      const checked = await checkCommit(deps, review!, place, head.sha, github?.sha);
      if (!checked.ok) {
        const swapped = await swapPush(deps, targetKey, ours, { ...run, state: "mismatch", ...checked.sha ? { sha: checked.sha } : {}, warning: checked.warning, files: checked.files, ...checked.secrets ? { secrets: checked.secrets } : {} });
        return "error" in swapped ? { ok: false, error: swapped.error } : { ok: true, warning: plainText(checked.warning), at: run.at };
      }
      const text = pushText(place, checked.sha);
      if (!text) { await savePush(deps, targetKey, claimed.was); return { ok: false, error: UNSAFE }; }
      const swapped = await swapPush(deps, targetKey, ours, { ...run, state: "pushing", sha: checked.sha });
      if ("error" in swapped) return { ok: false, error: swapped.error };
      return { ok: true, delivery: await tell(deps, review!, main.threadId, text), asked: "push" };
    }
    const delivery = await tell(deps, review!, main.threadId, [
      "Commit the changes I reviewed, all of them, in this folder. Then run `bb review report --commit <sha>` with the commit’s SHA.",
      "Don’t push: the review checks the commit against what I reviewed first, then says how to push it.",
    ].join("\n\n"));
    return { ok: true, delivery, asked: "commit" };
  } catch (failure) {
    return failedTo(failure, claimed.was);
  }
}

/**
 * `bb review report --commit <sha>` with no comment: the commit Push asked for, from the main thread, or a thread under
 * it (`mine`, the caller and the threads above it). It's checked now, and the answer tells the thread what to do: push
 * exactly it, or wait for the reviewer.
 */
export async function reportCommit(deps: Deps, sha: string, mine: ReadonlySet<string>): Promise<{ exitCode: number; stdout?: string; stderr?: string }> {
  const { store, gh } = deps;
  const waiting = (await store.listReviews()).filter((review) => review.push?.state === "committing" && mine.has(review.push.threadId));
  if (!waiting.length) return { exitCode: 1, stderr: "No Push is waiting on a commit from this thread. Report a comment with its id: bb review report <id> done|declined." };
  if (waiting.length > 1) return { exitCode: 2, stderr: `Push waits on a commit from this thread for ${waiting.length} reviews: ${waiting.map((review) => reviewIdentity(review).id).join(", ")}. Push them one at a time.` };
  const review = waiting[0]!;
  const key = review.targetKey;
  const id = reviewIdentity(await placed(deps.bb, store, review)).id;
  const place = pushPlace(review);
  if (typeof place === "string") return { exitCode: 1, stderr: place };
  const run = review.push!;
  const remote = await githubHead(gh.runGh, place);
  const github = "sha" in remote ? { repo: place.repo, head: place.head, sha: remote.sha } : undefined;
  const checked = await checkCommit(deps, review, place, sha, github?.sha);
  const nothing = checked.ok && github?.sha === checked.sha;
  // GitHub has commits the folder doesn't: unless you chose Push anyway past that already.
  const behind = !nothing && !run.pastBehind ? await behindGithub(deps, place.environmentId, github?.sha) : false;
  const warning = [...behind ? [behindWarning(behind, place, machineOf(review, place))] : [], ...checked.ok ? [] : [checked.warning]].join(" ");
  // A commit the check couldn't place keeps no SHA: nothing pushes it.
  const next: PushRun = !checked.ok || behind ? {
    ...run, state: "mismatch", at: Date.now(), ...checked.sha ? { sha: checked.sha } : {}, warning, files: checked.ok ? [] : checked.files,
    ...!checked.ok && checked.secrets ? { secrets: checked.secrets } : {}, ...behind ? { behind: true as const } : {},
  } : { ...run, state: nothing ? "pushed" : "pushing", at: Date.now(), sha: checked.sha };
  // Unless the reviewer cancelled meanwhile, or the branch moved on GitHub with no Push, as when the thread pushed before
  // it reported: that's flagged, whatever the check found. The report never starts watching: with nothing accepted yet,
  // GitHub at the very commit reported means the thread pushed it first.
  const saved = await store.exclusive(async (tx) => {
    const review = await tx.getReview(key);
    const now = review?.push ?? null;
    if (now?.state !== "committing" || now.at !== run.at) return now;
    const baseline = review!.remoteHead?.repo === place.repo && review!.remoteHead.head === place.head;
    const pushedFirst = !baseline && !!github?.sha && (github.sha.startsWith(sha) || checked.ok && github.sha === checked.sha);
    const { verdict, write } = github ? judge(review!, github, "skip") : { verdict: "same" as const, write: {} };
    if (verdict === "flag" || pushedFirst) {
      await tx.setLifecycle(key, { ...write, push: moved(place, github!.sha, run.threadId) });
      return "moved" as const;
    }
    await tx.setLifecycle(key, { ...write, push: next });
    return true;
  });
  if (saved === "moved") deps.changed(key);
  if (saved !== true) return { exitCode: 1, stderr: `Push on ${id} stopped: ${saved === "moved" || saved?.state === "flagged" ? "its branch has commits on GitHub that didn’t come from Push" : "the reviewer cancelled it"}. Don’t push; the reviewer decides.` };
  deps.changed(key);
  if (!checked.ok || next.state === "mismatch") return { exitCode: 0, stdout: `Recorded ${short(sha)} for ${id}, but ${checked.ok ? "it can’t go yet" : "it isn’t what the reviewer reviewed"}: ${plainText(warning)} Don’t push: the reviewer chooses Push anyway or Update first in the review, and you’ll be told.` };
  if (next.state === "pushed") return { exitCode: 0, stdout: nothingToPush(place.head, checked.sha) };
  return { exitCode: 0, stdout: `Checked ${short(checked.sha)} for ${id}: it’s what the reviewer reviewed. Push it now, exactly this commit:\n  ${pushCommand(checked.sha, place.head, place.remote)}\n${forkRemote(place)}Don’t force-push unless the reviewer says so.` };
}

/**
 * When a review's main thread stops, read its branch on GitHub. A Push landing on exactly its checked commit is pushed,
 * and accepted; a Push that didn't land is flagged, with what's there instead, but not while the thread has messages
 * queued, as the push may be one of them. Any other move nothing explains (judge) is flagged plainly, whatever stands
 * with Push, a flag you haven't dismissed staying as it is. A main thread that failed, or was archived or deleted
 * (`why`), while Push waited on its commit, stopped it. With Send to thread off, there's no Push, and nothing is read.
 */
async function readAfter(deps: Deps & Pick<ServeDeps, "sync">, thread: { id: string; queued: boolean }, why?: NonNullable<PushRun["why"]>) {
  const { store, gh } = deps;
  if (!(await store.getPreferences()).preferences.knobs.sendToThread) return;
  const reviews = (await store.listReviews()).filter((review) => !review.archivedAt && !review.userArchivedAt
    && (review.push?.threadId === thread.id || (review.mainThread?.threadId ?? review.sourceThreadId) === thread.id));
  for (const review of reviews) {
    const place = pushPlace(review);
    if (typeof place === "string") continue;
    // A local review's read finds the branch's PR too, in the same request (src/pr-watch.ts).
    const branch = place.pr ? null : (await readBranches(gh.runGh, [{ repo: place.repo, branch: place.head }]))[0]!;
    const read = branch ?? await githubHead(gh.runGh, place);
    const github = "sha" in read ? { repo: place.repo, head: place.head, sha: read.sha } : null;
    const landed = await store.exclusive(async (tx) => {
      const stored = await tx.getReview(review.targetKey);
      if (!stored) return false;
      // A thread that failed, or was archived or deleted, closes its Sends' cover now, on this event, before anything is
      // judged, and whether or not GitHub could be read.
      const closing = why ? (stored.sends ?? []).filter((send) => send.threadId === thread.id && send.letPush && !send.coverClosed) : [];
      const now = closing.length ? { ...stored, sends: stored.sends!.map((send) => closing.includes(send) ? { ...send, coverClosed: true as const } : send) } : stored;
      const run = now.push ?? null;
      const judgedRead = github ? judge(now, github) : { verdict: "same" as const, write: {} as ReviewLifecycle };
      const judged = judgedRead.verdict;
      const write: ReviewLifecycle = closing.length ? { sends: now.sends, ...judgedRead.write } : judgedRead.write;
      const stopped = !!why && run?.state === "committing" && run.threadId === thread.id;
      let next: PushRun | null | undefined;
      let accept = false;
      // A commit reported by a short SHA is GitHub's full one that starts with it.
      if (github?.sha && run?.sha && (run.state === "pushing" || run.state === "flagged" && run.flag === "differs") && github.sha.startsWith(run.sha)) {
        next = { ...run, state: "pushed", at: Date.now(), sha: github.sha, flag: undefined, remote: undefined };
        accept = true;
      } else if (github && run?.sha && run.state === "pushing") {
        next = thread.queued ? undefined : { ...run, state: "flagged", flag: "differs", remote: github.sha, at: Date.now() };
      } else if (judged === "flag") next = run?.state === "flagged" ? undefined : moved(place, github!.sha, thread.id);
      else if (stopped) next = { ...run!, state: "flagged", flag: "stopped", why, at: Date.now() };
      await tx.setLifecycle(review.targetKey, { ...write, ...accept && github ? accepted(github) : {}, ...next !== undefined ? { push: next } : {} });
      if (next !== undefined) deps.changed(review.targetKey);
      return accept;
    });
    // A PR's review pushed from its folder at exactly the commit Push checked: it shows the PR there, without the guide writer.
    if (landed && review.kind === "pr" && review.feature) await updateFeature(deps, review.targetKey).catch(() => {});
    // Its PR, once there is one: the review becomes its review, the Push it shows going on.
    if (branch) await becomeFound(deps, review.targetKey, branch);
  }
}

/** What "push" to the review agent must be, the whole message: a short command, as justPost's (src/post-preview.ts). */
const PUSH = ["push", "push it", "just push it"];
const PUSH_ANYWAY = ["push anyway", "push it anyway", "just push it anyway", "push it as it is"];

export function register(deps: ServeDeps) {
  const { bb, store, changed, classify } = deps;
  const handlers = {
    async push({ targetKey, force, sha, at }) {
      // Push anyway from the page goes on the warning it shows, by when it came.
      if (force && at === undefined) return { ok: false, error: "Push anyway needs the warning it answers. Reload, then choose." };
      const { asked: _asked, at: _at, ...started } = await startPush(deps, targetKey, { force, sha, at });
      return started;
    },
    async dismissPush({ targetKey }) {
      const found = await store.exclusive(async (tx) => {
        const review = await tx.getReview(targetKey);
        if (!review) return false;
        // Got it on a flag accepts what GitHub has, so it's flagged once.
        const run = review.push;
        await tx.setLifecycle(targetKey, { push: null, ...run?.state === "flagged" && run.remote !== undefined ? accepted({ repo: run.repo, head: run.head, sha: run.remote }) : {} });
        return true;
      });
      if (!found) return { ok: false, error: "This review no longer exists." };
      changed(targetKey);
      return { ok: true };
    },
  } satisfies Partial<RpcHandlers>;

  // The plugin's own agents are hidden, and never push.
  const stopped = (why: NonNullable<PushRun["why"]>) => ({ thread }: { thread: { id: string; visibility?: string } }) => thread.visibility === "hidden" ? undefined : readAfter(deps, { id: thread.id, queued: false }, why);
  const events: EventListeners = {
    "thread.idle": [({ thread }) => thread.visibility === "hidden" ? undefined : readAfter(deps, { id: thread.id, queued: (thread.queuedMessageCount ?? 0) > 0 })],
    "thread.failed": [stopped("failed")],
    "thread.archived": [stopped("archived")],
    "thread.deleted": [stopped("deleted")],
  };

  bb.agents.registerTool({
    name: "push",
    description: "Push this review's branch to GitHub when the reviewer says push: the main thread commits what they reviewed, the review checks the commit, then the main thread pushes exactly that commit. Never a force-push.",
    instructions: `Only when the reviewer's message in this review is just "push" or "push it", call push and tell them it's under way: the main thread commits, and Push in Finish review shows the check and the push. If it warns, tell them the warning in a line, with its at; call push with force: true and that at only once their message is just "push anyway". In any other turn it pushes nothing. ${ONLY_WITH_THESE_TOOLS}`,
    parameters: z.object({
      force: z.boolean().optional().describe("Push anyway, past the warning the last Push gave, once the reviewer's message is just \"push anyway\"."),
      at: z.number().optional().describe("With force: the at of the warning you told the reviewer, as push gave it."),
    }),
    execute: async ({ force, at }, { threadId }) => {
      const targetKey = await store.exclusive((tx) => assistantReview(tx, threadId));
      if (!targetKey) return failed("This conversation is no longer a review's assistant, so it has nothing to push.");
      const away = await mergedAway(store, targetKey);
      if (away) return failed(away);
      if (!(await store.getPreferences()).preferences.knobs.reviewAgentActs) return failed("Settings has the review agent only draft now, so nothing was pushed. The reviewer can use Push in Finish review.");
      // Pushes happen when the reviewer says so, in the review: never on a relay, nor in a turn the plugin started.
      const turn = await classify(threadId).catch((): Turn => ({ asking: "unattended", message: null }));
      // And in their own words, a short command for exactly it, so text in what's reviewed, or quoted from it, can't ask.
      const order = turn.asking === "direct" && !turn.joined && turn.message && !turn.message.inserted ? command(turn.message.text) : null;
      if (order === null || !(force ? PUSH_ANYWAY : [...PUSH, ...PUSH_ANYWAY]).includes(order)) {
        return failed(`Not pushed: only the reviewer starts ${force ? "Push anyway" : "a push"}, with a message in this review that's just "${force ? "push anyway" : "push"}". Suggest it in your reply; they can use Push in Finish review.`);
      }
      // Push anyway goes on the warning the reviewer was told, and their "push anyway" came after it: without its at, the
      // agent is told the warning now, to tell them.
      if (force) {
        const run = (await store.getReview(targetKey))?.push;
        if (!pushAnywayOffered(run)) return failed("Not pushed: No commit is waiting on Push anyway. Push to start again.");
        const ask = `Tell the reviewer; only if they then say "push anyway", call push with force: true and at: ${run.at}.`;
        if (at === undefined) return failed(`Not pushed yet. The warning now: ${plainText(run.warning ?? "the commit isn't what the reviewer reviewed.")} (at: ${run.at}). ${ask}`);
        if (at === run.at && !(turn.message!.at > run.at)) return failed(`Not pushed: the reviewer's "push anyway" came before this warning. ${ask}`);
      }
      const started = await startPush(deps, targetKey, { force, ...at === undefined ? {} : { at } });
      if (!started.ok) return failed(`Not pushed: ${started.error}`);
      if (started.asked) {
        const text = { commit: "Asked the main thread to commit, for Push", push: "Asked the main thread to push", anyway: "Asked the main thread to push anyway" }[started.asked];
        await store.exclusive(async (tx) => {
          const now = await tx.getReview(targetKey);
          if (now) await tx.setLifecycle(targetKey, { activity: [...now.activity ?? [], { at: Date.now(), text, asking: turn.asking }] });
        });
        changed(targetKey);
      }
      const told = started.note ?? started.warning ?? {
        commit: "The main thread was told to commit what the reviewer reviewed; the review checks the commit before it's pushed.",
        push: "The commit is what the reviewer reviewed, and the main thread was told to push exactly it.",
        anyway: "The main thread was told to push the commit as it is.",
      }[started.asked ?? "commit"];
      return { content: [{ type: "text", text: `${told}${started.warning && started.at !== undefined ? ` (at: ${started.at})` : ""} Tell the reviewer; Push in Finish review shows where it stands.` }] };
    },
  });
  return { handlers, events };
}
