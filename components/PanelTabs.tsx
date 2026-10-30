// The review page's tabs in BB's own side panel (app.tsx): Review agent and Main thread, the other side of the work
// beside the review. BB draws them apart from the page, with only its subPath, so each reads the review showing from
// the workspace store, and follows it as you switch reviews.
import { useEffect, type ReactNode } from "react";
import type { ExperimentalTabReference, PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { useTabVisible } from "../lib/app-panel";
import { SettingsProvider } from "../lib/settings";
import { WorkspaceView } from "../lib/workspace-context";
import { panelPage, showTab, useReviewTitle, useWorkspaceFor } from "../lib/workspace-store";
import { AgentDock } from "./AgentDock";
import { MainThreadPanel } from "./MainThreadPanel";

export type ReviewTab = "agent" | "main";

/** The tabs as BB's panel controller names them, and their registrations begin (app.tsx). */
export const REVIEW_TABS: Record<ReviewTab, ExperimentalTabReference & { context: { kind: "nav-panel"; panelId: string }; availability: "fixed" }> = {
  agent: { id: "agent", context: { kind: "nav-panel", panelId: "review" }, availability: "fixed" },
  main: { id: "main", context: { kind: "nav-panel", panelId: "review" }, availability: "fixed" },
};

const reviewOf = (subPath: string) => {
  const page = panelPage(subPath);
  return page.kind === "review" ? page.targetKey : null;
};

/** Review agent shows beside a review, not All reviews or Settings. */
export function useAgentTabVisible({ subPath }: PluginNavPanelProps): boolean {
  return reviewOf(subPath) !== null;
}

/** Main thread shows beside a review that has one, once its page has loaded. */
export function useMainTabVisible({ subPath }: PluginNavPanelProps): boolean {
  return !!useWorkspaceFor(reviewOf(subPath))?.mainThread;
}

function Notice({ children }: { children: ReactNode }) {
  return <p role="status" className="m-3 rounded-lg border border-border bg-muted/25 p-3 text-sm text-muted-foreground">{children}</p>;
}

/** Which review the tab is for, and whether it shows, which it tells the store for the review's commands. */
function useTab(subPath: string, tab: ReviewTab) {
  const targetKey = reviewOf(subPath);
  const visible = useTabVisible();
  useEffect(() => visible && targetKey ? showTab(targetKey, tab) : undefined, [visible, targetKey, tab]);
  return { targetKey, visible, api: useWorkspaceFor(targetKey), shown: !!useReviewTitle(targetKey) };
}

/** Before the review's page has its guide: still loading, or shown without one, as while it's built or found on GitHub. */
const waiting = (shown: boolean) => <Notice>{shown ? "This shows once the review’s guide is ready." : "Opening the review…"}</Notice>;

/** Review agent: the review's agent conversation, its first message choosing the agent. */
export function ReviewAgentTab({ subPath }: PluginNavPanelProps) {
  const { targetKey, visible, api, shown } = useTab(subPath, "agent");
  if (!targetKey) return <Notice>Open a review to ask its agent.</Notice>;
  if (!api) return waiting(shown);
  // Keyed by the review: switching reviews switches the conversation.
  return <SettingsProvider><AgentDock key={targetKey} targetKey={targetKey} reviewId={api.reviewId} patch={api.patch} injection={api.injection} active={visible} /></SettingsProvider>;
}
ReviewAgentTab.displayName = "ReviewAgentTab";

/** Main thread: the thread that writes the code and gets your Sends, with Change and Go to thread. */
export function MainThreadTab({ subPath }: PluginNavPanelProps) {
  const { targetKey, visible, api, shown } = useTab(subPath, "main");
  if (!targetKey) return <Notice>Open a review to see its main thread.</Notice>;
  if (!api) return waiting(shown);
  return <SettingsProvider><WorkspaceView api={api}><MainThreadPanel key={targetKey} active={visible} reviewId={api.reviewId} /></WorkspaceView></SettingsProvider>;
}
MainThreadTab.displayName = "MainThreadTab";
