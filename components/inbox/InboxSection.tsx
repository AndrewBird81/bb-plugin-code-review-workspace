import { useId, type ReactNode } from "react";
import { cn } from "../../lib/utils";
import { TOUCH_COMPACT, TOUCH_CONTROL } from "../touch";
import { Icon } from "../ui/icon";

/**
 * One of the inbox's sections, such as Needs review: a header with its count that collapses it, which sticks while its
 * rows scroll under it (`stickyTop` where something sticks above it). `short`: a page with little height, where the
 * header keeps to 36px inside a 44px target on touch.
 */
export function InboxSection({ title, count, collapsed, onToggle, stickyTop, short = false, children }: {
  title: string;
  count: number;
  collapsed: boolean;
  onToggle(): void;
  stickyTop?: string;
  short?: boolean;
  children: ReactNode;
}) {
  const bodyId = useId();
  return (
    <section aria-label={title} className="min-w-0">
      <h2 className={cn("sticky z-10 bg-background", stickyTop ?? "top-0")}>
        <button type="button" aria-expanded={!collapsed} aria-controls={bodyId} onClick={onToggle}
          className={cn("group/section flex w-full items-center gap-1.5 rounded-md px-3 text-left text-sm font-semibold text-foreground hover:bg-state-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring", `h-9 ${short ? TOUCH_COMPACT : TOUCH_CONTROL}`)}>
          {title}
          <span className="font-normal tabular-nums text-muted-foreground"><span aria-hidden>· </span>{count}</span>
          <Icon name="ChevronDown" className={cn("ml-auto size-4 text-subtle-foreground transition-transform duration-150 motion-reduce:transition-none", collapsed && "-rotate-90")} aria-hidden />
        </button>
      </h2>
      {!collapsed && <div id={bodyId}>{children}</div>}
    </section>
  );
}

/** A part of a section, such as Back to you in Needs review: a plain label with its count, then its rows. */
export function InboxPart({ title, count, short = false, children }: { title: string; count: number; short?: boolean; children: ReactNode }) {
  return (
    <div role="group" aria-label={title}>
      <h3 className={cn("px-3 pb-0.5 text-xs font-medium text-muted-foreground", short ? "pt-1" : "pt-2")}>{title} <span className="font-normal tabular-nums text-subtle-foreground"><span aria-hidden>· </span>{count}</span></h3>
      {children}
    </div>
  );
}
