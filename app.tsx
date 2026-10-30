// bb-plugin-code-review-workspace — frontend entry.
//
// Registers the "Code Review Workspace" navPanel (a sidebar entry + its own route).
// The panel routes by subPath: "" renders the review list, anything else
// renders the chapter/diff workspace for that target; an open review's commands
// go in the panel's title bar. An app overlay adds Needs review and pinned
// reviews to BB's thread list, which has no slot for them. A thread's page gets
// Review changes above its message box, and a Review tab while it's linked to one.
import { definePluginApp, type ExperimentalThreadContextSegmentProps, type ExperimentalThreadTabProps } from "@get-bb/plugin-sdk/app";
import { ReviewPanel } from "./components/ReviewPanel";
import { ReviewSettings } from "./components/ReviewSettings";
import { NeedsReviewSidebar } from "./components/NeedsReviewSidebar";
import { TitleBarControls } from "./components/TitleBarControls";
import { PostPreview } from "./components/PostPreview";
import { POST_PREVIEW_RENDERER } from "./src/post-preview";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ReviewChangesSegment, ReviewTab, useReviewChangesVisible, useReviewTabVisible } from "./components/ThreadSurfaces";
import { SWITCH_KEY, paletteCommandsAvailable, postPaletteCommand, readClipboard, switchTarget } from "./lib/commands";
import { useEffect } from "react";
import { panelPage, showPageTitle, useNarrowPane, useReviewTitle } from "./lib/workspace-store";
import { useMediaQuery } from "./components/ui/hooks/use-media-query";
import { MainThreadTab, REVIEW_TABS, ReviewAgentTab, useAgentTabVisible, useMainTabVisible } from "./components/PanelTabs";
import { tabsRefused } from "./lib/app-panel";

/** Needs review's rows in BB's own thread list: should they fail to draw, BB's list shows without them. */
function SidebarOverlay() {
  return <ErrorBoundary fallback={() => null}><NeedsReviewSidebar /></ErrorBoundary>;
}

/** The review agent's Post form, in place of its message box: should it fail to draw, it says so, and "yes" in chat still posts. */
function PostForm(props: Parameters<typeof PostPreview>[0]) {
  return <ErrorBoundary fallback={() => <p role="alert" className="p-3 text-sm text-muted-foreground">The Post form couldn’t show. Reply yes to post what the agent showed, or no.</p>}><PostPreview {...props} /></ErrorBoundary>;
}

/** Review changes, beside BB's Changed files: should it fail to draw, the row shows without it. */
function ReviewChanges(props: ExperimentalThreadContextSegmentProps) {
  return <ErrorBoundary resetKey={props.threadId} fallback={() => null}><ReviewChangesSegment {...props} /></ErrorBoundary>;
}

/** The Review tab: should it fail to draw, it says so and offers to try again. */
function ThreadReview(props: ExperimentalThreadTabProps) {
  return <ErrorBoundary resetKey={props.threadId} fallback={(retry) => <div role="alert" className="m-3 space-y-2 rounded-lg border border-border bg-muted/25 p-3 text-sm text-muted-foreground">
    <p>The review couldn’t show here. Open it from Code Review Workspace, or try again.</p>
    <button type="button" className="text-primary underline-offset-4 hover:underline" onClick={retry}>Try again</button>
  </div>}><ReviewTab {...props} /></ErrorBoundary>;
}

/**
 * BB's title bar, after the panel's name, and the window's title: the open review's id and name, "api#4512 · Fix login
 * race", which its page publishes; the panel's name alone on All reviews and Settings. Each pane asks for its own. The
 * id and the name are crumbs, where the window is at least 720px wide: BB cuts only the last one short. Narrower, the
 * whole line as one title, cut at its end: BB's crumbs run into each other in a tight bar (seen at 390 and 480px), and
 * it shares the bar between the panel's name and a title by their lengths, so the id alone would be cut to "api#4…".
 * So does a review narrower than a phone's beside BB's side panel.
 */
