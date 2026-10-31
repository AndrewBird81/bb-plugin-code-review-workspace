import { useCallback, useEffect } from "react";
import { VERDICT_LABEL } from "../src/draft";
import { useDraftStatus, useLocalToSend } from "../lib/draft-status";
import { useFullscreenPortalContainer } from "../lib/portal-scope";
import { ariaKeys, keyHint } from "../lib/review-shortcuts";
import { cn } from "../lib/utils";
import { phoneWindow } from "../lib/workspace-layout";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../src/rpc-contract";
import { useAppPanel } from "../lib/app-panel";
import { switchHint } from "../lib/commands";
import { mountTitleBar, panelPage, useNeedsYou, useTabShown, useWorkspaceFor } from "../lib/workspace-store";
import type { WorkspaceApi } from "../lib/workspace-context";
import { CompactViewportOverrideProvider } from "./ui/hooks/use-compact-viewport";
import { Button } from "./ui/button";
import { Hint } from "./ui/hint";
import { REWRITE_GUIDE } from "./shell/ReviewNotices";
import { keptApartLine } from "./shell/PrNotices";
import { useMediaQuery } from "./ui/hooks/use-media-query";
import { Icon } from "./ui/icon";
import { ReviewActions, type ReviewMenuItem } from "./ReviewActions";
import { ListTitleBar } from "./inbox/ListTitleBar";
import { sidePanelId } from "./shell/SidePanel";
import { TOUCH_COMPACT, TOUCH_CONTROL } from "./touch";

/** Where the controls are: BB's title bar, or the end of the workspace's band, which has them in full screen. */
export type TitleBarPlacement = "title" | "band";

// Full screen hides BB's bar and shows the band's controls, and leaving it does the opposite: the focus goes from
// the toggle clicked to the other one, when that shows within a moment.
let focusToggle: { to: TitleBarPlacement; until: number } | null = null;

/**
 * The review's commands: Comments, Ask agent, Main thread ↗ and Show beside review (with one), Finish review, Review
 * actions (⋯) and Full screen; on All reviews, the list's. BB renders it in its title bar (navPanel headerContent) with
 * the page's subPath, apart from the page, so it reads the workspace from the store. A plain function, not memo: the SDK takes only a function as a slot's component.
 */
export function TitleBarControls({ subPath, placement = "title" }: { subPath: string; placement?: TitleBarPlacement }) {
  const page = panelPage(subPath);
  const targetKey = page.kind === "review" ? page.targetKey : null;
  // Told even while it shows nothing, so the workspace knows not to show them itself.
  useEffect(() => placement === "title" && targetKey ? mountTitleBar(targetKey) : undefined, [placement, targetKey]);
  const api = useWorkspaceFor(targetKey);
  // All reviews' own: Find on a phone, Refresh and Settings.
  if (page.kind === "list") return placement === "title" ? <ListTitleBar /> : null;
  if (!api) return null;
  // A phone's controls are the workspace's own; in full screen BB's bar is hidden, and the band has them.
  if (placement === "title" && (api.layout.mode === "phone" || api.fullscreen.on)) return null;
  return <ReviewControls api={api} placement={placement} />;
}
TitleBarControls.displayName = "TitleBarControls";

