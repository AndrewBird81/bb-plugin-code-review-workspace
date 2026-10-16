import { memo, useId } from "react";
import type { z } from "zod";
import type { HotspotSchema } from "../src/guide";
import { Icon } from "./ui/icon";
import { InlineCode } from "./ui/inline-code";

/**
 * The guide's hotspots, highest risk first, each opening its line: read before the rest, since defects in what's read
 * last get missed.
 */
export const StartHere = memo(function StartHere({ hotspots, onOpen }: {
  hotspots: z.infer<typeof HotspotSchema>[];
  onOpen: (file: string, line: number, side: "LEFT" | "RIGHT") => void;
}) {
  const id = useId();
  return (
    <ol className="-mx-2 space-y-px">
      {hotspots.map(({ file, line, side = "RIGHT", why }, index) => {
        // A removed line opens on the diff's old side.
        const at = `${file}:${line}${side === "LEFT" ? " (removed line)" : ""}`;
        return (
          <li key={`${file}:${line}:${side}`}>
            <button type="button" aria-label={at} aria-describedby={`${id}-${index}`} title={at} onClick={() => onOpen(file, line, side)} className="group flex w-full items-baseline gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring pointer-coarse:min-h-11 pointer-coarse:items-center">
              <span aria-hidden className="w-3 shrink-0 text-right text-xs tabular-nums text-subtle-foreground">{index + 1}</span>
              {/* Where the row is narrow, why goes under its line rather than beside it. */}
              <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2.5">
                <span className="shrink-0 font-mono text-xs text-primary">{file.split("/").pop()}:{line}</span>
                <span id={`${id}-${index}`} className="min-w-0 flex-1 basis-60 text-sm text-foreground/90"><InlineCode text={why} /></span>
              </span>
              <Icon name="ArrowRight" className="size-3.5 shrink-0 self-center text-subtle-foreground transition-colors group-hover:text-foreground" aria-hidden />
            </button>
          </li>
        );
      })}
    </ol>
  );
});
StartHere.displayName = "StartHere";
