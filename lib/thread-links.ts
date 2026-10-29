// Which review a BB thread page shows (app.tsx): Review changes above a thread's message box, and the Review tab. One
// copy of the plugin's index of reviews by the threads and folders they're linked to, for every thread page at once,
// read again when a review or the settings change; and the folder's git status as BB's Git plugin reads it for its
// own Changed files, never a diff.
import { useEffect, useSyncExternalStore } from "react";
import { experimental_useRpcKeyedQuery, useRealtime, useRealtimeConnectionState, useRpc, type PluginRpcClient } from "@get-bb/plugin-sdk/app";
import type { PluginRpcResult, StandardSchemaV1 } from "@get-bb/plugin-sdk";
import type { rpcContract } from "../src/rpc-contract";

type Rpc = PluginRpcClient<typeof rpcContract>;
export type ThreadLinks = PluginRpcResult<(typeof rpcContract)["threadLinks"]>;
export type ThreadLink = ThreadLinks["reviews"][number];

let links: ThreadLinks | null = null;
let reading = false;
let readAgain = false;
const listeners = new Set<() => void>();

/** Read the index, once at a time: a read asked for meanwhile runs after it, once. A failed read keeps the last. */
function read(rpc: Rpc) {
  if (reading) { readAgain = true; return; }
  reading = true;
  void rpc.call("threadLinks", null).then((next) => {
    links = next;
    for (const listener of listeners) listener();
  }, () => {}).finally(() => {
    reading = false;
    if (readAgain) { readAgain = false; read(rpc); }
  });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The index, null until it's read: read on mount, when a review or the settings change, and on reconnecting. */
export function useThreadLinks(): ThreadLinks | null {
  const rpc = useRpc<typeof rpcContract>();
  const connection = useRealtimeConnectionState();
  useEffect(() => { if (connection === "connected") read(rpc); }, [rpc, connection]);
  useRealtime("reviews", () => read(rpc));
  useRealtime("preferences", () => read(rpc));
  return useSyncExternalStore(subscribe, () => links);
}

/** Newest first, as a folder's latest review is the one it's on. */
const newest = (found: ThreadLink[]) => found.sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;

/**
 * The review of the folder at the branch it's on: `branch` as git says, null on no branch; undefined when that isn't
 * known, the review the folder was last seen on its branch for.
 */
export function folderReview(index: ThreadLinks, environmentId: string, branch?: string | null): ThreadLink | null {
  if (branch === null) return null;
  return newest(index.reviews.filter(({ folder }) => folder?.environmentId === environmentId && (branch === undefined ? !folder.paused : folder.branch === branch)));
}

/** The review a thread is linked to: the one it's the main thread of, else its folder's, else one its Sends went to. */
export function threadReviewLink(index: ThreadLinks, threadId: string, environmentId: string | null): ThreadLink | null {
  return newest(index.reviews.filter((link) => link.main === threadId))
    ?? (environmentId ? folderReview(index, environmentId) : null)
    ?? newest(index.reviews.filter((link) => link.threads.includes(threadId)));
}

/** BB's Git plugin, whose status of a folder its own Changed files reads. */
const GIT_PLUGIN = "bb--git";
/** As much of a status row as Review changes reads; the Git plugin checks it, so the page takes it as it comes. */
interface GitStatusRow {
  outcome: string;
  workspace?: { workingTree?: { fileCount?: number }; mergeBase?: { fileCount?: number } | null; branch?: { currentBranch?: string | null } };
}
const asIs = <T,>(): StandardSchemaV1<T, T> => ({ "~standard": { version: 1, vendor: "code-review-workspace", validate: (value) => ({ value: value as T }) } });
const git = { status: { input: asIs<{ keys: string[] }>(), output: asIs<Record<string, GitStatusRow>>() } };

/**
 * The folder's git status, as BB's Changed files reads it, the same keyed read: whether it has changes, uncommitted or
 * on its branch, and the branch it's on (null on none, undefined unsaid). Null until it's read, or where Git can't say;
 * not read for no folder.
 */
export function useFolderStatus(environmentId: string | null): { changes: boolean; branch: string | null | undefined } | null {
  const { data } = experimental_useRpcKeyedQuery({ pluginId: GIT_PLUGIN, contract: git, method: "status", keys: environmentId ? [environmentId] : [], enabled: environmentId !== null });
  const workspace = environmentId ? data?.[environmentId] : undefined;
  if (workspace?.outcome !== "available" || !workspace.workspace) return null;
  const { workingTree, mergeBase, branch } = workspace.workspace;
  return { changes: (workingTree?.fileCount ?? 0) > 0 || (mergeBase?.fileCount ?? 0) > 0, branch: branch ? branch.currentBranch ?? null : undefined };
}
