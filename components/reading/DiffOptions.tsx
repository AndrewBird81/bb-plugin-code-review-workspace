import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useFullscreenPortalContainer } from "../../lib/portal-scope";
import { cn } from "../../lib/utils";
import { OVERVIEW, useWorkspace } from "../../lib/workspace-context";
import { CompareMenu, compareLabel, compareProblem, lastReviewed, useCommits } from "../ComparePicker";
import { TOUCH_COMPACT, TOUCH_CONTROL } from "../touch";
import { Button } from "../ui/button";
import { Hint } from "../ui/hint";
import { useMediaQuery } from "../ui/hooks/use-media-query";
import { Icon } from "../ui/icon";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";

const row = cn("flex h-9 w-full items-center justify-between gap-3 rounded-md px-2 text-sm font-normal", TOUCH_CONTROL);

/** One way the diff draws, on or off. */
function Option({ label, on, onChange }: { label: string; on: boolean; onChange: (on: boolean) => void }) {
  return (
    <Button variant="ghost" role="switch" aria-checked={on} className={row} onClick={() => onChange(!on)}>
      {label}
      <span aria-hidden className={cn("relative h-5 w-9 shrink-0 rounded-full transition-colors", on ? "bg-primary" : "bg-muted ring-1 ring-inset ring-border")}>
        <span className={cn("absolute left-0 top-0.5 size-4 rounded-full bg-background shadow-sm transition-transform motion-reduce:transition-none", on ? "translate-x-[18px]" : "translate-x-0.5")} />
      </span>
    </Button>
  );
}

