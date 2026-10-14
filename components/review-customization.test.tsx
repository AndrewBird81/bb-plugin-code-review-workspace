import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { defaultPreferences } from "../src/preferences";
import type { DraftProviderProps } from "./DraftProvider";

afterEach(() => { cleanup(); localStorage.clear(); });
// jsdom can't run pierre's diff element; the workspace's tests here are about its panel.
vi.mock("@pierre/diffs/react", () => ({ FileDiff: () => null }));

/** The draft's provider with Comments and Finish review after what it wraps, as the side panel shows them. */
async function draftTray() {
  const { DraftTray } = await import("./draft-tray.test-support");
  return DraftTray;
}

test("settings have an installed slot, save explicitly, and restore defaults without silently saving", async () => {
  const app = await loadPluginApp(() => import("../app"));
  expect(app.settingsSections).toHaveLength(1);
  const { ReviewSettings } = await import("./ReviewSettings");
  let record = { preferences: { ...defaultPreferences }, revision: 0 };
  const save = vi.fn(async (input: any) => record = { ...input, revision: input.revision + 1 });
  const slot = renderSlot({ component: ReviewSettings }, {}, { rpc: { setReviewPresence: () => ({ ok: true }), getPreferences: () => record, savePreferences: save } });
  await slot.findByRole("textbox", { name: "Guide instructions" });
  fireEvent.change(slot.getByRole("textbox", { name: "Guide instructions" }), { target: { value: "Explain compatibility" } });
  fireEvent.click(slot.getByRole("button", { name: /^Detailed$/ }));
  expect(save).not.toHaveBeenCalled();
  fireEvent.click(slot.getByRole("button", { name: "Save settings" }));
  await slot.findByText("Settings saved");
  expect(record.preferences).toMatchObject({ guideInstructions: "Explain compatibility", guideDetail: "detailed" });
  fireEvent.click(slot.getByRole("button", { name: "Restore defaults" }));
  expect(save).toHaveBeenCalledTimes(1);
  fireEvent.click(slot.getByRole("button", { name: "Save settings" }));
  await waitFor(() => expect(record.preferences).toEqual(defaultPreferences));
  slot.lifecycle.unmount();
});

test("Restore defaults keeps the diff layout, which the review sets, not Settings", async () => {
  const { ReviewSettings } = await import("./ReviewSettings");
  let record = { preferences: { ...defaultPreferences, diffLayout: "unified" }, revision: 0 };
  const save = vi.fn(async (input: any) => record = { ...input, revision: input.revision + 1 });
  const slot = renderSlot({ component: ReviewSettings }, {}, { rpc: { setReviewPresence: () => ({ ok: true }), getPreferences: () => record, savePreferences: save } });
  await slot.findByRole("textbox", { name: "Guide instructions" });
  // What the page shows is already at its defaults.
  fireEvent.click(slot.getByRole("button", { name: "Restore defaults" }));
  expect(slot.queryByText("Unsaved changes")).toBeNull();
  fireEvent.click(slot.getByRole("button", { name: /^Detailed$/ }));
  fireEvent.click(slot.getByRole("button", { name: "Save settings" }));
  await slot.findByText("Settings saved");
  fireEvent.click(slot.getByRole("button", { name: "Restore defaults" }));
  fireEvent.click(slot.getByRole("button", { name: "Save settings" }));
  await waitFor(() => expect(record.preferences).toEqual({ ...defaultPreferences, diffLayout: "unified" }));
  slot.lifecycle.unmount();
});

test("what a re-review shows starts on Changes since your review, saves All changes, and Restore defaults goes back", async () => {
  const { ReviewSettings } = await import("./ReviewSettings");
  let record = { preferences: { ...defaultPreferences }, revision: 0 };
  const save = vi.fn(async (input: any) => record = { ...input, revision: input.revision + 1 });
  const slot = renderSlot({ component: ReviewSettings }, {}, { rpc: { setReviewPresence: () => ({ ok: true }), getPreferences: () => record, savePreferences: save } });
  const choices = within(await slot.findByRole("group", { name: "On a re-review, show" }));
  const pressed = () => choices.getAllByRole("button").filter((button) => button.getAttribute("aria-pressed") === "true").map((button) => button.textContent);
  expect(pressed()).toEqual(["Changes since your review"]);
  fireEvent.click(choices.getByRole("button", { name: "All changes" }));
  fireEvent.click(slot.getByRole("button", { name: "Save settings" }));
  await slot.findByText("Settings saved");
  expect(record.preferences.rereviewShows).toBe("all");
  fireEvent.click(slot.getByRole("button", { name: "Restore defaults" }));
  expect(pressed()).toEqual(["Changes since your review"]);
  slot.lifecycle.unmount();
});

test("Settings goes back to where it was opened from, All reviews or the review, once edits are saved or discarded", async () => {
  const app = await loadPluginApp(() => import("../app"));
  const rpc = { setReviewPresence: () => ({ ok: true }), getPreferences: () => ({ preferences: { ...defaultPreferences }, revision: 0 }), getGhAccounts: () => ({ active: "me", accounts: [] }) } as any;
  let slot = renderSlot(app.navPanels[0]!, { subPath: "settings" }, { rpc });
  const back = await slot.findByRole("button", { name: "All reviews" });
  expect(slot.getByRole("heading", { level: 1 }).textContent).toBe("Settings");
  // The diff's layout is in the review's Diff options, not here.
  await slot.findByRole("textbox", { name: "Guide instructions" });
  expect(slot.queryByRole("group", { name: "Default diff layout" })).toBeNull();
  expect(slot.queryByText("Reading layout")).toBeNull();
  fireEvent.click(slot.getByRole("button", { name: /^Detailed$/ }));
  expect(back.hasAttribute("disabled")).toBe(true);
  fireEvent.click(slot.getByRole("button", { name: "Discard edits" }));
  fireEvent.click(back);
  expect(slot.inspection.navigateCalls).toEqual([{ method: "toPluginPanel", path: "review", options: { subPath: "" } }]);
  slot.lifecycle.unmount();
  slot = renderSlot(app.navPanels[0]!, { subPath: "settings/pr-42" }, { rpc });
  fireEvent.click(await slot.findByRole("button", { name: "Back to review" }));
  expect(slot.inspection.navigateCalls).toEqual([{ method: "toPluginPanel", path: "review", options: { subPath: "pr-42" } }]);
  slot.lifecycle.unmount();
});

