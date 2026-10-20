import { useId, type ReactNode } from "react";
import { cn } from "../../lib/utils";
import { TOUCH_COMPACT, TOUCH_CONTROL } from "../touch";
import { Icon } from "../ui/icon";

/**
 * One of the inbox's sections, such as Needs review: a header with its count that collapses it, which sticks while its
 * rows scroll under it (`stickyTop` where something sticks above it). `short`: a page with little height, where the
 * header keeps to 36px inside a 44px target on touch. `urgent`: the count is what needs you, filled like the title
 * bar's needs-you badge.
 */
export function InboxSection({ title, count, urgent = false, collapsed, onToggle, stickyTop, short = false, children }: {
  title: string;
  count: number;
  urgent?: boolean;
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
          className={cn("group/section flex w-full items-center gap-2 rounded-md px-3 text-left text-base font-semibold text-foreground hover:bg-state-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring", short ? `h-9 ${TOUCH_COMPACT}` : `h-11 ${TOUCH_CONTROL}`)}>
          {title}
          <span className={cn("min-w-5 rounded-full px-1.5 text-center text-xs font-semibold leading-5 tabular-nums", urgent && count > 0 ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground")}>
            <span className="sr-only">, </span>{count}
          </span>
          <Icon name="ChevronDown" className={cn("ml-auto size-4 text-subtle-foreground transition-transform duration-150 motion-reduce:transition-none", collapsed && "-rotate-90")} aria-hidden />
        </button>
      </h2>
      {!collapsed && <div id={bodyId} className={short ? "pb-2" : "pb-4"}>{children}</div>}
    </section>
  );
}

/** A part of a section, such as Back to you in Needs review: a small-capitals label with its count, then its rows. */
export function InboxPart({ title, count, short = false, children }: { title: string; count: number; short?: boolean; children: ReactNode }) {
  return (
    <div role="group" aria-label={title}>
      <h3 className={cn("px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-subtle-foreground", short ? "pt-2" : "pt-3")}>
        {title} <span className="font-normal tabular-nums tracking-normal"><span aria-hidden>· </span>{count}</span>
      </h3>
      {children}
    </div>
  );
}

/** A section's or part's rows as one card, a hairline between rows. */
export const ROWS_CARD = "overflow-hidden rounded-xl border border-border bg-card shadow-xs divide-y divide-border";
