import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { UrlLink, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../../src/rpc-contract";
import { SUMMARY_AT, VERDICT_LABEL, verdictPicked, type Verdict } from "../../src/draft";
import type { CommentFilter, CommentItem } from "../../lib/comments";
import { readDraftRecovery } from "../../lib/draft-recovery";
import { needsOrder, reviewState, type ReviewItem } from "../../lib/review-state";
import { statusWhy } from "../../lib/status-line";
import { cn } from "../../lib/utils";
import { useWorkspace } from "../../lib/workspace-context";
import { useDraft } from "../DraftProvider";
import { FixHandoff } from "../FixHandoff";
import { ReviewerNotes } from "../ReviewerNotes";
import { SummaryCard } from "../SummaryCard";
import { age } from "../time-ago";
import { TOUCH_CONTROL, TOUCH_TARGET } from "../touch";
import { Button, buttonVariants } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { Icon } from "../ui/icon";
import { InlineCode } from "../ui/inline-code";
import { MetaLine } from "../MetaLine";
import { Clamped } from "./CommentCard";
import { notSubmitted } from "./look";
import { focusComments } from "./CommentsView";
import { updateComments, useComments } from "./store";

const OWN_PR = "This is your PR, so GitHub allows only a Comment review.";
const RECEIPT_LABEL: Record<Verdict, string> = { APPROVE: "Approved", REQUEST_CHANGES: "Changes requested", COMMENT: "Commented" };
const VERDICTS = [
  ["APPROVE", "aria-pressed:bg-success/15 aria-pressed:text-diff-added aria-pressed:ring-success/30 aria-pressed:hover:bg-success/20"],
  ["COMMENT", "aria-pressed:bg-primary/15 aria-pressed:text-primary aria-pressed:ring-primary/30 aria-pressed:hover:bg-primary/20"],
  ["REQUEST_CHANGES", "aria-pressed:bg-warning/15 aria-pressed:text-warning-text aria-pressed:ring-warning/30 aria-pressed:hover:bg-warning/20"],
] as const;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Finish review, the side panel's view for it: the summary, the verdict (with the agent's suggestion, Use as draft and
 * Request what's left), what goes to GitHub, what stays in BB, and Submit, with each doubt listed beside its fix. After
 * you submit, the receipt offers the next review that needs you. A local review hands its comments to a new thread
 * instead; a closed PR keeps its unsubmitted draft to read.
 */
export function FinishView({ shown, revision }: {
  /** Finish is the panel's view. */
  shown: boolean;
  /** The review revision the page shows, for draft changes. */
  revision: string;
}) {
  const api = useWorkspace();
  const { targetKey, review } = api;
  const d = useDraft();
  const items = useComments(targetKey, "items");
  const isPr = review.kind === "pr";
  const notes = usePrivateNotes(targetKey, shown);
  // What the last Submit here sent, for its receipt.
  const [sent, setSent] = useState<{ comments: number; at: number } | null>(null);
  const submit = (confirmed = false) => {
    if (confirmed || !(d.doubts.length || d.approvingBlocked)) setSent({ comments: d.draft.comments.length, at: Date.now() });
    void d.submit(confirmed);
  };
  // It didn't go: there's no receipt to show.
  useEffect(() => { if (d.status.error) setSent(null); }, [d.status.error]);
  const openList = (filter: CommentFilter, id: string | null = null) => {
    updateComments(targetKey, { filter, expanded: id });
    api.panel.open("comments");
    focusComments(targetKey);
  };

  // The receipt of a review sent from here; one sent earlier is a line above the next one's draft.
  const body = !d.loaded || d.loadError ? null
    : d.closed ? <Archived />
    : d.completed && sent ? <Receipt sent={sent} />
    : null;
  // The panel's header names what shows, as Comments' foot does.
  const title = !body ? null : d.closed ? "Archived review" : "Review submitted";
  useEffect(() => updateComments(targetKey, { finishTitle: title }), [targetKey, title]);
  return (
    <div hidden={!shown} className={cn("flex min-h-0 flex-1 flex-col", !shown && "hidden")}>
      {d.loadError ? <div role="alert" className="space-y-3 p-3 text-sm"><p>Couldn’t load your draft. Editing is paused to protect it.</p><Button variant="outline" className={TOUCH_CONTROL} onClick={() => void d.load()}>Retry draft</Button></div>
        : !d.loaded ? <p role="status" className="p-3 text-sm text-muted-foreground">Loading draft…</p>
        : body ? <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">{body}{notes.show && <PrivateNotes targetKey={targetKey} />}</div>
        : <section aria-label="Review draft" className="flex min-h-0 flex-1 flex-col [@media(max-height:640px)]:overflow-y-auto">
          {/* On short screens the draft and its foot scroll together, so the foot doesn't crowd out the draft. */}
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3 [@media(max-height:640px)]:flex-none [@media(max-height:640px)]:overflow-visible">
            {d.submittedVerdict && <LastReview />}
            <span role="status" className={cn("flex items-center gap-1.5 text-xs", d.status.error ? "text-destructive-text" : "text-muted-foreground")}>{d.status.error ? <Icon name="AlertCircle" className="size-3.5 shrink-0" aria-hidden /> : d.status.saving ? <Icon name="Loading" className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden /> : <Icon name="CircleCheck" className="size-3.5 text-diff-added" aria-hidden />}{d.status.error ?? (d.status.saving ? "Saving…" : "Draft saved")}</span>
            <Part title={isPr ? "Summary · posted with your verdict" : "Summary"}>
              <SummaryCard cardRef={d.summaryRef} draft={d.draft} discussion={d.summaryDiscussion} editable={d.editable} busy={d.busy} writing={d.writing && !d.onSummary} composer={d.summaryComposer} isLocal={d.isLocal} chat={d.chat}
                changedWhileEditing={d.onSummary && !d.asking && d.summaryBase.current !== null && d.summaryBase.current !== d.draft.body}
                onEdit={() => d.openComposer(SUMMARY_AT, false)} onAsk={() => d.openComposer(SUMMARY_AT, false, true)} onRemove={() => void d.saveSummary("", d.revisionRef.current)}
                onUndo={() => void d.undo(SUMMARY_AT)} onRequest={(text) => void d.requestSummary(text)} />
            </Part>
            {isPr && <Verdicts revision={revision} />}
            {isPr ? <GoesToGitHub items={items} replyDrafts={items.filter((item) => item.kind === "thread" && item.replyDraft).length} onList={openList} />
              : <Part title="Stays in BB"><p className="text-sm text-muted-foreground">{d.hint}</p>{notes.show && <PrivateNotes targetKey={targetKey} />}</Part>}
            {(d.isLocal || d.ownPr) && <FixHandoff targetKey={targetKey} comments={d.sortedComments} />}
            {isPr && notes.show && <Part title="Stays in BB"><PrivateNotes targetKey={targetKey} /></Part>}
          </div>
          {!d.isLocal && <SubmitFoot onSubmit={submit} />}
        </section>}
    </div>
  );
}

/** A part of Finish, under its heading. */
function Part({ title, children }: { title: string; children: ReactNode }) {
  const [main, rest] = title.split(" · ");
  return <section className="space-y-2">
    <h3 className="px-0.5 text-[11px] font-semibold uppercase tracking-wider text-subtle-foreground">{main}{rest && <span className="font-normal normal-case tracking-normal"> · {rest}</span>}</h3>
    {children}
  </section>;
}

/** The verdict, the agent's suggestion, and its two ways into the draft: Use as draft and Request what's left. */
function Verdicts({ revision }: { revision: string }) {
  const { targetKey, openFinish } = useWorkspace();
  const d = useDraft();
  const rpc = useRpc<typeof rpcContract>();
  const feedback = useComments(targetKey, "feedback");
  const ownPrId = useId();
  const [busy, setBusy] = useState<"suggested" | "remaining" | null>(null);
  const [confirming, setConfirming] = useState<"suggested" | "remaining" | null>(null);
  const run = feedback?.run ?? null;
  // Blocking feedback the agent's check says isn't done yet.
  const left = !!feedback?.items.some((item) => !item.nonBlocking && item.assessment && item.assessment.verdict !== "addressed");
  // The agent's summary to use as yours, or its word on where the PR stands: readable here, whatever your summary says.
  const said = feedback?.suggestionInDraft ? "" : (run?.suggestedBody || run?.summary || "").trim();
  async function apply(mode: "suggested" | "remaining") {
    const result = await rpc.call("useSuggestedVerdict", { targetKey, mode, ...(revision ? { revision } : {}) });
    if (!result.ok) return void toast.error(result.error ?? "Couldn’t update the draft.");
    openFinish(true);
    toast.success("Draft updated — review it before submitting.");
  }
  // A summary you wrote, saved or still unsaved in this tab, is replaced only once you say so.
  async function suggest(mode: "suggested" | "remaining") {
    setBusy(mode);
    try {
      const { draft } = await rpc.call("getDraft", { targetKey });
      const recovery = readDraftRecovery(targetKey);
      const saved = (draft?.body ?? "").trim();
      const unsaved = (recovery.composer?.summary && !recovery.composer.asking ? recovery.composer.body : recovery.summary?.body ?? "").trim();
      if ((unsaved && unsaved !== saved) || (saved && draft.bodyAuthor !== "agent")) setConfirming(mode);
      else await apply(mode);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Something went wrong");
    } finally { setBusy(null); }
  }
  const replace = () => {
    if (!confirming) return;
    const mode = confirming;
    setConfirming(null);
    setBusy(mode);
    void apply(mode).finally(() => setBusy(null));
  };
  const suggested = d.suggested;
  return (
    <section className="space-y-2">
      <h3 className="px-0.5 text-[11px] font-semibold uppercase tracking-wider text-subtle-foreground">Verdict</h3>
      <div role="group" aria-label="Review verdict" className="flex max-w-full flex-wrap gap-0.5 rounded-lg bg-muted/40 p-1 ring-1 ring-inset ring-border">
        {VERDICTS.map(([verdict, pressed]) => <Button key={verdict} type="button" variant="ghost" size="sm" disabled={d.busy || d.ownPr && verdict !== "COMMENT"} {...(d.ownPr && verdict !== "COMMENT" ? { title: OWN_PR, "aria-describedby": ownPrId } : {})} aria-pressed={d.draft.verdict === verdict} aria-label={suggested === verdict ? `${VERDICT_LABEL[verdict]}, suggested by the agent` : undefined} className={cn("relative h-8 grow basis-auto whitespace-nowrap px-2 text-xs text-muted-foreground ring-1 ring-inset ring-transparent aria-pressed:shadow-xs", TOUCH_CONTROL, suggested === verdict && "pr-4", pressed)} onClick={() => d.chooseVerdict(verdict)}>
          {VERDICT_LABEL[verdict]}{suggested === verdict && <span aria-hidden title="Suggested by the agent" className="absolute right-1 top-1 flex"><Icon name="Sparkles" className="size-2.5 text-(--ansi-13)" /></span>}
        </Button>)}
      </div>
      {d.ownPr && <p id={ownPrId} className="text-xs text-muted-foreground">{OWN_PR}</p>}
      {(suggested && (suggested !== d.draft.verdict || !verdictPicked(d.draft)) && !(d.ownPr && suggested !== "COMMENT") || run && (run.suggestedVerdict || left || said)) && (
        <section aria-label="Agent’s suggestion" className="flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-lg bg-(--ansi-13)/5 px-2.5 py-2">
          <p className="flex min-w-0 flex-1 basis-40 items-center gap-1.5 text-xs text-muted-foreground"><Icon name="Sparkles" className="size-3.5 shrink-0 text-(--ansi-13)" aria-hidden />
            {suggested && !(d.ownPr && suggested !== "COMMENT") ? `Agent suggests ${VERDICT_LABEL[suggested]}` : run?.suggestedVerdict ? `Agent suggests ${VERDICT_LABEL[run.suggestedVerdict]}` : left ? "The agent found open items" : "Agent’s check"}
          </p>
          {said && <div className="min-w-0 basis-full"><Clamped body={said} /></div>}
          {run && (run.suggestedVerdict || left) && <span className="flex flex-wrap gap-1.5">
            {feedback?.suggestionInDraft
              ? <span className="flex items-center gap-1.5 text-xs text-muted-foreground"><Icon name="CircleCheck" className="size-3.5 text-diff-added" aria-hidden />In your draft</span>
              : run.suggestedVerdict && <Button size="sm" variant="outline" className={cn("h-7 px-2 text-xs", TOUCH_CONTROL)} disabled={!!busy || !d.editable} onClick={() => void suggest("suggested")}>Use as draft</Button>}
            {left && <Button size="sm" variant="outline" className={cn("h-7 px-2 text-xs", TOUCH_CONTROL)} disabled={!!busy || !d.editable} onClick={() => void suggest("remaining")}>Request what’s left</Button>}
          </span>}
        </section>
      )}
      <Dialog open={!!confirming} onOpenChange={(open) => { if (!open) setConfirming(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Replace your summary?</DialogTitle>
            <DialogDescription>The agent’s draft replaces the review summary you wrote.</DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:space-x-0">
            <Button variant="outline" className={TOUCH_CONTROL} onClick={() => setConfirming(null)}>Keep mine</Button>
            <Button className={TOUCH_CONTROL} onClick={replace}>Replace summary</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

/** One line of what goes to GitHub, or of what holds it back, with where to see it or fix it. */
function Row({ icon, tone = "neutral", children, action }: { icon: ReactNode; tone?: "neutral" | "warning"; children: ReactNode; action?: ReactNode }) {
  return <li className={cn("flex min-h-11 items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm", tone === "warning" ? "border border-warning/30 bg-warning/10 text-warning-text" : notSubmitted("yours"), tone === "neutral" && "border-l-primary/60 bg-card")}>
    {icon}
    <div className="min-w-0 flex-1">{children}</div>
    {action}
  </li>;
}

/** Goes to GitHub: the comments and their severities, who wrote them, what holds Submit back, and the reply drafts that post on their own. */
function GoesToGitHub({ items, replyDrafts, onList }: { items: readonly CommentItem[]; replyDrafts: number; onList: (filter: CommentFilter, id?: string | null) => void }) {
  const d = useDraft();
  const { reveal } = useWorkspace();
  const comments = d.draft.comments;
  const agent = comments.filter((comment) => comment.author === "agent").length;
  const older = items.filter((item) => item.kind === "draft" && item.state === "older-diff");
  const blocking = items.find((item) => item.kind === "draft" && item.comment.severity === "blocking");
  const link = (label: string, onClick: () => void) => <Button variant="ghost" size="sm" aria-label={label} className={cn("size-8 shrink-0 px-0 text-muted-foreground", TOUCH_CONTROL)} onClick={onClick}><Icon name="ChevronRight" aria-hidden /></Button>;
  const fix = (label: string, onClick: () => void) => <Button variant="outline" size="sm" className={cn("h-7 shrink-0 px-2 text-xs", TOUCH_CONTROL)} onClick={onClick}>{label}</Button>;
  return (
    <Part title="Goes to GitHub">
      <ul className="space-y-1.5">
        <Row icon={<Icon name="CircleDashed" className="size-4 shrink-0 text-primary" aria-hidden />} action={comments.length > 0 && link("Show the comments to send", () => onList("not-submitted"))}>
          <MetaLine className="text-sm text-foreground" items={[comments.length ? plural(comments.length, "comment") : "No line comments", ...(d.counts ? d.counts.split(" · ").map((count) => <span className="text-muted-foreground">{count}</span>) : [])]} />
          {agent > 0 && <p className="text-xs text-muted-foreground">{agent} written by the agent</p>}
        </Row>
        {older.length > 0 && <Row tone="warning" icon={<Icon name="AlertTriangle" className="size-4 shrink-0" aria-hidden />} action={link("Show the comments on an older diff", () => onList("needs-you", older[0].id))}>
          {plural(older.length, "comment")} on an older diff: edit or remove {older.length === 1 ? "it" : "them"}
        </Row>}
        {replyDrafts > 0 && <Row icon={<Icon name="CornerDownRight" className="size-4 shrink-0 text-primary" aria-hidden />} action={link("Show the reply drafts", () => onList("all", items.find((item) => item.kind === "thread" && item.replyDraft)?.id ?? null))}>
          {plural(replyDrafts, "reply draft")} not sent: replies post on their own
        </Row>}
        {d.writing && <Row tone="warning" icon={<Icon name="Edit" className="size-4 shrink-0" aria-hidden />} action={!d.onSummary && fix("Show", () => d.inline ? reveal({ file: d.file, line: Number(d.line), side: d.side }) : onList("all"))}>
          {d.onSummary ? "You’re writing the summary" : d.asking ? <>You’re writing to the agent about <span className="font-mono text-xs">{d.file}:{d.boxLines}</span></> : <>You’re writing a comment on <span className="font-mono text-xs">{d.file}:{d.boxLines}</span></>}
        </Row>}
        {d.needsSummary && <Row tone="warning" icon={<Icon name="AlertCircle" className="size-4 shrink-0" aria-hidden />} action={d.editable && !d.writing && fix("Write it", () => d.openComposer(SUMMARY_AT, false))}>Request changes needs a summary: say what has to change.</Row>}
        {d.suggested && d.suggested !== d.draft.verdict && !d.ownPr && <Row tone="warning" icon={<Icon name="Sparkles" className="size-4 shrink-0" aria-hidden />} action={d.editable && fix(`Switch to ${VERDICT_LABEL[d.suggested]}`, () => d.chooseVerdict(d.suggested!))}>
          The agent suggested {VERDICT_LABEL[d.suggested]}.
        </Row>}
        {d.approvingBlocked && <Row tone="warning" icon={<Icon name="AlertTriangle" className="size-4 shrink-0" aria-hidden />} action={blocking && fix("Show", () => onList("not-submitted", blocking.id))}>
          Approving with {plural(d.blockingCount, "blocking comment")}.
        </Row>}
      </ul>
    </Part>
  );
}

/** Submit, pinned: the verdict on it, where it posts and as whom, or why it waits; and the one more ask when in doubt. */
function SubmitFoot({ onSubmit }: { onSubmit: (confirmed?: boolean) => void }) {
  const { review } = useWorkspace();
  const d = useDraft();
  const blocked = d.busy || d.rebuilding || !d.hasReview || d.writing || d.needsSummary || d.staleComments.length > 0;
  const where = review.repo && review.number ? `${review.repo}#${review.number}` : null;
  const ready = d.hint === "Drafts stay in BB until you submit.";
  return (
    <footer className="shrink-0 space-y-2 border-t border-border p-3">
      {d.confirming ? <div role="alert" className="space-y-2 rounded-lg border border-warning/25 bg-warning/10 p-2.5 text-xs leading-relaxed text-warning-text">
        <p>{d.approvingBlocked ? `Approve with ${plural(d.blockingCount, "blocking comment")}?` : `Submit ${VERDICT_LABEL[d.draft.verdict]}${d.commentCount ? ` with ${plural(d.commentCount, "comment")}` : ""}?`} {d.doubts.join(" ")}</p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" className={TOUCH_CONTROL} disabled={blocked} onClick={() => onSubmit(true)}>Submit anyway</Button>
          <Button ref={d.confirmCancelRef} size="sm" variant="ghost" className={TOUCH_CONTROL} onClick={() => { d.setConfirming(false); requestAnimationFrame(() => d.submitRef.current?.focus()); }}>Cancel</Button>
        </div>
      </div>
      : <Button ref={d.submitRef} className={cn("w-full gap-2", TOUCH_CONTROL)} disabled={blocked} onClick={() => onSubmit()}>
          {d.busy ? <Icon name="Loading" className="size-4 animate-spin motion-reduce:animate-none" aria-hidden /> : <Icon name="Github" className="size-4" aria-hidden />}
          {d.busy ? "Saving…" : `Submit to GitHub · ${VERDICT_LABEL[d.draft.verdict]}`}
        </Button>}
      <p className="text-xs leading-relaxed text-muted-foreground">{ready && where ? <>Posts to {where}{d.account ? <> as @{d.account}</> : null}.</> : d.hint}</p>
    </footer>
  );
}

/** A closed or merged PR's review: archived, with its unsubmitted draft to read. */
function Archived() {
  const { review } = useWorkspace();
  const d = useDraft();
  const merged = review.prState === "MERGED";
  return (
    <section aria-label="Archived review" className="space-y-2 rounded-lg border border-border bg-muted/25 p-3">
      <p className="flex items-center gap-2 text-sm font-medium"><Icon name={merged ? "GitMerge" : "GitPullRequestClosed"} className={cn("size-4", merged ? "text-pr-merged" : "text-destructive-text")} aria-hidden />{merged ? "Merged" : "Closed"} · Archived</p>
      <p className="text-xs leading-relaxed text-muted-foreground">This review is saved in Archive. The guide, notes, and conversation remain available.</p>
      {(d.draft.comments.length > 0 || d.draft.body) && <details className="text-sm"><summary className="cursor-pointer">Unsubmitted draft</summary><p className="mt-2 whitespace-pre-wrap">{d.draft.body}</p>{d.draft.comments.map((comment, index) => <p key={index} className="mt-2 break-words">{comment.file}:{comment.line} — {comment.body}</p>)}</details>}
    </section>
  );
}

/** Your last review, sent before: its verdict, when, and where it is on GitHub. */
function LastReview() {
  const { review } = useWorkspace();
  const d = useDraft();
  const url = d.receiptUrl ?? review.url;
  return (
    <section aria-label="Submitted review" className="flex min-h-11 flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-success/25 bg-success/10 px-3 py-1.5 text-xs">
      <Icon name="BadgeCheck" className="size-4 shrink-0 text-diff-added" aria-hidden />
      <span className="font-medium text-diff-added">{RECEIPT_LABEL[d.submittedVerdict!]}</span>
      {age(review.submittedAt) && <span className="text-muted-foreground">· your last review, {age(review.submittedAt)} ago</span>}
      {url && <UrlLink href={url} className={cn("relative ml-auto text-primary hover:underline", TOUCH_TARGET)}>View on GitHub</UrlLink>}
    </section>
  );
}

/** After Submit: what went where, and the next review that needs you. */
function Receipt({ sent }: { sent: { comments: number; at: number } | null }) {
  const api = useWorkspace();
  const { review, targetKey } = api;
  const d = useDraft();
  const rpc = useRpc<typeof rpcContract>();
  const [next, setNext] = useState<ReviewItem | null | undefined>();
  useEffect(() => {
    let cancelled = false;
    rpc.call("listReviews", null).then(({ reviews }) => {
      if (cancelled) return;
      const waiting = (reviews as ReviewItem[]).filter((other) => other.targetKey !== targetKey && reviewState(other).group === "needs").sort(needsOrder);
      setNext(waiting[0] ?? null);
    }, () => { if (!cancelled) setNext(null); });
    return () => { cancelled = true; };
  }, [rpc, targetKey]);
  const verdict = d.submittedVerdict!;
  const where = review.repo && review.number ? `${review.repo}#${review.number}` : null;
  const when = sent?.at ?? review.submittedAt ?? null;
  const url = d.receiptUrl ?? review.url;
  return <>
    <section aria-label="Submitted review" className="space-y-3 rounded-lg border border-success/25 bg-success/10 p-3">
      <p className="flex items-center gap-2 text-sm font-medium text-diff-added"><Icon name="BadgeCheck" className="size-5" aria-hidden />{RECEIPT_LABEL[verdict]}</p>
      <div className="space-y-0.5 text-xs text-muted-foreground">
        <p>{where ? <>Posted to {where}{d.account ? <> as @{d.account}</> : null}</> : "Review submitted to GitHub"}{age(when) && ` · ${age(when)}`}</p>
        {sent && <p>{plural(sent.comments, "comment")}</p>}
      </div>
      <div className="flex flex-wrap gap-2">
        {url && <UrlLink href={url} className={cn(buttonVariants({ variant: "outline", size: "sm" }), TOUCH_CONTROL)}><Icon name="Github" className="size-4" aria-hidden />View on GitHub</UrlLink>}
        <Button variant="outline" size="sm" className={TOUCH_CONTROL} onClick={() => d.setWriteAnother(true)}>Add another review</Button>
      </div>
    </section>
    {next !== undefined && <section aria-label="Next review" className="space-y-2 border-t border-border pt-3">
      {next ? <>
        <h3 className="px-0.5 text-[11px] font-semibold uppercase tracking-wider text-subtle-foreground">Next in Needs review</h3>
        <div className="flex min-h-11 items-center gap-2 rounded-lg border border-border bg-card py-1.5 pl-3 pr-1.5">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium"><InlineCode text={next.title ?? next.gitRef ?? next.targetKey} /></p>
            <p className="truncate text-xs text-muted-foreground">{[statusWhy(next)?.text, next.number ? `#${next.number}` : null, age(reviewState(next).at ?? next.createdAt)].filter(Boolean).join(" · ")}</p>
          </div>
          <Button size="sm" className={cn("shrink-0", TOUCH_CONTROL)} onClick={() => void api.leave(next.targetKey)}>Open</Button>
        </div>
      </> : <p className="text-sm text-muted-foreground">Nothing else needs you right now.</p>}
      <Button variant="ghost" size="sm" className={cn("-ml-2 text-muted-foreground", TOUCH_CONTROL)} onClick={() => void api.leave()}><Icon name="ChevronLeft" className="size-4" aria-hidden />All reviews</Button>
    </section>}
  </>;
}

/** Whether Finish shows your private notes: only when you have some, or an unsaved copy waits in this browser. */
function usePrivateNotes(targetKey: string, shown: boolean): { show: boolean } {
  const rpc = useRpc<typeof rpcContract>();
  const [show, setShow] = useState(false);
  const checked = useRef(false);
  useEffect(() => {
    if (!shown || checked.current) return;
    checked.current = true;
    let backup = false;
    try { backup = !!JSON.parse(localStorage.getItem(`gr:notes-draft:${targetKey}`) ?? "null")?.body; } catch { /* best effort */ }
    if (backup) { setShow(true); return; }
    rpc.call("getReviewerNotes", { targetKey }).then(({ body }) => { if (body.trim()) setShow(true); }, () => {});
  }, [rpc, targetKey, shown]);
  return useMemo(() => ({ show }), [show]);
}

/** Your private notes from before notes were retired: read, edit, or clear them here. */
function PrivateNotes({ targetKey }: { targetKey: string }) {
  return (
    <details className="group/notes rounded-lg border border-border bg-muted/20">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3 py-2 text-sm font-medium [&::-webkit-details-marker]:hidden">
        <Icon name="Lock" className="size-3.5 text-subtle-foreground" aria-hidden />Private notes
        <Icon name="ChevronDown" className="ml-auto size-3.5 text-subtle-foreground transition-transform duration-150 group-open/notes:rotate-180" aria-hidden />
      </summary>
      <div className="border-t border-border"><ReviewerNotes targetKey={targetKey} /></div>
    </details>
  );
}