function usePageTitle({ subPath }: { subPath: string }) {
  const page = panelPage(subPath);
  const targetKey = page.kind === "review" ? page.targetKey : null;
  const title = useReviewTitle(targetKey);
  // A narrow pane beside BB's side panel is as tight as a narrow window.
  const narrowPane = useNarrowPane(targetKey);
  const narrow = useMediaQuery("(max-width: 719px)") || narrowPane;
  // Told while it shows the title, so the band leaves the review's name to it.
  useEffect(() => title && targetKey ? showPageTitle(targetKey) : undefined, [title, targetKey]);
  if (!title) return null;
  return narrow || title.line === title.id ? { title: title.line, windowTitle: title.line } : { breadcrumbs: [{ label: title.id }, { label: title.name }], windowTitle: title.line };
}

export default definePluginApp((app) => {
  app.slots.settingsSection({ id: "review-settings", title: "Code Review Workspace", component: ReviewSettings });
  app.slots.navPanel({
    id: "review",
    title: "Code Review Workspace",
    icon: "code-review-workspace/review",
    path: "review",
    component: ReviewPanel,
    headerContent: TitleBarControls,
    // BB hosts from before page titles ignore it, and the band's id chip still says which review it is.
    experimental_usePageTitle: usePageTitle,
  });
  // A review's page: Review agent, and Main thread with one, in BB's own side panel (components/PanelTabs.tsx).
  // A host that refuses a navigation page's tabs, as a client from before them may, loads the plugin without them: the
  // review's commands then open the agent's and the main thread's chats as threads (components/ReviewWorkspace.tsx).
  try {
    app.slots.experimental_tab?.({ ...REVIEW_TABS.agent, title: "Review agent", icon: "code-review-workspace/agent", layout: "flush", component: ReviewAgentTab, useVisible: useAgentTabVisible });
    app.slots.experimental_tab?.({ ...REVIEW_TABS.main, title: "Main thread", icon: "Code", layout: "flush", component: MainThreadTab, useVisible: useMainTabVisible });
  } catch { tabsRefused(); }
  // Optional call: BB hosts from before app overlays skip it rather than fail to load the plugin.
  app.slots.experimental_appOverlay?.({ id: "needs-review", component: SidebarOverlay });
  // The review agent's Post form (src/review-agent-tools.ts). A host without the slot shows none; "yes" in chat posts instead.
  app.slots.pendingInteraction?.({ id: POST_PREVIEW_RENDERER, component: PostForm });
  // A thread's pages. Optional calls: hosts from before either slot, such as BB 0.47.1's desktop app without the segment,
  // skip it. Its group is Changed files', "3_git" (experimental_THREAD_CONTEXT_SEGMENT_GROUPS.git), written out: the
  // build takes that constant from the host, which those hosts lack, and reading it there would stop the plugin loading.
  app.slots.experimental_threadContextSegment?.({ id: "review-changes", title: "Review", group: "3_git", order: 20, summary: ReviewChanges, useVisible: useReviewChangesVisible });
  app.slots.experimental_tab?.({ context: { kind: "thread" }, availability: "fixed", id: "review", title: "Review", icon: "code-review-workspace/review", layout: "flush", component: ThreadReview, useVisible: useReviewTabVisible });
  // BB's command palette, each rebindable; the overlay above handles them, so without it they aren't listed.
  app.commands.register({ id: "next-review", title: "Code Review Workspace: Next review that needs me", defaultShortcut: { key: "u", mod: true, shift: true },
    isAvailable: paletteCommandsAvailable, run: () => postPaletteCommand({ kind: "next" }) });
  app.commands.register({ id: "review-from-clipboard", title: "Code Review Workspace: Review PR from clipboard",
    isAvailable: paletteCommandsAvailable, run: async () => postPaletteCommand({ kind: "clipboard", text: await readClipboard() }) });
  app.commands.register({ id: "all-reviews", title: "Code Review Workspace: All reviews", isAvailable: paletteCommandsAvailable, run: () => postPaletteCommand({ kind: "all" }) });
  // Doing and reviewing, a key apart: a thread's page goes to its review, a review's page to its main thread.
  app.commands.register({ id: "switch-review-thread", title: "Code Review Workspace: Switch between review and main thread", defaultShortcut: SWITCH_KEY,
    isAvailable: (context) => paletteCommandsAvailable() && switchTarget(context) !== null,
    run: (context) => { const to = switchTarget(context); if (to) postPaletteCommand({ kind: "switch", to }); } });
});
