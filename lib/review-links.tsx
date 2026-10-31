// What links a review to the code and the BB thread that made the change: where Open in editor opens a local review's
// files, and what its comments' status lines say of it, its Sends among them. The workspace provides it, so each card in
// the code reads it without the whole draft.
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../src/rpc-contract";
import { POSTS, type StatusFacts } from "./comments";
import type { ReviewItem } from "./review-state";
import { useKnob } from "./settings";

export interface ReviewLinks {
  /** What a draft comment's status line says of its review (lib/comment-status.ts): with Send to thread off, no Sends. */
  status: StatusFacts;
  /**
   * Where the review's files open: a local review's checkout and the BB server's host; a folder's review's folder, on
   * its machine, a PR's that came from it too, while it's there on its branch. Null for another PR, a diff that doesn't
   * end at the checkout, or with Open in editor off. `unpushed`: on a PR, the files the folder has changed since the
   * PR's head, whose lines aren't the PR's; null until read, when none's are.
   */
  editor: { hostId: string; root: string; unpushed?: readonly string[] | null } | null;
}

export const ReviewLinksContext = createContext<ReviewLinks>({ status: POSTS, editor: null });

/**
 * Whether a local review's diff ends at what its checkout holds, so its lines are the checkout's: a ref without `..`,
 * which `git diff` takes against the working tree, or a range ending at HEAD. Not `main...feature` or `a..b`.
 */
export function diffEndsAtCheckout(gitRef: string | undefined): boolean {
  if (!gitRef) return false;
  const range = gitRef.match(/\.\.\.?(.*)$/);
  return !range || range[1] === "" || range[1] === "HEAD";
}

/**
 * The review's links, as its switches allow. A local review's checkout is on the BB server, so its files open there; a
 * folder's review's open in its folder, on its machine.
 */
export function useReviewLinks(review: ReviewItem | null): ReviewLinks {
  const rpc = useRpc<typeof rpcContract>();
  const sendToThread = useKnob("sendToThread");
  const openInEditor = useKnob("openInEditor");
  const feature = openInEditor && review?.feature && !review.feature.folderGone && !review.feature.pausedOn ? review.feature : null;
  const root = openInEditor && review?.kind === "ref" && !review.feature && diffEndsAtCheckout(review.gitRef) ? review.cwd ?? null : null;
  const [hostId, setHostId] = useState<string | null>(null);
  // On a PR, what its folder has that GitHub doesn't, as its notices read it (src/feature-review.ts checkFeature).
  const folderPr = review?.kind === "pr" && feature ? review.targetKey : null;
  const prHead = review?.headSha;
  const [unpushed, setUnpushed] = useState<{ targetKey: string; paths: string[] | null } | null>(null);
  useEffect(() => {
    if (!folderPr) return;
    let current = true;
    rpc.call("checkFeature", { targetKey: folderPr }).then((check) => {
      if (current) setUnpushed({ targetKey: folderPr, paths: check.state === "current" ? [] : check.state === "ahead" ? check.aheadPaths ?? null : null });
    }, () => {});
    return () => { current = false; };
  }, [rpc, folderPr, prHead]);
  useEffect(() => {
    if (!root) return;
    let current = true;
    // Without an answer, nothing offers to open.
    rpc.call("listMachines", null).then(({ machines }) => { if (current) setHostId(machines.find((machine) => machine.server)?.hostId ?? null); }, () => {});
    return () => { current = false; };
  }, [rpc, root]);
  const sent = sendToThread ? review?.sent ?? null : null;
  const sends = sendToThread ? review?.sends ?? null : null;
  const threadSends = sendToThread ? review?.threadSends ?? null : null;
  const posts = review?.kind === "pr";
  const own = review?.kind === "ref" || review?.ownPr === true || !!review?.feature;
  const status = useMemo(() => ({ posts, own, sends, sent, threadSends }), [posts, own, sends, sent, threadSends]);
  const featureHost = feature?.hostId;
  const featureRoot = feature?.path;
  const unpushedPaths = folderPr && unpushed?.targetKey === folderPr ? unpushed.paths : null;
  return useMemo(() => ({
    status,
    editor: featureHost && featureRoot ? { hostId: featureHost, root: featureRoot, ...folderPr ? { unpushed: unpushedPaths } : {} } : root && hostId ? { hostId, root } : null,
  }), [status, featureHost, featureRoot, folderPr, unpushedPaths, root, hostId]);
}

/** What a draft comment's status line says of its review: as the workspace provides it, or as before 1.8.0. */
export const useStatusFacts = () => useContext(ReviewLinksContext).status;

/**
 * A review's file in its checkout or folder, for Open in editor, and whether its lines are the diff's there (`lines`):
 * on a PR, only in a file the folder hasn't changed since the PR's head. Null where it can't open.
 */
export function useEditorFile(file: string): { target: { kind: "host"; hostId: string; path: string }; lines: boolean } | null {
  const { editor } = useContext(ReviewLinksContext);
  return editor && {
    target: { kind: "host", hostId: editor.hostId, path: `${editor.root.replace(/\/+$/, "")}/${file}` },
    lines: editor.unpushed === undefined || !!editor.unpushed && !editor.unpushed.includes(file),
  };
}
