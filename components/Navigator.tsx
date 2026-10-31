import { memo, type ReactNode } from "react";
import type { FileOwners } from "../src/codeowners";
import type { ReviewThread } from "../src/threads";
import { reviewState } from "../lib/review-state";
import { statusWhy } from "../lib/status-line";
import { useKnob } from "../lib/settings";
import { cn } from "../lib/utils";
import { hasNotPushed } from "../lib/main-thread";
import { NOT_PUSHED_PAGE, OVERVIEW, useWorkspace } from "../lib/workspace-context";
import { useNotPushedFiles } from "../lib/workspace-store";
import { ChapterNav } from "./ChapterNav";
import { FindInReview } from "./FindInReview";
import { Icon } from "./ui/icon";

/**
 * Where you are in the review: Find in review's box after `leading`, then the Overview, the chapters and, on a PR whose
 * main thread works in a folder, Not pushed yet; or every file.
 * The workspace hosts it beside the code, over it, or in a phone's sheet.
 */
export const Navigator = memo(function Navigator({ leading, patch, currentFile, changedSince, lines, generated, chosen, threads, owners, onSelect, onSelectFile, onOpenLine, onOpenFile, initialFind, onFind }: {
  leading: ReactNode;
  /** Find in review's query as a remounted workspace had it, and where its changes go to be kept for the next. */
  initialFind?: string;
  onFind?: (query: string) => void;
  patch: string;
  /** The file you're on, marked in the open chapter's list. */
  currentFile?: string;
  /** Per chapter id, how many of its files changed since your review. */
  changedSince?: Record<string, number>;
  lines?: ReadonlyMap<string, number>;
  generated?: ReadonlySet<string>;
  /** Files the change put at their paths (src/classify.ts isChosenPath), which their paths don't make generated. */
  chosen?: ReadonlySet<string>;
  threads?: readonly ReviewThread[];
  owners?: ReadonlyMap<string, FileOwners>;
  /** Show a chapter, or the Overview. */
  onSelect: (id: string) => void;
  onSelectFile: (chapterId: string, file: string) => void;
  onOpenLine: (file: string, line: number, side: "LEFT" | "RIGHT") => void;
  onOpenFile: (chapterId: string, file: string) => void;
}) {
  const { targetKey, review, sections, activeId, files, nav, compare, layout } = useWorkspace();
  const current = activeId === OVERVIEW;
  const onNotPushed = activeId === NOT_PUSHED_PAGE;
  // As its page, or the folder's check, last counted them.
  const notPushedFiles = useNotPushedFiles(targetKey);
  const row = (on: boolean) => cn("flex w-full items-center gap-2.5 rounded-lg py-2 pl-[10px] pr-2 text-left text-sm transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11", on ? "bg-state-active/50 ring-1 ring-inset ring-primary/20" : "hover:bg-state-hover");
  // Where the review stands, in All reviews' words; a ready guide that's nobody's news says nothing.
  const localDiffChanges = useKnob("localDiffChanges");
  const status = reviewState(review).label === "Ready" ? null : statusWhy(review, { localDiffChanges })?.text;
  return (
    <FindInReview leading={leading} patch={patch} sections={sections} onOpenLine={onOpenLine} onOpenChapter={onSelect} onOpenFile={onOpenFile} initialQuery={initialFind} onQuery={onFind}>
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
        chosen={chosen}
        view={nav.view}
        onViewChange={nav.setView}
        since={compare.since}
        threads={threads}
        owners={owners}
        sinceWhat={compare.what}
        onMarkViewed={files.markChapterViewed}
        onNextUnviewed={files.nextUnviewed}
        sheet={layout.mode === "phone"}
        overview={
          <button
            type="button"
            aria-current={current ? "page" : undefined}
            onClick={() => onSelect(OVERVIEW)}
            className={row(current)}
          >
            <Icon name="AlignLeft" className={cn("size-4 shrink-0", current ? "text-primary" : "text-subtle-foreground")} aria-hidden />
            <span className="min-w-0 flex-1 truncate">
              <span className="font-medium text-foreground">Overview</span>
              {status && <span className="text-muted-foreground"> · {status}</span>}
            </span>
          </button>
        }
        after={hasNotPushed(review) && (
          <button type="button" aria-current={onNotPushed ? "page" : undefined} onClick={() => onSelect(NOT_PUSHED_PAGE)} className={row(onNotPushed)}>
            <Icon name="FileDiff" className={cn("size-4 shrink-0", onNotPushed ? "text-primary" : "text-subtle-foreground")} aria-hidden />
            <span className="min-w-0 flex-1 truncate">
              <span className="font-medium text-foreground">Not pushed yet</span>
              {notPushedFiles !== null && <span className="text-muted-foreground"> · {notPushedFiles} file{notPushedFiles === 1 ? "" : "s"}</span>}
            </span>
          </button>
        )}
      />
    </FindInReview>
  );
});
Navigator.displayName = "Navigator";
