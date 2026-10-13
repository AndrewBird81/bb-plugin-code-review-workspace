import { Fragment, type ReactNode } from "react";
import { cn } from "../lib/utils";

/**
 * Facts on a line of small text, "a · b · c", leaving out empty ones. A long line breaks only before a dot: never inside
 * a fact, nor after a dot, so a dot starts the next line rather than dangling at the end of one. Except before a chip (an
 * inline box, such as a badge): the browser may break before one whatever comes before it.
 */
export function MetaLine({ items, className, title }: { items: ReactNode[]; className?: string; title?: string }) {
  const shown = items.filter((item) => item !== null && item !== undefined && item !== false && item !== "");
  return (
    <span title={title} className={cn("block text-xs text-muted-foreground", className)}>
      {shown.map((item, index) => (
        <Fragment key={index}>
          {/* The space stays outside the hidden dot, so a screen reader hears each fact apart. */}
          {index > 0 && <>{" "}<span aria-hidden className="text-subtle-foreground">{"·\u00a0"}</span></>}
          <span className="whitespace-nowrap">{item}</span>
        </Fragment>
      ))}
    </span>
  );
}
