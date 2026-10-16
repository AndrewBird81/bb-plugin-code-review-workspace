import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { defaultPreferences } from "../src/preferences";
import { findPicker } from "./provider-picker.test-support";

afterEach(cleanup);

test("an edit made as soon as findPicker returns bb's picker fake sticks, though the picker showed with its mount effect pending", async () => {
  await loadPluginApp(() => import("../app"));
  const { ReviewSettings } = await import("./ReviewSettings");
  const record = { preferences: { ...defaultPreferences }, revision: 0 };
  const defaults = { providerId: "codex", model: "gpt-6-astra", reasoningLevel: "low", permissionMode: "auto", serviceTier: "default" };
  const getAgentDefaults = vi.fn().mockResolvedValue({ defaults, guideWriterMode: "accept-edits" });
  const slot = renderSlot({ component: ReviewSettings }, {}, { rpc: { setReviewPresence: () => ({ ok: true }), getPreferences: () => record, getAgentDefaults } });
  const guide = await slot.findByRole("group", { name: "Guide writer agent" });
  // Custom shows the picker after the awaited defaults, in a render whose effects React runs in a later task. Look for
  // it the moment it shows, while that effect is surely pending.
  const edited = new Promise<string>((resolve) => {
    const observer = new MutationObserver(() => {
      if (!slot.queryByTestId("bb-provider-model-picker")) return;
      observer.disconnect();
      void findPicker(slot).then((picker) => {
        const model = within(picker).getByRole("textbox", { name: "Model" }) as HTMLInputElement;
        fireEvent.change(model, { target: { value: "gpt-6" } });
        resolve(model.value);
      });
      // As under load: a slow moment once the search is under way, so its timer is due before React's next task.
      process.nextTick(() => { const until = performance.now() + 5; while (performance.now() < until); });
    });
    observer.observe(slot.container, { childList: true, subtree: true });
  });
  fireEvent.click(within(guide).getByRole("button", { name: "Custom" }));
  expect(await edited).toBe("gpt-6");
  slot.lifecycle.unmount();
});
