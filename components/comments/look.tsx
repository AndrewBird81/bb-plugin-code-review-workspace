// How a comment-like thing looks wherever it shows, in the code, the list, or Finish (spec §4): dashed with a colored
// edge while it's only in BB, solid on GitHub with its author, muted with a lock when it's private. Never color alone:
// its state is always in words too.
import { CHECK_LABEL, STATE_LABEL, THREAD_FLAG_LABEL, type CommentCheck, type CommentItem, type FixMark, type ThreadItem } from "../../lib/comments";
import type { AssessmentVerdict } from "../../lib/feedback";
import type { CommentLocation, DraftComment, Severity } from "../../src/draft";
import { sameLocation } from "../../src/draft";
import { cn } from "../../lib/utils";
import { Badge, type Tone } from "../ui/badge";
import { Icon, type IconName } from "../ui/icon";

/** Whose words a not-submitted thing holds, which its edge's color says: yours, the agent's, or one on an older diff. */
export type Edge = "yours" | "agent" | "older";
const EDGE: Record<Edge, string> = { yours: "border-l-primary/70", agent: "border-l-(--ansi-13)/70", older: "border-l-warning" };
const EDGE_TEXT: Record<Edge, string> = { yours: "text-primary", agent: "text-(--ansi-13)", older: "text-warning-text" };

/** Only in BB: a dashed outline, and a solid 3px edge in its words' color. */
export const notSubmitted = (edge: Edge) => cn("border border-dashed border-muted-foreground/40 border-l-[3px] [border-left-style:solid]", EDGE[edge]);
/** On GitHub: a solid outline and no edge. */
export const onGitHub = "border border-border";
/** Private, with the agent: muted, under what it belongs to. */
export const privately = "border border-border/70 bg-muted/30";

export function draftEdge(comment: Pick<DraftComment, "author"> & CommentLocation, stale: readonly CommentLocation[]): Edge {
  return stale.some((at) => sameLocation(at, comment)) ? "older" : comment.author === "agent" ? "agent" : "yours";
}

/** The frame of an item's card, row or pill. */
export function frameOf(item: CommentItem): string {
  if (item.kind === "draft") return notSubmitted(item.state === "older-diff" ? "older" : item.state === "agent-draft" ? "agent" : "yours");
  if (item.kind === "private") return privately;
  return onGitHub;
}

const DRAFT_ICON: Record<Edge, IconName> = { yours: "CircleDashed", agent: "Sparkles", older: "AlertTriangle" };
/**
 * A sent comment's icon, where its fix stands: the send arrow while it's out; a check once the thread reports it done,
 * hollow where the review agent's check found it done unreported; a cross for declined, hollow the same way.
 */
const MARK_ICON: Record<FixMark, { icon: IconName; text: string }> = {
  sent: { icon: "Send", text: "text-primary" },
  done: { icon: "Check", text: "text-diff-added" },
  "looks-done": { icon: "CircleCheck", text: "text-muted-foreground" },
  declined: { icon: "X", text: "text-muted-foreground" },
  "looks-declined": { icon: "CircleX", text: "text-muted-foreground" },
};

/** The icon that leads an item: a dashed circle, the agent's sparkle, a warning, where a sent one's fix stands, GitHub's mark, or a lock. */
export function ItemIcon({ item, className }: { item: CommentItem; className?: string }) {
  if (item.kind === "draft") {
    const edge: Edge = item.state === "older-diff" ? "older" : item.state === "agent-draft" ? "agent" : "yours";
    return <DraftIcon edge={edge} mark={item.state === "older-diff" ? undefined : item.mark} className={className} />;
  }
  if (item.kind === "private") return <Icon name="Lock" className={cn("size-3.5 shrink-0 text-subtle-foreground", className)} aria-hidden />;
  if (item.kind === "ask") return <Icon name="FileText" className={cn("size-3.5 shrink-0 text-muted-foreground", className)} aria-hidden />;
  return <Icon name="Github" className={cn("size-3.5 shrink-0 text-muted-foreground", className)} aria-hidden />;
}

/** A draft's icon by who wrote it, or once sent, where its fix stands (`mark`). */
export function DraftIcon({ edge, mark, className }: { edge: Edge; mark?: FixMark; className?: string }) {
  if (mark && edge !== "older") return <Icon name={MARK_ICON[mark].icon} className={cn("size-3.5 shrink-0", MARK_ICON[mark].text, className)} aria-hidden />;
  return <Icon name={DRAFT_ICON[edge]} className={cn("size-3.5 shrink-0", EDGE_TEXT[edge], className)} aria-hidden />;
}

