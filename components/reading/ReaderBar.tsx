import { useEffect, useState } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { useFullscreenPortalContainer } from "../../lib/portal-scope";
import { cn } from "../../lib/utils";
import { OVERVIEW, useWorkspace } from "../../lib/workspace-context";
import { useTitleBarMounted } from "../../lib/workspace-store";
import { ComparePicker } from "../ComparePicker";
import { TopBand } from "../shell/TopBand";
import { TitleBarControls } from "../TitleBarControls";
import { TOUCH_COMPACT, TOUCH_CONTROL } from "../touch";
import { Button } from "../ui/button";
import { Hint } from "../ui/hint";
import { Icon } from "../ui/icon";
import { InlineCode } from "../ui/inline-code";

/** How long BB's title bar has to take the review's commands before the band shows them itself. */
const TITLE_BAR_WAIT_MS = 500;

/**
 * The band over the code: the chapters toggle and Find where the navigator isn't docked, where you are (All reviews,
 * the review, its chapter), and how the diff draws. The review's commands end it in full screen, which hides BB's
 * title bar, on a phone, and where the title bar didn't take them. `threads`: the PR has GitHub threads to show.
 */
export function ReaderBar({ threads }: { threads: boolean }) {
  const { targetKey, review, guide, sections, activeId, go, layout, compare, display, files, fullscreen } = useWorkspace();
  const navigate = useBbNavigate();
  const container = useFullscreenPortalContainer();
  const titleBar = useTitleBarMounted(targetKey);
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setWaited(true), TITLE_BAR_WAIT_MS);
    return () => clearTimeout(timer);
  }, []);
  const commands = fullscreen.on || layout.mode === "phone" || (waited && !titleBar);
  const isPr = review.kind === "pr";
  const index = activeId === OVERVIEW ? -1 : sections.findIndex((section) => section.id === activeId);
  const chapter = sections[index];
  const chapterFiles = chapter?.diffs.map((diff) => diff.file) ?? [];
  const viewed = chapterFiles.filter((file) => files.views.get(file)?.viewed).length;
  const phone = layout.mode === "phone";
  // A phone held sideways keeps its band to 40px, its buttons inside 44px targets.
  const touch = layout.mode === "short" ? TOUCH_COMPACT : TOUCH_CONTROL;
  const icon = cn("size-8 shrink-0 px-0 text-muted-foreground aria-pressed:text-primary", touch);
  return (
    <div className={cn("@container/band flex shrink-0 items-center gap-x-1 border-b border-border px-1.5", layout.mode === "short" ? "h-10" : "h-11", phone && "h-auto min-h-11 flex-wrap py-1")}>
      <div className={cn("flex min-w-0 flex-1 items-center gap-1", phone && "basis-full")}>
        {layout.nav !== "docked" && <TopBand find hidden={layout.nav === "overlay"} />}
        <nav aria-label="Breadcrumb" className="flex min-w-0 flex-1 items-center gap-1 text-sm">
          <Button variant="ghost" size="sm" aria-label="All reviews" className={cn("h-8 shrink-0 gap-1 px-1.5 text-muted-foreground", touch)} onClick={() => navigate.toPluginPanel("review")}>
            <Icon name="ChevronLeft" aria-hidden />{!layout.narrowReader && "All reviews"}
          </Button>
          {!layout.narrowReader && <span aria-hidden className="text-subtle-foreground">/</span>}
          {!chapter ? <span className="min-w-0 truncate font-medium">Overview</span> : <>
            {/* The review's title, where the band has room for it beside the chapter's. */}
            {!layout.narrowReader && <span className="hidden min-w-0 shrink-[3] items-center gap-1 @min-[900px]/band:flex">
              <button type="button" title="Overview" className="min-w-0 max-w-56 truncate rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" onClick={() => go(OVERVIEW)}>{review.title ?? guide.title ?? targetKey}</button>
              <span aria-hidden className="text-subtle-foreground">/</span>
            </span>}
            <span aria-label={`Chapter ${index + 1} of ${sections.length}: ${chapter.title}, ${viewed} of ${chapterFiles.length} files viewed`} className="flex min-w-0 items-center gap-1.5">
              {/* The chapter's step, as the chapters list marks the open one: its ring fills as its files are viewed. */}
              <span aria-hidden className="flex size-5 shrink-0 items-center justify-center rounded-full" style={{ background: `conic-gradient(var(--success) ${chapterFiles.length ? viewed / chapterFiles.length * 360 : 0}deg, var(--border) 0deg)` }}>
                <span className="flex size-4 items-center justify-center rounded-full bg-primary text-[10px] font-semibold tabular-nums text-primary-foreground">{index + 1}</span>
              </span>
              <span aria-hidden className="min-w-0 truncate font-medium text-foreground"><InlineCode text={chapter.title} /></span>
            </span>
          </>}
        </nav>
      </div>
      {/* On a phone, until its dock, the commands get a row of their own, and the diff's controls the next. */}
      {chapter && <div className={cn("flex shrink-0 items-center gap-0.5", phone && "order-3 basis-full justify-end")}>
        {(compare.since || isPr) && <ComparePicker targetKey={targetKey} baseline={compare.baseline} head={compare.head} from={compare.from} onFrom={compare.pick} available={!!compare.since} pickable={isPr} pressed={compare.narrowed} onToggle={() => compare.setNarrowed(!compare.narrowed)} />}
        {compare.error && (
          <span role="status" title={compare.error} className="flex items-center gap-1 px-1 text-xs text-destructive-text">
            <Icon name="AlertCircle" className="size-3.5 shrink-0" aria-hidden />
            <span title={compare.error} className={cn(layout.narrowReader && "sr-only")}>Couldn’t compare with {compare.from ? compare.from.slice(0, 7) : "your last review"}</span>
          </span>
        )}
        {/* Where the band is short of room, as on a phone, the chapter's end marks it viewed, and its ring counts. */}
        {!phone && <span className="hidden items-center gap-0.5 @min-[800px]/band:flex">
          <span className={cn("px-1 text-xs tabular-nums text-muted-foreground", viewed === chapterFiles.length && "text-diff-added")}><span aria-hidden>{viewed}/{chapterFiles.length}</span><span className="sr-only">{viewed} of {chapterFiles.length} files viewed in this chapter</span></span>
          <Hint label="Mark chapter viewed" container={container}>
            <Button variant="ghost" size="sm" aria-label="Mark chapter viewed" className={icon} disabled={viewed === chapterFiles.length} onClick={() => files.markChapterViewed(chapter.id)}>
              <Icon name="CircleCheck" aria-hidden />
            </Button>
          </Hint>
          <span aria-hidden className="mx-1 h-4 w-px bg-border" />
        </span>}
        {isPr && threads && <Hint label="GitHub threads" container={container}>
          <Button variant="ghost" size="sm" aria-label="GitHub threads" aria-pressed={display.githubThreads} className={icon} onClick={() => display.setGithubThreads(!display.githubThreads)}>
            <Icon name="Github" aria-hidden />
          </Button>
        </Hint>}
        {/* A phone always shows the diff unified. */}
        {!phone && <Hint label={display.unifiedOnly ? "Split view needs a wider pane" : "Split view"} container={container}>
          <Button variant="ghost" size="sm" aria-label="Split view" aria-pressed={display.layout === "split" && !display.unifiedOnly} aria-disabled={display.unifiedOnly} className={cn(icon, "aria-disabled:cursor-default aria-disabled:opacity-50")} onClick={display.toggleLayout}>
            <Icon name="Columns2" aria-hidden />
          </Button>
        </Hint>}
        <Hint label="Wrap lines" container={container}>
          <Button variant="ghost" size="sm" aria-label="Wrap lines" aria-pressed={display.wrap} className={icon} onClick={() => display.setWrap(!display.wrap)}>
            <Icon name="TextWrap" aria-hidden />
          </Button>
        </Hint>
        <Hint label="Hide whitespace" container={container}>
          <Button variant="ghost" size="sm" aria-label="Hide whitespace" aria-pressed={display.hideWhitespace} className={icon} onClick={() => display.setHideWhitespace(!display.hideWhitespace)}>
            <Icon name="Space" aria-hidden />
          </Button>
        </Hint>
      </div>}
      {commands && <div className={cn("flex shrink-0 items-center", phone && "order-2 basis-full justify-end")}>
        {chapter && !phone && <span aria-hidden className="mx-1 h-4 w-px bg-border" />}
        <TitleBarControls subPath={targetKey} placement="band" />
      </div>}
    </div>
  );
}
