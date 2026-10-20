import { createContext, useContext } from "react";
import type { LongRun } from "../lib/long-runs";
import { Icon } from "./ui/icon";

/** A file's long runs of deleted lines, which of them are open, which its last draw folded, and opening or closing one. */
export interface LongRuns {
  runs: readonly LongRun[];
  open: ReadonlySet<number>;
  folded: ReadonlySet<number>;
  toggle: (run: number) => void;
}
export const LongRunsContext = createContext<LongRuns | null>(null);

/**
 * The row standing for a long run's folded lines, under the run's first lines: one button across the row, "Show 174 more
 * deleted lines · old 17–190", or "Hide 174 deleted lines" once open. The lines stay where they are, only shown or
 * hidden, so the button keeps the focus. A run the draw couldn't fold shows whole, without it. The button carries the
 * fold's tint, so under a comment on the same line, whose row stays the canvas, it still reads as the fold; its focus
 * ring is the ring color at full strength, 3:1 or more on that tint.
 */
export function LongRunFold({ run }: { run: number }) {
  const folds = useContext(LongRunsContext);
  const at = folds?.runs[run];
  if (!folds || !at || !folds.folded.has(run)) return null;
  const open = folds.open.has(run);
  const count = at.count.toLocaleString();
  return (
    <button type="button" aria-expanded={open} onClick={() => folds.toggle(run)} data-gr-fold-control=""
      className="flex h-8 w-full cursor-pointer items-center gap-2 bg-(--gr-fold-bg) pr-3 pl-2 text-left font-sans text-xs leading-none font-medium whitespace-nowrap text-(--gr-fold-ink) outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring pointer-coarse:h-11">
      <Icon name={open ? "ChevronDown" : "ChevronRight"} className="size-3 shrink-0" aria-hidden />
      <span className="underline decoration-current/45 underline-offset-[3px]">{open ? `Hide ${count} deleted lines` : `Show ${count} more deleted lines`}</span>
      <span className="font-mono text-[11px] font-normal tabular-nums text-(--gr-fold-quiet)">old {at.from}–{at.to}</span>
    </button>
  );
}
