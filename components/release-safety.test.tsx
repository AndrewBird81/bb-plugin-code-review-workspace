import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { defaultPreferences } from "../src/preferences";
import { readDraftRecovery } from "../lib/draft-recovery";
import type { DraftProviderProps } from "./DraftProvider";
afterEach(() => { cleanup(); sessionStorage.clear(); });

/** The draft's provider with Comments and Finish review after what it wraps, as the side panel shows them. */
async function draftTray() {
  const { DraftTray } = await import("./draft-tray.test-support");
  return DraftTray;
}

test("closing a document releases its lease, while a cached page keeps its editors protected", async () => {
  await loadPluginApp(() => import("../app"));
  const { useReviewSession } = await import("../lib/review-session");
  const presence = vi.fn(() => ({ ok: true }));
  const beacon = vi.fn(() => true);
  const original = navigator.sendBeacon;
  Object.defineProperty(navigator, "sendBeacon", { configurable: true, value: beacon });
  try {
    const slot = renderSlot({ component: () => { const session = useReviewSession(); return <p>{session.ready ? "Ready" : "Opening"}</p>; } }, {}, { rpc: { setReviewPresence: presence } });
    await slot.findByText("Ready");
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })); expect(beacon).not.toHaveBeenCalled();
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false }));
    expect(beacon).toHaveBeenCalledWith("/api/v1/plugins/guided-review/rpc/setReviewPresence", expect.any(Blob));
    slot.lifecycle.unmount();
  } finally { Object.defineProperty(navigator, "sendBeacon", { configurable: true, value: original }); }
});

test("an unsaved summary survives closing the panel and reopens in its box", async () => {
  await loadPluginApp(() => import("../app"));
  const DraftTray = await draftTray();
  const save = vi.fn();
  const component = () => <DraftTray targetKey="kept-summary" activeChapterId="chapter" activeFiles={[]} reviewRevision="revision" />;
  const rpc = { getDraft: () => ({ draft: { targetKey: "kept-summary", verdict: "COMMENT", body: "", comments: [] } }), saveSummary: save };
  const first = renderSlot({ component }, {}, { rpc }); await first.findByText("Draft saved");
  fireEvent.click(first.getByRole("button", { name: "Write summary" }));
  fireEvent.change(first.getByRole("textbox", { name: "Review summary" }), { target: { value: "First version" } });
  first.lifecycle.unmount();
  expect(readDraftRecovery("kept-summary").composer).toMatchObject({ file: "", line: "0", body: "First version" });
  const second = renderSlot({ component }, {}, { rpc });
  expect(((await second.findByRole("textbox", { name: "Review summary" })) as HTMLTextAreaElement).value).toBe("First version");
  expect(save).not.toHaveBeenCalled();
});

test("recovered summary text saves with the revision it was written against", async () => {
  await loadPluginApp(() => import("../app"));
  const DraftTray = await draftTray();
  const draft = { targetKey: "recovery", verdict: "COMMENT", body: "", comments: [] };
  const save = vi.fn(async (_input: any) => { throw new Error("This review changed in another window."); });
  const rpc = { getDraft: () => ({ draft }), saveSummary: save };
  const component = (props: any) => <DraftTray targetKey="recovery" activeChapterId="chapter" activeFiles={["a.ts"]} {...props} />;
  const first = renderSlot({ component }, { reviewRevision: "old" }, { rpc });
  await first.findByText("Draft saved");
  fireEvent.click(first.getByRole("button", { name: "Write summary" }));
  fireEvent.change(first.getByRole("textbox", { name: "Review summary" }), { target: { value: "Unsaved reasoning" } });
  first.lifecycle.unmount();
  const second = renderSlot({ component }, { reviewRevision: "new" }, { rpc });
  const summary = await second.findByRole("textbox", { name: "Review summary" });
  expect((summary as HTMLTextAreaElement).value).toBe("Unsaved reasoning");
  fireEvent.click(second.getByRole("button", { name: "Save summary" }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  expect(save.mock.calls[0]?.[0]).toMatchObject({ revision: "old", body: "Unsaved reasoning" });
  // Refused: the text stays in its box.
  expect((second.getByRole("textbox", { name: "Review summary" }) as HTMLTextAreaElement).value).toBe("Unsaved reasoning");
});

test("summary text saved for recovery before the summary had its own box reopens in it", async () => {
  await loadPluginApp(() => import("../app"));
  const DraftTray = await draftTray();
  sessionStorage.setItem("guided-review:draft-recovery:legacy", JSON.stringify({ summary: { verdict: "REQUEST_CHANGES", body: "Older unsaved words", revision: "old" } }));
  const rpc = { getDraft: () => ({ draft: { targetKey: "legacy", verdict: "COMMENT", body: "", comments: [] } }) };
  const slot = renderSlot({ component: () => <DraftTray targetKey="legacy" activeChapterId="chapter" activeFiles={[]} reviewRevision="new" /> }, {}, { rpc });
  expect(((await slot.findByRole("textbox", { name: "Review summary" })) as HTMLTextAreaElement).value).toBe("Older unsaved words");
  slot.lifecycle.unmount();
});

test("manual update locks settings editors until replacement completes", async () => {
  await loadPluginApp(() => import("../app"));
  const { ReviewSettings } = await import("./ReviewSettings");
  const status = { installedVersion: "0.2.0", automatic: false, updating: false, outcome: "update-available", latestVersion: "0.2.1", candidateVersion: "new", checkedAt: 1, error: null };
  let finish!: (result: any) => void;
  const slot = renderSlot({ component: ReviewSettings }, {}, { rpc: {
    setReviewPresence: () => ({ ok: true }), getPreferences: () => ({ preferences: defaultPreferences, revision: 0 }),
    getReleaseStatus: () => status, applyPluginUpdate: () => new Promise(resolve => { finish = resolve; }),
    getSetupStatus: () => ({ account: "casey", githubCli: true, agentAvailable: true, projectAvailable: true }),
  } });
  fireEvent.click(await slot.findByRole("button", { name: "Update now" }));
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  expect((slot.getByRole("textbox", { name: "Guide instructions" }) as HTMLTextAreaElement).closest("fieldset")?.disabled).toBe(true);
  finish({ outcome: "updated", version: "0.2.1" });
  await slot.findByText(/Updated to 0.2.1/);
});

test("release notes open this fork's releases on GitHub", async () => {
  await loadPluginApp(() => import("../app"));
  const { ReviewSettings } = await import("./ReviewSettings");
  const status = { installedVersion: "0.6.0", automatic: false, updating: false, outcome: "current", latestVersion: "0.6.0", candidateVersion: null, checkedAt: 1, error: null };
  const slot = renderSlot({ component: ReviewSettings }, {}, { rpc: {
    setReviewPresence: () => ({ ok: true }), getPreferences: () => ({ preferences: defaultPreferences, revision: 0 }),
    getReleaseStatus: () => status,
    getSetupStatus: () => ({ account: "casey", githubCli: true, agentAvailable: true, projectAvailable: true }),
  } });
  expect((await slot.findByRole("link", { name: "Release notes" })).getAttribute("href")).toBe("https://github.com/AndrewBird81/bb-plugin-guided-review/releases");
  slot.lifecycle.unmount();
});
