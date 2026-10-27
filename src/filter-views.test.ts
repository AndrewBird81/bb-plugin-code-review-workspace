import { expect, test } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { testSql } from "./test-store.test-support";

async function setup() {
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace" });
  await plugin(bb);
  return { bb, call: harness.behavior.callRpc, channels: () => harness.inspection.realtimeSignals.map((s) => s.channel) };
}

test("saved views are the plugin's, oldest first: saving again renames or refilters one in its place, and each change tells other tabs", async () => {
  const { call, channels } = await setup();
  expect(await call("listFilterViews", null)).toEqual({ views: [] });
  await call("saveFilterView", { id: "v1", name: "Live 4 Project", filters: [{ field: "teams", values: ["acme/live-dev"] }] });
  await call("saveFilterView", { id: "v2", name: "Last 1 week updated", filters: [{ field: "updated", days: 7 }] });
  await call("saveFilterView", { id: "v1", name: "Live Dev", filters: [{ field: "teams", values: ["acme/live-dev"], negate: true }] });
  expect(await call("listFilterViews", null)).toEqual({ views: [
    { id: "v1", name: "Live Dev", filters: [{ field: "teams", values: ["acme/live-dev"], negate: true }] },
    { id: "v2", name: "Last 1 week updated", filters: [{ field: "updated", days: 7 }] },
  ] });
  await call("deleteFilterView", { id: "v1" });
  expect((await call("listFilterViews", null) as { views: Array<{ id: string }> }).views.map((v) => v.id)).toEqual(["v2"]);
  expect(channels().filter((channel) => channel === "filter-views")).toHaveLength(4);
});

test("a view without a name, with a field this version doesn't know, or with a malformed filter isn't saved", async () => {
  const { call } = await setup();
  for (const view of [
    { id: "v1", name: "  ", filters: [] },
    { id: "v1", name: "Mine", filters: [{ field: "nope", values: [] }] },
    { id: "v1", name: "Mine", filters: [{ field: "updated", days: 0 }] },
    { id: "v1", name: "Mine", filters: [{ field: "author", values: [1] }] },
  ]) await expect(call("saveFilterView", view)).rejects.toThrow();
  expect(await call("listFilterViews", null)).toEqual({ views: [] });
});

test("a view a newer version saved, with a field this one doesn't know, still lists, for the panel to leave that filter out", async () => {
  const { bb, call } = await setup();
  await testSql(bb).run(`INSERT INTO filter_views (id,name,filters,created_at) VALUES ('v1','Newer',?,1)`, [JSON.stringify([{ field: "milestone", values: ["Q4"] }])]);
  expect(await call("listFilterViews", null)).toEqual({ views: [{ id: "v1", name: "Newer", filters: [{ field: "milestone", values: ["Q4"] }] }] });
});
