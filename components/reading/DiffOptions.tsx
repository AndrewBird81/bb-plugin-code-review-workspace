import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../../src/rpc-contract";
import { useFullscreenPortalContainer } from "../../lib/portal-scope";
import { hasNotPushed } from "../../lib/main-thread";
import { cn } from "../../lib/utils";
import { OVERVIEW, useWorkspace } from "../../lib/workspace-context";
import { CompareMenu, ComparePicker, compareLabel, compareProblem, sinceFrom, useCommits } from "../ComparePicker";
import { TOUCH_COMPACT, TOUCH_CONTROL } from "../touch";
import { Button } from "../ui/button";
import { Hint } from "../ui/hint";
import { useMediaQuery } from "../ui/hooks/use-media-query";
import { Icon } from "../ui/icon";
import { Input } from "../ui/input";
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

type Candidate = { ref: string; ahead: number | null; behind: number | null };

/**
 * What a folder's local review is against: Automatic, the base its branch left last, or one you choose, from the bases
 * it weighs or typed; as `bb review --base`. A branch with an open PR is against the PR's base instead.
 */
function BasePage({ onBack, onPicked }: { onBack: () => void; onPicked: () => void }) {
  const { review, targetKey } = useWorkspace();
  const rpc = useRpc<typeof rpcContract>();
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const chosen = review.feature?.chosenBase;
  useEffect(() => {
    rpc.call("featureBases", { targetKey }).then((result) => setCandidates(result.candidates), () => setCandidates([]));
  }, [rpc, targetKey]);
  const pick = (base: string | null) => {
    if (busy) return;
    setBusy(true);
    rpc.call("setFeatureBase", { targetKey, base }).then((result) => {
      if (!result.ok) toast.error(result.error ?? "Couldn’t change the base.");
      else onPicked();
    }, () => toast.error("Couldn’t change the base.")).finally(() => setBusy(false));
  };
  const since = (candidate: Candidate) => candidate.ahead === null ? "Not in this folder" : `${candidate.ahead} ${candidate.ahead === 1 ? "commit" : "commits"} since`;
  const choice = "flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-state-hover focus-visible:bg-state-hover focus-visible:outline-none";
  return <>
    <Button variant="ghost" size="sm" aria-label="Back to Diff options" className={cn("h-8 w-full justify-start gap-1 px-1.5 text-xs text-muted-foreground", TOUCH_CONTROL)} onClick={onBack}>
      <Icon name="ChevronLeft" aria-hidden />Diff options
    </Button>
    <div role="menu" aria-label="Base" aria-busy={busy || undefined} className="flex flex-col">
      <p aria-hidden className="px-2 pb-1 pt-1.5 text-xs font-medium text-muted-foreground">Base</p>
      <button type="button" role="menuitemradio" aria-checked={!chosen} className={cn(choice, TOUCH_CONTROL)} onClick={() => pick(null)}>
        <Icon name="Check" className={cn("mt-0.5 size-3.5 shrink-0 text-primary", chosen && "invisible")} aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block truncate">Automatic</span>
          <span className="block truncate text-[11px] text-subtle-foreground">What the branch left last{!chosen && review.feature ? ` · ${review.feature.baseRef}` : ""}</span>
        </span>
      </button>
      {!candidates && <p role="status" className="px-2 py-1.5 text-xs text-muted-foreground">Reading the folder’s branches…</p>}
      {[...candidates ?? [], ...chosen && candidates && !candidates.some((candidate) => candidate.ref === chosen) ? [{ ref: chosen, ahead: null, behind: null }] : []].map((candidate) => (
        <button key={candidate.ref} type="button" role="menuitemradio" aria-checked={chosen === candidate.ref} className={cn(choice, TOUCH_CONTROL)} onClick={() => pick(candidate.ref)}>
          <Icon name="Check" className={cn("mt-0.5 size-3.5 shrink-0 text-primary", chosen !== candidate.ref && "invisible")} aria-hidden />
          <span className="min-w-0 flex-1">
            <span className="block truncate font-mono text-xs">{candidate.ref}</span>
            <span className="block truncate text-[11px] text-subtle-foreground">{since(candidate)}</span>
          </span>
        </button>
      ))}
      <form className="flex gap-1.5 px-2 pb-1 pt-1.5" onSubmit={(event) => { event.preventDefault(); if (typed.trim()) pick(typed.trim()); }}>
        <Input aria-label="Another base" placeholder="Another branch or commit" value={typed} onChange={(event) => setTyped(event.target.value)} className="h-8 font-mono text-xs" />
        <Button type="submit" variant="outline" size="sm" disabled={!typed.trim() || busy} className={cn("h-8 text-xs", TOUCH_CONTROL)}>Use</Button>
      </form>
      <p className="px-2 pb-1.5 text-[11px] text-subtle-foreground">Once the branch has an open PR, the diff is against the PR’s base.</p>
    </div>
  </>;
}