const STATE_LOOK: Record<ThreadItem["state"], { tone: Tone; icon?: IconName }> = {
  waiting: { tone: "neutral", icon: "Clock" },
  replied: { tone: "primary" },
  question: { tone: "primary" },
  resolved: { tone: "success", icon: "CircleCheck" },
  open: { tone: "neutral" },
  "needs-reply": { tone: "primary", icon: "ArrowTurnBackward" },
};

/** A GitHub thread's state, then Outdated or File comment. */
export function ThreadState({ item, size = "sm" }: { item: ThreadItem; size?: "sm" | "md" }) {
  const look = STATE_LOOK[item.state];
  return <>
    <Badge tone={look.tone} size={size} icon={look.icon && <Icon name={look.icon} aria-hidden />}>{item.label}</Badge>
    {item.outdated && <Badge size={size} icon={<Icon name="GitCommit" aria-hidden />}>{THREAD_FLAG_LABEL.outdated}</Badge>}
    {item.fileComment && <Badge size={size} icon={<Icon name="File" aria-hidden />}>{THREAD_FLAG_LABEL.fileComment}</Badge>}
  </>;
}

/** A thread's reply drafted and not sent yet, yours or the agent's, on its row or pill: dashed, as anything only in BB. */
export function ReplyDraftBadge({ reply, brief = false }: {
  reply: NonNullable<ThreadItem["replyDraft"]>;
  /** "Reply draft", its dashed frame and icon saying the rest, which a screen reader hears in full. */
  brief?: boolean;
}) {
  const agent = reply.author === "agent";
  return <Badge tone={agent ? "agent" : "primary"} size="sm" className="border-dashed" icon={<Icon name={agent ? "Sparkles" : "CircleDashed"} aria-hidden />}>
    {brief ? <><span aria-hidden>Reply draft</span><span className="sr-only">{reply.label}</span></> : reply.label}
  </Badge>;
}

const CHECK_TONE: Record<AssessmentVerdict, Tone> = { addressed: "success", partial: "warning", not_addressed: "danger", disputed: "warning", unclear: "neutral" };

/** The agent's check of your feedback: "✦ Addressed". */
export function CheckBadge({ check, size = "sm" }: { check: Pick<CommentCheck, "verdict">; size?: "sm" | "md" }) {
  return <Badge tone={CHECK_TONE[check.verdict]} size={size} title="The agent’s check" icon={<Icon name="Sparkles" aria-hidden />}>{CHECK_LABEL[check.verdict]}</Badge>;
}

/** A thread label's tone: a severity's, as on draft comments; neutral for nits, FYIs and other non-blocking ones. */
export const TAG_TONE: Partial<Record<string, Tone>> = { Blocking: "danger", "Should fix": "warning", Question: "primary" };
export const SEVERITY_TONE: Record<Severity, Tone> = { blocking: "danger", "should-fix": "warning", question: "primary", nit: "neutral" };

/** Where an item is, as a row ends: "cache.ts:16", the file's name only, or nothing for the whole PR. */
export function placeLabel(item: CommentItem): string | null {
  if (!item.at) return null;
  const name = item.at.file.split("/").at(-1) ?? item.at.file;
  return item.at.lines ? `${name}:${item.at.lines}` : name;
}

/** The words an item's row and pill lead with: its header's, though a draft's "not submitted" is its group's title. */
export function itemWords(item: CommentItem): string {
  // A draft not submitted, in short; on your own change, its status line whole (lib/comments.ts draftStatus).
  if (item.kind === "draft") return item.label !== STATE_LABEL[item.state] || item.state === "older-diff" ? item.label : item.state === "agent-draft" ? "Agent draft" : "Draft";
  if (item.kind === "thread") return [item.label, item.outdated ? THREAD_FLAG_LABEL.outdated : null, item.fileComment ? THREAD_FLAG_LABEL.fileComment : null].filter(Boolean).join(" · ");
  return item.label;
}

/** A message's first line in plain words, for a row or pill: no quote marks or fences, no bold or italic markers. */
export function plainLine(text: string): string {
  const line = text.split("\n").map((part) => part.trim()).find((part) => part && !part.startsWith(">") && !part.startsWith("```")) ?? "";
  return line.replace(/(\*\*|__)(.+?)\1/g, "$2");
}
