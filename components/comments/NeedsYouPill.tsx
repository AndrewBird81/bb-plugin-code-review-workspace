import type { CSSProperties } from "react";
import { cn } from "../../lib/utils";
import { Icon } from "../ui/icon";

/**
 * "3 need you ›", floating over the code once when a review came back to you and Comments couldn't open beside it, as
 * on a phone: it opens Comments on Needs you. ✕ puts it away.
 */
export function NeedsYouPill({ count, className, style, onOpen, onDismiss }: { count: number; className?: string; style?: CSSProperties; onOpen: () => void; onDismiss: () => void }) {
  return (
    <div style={style} className={cn("absolute z-40 flex w-max items-center rounded-full border border-primary/30 bg-popover shadow-xl ring-1 ring-primary/10 animate-in fade-in slide-in-from-bottom-2 duration-200 motion-reduce:animate-none", className)}>
      <button type="button" onClick={onOpen} className="flex h-9 items-center gap-1.5 rounded-l-full pl-3.5 pr-2 text-sm font-medium text-primary outline-none hover:bg-primary/10 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50 pointer-coarse:h-11">
        <Icon name="MessageSquare" className="size-4" aria-hidden />{count} need you<Icon name="ChevronRight" className="size-4" aria-hidden />
      </button>
      <button type="button" aria-label="Dismiss" onClick={onDismiss} className="flex h-9 w-8 items-center justify-center rounded-r-full text-muted-foreground outline-none hover:bg-state-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50 pointer-coarse:h-11 pointer-coarse:w-11">
        <Icon name="X" className="size-3.5" aria-hidden />
      </button>
    </div>
  );
}
