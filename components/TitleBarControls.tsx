import { useCallback, useEffect } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { VERDICT_LABEL } from "../src/draft";
import { useDraftStatus } from "../lib/draft-status";
import { useFullscreenPortalContainer } from "../lib/portal-scope";
import { cn } from "../lib/utils";
import { mountTitleBar, panelPage, useNeedsYou, useWorkspaceFor } from "../lib/workspace-store";
import type { WorkspaceApi } from "../lib/workspace-context";
import { CompactViewportOverrideProvider } from "./ui/hooks/use-compact-viewport";
import { Button } from "./ui/button";
import { Hint } from "./ui/hint";
import { Icon, type IconName } from "./ui/icon";
import { ReviewActions } from "./ReviewActions";
import { sidePanelId } from "./shell/SidePanel";
import { TOUCH_COMPACT, TOUCH_CONTROL } from "./touch";

/** Where the controls are: BB's title bar, or the end of the workspace's band, which has them in full screen. */
export type TitleBarPlacement = "title" | "band";

// Full screen hides BB's bar and shows the band's controls, and leaving it does the opposite: the focus goes from
// the toggle clicked to the other one, when that shows within a moment.
let focusToggle: { to: TitleBarPlacement; until: number } | null = null;

/**
 * The review's commands: Comments, Ask agent, Submit review, Review actions (⋯) and Full screen. BB renders it in its
 * title bar (navPanel headerContent) with the page's subPath, apart from the page, so it reads the workspace from the
 * store. A plain function, not memo: the SDK takes only a function as a slot's component.
 */
export function TitleBarControls({ subPath, placement = "title" }: { subPath: string; placement?: TitleBarPlacement }) {
  const page = panelPage(subPath);
  const targetKey = page.kind === "review" ? page.targetKey : null;
  // Told even while it shows nothing, so the workspace knows not to show them itself.
  useEffect(() => placement === "title" && targetKey ? mountTitleBar(targetKey) : undefined, [placement, targetKey]);
  const api = useWorkspaceFor(targetKey);
  if (!api) return null;
  // A phone's controls are the workspace's own; in full screen BB's bar is hidden, and the band has them.
  if (placement === "title" && (api.layout.mode === "phone" || api.fullscreen.on)) return null;
  return <ReviewControls api={api} placement={placement} />;
}
TitleBarControls.displayName = "TitleBarControls";

