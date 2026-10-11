import { memo, useId, useRef, useState } from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { UrlLink } from "@get-bb/plugin-sdk/app";
import { linesOf, sameLocation, SEVERITY_LABEL, SUMMARY_AT, VERDICT_LABEL, verdictPicked, type Discussion, type Verdict } from "../src/draft";
import { Button, buttonVariants } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { Icon } from "./ui/icon";
import { Badge } from "./ui/badge";
import { FilePath } from "./ui/file-path";
import { ReviewerNotes } from "./ReviewerNotes";
import { cn } from "../lib/utils";
import { AgentDock } from "./AgentDock";
import { usePortalScopeProps } from "../lib/portal-scope";
import { CommentBody, ComposerNotes, composerKeys, locationKey, SeverityBadge, SeveritySelect } from "./InlineDraft";
import { SummaryCard } from "./SummaryCard";
import { FixHandoff } from "./FixHandoff";
import { useDraft } from "./DraftProvider";

const OWN_PR = "This is your PR, so GitHub allows only a Comment review.";
const RECEIPT_LABEL: Record<Verdict, string> = { APPROVE: "Approved", REQUEST_CHANGES: "Changes requested", COMMENT: "Commented" };
const VERDICTS = [
  ["APPROVE", "aria-pressed:bg-success/15 aria-pressed:text-diff-added aria-pressed:ring-success/30 aria-pressed:hover:bg-success/20"],
  ["COMMENT", "aria-pressed:bg-primary/15 aria-pressed:text-primary aria-pressed:ring-primary/30 aria-pressed:hover:bg-primary/20"],
  ["REQUEST_CHANGES", "aria-pressed:bg-warning/15 aria-pressed:text-warning-text aria-pressed:ring-warning/30 aria-pressed:hover:bg-warning/20"],
] as const;

