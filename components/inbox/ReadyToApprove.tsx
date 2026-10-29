import { useEffect, useRef, useState } from "react";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../../src/rpc-contract";
import type { ReadyToApprove as Row } from "../../src/store";
import type { ReviewItem } from "../../lib/review-state";
import { reviewIdentity } from "../../lib/review-identity";
import { newCommentsText } from "../../lib/turn";
import { cn } from "../../lib/utils";
import { timeAgo } from "../time-ago";
import { TOUCH_CONTROL, TOUCH_TARGET } from "../touch";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { ROWS_CARD } from "./InboxSection";

type Ready = ReviewItem & { readyToApprove: Row };
/** What a run posted: each row's action, the PR's id, and where it is on GitHub. */
export type ReadyPosted = Array<{ action: Row["action"]; id: string; href: string | null }>;
const VERB: Record<Row["action"], string> = { approve: "Approve", merge: "Merge", close: "Close" };
const BUTTON: Record<Row["action"], string> = { approve: "Approve", merge: "Merge", close: "Close PR" };
const DONE: Record<Row["action"], string> = { approve: "Approved", merge: "Merged", close: "Closed" };
const DOING: Record<Row["action"], string> = { approve: "Approving", merge: "Merging", close: "Closing" };
const METHOD = { merge: "A merge commit", squash: "Squashed into one commit", rebase: "Rebased" } as const;
/** A busy control: focusable, and drawn as unavailable. */
const UNAVAILABLE = "aria-disabled:opacity-50";
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What a row does besides its text: how a merge is done, or that a close doesn't merge. */
function details(row: Row): string[] {
  if (row.action === "close") return ["Closes the PR without merging it."];
  if (row.action !== "merge") return [];
  const merge = row.merge ?? { method: "merge" as const, auto: false, deleteBranch: false };
  return [`${METHOD[merge.method]}, at ${row.headSha.slice(0, 7)}, the commit you reviewed.`, ...merge.method === "rebase" ? [] : ["Its commit message is the one this repo's settings make."],
    ...merge.auto ? ["It merges once checks and reviews pass."] : [], ...merge.deleteBranch ? ["Then it deletes the branch."] : []];
}
/** A PR the sync already knows has commits since the row was asked: held before anything is tried. */
const movedOn = (review: Ready) => !!review.latestHeadSha && review.latestHeadSha !== review.readyToApprove.headSha;
/** How many commits a held row covers: GitHub's count from its try, else the sync's since your review, when that's what was asked on. */
const commitsOf = (review: Ready, tried: number | null | undefined) =>
  tried ?? (review.signals?.lastReviewSha === review.readyToApprove.headSha ? review.signals?.commitsSince ?? null : null);
/** "Held: 2 new commits since you read it. Approving covers them too." */
function heldText(review: Ready, tried: number | null | undefined, verb: string): string {
  const n = commitsOf(review, tried);
  const covered = verb === "approve" ? ` Approving covers ${n === 1 ? "it" : "them"} too.` : " Update the review, then merge it there.";
  return `Held: ${n ? plural(n, "new commit") : "new commits"} since you read it.${covered}`;
}

/** "2 new comments on your PR, the latest since this was asked.": one may say not to go ahead. */
function commentsSince(review: Ready): string | null {
  const fresh = review.signals?.newComments;
  return fresh?.count && fresh.at > review.readyToApprove.at ? `${newCommentsText(fresh)} on your PR, the latest since this was asked.` : null;
}

/**
 * Needs review's Ready to approve: each approval, merge or close one of your other threads asked for, with exactly what
 * it posts, waiting for your click. Approve posts one; Approve N posts each approval shown that isn't held, one after
 * another, each row saying how it went; merges and closes each take their own click. An approval whose PR has commits
 * since you read it is held: the sync may know already, and GitHub's head is read again as each posts. Approve it too
 * posts those, on the commit you read. What posted is summed up, with links, until you dismiss it.
 */
