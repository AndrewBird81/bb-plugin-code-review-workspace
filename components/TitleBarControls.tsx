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
import { panelPage, useNeedsYou, useTabShown } from "../lib/workspace-store";
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
import { DiffOptionsPage } from "./reading/DiffOptions";

/** BB's title bar names a review; only All reviews adds plugin controls here. */
export function TitleBarControls({ subPath }: { subPath: string }) {
  return panelPage(subPath).kind === "list" ? <ListTitleBar /> : null;
}
TitleBarControls.displayName = "TitleBarControls";

/** The same commands in the band and phone dock; labels depend only on the band's CSS container. */
export function ReviewControls({ api, threads = false, phone = false }: { api: WorkspaceApi; threads?: boolean; phone?: boolean }) {
  const status = useDraftStatus(api.targetKey);
  const localToSend = useLocalToSend(api.targetKey);
  const needsYou = useNeedsYou(api.targetKey);
  const container = useFullscreenPortalContainer();
  const { layout, panel } = api;
  const appPanel = useAppPanel();
  const agentShown = useTabShown(api.targetKey, "agent") && !api.fullscreen.on;
  const mainShown = useTabShown(api.targetKey, "main") && !api.fullscreen.on;
  const comments = status?.comments ?? localToSend ?? 0;
  const finishLabel = status ? `Finish review: ${VERDICT_LABEL[status.verdict]}, ${comments} comment${comments === 1 ? "" : "s"}`
    : comments ? `Finish review: ${comments} comment${comments === 1 ? "" : "s"} to send` : "Finish review";
  const touch = layout.mode === "short" ? TOUCH_COMPACT : TOUCH_CONTROL;
  const icon = cn("h-8 min-w-8 gap-1 px-1.5 text-muted-foreground aria-pressed:text-foreground", touch, phone && "h-11 min-w-11 px-2");
  const label = "hidden min-w-0 truncate @min-[880px]/band:inline";
  return (
    <CompactViewportOverrideProvider isCompactViewport={layout.mode !== "tablet"}>
      <div role={phone ? undefined : "group"} aria-label={phone ? undefined : "Review commands"} data-review-commands={api.targetKey} className="flex shrink-0 items-center gap-1">
        <Hint label={keyHint(needsYou ? `Comments · ${needsYou} need${needsYou === 1 ? "s" : ""} you` : "Comments", "c", api.shortcuts)} container={container}>
          <Button variant="ghost" size="sm" aria-label={needsYou ? `Comments, ${needsYou} need you` : "Comments"} aria-pressed={panel.view === "comments"} aria-controls={sidePanelId(api.targetKey)} aria-keyshortcuts={ariaKeys("c", api.shortcuts)} className={icon} onClick={() => panel.toggle("comments")}>
            <Icon name="MessageSquare" aria-hidden />
            {!phone && <span className={label}>Comments</span>}
            {needsYou > 0 && <span aria-hidden className="min-w-4 rounded-full bg-primary px-1 text-center text-[10px] font-semibold leading-4 text-primary-foreground tabular-nums">{needsYou}</span>}
          </Button>
        </Hint>
        <Hint label={keyHint("Agent", "a", api.shortcuts)} container={container}>
          <Button variant="ghost" size="sm" aria-label="Agent" aria-pressed={agentShown} aria-keyshortcuts={ariaKeys("a", api.shortcuts)} className={icon} onClick={() => agentShown ? appPanel?.close() : api.askAgent()}>
            <Icon name="Sparkles" className="text-(--ansi-13)" aria-hidden />
            {!phone && <span className={label}>Agent</span>}
          </Button>
        </Hint>
        {!phone && api.mainThread && <Hint label={mainShown ? "Hide main thread" : "Show main thread beside review"} container={container}>
          <Button variant="ghost" size="sm" aria-label="Main thread" aria-pressed={mainShown} className={icon} onClick={() => mainShown ? appPanel?.close() : panel.open("main")}>
            <Icon name="Code" aria-hidden /><span className={label}>Main thread</span>
          </Button>
        </Hint>}
        {(status || localToSend !== null) && <Hint label={keyHint("Finish review", "s", api.shortcuts)} container={container}>
          <Button variant={panel.view === "finish" ? "outline" : "default"} size="sm" aria-label={finishLabel} aria-controls={sidePanelId(api.targetKey)} aria-keyshortcuts={ariaKeys("s", api.shortcuts)} className={cn("h-8 shrink-0 gap-1 px-1.5", touch, phone && "h-11 px-2")} onClick={() => api.openFinish()}>
            <span>Finish{!phone && <span className={label}> review</span>}</span>
            {comments > 0 && <span aria-hidden className="font-normal opacity-75 tabular-nums">· {comments}</span>}
          </Button>
        </Hint>}
        <ReviewMenu api={api} threads={threads} className={cn(icon, "w-8 px-0")} />
      </div>
    </CompactViewportOverrideProvider>
  );
}

