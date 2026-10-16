import { memo } from "react";
import type { CommentItem } from "../../lib/comments";
import { useKnob } from "../../lib/settings";
import { cn } from "../../lib/utils";
import { InlineCode } from "../ui/inline-code";
import { Badge } from "../ui/badge";
import { Icon } from "../ui/icon";
import { SEVERITY_LABEL } from "../../src/draft";
import { CheckBadge, frameOf, ItemIcon, itemWords, placeLabel, plainLine, ReplyDraftBadge, SEVERITY_TONE, TAG_TONE } from "./look";
import { CommentCard, whereOf } from "./CommentCard";
import { PreExistingBadge } from "../InlineDraft";

/** A row's second line: its latest message, with who wrote it when that isn't who started it. */
function latestOf(item: CommentItem): string {
  if (item.kind === "draft") return plainLine(item.comment.body);
  if (!item.latest) return "";
  const first = plainLine(item.latest.body);
  return (item.kind === "thread" && item.messages.length > 1) || item.kind === "private" ? `${item.latest.who}: ${first}` : first;
}

/** How many messages a draft comment has with the agent. */
const talkOf = (item: CommentItem) => item.kind === "draft" ? item.discussion?.entries.filter((entry) => entry.kind === "message").length ?? 0 : 0;
const talkWords = (talk: number) => `${talk} message${talk === 1 ? "" : "s"} with the agent`;

/** An item's words for a screen reader: its state, who, where, its severity, whether it's pre-existing, and check, its talk with the agent, its reply draft. */
function nameOf(item: CommentItem, preExisting: boolean): string {
  const parts: Array<string | null> = [item.kind === "draft" ? item.label : item.kind === "thread" ? `${item.who} · ${itemWords(item)}` : itemWords(item), whereOf(item)];
  if (item.kind === "draft") {
    parts.push(item.comment.severity ? SEVERITY_LABEL[item.comment.severity] : null, preExisting ? "Pre-existing" : null);
    const talk = talkOf(item);
    parts.push(talk ? talkWords(talk) : null, item.discussion?.waiting ? "Waiting for agent" : null);
  } else if (item.kind === "thread") parts.push(item.tag);
  if ((item.kind === "thread" || item.kind === "ask") && item.check) parts.push(`agent's check: ${item.check.label}`);
  if (item.kind === "thread") parts.push(item.replyDraft?.label ?? null);
  return parts.filter(Boolean).join(" · ");
}

/** What the row's card is called: "Draft comment on src/a.ts:2". */
function cardName(item: CommentItem): string {
  if (item.kind === "draft") return `Draft comment on ${whereOf(item)}`;
  if (item.kind === "thread") return `GitHub thread on ${whereOf(item)}`;
  if (item.kind === "private") return `Private discussion on ${whereOf(item)}`;
  return item.title;
}

/**
 * One item in the Comments list: two lines, the item's state, who and its check, then its latest message. Tapping it
 * shows it in the code (`onShow`); its chevron opens it here as the full card, which is how PR-level, outdated and
 * file-level items are read and answered.
 */
export const CommentRow = memo(function CommentRow({ targetKey, item, expanded, current, onShow, onExpand }: {
  targetKey: string;
  item: CommentItem;
  expanded: boolean;
  /** The item last gone to, with ] and [ or from here. */
  current: boolean;
  /** Show it in the code; null for the whole PR's, which has no place there. */
  onShow: ((item: CommentItem) => void) | null;
  onExpand: (id: string | null) => void;
}) {
  const place = placeLabel(item);
  const severity = item.kind === "draft" ? item.comment.severity : null;
  const preExisting = useKnob("preExistingFindings") && item.kind === "draft" && item.comment.introduced === false;
  const talk = talkOf(item);
  const latest = latestOf(item);
  const show = onShow ? () => onShow(item) : () => onExpand(expanded ? null : item.id);
  return (
    <li data-comment-row={item.id} className="group/row">
      <div className={cn("flex min-w-0 items-stretch rounded-lg bg-card transition-colors", expanded ? "rounded-b-none" : "hover:bg-state-hover/60", frameOf(item), expanded && "border-b-transparent", current && "ring-2 ring-primary/40")}>
        <button type="button" aria-label={nameOf(item, preExisting)} aria-current={current || undefined} title={onShow ? "Show in the code" : undefined} onClick={show}
          {...(item.kind === "draft" ? { "data-comment-at": `${item.comment.file}:${item.comment.line}:${item.comment.side}` } : {})}
          className="flex min-h-11 min-w-0 flex-1 flex-col justify-center gap-0.5 rounded-l-lg px-2.5 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50">
          <span className="flex min-w-0 items-center gap-1.5 text-xs">
            <ItemIcon item={item} />
            <span className="min-w-0 truncate font-medium text-foreground">{item.kind === "thread" ? `${item.who} · ${itemWords(item)}` : itemWords(item)}</span>
            {place && <span className="ml-auto shrink-0 pl-1 font-mono text-[11px] text-muted-foreground">{place}</span>}
          </span>
          {/* What it is in a word or two, then its latest message: on the next line when the words leave it no room. */}
          <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
            {item.at?.side === "LEFT" && item.at.line !== null && <Badge size="sm">Old line</Badge>}
            {severity && <Badge tone={SEVERITY_TONE[severity]} size="sm">{SEVERITY_LABEL[severity]}</Badge>}
            {preExisting && <PreExistingBadge />}
            {item.kind === "thread" && item.tag && <Badge tone={TAG_TONE[item.tag] ?? "neutral"} size="sm">{item.tag}</Badge>}
            {(item.kind === "thread" || item.kind === "ask") && item.check && <CheckBadge check={item.check} />}
            {item.kind === "thread" && item.replyDraft && <ReplyDraftBadge reply={item.replyDraft} />}
            {item.kind === "draft" && item.discussion?.waiting ? <Badge tone="agent" dot pulse size="sm">Waiting for agent</Badge>
              : talk > 0 && <span title={talkWords(talk)} className="inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground tabular-nums"><Icon name="MessageSquare" className="size-3" aria-hidden />{talk}</span>}
            {!expanded && latest && <span className="min-w-0 grow basis-24 truncate text-[13px] leading-snug text-muted-foreground"><InlineCode text={latest} /></span>}
          </span>
        </button>
        <button type="button" aria-label={`${expanded ? "Collapse" : "Expand"} ${cardName(item)}`} aria-expanded={expanded} onClick={() => onExpand(expanded ? null : item.id)}
          className="flex w-9 shrink-0 items-center justify-center rounded-r-lg text-subtle-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50 pointer-coarse:w-11">
          <Icon name="ChevronDown" className={cn("size-4 transition-transform duration-150 motion-reduce:transition-none", expanded && "rotate-180")} aria-hidden />
        </button>
      </div>
      {expanded && <div className="[&>article]:rounded-t-none [&>article]:border-t-0"><CommentCard targetKey={targetKey} item={item} variant="row" /></div>}
    </li>
  );
});
CommentRow.displayName = "CommentRow";
