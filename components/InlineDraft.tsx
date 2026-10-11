import { createContext, memo, useContext, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { Markdown } from "@get-bb/plugin-sdk/app";
import { linesOf, sameLocation, SEVERITIES, SEVERITY_LABEL, type CommentLocation, type Discussion, type DiscussionEntry, type DraftComment, type Severity } from "../src/draft";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Icon } from "./ui/icon";
import { Textarea } from "./ui/textarea";
import { Badge, SpeakerMark, TONE_TEXT, type Tone } from "./ui/badge";
import { withLineBreaks } from "../src/line-breaks";

/** The draft as the diff shows it, under each comment's line. DraftTray owns the draft and provides this. */
export interface InlineDraft {
  comments: DraftComment[];
  /** Comments drafted against an older diff, which submitting refuses. */
  stale: CommentLocation[];
  /** Discussions with the review assistant, under their line's comment or in its place. */
  discussions: Discussion[];
  /** The draft loaded and its PR is open, so its comments can change. */
  editable: boolean;
  busy: boolean;
  /** A comment is being written, so no other can be opened for editing. */
  writing: boolean;
  /** Nit comments are hidden, except where the comment box is open. */
  hideNits?: boolean;
  /** Where the diff shows the comment box, under its last line, while it's open there. `asking` when it writes to the agent. */
  composer: (CommentLocation & { startLine?: number; editing: boolean; asking: boolean }) | null;
  /** The line whose comment the box is open on, in the diff or the panel. */
  editingAt: CommentLocation | null;
  /** Open the comment box at a line, on the line's comment if it has one. */
  open(at: CommentLocation): void;
  /** Open a box at a line for a message to the review assistant. */
  ask(at: CommentLocation): void;
  remove(comment: DraftComment): void;
  /** Drop the discussion at a line that has no comment. */
  dismiss(at: CommentLocation): void;
  /** Undo the agent's latest change in the discussion at a line. */
  undo(at: CommentLocation): void;
  /** Show the review assistant's chat, when the review has one. */
  chat: (() => void) | null;
}

/** The comment box's text. Apart from InlineDraft so that typing re-renders only the box, not the diff. */
export interface InlineComposer {
  body: string;
  change(body: string): void;
  /** A line comment's severity, and its control; the summary has none. */
  severity?: Severity;
  changeSeverity?: (severity: Severity | undefined) => void;
  save(): void;
  /** Send the text to the review assistant instead of saving it. */
  askAgent(): void;
  cancel(): void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  /** Why the server refused the last save. */
  error?: string | null;
  /** The guide is rebuilding for new commits, so the comment can't be saved yet. */
  rebuilding?: boolean;
  /** The save was refused because the text was written against an older diff: keep it on the current one. */
  keepOnCurrentDiff?: (() => void) | null;
  /** Add a suggested change for the box's lines, when they're new-file lines. */
  suggest?: (() => void) | null;
}

export const InlineDraftContext = createContext<InlineDraft | null>(null);
export const InlineComposerContext = createContext<InlineComposer | null>(null);

/** Marks a line's comment and discussion in the diff, so the panel can scroll to them. */
export const locationKey = (at: CommentLocation) => `${at.file}:${at.line}:${at.side}`;

// The diff renders these inside its code view, so set the text style instead of inheriting the code's.
const card = "mx-2 my-2 max-w-3xl overflow-hidden rounded-lg border border-border bg-card font-sans text-sm leading-normal whitespace-normal text-foreground shadow-md";
/** A card's title row, and the small actions in it. */
export const bar = "flex min-h-9 flex-wrap items-center gap-x-2 gap-y-1 border-b border-border bg-muted/25 px-3 py-1 text-xs text-muted-foreground";
export const action = "h-7 px-2 text-xs";

/** Who wrote it: the agent, in its own color, or you. */
function Speaker({ agent, children }: { agent: boolean; children: ReactNode }) {
  return <span className="flex items-center gap-1.5 text-xs font-medium text-foreground"><SpeakerMark agent={agent} />{children}</span>;
}

