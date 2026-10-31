import { useState } from "react";
import { UrlLink, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../../src/rpc-contract";
import type { MergeNote, ReviewLifecycle } from "../../src/store";
import type { Verdict } from "../../src/draft";
import { useFullscreenPortalContainer } from "../../lib/portal-scope";
import { cn } from "../../lib/utils";
import { TOUCH_CONTROL } from "../touch";
import { Button, buttonVariants } from "../ui/button";
import { Hint } from "../ui/hint";
import type { Notice } from "./ReviewNotices";

/** The review, as its PR's notices read it: the PR it became, the review of the PR it offers to merge with, a PR it holds; or, on a PR's own review, the folder's review offering to merge with it. */
export interface PrReviewed {
  kind?: "pr" | "ref";
  archivedAt?: number | null;
  became?: ReviewLifecycle["became"];
  prOffer?: ReviewLifecycle["prOffer"];
  prPending?: ReviewLifecycle["prPending"];
  mergedFrom?: ReviewLifecycle["mergedFrom"];
  /** From the server, on a PR's own review (src/reviews-rpc.ts). */
  localReview?: { targetKey: string; id: string; comments: number; intoPr?: true } | null;
}

const BUTTON = cn("h-7", TOUCH_CONTROL);
const Code = ({ children }: { children: string }) => <span className="whitespace-nowrap font-mono">{children}</span>;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
/** "a, b and c". */
const listed = (parts: string[]) => parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0] ?? "";
const CHOICE: Record<Verdict, string> = { APPROVE: "Approve", REQUEST_CHANGES: "Request changes", COMMENT: "Comment" };
/** What a merge moves, or moved: "3 comments, the summary and 1 Send". */
const moved = (note: MergeNote, summary: string) => listed([...note.comments ? [plural(note.comments, "comment")] : [], ...note.summary ? [summary] : [], ...note.sends ? [plural(note.sends, "Send")] : []]);

/** Now PR #4512: what came along, only what there was, and the id it had. */
export function becameText(became: NonNullable<ReviewLifecycle["became"]>): string {
  const merged = became.merged && moved(became.merged, "the summary");
  return [
    `Now PR #${became.number}${became.carried ? ` · ${plural(became.carried, "comment")} carried over${became.local ? `, ${became.local} not on GitHub yet` : ""}` : ""}.`,
    ...became.outside ? [`${became.outside} ${became.outside === 1 ? "is" : "are"} outside the PR’s diff.`] : [],
    ...became.merged ? [`Merged with its other review${merged ? `: ${merged} moved here` : ""}.`] : [],
    ...became.merged?.verdict ? [`Its other verdict, ${CHOICE[became.merged.verdict]}, wasn’t kept.`] : [],
  ].join(" ");
}

/**
 * A review's notices about its PR (src/feature-review.ts becomePr, src/merge.ts), from what the review stores: it became
 * PR #n, with PR #n ↗ to GitHub, Got it, and after a merge Its agent chat ↗, the other review's; the PR has a review
 * of its own, with Merge into this review and PR #n’s review ↗; on the PR's own review, its branch's local review, with
 * Merge the two and a link named by its id; and a PR it holds, opened before the review, with Make it its review and Not this one, or GitHub didn't
 * answer, with Try again. `onChanged` reloads the review, which opens the one it went into once it's merged away.
 */
