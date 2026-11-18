import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { reviewIdentity, type ReviewIdentity } from "../../lib/review-identity";
import { TEXT_FIELD } from "../../lib/review-shortcuts";
import { cn } from "../../lib/utils";
import { NOT_PUSHED_PAGE, useWorkspace } from "../../lib/workspace-context";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { InlineCode } from "../ui/inline-code";
import { ReviewIdChip } from "../ReviewIdChip";
import { ChapterStep } from "./ChapterStep";
import { ReviewControls } from "../TitleBarControls";
import { OPAQUE } from "./side-parts";
import { navigatorId } from "./TopBand";

/**
 * Whether the focus is in a box you type in, in the review (`root`), which brings up a phone's keyboard; not one in BB's
 * side panel, as the review agent's, which covers the page anyway.
 */
function typingIn(el: Element | null, root: Element | null): boolean {
  return el instanceof HTMLElement && (el.isContentEditable || !!el.closest(TEXT_FIELD)) && !!root?.contains(el);
}

/**
 * While the dock shows, toasts at the page's bottom sit above it rather than over it. BB shows them, with its own
 * toaster (sonner), outside the plugin: a style in the page's head lifts that toaster by what the dock covers.
 */
function useToastsAbove(dock: HTMLElement | null) {
  useLayoutEffect(() => {
    if (!dock) return;
    const style = document.createElement("style");
    style.setAttribute("data-gr-toasts-above-dock", "");
    const update = () => {
      const lift = Math.max(0, Math.round(document.documentElement.clientHeight - dock.getBoundingClientRect().top));
      style.textContent = `[data-sonner-toaster][data-y-position="bottom"] { margin-bottom: ${lift}px !important; }`;
    };
    update();
    document.head.append(style);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(dock);
    window.addEventListener("resize", update);
    return () => {
      style.remove();
      observer?.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [dock]);
}

/** `id` in at most `chars` characters, cut from the end so it reads from its start: web:feat/snooz…. */
export function endCut(id: string, chars: number): string {
  return id.length <= chars ? id : `${id.slice(0, Math.max(0, chars - 1))}…`;
}

/**
 * The review's id over the chapter. A local review's, often longer than the tab, is cut from its end to the tab's room,
 * at 11px monospace's 6.6px a character (as the band's chip is sized), so its repository and its branch's start show;
 * whole on hover and to a screen reader. A PR's is the chip, which never cuts its number.
 */
function DockId({ identity }: { identity: ReviewIdentity }) {
  const [el, setEl] = useState<HTMLSpanElement | null>(null);
  const [room, setRoom] = useState(Number.POSITIVE_INFINITY);
  useLayoutEffect(() => {
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = (width: number) => { if (width > 0) setRoom(width); };
    measure(el.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) => measure(entry.contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);
  if (identity.idTail.startsWith("#")) return <ReviewIdChip identity={identity} className="bg-transparent px-0 leading-3.5" />;
  return (
    <span ref={setEl} data-dock-id title={identity.id} className="block w-full overflow-hidden whitespace-nowrap font-mono text-[11px] leading-3.5 text-muted-foreground">
      <span className="sr-only">{identity.id}</span>
      <span aria-hidden>{endCut(identity.id, Math.max(1, Math.floor(room / 6.6)))}</span>
    </span>
  );
}

/**
 * The chapter, Comments, Agent, Finish and ⋯ at the thumb. Sheets, typing, selection and toasts keep their behaviour.
 */
export function PhoneDock({ hidden, threads = false }: { hidden: boolean; threads?: boolean }) {
  const api = useWorkspace();
  const { targetKey, review, guide, sections, activeId, files, nav } = api;
  // A phone has no band, and in full screen no title bar of BB's: the chapter's tab says which review this is.
  const identity = useMemo(() => reviewIdentity(review, guide.title), [review, guide.title]);
  const [dock, setDock] = useState<HTMLDivElement | null>(null);
  const [typing, setTyping] = useState(false);
  useEffect(() => {
    const update = () => setTyping(typingIn(document.activeElement, dock?.closest("[data-review-root]") ?? null));
    update();
    document.addEventListener("focusin", update);
    document.addEventListener("focusout", update);
    return () => {
      document.removeEventListener("focusin", update);
      document.removeEventListener("focusout", update);
    };
  }, [dock]);
  const index = sections.findIndex((section) => section.id === activeId);
  const chapter = sections[index];
  const notPushed = activeId === NOT_PUSHED_PAGE;
  const page = notPushed ? "Not pushed yet" : "Overview";
  const chapterFiles = chapter?.diffs.map((diff) => diff.file) ?? [];
  const viewed = chapterFiles.filter((file) => files.views.get(file)?.viewed).length;
  const away = hidden || typing;
  useToastsAbove(away ? null : dock);
  return (
    <div
      ref={setDock}
      role="group"
      aria-label="Review commands"
      hidden={away}
      className={cn("flex shrink-0 items-center gap-1 border-t border-border px-1.5 pt-[3px] pb-[calc(4px+var(--gr-safe-bottom,0px))]", away && "hidden")}
      style={OPAQUE}
    >
      <Button
        variant="ghost"
        aria-label={`${identity.id}, ${chapter ? `Chapters: Chapter ${index + 1} of ${sections.length}, ${chapter.title}, ${viewed} of ${chapterFiles.length} files viewed` : `Chapters: ${page}`}`}
        aria-pressed={nav.open}
        aria-controls={navigatorId(targetKey)}
        className="h-11 min-w-0 flex-1 justify-start gap-2 bg-muted/40 px-2.5 text-foreground ring-1 ring-inset ring-border"
        onClick={nav.toggle}
      >
        {chapter ? <ChapterStep index={index} viewed={viewed} total={chapterFiles.length} /> : <Icon name={notPushed ? "FileDiff" : "AlignLeft"} className="text-primary" aria-hidden />}
        {/* The id over the chapter, in 44px, so the review stays named whatever the chapter's title takes. */}
        <span className="flex min-w-0 flex-1 flex-col items-start text-left">
          <DockId identity={identity} />
          <span className="w-full truncate leading-5">{chapter ? <InlineCode text={chapter.title} /> : page}</span>
        </span>
        <Icon name={nav.open ? "ChevronDown" : "ChevronUp"} className="text-subtle-foreground" aria-hidden />
      </Button>
      <ReviewControls api={api} threads={threads} phone />
    </div>
  );
}
