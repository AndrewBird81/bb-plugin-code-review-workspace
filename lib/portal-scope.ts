/**
 * Plugin flavor of the app's `lib/portal-scope.ts` (registry override —
 * component files are byte-identical between the app and the registry; only
 * this file differs). Everything a plugin renders is plugin-scoped, so the
 * scope attributes are unconditional: portaled overlay content (dialog,
 * select, popover, …) lands in document.body, outside the plugin's
 * `[data-bb-plugin]` mount, and must carry its own scope root for the
 * plugin's compiled stylesheet (`@scope ([data-bb-plugin="<id>"], …)`) to
 * reach it. `__BB_PLUGIN_ID__` is an esbuild define stamped by
 * `bb plugin build`; outside that pipeline (registry copies, tests) it is
 * undefined and the generic root attribute alone keeps legacy behavior. In
 * the host app the same hook reads the plugin-slot context instead, so host
 * overlays stay out of plugin scopes. The portaled-overlay marker is shared
 * with the host copy and lets Electron route pointer input to visible
 * overlay controls instead of an underlying window-drag region.
 */
import { useSyncExternalStore } from "react";
declare const __BB_PLUGIN_ID__: string | undefined;

const subscribeFullscreen = (notify: () => void) => {
  document.addEventListener("fullscreenchange", notify);
  // A popover's toggle doesn't bubble.
  document.addEventListener("toggle", notify, true);
  return () => {
    document.removeEventListener("fullscreenchange", notify);
    document.removeEventListener("toggle", notify, true);
  };
};
const getFullscreenContainer = () => (document.fullscreenElement ?? document.querySelector("[data-fullscreen-cover]")) as HTMLElement | null;
/**
 * Browser fullscreen paints only the selected subtree, including its portals; so does an element
 * covering the window from the top layer where the browser can't go full screen, as on an iPhone.
 */
export function useFullscreenPortalContainer() {
  return useSyncExternalStore(subscribeFullscreen, getFullscreenContainer, () => null) ?? undefined;
}

export function usePortalScopeProps(): {
  "data-bb-portaled-overlay": "";
  "data-bb-plugin-root"?: "";
  "data-bb-plugin"?: string;
} {
  const pluginId =
    typeof __BB_PLUGIN_ID__ === "string" ? __BB_PLUGIN_ID__ : undefined;
  return {
    "data-bb-portaled-overlay": "",
    "data-bb-plugin-root": "",
    ...(pluginId !== undefined ? { "data-bb-plugin": pluginId } : {}),
  };
}
