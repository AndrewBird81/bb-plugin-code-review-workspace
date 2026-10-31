import { useEffect, useId, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { useFullscreenPortalContainer } from "../../lib/portal-scope";
import { reviewIdentity, type ReviewIdentity } from "../../lib/review-identity";
import { keyHint } from "../../lib/review-shortcuts";
import { TITLE_BAR_WAIT_MS } from "../../lib/title-bar";
import { cn } from "../../lib/utils";
import { NOT_PUSHED_PAGE, OVERVIEW, useWorkspace } from "../../lib/workspace-context";
import { phoneWindow } from "../../lib/workspace-layout";
import { usePageTitleShown, useTitleBarMounted } from "../../lib/workspace-store";
import { compareLabel, ComparePicker, sinceFrom } from "../ComparePicker";
import { hasNotPushed } from "../../lib/main-thread";
import { sendBaselineOf } from "../../lib/send-baseline";
import { ReviewIdChip } from "../ReviewIdChip";
import { ChapterStep } from "../shell/ChapterStep";
import { TopBand } from "../shell/TopBand";
import { TitleBarControls } from "../TitleBarControls";
import { TOUCH_COMPACT, TOUCH_CONTROL } from "../touch";
import { Button } from "../ui/button";
import { Hint } from "../ui/hint";
import { useMediaQuery } from "../ui/hooks/use-media-query";
import { Icon } from "../ui/icon";
import { InlineCode } from "../ui/inline-code";
import { DiffOptions } from "./DiffOptions";


/**
 * What the band shows beside its buttons and the review's id, which always shows: "All reviews" beside ‹, the review's
 * title, the compare select, and Fold.
 */
export interface BandFit {
  back: boolean;
  title: boolean;
  /** "brief": "Since review"; null: the comparison is in Diff options. */
  compare: "full" | "brief" | null;
  /** Fold comments; Diff options has it where the band doesn't. */
  fold: boolean;
}

// The widths, in px, that the band's parts need beside its buttons: the chapter's ring and the start of its title, which
// always show, at the least beside the compare select and as usual beside the rest; "All reviews" beside ‹; and the
// review's title with its slashes.
const CHAPTER = { least: 120, usual: 180 };
const BACK = 82;
const TITLE = 160;
/**
 * Under this much room on a phone's touch screen, the band ends with Diff options alone: on an unfolded iPhone Duo held
 * sideways, the fold (x 455–496) runs where the compare select and Fold comments would be, beside docked Comments (the
 * band's 0–560) or before the review's commands in full screen (lanes/00-devices.md, requirement 6). An iPad has no
 * fold: its band fits as a mouse's does.
 */
const OPTIONS_ALONE_BELOW = 600;

/** The compare select's width with `label`: about 6.5px a character, its chevron, and its padding. */
export const selectWidth = (label: string) => Math.ceil(label.length * 6.5) + 34;

/** The id chip's width: 11px monospace, its repository's name up to 160px, its padding, and the gap after it. */
export const chipWidth = ({ idRepo, idTail }: Pick<ReviewIdentity, "idRepo" | "idTail">) => Math.min(160, Math.ceil(idRepo.length * 6.6)) + Math.ceil(idTail.length * 6.6) + 18;

/**
 * What fits in `room` px of band beside its `buttons` square buttons of `size` px and the review's id, `chip` px wide,
 * which always shows: the chapter's title first, then the compare select, `compare` px wide with its full or brief
 * label (null: the review has none), then "All reviews" from a reader of 720px, then the review's title, which goes
 * first. Where BB's title bar doesn't name the review (`named`), as in full screen, its title comes before "All
 * reviews". Fold comments, one of the buttons, is a setting Diff options has too: it gives way to the chapter's title
 * and to the compare select, a state you must see. On a phone's touch screen (`touch`), under 600px of room, both are
 * in Diff options.
 */
export function bandFit(room: number, buttons: number, size: number, compare: { full: number; brief: number } | null, { touch = false, chip = 0, named = false }: { touch?: boolean; chip?: number; named?: boolean } = {}): BandFit {
  if (touch && room < OPTIONS_ALONE_BELOW) return { back: false, title: false, compare: null, fold: false };
  const button = size + 4;
  let left = room - buttons * button - chip;
  // The full label only with room to spare, so the chapter's title doesn't lose what the label gains.
  const fits = (space: number): BandFit["compare"] => !compare ? null : space - CHAPTER.least >= compare.full + 60 ? "full" : space - CHAPTER.least >= compare.brief ? "brief" : null;
  let select = fits(left);
  const fold = left >= CHAPTER.least && (!compare || !!select || !fits(left + button));
  if (!fold) select = fits(left += button);
  left -= (select ? compare![select] : 0) + CHAPTER.usual;
  if (named) {
    const title = left >= TITLE;
    return { back: room >= 720 && left - (title ? TITLE : 0) >= BACK, title, compare: select, fold };
  }
  const back = room >= 720 && left >= BACK;
  left -= back ? BACK : 0;
  // The review's title only in the whole breadcrumb: after ‹ alone, it would read as where ‹ goes.
  return { back, title: back && left >= TITLE + 120, compare: select, fold };
}

const sameFit = (a: BandFit, b: BandFit) => a.back === b.back && a.title === b.title && a.compare === b.compare && a.fold === b.fold;

/**
 * The band's fit for the room its `el` has, measured as it resizes. It re-renders only when the fit changes, not on
 * every frame of a pane drag. Without ResizeObserver (jsdom), everything fits.
 */
function useBandFit(el: HTMLElement | null, fitIn: (room: number) => BandFit): BandFit {
  const room = useRef(Number.POSITIVE_INFINITY);
  const latest = useRef(fitIn);
  latest.current = fitIn;
  const [, refit] = useReducer((count: number) => count + 1, 0);
  const fit = fitIn(room.current);
  const shown = useRef(fit);
  shown.current = fit;
  useLayoutEffect(() => {
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = (width: number) => {
      room.current = width;
      if (!sameFit(latest.current(width), shown.current)) refit();
    };
    // Before the first paint, rather than when the observer first reports.
    const { width } = el.getBoundingClientRect();
    if (width > 0) measure(width);
    const observer = new ResizeObserver(([entry]) => measure(entry.contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);
  return fit;
}

/**
 * The band over the code: the chapters toggle and Find where the navigator isn't docked, where you are (All reviews,
 * the review, its chapter), and how the diff draws: the compare select on a re-review, Fold comments, and Diff options.
 * What shows depends on the band's room. The review's commands end it in full screen, which hides BB's title bar, and
 * where the title bar didn't take them. A phone has no band: its dock and sheet hold all this. `threads`: the PR has
 * GitHub threads to show. `onCompareShown` is told whether the band shows the compare select.
 */
export function ReaderBar({ threads, onCompareShown }: { threads: boolean; onCompareShown?: (shown: boolean) => void }) {
  const { targetKey, review, guide, sections, activeId, go, layout, compare, display, files, fullscreen, leave, shortcuts } = useWorkspace();
  const container = useFullscreenPortalContainer();
  const titleBar = useTitleBarMounted(targetKey);
  const coarse = useMediaQuery("(pointer: coarse)");
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setWaited(true), TITLE_BAR_WAIT_MS);
    return () => clearTimeout(timer);
  }, []);
  const [reading, setReading] = useState<HTMLDivElement | null>(null);
  const short = layout.mode === "short";
  const index = activeId === OVERVIEW ? -1 : sections.findIndex((section) => section.id === activeId);
  const chapter = sections[index];
  const notPushed = activeId === NOT_PUSHED_PAGE;
  // A re-review compares with your last review, a review with a Send with your last Send, and a first review shows its
  // comparison once you pick a commit. The select is sized for its longest label, so what it says doesn't move it out
  // of the band. A PR with a thread working on it in a folder has Not pushed yet there too.
  const comparable = !!chapter && (sinceFrom(compare, review) !== undefined || hasNotPushed(review));
  const lastSend = sendBaselineOf(review)?.key;
  const longer = (brief: boolean) => [compareLabel(false, null), compareLabel(true, compare.from, brief), ...(lastSend ? [compareLabel(true, lastSend, brief)] : [])]
    .reduce((a, b) => b.length > a.length ? b : a);
  const sized = (brief: boolean) => selectWidth(longer(brief)) + (compare.error ? 18 : 0);
  const buttons = (layout.nav === "docked" ? 0 : 2) + 1 + (chapter ? 2 : 0);
  // The review's commands end the band where BB's title bar doesn't show them, nor the review's name.
  const commands = fullscreen.on || (waited && !titleBar);
  // The review's name has one home: BB's title bar, where it shows this pane's review, else the band.
  const titled = usePageTitleShown(targetKey) && !commands;
  // A local review with no name of its own goes by its guide's title, as its page title does.
  const identity = useMemo(() => reviewIdentity(review, guide.title), [review, guide.title]);
  const described = useId();
  const fit = useBandFit(reading, (room) => bandFit(room, buttons, short ? 36 : coarse ? 44 : 32, comparable ? { full: sized(false), brief: sized(true) } : null, { touch: coarse && phoneWindow(), chip: chipWidth(identity), named: commands }));
  // Before the paint, so a narrowed diff's own note doesn't flash as the select comes and goes.
  useLayoutEffect(() => onCompareShown?.(!!fit.compare), [fit.compare, onCompareShown]);
  if (layout.mode === "phone") return null;
  const chapterFiles = chapter?.diffs.map((diff) => diff.file) ?? [];
  const viewed = chapterFiles.filter((file) => files.views.get(file)?.viewed).length;
  // A phone held sideways keeps its band to 40px, its buttons inside 44px targets.
  const touch = short ? TOUCH_COMPACT : TOUCH_CONTROL;
  const icon = cn("size-8 shrink-0 px-0 text-muted-foreground", touch);
  return (
    <div className={cn("@container/band flex shrink-0 items-center gap-x-1 border-b border-border px-1.5", short ? "h-10" : "h-11")}>
      <div ref={setReading} className="flex min-w-0 flex-1 items-center gap-1">
        {layout.nav !== "docked" && <TopBand find hidden={layout.nav === "overlay"} />}
        <nav aria-label="Breadcrumb" className="flex min-w-0 flex-1 items-center gap-1 text-sm">
          <Button variant="ghost" size="sm" aria-label="All reviews" className={cn("h-8 shrink-0 gap-1 px-1.5 text-muted-foreground", touch)} onClick={() => void leave()}>
            <Icon name="ChevronLeft" aria-hidden />{fit.back && "All reviews"}
          </Button>
          {fit.back && <span aria-hidden className="text-subtle-foreground">/</span>}
          {/* Which review: its id always, and in a chapter its title where the band has room, which goes to its Overview. */}
          <span className="flex min-w-0 shrink-[3] items-center gap-1">
            {chapter || notPushed
              // Its words truncate inside it, so a 44px target around it (short's ::after) isn't clipped.
              ? <button type="button" title="Overview" aria-label={fit.title && !titled ? `${identity.id} ${identity.name}` : identity.id} aria-describedby={described} className={cn("flex min-w-0 items-center gap-1.5 rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring", touch)} onClick={() => go(OVERVIEW)}>
                <ReviewIdChip identity={identity} />{fit.title && !titled && <span className="max-w-56 truncate">{identity.name}</span>}
                <span id={described} className="sr-only">{identity.label}</span>
              </button>
              // The Overview's own title names it, under the band.
              : <span className="flex min-w-0 items-center"><ReviewIdChip identity={identity} /></span>}
            <span aria-hidden className="text-subtle-foreground">/</span>
          </span>
          {!chapter ? <span className="flex min-w-0 items-center gap-1.5 font-medium">
            <Icon name={notPushed ? "FileDiff" : "AlignLeft"} className="size-4 shrink-0 text-primary" aria-hidden />
            <span className="truncate">{notPushed ? "Not pushed yet" : "Overview"}</span>
          </span> : <>
            {/* Where you are, not a button: the chapters toggle shows the chapters, here or at the navigator's top. */}
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="sr-only">{`Chapter ${index + 1} of ${sections.length}: ${chapter.title}, ${viewed} of ${chapterFiles.length} files viewed`}</span>
              <ChapterStep index={index} viewed={viewed} total={chapterFiles.length} />
              <span aria-hidden className="min-w-0 truncate font-medium text-foreground"><InlineCode text={chapter.title} /></span>
            </span>
          </>}
        </nav>
        {chapter && <div className="flex shrink-0 items-center gap-1">
          {fit.compare && <ComparePicker brief={fit.compare === "brief"} />}
          {fit.fold && <Hint label={keyHint("Fold comments", "i", shortcuts)} container={container}>
            <Button variant="ghost" size="sm" aria-label={display.commentsFolded ? "Unfold comments in code" : "Fold comments in code"} className={cn(icon, display.commentsFolded && "text-primary hover:text-primary")} onClick={() => display.setCommentsFolded(!display.commentsFolded)}>
              <Icon name={display.commentsFolded ? "ChevronsDown" : "ChevronsUp"} aria-hidden />
            </Button>
          </Hint>}
          <DiffOptions threads={threads} compareInBand={!!fit.compare} foldInBand={fit.fold} className={touch} />
        </div>}
      </div>
      {commands && <div className="flex shrink-0 items-center">
        {chapter && <span aria-hidden className="mx-1 h-4 w-px bg-border" />}
        <TitleBarControls subPath={targetKey} placement="band" />
      </div>}
    </div>
  );
}