test("in BB's Settings, Settings has no page bar of its own; its setup offers to switch the GitHub account where it's shown", async () => {
  const app = await loadPluginApp(() => import("../app"));
  const slot = renderSlot(app.settingsSections[0]!, {}, { rpc: { setReviewPresence: () => ({ ok: true }), getPreferences: () => ({ preferences: { ...defaultPreferences }, revision: 0 }),
    getGhAccounts: () => ({ active: "me", accounts: [] }), getSetupStatus: () => ({ account: "me", githubCli: true, agentAvailable: true, projectAvailable: true }) } as any });
  const setup = await slot.findByRole("region", { name: "Setup" });
  const row = (await within(setup).findByText("@me")).closest("li")!;
  expect(within(row).getByRole("button", { name: "GitHub account: @me" })).toBeTruthy();
  expect(slot.queryByRole("navigation", { name: "Breadcrumb" })).toBeNull();
  slot.lifecycle.unmount();
});

test("private notes survive leaving the editor and never use the public summary RPC", async () => {
  await loadPluginApp(() => import("../app"));
  const { ReviewerNotes } = await import("./ReviewerNotes");
  let stored = { body: "", revision: 0 };
  const save = vi.fn(async ({ body, revision }: any) => stored = { body, revision: revision + 1 });
  const setVerdict = vi.fn();
  const slot = renderSlot({ component: ReviewerNotes }, { targetKey: "private-notes" }, { rpc: { getReviewerNotes: () => stored, saveReviewerNotes: save, setVerdict } });
  await slot.findByText("Notes saved");
  fireEvent.change(slot.getByRole("textbox", { name: "Private notes" }), { target: { value: "Check rollout with my team" } });
  slot.lifecycle.unmount();
  await waitFor(() => expect(stored.body).toBe("Check rollout with my team"));
  expect(setVerdict).not.toHaveBeenCalled();
});

test("failed note writes preserve a recoverable copy after remount", async () => {
  await loadPluginApp(() => import("../app"));
  const { ReviewerNotes } = await import("./ReviewerNotes");
  const rpc = { getReviewerNotes: () => ({ body: "", revision: 0 }), saveReviewerNotes: vi.fn(async () => { throw new Error("Offline"); }) };
  let slot = renderSlot({ component: ReviewerNotes }, { targetKey: "recover-notes" }, { rpc });
  await slot.findByText("Notes saved");
  fireEvent.change(slot.getByRole("textbox", { name: "Private notes" }), { target: { value: "Do not lose this" } });
  fireEvent.blur(slot.getByRole("textbox", { name: "Private notes" }));
  await slot.findByRole("alert");
  slot.lifecycle.unmount();
  await waitFor(() => expect(rpc.saveReviewerNotes).toHaveBeenCalledTimes(2));
  slot = renderSlot({ component: ReviewerNotes }, { targetKey: "recover-notes" }, { rpc });
  await slot.findByText("Recovered unsaved notes. Save when ready.");
  expect((slot.getByRole("textbox", { name: "Private notes" }) as HTMLTextAreaElement).value).toBe("Do not lose this");
  slot.lifecycle.unmount();
});

test("editing a draft comment replaces it without changing its location", async () => {
  await loadPluginApp(() => import("../app"));
  const DraftTray = await draftTray();
  const comment = { file: "a.ts", line: 1, side: "RIGHT", body: "Old feedback", chapterId: "original" };
  const draft = { targetKey: "edit", verdict: "COMMENT", body: "", comments: [comment] };
  const save = vi.fn(async ({ comment }: any) => ({ draft: { ...draft, comments: [comment] } }));
  const slot = renderSlot({ component: (props: any) => <DraftTray {...props} /> }, { targetKey: "edit", activeChapterId: "other", activeFiles: ["b.ts"] }, { rpc: { getDraft: () => ({ draft }), getReviewerNotes: () => ({ body: "", revision: 0 }), saveDraftComment: save } });
  fireEvent.click(await slot.findByRole("button", { name: "Expand Draft comment on a.ts:1" }));
  fireEvent.click(slot.getByRole("button", { name: "Edit comment on a.ts:1" }));
  // Its box has no place to change: the comment stays where it is.
  expect(slot.queryByRole("combobox", { name: "Comment file" })).toBeNull();
  fireEvent.change(slot.getByRole("textbox", { name: "Draft comment" }), { target: { value: "Clearer feedback" } });
  fireEvent.click(slot.getByRole("button", { name: "Save comment" }));
  await slot.findByText("Clearer feedback");
  expect(save).toHaveBeenCalledWith({ targetKey: "edit", comment: { ...comment, body: "Clearer feedback" } });
  slot.lifecycle.unmount();
});