function ReviewControls({ api, placement }: { api: WorkspaceApi; placement: TitleBarPlacement }) {
  const status = useDraftStatus(api.targetKey);
  const needsYou = useNeedsYou(api.targetKey);
  const container = useFullscreenPortalContainer();
  const { layout, panel } = api;
  // A wide pane's title bar has room for every label; a phone held sideways, and the band, keep to icons and counts.
  const tier = placement === "band" || layout.mode === "short" ? "icons" : layout.widePane ? "labeled" : "compact";
  const comments = status?.comments ?? 0;
  const touch = placement === "title" || layout.mode === "short" ? TOUCH_COMPACT : TOUCH_CONTROL;
  const labeled = cn("h-8 gap-1.5 px-2 text-muted-foreground aria-pressed:text-foreground", touch);
  const icon = cn("size-8 px-0 text-muted-foreground aria-pressed:text-foreground", touch);
  const controls = sidePanelId(api.targetKey);
  const fullscreenRef = useCallback((el: HTMLButtonElement | null) => {
    if (!el || focusToggle?.to !== placement) return;
    if (Date.now() < focusToggle.until) el.focus();
    focusToggle = null;
  }, [placement]);
  return (
    <CompactViewportOverrideProvider isCompactViewport={layout.mode !== "tablet"}>
      <div role="group" aria-label="Review commands" className="flex shrink-0 items-center gap-1">
        <Hint label="Comments (c)" container={container}>
          <Button variant="ghost" size="sm" aria-label={needsYou ? `Comments, ${needsYou} need you` : "Comments"} aria-pressed={panel.view === "comments"} aria-controls={controls} className={tier === "labeled" ? labeled : cn(icon, needsYou > 0 && "w-auto gap-1 px-2")} onClick={() => panel.toggle("comments")}>
            <Icon name="MessageSquare" aria-hidden />
            {tier === "labeled" && "Comments"}
            {needsYou > 0 && <span aria-hidden className="min-w-4 rounded-full bg-primary px-1 text-center text-[10px] font-semibold leading-4 text-primary-foreground tabular-nums">{needsYou}</span>}
          </Button>
        </Hint>
        <Hint label="Ask agent (a)" container={container}>
          <Button variant="ghost" size="sm" aria-label="Ask agent" aria-pressed={panel.view === "agent"} aria-controls={controls} className={tier === "icons" ? icon : labeled} onClick={() => panel.view === "agent" ? panel.close() : api.askAgent()}>
            <Icon name="Sparkles" className="text-(--ansi-13)" aria-hidden />
            {tier !== "icons" && "Ask agent"}
          </Button>
        </Hint>
        {status && <Hint label="Finish and submit (s)" container={container}>
          <Button variant="ghost" size="sm" aria-label={`Submit review: ${VERDICT_LABEL[status.verdict]}, ${comments} comment${comments === 1 ? "" : "s"}`} aria-pressed={panel.view === "finish"} aria-controls={controls} className={labeled} onClick={() => panel.view === "finish" ? panel.close() : api.openFinish()}>
            <Icon name="Github" aria-hidden />
            {tier === "labeled" ? "Submit review" : "Submit"}
            {tier === "labeled" && <span className="font-normal text-subtle-foreground">· {VERDICT_LABEL[status.verdict]}</span>}
            {comments > 0 && <span className="font-normal text-subtle-foreground tabular-nums">· {comments}</span>}
          </Button>
        </Hint>}
        <ReviewMenu api={api} className={icon} />
        {api.fullscreen.available && <Hint label={`${api.fullscreen.on ? "Exit full screen" : "Full screen"} (⇧F)`} container={container}>
          <Button
            ref={fullscreenRef}
            variant="ghost"
            size="sm"
            aria-label={api.fullscreen.on ? "Exit full screen" : "Full screen"}
            aria-pressed={api.fullscreen.on}
            className={icon}
            onClick={(event) => {
              // From the keyboard (a click without a pointer), the focus follows the toggle.
              if (event.detail === 0) focusToggle = { to: placement === "title" ? "band" : "title", until: Date.now() + 2000 };
              // Inside the click: a browser goes full screen only from one.
              api.fullscreen.toggle();
            }}
          >
            <Icon name={api.fullscreen.on ? "Minimize2" : "Maximize2"} aria-hidden />
          </Button>
        </Hint>}
      </div>
    </CompactViewportOverrideProvider>
  );
}

/**
 * Review actions (⋯): the workspace's own first (Update or Rebuild guide, Open on GitHub, Keyboard shortcuts, Review
 * settings…), then the review's.
 */
export function ReviewMenu({ api, className }: { api: WorkspaceApi; className?: string }) {
  const navigate = useBbNavigate();
  const items: { label: string; icon: IconName; onSelect: () => void }[] = [
    { label: api.newCommits ? "Update guide" : "Rebuild guide", icon: "ArrowReloadHorizontal", onSelect: () => void api.rebuild() },
    ...(api.review.url ? [{ label: "Open on GitHub", icon: "Github" as const, onSelect: () => navigate.openUrl(api.review.url!) }] : []),
    { label: "Keyboard shortcuts", icon: "CircleQuestion", onSelect: api.showShortcuts },
    { label: "Review settings…", icon: "Settings", onSelect: () => void api.leave(`settings/${api.targetKey}`) },
  ];
  return <ReviewActions review={api.review} className={className} pinnable={api.pinnable} items={items} onChanged={() => void api.reload()} onDeleted={() => void api.leave()} />;
}