export function usePrNotices(targetKey: string, review: PrReviewed | null, onChanged: () => void): Notice[] {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const container = useFullscreenPortalContainer();
  const [busy, setBusy] = useState<string | null>(null);
  if (!review) return [];
  const act = async (id: string, run: () => Promise<{ ok: boolean; error?: string }>, failed: string) => {
    if (busy) return;
    setBusy(id);
    try {
      const result = await run();
      if (!result.ok) toast.error(result.error ?? failed);
      else onChanged();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : failed);
    } finally {
      setBusy(null);
    }
  };
  const button = (id: string, label: string, onClick: () => void, { warning, description }: { warning?: boolean; description?: string } = {}) => {
    const shown = <Button variant="outline" size="sm" className={cn(BUTTON, warning && "border-warning/40")} disabled={!!busy} aria-description={description} onClick={onClick}>{busy === id ? `${label}…` : label}</Button>;
    return description ? <Hint label={description} container={container}>{shown}</Hint> : shown;
  };
  const merge = (label: string, description: string) => button("merge", label, () => void act("merge", () => rpc.call("mergeReviews", { targetKey }), "Couldn’t merge the two reviews."), { description });
  // A link that goes somewhere is named for where it goes, with ↗; Go to … is its hint. A name that's an id (`code`)
  // is in monospace, as the notice's sentence says it.
  const away = (label: string, hint: string, onClick: () => void, code = false) => <Hint label={hint} container={container}>
    <Button variant="outline" size="sm" className={BUTTON} disabled={!!busy} aria-label={label} onClick={onClick}>{code ? <Code>{label}</Code> : label} ↗</Button>
  </Hint>;
  const open = (key: string, name: string, code = false) => away(name, `Go to ${name}`, () => navigate.toPluginPanel("review", { subPath: key }), code);

  const notices: Notice[] = [];
  const { became, prOffer, prPending, localReview } = review;
  if (prPending?.why === "error") {
    notices.push({ id: "pr-pending", tone: "warning", icon: "AlertTriangle", role: "alert", firstLine: true,
      text: `This branch has PR #${prPending.number}, but GitHub didn’t answer: ${prPending.error ?? "no reason given"}`,
      action: button("take", "Try again", () => void act("take", () => rpc.call("takePendingPr", { targetKey }), "Couldn’t read the PR."), { warning: true }) });
  }
  if (became) {
    // The agent chat of the review merged in, kept apart when this review had its own.
    const agent = became.merged ? [...review.mergedFrom ?? []].reverse().find((from) => from.agentThreadId)?.agentThreadId : null;
    notices.push({ id: "became-pr", tone: "info", icon: "GitPullRequest", label: "Now a PR", firstLine: true,
      text: <>{becameText(became)} It was <Code>{became.from}</Code>.</>,
      action: <span className="flex flex-wrap gap-1">
        <Hint label={`Go to PR #${became.number} on GitHub`} container={container}>
          <UrlLink href={became.url} aria-label={`PR #${became.number}`} className={cn(buttonVariants({ variant: "outline", size: "sm" }), BUTTON, "text-foreground")}>PR #{became.number} ↗</UrlLink>
        </Hint>
        {button("became", "Got it", () => void act("became", () => rpc.call("dismissBecame", { targetKey }), "Couldn’t save that."))}
        {agent && away("Its agent chat", "Go to the other review’s agent chat", () => navigate.toThread(agent))}
      </span> });
  }
  if (prOffer && !review.archivedAt) {
    const moves = moved(prOffer.moves, "a summary");
    notices.push({ id: "pr-offer", tone: "info", icon: "GitPullRequest", firstLine: true,
      text: `PR #${prOffer.number} has a review of its own${moves ? `, with ${moves}` : ""}.`,
      action: <span className="flex flex-wrap gap-1">
        {prOffer.intoPr
          ? merge("Merge the two", "This review’s comments, summary, notes, Sends and viewed files move there. This one goes to Archive.")
          : merge("Merge into this review", "Its comments, summary, notes, Sends and viewed files move here. The other review goes to Archive.")}
        {open(prOffer.key, `PR #${prOffer.number}’s review`)}
      </span> });
  }
  if (localReview && !review.archivedAt) {
    notices.push({ id: "pr-offer", tone: "info", icon: "GitPullRequest", firstLine: true,
      text: <>This PR’s branch has a local review, <Code>{localReview.id}</Code>{localReview.comments ? `, with ${plural(localReview.comments, "comment")}` : ""}.</>,
      action: <span className="flex flex-wrap gap-1">
        {localReview.intoPr
          ? merge("Merge the two", "Its comments, summary, notes, Sends and viewed files move here. It goes to Archive.")
          : merge("Merge the two", "This review’s comments, summary, notes, Sends and viewed files move into it. This one goes to Archive.")}
        {open(localReview.targetKey, localReview.id, true)}
      </span> });
  }
  if (prPending?.why === "older" && !prPending.declined) {
    notices.push({ id: "pr-pending", tone: "info", icon: "GitPullRequest", firstLine: true,
      text: `This branch has PR #${prPending.number}, opened before this review.`,
      action: <span className="flex flex-wrap gap-1">
        {button("take", `Make it PR #${prPending.number}’s review`, () => void act("take", () => rpc.call("takePendingPr", { targetKey }), "Couldn’t make it the PR’s review."))}
        {button("decline", "Not this one", () => void act("decline", () => rpc.call("dismissPendingPr", { targetKey }), "Couldn’t save that."))}
      </span> });
  }
  return notices;
}