/** Diff options, also used as a page of the review's ⋯ menu. */
export function DiffOptionsPage({ threads, menu = false, onClose }: { threads: boolean; menu?: boolean; onClose: () => void }) {
  const { review, activeId, layout, compare, display, files, showShortcuts, shortcuts } = useWorkspace();
  const fine = useMediaQuery("(any-pointer: fine)");
  const [page, setPage] = useState<"options" | "compare" | "base">("options");
  const content = useRef<HTMLDivElement>(null);
  const splitReason = useId();
  const turned = useRef(false);
  useEffect(() => {
    if (turned.current) content.current?.querySelector<HTMLElement>("button")?.focus();
    turned.current = false;
  }, [page]);
  const turn = (to: typeof page) => { turned.current = true; setPage(to); };
  const close = onClose;
  const tablet = layout.mode === "tablet";
  const isPr = review.kind === "pr";
  const since = sinceFrom(compare, review);
  const comparing = since !== undefined;
  const picking = isPr && !comparing;
  // A folder's local review: what its diff is against, as `bb review --base` sets it.
  const folderBase = review.kind === "ref" && review.feature && !review.feature.folderGone ? review.feature : null;
  return <div ref={content}>
        {page === "compare" ? <ComparePage onBack={() => turn("options")} onPicked={close} />
          : page === "base" ? <BasePage onBack={() => turn("options")} onPicked={close} /> : <>
          <p aria-hidden className="px-2 pb-1 pt-1.5 text-xs font-medium text-muted-foreground">Diff options</p>
          {folderBase && <div className="border-b border-border pb-1">
            <Link label="Base" end={<span className="flex min-w-0 items-center gap-1"><span className="truncate font-mono text-xs">{folderBase.baseRef}</span><span className="text-xs">{folderBase.chosenBase ? "· chosen" : "· automatic"}</span><Icon name="ChevronRight" className="size-4 shrink-0" aria-hidden /></span>} onSelect={() => turn("base")} />
          </div>}
          {(comparing || hasNotPushed(review)) && menu ? <div className="border-b border-border p-1"><ComparePicker onPicked={close} /></div> : comparing && <div className="border-b border-border pb-1">
            <div className={cn(row, "hover:bg-transparent")}>
              Show changes
              <Segmented label="Show changes" value={compare.narrowed ? "since" : "all"} onChange={(value) => value === "all" ? compare.setNarrowed(false) : compare.pick(since ?? null)}
                options={[{ value: "all", label: "All" }, { value: "since", label: compareLabel(true, since ?? null) }]} />
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
            {!menu && <Option label="Fold comments in code" on={display.commentsFolded} onChange={display.setCommentsFolded} />}
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
  </div>;
}

/** A standalone entry for the chapters sheet. The review bar uses the same content inside ⋯. */
export function DiffOptions({ threads, className }: { threads: boolean; className?: string }) {
  const container = useFullscreenPortalContainer();
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Hint label="Diff options" container={container}>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="sm" aria-label="Diff options" className={cn("size-8 shrink-0 px-0 text-muted-foreground aria-expanded:bg-state-active aria-expanded:text-foreground", TOUCH_CONTROL, className)}>
            <Icon name="SlidersHorizontal" aria-hidden />
          </Button>
        </PopoverTrigger>
      </Hint>
      <PopoverContent align="end" aria-label="Diff options" mobileTitle="Diff options" className="w-80 max-w-[calc(100vw-24px)] p-1">
        {open && <DiffOptionsPage threads={threads} onClose={() => setOpen(false)} />}
      </PopoverContent>
    </Popover>
  );
}
