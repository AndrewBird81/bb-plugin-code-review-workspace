import { useEffect, useState } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
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
 * A phone's controls, at the bottom: All reviews, the chapter you're on, Comments, the agent, and Full screen. The
 * chapter, Comments and the agent are the tabs of the one sheet above it: the open one is pressed, and pressing it
 * again closes the sheet. It makes way while you type, for the keyboard, and for the lines you select (`hidden`).
 */
export function PhoneDock({ hidden }: { hidden: boolean }) {
  const { targetKey, sections, activeId, files, nav, panel, askAgent, fullscreen } = useWorkspace();
  const navigate = useBbNavigate();
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
  const tab = "h-11 min-w-11 shrink-0 px-0 text-muted-foreground";
  return (
    <div
      role="group"
      aria-label="Review commands"
      hidden={away}
      className={cn("flex shrink-0 items-center gap-1 border-t border-border px-1.5 pt-1 pb-[calc(4px+env(safe-area-inset-bottom))]", away && "hidden")}
      style={OPAQUE}
    >
      <Button variant="ghost" aria-label="All reviews" className={tab} onClick={() => navigate.toPluginPanel("review")}>
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
        aria-label={`Comments${unsent ? `, ${unsent} not submitted` : ""}${needsYou ? `, ${needsYou} need you` : ""}`}
        aria-pressed={comments}
        aria-controls={sidePanelId(targetKey)}
        className={cn(tab, "relative gap-1", unsent > 0 && "px-2.5")}
        onClick={() => comments ? panel.close() : panel.open("comments")}
      >
        <Icon name="MessageSquare" aria-hidden />
        {unsent > 0 && <span aria-hidden className="text-xs font-medium tabular-nums">{unsent}</span>}
        {needsYou > 0 && <span aria-hidden className="absolute right-1.5 top-2 size-2 rounded-full bg-primary ring-2 ring-background" />}
      </Button>
      <Button variant="ghost" aria-label="Ask agent" aria-pressed={panel.view === "agent"} aria-controls={sidePanelId(targetKey)} className={tab} onClick={() => panel.view === "agent" ? panel.close() : askAgent()}>
        <Icon name="Sparkles" className="text-(--ansi-13)" aria-hidden />
      </Button>
      {fullscreen.available && (
        <Button variant="ghost" aria-label={fullscreen.on ? "Exit full screen" : "Full screen"} aria-pressed={fullscreen.on} className={tab} onClick={fullscreen.toggle}>
          <Icon name={fullscreen.on ? "Minimize2" : "Maximize2"} aria-hidden />
        </Button>
      )}
    </div>
  );
}
