import { useState } from "react";
import { cn } from "../../lib/utils";
import { useWorkspace } from "../../lib/workspace-context";
import { ComparePicker } from "../ComparePicker";
import { TOUCH_CONTROL } from "../touch";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";

/** One way the diff draws, on or off. */
function Option({ label, on, onChange }: { label: string; on: boolean; onChange: (on: boolean) => void }) {
  return (
    <Button variant="ghost" role="switch" aria-checked={on} className="h-11 w-full justify-between px-2 text-sm font-normal" onClick={() => onChange(!on)}>
      {label}
      <span aria-hidden className={cn("relative h-5 w-9 shrink-0 rounded-full transition-colors", on ? "bg-primary" : "bg-muted ring-1 ring-inset ring-border")}>
        <span className={cn("absolute left-0 top-0.5 size-4 rounded-full bg-background shadow-sm transition-transform motion-reduce:transition-none", on ? "translate-x-[18px]" : "translate-x-0.5")} />
      </span>
    </Button>
  );
}

/**
 * How the diff draws, behind one button, where the band has no room for the controls: in a phone's chapters sheet,
 * and in the band of one held sideways. `threads`: the PR has GitHub threads to show.
 */
export function DiffOptions({ threads, className }: { threads: boolean; className?: string }) {
  const { targetKey, review, compare, display } = useWorkspace();
  const [open, setOpen] = useState(false);
  const isPr = review.kind === "pr";
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" aria-label="Diff options" className={cn("size-8 shrink-0 px-0 text-muted-foreground", TOUCH_CONTROL, className)}>
          <Icon name="SlidersHorizontal" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" mobileTitle="Diff options" className="w-72 p-1">
        <p aria-hidden className="px-2 pb-1 pt-1.5 text-xs font-medium text-muted-foreground">Diff options</p>
        {(compare.since || isPr) && (
          <div className="flex min-h-11 items-center justify-between gap-2 px-2">
            <span className="text-sm">Show changes</span>
            <ComparePicker targetKey={targetKey} baseline={compare.baseline} head={compare.head} from={compare.from} onFrom={compare.pick} available={!!compare.since} pickable={isPr} pressed={compare.narrowed} onToggle={() => compare.setNarrowed(!compare.narrowed)} />
          </div>
        )}
        {compare.error && (
          <p role="status" className="flex items-center gap-1.5 px-2 pb-2 text-xs text-destructive-text">
            <Icon name="AlertCircle" className="size-3.5 shrink-0" aria-hidden />
            Couldn’t compare with {compare.from ? compare.from.slice(0, 7) : "your last review"}
          </p>
        )}
        {!display.unifiedOnly && <Option label="Split view" on={display.layout === "split"} onChange={display.toggleLayout} />}
        {isPr && threads && <Option label="GitHub threads in code" on={display.githubThreads} onChange={display.setGithubThreads} />}
        <Option label="Wrap long lines" on={display.wrap} onChange={display.setWrap} />
        <Option label="Hide whitespace changes" on={display.hideWhitespace} onChange={display.setHideWhitespace} />
      </PopoverContent>
    </Popover>
  );
}
