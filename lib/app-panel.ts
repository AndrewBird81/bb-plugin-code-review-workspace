// BB's own side panel, where a review's Review agent and Main thread tabs show (components/PanelTabs.tsx). Its hooks
// arrived with BB 0.48.0's clients: BB's 0.47.1 desktop app, which the engines still admit, runs the panel without them.
import { experimental_useAppPanel, experimental_useTabVisible, type ExperimentalPanelController } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";

const useAppPanelHook = experimental_useAppPanel as typeof experimental_useAppPanel | undefined;
const useTabVisibleHook = experimental_useTabVisible as typeof experimental_useTabVisible | undefined;

// Whether BB took the review page's tabs: a client from before them may refuse them (app.tsx).
let tabsTaken = true;

/** BB refused the review page's tabs: the review opens the agent's and the main thread's chats as threads instead. */
export function tabsRefused() { tabsTaken = false; }

/** The side panel of the surface this renders in, or null on a client without one, or without the review's tabs. */
export function useAppPanel(): ExperimentalPanelController | null {
  const panel = useAppPanelHook?.() ?? null;
  return tabsTaken ? panel : null;
}

/** Whether the tab this renders in shows; on a client that can't say, it does. */
export function useTabVisible(): boolean {
  return useTabVisibleHook?.() ?? true;
}

/** BB's panel declined the tab, as where it doesn't list it. */
export function panelDeclined(tab: "agent" | "main") {
  toast.error(tab === "agent" ? "The review agent isn’t available here." : "The main thread isn’t available here.");
}

/** A client without BB's panel, with no review agent chat to open in a split: one starts only in BB's panel. */
export function panelMissing() {
  toast.error("Update the BB app to start a review agent chat here.");
}
