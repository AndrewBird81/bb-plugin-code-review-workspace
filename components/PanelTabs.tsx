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
import { hasNotPushed } from "../lib/main-thread";

export type PanelTab = "agent" | "main";

/** The tabs as BB's panel controller names them, and their registrations begin (app.tsx). */
export const REVIEW_TABS: Record<PanelTab, ExperimentalTabReference & { context: { kind: "nav-panel"; panelId: string }; availability: "fixed" }> = {
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

/**
 * Main thread shows beside a review that has one, or whose PR has Not pushed yet, which it shows; and while the
 * review's page loads, so a tab BB opens on as it remembers doesn't blink, not once the page shows without a guide.
 */
export function useMainTabVisible({ subPath }: PluginNavPanelProps): boolean {
  const targetKey = reviewOf(subPath);
  const api = useWorkspaceFor(targetKey);
  const shown = !!useReviewTitle(targetKey);
  if (!targetKey) return false;
  return api ? !!api.mainThread || hasNotPushed(api.review) : !shown;
}

function Notice({ children }: { children: ReactNode }) {
  return <p role="status" className="m-3 rounded-lg border border-border bg-muted/25 p-3 text-sm text-muted-foreground">{children}</p>;
}

/** Which review the tab is for, and whether it shows, which it tells the store for the review's commands. */
function useTab(subPath: string, tab: PanelTab) {
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
  // BB lists it only beside a review, though it may keep it drawn, hidden, a moment after.
  if (!targetKey) return null;
  if (!api) return waiting(shown);
  // Keyed by the review: switching reviews switches the conversation.
  return <SettingsProvider><AgentDock key={targetKey} targetKey={targetKey} reviewId={api.reviewId} reviewName={api.reviewName} patch={api.patch} injection={api.injection} active={visible} /></SettingsProvider>;
}
ReviewAgentTab.displayName = "ReviewAgentTab";

/** Main thread: the thread that writes the code and gets your Sends, with Change thread and Main thread ↗. */
export function MainThreadTab({ subPath }: PluginNavPanelProps) {
  const { targetKey, visible, api } = useTab(subPath, "main");
  // BB lists it only beside a review.
  if (!targetKey) return null;
  if (!api) return <Notice>Opening the review…</Notice>;
  return <SettingsProvider><WorkspaceView api={api}><MainThreadPanel key={targetKey} active={visible} reviewId={api.reviewId} reviewName={api.reviewName} /></WorkspaceView></SettingsProvider>;
}
MainThreadTab.displayName = "MainThreadTab";
