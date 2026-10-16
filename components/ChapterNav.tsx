import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { cn } from "../lib/utils";
import { classifyFile } from "../src/classify";
import { useFullscreenPortalContainer } from "../lib/portal-scope";
import { Icon } from "./ui/icon";
import { Badge, type Tone } from "./ui/badge";
import { Button } from "./ui/button";
import { Progress } from "./ui/diff-stat";
import { Hint } from "./ui/hint";
import { FileTag } from "./FileTag";
import { InlineCode } from "./ui/inline-code";
import type { FileViewFlags } from "./DiffViewer";
import { chapterReadingLines } from "../lib/review-size";
import { FileTree } from "./FileTree";
import { MetaLine } from "./MetaLine";
import { TOUCH_COMPACT, TOUCH_CONTROL } from "./touch";
import type { FileInterdiff } from "../src/interdiff";
import type { ReviewThread } from "../src/threads";
import type { FileOwners } from "../src/codeowners";
import type { NavView } from "../lib/panel-state";

interface Section {
  id: string;
  title: string;
  overview: string;
  diffs: { file: string; summary?: string; hunks?: number[] }[];
  risk?: string;
}

/** Focus the review's code (`data-review-code`) nearest `from`, where its keys scroll it. */
function skipToCode(from: HTMLElement) {
  for (let el = from.parentElement; el; el = el.parentElement) {
    const code = el.querySelector<HTMLElement>("[data-review-code]");
    if (code) return code.focus({ preventScroll: true });
  }
}

/** Each path's shortest tail that no other path in `paths` ends with: its name, unless another file has that name too. */
export function shortPaths(paths: readonly string[]): Map<string, string> {
  const tails = (path: string) => path.split("/").map((_, i, parts) => parts.slice(i).join("/")).reverse();
  const seen = new Map<string, number>();
  for (const path of new Set(paths)) for (const tail of tails(path)) seen.set(tail, (seen.get(tail) ?? 0) + 1);
  return new Map(paths.map((path) => [path, tails(path).find((tail) => seen.get(tail) === 1) ?? path]));
}

export const RISK_TONE: Record<string, Tone> = { high: "danger", medium: "warning", low: "neutral" };
export const RISK_LABEL: Record<string, string> = { high: "High risk", medium: "Medium risk", low: "Low risk" };

/**
 * A chapter's step on the guide's path: its number inside a ring that fills
 * green as its files are viewed. The open chapter is solid blue; a finished
 * one shows a check.
 */
export function StepMarker({ index, viewed, total, active }: { index: number; viewed: number; total: number; active: boolean }) {
  const done = total > 0 && viewed === total;
  const ratio = total ? viewed / total : 0;
  return (
    <span
      aria-hidden
      className="relative z-[1] mt-px flex size-[22px] shrink-0 items-center justify-center rounded-full"
      style={{ background: `conic-gradient(var(--success) ${ratio * 360}deg, var(--border) 0deg)` }}
    >
      <span
        className={cn(
          "flex size-[18px] items-center justify-center rounded-full text-[10px] font-semibold tabular-nums",
          active ? "bg-primary text-primary-foreground" : done ? "bg-success text-background" : "bg-background text-muted-foreground",
        )}
      >
        {done && !active ? <Icon name="Check" className="size-3" /> : index + 1}
      </span>
    </span>
  );
}

/** Chapters | All files: the navigator's two views. On a coarse pointer the track's padding is part of each 44px target. */
export function ChapterViewSwitch({ view, onChange }: { view: NavView; onChange: (view: NavView) => void }) {
  return (
    <span className="inline-flex items-center gap-0.5 rounded-md bg-muted/40 p-0.5 text-xs ring-1 ring-inset ring-border">
      {(["chapters", "files"] as const).map((value) => (
        <button
          key={value}
          type="button"
          aria-pressed={view === value}
          onClick={() => onChange(value)}
          className="relative rounded px-2 py-0.5 font-medium text-muted-foreground hover:text-foreground aria-pressed:bg-background aria-pressed:text-foreground aria-pressed:shadow-xs pointer-coarse:min-h-10 pointer-coarse:px-3 pointer-coarse:after:absolute pointer-coarse:after:-inset-y-0.5 pointer-coarse:after:inset-x-0 pointer-coarse:after:content-['']"
        >
          {value === "chapters" ? "Chapters" : "All files"}
        </button>
      ))}
    </span>
  );
}

