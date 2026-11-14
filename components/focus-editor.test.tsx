import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, within } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { defaultPreferences } from "../lib/review-preferences";
import { docs } from "../lib/focus-templates/docs";
import { focusTemplates } from "../lib/focus-templates";
import { ReviewSettings } from "./ReviewSettings";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
async function settings(focuses = { ...defaultPreferences.focuses, enabled: true }) {
  const save = vi.fn(async (record: any) => ({ ...record, revision: 1 }));
  const slot = renderSlot({ component: ReviewSettings }, {}, { rpc: {
    getPreferences: () => ({ preferences: { ...defaultPreferences, focuses }, revision: 0 }), savePreferences: save,
    getAgentDefaults: () => ({ defaults: { providerId: "codex", model: "small", reasoningLevel: "medium", permissionMode: "full" } }),
    setReviewPresence: () => ({ ok: true }),
  } });
  await slot.findByRole("checkbox", { name: "Review with focuses" });
  return { slot, save };
}

test("edit stages, cancel discards, reset follows template, and Save settings alone persists", async () => {
  const { slot, save } = await settings();
  fireEvent.click(slot.getByRole("button", { name: "Edit Docs" }));
  let dialog = within(slot.getByRole("dialog", { name: "Edit focus" }));
  expect((dialog.getByRole("textbox", { name: "Instructions" }) as HTMLTextAreaElement).value).toBe(docs.instructions);
  fireEvent.change(dialog.getByRole("textbox", { name: "Name" }), { target: { value: "Changed" } });
  fireEvent.click(dialog.getByRole("button", { name: "Cancel" }));
  expect(slot.getByRole("button", { name: "Edit Docs" })).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: "Edit Docs" }));
  dialog = within(slot.getByRole("dialog", { name: "Edit focus" }));
  fireEvent.change(dialog.getByRole("textbox", { name: "Instructions" }), { target: { value: "My text" } });
  fireEvent.click(dialog.getByRole("button", { name: "Done" }));
  expect(save).not.toHaveBeenCalled();
  fireEvent.click(slot.getByRole("button", { name: "Edit Docs" }));
  dialog = within(slot.getByRole("dialog", { name: "Edit focus" }));
  expect(dialog.getByRole("link", { name: /Licenses/ }).getAttribute("href")).toContain("THIRD_PARTY_NOTICES.md");
  fireEvent.click(dialog.getByRole("button", { name: "Reset to template" }));
  fireEvent.change(dialog.getByRole("textbox", { name: "Name" }), { target: { value: "Docs 2" } });
  fireEvent.click(dialog.getByRole("button", { name: "Done" }));
  fireEvent.change(slot.getByRole("combobox", { name: "Check findings at" }), { target: { value: "high" } });
  fireEvent.click(slot.getByRole("button", { name: "Save settings" }));
  await slot.findByText("Settings saved");
  expect(save.mock.calls[0][0].preferences.focuses).toEqual({ ...defaultPreferences.focuses, enabled: true, mergeEffort: "high", focuses: defaultPreferences.focuses.focuses.map((focus) => focus.id === "docs" ? { ...focus, label: "Docs 2" } : focus) });
  expect(save.mock.calls[0][0].preferences.focuses.focuses[0]).not.toHaveProperty("instructions");
});

