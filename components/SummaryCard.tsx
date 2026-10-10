import { Markdown } from "@get-bb/plugin-sdk/app";
import { summaryChanges, type Discussion, type Draft, type Verdict } from "../src/draft";
import { VERDICT_LABEL } from "../lib/draft-status";
import { cn } from "../lib/utils";
import { withLineBreaks } from "../src/line-breaks";
import { Badge, TONE_TEXT } from "./ui/badge";
import { Button } from "./ui/button";
import { Icon } from "./ui/icon";
import { action, bar, ComposerFields, DiscussionView, type InlineComposer } from "./InlineDraft";

/** What to ask the agent when the summary no longer fits the comments, or the verdict you picked. */
export function updateRequest(changes: { comments: boolean; verdict: Verdict | null }, chosen: Verdict): string {
  if (changes.comments && changes.verdict) return `My comments changed, and I chose ${VERDICT_LABEL[chosen]}. Update the summary to match.`;
  if (changes.verdict) return `I chose ${VERDICT_LABEL[chosen]}. Rewrite the summary for that verdict.`;
  return "My comments changed since you wrote this summary. Update it to match them.";
}

/**
 * The review summary, the comment GitHub shows with your verdict. It works like a line comment:
 * the agent can write it, you edit or remove it, and Ask agent discusses it with the agent here.
 */
export function SummaryCard({ draft, discussion, editable, busy, writing, composer, isLocal, chat, onEdit, onAsk, onRemove, onUndo, onRequest }: {
  draft: Draft;
  discussion?: Discussion;
  /** The draft loaded and its PR is open. */
  editable: boolean;
  busy: boolean;
  /** Something else is being written, so this can't open. */
  writing: boolean;
  /** The comment box, while it's open on the summary. */
  composer: (InlineComposer & { mode: "edit" | "ask" }) | null;
  isLocal: boolean;
  chat: (() => void) | null;
  onEdit(): void;
  onAsk(): void;
  onRemove(): void;
  onUndo(): void;
  /** Send the agent a message in the summary's discussion. */
  onRequest(text: string): void;
}) {
  const body = draft.body.trim();
  const agent = draft.bodyAuthor === "agent" && !!body;
  const changes = summaryChanges(draft);
  const outdated = editable && !discussion?.waiting && !composer && (changes.comments || !!changes.verdict);
  const blocked = busy || writing;
  return (
    <section aria-label="Review summary" className={cn("overflow-hidden rounded-lg border border-border bg-card border-l-[3px]", agent ? "border-l-(--ansi-13)/60" : "border-l-primary/60")}>
      <div className={bar}>
        <Icon name="FileText" className="size-3.5 shrink-0 text-primary" aria-hidden />
        <span className="font-medium text-foreground">Review summary</span>
        {agent && <Badge tone="agent" icon={<Icon name="Sparkles" aria-hidden />}>Added by agent</Badge>}
        {editable && body && composer?.mode !== "edit" && (
          <span className="ml-auto flex">
            <Button variant="ghost" size="sm" className={cn(action, TONE_TEXT.agent, "hover:text-(--ansi-13)")} disabled={blocked || !!composer} onClick={onAsk}><Icon name="Sparkles" className="size-3.5" aria-hidden />Ask agent</Button>
            <Button variant="ghost" size="sm" className={action} disabled={blocked || !!composer} onClick={onEdit}>Edit</Button>
            <Button variant="ghost" size="sm" className={cn(action, "hover:text-destructive-text")} disabled={busy} onClick={onRemove}>Remove</Button>
          </span>
        )}
      </div>
      {composer?.mode === "edit" ? <ComposerFields mode="edit" subject="summary" busy={busy} composer={composer} />
        : body ? <div className="px-3 py-2.5"><Markdown content={withLineBreaks(draft.body)} className="text-sm leading-relaxed" /></div>
        : <div className="space-y-2.5 px-3 py-3">
            <p className="text-sm leading-relaxed text-muted-foreground">{isLocal ? "Saved with your local draft." : "What should the author know overall? It goes to GitHub with your verdict, above your line comments."}</p>
            {editable && !discussion?.waiting && !composer && <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" disabled={blocked} onClick={onEdit}><Icon name="Edit" className="size-3.5" aria-hidden />Write summary</Button>
              <Button variant="outline" size="sm" disabled={blocked} onClick={() => onRequest("Write the review summary.")}><Icon name="Sparkles" className="size-3.5 text-(--ansi-13)" aria-hidden />Ask agent to write it</Button>
            </div>}
          </div>}
      {outdated && (
        <div role="status" className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-warning/20 bg-warning/10 px-3 py-1.5 text-xs text-warning-text">
          <Icon name="AlertCircle" className="size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1">{changes.comments && changes.verdict
            ? `Your comments changed, and it was written for ${VERDICT_LABEL[changes.verdict]}.`
            : changes.verdict ? `Written for ${VERDICT_LABEL[changes.verdict]}; you chose ${VERDICT_LABEL[draft.verdict]}.` : "Your comments changed since the agent wrote this."}</span>
          <Button variant="outline" size="sm" className="h-6 px-2 text-xs" disabled={blocked} onClick={() => onRequest(updateRequest(changes, draft.verdict))}>Update</Button>
        </div>
      )}
      {discussion && <DiscussionView discussion={discussion} titled summary chat={chat} busy={busy} onUndo={editable ? onUndo : undefined} />}
      {composer?.mode === "ask" && <ComposerFields mode="ask" subject="summary" divided busy={busy} composer={composer} />}
    </section>
  );
}