test("comparing conflicting notes preserves edits made while the saved version loads", async () => {
  await loadPluginApp(() => import("../app"));
  const { ReviewerNotes } = await import("./ReviewerNotes");
  let complete!: (notes: { body: string; revision: number }) => void;
  const get = vi.fn().mockResolvedValueOnce({ body: "Original", revision: 1 }).mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
  const save = vi.fn().mockRejectedValueOnce(new Error("Notes changed in another window")).mockResolvedValue({ body: "My newer edits", revision: 3 });
  const slot = renderSlot({ component: ReviewerNotes }, { targetKey: "conflict-notes" }, { rpc: { getReviewerNotes: get, saveReviewerNotes: save } });
  await slot.findByText("Notes saved");
  const editor = slot.getByRole("textbox", { name: "Private notes" }) as HTMLTextAreaElement;
  fireEvent.change(editor, { target: { value: "My edits" } }); fireEvent.blur(editor);
  fireEvent.click(await slot.findByRole("button", { name: "Compare saved notes" }));
  await waitFor(() => expect(complete).toBeTypeOf("function"));
  fireEvent.change(editor, { target: { value: "My newer edits" } });
  complete({ body: "Other window", revision: 2 });
  await slot.findByRole("textbox", { name: "Saved private notes" });
  expect(editor.value).toBe("My newer edits");
  fireEvent.click(slot.getByRole("button", { name: "Save my version" }));
  await waitFor(() => expect(save).toHaveBeenLastCalledWith({ targetKey: "conflict-notes", body: "My newer edits", revision: 2 }));
  slot.lifecycle.unmount();
});