function ReviewControls({ api, placement }: { api: WorkspaceApi; placement: TitleBarPlacement }) {
  const status = useDraftStatus(api.targetKey);
  const localToSend = useLocalToSend(api.targetKey);
  const needsYou = useNeedsYou(api.targetKey);
  const container = useFullscreenPortalContainer();
  const { layout, panel } = api;
  const appPanel = useAppPanel();
  const navigate = useBbNavigate();
  // BB's tabs, showing beside the review: never over full screen, which their buttons leave to show them.
  const agentShown = useTabShown(api.targetKey, "agent") && !api.fullscreen.on;
  const mainShown = useTabShown(api.targetKey, "main") && !api.fullscreen.on;
  // A wide pane's title bar has room for every label; a phone held sideways, a narrow pane beside BB's side panel, and
  // the band keep to icons and counts.
  const tier = placement === "band" || layout.mode === "short" || layout.narrowPane ? "icons" : layout.widePane ? "labeled" : "compact";
  // There Finish review is its icon and count too, where "Finish · 1" left BB's crumbs no room; the band keeps its word
  // over 720px.
  const finishIcons = placement === "title" && tier === "icons";
  // Finish review's count: what Submit posts, with the verdict; a local review, which submits nothing, what Send would send.
  const comments = status?.comments ?? localToSend ?? 0;
  const finishLabel = status ? `Finish review: ${VERDICT_LABEL[status.verdict]}, ${comments} comment${comments === 1 ? "" : "s"}`
    : comments ? `Finish review: ${comments} comment${comments === 1 ? "" : "s"} to send` : "Finish review";
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
      <div role="group" aria-label="Review commands" data-review-commands={api.targetKey} className="flex shrink-0 items-center gap-1">
        {/* Its count is what needs you, which the tooltip says; Finish review's is what will be sent. */}
        <Hint label={keyHint(needsYou ? `Comments · ${needsYou} need${needsYou === 1 ? "s" : ""} you` : "Comments", "c", api.shortcuts)} container={container}>
          <Button variant="ghost" size="sm" aria-label={needsYou ? `Comments, ${needsYou} need you` : "Comments"} aria-pressed={panel.view === "comments"} aria-controls={controls} aria-keyshortcuts={ariaKeys("c", api.shortcuts)} className={tier === "labeled" ? labeled : cn(icon, needsYou > 0 && "w-auto gap-1 px-2")} onClick={() => panel.toggle("comments")}>
            <Icon name="MessageSquare" aria-hidden />
            {tier === "labeled" && "Comments"}
            {needsYou > 0 && <span aria-hidden className="min-w-4 rounded-full bg-primary px-1 text-center text-[10px] font-semibold leading-4 text-primary-foreground tabular-nums">{needsYou}</span>}
          </Button>
        </Hint>
        {/* Mid-width, the switch to the main thread keeps its label and Ask agent, with its key and BB's tab, gives way. */}
        <Hint label={keyHint("Ask agent", "a", api.shortcuts)} container={container}>
          <Button variant="ghost" size="sm" aria-label="Ask agent" aria-pressed={agentShown} aria-keyshortcuts={ariaKeys("a", api.shortcuts)} className={tier === "labeled" ? labeled : icon} onClick={() => agentShown ? appPanel?.close() : api.askAgent()}>
            <Icon name="Sparkles" className="text-(--ansi-13)" aria-hidden />
            {tier === "labeled" && "Ask agent"}
          </Button>
        </Hint>
        {/* The other side of the work, a click away, as the thread's Review · 2 open ↗ is from there: always with its ↗. */}
        {api.mainThread && <Hint label={switchHint("Go to the main thread")} container={container}>
          <Button variant="ghost" size="sm" aria-label="Go to main thread" className={tier === "icons" ? cn(icon, "w-auto gap-0.5 px-1.5") : labeled} onClick={() => navigate.toThread(api.mainThread!.threadId)}>
            <Icon name="Code" aria-hidden />
            {tier !== "icons" && "Main thread"}
            <Icon name="ArrowUpRight" className="size-3.5" aria-hidden />
          </Button>
        </Hint>}
        {api.mainThread && <Hint label={mainShown ? "Hide main thread" : "Show main thread beside review"} container={container}>
          <Button variant="ghost" size="sm" aria-label="Show main thread beside review" aria-pressed={mainShown} className={icon} onClick={() => mainShown ? appPanel?.close() : panel.open("main")}>
            <Icon name="Columns2" aria-hidden />
          </Button>
        </Hint>}
        {(status || localToSend !== null) && <Hint label={keyHint("Finish review", "s", api.shortcuts)} container={container}>
          <Button variant="ghost" size="sm" aria-label={finishLabel} aria-pressed={panel.view === "finish"} aria-controls={controls} aria-keyshortcuts={ariaKeys("s", api.shortcuts)} className={finishIcons ? cn(icon, comments > 0 && "w-auto gap-1 px-2") : labeled} onClick={() => panel.view === "finish" ? panel.close() : api.openFinish()}>
            {/* A local review's goes to the main thread, not GitHub. */}
            <Icon name={status ? "Github" : "Send"} aria-hidden />
            {/* A band under 720px (full screen on a phone) keeps its room for where you are: the icon and the count. */}
            {!finishIcons && <span className={cn(placement === "band" && "@max-[720px]/band:hidden")}>{tier === "labeled" ? "Finish review" : "Finish"}</span>}
            {tier === "labeled" && status && <span className="font-normal text-subtle-foreground">· {VERDICT_LABEL[status.verdict]}</span>}
            {comments > 0 && <span className="font-normal text-subtle-foreground tabular-nums">{!finishIcons && <span className={cn(placement === "band" && "@max-[720px]/band:hidden")}>· </span>}{comments}</span>}
          </Button>
        </Hint>}
        <ReviewMenu api={api} className={icon} />
        {api.fullscreen.available && <Hint label={keyHint(api.fullscreen.on ? "Exit full screen" : "Full screen", "⇧F", api.shortcuts)} container={container}>
          <Button
            ref={fullscreenRef}
            variant="ghost"
            size="sm"
            aria-label={api.fullscreen.on ? "Exit full screen" : "Full screen"}
            aria-keyshortcuts={ariaKeys("F", api.shortcuts)}
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
 * Review actions (⋯): the workspace's Update or Rebuild guide first, then the review's own, a local review's Rewrite guide
 * after its Rename…, so the menu doesn't open on what starts the guide writer, with the workspace's Keyboard
 * shortcuts and Review settings… after Open on GitHub. An archived review's guide isn't rebuilt. A phone, without a
 * mouse to say a keyboard may be there, has no Keyboard shortcuts; an iPad keeps them, for its keyboard. Neither has
 * them while Settings turns single-key shortcuts off. An offer about its PR you dismissed is here after the guide's:
 * Keep both's Merge into one review, saying which stays, and Not this one's Make it PR #n's review.
 */
export function ReviewMenu({ api, className }: { api: WorkspaceApi; className?: string }) {
  const fine = useMediaQuery("(any-pointer: fine)");
  const rpc = useRpc<typeof rpcContract>();
  const keys = api.shortcuts && (fine || !phoneWindow());
  const local = api.review.kind === "ref";
  const { keptApart, prPending } = api.review;
  const call = (run: () => Promise<{ ok: boolean; error?: string }>, failed: string) => async () => {
    try {
      const result = await run();
      if (!result.ok) toast.error(result.error ?? failed);
      else await api.reload();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : failed);
    }
  };
  const dismissed: ReviewMenuItem[] = api.review.archivedAt ? [] : [
    ...keptApart ? [{ label: "Merge into one review", icon: "GitMerge", detail: keptApartLine(keptApart, !local), onSelect: call(() => rpc.call("mergeReviews", { targetKey: api.targetKey }), "Couldn’t merge the two reviews.") } satisfies ReviewMenuItem] : [],
    // Why it was held, as its notice said.
    ...local && prPending?.declined && prPending.why !== "error" ? [{ label: `Make it PR #${prPending.number}’s review`, icon: "GitPullRequest",
      detail: prPending.why === "branch" && prPending.head ? `PR #${prPending.number} is from ${prPending.head}, not this branch.` : `This branch has PR #${prPending.number}, opened before this review.`, onSelect: call(() => rpc.call("takePendingPr", { targetKey: api.targetKey }), "Couldn’t make it the PR’s review.") } satisfies ReviewMenuItem] : [],
  ];
  const items: ReviewMenuItem[] = [...api.review.archivedAt || local ? [] : [{ label: api.newCommits ? "Update guide" : "Rebuild guide", icon: "ArrowReloadHorizontal", onSelect: () => void api.rebuild() } satisfies ReviewMenuItem], ...dismissed];
  const afterRename: ReviewMenuItem[] = api.review.archivedAt || !local ? [] : [{ label: "Rewrite guide", icon: "Sparkles", agent: true, description: REWRITE_GUIDE, onSelect: () => void api.rebuild() }];
  const trailing: ReviewMenuItem[] = [
    ...(keys ? [{ label: "Keyboard shortcuts", icon: "CircleQuestion", keys: "?", onSelect: api.showShortcuts } satisfies ReviewMenuItem] : []),
    { label: "Review settings…", icon: "Settings", onSelect: () => void api.leave(`settings/${api.targetKey}`) },
  ];
  return <ReviewActions review={api.review} className={className} pinnable={api.pinnable} items={items} afterRename={afterRename} trailing={trailing} onChanged={() => void api.reload()} onDeleted={() => void api.leave()} />;
}