/** Navigation and display, then the review's existing actions and settings, in one menu. */
export function ReviewMenu({ api, threads = false, className }: { api: WorkspaceApi; threads?: boolean; className?: string }) {
  const fine = useMediaQuery("(any-pointer: fine)");
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
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
    // On a PR's review, for the folder's review it names, of the PR's two or more.
    ...keptApart ? [{ label: "Merge into one review", icon: "GitMerge", detail: keptApartLine(keptApart, !local), onSelect: call(() => rpc.call("mergeReviews", { targetKey: local ? api.targetKey : keptApart.targetKey }), "Couldn’t merge the two reviews.") } satisfies ReviewMenuItem] : [],
    // Why it was held, as its notice said.
    ...local && prPending?.declined && prPending.why !== "error" ? [{ label: `Make it PR #${prPending.number}’s review`, icon: "GitPullRequest",
      detail: prPending.why === "branch" && prPending.head ? `PR #${prPending.number} is from \`${prPending.head}\`, not this branch.` : `This branch has PR #${prPending.number}, opened before this review.`, onSelect: call(() => rpc.call("takePendingPr", { targetKey: api.targetKey }), "Couldn’t make it the PR’s review.") } satisfies ReviewMenuItem] : [],
  ];
  const items: ReviewMenuItem[] = [...api.review.archivedAt || local ? [] : [{ label: api.newCommits ? "Update guide" : "Rebuild guide", icon: "ArrowReloadHorizontal", onSelect: () => void api.rebuild() } satisfies ReviewMenuItem], ...dismissed];
  const afterRename: ReviewMenuItem[] = api.review.archivedAt || !local ? [] : [{ label: "Rewrite guide", icon: "Sparkles", agent: true, description: REWRITE_GUIDE, onSelect: () => void api.rebuild() }];
  const trailing: ReviewMenuItem[] = [
    ...(keys ? [{ label: "Keyboard shortcuts", icon: "CircleQuestion", keys: "?", onSelect: api.showShortcuts } satisfies ReviewMenuItem] : []),
    { label: "Review settings…", icon: "Settings", onSelect: () => void api.leave(`settings/${api.targetKey}`) },
  ];
  const leading: ReviewMenuItem[] = [
    ...api.layout.mode === "phone" ? [{ label: "All reviews", icon: "ChevronLeft", onSelect: () => void api.leave() } satisfies ReviewMenuItem] : [],
    { label: "Find in review", icon: "Search", keys: api.shortcuts ? "/" : undefined, onSelect: api.nav.find },
    ...api.mainThread ? [{ label: "Go to main thread ↗", icon: "ArrowUpRight", onSelect: () => navigate.toThread(api.mainThread!.threadId) } satisfies ReviewMenuItem] : [],
    { label: api.display.commentsFolded ? "Unfold comments in code" : "Fold comments in code", icon: api.display.commentsFolded ? "ChevronsDown" : "ChevronsUp", keys: api.shortcuts ? "i" : undefined, onSelect: () => api.display.setCommentsFolded(!api.display.commentsFolded) },
  ];
  const afterOptions: ReviewMenuItem[] = api.fullscreen.available ? [{ label: api.fullscreen.on ? "Exit full screen" : "Full screen", icon: api.fullscreen.on ? "Minimize2" : "Maximize2", keys: api.shortcuts ? "⇧F" : undefined, onSelect: api.fullscreen.toggle }] : [];
  return <ReviewActions leading={leading} options={(close) => <DiffOptionsPage threads={threads} menu onClose={close} />} afterOptions={afterOptions} review={api.review} className={className} pinnable={api.pinnable} items={items} afterRename={afterRename} trailing={trailing} onChanged={() => void api.reload()} onDeleted={() => void api.leave()} />;
}