/** A review open in its workspace, on its chapter, with the panel's views to switch between. */
async function renderReview(targetKey: string, notes = "") {
  const { patchReviewState } = await import("../lib/panel-state");
  patchReviewState(targetKey, { activeId: "c1" });
  const app = await loadPluginApp(() => import("../app"));
  const slot = renderSlot(app.navPanels[0]!, { subPath: targetKey }, { rpc: {
    setReviewPresence: () => ({ ok: true }),
    getReviewBundle: () => ({ review: { targetKey, kind: "pr", status: "ready", createdAt: 1, title: "Keep state", headSha: "h" }, guide: { title: "Guide", intent: "Keeps state.", unplacedFiles: [], sections: [{ id: "c1", title: "State", overview: "", diffs: [{ file: "a.ts" }] }] }, patch: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n", revision: "r1" }),
    getChecks: () => ({ bucket: "none", checks: [] }),
    getPreferences: () => ({ preferences: defaultPreferences, revision: 0 }),
    getFileViews: () => ({ views: [] }),
    checkRepoAccess: () => ({ accessible: true, repo: "acme/web", account: "me" }),
    checkForUpdates: () => ({ hasNewCommits: false }),
    getDraft: () => ({ draft: { targetKey, verdict: "COMMENT", body: "", comments: [] } }),
    getReviewerNotes: () => ({ body: notes, revision: 0 }), saveReviewerNotes: ({ body }: any) => ({ body, revision: 1 }),
    getConversation: () => ({ threadId: null, legacy: [], defaults: null }),
    markSeen: () => ({ ok: true }),
  } as any });
  // The commands sit in the band, where BB's title bar didn't take them.
  await slot.findByRole("button", { name: "Comments" });
  const panel = () => within(slot.getByRole("complementary", { name: "Comments and agent" }));
  const close = () => fireEvent.click(panel().getByRole("button", { name: "Close panel" }));
  return { slot, panel, close };
}

test("the side panel's views keep what you were writing as it closes and switches", async () => {
  // Notes from before notes were retired: Finish review keeps them.
  const { slot, panel, close } = await renderReview("panel-editors", "Earlier notes");
  fireEvent.click(slot.getByRole("button", { name: "Comments" }));
  fireEvent.click(await panel().findByRole("button", { name: "Comment options" }));
  fireEvent.click(await slot.findByRole("button", { name: "Add comment by line…" }));
  fireEvent.change(panel().getByRole("textbox", { name: "Draft comment" }), { target: { value: "Keep this unfinished comment" } });
  close();
  expect(slot.queryByRole("textbox", { name: "Draft comment" })).toBeNull();
  fireEvent.click(slot.getByRole("button", { name: "Ask agent" }));
  fireEvent.change(await panel().findByRole("textbox", { name: "Ask the agent" }), { target: { value: "Keep this question" } });
  fireEvent.click(slot.getByRole("button", { name: /^Submit review/ }));
  expect(slot.queryByRole("textbox", { name: "Ask the agent" })).toBeNull();
  fireEvent.click(await panel().findByText("Private notes"));
  fireEvent.change(await panel().findByRole("textbox", { name: "Private notes" }), { target: { value: "Keep my notes" } });
  close();
  fireEvent.click(slot.getByRole("button", { name: "Ask agent" }));
  expect((panel().getByRole("textbox", { name: "Ask the agent" }) as HTMLTextAreaElement).value).toBe("Keep this question");
  fireEvent.click(slot.getByRole("button", { name: /^Submit review/ }));
  expect((panel().getByRole("textbox", { name: "Private notes" }) as HTMLTextAreaElement).value).toBe("Keep my notes");
  fireEvent.click(panel().getByRole("button", { name: "Comments" }));
  expect((panel().getByRole("textbox", { name: "Draft comment" }) as HTMLTextAreaElement).value).toBe("Keep this unfinished comment");
  slot.lifecycle.unmount();
});

test("a review opens with its panel as you left it: closed stays closed, and an open view opens again where it docks", async () => {
  let { slot, close } = await renderReview("panel-restore");
  fireEvent.click(slot.getByRole("button", { name: "Comments" }));
  close();
  slot.lifecycle.unmount();
  ({ slot } = await renderReview("panel-restore"));
  expect(slot.queryByRole("complementary", { name: "Comments and agent" })).toBeNull();
  fireEvent.click(slot.getByRole("button", { name: "Ask agent" }));
  slot.lifecycle.unmount();
  ({ slot } = await renderReview("panel-restore"));
  expect(slot.getByRole("button", { name: "Ask agent" }).getAttribute("aria-pressed")).toBe("true");
  expect(within(slot.getByRole("complementary", { name: "Comments and agent" })).getByRole("region", { name: "Review agent" })).toBeTruthy();
  slot.lifecycle.unmount();
});

test("a new line-comment request reveals an unfinished comment without replacing it", async () => {
  await loadPluginApp(() => import("../app"));
  const DraftTray = await draftTray();
  const onOpenPanel = vi.fn();
  function Workspace() {
    const [nonce, setNonce] = useState(0);
    return <><button onClick={() => setNonce((value) => value + 1)}>Comment on selected line</button><DraftTray targetKey="unfinished-comment" activeChapterId="c1" activeFiles={["a.ts"]} onOpenPanel={onOpenPanel} prefill={nonce ? { file: "b.ts", line: 7, side: "RIGHT", nonce } : undefined} /></>;
  }
  const slot = renderSlot({ component: Workspace }, {}, { rpc: {
    getDraft: () => ({ draft: { targetKey: "unfinished-comment", verdict: "COMMENT", body: "", comments: [] } }), getReviewerNotes: () => ({ body: "", revision: 0 }),
  } });
  fireEvent.click(await slot.findByRole("button", { name: "Comment options" }));
  fireEvent.click(await slot.findByRole("button", { name: "Add comment by line…" }));
  fireEvent.change(slot.getByRole("textbox", { name: "Draft comment" }), { target: { value: "Keep this unfinished comment" } });
  onOpenPanel.mockClear();
  fireEvent.click(slot.getByRole("button", { name: "Comment on selected line" }));
  // The panel shows the comment it holds.
  expect(onOpenPanel).toHaveBeenCalledWith("comments");
  const editor = await slot.findByRole("textbox", { name: "Draft comment" }) as HTMLTextAreaElement;
  expect(editor.value).toBe("Keep this unfinished comment");
  expect((slot.getByRole("combobox", { name: "Comment file" }) as HTMLSelectElement).value).toBe("a.ts");
  await waitFor(() => expect(document.activeElement).toBe(editor));
  slot.lifecycle.unmount();
});

test("each agent uses project defaults until customized with bb's pickers", async () => {
  await loadPluginApp(() => import("../app"));
  const { ReviewSettings } = await import("./ReviewSettings");
  let record = { preferences: { ...defaultPreferences }, revision: 0 };
  const save = vi.fn(async (input: any) => record = { ...input, revision: input.revision + 1 });
  const defaults = { providerId: "codex", model: "gpt-6-astra", reasoningLevel: "low", permissionMode: "auto", serviceTier: "default" };
  const getAgentDefaults = vi.fn().mockResolvedValueOnce({ defaults, guideWriterMode: "accept-edits" }).mockRejectedValueOnce(new Error("Offline"));
  const slot = renderSlot({ component: ReviewSettings }, {}, { rpc: { setReviewPresence: () => ({ ok: true }), getPreferences: () => record, savePreferences: save, getAgentDefaults } });
  const guide = await slot.findByRole("group", { name: "Guide writer agent" });
  const assistant = slot.getByRole("group", { name: "Review assistant agent" });
  expect(within(guide).getByRole("button", { name: "Project defaults" }).getAttribute("aria-pressed")).toBe("true");
  expect(slot.queryByTestId("bb-provider-model-picker")).toBeNull();
  // The guide writer's defaults don't take the project's permissions; the assistant's do.
  expect(guide.parentElement!.textContent).toContain("at the lowest permissions that agent runs in");
  expect(assistant.parentElement!.textContent).toContain("effort, and permissions bb remembers");

  // Custom starts from the personal project's defaults, the guide writer at the lowest mode its provider runs in.
  fireEvent.click(within(guide).getByRole("button", { name: "Custom" }));
  const picker = await slot.findByTestId("bb-provider-model-picker");
  expect((within(picker).getByRole("textbox", { name: "Model" }) as HTMLInputElement).value).toBe("gpt-6-astra");
  expect((slot.getByRole("combobox", { name: "Permission mode" }) as HTMLSelectElement).value).toBe("accept-edits");
  fireEvent.change(within(picker).getByRole("textbox", { name: "Model" }), { target: { value: "gpt-6" } });
  fireEvent.change(within(picker).getByRole("textbox", { name: "Reasoning level" }), { target: { value: "high" } });
  fireEvent.change(within(picker).getByRole("combobox", { name: "Service tier" }), { target: { value: "fast" } });
  fireEvent.click(within(picker).getByRole("button", { name: "Apply execution selection" }));
  fireEvent.change(slot.getByRole("combobox", { name: "Permission mode" }), { target: { value: "full" } });

  // Without defaults, saving waits until the pickers resolve a provider and model.
  fireEvent.click(within(assistant).getByRole("button", { name: "Custom" }));
  await waitFor(() => expect(slot.getAllByTestId("bb-provider-model-picker")).toHaveLength(2));
  expect((slot.getByRole("button", { name: "Save settings" }) as HTMLButtonElement).disabled).toBe(true);
  const second = slot.getAllByTestId("bb-provider-model-picker")[1];
  fireEvent.change(within(second).getByRole("textbox", { name: "Provider ID" }), { target: { value: "pi" } });
  fireEvent.change(within(second).getByRole("textbox", { name: "Model" }), { target: { value: "local" } });
  fireEvent.click(within(second).getByRole("button", { name: "Apply execution selection" }));
  fireEvent.click(slot.getByRole("button", { name: "Save settings" }));
  // The settings page is long; under a full parallel run it can take more than the default second.
  await slot.findByText("Settings saved", {}, { timeout: 5000 });
  expect(record.preferences.guideAgent).toEqual({ providerId: "codex", model: "gpt-6", reasoningLevel: "high", permissionMode: "full", serviceTier: "fast" });
  expect(record.preferences.assistantAgent).toEqual({ providerId: "pi", model: "local", reasoningLevel: "medium", permissionMode: "auto" });

  fireEvent.click(within(guide).getByRole("button", { name: "Project defaults" }));
  expect(slot.getAllByTestId("bb-provider-model-picker")).toHaveLength(1);
  fireEvent.click(slot.getByRole("button", { name: "Save settings" }));
  await waitFor(() => expect(record.preferences.guideAgent).toBeNull());
  slot.lifecycle.unmount();
});

test("a custom guide writer starts at auto when its provider has no accept-edits, else at the project's mode", async () => {
  await loadPluginApp(() => import("../app"));
  const { ReviewSettings } = await import("./ReviewSettings");
  const record = { preferences: { ...defaultPreferences }, revision: 0 };
  const defaults = { providerId: "other", model: "m", reasoningLevel: "low", permissionMode: "full" };
  const getAgentDefaults = vi.fn().mockResolvedValueOnce({ defaults, guideWriterMode: "auto" }).mockResolvedValueOnce({ defaults });
  const slot = renderSlot({ component: ReviewSettings }, {}, { rpc: { setReviewPresence: () => ({ ok: true }), getPreferences: () => record, getAgentDefaults } });
  const guide = await slot.findByRole("group", { name: "Guide writer agent" });
  const mode = () => (slot.getByRole("combobox", { name: "Permission mode" }) as HTMLSelectElement).value;
  fireEvent.click(within(guide).getByRole("button", { name: "Custom" }));
  await waitFor(() => expect(mode()).toBe("auto"));
  fireEvent.click(within(guide).getByRole("button", { name: "Project defaults" }));
  fireEvent.click(within(guide).getByRole("button", { name: "Custom" }));
  await waitFor(() => expect(getAgentDefaults).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(mode()).toBe("full"));
  slot.lifecycle.unmount();
});

const listMachines = () => ({ machines: [
  { hostId: "host_server", name: "bb-server-0", connected: true, server: true },
  { hostId: "host_flomac", name: "FloMac", connected: true, server: false },
  { hostId: "host_old", name: "FloMac Original", connected: false, server: false },
] });

test("a custom agent can run on another machine, with bb's pickers listing that machine's choices", async () => {
  await loadPluginApp(() => import("../app"));
  const { ReviewSettings } = await import("./ReviewSettings");
  const codex = { providerId: "codex", model: "gpt-6-astra", reasoningLevel: "low", permissionMode: "auto" };
  let record: any = { preferences: { ...defaultPreferences, guideAgent: codex }, revision: 0 };
  const save = vi.fn(async (input: any) => record = { ...input, revision: input.revision + 1 });
  const slot = renderSlot({ component: ReviewSettings }, {}, { rpc: { setReviewPresence: () => ({ ok: true }), getPreferences: () => record, savePreferences: save, listMachines } });
  const machine = await slot.findByRole("combobox", { name: "Machine" }) as HTMLSelectElement;
  await waitFor(() => expect(Array.from(machine.options).map((option) => option.text)).toEqual(["bb-server-0 (server)", "FloMac", "FloMac Original (offline)"]));
  const picker = slot.getByTestId("bb-provider-model-picker");
  expect(picker.dataset.routingKind).toBe("primary");

  fireEvent.change(machine, { target: { value: "host_flomac" } });
  for (const routed of [picker, slot.getByTestId("bb-permission-mode-picker")]) expect(routed.dataset).toMatchObject({ routingKind: "host", routingId: "host_flomac" });
  fireEvent.change(within(picker).getByRole("textbox", { name: "Provider ID" }), { target: { value: "claude-code" } });
  fireEvent.change(within(picker).getByRole("textbox", { name: "Model" }), { target: { value: "claude-opus-5-5" } });
  fireEvent.click(within(picker).getByRole("button", { name: "Apply execution selection" }));
  fireEvent.click(slot.getByRole("button", { name: "Save settings" }));
  await slot.findByText("Settings saved");
  const onFloMac = { hostId: "host_flomac", providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "low", permissionMode: "auto" };
  expect(record.preferences.guideAgent).toEqual(onFloMac);

  // The server is stored as no machine.
  fireEvent.change(slot.getByRole("combobox", { name: "Machine" }), { target: { value: "" } });
  expect(slot.getByTestId("bb-provider-model-picker").dataset.routingKind).toBe("primary");
  fireEvent.click(slot.getByRole("button", { name: "Save settings" }));
  await waitFor(() => expect(record.preferences.guideAgent).toEqual({ ...onFloMac, hostId: undefined }));
  expect(record.preferences.guideAgent).not.toHaveProperty("hostId");
  slot.lifecycle.unmount();
});

test("a saved machine that was removed, or a machine list that won't load, is labeled", async () => {
  await loadPluginApp(() => import("../app"));
  const { ReviewSettings } = await import("./ReviewSettings");
  const assistantAgent = { hostId: "host_gone", providerId: "codex", model: "gpt-6", reasoningLevel: "low", permissionMode: "auto" };
  let record = { preferences: { ...defaultPreferences, assistantAgent }, revision: 1 };
  const rpc = { setReviewPresence: () => ({ ok: true }), getPreferences: () => record, listMachines };
  let slot = renderSlot({ component: ReviewSettings }, {}, { rpc });
  let machine = await slot.findByRole("combobox", { name: "Machine" }) as HTMLSelectElement;
  await waitFor(() => expect(machine.selectedOptions[0].text).toBe("Removed machine"));
  slot.lifecycle.unmount();

  // A machine that became the server, such as after a server move, shows as the server.
  record = { preferences: { ...defaultPreferences, assistantAgent: { ...assistantAgent, hostId: "host_server" } }, revision: 1 };
  slot = renderSlot({ component: ReviewSettings }, {}, { rpc });
  machine = await slot.findByRole("combobox", { name: "Machine" }) as HTMLSelectElement;
  await waitFor(() => expect(machine.selectedOptions[0].text).toBe("bb-server-0 (server)"));
  slot.lifecycle.unmount();
  record = { preferences: { ...defaultPreferences, assistantAgent }, revision: 1 };

  slot = renderSlot({ component: ReviewSettings }, {}, { rpc: { ...rpc, listMachines: async () => { throw new Error("Offline"); } } });
  await slot.findByText("Couldn’t load your machines. Reload this page to choose another machine.");
  machine = slot.getByRole("combobox", { name: "Machine" }) as HTMLSelectElement;
  expect(machine.selectedOptions[0].text).toBe("host_gone");
  slot.lifecycle.unmount();
});

test("the automatic review prompt starts from the default and can be turned off", async () => {
  await loadPluginApp(() => import("../app"));
  const { ReviewSettings } = await import("./ReviewSettings");
  let record = { preferences: { ...defaultPreferences }, revision: 0 };
  const save = vi.fn(async (input: any) => record = { ...input, revision: input.revision + 1 });
  const slot = renderSlot({ component: ReviewSettings }, {}, { rpc: { setReviewPresence: () => ({ ok: true }), getPreferences: () => record, savePreferences: save } });
  const prompt = await slot.findByRole("textbox", { name: "Automatic review" }) as HTMLTextAreaElement;
  expect(prompt.value).toBe(defaultPreferences.automaticReview);
  expect(prompt.value).toContain("add_draft_comment");
  fireEvent.change(prompt, { target: { value: "" } });
  fireEvent.click(slot.getByRole("button", { name: "Save settings" }));
  await slot.findByText("Settings saved");
  expect(record.preferences.automaticReview).toBe("");
  slot.lifecycle.unmount();
});

test("an assistant's comment appears in an open draft, and Submit sends only the comments shown", async () => {
  await loadPluginApp(() => import("../app"));
  const DraftTray = await draftTray();
  const mine = { file: "a.ts", line: 1, side: "RIGHT", body: "My comment", chapterId: "c1" };
  const theirs = { file: "a.ts", line: 2, side: "RIGHT", body: "The assistant's comment" };
  const stored = { targetKey: "live", verdict: "COMMENT", body: "", comments: [mine] as any[] };
  const submitReview = vi.fn(() => ({ ok: false, error: "Not now" }));
  const slot = renderSlot({ component: (props: any) => <DraftTray {...props} /> }, { targetKey: "live", activeChapterId: "c1", activeFiles: ["a.ts"], reviewRevision: "r1", account: "reviewer" }, { rpc: {
    setReviewPresence: () => ({ ok: true }), getReviewerNotes: () => ({ body: "", revision: 0 }), getDraft: () => ({ draft: structuredClone(stored) }), submitReview,
  } });
  await slot.findByText("My comment");
  stored.comments.push(theirs);
  await slot.emitRealtime("draft:live", {});
  await slot.findByText("The assistant's comment");
  fireEvent.click(slot.getByRole("button", { name: /^Submit to GitHub/ }));
  await waitFor(() => expect(submitReview).toHaveBeenCalledWith({ targetKey: "live", revision: "r1", account: "reviewer", comments: [mine, theirs], body: "", verdict: "COMMENT" }));
  slot.lifecycle.unmount();
});

test("a draft labels agents' comments, and Remove names the comment's location", async () => {
  await loadPluginApp(() => import("../app"));
  const DraftTray = await draftTray();
  const mine = { file: "a.ts", line: 1, side: "RIGHT", body: "My comment" };
  const theirs = { file: "a.ts", line: 2, side: "LEFT", author: "agent", body: "The agent's comment" };
  const draft = { targetKey: "labels", verdict: "COMMENT", body: "", comments: [mine, theirs] };
  const removeDraftComment = vi.fn(() => ({ draft: { ...draft, comments: [mine] } }));
  const slot = renderSlot({ component: (props: any) => <DraftTray {...props} /> }, { targetKey: "labels", activeChapterId: "c1", activeFiles: ["a.ts"] }, { rpc: {
    setReviewPresence: () => ({ ok: true }), getReviewerNotes: () => ({ body: "", revision: 0 }), getDraft: () => ({ draft }), removeDraftComment,
  } });
  await slot.findByRole("button", { name: "Agent draft · not submitted · a.ts:2 (old line)" });
  expect(slot.getByRole("button", { name: "Draft · not submitted · a.ts:1" })).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: "Expand Draft comment on a.ts:2 (old line)" }));
  fireEvent.click(slot.getByRole("button", { name: "Remove comment on a.ts:2" }));
  await waitFor(() => expect(removeDraftComment).toHaveBeenCalledWith({ targetKey: "labels", file: "a.ts", line: 2, side: "LEFT" }));
  await waitFor(() => expect(slot.queryByText("The agent's comment")).toBeNull());
  slot.lifecycle.unmount();
});

