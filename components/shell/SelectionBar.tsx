import type { SelectedLineRange } from "@pierre/diffs";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";

/**
 * What's selected in the diff, with what you can do with it: lines picked GitHub-style, or code text. On a `phone`
 * the lines' bar takes the dock's place, at the bottom.
 */
export function SelectionBar({ lines, text, phone, onComment, onAskLines, onClear, onAskText }: {
  lines: { file: string; range: SelectedLineRange } | null;
  phone: boolean;
  /** Selected code, where it sits on screen. */
  text: { x: number; y: number } | null;
  onComment: () => void;
  onAskLines: () => void;
  onClear: () => void;
  onAskText: () => void;
}) {
  return <>
    {lines && (
      <div className={cn("fixed left-1/2 z-[62] flex w-max max-w-[calc(100vw-24px)] -translate-x-1/2 items-center gap-1.5 rounded-xl border border-border bg-popover px-2 py-1.5 text-xs shadow-2xl ring-1 ring-primary/10", phone ? "bottom-[calc(4px+env(safe-area-inset-bottom))]" : "bottom-24 flex-wrap")}>
        {/* On a phone the bar keeps to one row: the file's name gives way. */}
        <span className="flex min-w-0 items-center gap-1.5 px-1 font-mono text-[11px] text-muted-foreground">
          <Icon name="File" className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate">{lines.file.split("/").pop()}</span>
          <span className="shrink-0 rounded bg-primary/10 px-1 text-primary">
            L{lines.range.start}
            {lines.range.end !== lines.range.start ? `–${lines.range.end}` : ""}
          </span>
        </span>
        <span className="h-4 w-px shrink-0 bg-border" />
        <Button size="sm" variant="ghost" className="h-9 shrink-0 gap-1.5 px-2 text-xs md:h-7" onClick={onComment}>
          <Icon name="MessageSquarePlus" className="size-3.5 text-primary" aria-hidden />
          Add comment
        </Button>
        <Button size="sm" variant="ghost" className="h-9 shrink-0 gap-1.5 px-2 text-xs md:h-7" onClick={onAskLines}>
          <Icon name="Sparkles" className="size-3.5 text-(--ansi-13)" aria-hidden />
          Ask agent
        </Button>
        <button
          type="button"
          aria-label="Clear selection"
          onClick={onClear}
          className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-state-hover hover:text-foreground"
        >
          <Icon name="X" className="size-3.5" aria-hidden />
        </button>
      </div>
    )}
    {text && (
      <button
        type="button"
        onClick={onAskText}
        className="fixed z-[62] flex -translate-x-1/2 -translate-y-full items-center gap-1.5 rounded-lg bg-(--ansi-13) px-2.5 py-1 text-xs font-semibold text-background shadow-lg hover:brightness-110"
        style={{ left: text.x, top: text.y - 6 }}
      >
        <Icon name="Sparkles" className="size-3.5" aria-hidden />
        Ask agent about this
      </button>
    )}
  </>;
}