export function ReadyToApprove({ reviews, onOpen, onChanged, onPosted }: { reviews: Ready[]; onOpen(targetKey: string): void; onChanged(): void; onPosted(posted: ReadyPosted): void }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  // The GitHub account it posts as, when known.
  const [account, setAccount] = useState<string | null>(null);
  useEffect(() => { void rpc.call("getGhAccounts", null).then((result) => setAccount(result.active), () => {}); }, [rpc]);
  /** Why a row was held or failed, by its token, from its latest try, and a held one's commits. */
  const [outcomes, setOutcomes] = useState<Record<string, { held: boolean; error: string; commits?: number | null }>>({});
  /** The rows of a run, by token: waiting their turn, posting now, or posted. */
  const [states, setStates] = useState<Record<string, "queued" | "posting" | "posted">>({});
  const [said, setSaid] = useState("");
  const listRef = useRef<HTMLUListElement>(null);
  const focusAfter = useRef<string | null>(null);
  // Once a dismissed row goes, its focus goes to the next row, else the part's first control; what posted takes it itself.
  useEffect(() => {
    const token = focusAfter.current;
    if (!token || reviews.some((review) => review.readyToApprove.token === token)) return;
    focusAfter.current = null;
    (listRef.current?.querySelector<HTMLElement>("[data-ready-action]") ?? listRef.current?.closest("[role=group]")?.querySelector<HTMLElement>("button"))?.focus();
  }, [reviews]);

  const held = (review: Ready) => outcomes[review.readyToApprove.token]?.held ?? movedOn(review);
  const approvals = reviews.filter((review) => review.readyToApprove.action === "approve");
  const ready = approvals.filter((review) => !held(review));
  const heldOnes = approvals.filter(held);
  const merges = reviews.filter((review) => review.readyToApprove.action === "merge").length;
  const closes = reviews.filter((review) => review.readyToApprove.action === "close").length;
  const skipped = [heldOnes.length && `${heldOnes.length} held`, merges && plural(merges, "merge"), closes && plural(closes, "close")].filter(Boolean).join(", ");
  const busy = Object.keys(states).length > 0;
  // The commits the held ones cover, when each says how many.
  const heldCounts = heldOnes.map((review) => commitsOf(review, outcomes[review.readyToApprove.token]?.commits));
  const heldCommits = heldCounts.every((n) => typeof n === "number" && n > 0) ? heldCounts.reduce<number>((sum, n) => sum + n!, 0) : null;

  /** Post `rows`, one after another, past their held commits too with `alsoHeld`; each row says how it went. */
  async function post(rows: Ready[], alsoHeld = false) {
    if (busy || !rows.length) return;
    setStates(Object.fromEntries(rows.map((review) => [review.readyToApprove.token, "queued" as const])));
    const posted: ReadyPosted = [];
    const stopped: string[] = [];
    for (const [index, review] of rows.entries()) {
      const row = review.readyToApprove;
      const { id } = reviewIdentity(review);
      setStates((all) => ({ ...all, [row.token]: "posting" }));
      if (rows.length > 1) setSaid(`${DOING[row.action]} ${id}, ${index + 1} of ${rows.length}…`);
      try {
        const [result] = (await rpc.call("approveReady", { rows: [{ targetKey: review.targetKey, token: row.token }], ...alsoHeld ? { alsoHeld } : {} })).results;
        if (result?.outcome === "posted") {
          posted.push({ action: row.action, id, href: result.url ?? review.url ?? null });
          setStates((all) => ({ ...all, [row.token]: "posted" }));
          setOutcomes((all) => { const { [row.token]: _gone, ...rest } = all; return rest; });
          continue;
        }
        setOutcomes((all) => ({ ...all, [row.token]: { held: result?.outcome === "held", error: result?.error ?? "GitHub didn't take it. Try again.", commits: result?.commits ?? null } }));
      } catch {
        setOutcomes((all) => ({ ...all, [row.token]: { held: false, error: "Couldn't reach Code Review Workspace. Try again." } }));
      }
      stopped.push(id);
      setStates((all) => { const { [row.token]: _gone, ...rest } = all; return rest; });
    }
    if (posted.length) onPosted(posted);
    setSaid([posted.length ? `${DONE[posted[0]!.action]} ${posted.map((p) => p.id).join(", ")} on GitHub.` : "", stopped.length ? `${stopped.join(", ")} didn’t post: ${stopped.length === 1 ? "its row says why" : "their rows say why"}.` : ""].filter(Boolean).join(" "));
    if (posted.length) onChanged();
    setStates({});
  }
  async function dismiss(review: Ready) {
    if (busy) return;
    focusAfter.current = review.readyToApprove.token;
    try { await rpc.call("dismissReady", { targetKey: review.targetKey, token: review.readyToApprove.token }); } catch { /* the list says what's still there */ }
    setSaid(`Dismissed ${reviewIdentity(review).id}. Nothing was posted.`);
    onChanged();
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3">
        <p className="min-w-0 flex-1 basis-56 text-xs text-muted-foreground">Asked from your other threads. Each posts to GitHub{account ? ` as @${account}` : ""} only when you click it.</p>
        {ready.length > 1 && <div className="flex shrink-0 items-center gap-2">
          {skipped && <span className="text-xs text-muted-foreground">Skips {skipped}</span>}
          <Button size="sm" className={cn("gap-1.5", TOUCH_CONTROL, UNAVAILABLE)} aria-disabled={busy || undefined} onClick={() => void post(ready)}>Approve {ready.length}</Button>
        </div>}
      </div>
      <ul ref={listRef} className={ROWS_CARD}>
        {reviews.map((review) => {
          const row = review.readyToApprove;
          const { id } = reviewIdentity(review);
          const outcome = outcomes[row.token];
          const state = states[row.token];
          const isHeld = held(review) && (!state || state === "queued");
          const lines = details(row);
          const asked = timeAgo(row.at);
          const comments = commentsSince(review);
          // A summary of one line is whole in the row's first line; a longer one shows whole under it, once.
          const body = row.body.trim();
          const whole = body.includes("\n");
          const label = isHeld && row.action === "approve" ? "Approve it too" : BUTTON[row.action];
          return <li key={row.token} className="px-3 py-2.5">
            <div className="flex flex-col gap-2 @min-[560px]/inbox:flex-row @min-[560px]/inbox:items-start @min-[560px]/inbox:gap-3">
              <div className="min-w-0 flex-1 space-y-1.5">
                <p className="break-words text-sm leading-5">
                  <span className="font-medium">{VERB[row.action]}</span><span className="text-subtle-foreground" aria-hidden> · </span>
                  <button type="button" onClick={() => onOpen(review.targetKey)} aria-label={`Open ${id}`} className={cn("relative rounded-sm font-mono text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", TOUCH_TARGET)}>{id}</button>
                  {body && !whole && <><span className="text-subtle-foreground" aria-hidden> · </span><span>{body}</span></>}
                  {!body && row.action === "approve" && <span className="ml-2 italic text-muted-foreground">(no message, approval only)</span>}
                  {!body && row.action !== "approve" && <span className="ml-2 text-muted-foreground">{reviewIdentity(review).name}</span>}
                </p>
                {whole && <p className="whitespace-pre-wrap break-words rounded-md bg-muted/40 px-2 py-1.5 text-sm leading-relaxed"><span className="sr-only">Exactly what posts: </span>{row.body}</p>}
                {lines.length > 0 && <ul className="space-y-0.5 text-xs text-muted-foreground">{lines.map((line) => <li key={line}>{line}</li>)}</ul>}
                <p className="text-xs text-subtle-foreground">
                  {row.from ? <>Asked from <button type="button" onClick={() => navigate.toThread(row.from!)} className={cn("relative text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary", TOUCH_TARGET)}>{row.fromTitle ?? row.from}<span aria-hidden> ↗</span></button></> : "Asked from a shell outside bb's threads"}
                  {asked && <span className="whitespace-nowrap"> · {asked}</span>}
                </p>
                {comments && <p className="flex gap-1.5 text-xs leading-relaxed text-warning-text"><Icon name="AlertTriangle" className="mt-0.5 size-3.5 shrink-0" aria-hidden />{comments}</p>}
                {isHeld && <p className="flex gap-1.5 text-xs leading-relaxed text-warning-text"><Icon name="AlertTriangle" className="mt-0.5 size-3.5 shrink-0" aria-hidden />{heldText(review, outcome?.commits, row.action)}</p>}
                {outcome && !outcome.held && <p className="flex gap-1.5 text-xs leading-relaxed text-destructive-text"><Icon name="AlertCircle" className="mt-0.5 size-3.5 shrink-0" aria-hidden />{outcome.error}</p>}
              </div>
              <div className="flex shrink-0 items-center justify-end gap-1">
                {state === "posting" && <span className="flex items-center gap-1.5 pr-1 text-xs text-muted-foreground"><Icon name="Loading" className="size-4 animate-spin motion-reduce:animate-none" aria-hidden />{DOING[row.action]}…</span>}
                {state === "posted" && <span className="flex items-center gap-1 pr-1 text-xs font-medium text-diff-added">{DONE[row.action]} <Icon name="Check" className="size-4" aria-hidden /></span>}
                {(!state || state === "queued") && <>
                  <Button variant="ghost" size="sm" className={cn(TOUCH_CONTROL, UNAVAILABLE)} aria-label={`Dismiss ${id}`} aria-disabled={busy || undefined} onClick={() => void dismiss(review)}>Dismiss</Button>
                  <Button size="sm" data-ready-action variant={isHeld ? "outline" : "default"} className={cn("gap-1.5", TOUCH_CONTROL, UNAVAILABLE)} aria-label={`${label} ${id}`} aria-disabled={busy || undefined}
                    onClick={() => void post([review], isHeld && row.action === "approve")}>{label}</Button>
                </>}
              </div>
            </div>
          </li>;
        })}
      </ul>
      {heldOnes.length > 0 && <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 text-sm text-warning-text">
        <Icon name="AlertTriangle" className="size-4 shrink-0" aria-hidden />
        <span>{heldOnes.length} held: {heldCommits ? plural(heldCommits, "new commit") : "commits"} since you read {heldOnes.length === 1 ? "it" : "them"}</span>
        <Button variant="outline" size="sm" className={cn(TOUCH_CONTROL, UNAVAILABLE)} aria-disabled={busy || undefined} onClick={() => void post(heldOnes, true)}>{heldOnes.length === 1 ? "Approve it too" : "Approve them too"}</Button>
      </div>}
      <p role="status" aria-live="polite" className="sr-only">{said}</p>
    </div>
  );
}