/** Settings over a saved record, which Save replaces. */
async function renderSettings(preferences: Record<string, unknown> = { ...defaultPreferences }) {
  await loadPluginApp(() => import("../app"));
  const { ReviewSettings } = await import("./ReviewSettings");
  const saved = { record: { preferences, revision: 1 } as { preferences: any; revision: number } };
  const save = vi.fn(async (input: any) => saved.record = { ...input, revision: input.revision + 1 });
  const slot = renderSlot({ component: ReviewSettings }, {}, { rpc: { setReviewPresence: () => ({ ok: true }), getPreferences: () => saved.record, savePreferences: save } });
  await slot.findByRole("textbox", { name: "Guide instructions" });
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const toggle = (label: string) => slot.getByRole("checkbox", { name: new RegExp(`^${escape(label)}`) }) as HTMLInputElement;
  const pace = () => slot.getByRole("spinbutton", { name: "Flag chapters read faster than lines an hour" }) as HTMLInputElement;
  const saveButton = () => slot.getByRole("button", { name: "Save settings" }) as HTMLButtonElement;
  return { slot, saved, save, toggle, pace, saveButton };
}
const SECTION_TITLES = { notifications: "Notifications", assistant: "Review assistant", turn: "Whose turn", reading: "Reading", comments: "Comments and Finish review", trust: "Trust" } as const;

