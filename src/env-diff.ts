// A local review's diff, read from its folder on whichever machine it's on through bb's Git plugin (`bb git files`,
// `bb git patch`): committed, uncommitted and untracked changes against the folder's real base, which is, in order:
// 1. the base of the branch's PR, when it has one, as GitHub diffs it;
// 2. else the folder's merge base in bb (`mergeBaseBranch`), which bb sets to what a worktree was made from;
// 3. else the branch it was made from (`baseBranch`; nothing reports a branch's upstream);
// 4. else its default branch.
// Secret-looking untracked files, binaries and huge diffs stay out of the patch, so out of the store and away from
// agents, until the reviewer includes them. Tracked (committed or staged) secret-looking files show, flagged.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { ensureGitHeaders } from "./patch";
import { machineStatus } from "./machines";
import type { FeatureReview } from "./store";
import { isSecretPath, symlinkTarget, type HiddenFile } from "../lib/folder-files";

export const GIT_PLUGIN = "bb--git";
type Environment = Awaited<ReturnType<BbPluginApi["sdk"]["environments"]["get"]>>;

export { flaggedFileNotice, hiddenFileNotice, isSecretPath, type HiddenFile } from "../lib/folder-files";

export type FeatureDiff =
  | {
    outcome: "available";
    /** Every shown file's diff, with git headers. */
    patch: string;
    /** Each changed file's revision, hidden ones too, by path, as bb gave it: an edit to the file changes it. */
    revisions: Record<string, string>;
    hidden: HiddenFile[];
    /** Committed files that look like secrets: shown, and worth a warning. */
    flagged: string[];
    /** What the diff is against, as the folder names it (a branch, or a commit), and where the branch left it. */
    base: string;
    mergeBaseRef: string;
    /** Why the diff is incomplete, for the review to say; null when it's whole. */
    notice: string | null;
    /** The branch's PR, as bb's GitHub PR status plugin said; absent for none, or when it couldn't say. */
    pr?: FolderPr;
  }
  | FolderUnread;

/**
 * Why a folder wasn't read. offline: its machine isn't connected. gone: bb removed it. paused: it's on another branch
 * than the review's, `branch` (null for none). unavailable: anything else.
 */
export type FolderUnread = { outcome: "offline" | "gone" | "unavailable"; message: string } | { outcome: "paused"; branch: string | null; message: string };

/** A folder's branch's PR, as bb's GitHub PR status plugin says it. */
export type FolderPr = z.infer<typeof folderPr>;

/**
 * Where a local review keeps the revisions and hidden files of its diff (saveSnapshotFiles): by the stored patch's hash,
 * so another patch never reads them. None kept means they're unknown.
 */
export const diffFilesHead = (patchHash: string) => `diff:${patchHash}`;

/** bb gives each file's diff up to 512 KB; past this much in all, the rest stay out, as a local diff stops at 64 MB. */
const MAX_PATCH_BYTES = 64 * 1024 * 1024;
/** Keys the Git plugin takes in one patches call. */
const PATCH_BATCH = 50;

const failure = z.object({ outcome: z.literal("unavailable"), failure: z.object({ code: z.string(), message: z.string() }) });
const notGit = z.object({ outcome: z.literal("not_applicable"), message: z.string() });
const filePatch = z.object({ path: z.string(), patch: z.string(), truncated: z.boolean() });
const filesOutput = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("available"),
    files: z.array(z.object({
      path: z.string(), previousPath: z.string().nullable(), changeKind: z.string(), binary: z.boolean(),
      origin: z.enum(["tracked", "untracked"]), loadMode: z.enum(["auto", "on_demand", "too_large"]), revision: z.string(),
    })),
    truncated: z.boolean(),
    mergeBaseRef: z.string().nullable(),
    initialPatches: z.array(filePatch),
  }),
  notGit, failure,
]);
const patchesOutput = z.record(z.string(), z.discriminatedUnion("outcome", [z.object({ outcome: z.literal("available"), patch: filePatch }), notGit, failure]));
const folderPr = z.object({ baseRefName: z.string(), number: z.number().int().optional(), url: z.string().optional(), headRefName: z.string().optional(), state: z.string().optional() });
const pullRequestsOutput = z.record(z.string(), z.object({ outcome: z.string(), pullRequest: folderPr.optional() }));
type ChangedFile = Extract<z.infer<typeof filesOutput>, { outcome: "available" }>["files"][number];

