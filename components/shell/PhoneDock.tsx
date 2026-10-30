import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { useAppPanel } from "../../lib/app-panel";
import { useDraftStatus } from "../../lib/draft-status";
import { reviewIdentity, type ReviewIdentity } from "../../lib/review-identity";
import { TEXT_FIELD } from "../../lib/review-shortcuts";
import { cn } from "../../lib/utils";
import { useWorkspace } from "../../lib/workspace-context";
import { useNeedsYou, useTabShown } from "../../lib/workspace-store";
import { useFullscreenPortalContainer } from "../../lib/portal-scope";
import { Button } from "../ui/button";
import { Hint } from "../ui/hint";
import { Icon } from "../ui/icon";
import { InlineCode } from "../ui/inline-code";
import { ReviewIdChip } from "../ReviewIdChip";
import { ChapterStep } from "./ChapterStep";
import { sidePanelId } from "./SidePanel";
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

/** `id` in at most `chars` characters, cut in the middle so both its ends show: web:feat…on-retries. */
export function middleCut(id: string, chars: number): string {
  if (id.length <= chars) return id;
  const tail = Math.ceil((chars - 1) * 0.55);
  return `${id.slice(0, Math.max(0, chars - 1 - tail))}…${id.slice(id.length - tail)}`;
}

/**
 * The review's id over the chapter. A local review's, often longer than the tab, is cut in the middle to the tab's
 * room, at 11px monospace's 6.6px a character (as the band's chip is sized), so its repository and its branch's end both
 * show; whole on hover and to a screen reader. A PR's is the chip, which never cuts its number.
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
      <span aria-hidden>{middleCut(identity.id, Math.max(1, Math.floor(room / 6.6)))}</span>
    </span>
  );
}

/**
 * A phone's controls, at the bottom: All reviews, the chapter you're on, Comments, Ask agent, Main thread (with one),
 * and Full screen. The chapter and Comments are the tabs of the one sheet above it: the open one is pressed, and pressing
 * it again closes the sheet. Ask agent opens BB's side panel over the page; Main thread goes to the main thread. It
 * makes way while you type in the review, for the keyboard, and for the lines you select (`hidden`).
 */
export function PhoneDock({ hidden }: { hidden: boolean }) {
  const { targetKey, review, guide, sections, activeId, files, nav, panel, askAgent, fullscreen, leave, mainThread } = useWorkspace();
  const navigate = useBbNavigate();
  const appPanel = useAppPanel();
  const agentShown = useTabShown(targetKey, "agent") && !fullscreen.on;
  // A phone has no band, and in full screen no title bar of BB's: the chapter's tab says which review this is.
  const identity = useMemo(() => reviewIdentity(review, guide.title), [review, guide.title]);
  const status = useDraftStatus(targetKey);
  const needsYou = useNeedsYou(targetKey);
  const container = useFullscreenPortalContainer();
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
  const chapterFiles = chapter?.diffs.map((diff) => diff.file) ?? [];
  const viewed = chapterFiles.filter((file) => files.views.get(file)?.viewed).length;
  // Finish review is part of Comments.
  const comments = panel.view === "comments" || panel.view === "finish";
  const unsent = status?.comments ?? 0;
  const away = hidden || typing;
  useToastsAbove(away ? null : dock);
  const tab = "h-11 min-w-11 shrink-0 px-0 text-muted-foreground";
  return (
    <div
      ref={setDock}
      role="group"
      aria-label="Review commands"
      hidden={away}
      className={cn("flex shrink-0 items-center gap-1 border-t border-border px-1.5 pt-[3px] pb-[calc(4px+var(--gr-safe-bottom,0px))]", away && "hidden")}
      style={OPAQUE}
    >
      <Button variant="ghost" aria-label="All reviews" className={tab} onClick={() => void leave()}>
        <Icon name="ChevronLeft" aria-hidden />
      </Button>
      <Button
        variant="ghost"
        aria-label={`${identity.id}, ${chapter ? `Chapters: Chapter ${index + 1} of ${sections.length}, ${chapter.title}, ${viewed} of ${chapterFiles.length} files viewed` : "Chapters: Overview"}`}
        aria-pressed={nav.open}
        aria-controls={navigatorId(targetKey)}
        className="h-11 min-w-0 flex-1 justify-start gap-2 bg-muted/40 px-2.5 text-foreground ring-1 ring-inset ring-border"
        onClick={nav.toggle}
      >
        {chapter ? <ChapterStep index={index} viewed={viewed} total={chapterFiles.length} /> : <Icon name="AlignLeft" className="text-primary" aria-hidden />}
        {/* The id over the chapter, in 44px, so the review stays named whatever the chapter's title takes. */}
        <span className="flex min-w-0 flex-1 flex-col items-start text-left">
          <DockId identity={identity} />
          <span className="w-full truncate leading-5">{chapter ? <InlineCode text={chapter.title} /> : "Overview"}</span>
        </span>
        <Icon name={nav.open ? "ChevronDown" : "ChevronUp"} className="text-subtle-foreground" aria-hidden />
      </Button>
      <Button
        variant="ghost"
        aria-label={`Comments${unsent ? `, ${unsent} to send` : ""}${needsYou ? `, ${needsYou} need you` : ""}`}
        aria-pressed={comments}
        aria-controls={sidePanelId(targetKey)}
        className={cn(tab, "relative gap-1", unsent > 0 && "px-2.5")}
        onClick={() => comments ? panel.close() : panel.open("comments")}
      >
        <Icon name="MessageSquare" aria-hidden />
        {/* What will be sent, the count alone in a narrow pane, so the chapter keeps its title; the dot is what needs
            you, as the title bar's count is. */}
        {unsent > 0 && <span aria-hidden className="text-xs font-medium tabular-nums">{unsent}<span className="@max-[400px]/review:hidden"> to send</span></span>}
        {needsYou > 0 && <span aria-hidden className="absolute right-1.5 top-2 size-2 rounded-full bg-primary ring-2 ring-background" />}
      </Button>
      {/* The agent opens in BB's side panel, over the page on a phone, whose tabs include the main thread's. */}
      <Button variant="ghost" aria-label="Ask agent" aria-pressed={agentShown} className={tab} onClick={() => agentShown ? appPanel?.close() : askAgent()}>
        <Icon name="Sparkles" className="text-(--ansi-13)" aria-hidden />
      </Button>
      {mainThread && <Hint label={`Go to the main thread${mainThread.title ? `, ${mainThread.title}` : ""}`} container={container}>
        <Button variant="ghost" aria-label="Go to main thread" className={cn(tab, "relative")} onClick={() => navigate.toThread(mainThread.threadId)}>
          <Icon name="Code" aria-hidden />
          {/* It leaves the review for the thread's page. */}
          <Icon name="ArrowUpRight" className="absolute right-0.5 top-1.5 size-3" aria-hidden />
        </Button>
      </Hint>}
      {fullscreen.available && (
        <Button variant="ghost" aria-label={fullscreen.on ? "Exit full screen" : "Full screen"} className={tab} onClick={fullscreen.toggle}>
          <Icon name={fullscreen.on ? "Minimize2" : "Maximize2"} aria-hidden />
        </Button>
      )}
    </div>
  );
}
