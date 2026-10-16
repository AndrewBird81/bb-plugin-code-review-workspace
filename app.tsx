// bb-plugin-guided-review — frontend entry.
//
// Registers the "Guided Review" navPanel (a sidebar entry + its own route).
// The panel routes by subPath: "" renders the review list, anything else
// renders the chapter/diff workspace for that target; an open review's commands
// go in the panel's title bar. An app overlay adds Needs review and pinned
// reviews to BB's thread list, which has no slot for them.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { ReviewPanel } from "./components/ReviewPanel";
import { ReviewSettings } from "./components/ReviewSettings";
import { NeedsReviewSidebar } from "./components/NeedsReviewSidebar";
import { TitleBarControls } from "./components/TitleBarControls";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { paletteCommandsAvailable, postPaletteCommand, readClipboard } from "./lib/commands";

/** Needs review's rows in BB's own thread list: should they fail to draw, BB's list shows without them. */
function SidebarOverlay() {
  return <ErrorBoundary fallback={() => null}><NeedsReviewSidebar /></ErrorBoundary>;
}

export default definePluginApp((app) => {
  app.slots.settingsSection({ id: "review-settings", title: "Guided Review", component: ReviewSettings });
  app.slots.navPanel({
    id: "review",
    title: "Guided Review",
    icon: "GitPullRequest",
    path: "review",
    component: ReviewPanel,
    headerContent: TitleBarControls,
  });
  // Optional call: BB hosts from before app overlays skip it rather than fail to load the plugin.
  app.slots.experimental_appOverlay?.({ id: "needs-review", component: SidebarOverlay });
  // BB's command palette, each rebindable; the overlay above handles them, so without it they aren't listed.
  app.commands.register({ id: "next-review", title: "Guided Review: Next review that needs me", defaultShortcut: { key: "u", mod: true, shift: true },
    isAvailable: paletteCommandsAvailable, run: () => postPaletteCommand({ kind: "next" }) });
  app.commands.register({ id: "review-from-clipboard", title: "Guided Review: Review PR from clipboard",
    isAvailable: paletteCommandsAvailable, run: async () => postPaletteCommand({ kind: "clipboard", text: await readClipboard() }) });
  app.commands.register({ id: "all-reviews", title: "Guided Review: All reviews", isAvailable: paletteCommandsAvailable, run: () => postPaletteCommand({ kind: "all" }) });
});
