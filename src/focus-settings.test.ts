import { afterEach, expect, test } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { defaultPreferences, focusSettingsSchema, readFocusSettings } from "./preferences";
import { testStore } from "./test-store.test-support";
import { docs } from "../lib/focus-templates/docs";
import { focusInstructions } from "../lib/focus-templates";

const disposers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of disposers.splice(0)) await dispose(); });
const agent = { providerId: "custom", model: "small", reasoningLevel: "high", serviceTier: "fast" };
const focus = { id: "docs", label: "Docs", enabled: true, template: "docs", agent: null };
const settings = { ...defaultPreferences.focuses, mergeEffort: "high", focuses: [{ ...focus, agent, instructions: "My instructions" }] };

test("focus caps, unique ids and names, safe names, instruction cap and execution-only overrides", () => {
  const list = (n: number, enabled = false) => Array.from({ length: n }, (_, i) => ({ ...focus, id: String(i), label: `Focus ${i}`, enabled }));
  expect(focusSettingsSchema.safeParse({ ...settings, focuses: list(12) }).success).toBe(true);
  expect(focusSettingsSchema.safeParse({ ...settings, focuses: list(13) }).success).toBe(false);
  expect(focusSettingsSchema.safeParse({ ...settings, focuses: list(4, true) }).success).toBe(true);
  expect(focusSettingsSchema.safeParse({ ...settings, focuses: list(5, true) }).success).toBe(false);
  for (const label of ["", " ", "x".repeat(25), "Do\ncs", "[Docs]", "**Docs**", "@Docs"]) {
    expect(focusSettingsSchema.safeParse({ ...settings, focuses: [{ ...focus, label }] }).success).toBe(false);
  }
  expect(focusSettingsSchema.parse({ ...settings, focuses: [{ ...focus, label: " 文档 2._- " }] }).focuses[0].label).toBe("文档 2._-");
  for (const duplicate of [{ ...focus, id: "other", label: "docs" }, { ...focus, label: "Other" }]) expect(focusSettingsSchema.safeParse({ ...settings, focuses: [focus, duplicate] }).success).toBe(false);
  expect(focusSettingsSchema.safeParse({ ...settings, focuses: [{ ...focus, instructions: "x".repeat(8000) }] }).success).toBe(true);
  expect(focusSettingsSchema.safeParse({ ...settings, focuses: [{ ...focus, instructions: "x".repeat(8001) }] }).success).toBe(false);
  for (const extra of [{ permissionMode: "full" }, { hostId: "remote" }]) expect(focusSettingsSchema.safeParse({ ...settings, focuses: [{ ...focus, agent: { ...agent, ...extra } }] }).success).toBe(false);
});

test("bad fields default independently, including inside a focus; old records gain defaults", () => {
  expect(readFocusSettings({ ...settings, mergeEffort: "bad", githubLabel: "bad", focuses: [{ ...focus, instructions: 2, agent: { providerId: "incomplete" } }] })).toEqual({ ...defaultPreferences.focuses, focuses: [focus] });
  expect(readFocusSettings({ ...settings, enabled: "bad" })).toEqual({ ...settings, enabled: false });
  expect(readFocusSettings({ enabled: true, focuses: [{ id: "docs", label: "Docs", enabled: true, template: "docs" }] })).toEqual({ ...defaultPreferences.focuses, enabled: true });
});

test("pre-Phase-4 saves keep new fields by focus id, allow old fields to change, and refuse stale revision", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace" });
  disposers.push(() => harness.lifecycle.dispose());
  await plugin(bb);
  const saved = await harness.behavior.callRpc("savePreferences", { preferences: { ...defaultPreferences, focuses: settings }, revision: 0 }) as any;
  const oldFocuses = { enabled: false, githubLabel: false, focuses: [{ id: "docs", label: "Renamed", enabled: false, template: "docs" }] };
  const result = await harness.behavior.callRpc("savePreferences", { preferences: { ...defaultPreferences, focuses: oldFocuses }, revision: saved.revision }) as any;
  expect(result.preferences.focuses).toEqual({ ...settings, ...oldFocuses, mergeEffort: "high", focuses: [{ ...settings.focuses[0], label: "Renamed", enabled: false }] });
  expect((await testStore(bb).getPreferences()).preferences.focuses).toEqual(result.preferences.focuses);
  await expect(harness.behavior.callRpc("savePreferences", { preferences: { ...defaultPreferences, focuses: settings }, revision: saved.revision })).rejects.toThrow(/changed/);
  const cleared = { ...settings, focuses: [{ ...focus, agent: null }] };
  const next = await harness.behavior.callRpc("savePreferences", { preferences: { ...defaultPreferences, focuses: cleared }, revision: result.revision }) as any;
  expect(next.preferences.focuses).toEqual(cleared);
});

test("unedited templates follow shipped updates, edited text stays, and reset follows again", () => {
  const shipped = docs as { instructions: string };
  const old = shipped.instructions;
  try {
    expect(focusInstructions(focus)).toBe(old);
    shipped.instructions = "Updated shipped instructions";
    expect(focusInstructions(focus)).toBe(docs.instructions);
    expect(focusInstructions({ ...focus, instructions: old })).toBe(old);
    expect(focusInstructions({ ...focus, instructions: "" })).toBe("");
    expect(focusInstructions({ ...focus, template: undefined })).toBe("");
  } finally { shipped.instructions = old; }
});
