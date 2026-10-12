import { Fragment, type ReactNode } from "react";
import { cn } from "../lib/utils";

/**
 * Facts on a line of small text, "a · b · c", leaving out empty ones. A long line breaks only after a dot: never inside a
 * fact, nor before a dot.
 */
export function MetaLine({ items, className }: { items: ReactNode[]; className?: string }) {
  const shown = items.filter((item) => item !== null && item !== undefined && item !== false && item !== "");
  return (
    <span className={cn("block text-xs text-muted-foreground", className)}>
      {shown.map((item, index) => (
        <Fragment key={index}>
          {index > 0 && " "}
          <span className="whitespace-nowrap">{item}{index < shown.length - 1 && <span aria-hidden className="text-subtle-foreground">{"\u00a0·"}</span>}</span>
        </Fragment>
      ))}
    </span>
  );
}
