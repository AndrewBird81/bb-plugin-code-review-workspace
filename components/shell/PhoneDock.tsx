import { useEffect, useLayoutEffect, useState } from "react";
import { useDraftStatus } from "../../lib/draft-status";
import { TEXT_FIELD } from "../../lib/review-shortcuts";
import { cn } from "../../lib/utils";
import { useWorkspace } from "../../lib/workspace-context";
import { useNeedsYou } from "../../lib/workspace-store";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { InlineCode } from "../ui/inline-code";
import { ChapterStep } from "./ChapterStep";
import { sidePanelId } from "./SidePanel";
import { OPAQUE } from "./side-parts";
import { navigatorId } from "./TopBand";

/** Whether the focus is in a box you type in, which brings up a phone's keyboard. */
function typingIn(el: Element | null): boolean {
  return el instanceof HTMLElement && (el.isContentEditable || !!el.closest(TEXT_FIELD));
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

/**
 * A phone's controls, at the bottom: All reviews, the chapter you're on, Comments, the agent, and Full screen. The
 * chapter, Comments and the agent are the tabs of the one sheet above it: the open one is pressed, and pressing it
 * again closes the sheet. It makes way while you type, for the keyboard, and for the lines you select (`hidden`).
 */
export function PhoneDock({ hidden }: { hidden: boolean }) {
  const { targetKey, sections, activeId, files, nav, panel, askAgent, fullscreen, leave } = useWorkspace();
  const status = useDraftStatus(targetKey);
  const needsYou = useNeedsYou(targetKey);
  const [typing, setTyping] = useState(() => typingIn(document.activeElement));
  useEffect(() => {
    const update = () => setTyping(typingIn(document.activeElement));
    document.addEventListener("focusin", update);
    document.addEventListener("focusout", update);
    return () => {
      document.removeEventListener("focusin", update);
      document.removeEventListener("focusout", update);
    };
  }, []);
  const index = sections.findIndex((section) => section.id === activeId);
  const chapter = sections[index];
  const chapterFiles = chapter?.diffs.map((diff) => diff.file) ?? [];
  const viewed = chapterFiles.filter((file) => files.views.get(file)?.viewed).length;
  // Finish review is part of Comments.
  const comments = panel.view === "comments" || panel.view === "finish";
  const unsent = status?.comments ?? 0;
  const away = hidden || typing;
  const [dock, setDock] = useState<HTMLDivElement | null>(null);
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
        aria-label={chapter ? `Chapters: Chapter ${index + 1} of ${sections.length}, ${chapter.title}, ${viewed} of ${chapterFiles.length} files viewed` : "Chapters: Overview"}
        aria-pressed={nav.open}
        aria-controls={navigatorId(targetKey)}
        className="h-11 min-w-0 flex-1 justify-start gap-2 bg-muted/40 px-2.5 text-foreground ring-1 ring-inset ring-border"
        onClick={nav.toggle}
      >
        {chapter ? <ChapterStep index={index} viewed={viewed} total={chapterFiles.length} /> : <Icon name="AlignLeft" className="text-primary" aria-hidden />}
        <span className="min-w-0 flex-1 truncate text-left">{chapter ? <InlineCode text={chapter.title} /> : "Overview"}</span>
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
      <Button variant="ghost" aria-label="Ask agent" aria-pressed={panel.view === "agent"} aria-controls={sidePanelId(targetKey)} className={tab} onClick={() => panel.view === "agent" ? panel.close() : askAgent()}>
        <Icon name="Sparkles" className="text-(--ansi-13)" aria-hidden />
      </Button>
      {fullscreen.available && (
        <Button variant="ghost" aria-label={fullscreen.on ? "Exit full screen" : "Full screen"} className={tab} onClick={fullscreen.toggle}>
          <Icon name={fullscreen.on ? "Minimize2" : "Maximize2"} aria-hidden />
        </Button>
      )}
    </div>
  );
}
