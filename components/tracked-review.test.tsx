// @vitest-environment jsdom
import { afterEach, expect, test } from "vitest";
import { cleanup } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { defaultPreferences } from "../src/preferences";
import { snoozeLabel } from "../lib/turn";

afterEach(() => { cleanup(); });

test("a snoozed tracked review says when it wakes, as the list does", async () => {
  const app = await loadPluginApp(() => import("../app"));
  const until = Date.now() + 3 * 86_400_000;
  const slot = renderSlot(app.navPanels[0]!, { subPath: "pr-42" }, { rpc: {
    setReviewPresence: () => ({ ok: true }),
    getReviewBundle: () => ({ review: { targetKey: "pr-42", kind: "pr", status: "tracked", createdAt: 1, title: "Parse rows", snoozedUntil: until,
      turn: { group: "waiting", reason: "snoozed", label: "Snoozed" } }, guide: null, patch: "", revision: "r1" }),
    getPreferences: () => ({ preferences: defaultPreferences, revision: 0 }),
    getFileViews: () => ({ views: [] }),
  } as any });
  const section = await slot.findByRole("region", { name: "Tracked pull request" });
  expect(section.textContent).toContain(snoozeLabel(until));
  slot.lifecycle.unmount();
});
