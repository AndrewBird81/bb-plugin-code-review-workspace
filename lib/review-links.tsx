// What links a review to the code and the BB thread that made the change: where Open in editor opens a local review's
// files, and the comments sent to the thread. The workspace provides it, so each card in the code reads it without the
// whole draft.
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../src/rpc-contract";
import { sameLocation, type CommentLocation } from "../src/draft";
import type { ReviewLifecycle } from "../src/store";
import type { ReviewItem } from "./review-state";
import { useKnob } from "./settings";

export interface ReviewLinks {
  /** The comments sent to the review's source thread; null when none were, or Send to thread is off. */
  sent: NonNullable<ReviewLifecycle["sent"]> | null;
  /** A local review's checkout and the BB server's host, where its files open; null for a PR, a diff that doesn't end at the checkout, or with Open in editor off. */
  editor: { hostId: string; root: string } | null;
}

export const ReviewLinksContext = createContext<ReviewLinks>({ sent: null, editor: null });

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
  return useMemo(() => ({ sent, editor: root && hostId ? { hostId, root } : null }), [sent, root, hostId]);
}

/** Where and when the comment was sent, or null: null too once it's edited, or another takes its place, since. */
export function useSentTo(at: CommentLocation & { body: string }): { threadId: string; title: string | null; at: number } | null {
  const { sent } = useContext(ReviewLinksContext);
  // A record from 0.8.0 has no body, so it matches by place alone.
  const comment = sent?.comments.find((entry) => sameLocation(entry, at) && (entry.body === undefined || entry.body === at.body));
  return sent && comment ? { threadId: sent.threadId, title: sent.title, at: comment.at } : null;
}

/** A local review's file on the BB server, for Open in editor; null where it can't open. */
export function useEditorFile(file: string): { kind: "host"; hostId: string; path: string } | null {
  const { editor } = useContext(ReviewLinksContext);
  return editor && { kind: "host", hostId: editor.hostId, path: `${editor.root.replace(/\/+$/, "")}/${file}` };
}