test("every knob shows in its section, and each saves its non-default value", async () => {
  const { KNOB_CONTROLS } = await import("./SettingsKnobs");
  const { defaultKnobs } = await import("../lib/knobs");
  expect(KNOB_CONTROLS.map((control) => control.id).sort()).toEqual(Object.keys(defaultKnobs).sort());
  const { slot, saved, toggle, pace, saveButton } = await renderSettings();
  for (const control of KNOB_CONTROLS) {
    const section = slot.getByRole("heading", { name: SECTION_TITLES[control.section] }).closest("section")!;
    const input = control.unit ? pace() : toggle(control.label);
    expect({ id: control.id, inSection: section.contains(input) }).toEqual({ id: control.id, inSection: true });
  }
  // The pace first: it's disabled once Check before you approve is off.
  fireEvent.change(pace(), { target: { value: "800" } });
  for (const control of KNOB_CONTROLS) if (!control.unit) fireEvent.click(toggle(control.label));
  fireEvent.click(saveButton());
  await slot.findByText("Settings saved");
  const off = Object.fromEntries(Object.keys(defaultKnobs).map((id) => [id, false]));
  expect(saved.record.preferences).toEqual({ ...defaultPreferences, knobs: { ...off, approveGuardPace: 800 } });
  slot.lifecycle.unmount();
});

