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
  /** A local review's checkout and the BB server's host, where its files open; null for a PR, a diff that doesn't end at the checkout, or with Open in editor off. */
  editor: { hostId: string; root: string } | null;
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

/** The review's links, as its switches allow. A local review's checkout is on the BB server, so its files open there. */
export function useReviewLinks(review: ReviewItem | null): ReviewLinks {
  const rpc = useRpc<typeof rpcContract>();
  const sendToThread = useKnob("sendToThread");
  const openInEditor = useKnob("openInEditor");
  const root = openInEditor && review?.kind === "ref" && diffEndsAtCheckout(review.gitRef) ? review.cwd ?? null : null;
  const [hostId, setHostId] = useState<string | null>(null);
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
  return useMemo(() => ({ status, editor: root && hostId ? { hostId, root } : null }), [status, root, hostId]);
}

/** What a draft comment's status line says of its review: as the workspace provides it, or as before 1.8.0. */
export const useStatusFacts = () => useContext(ReviewLinksContext).status;

/** A local review's file on the BB server, for Open in editor; null where it can't open. */
export function useEditorFile(file: string): { kind: "host"; hostId: string; path: string } | null {
  const { editor } = useContext(ReviewLinksContext);
  return editor && { kind: "host", hostId: editor.hostId, path: `${editor.root.replace(/\/+$/, "")}/${file}` };
}