/** Call one of bb's Git plugin's RPC methods. */
export function callGit<T>(bb: BbPluginApi, method: string, input: Parameters<BbPluginApi["sdk"]["plugins"]["callRpc"]>[0]["input"], outputSchema: z.ZodType<T>): Promise<T> {
  return bb.sdk.plugins.callRpc({ pluginId: GIT_PLUGIN, method, input, outputSchema });
}

const statusOutput = z.object({ outcome: z.string(), workspace: z.object({ mergeBase: z.object({ behindCount: z.number().optional() }).nullable().optional() }).optional() });

/** Whether the folder has commit `sha`: nothing in it is missing from the folder's head. False when bb can't say. */
export async function folderHas(bb: BbPluginApi, environmentId: string, sha: string): Promise<boolean> {
  const read = await callGit(bb, "workspaceStatus", { environmentId, mergeBaseBranch: sha }, statusOutput).catch(() => null);
  return read?.outcome === "available" && read.workspace?.mergeBase?.behindCount === 0;
}

/** BB answered that the thing asked for doesn’t exist: not that it couldn’t say. */
export const isNotFound = (error: unknown) => (error as { status?: number } | null)?.status === 404 || String(error).includes("HTTP 404");
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * What a folder's diff is against, in the order above, or why that's unknown, and the branch's PR when it has one. A
 * folder with no GitHub repo has no PR. When bb can't say whether the branch has one, the base the last read used
 * (`stored`) stays, so the diff doesn't jump to another base and back.
 */
export async function featureBase(bb: BbPluginApi, env: Environment, repo: string | null, stored?: string): Promise<{ base: string; pr?: FolderPr } | { message: string }> {
  if (repo) {
    const prs = await bb.sdk.plugins.callRpc({ pluginId: "bb--github-pr-status", method: "pullRequests", input: { keys: [env.id] }, outputSchema: pullRequestsOutput }).catch(() => null);
    const pr = prs?.[env.id];
    if (pr?.outcome === "available" && pr.pullRequest?.baseRefName) return { base: pr.pullRequest.baseRefName, pr: pr.pullRequest };
    if (pr?.outcome !== "absent") {
      return stored ? { base: stored } : { message: "Couldn’t check whether this branch has a PR, so its base isn’t known yet. Try again in a moment." };
    }
  }
  const base = env.mergeBaseBranch || env.baseBranch || env.defaultBranch;
  return base ? { base } : { message: "Couldn’t find a base branch to compare this folder with. Choose one in its Diff tab, then try again." };
}

/** A binary file's diff as a PR's shows it: its headers and one line, without git's encoded contents. */
function binaryStub(file: ChangedFile, patch: string): string {
  const at = patch.indexOf("\nGIT binary patch");
  if (at < 0) return patch;
  const old = file.changeKind === "added" ? "/dev/null" : `a/${file.previousPath ?? file.path}`;
  const next = file.changeKind === "deleted" ? "/dev/null" : `b/${file.path}`;
  return `${patch.slice(0, at)}\nBinary files ${old} and ${next} differ\n`;
}

type Opened = { env: Environment; base: string; pr?: FolderPr; offline: () => FolderUnread };

/**
 * The folder, ready to read: ready on a connected machine, on the review's `branch` when one's given, and its base;
 * else why it can't be read.
 */
async function openFolder(bb: BbPluginApi, feature: Pick<FeatureReview, "environmentId" | "machine" | "repo"> & { baseRef?: string; branch?: string; workBranch?: string }): Promise<Opened | FolderUnread> {
  let env: Environment;
  try {
    env = await bb.sdk.environments.get({ environmentId: feature.environmentId });
  } catch (error) {
    if (isNotFound(error)) return { outcome: "gone", message: "BB removed this folder, so its changes can’t be read." };
    return { outcome: "unavailable", message: `Couldn’t read the folder’s changes: ${errorText(error)}` };
  }
  if (env.status === "destroyed") return { outcome: "gone", message: "BB removed this folder, so its changes can’t be read." };
  if (env.status === "error") return { outcome: "unavailable", message: "BB couldn’t set up this folder, so its changes can’t be read." };
  if (env.status !== "ready") return { outcome: "unavailable", message: "The folder is still being set up. Try again in a moment." };
  const machine = await machineStatus(bb, env.hostId);
  const offline = (): FolderUnread => ({ outcome: "offline", message: `${machine?.name ?? feature.machine} is offline. Wake it to see the folder’s latest changes.` });
  if (machine && !machine.connected) return offline();
  // Another branch's changes aren't this review's; a fresh thread's worktree is on a branch of its own, made from it.
  const branch = feature.workBranch ?? feature.branch;
  if (branch !== undefined && env.branchName !== branch) {
    return { outcome: "paused", branch: env.branchName, message: `The folder is on ${env.branchName ?? "no branch"}, not ${branch}.` };
  }
  // That worktree's own base is the branch it was made from: the review keeps the base it had.
  const found = feature.workBranch && feature.baseRef ? { base: feature.baseRef } : await featureBase(bb, env, feature.repo, feature.baseRef);
  if ("message" in found) return { outcome: "unavailable", message: found.message };
  return { env, ...found, offline };
}

