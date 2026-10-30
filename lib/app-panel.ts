// BB's own side panel, where a review's Review agent and Main thread tabs show (components/PanelTabs.tsx). Its hooks
// arrived with BB 0.48.0's clients: BB's 0.47.1 desktop app, which the engines still admit, runs the panel without them.
import { experimental_useAppPanel, experimental_useTabVisible, type ExperimentalPanelController } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";

const useAppPanelHook = experimental_useAppPanel as typeof experimental_useAppPanel | undefined;
const useTabVisibleHook = experimental_useTabVisible as typeof experimental_useTabVisible | undefined;

/** The side panel of the surface this renders in, or null on a client without one. */
export function useAppPanel(): ExperimentalPanelController | null {
  return useAppPanelHook?.() ?? null;
}

/** Whether the tab this renders in shows; on a client that can't say, it does. */
export function useTabVisible(): boolean {
  return useTabVisibleHook?.() ?? true;
}

/** Says so when BB couldn't show the tab: a client without its side panel, or one that declined. */
export function panelDeclined() {
  toast.error("BB couldn’t open its side panel here. Update BB to see the review agent and the main thread beside the review.");
}