export const ChapterNav = memo(function ChapterNav({
  sections,
  activeId,
  onSelect,
  views,
  onSelectFile,
  currentFile,
  changedSince,
  lines,
  generated,
  view = "chapters",
  onViewChange,
  since,
  threads,
  owners,
  sinceWhat = "your review",
  patch,
  overview,
  onMarkViewed,
  onNextUnviewed,
  sheet = false,
}: {
  sections: Section[];
  activeId: string;
  onSelect: (id: string) => void;
  views: Map<string, FileViewFlags>;
  onSelectFile: (chapterId: string, file: string) => void;
  /** The file you're on, which a key or click went to or the diff is scrolled to, marked in the open chapter's list. */
  currentFile?: string;
  /** Per chapter id, how many of its files changed since your review. */
  changedSince?: Record<string, number>;
  /** Each file's changed lines (lib/review-size.ts). */
  lines?: ReadonlyMap<string, number>;
  /** Files the repo's .gitattributes marks generated or vendored. */
  generated?: ReadonlySet<string>;
  /** The chapters, or every file as a folder tree. */
  view?: NavView;
  onViewChange?: (view: NavView) => void;
  /** All files: each file compared with your last review, everyone's GitHub threads, and CODEOWNERS owners. */
  since?: Map<string, FileInterdiff> | null;
  threads?: readonly ReviewThread[];
  owners?: ReadonlyMap<string, FileOwners>;
  /** What changedSince and since compare with: "your review", or a commit. */
  sinceWhat?: string;
  /** The diff, for the lines of a file split across chapters. */
  patch?: string;
  /** The Overview's row, the step before the first chapter. */
  overview?: ReactNode;
  /** Mark a chapter's files viewed: an open chapter's button, and the ✓ a closed one shows on hover or focus. */
  onMarkViewed?: (id: string) => void;
  /** Open the next file not viewed yet (u). */
  onNextUnviewed?: () => void;
  /** In a phone's sheet, whose header holds the switch: the files viewed share the progress's row. */
  sheet?: boolean;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const container = useFullscreenPortalContainer();
  const isExpanded = (id: string) => expanded[id] ?? id === activeId;
  const chapterButtons = useRef(new Map<string, HTMLButtonElement>());
  // Marking hides the control that did it: its focus moves to the chapter's own button rather than to the page. A tap
  // that didn't focus the control (Safari) leaves the focus where it was, such as in a comment being written.
  const markViewed = (id: string, control: HTMLElement) => {
    onMarkViewed?.(id);
    if (document.activeElement === control) chapterButtons.current.get(id)?.focus({ preventScroll: true });
  };
  // A file split across chapters counts once.
  const allFiles = [...new Set(sections.flatMap((s) => s.diffs.map((d) => d.file)))];
  const shortNames = useMemo(() => shortPaths(sections.flatMap((s) => s.diffs.map((d) => d.file))), [sections]);
  // The current file's row stays in sight as the code moves on through the chapter.
  const currentRow = useRef<HTMLButtonElement | null>(null);
  useEffect(() => { currentRow.current?.scrollIntoView?.({ block: "nearest" }); }, [currentFile, activeId]);
  const viewedAll = allFiles.filter((f) => views.get(f)?.viewed).length;
  const toRead = useMemo(() => lines ? chapterReadingLines(sections, patch ?? "", lines, generated) : null, [sections, patch, lines, generated]);
  // A split file opens in the open chapter when it's there, else in the first chapter with it.
  const chapterOf = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of sections) for (const d of s.diffs) if (!map.has(d.file) || s.id === activeId) map.set(d.file, s.id);
    return map;
  }, [sections, activeId]);

  return (
    <nav aria-label="Chapters" className="space-y-3">
      {/* Past the chapters, for the keyboard: shown on focus, and only where they're docked, not over the code. */}
      <button type="button" onClick={(event) => skipToCode(event.currentTarget)} className="sr-only rounded-md bg-background px-2 py-1 text-xs font-medium text-primary focus:not-sr-only focus:block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [[data-gr-side]_&]:hidden">
        Skip to code
      </button>
      <div className="space-y-1.5 px-1">
        {!sheet && <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-xs">
          {onViewChange ? <ChapterViewSwitch view={view} onChange={onViewChange} /> : <span className="font-medium text-foreground">Chapters</span>}
          <span className="tabular-nums text-muted-foreground">{viewedAll}/{allFiles.length} files viewed</span>
        </div>}
        <div className="flex items-center gap-2">
          {sheet && <span className="text-xs tabular-nums text-muted-foreground">{viewedAll}/{allFiles.length}<span className="sr-only"> files viewed</span></span>}
          <Progress value={viewedAll} max={allFiles.length} label="Files viewed" className="flex-1" />
          {onNextUnviewed && viewedAll < allFiles.length && (
            <Button variant="ghost" size="sm" className={cn("-mr-1 h-6 shrink-0 gap-0.5 px-1.5 text-xs font-normal text-primary hover:text-primary [&_svg]:size-3.5", TOUCH_COMPACT)} onClick={onNextUnviewed}>
              Next unviewed<Icon name="ChevronRight" aria-hidden />
            </Button>
          )}
        </div>
      </div>
      {view === "files" ? (
        <FileTree chapterOf={chapterOf} views={views} onSelectFile={onSelectFile} currentFile={currentFile} since={since} threads={threads} owners={owners} generated={generated} sinceWhat={sinceWhat} />
      ) : (
      <div className="space-y-0.5">
      {overview}
      <ol className="relative space-y-0.5">
        {sections.map((s, index) => {
          const active = s.id === activeId;
          const open = isExpanded(s.id);
          const skippable = s.diffs.filter((d) => classifyFile(d.file, generated?.has(d.file)).skippable).length;
          const allSkippable = s.diffs.length > 0 && skippable === s.diffs.length;
          const viewed = s.diffs.filter((d) => views.get(d.file)?.viewed).length;
          const done = s.diffs.length > 0 && viewed === s.diffs.length;
          const changed = changedSince?.[s.id] ?? 0;
          const chapterLines = toRead?.get(s.id) ?? 0;
          return (
            <li key={s.id} className="relative">
              {index < sections.length - 1 && <span aria-hidden className="absolute bottom-[-6px] left-[18px] top-7 w-px bg-border" />}
              <div
                className={cn(
                  "group/card rounded-lg transition-colors duration-150",
                  active ? "bg-state-active/50 ring-1 ring-inset ring-primary/20" : "hover:bg-state-hover",
                )}
              >
                <div className="flex items-start gap-2.5 py-2 pl-[7px] pr-1">
                  <StepMarker index={index} viewed={viewed} total={s.diffs.length} active={active} />
                  <button ref={(button) => { if (button) chapterButtons.current.set(s.id, button); else chapterButtons.current.delete(s.id); }} onClick={() => onSelect(s.id)} aria-current={active ? "step" : undefined} title={s.overview || undefined} className="min-w-0 flex-1 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11">
                    <span className={cn("block text-sm font-medium leading-snug line-clamp-3", active ? "text-foreground" : "text-foreground/90")}>
                      <InlineCode text={s.title} />
                    </span>
                    <MetaLine className="mt-1 text-[11px] leading-5 tabular-nums" items={[
                      s.risk && s.risk !== "low" && <Badge tone={RISK_TONE[s.risk] ?? "neutral"} size="sm" className="align-[-2px]">{RISK_LABEL[s.risk] ?? s.risk}</Badge>,
                      `${s.diffs.length} file${s.diffs.length === 1 ? "" : "s"}`,
                      chapterLines > 0 && <span title="Changed lines, without lockfiles and generated files">{chapterLines.toLocaleString()} {chapterLines === 1 ? "line" : "lines"}</span>,
                      changed > 0 && <span className="text-primary" title={`${changed} file${changed === 1 ? "" : "s"} changed since ${sinceWhat}`}>{changed} changed</span>,
                      skippable > 0 && `${skippable} skippable`,
                      allSkippable && <span className="italic">generated files — skim</span>,
                    ]} />
                    {viewed > 0 && <span className="sr-only">, {viewed} of {s.diffs.length} viewed</span>}
                  </button>
                  {/* Skipping a chapter without opening it: with a pointer, from its row. A touch opens the row instead. */}
                  {onMarkViewed && !open && !done && (
                    <Hint label={`Mark chapter ${index + 1} viewed`} container={container}>
                      <Button variant="ghost" size="sm" aria-label={`Mark chapter ${index + 1} viewed`} className="size-7 shrink-0 px-0 text-muted-foreground opacity-0 transition-opacity hover:text-diff-added focus-visible:opacity-100 group-hover/card:opacity-100 pointer-coarse:hidden" onClick={(event) => markViewed(s.id, event.currentTarget)}>
                        <Icon name="CircleCheck" aria-hidden />
                      </Button>
                    </Hint>
                  )}
                  <button
                    type="button"
                    aria-label={open ? "Collapse chapter" : "Expand chapter"}
                    aria-expanded={open}
                    className={cn("flex size-7 shrink-0 items-center justify-center rounded-md text-subtle-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring", TOUCH_CONTROL)}
                    onClick={() => setExpanded((e) => ({ ...e, [s.id]: !open }))}
                  >
                    <Icon name="ChevronDown" className={cn("size-3.5 transition-transform duration-150", !open && "-rotate-90")} aria-hidden />
                  </button>
                </div>
                {open && s.diffs.length > 0 && (
                  <ul className="space-y-px pb-2 pl-8 pr-2">
                    {s.diffs.map((d) => {
                      const viewed = views.get(d.file)?.viewed ?? false;
                      const current = active && d.file === currentFile;
                      const kind = classifyFile(d.file, generated?.has(d.file));
                      // The row shows the folders only another file of its name needs; it's named by its whole path.
                      const name = [d.file, kind.category !== "code" && (kind.skippable ? `${kind.label} · skip` : kind.label), viewed && "viewed"].filter(Boolean).join(", ");
                      return (
                        <li key={d.file}>
                          <button
                            type="button"
                            ref={current ? currentRow : undefined}
                            onClick={() => onSelectFile(s.id, d.file)}
                            aria-current={current ? "true" : undefined}
                            aria-label={name}
                            className={cn("flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left hover:bg-state-hover pointer-coarse:min-h-11", current && "bg-state-hover")}
                            title={d.summary ? `${d.file} — ${d.summary}` : d.file}
                          >
                            <Icon
                              name={viewed ? "CircleCheck" : "Circle"}
                              className={cn("size-3.5 shrink-0", viewed ? "text-diff-added" : current ? "text-primary" : "text-subtle-foreground")}
                              aria-hidden
                            />
                            <span
                              className={cn(
                                "min-w-0 flex-1 truncate font-mono text-[11px]",
                                viewed ? "text-muted-foreground line-through decoration-muted-foreground/40" : current ? "text-primary" : "text-foreground/90",
                              )}
                            >
                              {shortNames.get(d.file) ?? d.file}
                            </span>
                            <FileTag file={d.file} generated={generated?.has(d.file)} />
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
                {open && onMarkViewed && s.diffs.length > 0 && (
                  <div className="flex min-h-8 flex-wrap items-center justify-between gap-x-2 gap-y-1 pb-2 pl-8 pr-2 text-[11px]">
                    {done ? (
                      <span className="inline-flex items-center gap-1.5 font-medium text-diff-added"><Icon name="CircleCheck" className="size-3.5" aria-hidden />Chapter viewed</span>
                    ) : <>
                      <span className="tabular-nums text-muted-foreground">{viewed} of {s.diffs.length} viewed</span>
                      <Button variant="outline" size="sm" className={cn("h-7 gap-1.5 px-2 text-xs [&_svg]:size-3.5", TOUCH_CONTROL)} onClick={(event) => markViewed(s.id, event.currentTarget)}>
                        <Icon name="CircleCheck" aria-hidden />Mark chapter viewed
                      </Button>
                    </>}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      </div>
      )}
    </nav>
  );
});
ChapterNav.displayName = "ChapterNav";
