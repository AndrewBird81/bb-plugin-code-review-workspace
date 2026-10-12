import type { ReactNode } from "react";
import { cn } from "../../lib/utils";
import { Icon } from "../ui/icon";
import { InlineCode } from "../ui/inline-code";
import { plainLine } from "./look";

/**
 * A comment in the code folded to one line (Fold comments, `i`): its icon, who, its state or severity, its first line,
 * what's under it ("2 replies · Resolved"), and Show, which opens it in full. 28px tall, 44px on a coarse pointer; its
 * frame keeps the card's: dashed with an edge while it's only in BB, solid on GitHub, muted when private.
 */
export function CommentPill({ frame, icon, who, words, text, more, name, onShow, className }: {
  /** The card's frame classes (look.tsx). */
  frame: string;
  icon: ReactNode;
  who: string | null;
  /** Its state or severity, in words: "Agent draft · Blocking". */
  words: string;
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
  return (
    <div role="group" aria-label={`${name}, folded`} className={cn("mx-2 my-1 flex h-7 max-w-3xl min-w-0 items-center [contain:inline-size] gap-1.5 overflow-hidden rounded-md bg-card pl-2 font-sans text-xs leading-none whitespace-nowrap text-muted-foreground shadow-xs pointer-coarse:h-11", frame, className)}>
      {icon}
      {who && <span className="shrink-0 font-medium text-foreground">{who}</span>}
      <span className="shrink-0">{words}</span>
      <span aria-hidden className="shrink-0 text-subtle-foreground">·</span>
      <span className="min-w-0 flex-1 truncate text-foreground/80"><InlineCode text={first} /></span>
      {more && <span className="hidden shrink-0 text-subtle-foreground @min-[520px]/review:inline">{more}</span>}
      <button type="button" aria-label={`Show ${name}`} onClick={onShow}
        className="flex h-full shrink-0 items-center gap-1 px-2 font-medium text-primary outline-none hover:bg-state-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50 pointer-coarse:min-w-11 pointer-coarse:justify-center">
        Show<Icon name="ChevronDown" className="size-3" aria-hidden />
      </button>
    </div>
  );
}
