import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, within } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { defaultPreferences } from "../lib/review-preferences";
import { docs } from "../lib/focus-templates/docs";
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
  expect(save.mock.calls[0][0].preferences.focuses).toMatchObject({ mergeEffort: "high", focuses: [{ label: "Docs 2", agent: null }] });
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
    fireEvent.click(slot.getByRole("button", { name: "Docs and comments" }));
    fireEvent.click(within(slot.getByRole("dialog", { name: "Edit focus" })).getByRole("button", { name: "Done" }));
  }
  expect((slot.getByRole("button", { name: "Add focus" }) as HTMLButtonElement).disabled).toBe(true);
  expect(slot.getByText("12 saved focuses maximum")).toBeTruthy();
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
