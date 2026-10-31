import { useState, type ReactNode } from "react";
import { UrlLink, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../../src/rpc-contract";
import type { MergeNote, ReviewLifecycle } from "../../src/store";
import type { Verdict } from "../../src/draft";
import { useFullscreenPortalContainer } from "../../lib/portal-scope";
import { reviewIdentity, type Identifiable } from "../../lib/review-identity";
import type { KeptApart } from "../../lib/review-state";
import { cn } from "../../lib/utils";
import { TOUCH_CONTROL } from "../touch";
import { Button, buttonVariants } from "../ui/button";
import { Hint } from "../ui/hint";
import type { Notice } from "./ReviewNotices";

/** The review, as its PR's notices read it: the PR it became, the review of the PR it offers to merge with, a PR it holds; or, on a PR's own review, the folder's review offering to merge with it. */
export interface PrReviewed extends Omit<Identifiable, "targetKey" | "kind"> {
  kind?: "pr" | "ref";
  archivedAt?: number | null;
  became?: ReviewLifecycle["became"];
  prOffer?: ReviewLifecycle["prOffer"];
  mergeDeclined?: ReviewLifecycle["mergeDeclined"];
  prPending?: ReviewLifecycle["prPending"];
  mergedFrom?: ReviewLifecycle["mergedFrom"];
  /** From the server, on a PR's own review (src/reviews-rpc.ts). `branch`: the local review's, when it isn't the PR's. */
  localReview?: { targetKey: string; id: string; comments: number; intoPr?: true; branch?: string } | null;
}

const BUTTON = cn("h-7", TOUCH_CONTROL);
const Code = ({ children }: { children: string }) => <span className="whitespace-nowrap font-mono">{children}</span>;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
/** "a, b and c". */
const listed = (parts: string[]) => parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0] ?? "";
const CHOICE: Record<Verdict, string> = { APPROVE: "Approve", REQUEST_CHANGES: "Request changes", COMMENT: "Comment" };
/** Which review a merge keeps, as its offer says: the folder's, unless the PR's began as another folder's (`intoPr`). */
const stays = (intoPr: boolean | undefined, onPr: boolean) => (onPr ? intoPr : !intoPr) ? "Merging keeps this one and archives that one." : "Merging keeps that one and archives this one.";
/** Review actions' Merge into one review after Keep both: the offer's sentence, without what moves, which may have changed; its branch in `backticks`. */
export const keptApartLine = (kept: KeptApart, onPr: boolean) => `${!onPr ? `PR #${kept.number} has its own review.` : kept.branch ? `A local review of \`${kept.branch}\` is linked to this PR.` : "This PR’s branch has a local review."} ${stays(kept.intoPr, onPr)}`;
/** What a merge moves, or moved: "3 comments, the summary and 1 Send". */
const moved = (note: MergeNote, summary: string) => listed([...note.comments ? [plural(note.comments, "comment")] : [], ...note.summary ? [summary] : [], ...note.sends ? [plural(note.sends, "Send")] : []]);

/**
 * Now PR #4512's review, `api#4512` (`id`): what came along, only what there was; where the comments the PR's diff
 * doesn't have are, those open in Needs you (`needsYou`, its link); the id it had, which still opens it; and after a
 * merge, with `mergedWith`, what moved here.
 */
export function becameText(became: NonNullable<ReviewLifecycle["became"]>, id: string, mergedWith: string, needsYou: (label: string) => ReactNode = (label) => label): ReactNode {
  const merged = became.merged && moved(became.merged, "the summary");
  const { outside } = became;
  // Of those, the open ones, on the older diff, need you; the rest were sent.
  const open = Math.min(became.needsYou ?? outside, outside);
  const lines = outside === 1 ? "is on a line the PR doesn’t have" : `are on lines the PR doesn’t have`;
  return <>
    Now PR #{became.number}’s review, <Code>{id}</Code>{became.carried ? `, with ${plural(became.carried, "comment")} carried over${became.local ? `, ${became.local} not on GitHub yet` : ""}` : ""}.
    {outside > 0 && <> {outside} {lines}{open === outside ? <>, under {needsYou("Needs you")}.</> : open ? <>: {open} under {needsYou("Needs you")}, the rest with your Sends.</> : ", with your Sends."}</>}
    {" "}It was <Code>{became.from}</Code>, which still opens it.
    {became.merged && ` Merged with ${mergedWith}${merged ? `: ${merged} moved here` : ""}.`}
    {became.merged?.verdict && ` Its verdict, ${CHOICE[became.merged.verdict]}, wasn’t kept.`}
  </>;
}

/**
 * A review's notices about its PR (src/feature-review.ts becomePr, src/merge.ts), from what the review stores: it became
 * PR #n, with PR #n ↗ to GitHub, after a merge Earlier agent chat ↗, the other review's, beside this one, and Got it,
 * its Needs you opening Comments there (`onNeedsYou`); the PR has a review of its own, with Merge into one review, PR
 * #n’s review ↗ and Keep both; on the PR's own review, its branch's local review, with Merge into one review, Local
 * review ↗ and Keep both; and a PR it holds, opened before the review, with Make it its review and Not this one, or
 * GitHub didn't answer, with Try again. `onChanged` reloads the review, which opens the one it went into once it's
 * merged away.
 */
