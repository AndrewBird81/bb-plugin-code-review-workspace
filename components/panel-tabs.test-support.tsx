// For tests, not the plugin: a review page's tab in BB's side panel (components/PanelTabs.tsx), as BB shows it beside the
// page, which publishes the review's workspace for it. Import it after the plugin runtime is installed.
import { renderSlot, type CapturedPluginApp, type RenderSlotOptions } from "@get-bb/plugin-sdk/testing/app";

/** The tab `id`, showing, beside the review page at `subPath`; `options` as the page's, its rpc among them. */
export function renderPanelTab(app: CapturedPluginApp, id: "agent" | "main", subPath: string, options: RenderSlotOptions = {}) {
  const tab = app.tabs.find((registration) => registration.id === id && registration.context.kind === "nav-panel");
  if (!tab) throw new Error(`No ${id} tab`);
  return renderSlot(tab as unknown as { component: (props: { subPath: string }) => null }, { subPath }, { tabVisible: true, ...options });
}

/** The tabs the page asked BB's panel to open or toggle, by id, in order. */
export function panelTabCalls(slot: ReturnType<typeof renderSlot>): string[] {
  return slot.inspection.experimental_panelCalls.map((call) => call.method === "close" ? "close" : `${call.method}:${call.options.tab.id}`);
}