test("a setting that depends on another is disabled while that one is off, and Trust's authors stay a choice", async () => {
  const { slot, toggle, pace } = await renderSettings();
  const automaticReview = slot.getByRole("textbox", { name: "Automatic review" }) as HTMLTextAreaElement;
  const check = slot.getByRole("textbox", { name: "Re-review check" }) as HTMLTextAreaElement;
  const pushes = () => within(slot.getByRole("group", { name: "After the author pushes" })).getAllByRole("button") as HTMLButtonElement[];
  const authors = () => within(slot.getByRole("group", { name: "Run agents on their own for PRs from" })).getAllByRole("button") as HTMLButtonElement[];
  const dependents = () => ({
    automaticReview: automaticReview.disabled, check: check.disabled, pushes: pushes().every((button) => button.disabled),
    reviewed: toggle("Include PRs you’ve reviewed").disabled, team: toggle("Include team requests").disabled, pace: pace().disabled,
    authors: authors().some((button) => button.disabled),
  });
  expect(dependents()).toEqual({ automaticReview: false, check: false, pushes: false, reviewed: false, team: false, pace: false, authors: false });
  // A disabled dependent's label and description dim with its control, still readable.
  const texts = ["Automatic review", /^Sent to the assistant when a guide is ready/, "Re-review check", /^Sent to the review assistant when a review comes back/,
    "After the author pushes", /^The review assistant checks once the author’s pushes settle/, "Include team requests", /^Also show PRs that ask a team/,
    "Include PRs you’ve reviewed", /^Open PRs you reviewed on GitHub/, "Flag chapters read faster than", "lines an hour", /^Medium- and high-risk chapters/];
  const dimmed = () => texts.map((text) => slot.getByText(text).closest(".opacity-80") !== null);
  expect(dimmed()).toEqual(texts.map(() => false));
  for (const label of ["Run the automatic review", "Run the re-review check", "Track reviews from GitHub", "Check before you approve", "Start agents on their own"]) fireEvent.click(toggle(label));
  expect(dependents()).toEqual({ automaticReview: true, check: true, pushes: true, reviewed: true, team: true, pace: true, authors: false });
  expect(dimmed()).toEqual(texts.map(() => true));
  expect(slot.getByText("Run the automatic review").closest(".opacity-80")).toBeNull();
  expect(slot.getByText(/^Start agents on their own is off: on other people’s PRs, nothing starts until you click\. This choice still decides whose PRs the repo’s tests and linters may run on\.$/)).toBeTruthy();
  fireEvent.click(toggle("Start agents on their own"));
  expect(slot.getByText(/^For other authors, no guide, automatic review, or feedback check starts by itself.*unless the PR’s branch is in someone else’s fork\.$/)).toBeTruthy();
  slot.lifecycle.unmount();
});

test("Start guides automatically says when its guides start, which follows the turn alerts and Start agents on their own", async () => {
  const { slot, toggle } = await renderSettings();
  const help = () => slot.container.querySelector("#auto-start-help")!.textContent;
  expect(help()).toMatch(/\. When your review is requested there, the guide is ready by the time you’re alerted\.$/);
  fireEvent.click(toggle("A review becomes your turn"));
  expect(help()).toMatch(/\. When your review is requested there, the guide starts right away\.$/);
  fireEvent.click(toggle("Start agents on their own"));
  expect(help()).toMatch(/\. Start agents on their own is off, so these guides wait for your click\.$/);
  fireEvent.click(toggle("A review becomes your turn"));
  expect(help()).toMatch(/wait for your click\.$/);
  slot.lifecycle.unmount();
});