export function usePrNotices(targetKey: string, review: PrReviewed | null, onChanged: () => void, onNeedsYou: () => void): Notice[] {
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
  const button = (id: string, label: string, onClick: () => void, { warning, quiet }: { warning?: boolean; quiet?: boolean } = {}) =>
    <Button variant={quiet ? "ghost" : "outline"} size="sm" className={cn(BUTTON, warning && "border-warning/40")} disabled={!!busy} onClick={onClick}>{busy === id ? `${label}…` : label}</Button>;
  // The same on both reviews: the notice's sentence says which stays. For the folder's review it names (`folder`), of
  // a PR's two or more.
  const merge = (folder: string) => button("merge", "Merge into one review", () => void act("merge", () => rpc.call("mergeReviews", { targetKey: folder }), "Couldn’t merge the two reviews."));
  const keepBoth = (folder: string) => button("keep", "Keep both", () => void act("keep", () => rpc.call("keepBothReviews", { targetKey: folder }), "Couldn’t save that."), { quiet: true });
  // A link that goes somewhere is named for where it goes, with ↗; Go to … is its hint. Its words are one span, so the
  // button's gap never opens inside them, between a part a width hides and the rest.
  const away = (label: string, hint: string, onClick: () => void, shown: ReactNode = label) => <Hint label={hint} container={container}>
    <Button variant="outline" size="sm" className={BUTTON} disabled={!!busy} aria-label={label} onClick={onClick}><span>{shown} ↗</span></Button>
  </Hint>;
  const open = (key: string, name: string, hint = `Go to ${name}`, shown?: ReactNode) => away(name, hint, () => navigate.toPluginPanel("review", { subPath: key }), shown);

  const notices: Notice[] = [];
  const { became, prOffer, prPending, localReview } = review;
  if (prPending?.why === "error") {
    notices.push({ id: "pr-pending", tone: "warning", icon: "AlertTriangle", role: "alert", firstLine: true,
      text: `This branch has PR #${prPending.number}, but GitHub didn’t answer: ${prPending.error ?? "no reason given"}`,
      action: button("take", "Try again", () => void act("take", () => rpc.call("takePendingPr", { targetKey }), "Couldn’t read the PR."), { warning: true }) });
  }
  if (became) {
    // The agent chat of the review merged in, kept apart when this review had its own; and what that review was.
    const from = became.merged ? review.mergedFrom?.at(-1) : undefined;
    const agent = became.merged ? [...review.mergedFrom ?? []].reverse().find((merged) => merged.agentThreadId)?.agentThreadId : null;
    const mergedWith = from?.key.startsWith("br-") ? `another folder’s review, ${from.id}` : "the PR’s own review";
    const needsYou = (label: string) => <button type="button" className="rounded-sm font-medium underline decoration-border underline-offset-4 hover:decoration-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={onNeedsYou}>{label}</button>;
    notices.push({ id: "became-pr", tone: "info", icon: "GitPullRequest", label: "Now a PR", firstLine: true,
      text: becameText(became, reviewIdentity({ ...review, targetKey }).id, mergedWith, needsYou),
      action: <span className="flex flex-wrap gap-1">
        <Hint label={`Go to PR #${became.number} on GitHub`} container={container}>
          <UrlLink href={became.url} aria-label={`PR #${became.number}`} className={cn(buttonVariants({ variant: "outline", size: "sm" }), BUTTON, "text-foreground")}>PR #{became.number} ↗</UrlLink>
        </Hint>
        {agent && away("Earlier agent chat", "Go to the merged review’s agent chat, beside this review", () => navigate.toThread(agent, { split: true }))}
        {button("became", "Got it", () => void act("became", () => rpc.call("dismissBecame", { targetKey }), "Couldn’t save that."))}
      </span> });
  }
  if (prOffer && !review.archivedAt && review.mergeDeclined !== prOffer.key) {
    const moves = moved(prOffer.moves, "a summary");
    notices.push({ id: "pr-offer", tone: "info", icon: "GitPullRequest", firstLine: true,
      text: `PR #${prOffer.number} has its own review${moves ? `, with ${moves}` : ""}. ${stays(prOffer.intoPr, false)}`,
      action: <span className="flex flex-wrap gap-1">
        {merge(targetKey)}
        {/* PR’s review ↗ under 440px wide, as the sentence names the PR, so Keep both stays on the buttons' row. */}
        {open(prOffer.key, `PR #${prOffer.number}’s review`, undefined, <>PR<span className="@max-[440px]/review:hidden"> #{prOffer.number}</span>’s review</>)}
        {keepBoth(targetKey)}
      </span> });
  }
  if (localReview && !review.archivedAt) {
    notices.push({ id: "pr-offer", tone: "info", icon: "GitPullRequest", firstLine: true,
      text: localReview.branch
        ? <>A local review of <Code>{localReview.branch}</Code>{localReview.comments ? ` with ${plural(localReview.comments, "comment")}` : ""} is linked to this PR. {stays(localReview.intoPr, true)}</>
        : `This PR’s branch has a local review${localReview.comments ? ` with ${plural(localReview.comments, "comment")}` : ""}. ${stays(localReview.intoPr, true)}`,
      action: <span className="flex flex-wrap gap-1">
        {merge(localReview.targetKey)}
        {open(localReview.targetKey, "Local review", `Go to ${localReview.id}`)}
        {keepBoth(localReview.targetKey)}
      </span> });
  }
  if ((prPending?.why === "older" || prPending?.why === "branch") && !prPending.declined) {
    notices.push({ id: "pr-pending", tone: "info", icon: "GitPullRequest", firstLine: true,
      text: prPending.why === "branch" && prPending.head ? <>PR #{prPending.number} is from <Code>{prPending.head}</Code>, not this branch.</>
        : `This branch has PR #${prPending.number}, opened before this review.`,
      action: <span className="flex flex-wrap gap-1">
        {button("take", `Make it PR #${prPending.number}’s review`, () => void act("take", () => rpc.call("takePendingPr", { targetKey }), "Couldn’t make it the PR’s review."))}
        {button("decline", "Not this one", () => void act("decline", () => rpc.call("dismissPendingPr", { targetKey }), "Couldn’t save that."))}
      </span> });
  }
  return notices;
}