/**
 * Each changed file's revision in the folder now, against its real base, hidden files' too, without reading a diff:
 * what a review compares with the revisions it keeps to say whether the folder changed. With the branch's PR.
 */
export async function readFeatureRevisions(bb: BbPluginApi, feature: Pick<FeatureReview, "environmentId" | "machine" | "repo"> & { baseRef?: string; branch?: string; workBranch?: string }): Promise<{ outcome: "available"; revisions: Record<string, string>; base: string; pr?: FolderPr } | FolderUnread> {
  const opened = await openFolder(bb, feature);
  if ("outcome" in opened) return opened;
  const { env, base, pr } = opened;
  try {
    const listed = await callGit(bb, "files", { environmentId: env.id, target: { type: "all", mergeBaseBranch: base }, ignoreWhitespace: false }, filesOutput);
    if (listed.outcome !== "available") return unreadable(listed);
    return { outcome: "available", revisions: Object.fromEntries(listed.files.map((file) => [file.path, file.revision])), base, ...pr ? { pr } : {} };
  } catch (error) {
    if ((await machineStatus(bb, env.hostId))?.connected === false) return opened.offline();
    return { outcome: "unavailable", message: `Couldn’t read the folder’s changes: ${errorText(error)}` };
  }
}

/** Why the Git plugin couldn't read the folder. */
const unreadable = (result: z.infer<typeof notGit> | z.infer<typeof failure>): FolderUnread => result.outcome === "not_applicable"
  ? { outcome: "unavailable", message: "This folder isn’t a git repository, so it has no changes to review." }
  : result.failure.code === "path_not_found" || result.failure.code === "unknown_environment"
    ? { outcome: "gone", message: "The folder is no longer on its machine, so its changes can’t be read." }
    : { outcome: "unavailable", message: `Couldn’t read the folder’s changes: ${result.failure.message}` };

/**
 * The folder's diff against its real base, with `include` the hidden files the reviewer chose to see,
 * `feature.baseRef` the base the last read used, if any, and `feature.branch` the branch it must be on, if any. A
 * machine that's asleep, a folder bb removed or on another branch, and any read that fails come back as an outcome with
 * the message the review shows.
 */