/** The review tools: a rail, or a bar on a narrow pane, with Draft review, Reviewer notes, and the agent. DraftProvider owns what it shows. */
export const DraftPanel = memo(function DraftPanel() {
  const {
    targetKey, agent, tab, setTab, toolsOpen, setToolsOpen, loadError, load, loaded, closed, review, draft, completed, submittedVerdict, receiptUrl, setWriteAnother, status,
    summaryRef, summaryDiscussion, editable, busy, writing, onSummary, summaryComposer, isLocal, chat, asking, summaryBase, openComposer, saveSummary, revisionRef, undo, requestSummary,
    showComposer, inline, counts, hideNits, nitCount, toggleNits, removeNits, listRef, sortedComments, stale, discussions, onShowComment, body, removeComment,
    file, boxLines, line, side, files, setFile, editing, startLine, setLine, setSide, bodyRef, changeBody, canAdd, addComment, cancelComposer, composerError, rebuilding, olderDiff, keepOnCurrentDiff, composerControls, severity, setSeverity, suggestable, suggestChange,
    ownPr, suggested, chooseVerdict, confirming, setConfirming, approvingBlocked, blockingCount, commentCount, doubts, hasReview, needsSummary, staleComments, submit, confirmCancelRef, submitRef, hint,
  } = useDraft();
  const panelId = useId();
  const railRef = useRef<HTMLDivElement>(null);
  const scopeProps = usePortalScopeProps();
  // The rail's open tooltip. Collapsing focuses the rail, which would open one over the toolbar.
  const [railTip, setRailTip] = useState<string | null>(null);
  function collapse() {
    setToolsOpen(false);
    railRef.current?.querySelector<HTMLButtonElement>(`[data-tool="${tab}"]`)?.focus();
    setRailTip(null);
  }
  function selectTool(next: typeof tab) {
    if (toolsOpen && tab === next) collapse();
    else { setTab(next); setToolsOpen(true); }
  }
  const ownPrId = useId();
  const toolItems = [
    { id: "draft", label: "Draft review", icon: "MessageSquare", count: draft.comments.length },
    { id: "notes", label: "Reviewer notes", icon: "EditFile", count: 0 },
    ...(agent ? [{ id: "agent", label: "Ask agent", icon: "BubbleChatSpark", count: 0 }] as const : []),
  ] as const;
  return <aside aria-label="Review tools" className={cn("flex max-h-[50vh] min-h-0 shrink-0 flex-col border-t border-border bg-background @min-[1024px]/review:h-full @min-[1024px]/review:max-h-none @min-[1024px]/review:flex-row-reverse @min-[1024px]/review:border-l @min-[1024px]/review:border-t-0", toolsOpen ? "@min-[1024px]/review:w-[384px]" : "@min-[1024px]/review:w-11", toolsOpen && tab === "agent" && "h-[50vh]")}>
    <div ref={railRef} role="group" aria-label="Review tools" className={cn("flex h-11 shrink-0 items-center gap-0.5 bg-surface-raised p-0.5 @min-[1024px]/review:h-full @min-[1024px]/review:w-11 @min-[1024px]/review:flex-col @min-[1024px]/review:gap-1 @min-[1024px]/review:pt-1.5", toolsOpen && "border-b border-border @min-[1024px]/review:border-b-0 @min-[1024px]/review:border-l")}>
      <Tooltip.Provider delayDuration={350}>
        {toolItems.map((tool) => <Tooltip.Root key={tool.id} open={railTip === tool.id} onOpenChange={(open) => setRailTip((tip) => open ? tool.id : tip === tool.id ? null : tip)}>
          <Tooltip.Trigger asChild>
            <Button variant="ghost" size="icon" data-tool={tool.id} aria-label={tool.label} aria-pressed={toolsOpen && tab === tool.id} aria-expanded={toolsOpen && tab === tool.id} aria-controls={panelId} onClick={() => selectTool(tool.id)} className={cn("relative size-10 shrink-0 rounded-lg text-muted-foreground aria-pressed:bg-primary/10 aria-pressed:text-primary aria-pressed:hover:bg-primary/15 [&_svg]:size-[18px]", tool.id === "agent" && "aria-pressed:bg-(--ansi-13)/10 aria-pressed:text-(--ansi-13) aria-pressed:hover:bg-(--ansi-13)/15", toolsOpen && tab === tool.id && "after:absolute after:inset-x-2.5 after:-bottom-0.5 after:h-0.5 after:rounded-full after:bg-current @min-[1024px]/review:after:inset-y-2.5 @min-[1024px]/review:after:-right-0.5 @min-[1024px]/review:after:left-auto @min-[1024px]/review:after:h-auto @min-[1024px]/review:after:w-0.5")}>
              <Icon name={tool.icon} aria-hidden />
              {tool.count > 0 && <span aria-hidden className="absolute right-0.5 top-0.5 min-w-4 rounded-full bg-primary px-1 text-center text-[10px] font-semibold leading-4 text-primary-foreground ring-2 ring-background">{tool.count > 99 ? "99+" : tool.count}</span>}
            </Button>
          </Tooltip.Trigger>
          <Tooltip.Portal container={agent?.container ?? undefined}><Tooltip.Content {...scopeProps} side="left" sideOffset={8} collisionPadding={8} className="z-[75] rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md">{tool.label}{tool.count > 0 ? ` (${tool.count})` : ""}</Tooltip.Content></Tooltip.Portal>
        </Tooltip.Root>)}
      </Tooltip.Provider>
      <span className="ml-auto min-w-0 truncate px-2 text-xs text-muted-foreground @min-[1024px]/review:hidden">{toolsOpen ? toolItems.find((tool) => tool.id === tab)?.label : "Review tools"}</span>
      {toolsOpen && <Button variant="ghost" size="icon" className="size-8 shrink-0 text-muted-foreground @min-[1024px]/review:hidden" aria-label="Collapse review panel" onClick={collapse}><Icon name="X" aria-hidden /></Button>}
    </div>
    <div id={panelId} hidden={!toolsOpen} className={cn("flex min-h-0 min-w-0 flex-1 flex-col", !toolsOpen && "hidden")}>
      {tab !== "agent" && <div className="hidden h-11 shrink-0 items-center gap-2 border-b border-border px-3 @min-[1024px]/review:flex"><Icon name={tab === "draft" ? "MessageSquare" : "EditFile"} className="size-4 text-primary" aria-hidden /><h2 className="min-w-0 truncate text-sm font-medium">{tab === "draft" ? "Draft review" : "Reviewer notes"}</h2><span className="flex-1" /><Button variant="ghost" size="icon" className="size-7 text-muted-foreground" aria-label="Collapse review panel" onClick={collapse}><Icon name="X" aria-hidden /></Button></div>}
    {agent && <AgentDock targetKey={targetKey} {...agent} active={toolsOpen && tab === "agent"} onDock={() => { setTab("agent"); setToolsOpen(true); }} onCollapse={collapse} />}
    <div hidden={tab !== "notes"} className={cn("min-h-0 overflow-y-auto", tab !== "notes" && "hidden")}><ReviewerNotes targetKey={targetKey} /></div>
    <div hidden={tab !== "draft"} className={cn("flex min-h-0 flex-1 flex-col", tab !== "draft" && "hidden")}>
      {loadError ? <div role="alert" className="space-y-3 overflow-y-auto p-3 text-sm"><p>Couldn’t load your draft. Editing is paused to protect it.</p><Button variant="outline" onClick={() => void load()}>Retry draft</Button></div> : !loaded ? <p role="status" className="p-3 text-sm text-muted-foreground">Loading draft…</p> : closed ?
        <div className="min-h-0 overflow-y-auto"><section aria-label="Archived review" className="m-3 space-y-2 rounded-lg border border-border bg-muted/25 p-3">
          <p className="flex items-center gap-2 text-sm font-medium"><Icon name={review?.prState === "MERGED" ? "GitMerge" : "GitPullRequestClosed"} className={cn("size-4", review?.prState === "MERGED" ? "text-pr-merged" : "text-destructive-text")} aria-hidden />{review?.prState === "MERGED" ? "Merged" : "Closed"} · Archived</p>
          <p className="text-xs leading-relaxed text-muted-foreground">This review is saved in Archive. The guide, notes, and conversation remain available.</p>
          {(draft.comments.length > 0 || draft.body) && <details className="text-sm"><summary className="cursor-pointer">Unsubmitted draft</summary><p className="mt-2 whitespace-pre-wrap">{draft.body}</p>{draft.comments.map((comment, index) => <p key={index} className="mt-2 break-words">{comment.file}:{comment.line} — {comment.body}</p>)}</details>}
        </section></div> : completed ?
        <section aria-label="Submitted review" className="m-3 space-y-3 rounded-lg border border-success/25 bg-success/10 p-3">
          <p className="flex items-center gap-2 text-sm font-medium text-diff-added"><Icon name="BadgeCheck" className="size-5" aria-hidden />{RECEIPT_LABEL[submittedVerdict!]}</p>
          <p className="text-xs text-muted-foreground">Review submitted to GitHub</p>
          <div className="flex flex-wrap gap-2">
            {(receiptUrl ?? review?.url) && <UrlLink href={(receiptUrl ?? review?.url)!} className={buttonVariants({ variant: "outline", size: "sm" })}><Icon name="Github" className="size-4" aria-hidden />View on GitHub</UrlLink>}
            <Button variant="outline" size="sm" onClick={() => setWriteAnother(true)}>Add another review</Button>
          </div>
        </section> : <section aria-label="Review draft" className="flex min-h-0 flex-1 flex-col [@media(max-height:560px)]:overflow-y-auto">
          {/* On short screens the draft and its foot scroll together, so the foot doesn't crowd out the draft. */}
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 [@media(max-height:560px)]:flex-none [@media(max-height:560px)]:overflow-visible">
            <span role="status" className={cn("flex items-center gap-1.5 text-xs", status.error ? "text-destructive-text" : "text-muted-foreground")}>{status.error ? <Icon name="AlertCircle" className="size-3.5 shrink-0" aria-hidden /> : status.saving ? <Icon name="Loading" className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden /> : <Icon name="CircleCheck" className="size-3.5 text-diff-added" aria-hidden />}{status.error ?? (status.saving ? "Saving…" : "Draft saved")}</span>
            <SummaryCard cardRef={summaryRef} draft={draft} discussion={summaryDiscussion} editable={editable} busy={busy} writing={writing && !onSummary} composer={summaryComposer} isLocal={isLocal} chat={chat}
              changedWhileEditing={onSummary && !asking && summaryBase.current !== null && summaryBase.current !== draft.body}
              onEdit={() => openComposer(SUMMARY_AT, false)} onAsk={() => openComposer(SUMMARY_AT, false, true)} onRemove={() => void saveSummary("", revisionRef.current)}
              onUndo={() => void undo(SUMMARY_AT)} onRequest={(text) => void requestSummary(text)} />
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-subtle-foreground">Line comments</h3>
              {draft.comments.length > 0 && <span className="rounded-full bg-muted px-1.5 text-[11px] leading-[18px] tabular-nums text-muted-foreground">{draft.comments.length}</span>}
              <span className="flex-1" />
              <Button variant="ghost" size="sm" className="-mr-2 text-primary hover:text-primary" aria-expanded={showComposer && !inline && !onSummary} onClick={() => openComposer(null, false)}><Icon name="Plus" className="size-4" aria-hidden /> Add comment</Button>
            </div>
            {counts && <div className="-mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              <span className="tabular-nums">{counts}{hideNits && nitCount > 0 && ` · ${nitCount} hidden`}</span>
              {nitCount > 0 && <span className="-mr-2 ml-auto flex gap-0.5">
                <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground aria-pressed:bg-primary/10 aria-pressed:text-primary" aria-pressed={hideNits} onClick={toggleNits}><Icon name={hideNits ? "EyeOff" : "Eye"} className="size-3.5" aria-hidden />Hide nits</Button>
                <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive-text" disabled={busy} onClick={() => void removeNits()}><Icon name="Trash2" className="size-3.5" aria-hidden />Remove nits</Button>
              </span>}
            </div>}
            {draft.comments.length ? <ul ref={listRef} className="space-y-2 text-sm">{sortedComments.filter((comment) => !(hideNits && comment.severity === "nit")).map((comment) => {
              const isStale = stale.some((at) => sameLocation(at, comment));
              const discussion = discussions.find((d) => sameLocation(d, comment));
              const messages = discussion?.entries.filter((entry) => entry.kind === "message").length ?? 0;
              return <li key={`${comment.file}:${comment.line}:${comment.side}`} tabIndex={-1} data-comment-at={locationKey(comment)} className={cn("group/comment space-y-2 rounded-lg border border-border bg-card p-3 outline-none transition-colors hover:border-input focus-visible:ring-2 focus-visible:ring-ring/50", comment.author === "agent" ? "border-l-[3px] border-l-(--ansi-13)/60" : "border-l-[3px] border-l-primary/60")}>
              <button type="button" aria-label={`${comment.file}:${linesOf(comment)}${comment.side === "LEFT" ? " · Old line" : ""}${comment.severity ? ` · ${SEVERITY_LABEL[comment.severity]}` : ""}${comment.author === "agent" ? " · Added by agent" : ""}${isStale ? " · Older diff" : ""}${discussionLabel(discussion)}`} className="flex w-full min-w-0 flex-wrap items-center gap-1.5 rounded-sm text-left text-xs hover:[&_.gr-path]:underline" onClick={() => onShowComment?.(comment)}>
                <span className="gr-path flex min-w-0 max-w-full items-center decoration-muted-foreground/50 underline-offset-2"><FilePath path={comment.file} className="min-w-0 text-[11px]" /><span className="shrink-0 font-mono text-[11px] text-primary">:{linesOf(comment)}</span></span>
                {comment.side === "LEFT" && <Badge size="sm">Old line</Badge>}
                {comment.severity && <SeverityBadge severity={comment.severity} size="sm" />}
                {comment.author === "agent" && <Badge tone="agent" size="sm" icon={<Icon name="Sparkles" aria-hidden />}>Agent</Badge>}
                {isStale && <Badge tone="warning" size="sm">Older diff</Badge>}
                {discussion?.waiting ? <Badge tone="agent" dot pulse size="sm">Waiting for agent</Badge> : messages > 0 && <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground"><Icon name="MessageSquare" className="size-3" aria-hidden />{messages}</span>}
              </button>
              <CommentBody body={comment.body} />
              <div className="-mb-1 -ml-2 flex gap-0.5"><Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground" disabled={busy || !!body.trim()} aria-label={`Edit comment on ${comment.file}:${linesOf(comment)}`} onClick={() => openComposer(comment, false)}><Icon name="Edit" className="size-3.5" aria-hidden />Edit</Button><Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive-text" disabled={busy} aria-label={`Remove comment on ${comment.file}:${linesOf(comment)}`} onClick={() => void removeComment(comment)}><Icon name="Trash2" className="size-3.5" aria-hidden />Remove</Button></div>
            </li>; })}</ul> : !(showComposer && !onSummary) && <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-4 py-6 text-center"><Icon name="MessageSquarePlus" className="size-5 text-subtle-foreground" aria-hidden /><p className="text-sm leading-relaxed text-muted-foreground">Select a line in the diff or add a comment here.</p></div>}
            {showComposer && !onSummary && (inline ? <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3 text-xs text-muted-foreground">
              <span className="min-w-0 flex-1 break-words">{asking ? `Writing to the agent about ${file}:${boxLines} in the diff.` : `Writing a comment on ${file}:${boxLines} in the diff.`}</span>
              <Button variant="ghost" size="sm" onClick={() => onShowComment?.({ file, line: Number(line), side })}>Show in diff</Button>
            </div> : <div className="space-y-3 border-t border-border pt-3">
              <label className="block space-y-1 text-xs text-muted-foreground">File<select aria-label="Comment file" disabled={busy || !!editing} className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground" value={file} onChange={(event) => setFile(event.target.value)}>{(file && !files.includes(file) ? [file, ...files] : files).map((choice) => <option key={choice} value={choice}>{choice}</option>)}</select></label>
              <div className="grid grid-cols-[80px_minmax(0,1fr)] gap-3">
                {startLine ? <p className="space-y-1 text-xs text-muted-foreground">Lines<span className="flex h-9 items-center text-sm text-foreground tabular-nums">{boxLines}</span></p>
                  : <label className="space-y-1 text-xs text-muted-foreground">Line<Input aria-label="Comment line" disabled={busy || !!editing} type="number" min={1} value={line} onChange={(event) => setLine(event.target.value)} /></label>}
                <label className="space-y-1 text-xs text-muted-foreground">Side<select aria-label="Comment side" disabled={busy || !!editing} className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground" value={side} onChange={(event) => setSide(event.target.value as "LEFT" | "RIGHT")}><option value="RIGHT">New line</option><option value="LEFT">Old line</option></select></label>
              </div>
              <Textarea ref={bodyRef} aria-label="Draft comment" disabled={busy} value={body} onChange={(event) => changeBody(event.target.value)} onKeyDown={(event) => composerKeys(event, canAdd ? () => void addComment() : null, () => { if (!busy) cancelComposer(); })} placeholder="What should the author know?" />
              <ComposerNotes error={composerError} rebuilding={rebuilding} keepOnCurrentDiff={olderDiff ? keepOnCurrentDiff : null} />
              <div ref={composerControls} data-composer-controls className="flex flex-wrap gap-2"><Button disabled={!canAdd} onClick={() => void addComment()}>{editing ? "Save comment" : "Add to draft"}</Button><Button variant="ghost" disabled={busy} onClick={cancelComposer}>Cancel</Button><span className="ml-auto flex flex-wrap gap-2"><SeveritySelect className="h-9 text-sm" value={severity} onChange={setSeverity} disabled={busy} />{suggestable && <Button variant="outline" disabled={busy} onClick={suggestChange}><Icon name="Edit" className="size-3.5" aria-hidden />Suggest change</Button>}</span></div>
            </div>)}
            {(isLocal || ownPr) && <FixHandoff targetKey={targetKey} comments={sortedComments} />}
          </div>
          <footer className="shrink-0 space-y-2.5 border-t border-border p-3">
            {!isLocal && <>
              <div role="group" aria-label="Review verdict" className="flex max-w-full flex-wrap gap-0.5 rounded-lg bg-muted/40 p-1 ring-1 ring-inset ring-border">
                {VERDICTS.map(([verdict, pressed]) => <Button key={verdict} type="button" variant="ghost" size="sm" disabled={busy || ownPr && verdict !== "COMMENT"} {...(ownPr && verdict !== "COMMENT" ? { title: OWN_PR, "aria-describedby": ownPrId } : {})} aria-pressed={draft.verdict === verdict} aria-label={suggested === verdict ? `${VERDICT_LABEL[verdict]}, suggested by the agent` : undefined} className={cn("relative h-8 grow basis-auto whitespace-nowrap px-2 text-xs text-muted-foreground ring-1 ring-inset ring-transparent aria-pressed:shadow-xs", suggested === verdict && "pr-3.5", pressed)} onClick={() => chooseVerdict(verdict)}>
                  {VERDICT_LABEL[verdict]}{suggested === verdict && <span aria-hidden title="Suggested by the agent" className="absolute right-0.5 top-0.5 flex"><Icon name="Sparkles" className="size-2.5 text-(--ansi-13)" /></span>}
                </Button>)}
              </div>
              {ownPr && <p id={ownPrId} className="text-xs text-muted-foreground">{OWN_PR}</p>}
              {suggested && (suggested !== draft.verdict || !verdictPicked(draft)) && !(ownPr && suggested !== "COMMENT") && <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Icon name="Sparkles" className="size-3.5 shrink-0 text-(--ansi-13)" aria-hidden />Agent suggests {VERDICT_LABEL[suggested]}</p>}
              {confirming ? <div role="alert" className="space-y-2 rounded-lg border border-warning/25 bg-warning/10 p-2.5 text-xs leading-relaxed text-warning-text">
                <p>{approvingBlocked ? `Approve with ${blockingCount} blocking comment${blockingCount === 1 ? "" : "s"}?` : `Submit ${VERDICT_LABEL[draft.verdict]}${commentCount ? ` with ${commentCount} comment${commentCount === 1 ? "" : "s"}` : ""}?`} {doubts.join(" ")}</p>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" disabled={busy || rebuilding || !hasReview || writing || needsSummary || staleComments.length > 0} onClick={() => void submit(true)}>Submit anyway</Button>
                  <Button ref={confirmCancelRef} size="sm" variant="ghost" onClick={() => { setConfirming(false); requestAnimationFrame(() => submitRef.current?.focus()); }}>Cancel</Button>
                </div>
              </div>
              : <Button ref={submitRef} className="w-full gap-2" disabled={busy || rebuilding || !hasReview || writing || needsSummary || staleComments.length > 0} onClick={() => void submit()}>{busy ? <Icon name="Loading" className="size-4 animate-spin motion-reduce:animate-none" aria-hidden /> : <Icon name="Github" className="size-4" aria-hidden />}{busy ? "Saving…" : "Submit to GitHub"}</Button>}
            </>}
            <p className="text-xs leading-relaxed text-muted-foreground">{hint}</p>
          </footer>
        </section>}
    </div>
    </div>
  </aside>;
});
DraftPanel.displayName = "DraftPanel";

/** How a comment's discussion with the agent reads in the panel. */
function discussionLabel(discussion: Discussion | undefined): string {
  if (!discussion) return "";
  const messages = discussion.entries.filter((entry) => entry.kind === "message").length;
  return `${messages ? ` · ${messages} message${messages === 1 ? "" : "s"}` : ""}${discussion.waiting ? " · Waiting for agent" : ""}`;
}
