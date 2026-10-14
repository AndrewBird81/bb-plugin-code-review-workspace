// Settings knobs reach the panel's views through SettingsProvider, and every view still renders with each one off.
import { useEffect, useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { defaultPreferences } from "../lib/review-preferences";
import { defaultKnobs } from "../lib/knobs";
import { allKnobsOff, desktopWindow, renderInbox, renderReview } from "./settings-off.test-support";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() }, Toaster: () => null }));
vi.mock("@pierre/diffs/react", () => ({ FileDiff: () => <div data-testid="filediff" /> }));

const restores: (() => void)[] = [];
afterEach(() => { cleanup(); localStorage.clear(); sessionStorage.clear(); restores.splice(0).forEach((restore) => restore()); });

/** A view under SettingsProvider that shows one knob, and what the first load settled with. */
async function renderProbe(getPreferences: () => unknown) {
  await loadPluginApp(() => import("../app"));
  const { SettingsProvider, useKnob, useSettings } = await import("../lib/settings");
  function Probe() {
    const codeOwners = useKnob("codeOwners");
    const { settled } = useSettings();
    const [first, setFirst] = useState("waiting");
    useEffect(() => { void settled.then((preferences) => setFirst(String(preferences.knobs.codeOwners))); }, [settled]);
    return <><p>Code owners {String(codeOwners)}</p><p>Settled {first}</p></>;
  }
  return renderSlot({ component: () => <SettingsProvider><Probe /></SettingsProvider> }, {}, { rpc: { getPreferences } as any });
}
const off = { preferences: { ...defaultPreferences, knobs: { ...defaultKnobs, codeOwners: false } }, revision: 1 };
const on = { preferences: { ...defaultPreferences, knobs: { ...defaultKnobs } }, revision: 2 };

test("settings load once the provider mounts, and again on each realtime preferences event", async () => {
  let record = off;
  const slot = await renderProbe(() => record);
  await slot.findByText("Code owners false");
  await slot.findByText("Settled false");
  record = on;
  await slot.emitRealtime("preferences", {});
  await slot.findByText("Code owners true");
  // settled holds the first load.
  expect(slot.getByText("Settled false")).toBeTruthy();
  slot.lifecycle.unmount();
});

test("a reload that lands after a newer one is dropped", async () => {
  const pending: ((record: unknown) => void)[] = [];
  const slot = await renderProbe(() => new Promise((resolve) => pending.push(resolve)));
  await waitFor(() => expect(pending).toHaveLength(1));
  await slot.emitRealtime("preferences", {});
  await waitFor(() => expect(pending).toHaveLength(2));
  pending[1]!(off);
  await slot.findByText("Code owners false");
  pending[0]!(on);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(slot.getByText("Code owners false")).toBeTruthy();
  slot.lifecycle.unmount();
});

test("settings that won't load read as defaults, a failed reload keeps the last good ones, and missing knobs read at their defaults", async () => {
  let fail = true;
  let record: unknown = off;
  const slot = await renderProbe(() => { if (fail) throw new Error("Offline"); return record; });
  await slot.findByText("Settled true");
  expect(slot.getByText("Code owners true")).toBeTruthy();
  fail = false;
  await slot.emitRealtime("preferences", {});
  await slot.findByText("Code owners false");
  fail = true;
  await slot.emitRealtime("preferences", {});
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(slot.getByText("Code owners false")).toBeTruthy();
  // An older server sends no knobs.
  fail = false;
  const { knobs: _none, ...older } = defaultPreferences;
  record = { preferences: older, revision: 3 };
  await slot.emitRealtime("preferences", {});
  await slot.findByText("Code owners true");
  slot.lifecycle.unmount();
});

test("a review opens, with default settings, when its settings won't load", async () => {
  const { page } = await renderReview(defaultKnobs, { getPreferences: () => { throw new Error("Offline"); } });
  await page.findByRole("heading", { name: "Parse rows" });
  // The workspace's load and the provider's.
  expect(page.inspection.rpcCalls.filter((call) => call.method === "getPreferences").length).toBeGreaterThanOrEqual(2);
  page.lifecycle.unmount();
});

test("with every knob off, the Overview, a chapter, Comments, Finish review, the title bar and All reviews still render", async () => {
  restores.push(desktopWindow());
  const { page, bar, main } = await renderReview(allKnobsOff);
  await page.findByRole("heading", { name: "Parse rows" });
  const commands = within(await bar.findByRole("group", { name: "Review commands" }));
  fireEvent.click(await main().findByRole("button", { name: "Start reading: Parsing" }));
  await page.findAllByTestId("filediff");
  fireEvent.click(commands.getByRole("button", { name: "Comments" }));
  const panel = within(await page.findByRole("complementary", { name: "Comments and agent" }));
  await panel.findByText("Upper case reads as a constant.");
  fireEvent.click(await commands.findByRole("button", { name: /^Submit review/ }));
  await page.findByRole("heading", { name: "Finish review" });
  page.lifecycle.unmount(); bar.lifecycle.unmount();
  const inbox = await renderInbox(allKnobsOff);
  expect(inbox.getByText("Parse rows")).toBeTruthy();
  inbox.lifecycle.unmount();
});
