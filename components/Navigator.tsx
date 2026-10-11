import { memo, type ReactNode } from "react";
import type { FileOwners } from "../src/codeowners";
import type { ReviewThread } from "../src/threads";
import { cn } from "../lib/utils";
import { OVERVIEW, useWorkspace } from "../lib/workspace-context";
import { ChapterNav } from "./ChapterNav";
import { FindInReview } from "./FindInReview";
import { Icon } from "./ui/icon";

/**
 * Where you are in the review: Find in review's box after `leading`, then the Overview and the chapters, or every file.
 * The workspace hosts it beside the code or over it.
 */
export const Navigator = memo(function Navigator({ leading, patch, currentFile, changedSince, lines, generated, threads, owners, onSelect, onSelectFile, onOpenLine, onOpenFile }: {
  leading: ReactNode;
  patch: string;
  /** The file you're on, marked in the open chapter's list. */
  currentFile?: string;
  /** Per chapter id, how many of its files changed since your review. */
  changedSince?: Record<string, number>;
  lines?: ReadonlyMap<string, number>;
  generated?: ReadonlySet<string>;
  threads?: readonly ReviewThread[];
  owners?: ReadonlyMap<string, FileOwners>;
  /** Show a chapter, or the Overview. */
  onSelect: (id: string) => void;
  onSelectFile: (chapterId: string, file: string) => void;
  onOpenLine: (file: string, line: number, side: "LEFT" | "RIGHT") => void;
  onOpenFile: (chapterId: string, file: string) => void;
}) {
  const { sections, activeId, files, nav, compare } = useWorkspace();
  const overview = activeId === OVERVIEW;
  return (
    <FindInReview leading={leading} patch={patch} sections={sections} onOpenLine={onOpenLine} onOpenChapter={onSelect} onOpenFile={onOpenFile}>
      <button
        type="button"
        aria-current={overview ? "page" : undefined}
        onClick={() => onSelect(OVERVIEW)}
        className={cn("mb-2 flex w-full items-center gap-2.5 rounded-lg py-2 pl-[9px] pr-2 text-left text-sm font-medium transition-colors duration-150 pointer-coarse:min-h-11", overview ? "bg-state-active/50 text-foreground ring-1 ring-inset ring-primary/20" : "text-foreground/90 hover:bg-state-hover")}
      >
        <Icon name="AlignLeft" className={cn("size-4 shrink-0", overview ? "text-primary" : "text-subtle-foreground")} aria-hidden />
        Overview
      </button>
      <ChapterNav
        sections={sections}
        activeId={activeId}
        onSelect={onSelect}
        views={files.views}
        onSelectFile={onSelectFile}
        currentFile={currentFile}
        changedSince={changedSince}
        lines={lines}
        patch={patch}
        generated={generated}
        view={nav.view}
        onViewChange={nav.setView}
        since={compare.since}
        threads={threads}
        owners={owners}
        sinceWhat={compare.what}
      />
    </FindInReview>
  );
});
Navigator.displayName = "Navigator";