test("add blank or template, validate editor, remove, cap saved and hold Save above four enabled", async () => {
  const { slot } = await settings({ ...defaultPreferences.focuses, enabled: true, focuses: Array.from({ length: 4 }, (_, i) => ({ ...defaultPreferences.focuses.focuses[0], id: String(i), label: `Docs ${i}` })) });
  fireEvent.click(slot.getByRole("button", { name: "Add focus" }));
  fireEvent.click(slot.getByRole("button", { name: "Blank focus" }));
  let dialog = within(slot.getByRole("dialog", { name: "Edit focus" }));
  fireEvent.change(dialog.getByRole("textbox", { name: "Name" }), { target: { value: "Docs 0" } });
  expect((dialog.getByRole("button", { name: "Done" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(dialog.getByRole("textbox", { name: "Name" }), { target: { value: "[unsafe]" } });
  expect((dialog.getByRole("button", { name: "Done" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(dialog.getByRole("textbox", { name: "Name" }), { target: { value: "New" } });
  expect(dialog.getByRole("textbox", { name: "Instructions" }).getAttribute("maxlength")).toBe("8000");
  fireEvent.change(dialog.getByRole("textbox", { name: "Instructions" }), { target: { value: "Check for incorrect retry behavior." } });
  fireEvent.click(dialog.getByRole("button", { name: "Done" }));
  expect(slot.getByText("4 focuses can run at once")).toBeTruthy();
  expect(slot.getByRole("button", { name: "Save settings" }).getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(slot.getByRole("checkbox", { name: "Enable New" }));
  expect(slot.getByRole("button", { name: "Save settings" }).getAttribute("aria-disabled")).toBe("false");
  fireEvent.click(slot.getByRole("button", { name: "Edit New" }));
  dialog = within(slot.getByRole("dialog", { name: "Edit focus" }));
  fireEvent.click(dialog.getByRole("button", { name: "Remove focus" }));
  expect(slot.queryByRole("button", { name: "Edit New" })).toBeNull();
  for (let i = 4; i < 12; i++) {
    fireEvent.click(slot.getByRole("button", { name: "Add focus" }));
    fireEvent.click(slot.getByRole("button", { name: docs.label }));
    fireEvent.click(within(slot.getByRole("dialog", { name: "Edit focus" })).getByRole("button", { name: "Done" }));
  }
  expect((slot.getByRole("button", { name: "Add focus" }) as HTMLButtonElement).disabled).toBe(true);
  expect(slot.getByText("12 saved focuses maximum")).toBeTruthy();
});

test.each(["blank", "template"])("Done refuses empty or whitespace instructions for a %s focus", async (kind) => {
  const { slot, save } = await settings();
  if (kind === "blank") {
    fireEvent.click(slot.getByRole("button", { name: "Add focus" }));
    fireEvent.click(slot.getByRole("button", { name: "Blank focus" }));
  } else fireEvent.click(slot.getByRole("button", { name: "Edit Docs" }));
  const dialog = within(slot.getByRole("dialog", { name: "Edit focus" }));
  for (const instructions of ["", " \n\t "]) {
    fireEvent.change(dialog.getByRole("textbox", { name: "Instructions" }), { target: { value: instructions } });
    const done = dialog.getByRole("button", { name: "Done" }) as HTMLButtonElement;
    expect(done.disabled).toBe(true);
    fireEvent.click(done);
    expect(slot.getByRole("dialog", { name: "Edit focus" })).toBeTruthy();
  }
  fireEvent.change(dialog.getByRole("textbox", { name: "Instructions" }), { target: { value: "Check retry behavior." } });
  expect((dialog.getByRole("button", { name: "Done" }) as HTMLButtonElement).disabled).toBe(false);
  expect(save).not.toHaveBeenCalled();
});

test("typing the template text again drops the override on Done", async () => {
  const { slot, save } = await settings();
  fireEvent.click(slot.getByRole("button", { name: "Edit Docs" }));
  const dialog = within(slot.getByRole("dialog", { name: "Edit focus" }));
  fireEvent.change(dialog.getByRole("textbox", { name: "Instructions" }), { target: { value: "Edited" } });
  fireEvent.change(dialog.getByRole("textbox", { name: "Instructions" }), { target: { value: docs.instructions } });
  fireEvent.change(dialog.getByRole("textbox", { name: "Name" }), { target: { value: "Renamed" } });
  fireEvent.click(dialog.getByRole("button", { name: "Done" }));
  fireEvent.click(slot.getByRole("button", { name: "Save settings" }));
  await slot.findByText("Settings saved");
  expect(save.mock.calls[0][0].preferences.focuses.focuses[0]).not.toHaveProperty("instructions");
});

test.each(focusTemplates)("template $id choices, instructions and attribution use shipped metadata", async (template) => {
  const { slot } = await settings();
  fireEvent.click(slot.getByRole("button", { name: "Add focus" }));
  for (const choice of focusTemplates) expect(slot.getByRole("button", { name: choice.label })).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: template.label }));
  const dialog = within(slot.getByRole("dialog", { name: "Edit focus" }));
  expect(dialog.getByRole("link", { name: template.holder }).getAttribute("href")).toBe(template.source);
  expect(dialog.getByText(new RegExp(template.license))).toBeTruthy();
  expect((dialog.getByRole("textbox", { name: "Instructions" }) as HTMLTextAreaElement).value).toBe(template.instructions);
});

test("default list can save; only enabled focuses count toward the four-focus cap", async () => {
  const { slot, save } = await settings();
  for (const template of focusTemplates) expect((slot.getByRole("checkbox", { name: `Enable ${template.label}` }) as HTMLInputElement).checked).toBe(template.id === "docs");
  expect(slot.queryByText("4 focuses can run at once")).toBeNull();
  fireEvent.click(slot.getByRole("checkbox", { name: "Enable Bugs" }));
  fireEvent.click(slot.getByRole("button", { name: "Save settings" }));
  await slot.findByText("Settings saved");
  expect(save.mock.calls[0][0].preferences.focuses.focuses).toHaveLength(7);
});

test("focus override stages execution-only picker values, then null restores the review agent", async () => {
  const { slot, save } = await settings();
  fireEvent.click(slot.getByRole("button", { name: "Edit Docs" }));
  let dialog = within(slot.getByRole("dialog", { name: "Edit focus" }));
  fireEvent.click(dialog.getByRole("button", { name: "Custom" }));
  const picker = within(await dialog.findByTestId("bb-provider-model-picker"));
  fireEvent.change(picker.getByRole("textbox", { name: "Provider ID" }), { target: { value: "pi" } });
  fireEvent.change(picker.getByRole("textbox", { name: "Model" }), { target: { value: "local" } });
  fireEvent.change(picker.getByRole("textbox", { name: "Reasoning level" }), { target: { value: "high" } });
  fireEvent.click(picker.getByRole("button", { name: "Apply execution selection" }));
  fireEvent.click(dialog.getByRole("button", { name: "Done" }));
  fireEvent.click(slot.getByRole("button", { name: "Save settings" }));
  await slot.findByText("Settings saved");
  expect(save.mock.calls[0][0].preferences.focuses.focuses[0].agent).toEqual({ providerId: "pi", model: "local", reasoningLevel: "high" });
  fireEvent.click(slot.getByRole("button", { name: "Edit Docs" }));
  dialog = within(slot.getByRole("dialog", { name: "Edit focus" }));
  fireEvent.click(dialog.getByRole("button", { name: "The review agent’s" }));
  fireEvent.click(dialog.getByRole("button", { name: "Done" }));
  fireEvent.click(slot.getByRole("button", { name: "Save settings" }));
  await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  expect(save.mock.calls[1][0].preferences.focuses.focuses[0].agent).toBeNull();
});

test.each([390, 844])("%ipx template choices wrap with 44px targets", async (width) => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  const { slot } = await settings();
  fireEvent.click(slot.getByRole("button", { name: "Add focus" }));
  const choices = focusTemplates.map(({ label }) => slot.getByRole("button", { name: label }));
  expect(choices[0].parentElement?.className).toContain("flex-wrap");
  for (const choice of [...choices, slot.getByRole("button", { name: "Blank focus" })]) {
    expect(choice.className).toContain("min-h-11");
    expect(choice.className).toContain("whitespace-normal");
  }
});

test("390px editor is the existing drawer with 44px targets and no host or permission picker", async () => {
  vi.spyOn(window, "matchMedia").mockImplementation((query) => ({ matches: query.includes("max-width") || query.includes("pointer: coarse"), media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false }));
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
  const { slot } = await settings();
  fireEvent.click(slot.getByRole("button", { name: "Edit Docs" }));
  const element = await slot.findByRole("dialog", { name: "Edit focus" });
  expect(element.hasAttribute("data-persistent-drawer-content")).toBe(true);
  const dialog = within(element);
  for (const name of ["Cancel", "Done", "Remove focus", "Reset to template", "Custom", "The review agent’s"]) expect(dialog.getByRole("button", { name }).className).toContain("min-h-11");
  expect(dialog.queryByRole("combobox", { name: "Machine" })).toBeNull();
  expect(dialog.queryByRole("combobox", { name: /permission/i })).toBeNull();
});
