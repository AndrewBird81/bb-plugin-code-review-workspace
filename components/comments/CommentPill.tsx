import type { ReactNode } from "react";
import { cn } from "../../lib/utils";
import { Icon } from "../ui/icon";
import { InlineCode } from "../ui/inline-code";
import { CUT_CODE, plainLine } from "./look";

/**
 * Where a pill takes two lines, each part's classes, written out for Tailwind: on a phone, and in a review under 440px
 * wide on any pointer; one with a state badge under 600px, where on one line its state and badge left its first line
 * no room.
 */
const TWO_LINES = {
  narrow: {
    tall: "@max-[440px]/review:h-11",
    lines: "pointer-coarse:@max-[600px]/review:flex-col pointer-coarse:@max-[600px]/review:items-start pointer-coarse:@max-[600px]/review:gap-1 @max-[440px]/review:flex-col @max-[440px]/review:items-start @max-[440px]/review:gap-1",
    oneLineOnly: "pointer-coarse:@max-[600px]/review:hidden @max-[440px]/review:hidden",
    second: "pointer-coarse:@max-[600px]/review:flex-none @max-[440px]/review:flex-none",
    secondOnly: "pointer-coarse:@max-[600px]/review:inline @max-[440px]/review:inline",
    secondOnlyFlex: "pointer-coarse:@max-[600px]/review:inline-flex @max-[440px]/review:inline-flex",
  },
  stateBadge: {
    tall: "@max-[600px]/review:h-11",
    lines: "@max-[600px]/review:flex-col @max-[600px]/review:items-start @max-[600px]/review:gap-1",
    oneLineOnly: "@max-[600px]/review:hidden",
    second: "@max-[600px]/review:flex-none",
    secondOnly: "@max-[600px]/review:inline",
    secondOnlyFlex: "@max-[600px]/review:inline-flex",
  },
};

/**
 * A comment in the code folded to one line (Fold comments, `i`): its icon, who, its state or severity, its first line,
 * what's under it ("2 replies · Resolved"), and Show, which opens it in full. 28px tall, 44px on a coarse pointer; its
 * frame keeps the card's: dashed with an edge while it's only in BB, solid on GitHub, muted when private.
 */
export function CommentPill({ frame, icon, who, words, tag, stateBadge, badge, briefBadge, text, more, name, onShow, className }: {
  /** The card's frame classes (look.tsx). */
  frame: string;
  icon: ReactNode;
  who: string | null;
  /** Its state, in words: "Agent draft · not submitted"; `code` in it, as in a thread's note on a sent comment ("Done · Renamed `a`"), shows as code. */
  words: string;
  /** Its severity, in words: "Blocking". */
  tag?: string | null;
  /** What its state is about, as Not on GitHub yet: beside its state on every width, so on two lines its first line keeps the second's room. */
  stateBadge?: ReactNode;
  /** What waits with it and isn't sent: a thread's reply draft. After its state; on a phone, ahead of its first line. */
  badge?: ReactNode;
  /** The badge as a phone shows it, shorter, so its first line keeps room beside it. */
  briefBadge?: ReactNode;
  /** Its first line. */
  text: string;
  /** What's folded under it: "2 replies · Resolved". */
  more?: string | null;
  /** What it is, for Show's name: "Draft comment on src/a.ts:2". */
  name: string;
  onShow: () => void;
  className?: string;
}) {
  const first = plainLine(text);
  const two = TWO_LINES[stateBadge ? "stateBadge" : "narrow"];
  return (
    <div role="group" aria-label={`${name}, folded`} className={cn("mx-2 my-1 flex h-7 max-w-[min(72ch,calc(100%-1rem))] min-w-0 items-center [contain:inline-size] gap-1.5 rounded-md bg-card font-sans text-xs leading-none whitespace-nowrap text-muted-foreground shadow-xs pointer-coarse:h-11", two.tall, frame, className)}>
      <span className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden pl-2">
        {icon}
        {/* On a phone, two lines, as in the list's rows: who and state, then severity and the first line. So too in a
            review under 440px wide, on any pointer, where state, severity and badge would cut each other on one line
            (TWO_LINES). */}
        <span className={cn("flex min-w-0 flex-1 items-center gap-1.5", two.lines)}>
          <span className="flex max-w-full min-w-0 items-center gap-1.5">
            {who && <span className="shrink-0 font-medium text-foreground">{who}</span>}
            <span className={cn("min-w-0 truncate", CUT_CODE)}><InlineCode text={words} />{tag && <span className={two.oneLineOnly}> · {tag}</span>}</span>
            {stateBadge && <span className="flex shrink-0">{stateBadge}</span>}
            {badge && <span className={cn("flex shrink-0", two.oneLineOnly)}>{badge}</span>}
          </span>
          {/* A step quieter than who: at 80% a light theme's first line fell to about 4:1. Severity and badge stay whole:
              only the comment's first line is cut. */}
          <span className={cn("flex max-w-full min-w-0 flex-1 items-center gap-1.5 text-foreground/90", two.second)}>
            {/* After severity on two lines, as before the first line on one: the line's gap on either side of it. */}
            {tag && <span className={cn("hidden shrink-0 font-medium text-muted-foreground", two.secondOnly)}>{tag}</span>}
            <span aria-hidden className={cn("shrink-0 text-subtle-foreground", !tag && two.oneLineOnly)}>·</span>
            {badge && <span className={cn("hidden shrink-0", two.secondOnlyFlex)}>{briefBadge ?? badge}</span>}
            <span className={cn("min-w-0 truncate", CUT_CODE)}><InlineCode text={first} /></span>
          </span>
        </span>
        {more && <span className="hidden shrink-0 text-subtle-foreground @min-[520px]/review:inline">{more}</span>}
      </span>
      {/* Over the frame's border, so on a coarse pointer it's the pill's full 44px. */}
      <button type="button" aria-label={`Show ${name}`} onClick={onShow}
        className="-my-px -mr-px flex h-[calc(100%+2px)] shrink-0 items-center gap-1 rounded-r-md px-2 font-medium text-primary outline-none hover:bg-state-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50 pointer-coarse:min-w-11 pointer-coarse:justify-center">
        Show<Icon name="ChevronDown" className="size-3" aria-hidden />
      </button>
    </div>
  );
}