/** A line's draft comment, its discussion with the agent, and the comment box while it's open there. */
export const InlineLocation = memo(function InlineLocation({ at }: { at: CommentLocation }) {
  const draft = useContext(InlineDraftContext);
  if (!draft) return null;
  const comment = draft.comments.find((c) => sameLocation(c, at));
  const discussion = draft.discussions.find((d) => sameLocation(d, at));
  const composer = draft.composer && sameLocation(draft.composer, at) ? draft.composer : null;
  const box = composer && (composer.editing ? "edit" : composer.asking ? "ask" : "new");
  if (!comment && !discussion && !box) return null;
  if (draft.hideNits && comment?.severity === "nit" && !box) return null;
  // A colored edge says whose words these are: the agent's, yours, or a question in progress.
  const edge = box === "ask" || (!comment && discussion) ? "border-l-(--ansi-13)/60" : comment?.author === "agent" ? "border-l-(--ansi-13)/60" : "border-l-primary/60";
  return (
    <div data-draft-at={locationKey(at)} className={cn(card, "border-l-[3px]", edge)}>
      {box === "edit" ? <ComposerBox mode="edit" /> : comment ? <CommentView comment={comment} draft={draft} /> : discussion && <DiscussionBar discussion={discussion} draft={draft} boxOpen={!!box} />}
      {discussion && <DiscussionView discussion={discussion} titled={!!comment || box === "edit"} chat={draft.chat} busy={draft.busy} onUndo={draft.editable && !box && !(draft.editingAt && sameLocation(draft.editingAt, at)) ? () => draft.undo(discussion) : undefined} />}
      {box && box !== "edit" && <ComposerBox mode={box} divided={!!(comment || discussion)} />}
    </div>
  );
});
InlineLocation.displayName = "InlineLocation";

function CommentView({ comment, draft }: { comment: DraftComment; draft: InlineDraft }) {
  const stale = draft.stale.some((at) => sameLocation(at, comment));
  return (
    <article tabIndex={-1} aria-label={`Draft comment on ${comment.file}:${linesOf(comment)}`} className="outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50">
      <div className={bar}>
        <Icon name="MessageSquare" className="size-3.5 shrink-0 text-primary" aria-hidden />
        <span className="font-medium text-foreground">Draft</span>
        {comment.startLine !== undefined && <span className="tabular-nums">Lines {linesOf(comment)}</span>}
        {comment.severity && <SeverityBadge severity={comment.severity} />}
        {comment.author === "agent" && <Badge tone="agent" icon={<Icon name="Sparkles" aria-hidden />}>Added by agent</Badge>}
        {stale && (
          <Badge tone="warning" title="Drafted against an older diff. Edit and save it, or remove it, before submitting.">Older diff</Badge>
        )}
        {draft.editable && (
          <span className="ml-auto flex">
            <Button variant="ghost" size="sm" className={cn(action, TONE_TEXT.agent, "hover:text-(--ansi-13)")} disabled={draft.busy || draft.writing} onClick={() => draft.ask(comment)}><Icon name="Sparkles" className="size-3.5" aria-hidden />Ask agent</Button>
            <Button variant="ghost" size="sm" className={action} disabled={draft.busy || draft.writing} onClick={() => draft.open(comment)}>Edit</Button>
            <Button variant="ghost" size="sm" className={cn(action, "hover:text-destructive-text")} disabled={draft.busy} onClick={() => draft.remove(comment)}>Remove</Button>
          </span>
        )}
      </div>
      <div className="px-3 py-2.5"><CommentBody body={comment.body} /></div>
    </article>
  );
}

const SEVERITY_TONE: Record<Severity, Tone> = { blocking: "danger", "should-fix": "warning", question: "primary", nit: "neutral" };

/** How much a comment matters, on its card. */
export function SeverityBadge({ severity, size }: { severity: Severity; size?: "sm" | "md" }) {
  return <Badge tone={SEVERITY_TONE[severity]} size={size}>{SEVERITY_LABEL[severity]}</Badge>;
}

/** The comment box's choice of severity. */
export function SeveritySelect({ value, onChange, disabled, className }: { value?: Severity; onChange: (severity: Severity | undefined) => void; disabled: boolean; className?: string }) {
  return (
    <select aria-label="Severity" disabled={disabled} value={value ?? "none"} onChange={(event) => onChange(event.target.value === "none" ? undefined : event.target.value as Severity)}
      className={cn("h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground", className)}>
      <option value="none">No severity</option>
      {SEVERITIES.map((severity) => <option key={severity} value={severity}>{SEVERITY_LABEL[severity]}</option>)}
    </select>
  );
}

// A ```suggestion block: the lines it would put in place of the comment's.
const SUGGESTION = /^```suggestion[ \t]*\n([\s\S]*?)^```[ \t]*$/m;

/** A comment's text, with each ```suggestion block shown as the code it would put in place of the comment's lines. */
export function CommentBody({ body }: { body: string }) {
  const parts = body.split(new RegExp(SUGGESTION, "gm"));
  return <div className="space-y-2">{parts.map((part, index) => index % 2
    ? <figure key={index} aria-label="Suggested change" className="overflow-hidden rounded-md border border-border">
        <figcaption className="border-b border-border bg-muted/25 px-2 py-1 text-xs text-muted-foreground">Suggested change</figcaption>
        <pre className="overflow-x-auto bg-success/10 px-2 py-1.5 font-mono text-xs leading-relaxed"><code>{part.replace(/\n$/, "")}</code></pre>
      </figure>
    : part.trim() && <Markdown key={index} content={withLineBreaks(part.trim())} className="text-sm leading-relaxed" />)}</div>;
}

