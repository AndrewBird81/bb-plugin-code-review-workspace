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
  app.slots.experimental_appOverlay?.({ id: "needs-review", component: NeedsReviewSidebar });
});