export async function readFeatureDiff(bb: BbPluginApi, feature: Pick<FeatureReview, "environmentId" | "machine" | "repo"> & { baseRef?: string; branch?: string; workBranch?: string }, include: readonly string[] = []): Promise<FeatureDiff> {
  const opened = await openFolder(bb, feature);
  if ("outcome" in opened) return opened;
  const { env, base, pr, offline } = opened;

  try {
    const listed = await callGit(bb, "files", { environmentId: env.id, target: { type: "all", mergeBaseBranch: base }, ignoreWhitespace: false }, filesOutput);
    if (listed.outcome !== "available") return unreadable(listed);
    const { mergeBaseRef } = listed;
    // File reads and stored diffs take it as a fixed commit, never a name that moves.
    if (!mergeBaseRef || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(mergeBaseRef)) return { outcome: "unavailable", message: `Couldn’t find where this folder’s branch left ${base}.` };

    const hidden: HiddenFile[] = [];
    const flagged: string[] = [];
    const shown: ChangedFile[] = [];
    for (const file of listed.files) {
      const secret = isSecretPath(file.path);
      const reason: HiddenFile["reason"] | null = secret && file.origin === "untracked" ? "secret"
        : file.binary ? "binary" : file.loadMode === "too_large" ? "large" : null;
      if (secret && file.origin === "tracked") flagged.push(file.path);
      if (reason && !include.includes(file.path)) hidden.push({ path: file.path, reason });
      else shown.push(file);
    }

    // Read at the merge base's commit, not the branch name, so every file's diff starts where the list did.
    const patches = new Map(listed.initialPatches.map((p) => [p.path, p]));
    const target = { type: "all", mergeBaseBranch: mergeBaseRef };
    const wanted = shown.filter((file) => !patches.has(file.path));
    for (let i = 0; i < wanted.length; i += PATCH_BATCH) {
      const batch = wanted.slice(i, i + PATCH_BATCH).map((file) => ({ file, key: JSON.stringify([env.id, target, false, file.path, file.revision]) }));
      const read = await callGit(bb, "patches", { keys: batch.map((b) => b.key) }, patchesOutput);
      for (const { file, key } of batch) {
        const result = read[key];
        if (!result) return { outcome: "unavailable", message: `Couldn’t read the folder’s changes: BB sent no diff for ${file.path}.` };
        if (result.outcome !== "available") return unreadable(result);
        patches.set(file.path, result.patch);
      }
    }

    const parts: string[] = [];
    const revisions: Record<string, string> = {};
    let bytes = 0;
    for (const file of shown) {
      const read = patches.get(file.path)!;
      const text = file.binary ? binaryStub(file, read.patch) : read.patch;
      // A cut diff would end mid-hunk.
      if (read.truncated && !file.binary || bytes + text.length > MAX_PATCH_BYTES) {
        hidden.push({ path: file.path, reason: "large" });
        continue;
      }
      // No diff means it's no longer changed: reverted between the list and the read. It isn't in the review.
      if (!text) continue;
      revisions[file.path] = file.revision;
      bytes += text.length;
      parts.push(text.endsWith("\n") ? text : `${text}\n`);
    }
    // In the list's order, wherever a file was found too large.
    const order = new Map(listed.files.map((file, i) => [file.path, i]));
    hidden.sort((a, b) => order.get(a.path)! - order.get(b.path)!);
    for (const { path } of hidden) revisions[path] = listed.files[order.get(path)!]!.revision;
    return {
      outcome: "available",
      patch: ensureGitHeaders(parts.join("")),
      revisions: Object.fromEntries([...order.keys()].filter((path) => path in revisions).map((path) => [path, revisions[path]!])),
      hidden,
      flagged,
      base,
      mergeBaseRef,
      notice: listed.truncated ? `This folder has more changed files than BB lists at once, so the review has the first ${listed.files.length}.` : null,
      ...pr ? { pr } : {},
    };
  } catch (error) {
    // The Git plugin can't reach a machine that went to sleep since it was last seen.
    if ((await machineStatus(bb, env.hostId))?.connected === false) return offline();
    return { outcome: "unavailable", message: `Couldn’t read the folder’s changes: ${errorText(error)}` };
  }
}

/** `path`, then each folder above it, outermost first: d/e/x is d, d/e, d/e/x. */
export const pathAndFolders = (path: string) => path.split("/").map((_, at, parts) => parts.slice(0, at + 1).join("/"));

/**
 * The changed link `path` goes through in the folder now, as its diff against the review's base shows it: `path`
 * itself, or the outermost folder above it, that the diff makes a link (new mode 120000), with where it points ("" when
 * BB didn't show it); null for none. A list BB cut short can't say, so that's an error, as is any read that fails.
 */
export async function changedLinkNow(bb: BbPluginApi, feature: Pick<FeatureReview, "environmentId" | "mergeBaseRef">, path: string): Promise<{ link: { path: string; target: string } | null } | { error: string }> {
  if (!feature.mergeBaseRef) return { error: "the review hasn’t read its folder yet." };
  const target = { type: "all", mergeBaseBranch: feature.mergeBaseRef };
  try {
    const listed = await callGit(bb, "files", { environmentId: feature.environmentId, target, ignoreWhitespace: false }, filesOutput);
    if (listed.outcome !== "available") return { error: unreadable(listed).message };
    if (listed.truncated) return { error: "BB lists only part of the folder’s changes, so it can’t tell whether this path goes through a link." };
    // A revision is oldMode:oldBlob:newMode:newBlob. Paths compare in any case, as a Mac's folders do.
    const links = new Map(listed.files.filter((changed) => changed.revision.split(":")[2] === "120000").map((changed) => [changed.path.toLowerCase(), changed]));
    const file = pathAndFolders(path).map((at) => links.get(at.toLowerCase())).find((found) => found);
    if (!file) return { link: null };
    let patch = listed.initialPatches.find((initial) => initial.path === file.path)?.patch;
    if (patch === undefined) {
      const key = JSON.stringify([feature.environmentId, target, false, file.path, file.revision]);
      const read = (await callGit(bb, "patches", { keys: [key] }, patchesOutput))[key];
      if (read?.outcome !== "available") return { error: `BB sent no diff for ${file.path}.` };
      patch = read.patch.patch;
    }
    return { link: { path: file.path, target: symlinkTarget(patch) ?? "" } };
  } catch (error) {
    return { error: errorText(error) };
  }
}
