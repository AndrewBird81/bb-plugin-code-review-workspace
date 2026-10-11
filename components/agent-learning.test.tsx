import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { defaultPreferences } from "../src/preferences";

afterEach(cleanup);

const stats = {
  total: 12, kept: 7, edited: 3, removed: 2, canSuggest: true, suggestion: { state: "idle" },
  recentRemoved: [{ repo: "acme/web", file: "src/a.ts", line: "Nit: rename this.", at: 2 }, { repo: "acme/api", file: "b.ts", line: "Question: why?", at: 1 }],
};

async function settings(rpc: Record<string, unknown>) {
  await loadPluginApp(() => import("../app"));
  const { ReviewSettings } = await import("./ReviewSettings");
  let record = { preferences: { ...defaultPreferences, assistantInstructions: "Prioritize correctness." }, revision: 1 };
  const savePreferences = vi.fn(async (input: any) => record = { ...input, revision: input.revision + 1 });
  const slot = renderSlot({ component: ReviewSettings }, {}, { rpc: { setReviewPresence: () => ({ ok: true }), getPreferences: () => record, savePreferences, ...rpc } });
  return { slot, savePreferences, saved: () => record };
}

test("Settings shows how the agent's last comments fared, and the latest it lost", async () => {
  const { slot } = await settings({ getAgentLearning: () => stats });
  await slot.findByText("Of the agent’s last 12 comments you kept 7 as written, edited 3, removed 2.");
  expect(slot.getByText("acme/web · src/a.ts")).toBeTruthy();
  expect(slot.getByText("Nit: rename this.")).toBeTruthy();
  expect(slot.getByText("Question: why?")).toBeTruthy();
  slot.lifecycle.unmount();
});

test("with no submitted comments yet, Settings says what it will show, and there's nothing to suggest from", async () => {
  const { slot } = await settings({ getAgentLearning: () => ({ ...stats, total: 0, kept: 0, edited: 0, removed: 0, recentRemoved: [], canSuggest: false }) });
  await slot.findByText("When you submit reviews, this counts the agent’s comments you kept as written, edited, and removed.");
  expect((slot.getByRole("button", { name: "Suggest instruction changes" }) as HTMLButtonElement).disabled).toBe(true);
  slot.lifecycle.unmount();
});

test("a suggestion comes back to edit and add to the instructions, which change only when you save", async () => {
  let learning: any = stats;
  const suggest = vi.fn(() => { learning = { ...stats, suggestion: { state: "running", at: 5 } }; return { ok: true }; });
  const dismiss = vi.fn(() => ({ ok: true }));
  const { slot, savePreferences, saved } = await settings({ getAgentLearning: () => learning, suggestAssistantInstructions: suggest, dismissInstructionSuggestion: dismiss });
  fireEvent.click(await slot.findByRole("button", { name: "Suggest instruction changes" }));
  await slot.findByRole("button", { name: "Suggesting…" });
  expect(suggest).toHaveBeenCalledTimes(1);
  learning = { ...stats, suggestion: { state: "ready", at: 6, text: "Skip naming nits.\nAsk before flagging style." } };
  await slot.emitRealtime("learning", {});
  const proposal = await slot.findByRole("textbox", { name: "Suggested instructions" }) as HTMLTextAreaElement;
  expect(proposal.value).toBe("Skip naming nits.\nAsk before flagging style.");
  fireEvent.change(proposal, { target: { value: "Skip naming nits." } });
  fireEvent.click(slot.getByRole("button", { name: "Add to instructions" }));
  expect(slot.queryByRole("textbox", { name: "Suggested instructions" })).toBeNull();
  expect((slot.getByRole("textbox", { name: "Assistant instructions" }) as HTMLTextAreaElement).value).toBe("Prioritize correctness.\nSkip naming nits.");
  expect(dismiss).toHaveBeenCalledTimes(1);
  expect(savePreferences).not.toHaveBeenCalled();
  fireEvent.click(slot.getByRole("button", { name: "Save settings" }));
  await waitFor(() => expect(saved().preferences.assistantInstructions).toBe("Prioritize correctness.\nSkip naming nits."));
  slot.lifecycle.unmount();
});

test("a suggestion that fails, or finds nothing, says so", async () => {
  let learning: any = { ...stats, suggestion: { state: "running", at: 5 } };
  const { slot } = await settings({ getAgentLearning: () => learning, suggestAssistantInstructions: () => ({ ok: true }) });
  await slot.findByRole("button", { name: "Suggesting…" });
  learning = { ...stats, suggestion: { state: "failed", at: 6, error: "The agent couldn’t suggest changes. Try again." } };
  await slot.emitRealtime("learning", {});
  expect((await slot.findByText("The agent couldn’t suggest changes. Try again.")).getAttribute("role")).toBe("alert");
  learning = { ...stats, suggestion: { state: "running", at: 7 } };
  fireEvent.click(slot.getByRole("button", { name: "Suggest instruction changes" }));
  await slot.findByRole("button", { name: "Suggesting…" });
  learning = { ...stats, suggestion: { state: "ready", at: 8, text: "" } };
  await slot.emitRealtime("learning", {});
  await slot.findByText("The agent found nothing to add.");
  slot.lifecycle.unmount();
});

test("a proposal that finished while you were away opens with Settings, until you discard it", async () => {
  let learning: any = { ...stats, suggestion: { state: "ready", at: 6, text: "Old idea." } };
  const dismiss = vi.fn(() => { learning = stats; return { ok: true }; });
  const { slot } = await settings({ getAgentLearning: () => learning, dismissInstructionSuggestion: dismiss });
  expect((await slot.findByRole("textbox", { name: "Suggested instructions" }) as HTMLTextAreaElement).value).toBe("Old idea.");
  fireEvent.click(slot.getByRole("button", { name: "Discard" }));
  expect(slot.queryByRole("textbox", { name: "Suggested instructions" })).toBeNull();
  expect(dismiss).toHaveBeenCalledTimes(1);
  // A finished run that failed or found nothing isn't news on a later visit.
  learning = { ...stats, suggestion: { state: "failed", at: 7, error: "The agent couldn’t suggest changes. Try again." } };
  slot.lifecycle.unmount();
  const again = (await settings({ getAgentLearning: () => learning })).slot;
  await again.findByText("Of the agent’s last 12 comments you kept 7 as written, edited 3, removed 2.");
  expect(again.queryByText("The agent couldn’t suggest changes. Try again.")).toBeNull();
  again.lifecycle.unmount();
});
