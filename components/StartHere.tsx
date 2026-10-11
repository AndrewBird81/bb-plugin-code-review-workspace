import { memo } from "react";
import type { z } from "zod";
import type { HotspotSchema } from "../src/guide";
import { Icon } from "./ui/icon";
import { InlineCode } from "./ui/inline-code";

/** The guide's hotspots, highest risk first: read before the rest, since defects in what's read last get missed. */
export const StartHere = memo(function StartHere({ hotspots, onOpen }: {
  hotspots: z.infer<typeof HotspotSchema>[];
  onOpen: (file: string, line: number) => void;
}) {
  return (
    <section aria-label="Start here" className="mt-3 space-y-1 text-xs">
      <p className="flex items-center gap-1.5 font-medium text-foreground"><Icon name="Target" className="size-3.5 text-warning-text" aria-hidden />Start here</p>
      <ol className="space-y-1 pl-5">
        {hotspots.map(({ file, line, why }) => (
          <li key={`${file}:${line}`} className="flex flex-wrap items-baseline gap-x-2">
            <button type="button" aria-label={`${file}:${line}`} title={`${file}:${line}`} className="shrink-0 font-mono text-primary hover:underline" onClick={() => onOpen(file, line)}>
              {file.split("/").pop()}:{line}
            </button>
            <span className="min-w-0 text-muted-foreground"><InlineCode text={why} /></span>
          </li>
        ))}
      </ol>
    </section>
  );
});
StartHere.displayName = "StartHere";