/**
 * What the last Ready to approve run posted, with links to it on GitHub, in Needs review until you dismiss it: it outlives
 * the rows it posted, which leave the list. It takes the focus when it shows, as theirs went with them.
 */
export function ReadyPostedNotice({ posted, onDismiss }: { posted: ReadyPosted; onDismiss(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const active = document.activeElement;
    if (!active || active === document.body) ref.current?.focus();
  }, [posted]);
  const grouped = (["approve", "merge", "close"] as const).map((action) => ({ action, done: posted.filter((p) => p.action === action) })).filter((g) => g.done.length);
  return (
    <div ref={ref} tabIndex={-1} role="status" className="flex items-start gap-2 rounded-lg border border-success/20 bg-success/10 px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <Icon name="CircleCheck" className="mt-0.5 size-4 shrink-0 text-diff-added" aria-hidden />
      <div className="min-w-0 flex-1 space-y-0.5">
        {grouped.map(({ action, done }) => <p key={action} className="break-words">
          {DONE[action]} {done.length > 1 ? `${done.length} ` : ""}on GitHub: {done.map((d, i) => <span key={d.id}>{i > 0 && ", "}
            {d.href ? <a href={d.href} target="_blank" rel="noreferrer" className={cn("relative font-mono text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary", TOUCH_TARGET)}>{d.id}</a> : <span className="font-mono">{d.id}</span>}</span>)}
        </p>)}
      </div>
      <Button variant="ghost" size="sm" className={cn("-my-1 size-7 px-0", TOUCH_CONTROL)} aria-label="Dismiss what was posted" onClick={onDismiss}><Icon name="X" aria-hidden /></Button>
    </div>
  );
}
