import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { defaultPreferences } from "../src/preferences";
import { ReviewSettings } from "./ReviewSettings";
import { FocusStrip } from "./shell/FocusStrip";
import type { FocusRun } from "../src/focus-model";

afterEach(cleanup);

test("Focuses is explicit-save opt-in, with a fixed General/Docs list and permission warning", async () => {
  const save = vi.fn(async (record: any) => ({ ...record, revision: 1 }));
  const slot = renderSlot({ component: ReviewSettings }, {}, { rpc: { getPreferences: () => ({ preferences: defaultPreferences, revision: 0 }), savePreferences: save, setReviewPresence: () => ({ ok: true }) } });
  const toggle = await slot.findByRole("checkbox", { name: "Review with focuses" }) as HTMLInputElement;
  expect(toggle.checked).toBe(false);
  expect(slot.getByText(/can still edit files/)).toBeTruthy();
  expect(slot.getByText("General")).toBeTruthy();
  expect(slot.getAllByText("Docs").some((element) => element.tagName === "STRONG")).toBe(true);
  expect(slot.queryByRole("button", { name: "Edit focus" })).toBeNull();
  const label = slot.getByRole("checkbox", { name: "Label comments on GitHub with their focus" }) as HTMLInputElement;
  expect(label.checked).toBe(true);
  expect(label.disabled).toBe(true);
  fireEvent.click(toggle);
  expect(label.disabled).toBe(false);
  fireEvent.click(label);
  fireEvent.click(toggle);
  expect(label.disabled).toBe(true);
  expect(label.checked).toBe(false);
  fireEvent.click(toggle);
  expect((slot.getByRole("checkbox", { name: "Label comments on GitHub with their focus" }) as HTMLInputElement).checked).toBe(false);
  expect(save).not.toHaveBeenCalled();
  fireEvent.click(slot.getByRole("button", { name: "Save settings" }));
  await slot.findByText("Settings saved");
  expect(save.mock.calls[0][0].preferences.focuses).toEqual({ ...defaultPreferences.focuses, enabled: true, githubLabel: false });
});
const run: FocusRun = { id: "run", head: "head", startedAt: 1, state: "finding", focuses: [{ focusId: "docs", label: "Docs", state: "running", queuedAt: 1 }] };

test("focus strip runs with Stop, hides Stop during dispatched merge, and shows one failure line", async () => {
  const stop = vi.fn(async () => ({ ok: true }));
  const render = (value: FocusRun) => renderSlot({ component: () => <FocusStrip targetKey="r" run={value} /> }, {}, { rpc: { stopFocusRun: stop } });
  let slot = render(run);
  expect(slot.getByRole("status").textContent).toContain("Reviewing with focuses");
  fireEvent.click(slot.getByRole("button", { name: "Stop" }));
  await vi.waitFor(() => expect(stop).toHaveBeenCalledWith({ targetKey: "r" }));
  slot.lifecycle.unmount();
  slot = render({ ...run, state: "merging", mergeDispatchedAt: 2 });
  expect(slot.queryByRole("button", { name: "Stop" })).toBeNull();
  slot.lifecycle.unmount();
  slot = render({ ...run, state: "done", focuses: [{ ...run.focuses[0], state: "failed", error: "didn't start" }] });
  expect(slot.getAllByRole("status")).toHaveLength(1);
  expect(slot.getByRole("status").textContent).toContain("Docs didn't finish: didn't start");
  slot.lifecycle.unmount();
  slot = render({ ...run, state: "done", focuses: [{ ...run.focuses[0], state: "done" }] });
  expect(slot.getByRole("status").textContent).toBe("");
});