/** Heads a discussion with no comment: a question about the line, or one whose comment the agent removed. */
function DiscussionBar({ discussion, draft, boxOpen }: { discussion: Discussion; draft: InlineDraft; boxOpen: boolean }) {
  const removed = discussion.entries.filter((entry) => entry.kind !== "message").slice(-1)[0]?.kind === "removed";
  return (
    <div className={bar}>
      <Icon name={removed ? "Trash2" : "Sparkles"} className="size-3.5 shrink-0 text-(--ansi-13)" aria-hidden />
      <span className="font-medium text-foreground">{removed ? "Removed by agent" : "Discussion with agent"}</span>
      {discussion.startLine !== undefined && <span className="tabular-nums">Lines {discussionLines(discussion)}</span>}
      {draft.editable && !boxOpen && (
        <span className="ml-auto flex">
          <Button variant="ghost" size="sm" className={action} disabled={draft.busy || draft.writing} onClick={() => draft.ask(discussion)}>Ask agent</Button>
          <Button variant="ghost" size="sm" className={action} disabled={draft.busy} onClick={() => draft.dismiss(discussion)}>Dismiss</Button>
        </span>
      )}
    </div>
  );
}

/** A discussion's lines; its start may be either end of the lines the reviewer selected. */
const discussionLines = ({ startLine, line }: Discussion) => startLine === undefined ? `${line}` : `${Math.min(startLine, line)}–${Math.max(startLine, line)}`;

type Change = Exclude<DiscussionEntry["kind"], "message">;
const changeIcons: Record<Change, "Sparkles" | "Edit" | "Trash2" | "ArrowTurnBackward"> = { added: "Sparkles", edited: "Edit", removed: "Trash2", restored: "ArrowTurnBackward" };
const changeText = (kind: Change, summary: boolean) => kind === "restored" ? "You undid that change." : summary
  ? { added: "Agent wrote the summary.", edited: "Agent edited the summary.", removed: "Agent removed the summary." }[kind]
  : { added: "Agent added this comment.", edited: "Agent edited the comment.", removed: "Agent removed the comment." }[kind];

/** A discussion with the agent, under a line's comment or the review summary. `onUndo` undoes the agent's latest change while it can be. */
export function DiscussionView({ discussion, titled, chat, busy = false, onUndo, summary = false }: {
  discussion: Discussion; titled: boolean; chat: (() => void) | null; busy?: boolean; onUndo?: () => void; summary?: boolean;
}) {
  const last = discussion.entries[discussion.entries.length - 1];
  const unanswered = !discussion.waiting && last?.kind === "message" && last.author === "reviewer";
  const latestChange = discussion.entries.map((entry) => entry.kind !== "message").lastIndexOf(true);
  return (
    <section aria-label={summary ? "Discussion with agent on the review summary" : `Discussion with agent on ${discussion.file}:${discussionLines(discussion)}`} className={cn("space-y-3 bg-muted/20 px-3 py-2.5", titled && "border-t border-border")}>
      {titled && <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-subtle-foreground">Discussion with agent</p>}
      {discussion.entries.map((entry, index) => entry.kind === "message"
        ? <div key={index} className="space-y-1">
            <Speaker agent={entry.author === "agent"}>{entry.author === "agent" ? "Agent" : "You"}</Speaker>
            <div className="pl-6"><Markdown content={entry.author === "agent" ? entry.body : withLineBreaks(entry.body)} className="text-sm leading-relaxed" /></div>
          </div>
        : <p key={index} className="flex flex-wrap items-center gap-x-1.5 pl-0.5 text-xs italic text-muted-foreground">
            <Icon name={changeIcons[entry.kind]} className="size-3 text-(--ansi-13)" aria-hidden />{changeText(entry.kind, summary)}
            {index === latestChange && discussion.undoable && onUndo && <Button variant="link" size="sm" className="h-auto p-0 text-xs not-italic" disabled={busy} onClick={onUndo}>Undo</Button>}
          </p>)}
      {discussion.waiting
        ? <p role="status" className="flex items-center gap-2 pl-0.5 text-xs text-(--ansi-13)"><span aria-hidden className="flex gap-0.5">{[0, 1, 2].map((dot) => <span key={dot} className="size-1 rounded-full bg-current motion-safe:animate-bounce" style={{ animationDelay: `${dot * 140}ms` }} />)}</span>Waiting for agent…</p>
        : unanswered && <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
            The agent didn’t reply here.
            {chat && <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={chat}>Open Ask agent</Button>}
          </p>}
    </section>
  );
}

/** Cmd/Ctrl+Enter runs a box's primary action, when it can run; Esc cancels, without reaching a drawer around the panel. */
export function composerKeys(event: KeyboardEvent<HTMLTextAreaElement>, primary: (() => void) | null, cancel: () => void) {
  if (event.nativeEvent.isComposing) return;
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); primary?.(); }
  else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancel(); }
}