/** Choices side by side, one of them on: a radio group, whose arrow keys move the choice. */
export function Segmented<T extends string>({ label, value, options, onChange }: {
  label: string;
  value: T;
  /** `reason`: the id of the text that says why a choice is off. */
  options: { value: T; label: string; disabled?: boolean; reason?: string }[];
  onChange: (value: T) => void;
}) {
  const enabled = options.filter((option) => !option.disabled);
  function step(event: KeyboardEvent<HTMLElement>) {
    const by = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (!by) return;
    event.preventDefault();
    const next = enabled[(enabled.findIndex((option) => option.value === value) + by + enabled.length) % enabled.length];
    onChange(next.value);
    event.currentTarget.parentElement?.querySelector<HTMLElement>(`[data-value="${next.value}"]`)?.focus();
  }
  return (
    <div role="radiogroup" aria-label={label} className="flex shrink-0 rounded-md bg-muted/60 p-0.5 ring-1 ring-inset ring-border">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          data-value={option.value}
          aria-checked={option.value === value}
          aria-disabled={option.disabled || undefined}
          aria-describedby={option.reason}
          tabIndex={option.value === value ? 0 : -1}
          onKeyDown={step}
          onClick={() => { if (!option.disabled && option.value !== value) onChange(option.value); }}
          className={cn(
            "h-7 rounded-[5px] px-2.5 text-xs font-medium text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            TOUCH_COMPACT,
            option.value === value && "bg-background text-foreground shadow-xs",
            option.disabled && "cursor-default opacity-50",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** A row that goes somewhere: another page of the options, or the shortcuts. */
function Link({ label, end, onSelect }: { label: string; end: ReactNode; onSelect: () => void }) {
  return (
    <Button variant="ghost" className={row} onClick={onSelect}>
      {label}
      <span className="text-subtle-foreground">{end}</span>
    </Button>
  );
}

/** The commits to compare from, read as this page opens. */
function ComparePage({ onBack, onPicked }: { onBack: () => void; onPicked: () => void }) {
  const { review } = useWorkspace();
  const { commits, error } = useCommits(review.kind === "pr");
  return <>
    <Button variant="ghost" size="sm" aria-label="Back to Diff options" className={cn("h-8 w-full justify-start gap-1 px-1.5 text-xs text-muted-foreground", TOUCH_CONTROL)} onClick={onBack}>
      <Icon name="ChevronLeft" aria-hidden />Diff options
    </Button>
    <CompareMenu commits={commits} error={error} onPicked={onPicked} />
  </>;
}

/**
 * How the diff draws, behind one button: Layout, Wrap long lines, Hide whitespace changes, GitHub threads in code (the
 * PR has `threads`), and Fold comments in code on a phone, one held sideways, or where the band has no room for its
 * own (`foldInBand`); collapsing or expanding the chapter's files; and what the diff compares with, where the band has
 * no compare select (`compareInBand`). A bottom drawer on a phone and on one held sideways.
 */
export function DiffOptions({ threads, compareInBand = false, foldInBand = false, className }: { threads: boolean; compareInBand?: boolean; foldInBand?: boolean; className?: string }) {
  const { review, activeId, layout, compare, display, files, showShortcuts, shortcuts } = useWorkspace();
  const container = useFullscreenPortalContainer();
  const fine = useMediaQuery("(any-pointer: fine)");
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<"options" | "compare">("options");
  const content = useRef<HTMLDivElement>(null);
  const splitReason = useId();
  // A page that opens takes the focus from the row that opened it, which it replaces.
  const turned = useRef(false);
  useEffect(() => {
    if (turned.current) content.current?.querySelector<HTMLElement>("button")?.focus();
    turned.current = false;
  }, [page]);
  const turn = (to: typeof page) => { turned.current = true; setPage(to); };
  const close = () => { setOpen(false); setPage("options"); };
  const tablet = layout.mode === "tablet";
  const isPr = review.kind === "pr";
  const lastReview = lastReviewed(compare);
  // Without a compare select in the band, the comparison is here: switched on and off, and picked from the commits.
  const comparing = !compareInBand && (!!lastReview || !!compare.from);
  const picking = !compareInBand && isPr && !comparing;
  return (
    <Popover open={open} onOpenChange={(next) => { setOpen(next); if (!next) setPage("options"); }}>
      <Hint label="Diff options" container={container}>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="sm" aria-label="Diff options" className={cn("size-8 shrink-0 px-0 text-muted-foreground aria-expanded:bg-state-active aria-expanded:text-foreground", TOUCH_CONTROL, className)}>
            <Icon name="SlidersHorizontal" aria-hidden />
          </Button>
        </PopoverTrigger>
      </Hint>
      <PopoverContent ref={content} align="end" aria-label="Diff options" mobileTitle="Diff options" className="w-80 max-w-[calc(100vw-24px)] p-1">
        {page === "compare" ? <ComparePage onBack={() => turn("options")} onPicked={close} /> : <>
          <p aria-hidden className="px-2 pb-1 pt-1.5 text-xs font-medium text-muted-foreground">Diff options</p>
          {comparing && <div className="border-b border-border pb-1">
            <div className={cn(row, "hover:bg-transparent")}>
              Show changes
              <Segmented label="Show changes" value={compare.narrowed ? "since" : "all"} onChange={(value) => value === "all" ? compare.setNarrowed(false) : compare.pick(compare.from)}
                options={[{ value: "all", label: "All" }, { value: "since", label: compareLabel(true, compare.from) }]} />
            </div>
            {compare.error && <p role="status" className="flex items-center gap-1.5 px-2 pb-1.5 text-xs text-destructive-text"><Icon name="AlertCircle" className="size-3.5 shrink-0" aria-hidden />{compareProblem(compare)}</p>}
            {isPr && <Link label="Since a commit…" end={<Icon name="ChevronRight" className="size-4" aria-hidden />} onSelect={() => turn("compare")} />}
          </div>}
          <div className={cn(comparing && "pt-1")}>
            {/* A phone, or one held sideways, has room for one column only. */}
            {tablet && <div className={cn(row, "hover:bg-transparent")}>
              Layout
              <Segmented label="Layout" value={display.unifiedOnly ? "unified" : display.layout} onChange={display.toggleLayout}
                options={[{ value: "unified", label: "Unified" }, { value: "split", label: "Split", disabled: display.unifiedOnly, reason: display.unifiedOnly ? splitReason : undefined }]} />
            </div>}
            {tablet && display.unifiedOnly && <p id={splitReason} className="-mt-1 px-2 pb-1 text-right text-xs text-muted-foreground">Split view needs a wider pane</p>}
            {/* A file the PR adds or deletes whole: its code with a rail beside it, or every line marked as a change. */}
            <div className={cn(row, "hover:bg-transparent")}>
              New and deleted files
              <Segmented label="New and deleted files" value={display.newFiles} onChange={display.setNewFiles}
                options={[{ value: "file", label: "As file" }, { value: "diff", label: "As diff" }]} />
            </div>
            {/* A .md or .markdown file: its diff, or rendered with its changed blocks marked. */}
            <div className={cn(row, "hover:bg-transparent")}>
              Markdown files
              <Segmented label="Markdown files" value={display.markdownFiles} onChange={display.setMarkdownFiles}
                options={[{ value: "source", label: "Source" }, { value: "rendered", label: "Rendered" }]} />
            </div>
            <Option label="Wrap long lines" on={display.wrap} onChange={display.setWrap} />
            <Option label="Hide whitespace changes" on={display.hideWhitespace} onChange={display.setHideWhitespace} />
            {isPr && threads && <Option label="GitHub threads in code" on={display.githubThreads} onChange={display.setGithubThreads} />}
            {(!tablet || !foldInBand) && <Option label="Fold comments in code" on={display.commentsFolded} onChange={display.setCommentsFolded} />}
          </div>
          {activeId !== OVERVIEW && <div className="mt-1 border-t border-border px-2 pb-1 pt-2">
            <p className="text-xs font-medium text-muted-foreground">Files in this chapter</p>
            <div className="mt-1.5 flex gap-2">
              {([["Collapse all", true], ["Expand all", false]] as const).map(([label, folded]) => (
                <Button key={label} variant="outline" size="sm" className={cn("h-8 flex-1 text-xs", TOUCH_CONTROL)} onClick={() => { files.foldAll(folded); close(); }}>{label}</Button>
              ))}
            </div>
          </div>}
          {(picking || (fine && shortcuts)) && <div className="mt-1 border-t border-border pt-1">
            {picking && <Link label="Compare with a commit…" end={<Icon name="ChevronRight" className="size-4" aria-hidden />} onSelect={() => turn("compare")} />}
            {fine && shortcuts && <Link label="Keyboard shortcuts" end={<kbd className="font-mono text-xs">?</kbd>} onSelect={() => { close(); showShortcuts(); }} />}
          </div>}
        </>}
      </PopoverContent>
    </Popover>
  );
}