test("a pace that isn't a whole number from 100 to 2,000 holds Save, and Discard edits clears it", async () => {
  const { slot, saved, pace, saveButton } = await renderSettings();
  const error = "Use a whole number from 100 to 2,000.";
  for (const value of ["99", "2001", "", "12.5"]) {
    fireEvent.change(pace(), { target: { value } });
    expect({ value, invalid: pace().getAttribute("aria-invalid"), error: !!slot.queryByText(error), save: saveButton().disabled }).toEqual({ value, invalid: "true", error: true, save: true });
  }
  fireEvent.change(pace(), { target: { value: "1000" } });
  expect({ invalid: pace().getAttribute("aria-invalid"), error: !!slot.queryByText(error), save: saveButton().disabled }).toEqual({ invalid: "false", error: false, save: false });
  fireEvent.change(pace(), { target: { value: "5" } });
  fireEvent.click(slot.getByRole("button", { name: "Discard edits" }));
  expect(pace().value).toBe("500");
  expect(slot.queryByText(error)).toBeNull();
  expect(slot.queryByText("Unsaved changes")).toBeNull();
  // Typing alone is an edit to discard.
  fireEvent.change(pace(), { target: { value: "5" } });
  expect(slot.getByText("Unsaved changes")).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: "Discard edits" }));
  fireEvent.change(pace(), { target: { value: "1500" } });
  fireEvent.click(saveButton());
  await slot.findByText("Settings saved");
  expect(saved.record.preferences.knobs.approveGuardPace).toBe(1500);
  slot.lifecycle.unmount();
});

test("how to set up Needs You shows while settings load and when they can't, and its toggles once they have", async () => {
  await loadPluginApp(() => import("../app"));
  const { ReviewSettings } = await import("./ReviewSettings");
  let fail = true;
  let answer!: (record: unknown) => void;
  const slot = renderSlot({ component: ReviewSettings }, {}, { rpc: { setReviewPresence: () => ({ ok: true }), getPreferences: () => {
    if (fail) throw new Error("Offline");
    return new Promise((resolve) => { answer = resolve; });
  } } });
  const error = (await slot.findByText("Couldn’t load settings. Try again.")).closest("[role=alert]");
  expect(slot.getByRole("link", { name: "Open Needs You settings" })).toBeTruthy();
  expect(slot.queryByRole("checkbox", { name: /^A guide is ready or failed/ })).toBeNull();
  // The error and Reload saved settings sit directly under Plugin updates, above Notifications.
  expect(slot.getByRole("region", { name: "Plugin updates" }).nextElementSibling).toBe(error);
  fail = false;
  fireEvent.click(slot.getByRole("button", { name: "Reload saved settings" }));
  await waitFor(() => expect(answer).toBeTypeOf("function"));
  expect(slot.getByRole("link", { name: "Open Needs You settings" })).toBeTruthy();
  answer({ preferences: { ...defaultPreferences }, revision: 1 });
  await slot.findByRole("checkbox", { name: /^A guide is ready or failed/ });
  slot.lifecycle.unmount();
});

test("every settings checkbox keeps its size beside a description that wraps", async () => {
  const { slot } = await renderSettings();
  const boxes = slot.getAllByRole("checkbox");
  expect(boxes.length).toBeGreaterThan(20);
  expect(boxes.filter((box) => !box.classList.contains("shrink-0")).map((box) => box.closest("label")?.textContent)).toEqual([]);
  slot.lifecycle.unmount();
});

test("the pace's number and its unit wrap as one, so the unit never sits alone on a phone", async () => {
  const { slot, pace } = await renderSettings();
  const unit = slot.getByText("lines an hour");
  expect(unit.parentElement).toBe(pace().parentElement);
  expect(unit.parentElement!.classList.contains("whitespace-nowrap")).toBe(true);
  slot.lifecycle.unmount();
});

test("a pace being typed goes when Check before you approve is turned off, so Save keeps the other edits", async () => {
  const { slot, saved, toggle, pace, saveButton } = await renderSettings();
  fireEvent.change(pace(), { target: { value: "50" } });
  expect(saveButton().disabled).toBe(true);
  fireEvent.click(toggle("Check before you approve"));
  fireEvent.click(toggle("Code owners"));
  expect(pace().disabled).toBe(true);
  expect(pace().value).toBe("500");
  expect(slot.queryByText("Use a whole number from 100 to 2,000.")).toBeNull();
  expect(saveButton().disabled).toBe(false);
  fireEvent.click(saveButton());
  await slot.findByText("Settings saved");
  expect(saved.record.preferences.knobs).toMatchObject({ approveGuard: false, approveGuardPace: 500, codeOwners: false });
  slot.lifecycle.unmount();
});

test("Restore defaults turns every knob back to its default, clears a pace being typed, and keeps the diff layout", async () => {
  const { defaultKnobs } = await import("../lib/knobs");
  const { allKnobsOff } = await import("./settings-off.test-support");
  const { slot, saved, toggle, pace, saveButton } = await renderSettings({ ...defaultPreferences, diffLayout: "unified", knobs: allKnobsOff });
  expect(toggle("Single-key shortcuts").checked).toBe(false);
  fireEvent.click(toggle("Check before you approve"));
  fireEvent.change(pace(), { target: { value: "50" } });
  fireEvent.click(slot.getByRole("button", { name: "Restore defaults" }));
  expect(pace().value).toBe("500");
  expect(pace().getAttribute("aria-invalid")).toBe("false");
  expect(toggle("Single-key shortcuts").checked).toBe(true);
  expect(saved.record.preferences.knobs).toEqual(allKnobsOff);
  fireEvent.click(saveButton());
  await slot.findByText("Settings saved");
  expect(saved.record.preferences).toEqual({ ...defaultPreferences, diffLayout: "unified", knobs: defaultKnobs });
  slot.lifecycle.unmount();
});

test("settings from a server without knobs show each at its default, with nothing to save", async () => {
  const { knobs: _none, ...older } = defaultPreferences;
  const { slot, toggle, pace, saveButton } = await renderSettings(older);
  expect(toggle("Single-key shortcuts").checked).toBe(true);
  expect(pace().value).toBe("500");
  expect(slot.queryByText("Unsaved changes")).toBeNull();
  expect(saveButton().disabled).toBe(true);
  slot.lifecycle.unmount();
});
