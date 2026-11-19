import { useId, useMemo, useState } from "react";
import { reviewIdentity } from "../../lib/review-identity";
import { useFold } from "../../lib/use-fold";
import { cn } from "../../lib/utils";
import { NOT_PUSHED_PAGE, OVERVIEW, useWorkspace } from "../../lib/workspace-context";
import { ReviewIdChip } from "../ReviewIdChip";
import { ChapterStep } from "../shell/ChapterStep";
import { TopBand } from "../shell/TopBand";
import { ReviewControls } from "../TitleBarControls";
import { TOUCH_COMPACT, TOUCH_CONTROL } from "../touch";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { InlineCode } from "../ui/inline-code";

/** One review bar: where you are, then Comments, Agent, Main thread, Finish and everything else in ⋯. */
export function ReaderBar({ threads }: { threads: boolean }) {
  const api = useWorkspace();
  const { review, guide, sections, activeId, layout, files, go } = api;
  const described = useId();
  const [bar, setBar] = useState<HTMLDivElement | null>(null);
  useFold(bar, layout.mode === "tablet");
  const identity = useMemo(() => reviewIdentity(review, guide.title), [review, guide.title]);
  if (layout.mode === "phone") return null;
  const short = layout.mode === "short";
  const touch = short ? TOUCH_COMPACT : TOUCH_CONTROL;
  const index = sections.findIndex((section) => section.id === activeId);
  const chapter = sections[index];
  const notPushed = activeId === NOT_PUSHED_PAGE;
  const chapterFiles = chapter?.diffs.map((diff) => diff.file) ?? [];
  const viewed = chapterFiles.filter((file) => files.views.get(file)?.viewed).length;
  return (
    <div ref={setBar} className={cn("@container/band flex shrink-0 items-center gap-x-1 border-b border-border px-1.5", short ? "h-10" : "h-11")}>
      {/* The fold's width is at most 48px; the left group ends before its near edge. Labels never measure the bar. */}
      <div className="flex min-w-0 flex-1 items-center gap-1" style={{ maxWidth: "calc(var(--gr-fold-end, 100000px) - 48px)" }}>
        {layout.nav !== "docked" && <TopBand hidden={layout.nav === "overlay"} />}
        <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-sm">
          <Button variant="ghost" size="sm" aria-label="All reviews" className={cn("h-8 shrink-0 gap-1 px-1.5 text-muted-foreground", touch)} onClick={() => void api.leave()}>
            <Icon name="ChevronLeft" aria-hidden /><span className="hidden min-w-0 truncate @min-[880px]/band:inline">All reviews</span>
          </Button>
          <span aria-hidden className="shrink-0 text-subtle-foreground">/</span>
          {chapter || notPushed
            ? <button type="button" title="Overview" aria-label={identity.id} aria-describedby={described} className={cn("flex min-w-0 shrink-[3] items-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring", touch)} onClick={() => go(OVERVIEW)}>
              <ReviewIdChip identity={identity} />
              <span id={described} className="sr-only">{identity.label}</span>
            </button>
            : <span className="flex min-w-0 shrink-[3] items-center"><ReviewIdChip identity={identity} /></span>}
          <span aria-hidden className="shrink-0 text-subtle-foreground">/</span>
          {!chapter ? <span className="flex min-w-0 items-center gap-1.5 font-medium">
            <Icon name={notPushed ? "FileDiff" : "AlignLeft"} className="size-4 shrink-0 text-primary" aria-hidden />
            <span className="truncate">{notPushed ? "Not pushed yet" : "Overview"}</span>
          </span> : <span className="flex min-w-0 items-center gap-1.5">
            <span className="sr-only">{`Chapter ${index + 1} of ${sections.length}: ${chapter.title}, ${viewed} of ${chapterFiles.length} files viewed`}</span>
            <ChapterStep index={index} viewed={viewed} total={chapterFiles.length} />
            <span aria-hidden className="min-w-0 truncate font-medium text-foreground"><InlineCode text={chapter.title} /></span>
          </span>}
        </nav>
      </div>
      <div className="ml-auto shrink-0" style={{ maxWidth: "calc(100% - var(--gr-fold-end, 0px))" }}><ReviewControls api={api} threads={threads} /></div>
    </div>
  );
}