/** Under a comment's box: why its save was refused, or why it waits. */
export function ComposerNotes({ error, rebuilding, keepOnCurrentDiff }: Pick<InlineComposer, "error" | "rebuilding" | "keepOnCurrentDiff">) {
  return <>
    {rebuilding && <p className="text-xs text-muted-foreground">The guide is rebuilding for new commits; your text is kept. Save when it’s ready.</p>}
    {keepOnCurrentDiff && <p role="alert" className="flex flex-wrap items-center gap-x-2 text-xs text-warning-text">
      Written against an older diff. Check it still fits.
      <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={keepOnCurrentDiff}>Keep on current diff</Button>
    </p>}
    {error && <p role="alert" className="text-xs text-destructive-text">{error}</p>}
  </>;
}

/** The box for a new comment in the diff, an edit, or a message to the agent, wherever DraftTray opened it. */
function ComposerBox({ mode, divided = false }: { mode: "new" | "edit" | "ask"; divided?: boolean }) {
  const draft = useContext(InlineDraftContext);
  const composer = useContext(InlineComposerContext);
  if (!draft?.composer || !composer) return null;
  const { startLine, line } = draft.composer;
  return <>
    {startLine !== undefined && <p className={cn("px-2.5 pt-2.5 text-xs text-muted-foreground tabular-nums", divided && "border-t border-border")}>Lines {startLine}–{line}</p>}
    <ComposerFields mode={mode} divided={divided && startLine === undefined} busy={draft.busy} composer={composer} />
  </>;
}

/** The comment box itself: a line comment's, the summary's, or a message to the agent about either. */
export function ComposerFields({ mode, subject = "comment", divided = false, busy, composer }: {
  mode: "new" | "edit" | "ask"; subject?: "comment" | "summary"; divided?: boolean; busy: boolean; composer: InlineComposer;
}) {
  const empty = !composer.body.trim();
  const summary = subject === "summary";
  const primary = mode === "ask" ? composer.askAgent : composer.save;
  const held = busy || empty || mode !== "ask" && !!composer.rebuilding;
  return (
    <div className={cn("space-y-2 p-2.5", divided && "border-t border-border")}>
      <Textarea
        ref={composer.textareaRef}
        aria-label={mode === "ask" ? "Message to agent" : summary ? "Review summary" : "Draft comment"}
        disabled={busy}
        value={composer.body}
        onChange={(event) => composer.change(event.target.value)}
        onKeyDown={(event) => composerKeys(event, held ? null : primary, () => { if (!busy) composer.cancel(); })}
        placeholder={mode === "ask" ? summary ? "Ask about the summary, or say what to change" : "Ask about this, or say what to change" : summary ? "What should the author know overall?" : "What should the author know?"}
        className={cn("bg-background text-sm", summary && mode !== "ask" ? "min-h-28" : "min-h-20")}
      />
      {mode !== "ask" && <ComposerNotes error={composer.error} rebuilding={composer.rebuilding} keepOnCurrentDiff={composer.keepOnCurrentDiff} />}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {mode === "ask" && <span className="mr-auto flex items-center gap-1.5 text-xs text-muted-foreground"><Icon name="Sparkles" className="size-3.5 text-(--ansi-13)" aria-hidden />Goes to the agent, not GitHub.</span>}
        {mode !== "ask" && (composer.changeSeverity || composer.suggest) && <span className="mr-auto flex flex-wrap gap-2">
          {composer.changeSeverity && <SeveritySelect value={composer.severity} onChange={composer.changeSeverity} disabled={busy} />}
          {composer.suggest && <Button variant="outline" size="sm" disabled={busy} onClick={composer.suggest}><Icon name="Edit" className="size-3.5" aria-hidden />Suggest change</Button>}
        </span>}
        <Button variant="ghost" size="sm" disabled={busy} onClick={composer.cancel}>Cancel</Button>
        {mode === "new" && <Button variant="outline" size="sm" disabled={busy || empty} onClick={composer.askAgent}><Icon name="Sparkles" className="size-3.5 text-(--ansi-13)" aria-hidden />Ask agent</Button>}
        <Button size="sm" disabled={held} onClick={primary}>
          {mode === "ask" ? "Send to agent" : summary ? "Save summary" : mode === "edit" ? "Save comment" : "Add to draft"}
        </Button>
      </div>
    </div>
  );
}
