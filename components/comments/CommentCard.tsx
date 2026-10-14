import { useRef, useState, type ReactNode } from "react";
import { Markdown, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { linesOf, sameLocation } from "../../src/draft";
import { withLineBreaks } from "../../src/line-breaks";
import type { AskItem, CommentItem, DraftItem, PrivateItem, ThreadItem, ThreadMessage } from "../../lib/comments";
import { cn } from "../../lib/utils";
import { useWorkspaceFor } from "../../lib/workspace-store";
import { useDraft } from "../DraftProvider";
import { CommentBody, ComposerFields, DiscussionView, SeverityBadge, type InlineComposer } from "../InlineDraft";
import { age } from "../time-ago";
import { TOUCH_CONTROL } from "../touch";
import { Avatar } from "../ui/avatar";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { InlineCode } from "../ui/inline-code";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { CheckBadge, frameOf, plainLine, TAG_TONE, ThreadState } from "./look";
import { ReplyBox } from "./ReplyBox";
import { useComments } from "./store";

/** In the code: inside pierre's code view, so it sets its own text style rather than inheriting the code's. */
const INLINE_CARD = "mx-2 my-2 max-w-3xl overflow-hidden rounded-lg bg-card [contain:inline-size] font-sans text-sm leading-normal whitespace-normal text-foreground shadow-md";
/** A card's head, and the small actions in it. */
export const HEAD = "flex min-h-9 flex-wrap items-center gap-x-2 gap-y-1 px-3 py-1.5 text-xs text-muted-foreground";
const ACTION = cn("h-7 px-2 text-xs text-muted-foreground", TOUCH_CONTROL);

/** "src/a.ts:2", "src/a.ts:2 (old line)", the file alone, or the PR: a card's name says where it is. */
export function whereOf(item: CommentItem): string {
  if (!item.at) return "the PR";
  return `${item.at.file}${item.at.lines ? `:${item.at.lines}` : ""}${item.at.line !== null && item.at.side === "LEFT" ? " (old line)" : ""}`;
}

/**
 * One comment-like thing as a full card, the same in the code (`inline`) and in a list's expanded row (`row`): a GitHub
 * thread or an ask from your summary in both, and in a row also a draft comment or a private discussion, which the
 * code shows through InlineLocation.
 */
export function CommentCard({ targetKey, item, variant }: { targetKey: string; item: CommentItem; variant: "inline" | "row" }) {
  if (item.kind === "thread") return <ThreadCard targetKey={targetKey} item={item} variant={variant} />;
  if (item.kind === "ask") return <AskCard targetKey={targetKey} item={item} variant={variant} />;
  if (item.kind === "draft") return <DraftCard item={item} />;
  return <PrivateCard item={item} />;
}

const CLAMP = 280;

/** A long comment shows its start until you ask for the rest. */
export function Clamped({ body }: { body: string }) {
  const [all, setAll] = useState(false);
  const long = body.length > CLAMP || body.split("\n").length > 6;
  return <div>
    <div className={cn(!all && long && "max-h-[6.5rem] overflow-hidden [mask-image:linear-gradient(to_bottom,black_4.5rem,transparent)]")}><CommentBody body={body} /></div>
    {long && <button type="button" aria-expanded={all} onClick={() => setAll(!all)} className={cn("mt-0.5 inline-flex items-center gap-0.5 rounded-sm text-xs text-muted-foreground hover:text-foreground", TOUCH_CONTROL)}>
      {all ? "Less" : "More"}<Icon name={all ? "ChevronUp" : "ChevronDown"} className="size-3" aria-hidden />
    </button>}
  </div>;
}

/** Who wrote a message, and when. */
function Speaker({ message, children }: { message: ThreadMessage; children?: ReactNode }) {
  return <span className="flex min-w-0 items-center gap-1.5 text-xs">
    {message.author ? <Avatar login={message.author} size={16} /> : <Icon name="UserRound" className="size-4 text-subtle-foreground" aria-hidden />}
    <span className="truncate font-medium text-foreground">{message.who}</span>
    {message.bot && <Badge size="sm">bot</Badge>}
    {age(message.createdAt) && <span className="shrink-0 text-subtle-foreground">{age(message.createdAt)}</span>}
    {children}
  </span>;
}

/** The agent's check: what changed or what's missing, and where the fix is. */
function Evidence({ item, onFix }: { item: ThreadItem | AskItem; onFix?: () => void }) {
  if (!item.check?.evidence) return null;
  return <div className="flex gap-2 rounded-md border-l-2 border-(--ansi-13)/60 bg-(--ansi-13)/5 px-2.5 py-1.5">
    <Icon name="Sparkles" className="mt-0.5 size-3.5 shrink-0 text-(--ansi-13)" aria-label="Agent" />
    <Markdown content={item.check.evidence} className="min-w-0 flex-1 text-sm leading-relaxed" />
    {item.check.fix && onFix && <Button variant="link" size="sm" className={cn("h-auto shrink-0 self-start p-0 text-xs", TOUCH_CONTROL)} onClick={onFix}>Show the fix<Icon name="ArrowRight" className="size-3" aria-hidden /></Button>}
  </div>;
}

/** Earlier replies stay folded, past the latest two. */
function Replies({ replies }: { replies: ThreadMessage[] }) {
  const [all, setAll] = useState(false);
  const hidden = replies.length - 2;
  if (!replies.length) return null;
  return <div className="space-y-2.5">
    {hidden > 0 && <button type="button" aria-expanded={all} onClick={() => setAll(!all)} className={cn("inline-flex items-center text-xs text-muted-foreground hover:text-foreground", TOUCH_CONTROL)}>
      {all ? "Show fewer replies" : `Show ${hidden} earlier repl${hidden === 1 ? "y" : "ies"}`}
    </button>}
    <ul className="space-y-2.5">
      {(all ? replies : replies.slice(-2)).map((reply, index) => <li key={`${reply.createdAt}:${index}`} className="space-y-1">
        <Speaker message={reply} />
        <div className="pl-[22px]"><Markdown content={withLineBreaks(reply.body)} className="text-sm leading-relaxed" /></div>
      </li>)}
    </ul>
  </div>;
}

/** A thread on GitHub: who started it and when, its state and the agent's check, the messages, and its reply. A resolved one starts folded. */
function ThreadCard({ targetKey, item, variant }: { targetKey: string; item: ThreadItem; variant: "inline" | "row" }) {
  const actions = useComments(targetKey, "actions");
  const busy = useComments(targetKey, "busy") === item.id;
  const api = useWorkspaceFor(targetKey);
  const navigate = useBbNavigate();
  const inline = variant === "inline";
  // In a list, the row above it names who and what state, and folds it.
  const [shut, setShut] = useState(item.state === "resolved");
  const open = !inline || !shut;
  const [writing, setWriting] = useState(false);
  const [menu, setMenu] = useState(false);
  const replyButton = useRef<HTMLButtonElement>(null);
  const where = whereOf(item);
  const [first, ...replies] = item.messages;
  const followUp = item.at && api ? () => api.followUp(item.at!.file, item.at!.line, item.at!.side, item.url) : null;
  const replyShows = writing || !!item.replyDraft;
  // Hidden, one line says what's under it.
  const shutLine = [item.state === "resolved" && item.resolvedBy ? `Resolved by @${item.resolvedBy}` : null, replies.length ? `${replies.length} repl${replies.length === 1 ? "y" : "ies"}` : null].filter(Boolean).join(" · ");
  return (
    <article aria-label={`GitHub thread on ${where}`} className={cn(inline ? INLINE_CARD : "overflow-hidden rounded-lg bg-card pt-2.5 text-sm", frameOf(item))}>
      {inline && <div className={cn(HEAD, !open && "pb-1")}>
        <span className="flex shrink-0 items-center gap-1.5"><Icon name="Github" className="size-3.5 shrink-0" aria-hidden />On GitHub<span aria-hidden className="text-subtle-foreground">·</span></span>
        {first ? <Speaker message={first} /> : <span className="font-medium text-foreground">{item.who}</span>}
        {item.tag && <Badge tone={TAG_TONE[item.tag] ?? "neutral"} size="sm">{item.tag}</Badge>}
        <ThreadState item={item} />
        {item.check && <CheckBadge check={item.check} />}
        <Button variant="ghost" size="sm" aria-expanded={open} className={cn(ACTION, "ml-auto")} onClick={() => setShut(open)}>{open ? "Hide" : "Show"}</Button>
      </div>}
      {open ? <div className="space-y-2.5 px-3 pb-2.5">
        {!inline && first && <Speaker message={first} />}
        {first && <Clamped body={first.body} />}
        <Replies replies={replies} />
        <Evidence item={item} onFix={item.check?.fix && api ? () => api.showLocation(item.check!.fix!.file, item.check!.fix!.line, "RIGHT") : undefined} />
        {actions && replyShows && <ReplyBox targetKey={targetKey} item={item} where={where} actions={actions} busy={busy} writing={writing} onClose={() => setWriting(false)} replyButton={replyButton} />}
        {actions && <div className="-mb-1 -ml-2 flex flex-wrap items-center gap-0.5">
          {!replyShows && <Button ref={replyButton} variant="ghost" size="sm" className={ACTION} disabled={busy || item.replyTo === null} onClick={() => setWriting(true)}><Icon name="CornerDownRight" className="size-3.5" aria-hidden />Reply</Button>}
          <Button variant="ghost" size="sm" className={ACTION} disabled={busy} onClick={() => void actions.setResolved(item.id, item.state !== "resolved")}>
            <Icon name={item.state === "resolved" ? "RotateCcw" : "CircleCheck"} className="size-3.5" aria-hidden />{item.state === "resolved" ? "Unresolve" : "Resolve"}
          </Button>
          {(followUp || item.url) && <Popover open={menu} onOpenChange={setMenu}>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="sm" aria-label={`More on the thread on ${where}`} className={cn(ACTION, "w-7 px-0")}><Icon name="MoreHorizontal" className="size-3.5" aria-hidden /></Button>
            </PopoverTrigger>
            <PopoverContent align="start" mobileTitle="Thread" className="w-52 p-1">
              {followUp && <Button variant="ghost" size="sm" className={cn("w-full justify-start text-muted-foreground hover:text-foreground", TOUCH_CONTROL)} onClick={() => { setMenu(false); followUp(); }}>
                <Icon name="MessageSquarePlus" aria-hidden />Follow up
              </Button>}
              {item.url && <Button variant="ghost" size="sm" className={cn("w-full justify-start text-muted-foreground hover:text-foreground", TOUCH_CONTROL)} onClick={() => { setMenu(false); navigate.openUrl(item.url!); }}>
                <Icon name="Github" aria-hidden />Open on GitHub
              </Button>}
            </PopoverContent>
          </Popover>}
        </div>}
      </div> : <p className="truncate px-3 pb-2 text-xs text-muted-foreground">
        {shutLine}{shutLine && first && " · "}
        {/* Its code without the chip's ground, which the cut would leave as a sliver before the ellipsis. */}
        {first && <>{first.who}: <span className="text-foreground/80 [&_code]:bg-transparent [&_code]:px-0"><InlineCode text={plainLine(first.body)} /></span></>}
      </p>}
    </article>
  );
}

/** An ask from your earlier review summary, and the agent's check of it. */
function AskCard({ targetKey, item, variant }: { targetKey: string; item: AskItem; variant: "inline" | "row" }) {
  const api = useWorkspaceFor(targetKey);
  return (
    <article aria-label={item.title} className={cn(variant === "inline" ? INLINE_CARD : "overflow-hidden rounded-lg bg-card pt-2.5 text-sm", frameOf(item))}>
      {variant === "inline" && <div className={HEAD}>
        <Icon name="FileText" className="size-3.5 shrink-0" aria-hidden />
        <span className="font-medium text-foreground">{item.label}</span>
        {item.check && <CheckBadge check={item.check} />}
      </div>}
      <div className="space-y-2.5 px-3 pb-2.5">
        <p className="text-sm">{item.title}</p>
        <Evidence item={item} onFix={item.check?.fix && api ? () => api.showLocation(item.check!.fix!.file, item.check!.fix!.line, "RIGHT") : undefined} />
      </div>
    </article>
  );
}

/** The comment box of the side panel's draft, as a card's box: an edit of the comment, or a message to the agent. */
export function usePanelComposer(): InlineComposer {
  const draft = useDraft();
  return {
    body: draft.body, edited: draft.edited, replacing: draft.replacing, change: draft.changeBody, textareaRef: draft.bodyRef, error: draft.composerError, rebuilding: draft.rebuilding,
    keepOnCurrentDiff: draft.olderDiff ? draft.keepOnCurrentDiff : null, severity: draft.severity, changeSeverity: draft.setSeverity,
    save: () => { void draft.addComment(); }, askAgent: () => { void draft.askAgent(); }, cancel: draft.cancelComposer,
    suggest: draft.suggestable ? draft.suggestChange : null,
  };
}

/** Whether the side panel's box is open at a place, rather than in the code or on the summary. */
function boxAt(draft: ReturnType<typeof useDraft>, at: { file: string; line: number; side: "LEFT" | "RIGHT" }): "edit" | "ask" | null {
  if (!draft.showComposer || draft.inline || draft.onSummary || !sameLocation({ file: draft.file, line: Number(draft.line), side: draft.side }, at)) return null;
  return draft.asking ? "ask" : draft.editing ? "edit" : null;
}

/** A draft comment in a list, under its row: its words, its discussion with the agent, its box, and what you can do. */
function DraftCard({ item }: { item: DraftItem }) {
  const draft = useDraft();
  const composer = usePanelComposer();
  const { comment } = item;
  const box = boxAt(draft, comment);
  const where = `${comment.file}:${linesOf(comment)}`;
  return (
    <article data-comment-at={`${comment.file}:${comment.line}:${comment.side}`} tabIndex={-1} aria-label={`Draft comment on ${where}`} className={cn("overflow-hidden rounded-lg bg-card text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50", frameOf(item))}>
      {box === "edit" ? <>
        {comment.startLine !== undefined && <p className="px-2.5 pt-2.5 text-xs text-muted-foreground tabular-nums">Lines {linesOf(comment)}</p>}
        <ComposerFields mode="edit" busy={draft.busy} composer={composer} controlsRef={draft.composerControls} />
      </> : <div className="space-y-2 px-3 pb-2.5 pt-2.5">
        {(comment.startLine !== undefined || comment.side === "LEFT") && <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {comment.startLine !== undefined && <span className="tabular-nums">Lines {linesOf(comment)}</span>}
          {comment.side === "LEFT" && <Badge size="sm">Old line</Badge>}
        </p>}
        <CommentBody body={comment.body} />
        {item.state === "older-diff" && <p className="text-xs text-warning-text">Drafted against an older diff. Edit and save it, or remove it, before you submit.</p>}
        {draft.editable && <div className="-mb-1 -ml-2 flex flex-wrap gap-0.5">
          <Button variant="ghost" size="sm" aria-label={`Edit comment on ${where}`} className={ACTION} disabled={draft.busy || draft.writing} onClick={() => draft.openComposer(comment, false)}><Icon name="Edit" className="size-3.5" aria-hidden />Edit</Button>
          <Button variant="ghost" size="sm" aria-label={`Ask agent about the comment on ${where}`} className={cn(ACTION, "text-(--ansi-13) hover:text-(--ansi-13)")} disabled={draft.busy || draft.writing} onClick={() => draft.openComposer(comment, false, true)}><Icon name="Sparkles" className="size-3.5" aria-hidden />Ask agent</Button>
          <Button variant="ghost" size="sm" aria-label={`Remove comment on ${where}`} className={cn(ACTION, "hover:text-destructive-text")} disabled={draft.busy} onClick={() => void draft.removeComment(comment)}><Icon name="Trash2" className="size-3.5" aria-hidden />Remove</Button>
        </div>}
      </div>}
      {item.discussion && <DiscussionView discussion={item.discussion} titled chat={draft.chat} busy={draft.busy} onUndo={draft.editable && !box ? () => void draft.undo(item.discussion!) : undefined} />}
      {box === "ask" && <ComposerFields mode="ask" divided busy={draft.busy} composer={composer} />}
    </article>
  );
}

/** A private discussion with the agent about lines without a comment, under its row. */
function PrivateCard({ item }: { item: PrivateItem }) {
  const draft = useDraft();
  const composer = usePanelComposer();
  const { discussion } = item;
  const box = boxAt(draft, discussion);
  return (
    <article aria-label={`Private discussion on ${whereOf(item)}`} className={cn("overflow-hidden rounded-lg text-sm", frameOf(item))}>
      <DiscussionView discussion={discussion} titled={false} chat={draft.chat} busy={draft.busy} onUndo={draft.editable && !box ? () => void draft.undo(discussion) : undefined} />
      {box === "ask" ? <ComposerFields mode="ask" divided busy={draft.busy} composer={composer} /> : draft.editable && <div className="flex flex-wrap gap-0.5 px-1 pb-1.5">
        <Button variant="ghost" size="sm" className={cn(ACTION, "text-(--ansi-13) hover:text-(--ansi-13)")} disabled={draft.busy || draft.writing} onClick={() => draft.openComposer(discussion, false, true)}><Icon name="Sparkles" className="size-3.5" aria-hidden />Reply</Button>
        <Button variant="ghost" size="sm" className={ACTION} disabled={draft.busy} onClick={() => draft.inlineDraft.dismiss(discussion)}>Dismiss</Button>
      </div>}
    </article>
  );
}
