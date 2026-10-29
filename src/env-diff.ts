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
import type { FeatureReview, SnapshotFiles } from "./store";

export const GIT_PLUGIN = "bb--git";
type Environment = Awaited<ReturnType<BbPluginApi["sdk"]["environments"]["get"]>>;

/** A file kept out of the patch, and why: it looks like a secret, it's binary, or its diff is too large. */
export type HiddenFile = SnapshotFiles["hidden"][number];

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
  }
  /** offline: the folder's machine isn't connected. gone: bb removed the folder. unavailable: anything else. */
  | { outcome: "offline" | "gone" | "unavailable"; message: string };

/** Untracked files with these names stay out until included: `.env*`, `*.pem`, `*.key`, `credentials*`. */
export function isSecretPath(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  return name.startsWith(".env") || name.endsWith(".pem") || name.endsWith(".key") || name.startsWith("credentials");
}

/** What the review says about a file it doesn't show. */
export function hiddenFileNotice(file: HiddenFile): string {
  switch (file.reason) {
    case "secret": return `${file.path} looks like a secret, so it isn’t shown or sent to agents. Include it to review it.`;
    case "binary": return `${file.path} is a binary file, so its contents aren’t shown or sent to agents.`;
    case "large": return `${file.path}’s diff is too large to show. Review it in the folder.`;
  }
}

/** What the review says about a committed file that looks like a secret. */
export const flaggedFileNotice = (path: string) => `${path} looks like a secret and is committed. Check it belongs in the repo.`;

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
const pullRequestsOutput = z.record(z.string(), z.object({ outcome: z.string(), pullRequest: z.object({ baseRefName: z.string() }).optional() }));
type ChangedFile = Extract<z.infer<typeof filesOutput>, { outcome: "available" }>["files"][number];

/** Call one of bb's Git plugin's RPC methods. */
export function callGit<T>(bb: BbPluginApi, method: string, input: Parameters<BbPluginApi["sdk"]["plugins"]["callRpc"]>[0]["input"], outputSchema: z.ZodType<T>): Promise<T> {
  return bb.sdk.plugins.callRpc({ pluginId: GIT_PLUGIN, method, input, outputSchema });
}

const isNotFound = (error: unknown) => (error as { status?: number } | null)?.status === 404 || String(error).includes("HTTP 404");
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * What a folder's diff is against, in the order above, or why that's unknown. A folder with no GitHub repo has no PR.
 * When bb can't say whether the branch has one, the base the last read used (`stored`) stays, so the diff doesn't
 * jump to another base and back.
 */
export async function featureBase(bb: BbPluginApi, env: Environment, repo: string | null, stored?: string): Promise<{ base: string } | { message: string }> {
  if (repo) {
    const prs = await bb.sdk.plugins.callRpc({ pluginId: "bb--github-pr-status", method: "pullRequests", input: { keys: [env.id] }, outputSchema: pullRequestsOutput }).catch(() => null);
    const pr = prs?.[env.id];
    if (pr?.outcome === "available" && pr.pullRequest?.baseRefName) return { base: pr.pullRequest.baseRefName };
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

/**
 * The folder's diff against its real base, with `include` the hidden files the reviewer chose to see and
 * `feature.baseRef` the base the last read used, if any. A machine that's
 * asleep, a folder bb removed, and any read that fails come back as an outcome with the message the review shows.
 */
export async function readFeatureDiff(bb: BbPluginApi, feature: Pick<FeatureReview, "environmentId" | "machine" | "repo"> & { baseRef?: string }, include: readonly string[] = []): Promise<FeatureDiff> {
  let env: Environment;
  try {
    env = await bb.sdk.environments.get({ environmentId: feature.environmentId });
  } catch (error) {
    if (isNotFound(error)) return { outcome: "gone", message: "bb removed this folder, so its changes can’t be read." };
    return { outcome: "unavailable", message: `Couldn’t read the folder’s changes: ${errorText(error)}` };
  }
  if (env.status === "destroyed") return { outcome: "gone", message: "bb removed this folder, so its changes can’t be read." };
  if (env.status === "error") return { outcome: "unavailable", message: "bb couldn’t set up this folder, so its changes can’t be read." };
  if (env.status !== "ready") return { outcome: "unavailable", message: "The folder is still being set up. Try again in a moment." };
  const machine = await machineStatus(bb, env.hostId);
  const offline = (): FeatureDiff => ({ outcome: "offline", message: `${machine?.name ?? feature.machine} is offline. Wake it to see the folder’s latest changes.` });
  if (machine && !machine.connected) return offline();
  const found = await featureBase(bb, env, feature.repo, feature.baseRef);
  if ("message" in found) return { outcome: "unavailable", message: found.message };
  const { base } = found;

  const unreadable = (result: z.infer<typeof notGit> | z.infer<typeof failure>): FeatureDiff => result.outcome === "not_applicable"
    ? { outcome: "unavailable", message: "This folder isn’t a git repository, so it has no changes to review." }
    : result.failure.code === "path_not_found" || result.failure.code === "unknown_environment"
      ? { outcome: "gone", message: "The folder is no longer on its machine, so its changes can’t be read." }
      : { outcome: "unavailable", message: `Couldn’t read the folder’s changes: ${result.failure.message}` };
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
        if (!result) return { outcome: "unavailable", message: `Couldn’t read the folder’s changes: bb sent no diff for ${file.path}.` };
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
      notice: listed.truncated ? `This folder has more changed files than bb lists at once, so the review has the first ${listed.files.length}.` : null,
    };
  } catch (error) {
    // The Git plugin can't reach a machine that went to sleep since it was last seen.
    if ((await machineStatus(bb, env.hostId))?.connected === false) return offline();
    return { outcome: "unavailable", message: `Couldn’t read the folder’s changes: ${errorText(error)}` };
  }
}
