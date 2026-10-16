// Settings knobs reach the panel's views through SettingsProvider, and every view still renders with each one off.
import { useEffect, useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { defaultPreferences } from "../lib/review-preferences";
import { defaultKnobs } from "../lib/knobs";
import { patchReviewState } from "../lib/panel-state";
import { allKnobsOff, desktopWindow, renderInbox, renderReview, settingsOffRpc } from "./settings-off.test-support";

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

test("the first load settles from an answer a newer reload overtook", async () => {
  const pending: ((record: unknown) => void)[] = [];
  const slot = await renderProbe(() => new Promise((resolve) => pending.push(resolve)));
  await waitFor(() => expect(pending).toHaveLength(1));
  await slot.emitRealtime("preferences", {});
  await waitFor(() => expect(pending).toHaveLength(2));
  pending[0]!(off);
  await slot.findByText("Settled false");
  // Only the newest load sets what the views read.
  expect(slot.getByText("Code owners true")).toBeTruthy();
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

test("settings that won't load keep the switches this browser last loaded, and a fresh browser gets the defaults", async () => {
  const offline = { getPreferences: () => { throw new Error("Offline"); } };
  const loaded = await renderReview({ ...defaultKnobs, singleKeyShortcuts: false });
  await loaded.page.findByRole("heading", { name: "Parse rows" });
  loaded.page.lifecycle.unmount(); loaded.bar.lifecycle.unmount();
  // Shortcuts were off when settings last loaded; now they can't load.
  const { page, bar } = await renderReview(defaultKnobs, offline);
  await page.findByRole("heading", { name: "Parse rows" });
  for (const key of ["j", "?"]) fireEvent.keyDown(document.body, { key });
  expect(page.queryByRole("dialog", { name: "Keyboard shortcuts" })).toBeNull();
  page.lifecycle.unmount(); bar.lifecycle.unmount();
  localStorage.clear();
  const fresh = await renderReview(defaultKnobs, offline);
  await fresh.page.findByRole("heading", { name: "Parse rows" });
  fireEvent.keyDown(document.body, { key: "?" });
  await fresh.page.findByRole("dialog", { name: "Keyboard shortcuts" });
  fresh.page.lifecycle.unmount(); fresh.bar.lifecycle.unmount();
});

test("the stored switches are read as saved settings are: each invalid or missing one at its default", async () => {
  await loadPluginApp(() => import("../app"));
  const { storedKnobs } = await import("../lib/settings");
  expect(storedKnobs("guided-review")).toBeNull();
  localStorage.setItem("gr:knobs:guided-review", JSON.stringify({ singleKeyShortcuts: false, codeOwners: "no", approveGuardPace: 50.5 }));
  expect(storedKnobs("guided-review")).toEqual({ ...defaultKnobs, singleKeyShortcuts: false });
  localStorage.setItem("gr:knobs:guided-review", JSON.stringify({ approveGuardPace: 100 }));
  expect(storedKnobs("guided-review")?.approveGuardPace).toBe(100);
  // Another install's are its own.
  expect(storedKnobs("guided-review-dev")).toBeNull();
  localStorage.setItem("gr:knobs:guided-review", "{");
  expect(storedKnobs("guided-review")).toBeNull();
});

/** The review's page alone, whose settings load however `getPreferences` answers. */
async function openReview(getPreferences: () => unknown) {
  const app = await loadPluginApp(() => import("../app"));
  return renderSlot(app.navPanels[0]!, { subPath: "pr-42" }, { rpc: settingsOffRpc(defaultKnobs, { getPreferences }) as any });
}
const requirementsOff = { preferences: { ...defaultPreferences, knobs: { ...defaultKnobs, requirements: false } }, revision: 1 };

test("a settings load that never answers opens the review with default settings after a second", async () => {
  const page = await openReview(() => new Promise(() => {}));
  await page.findByRole("main", { name: "Review" }, { timeout: 4000 });
  await page.findByRole("region", { name: /^Requirements/ });
  page.lifecycle.unmount();
}, 15_000);

test("a first settings load overtaken by a reload that never answers still opens the review", async () => {
  const pending: ((record: unknown) => void)[] = [];
  const page = await openReview(() => new Promise((resolve) => pending.push(resolve)));
  // The provider's load and the workspace's own preferences read.
  await waitFor(() => expect(pending.length).toBeGreaterThanOrEqual(2));
  const before = pending.length;
  await page.emitRealtime("preferences", {});
  await waitFor(() => expect(pending.length).toBeGreaterThan(before));
  // Every load but the newest answers.
  pending.slice(0, -1).forEach((resolve) => resolve(requirementsOff));
  await page.findByRole("main", { name: "Review" }, { timeout: 4000 });
  page.lifecycle.unmount();
}, 15_000);

test("a settings load that never answers opens the review with the switches this browser last loaded", async () => {
  // Open on the Overview was off: a review that came back to you reopens where you left it.
  localStorage.setItem("gr:knobs:test-plugin", JSON.stringify({ ...defaultKnobs, returnToOverview: false }));
  patchReviewState("pr-42", { activeId: "c1" });
  const app = await loadPluginApp(() => import("../app"));
  const review = { targetKey: "pr-42", kind: "pr", status: "ready", createdAt: 1, title: "Parse rows", headSha: "new", url: "https://github.com/acme/web/pull/42", repo: "acme/web", number: 42,
    submittedVerdict: "REQUEST_CHANGES", turn: { group: "needs", reason: "re-requested", label: "Re-requested", signal: "re-requested:1", at: Date.now(), notify: true, blocking: false, updated: true } };
  const bundle = settingsOffRpc(defaultKnobs).getReviewBundle();
  const page = renderSlot(app.navPanels[0]!, { subPath: "pr-42" }, { rpc: settingsOffRpc(defaultKnobs, {
    getPreferences: () => new Promise(() => {}), getReviewBundle: () => ({ ...bundle, review }),
  }) as any });
  await page.findAllByTestId("filediff", {}, { timeout: 4000 });
  expect(page.queryByRole("heading", { name: "Parse rows" })).toBeNull();
  page.lifecycle.unmount();
}, 15_000);

test("a slow settings load doesn't hold the review, and its settings apply once they arrive", async () => {
  let answer!: (record: unknown) => void;
  const page = await openReview(() => new Promise((resolve) => { answer = resolve; }));
  await page.findByRole("main", { name: "Review" }, { timeout: 4000 });
  await page.findByRole("region", { name: /^Requirements/ });
  answer(requirementsOff);
  await waitFor(() => expect(page.queryByRole("region", { name: /^Requirements/ })).toBeNull());
  page.lifecycle.unmount();
}, 15_000);

/** The ids of the 1 s timers set while `run` runs, and whether each was cleared by the end. */
async function secondTimers(run: () => Promise<void>) {
  const set = vi.spyOn(globalThis, "setTimeout");
  const clear = vi.spyOn(globalThis, "clearTimeout");
  try {
    await run();
    const ids = set.mock.calls.flatMap((call, index) => call[1] === 1000 ? [set.mock.results[index]!.value] : []);
    return ids.map((id) => clear.mock.calls.some(([cleared]) => cleared === id));
  } finally { set.mockRestore(); clear.mockRestore(); }
}

test("a review's wait for its settings stops once they answer, or once its load fails", async () => {
  expect(await secondTimers(async () => {
    const page = await openReview(() => requirementsOff);
    await page.findByRole("main", { name: "Review" }, { timeout: 4000 });
    page.lifecycle.unmount();
  })).toEqual([true]);
  expect(await secondTimers(async () => {
    const app = await loadPluginApp(() => import("../app"));
    const page = renderSlot(app.navPanels[0]!, { subPath: "pr-42" }, { rpc: settingsOffRpc(defaultKnobs, {
      getPreferences: () => new Promise(() => {}), getReviewBundle: () => { throw new Error("Offline"); },
    }) as any });
    await page.findByRole("button", { name: "Try again" }, { timeout: 4000 });
    page.lifecycle.unmount();
  })).toEqual([true]);
}, 15_000);

test("with every knob off, the Overview, a chapter, Comments, Finish review, the title bar and All reviews still render", async () => {
  restores.push(desktopWindow());
  const setVerdict = vi.fn(({ verdict }: { verdict: string }) => ({ draft: { targetKey: "pr-42", verdict, verdictChosen: true, body: "", comments: [{ file: "src/a.ts", line: 2, side: "RIGHT", severity: "blocking", body: "Upper case reads as a constant." }] } }));
  const rpc = { setFileViewed: vi.fn(() => ({ ok: true })), setVerdict };
  const { page, bar, main } = await renderReview(allKnobsOff, rpc);
  await page.findByRole("heading", { name: "Parse rows" });
  const commands = within(await bar.findByRole("group", { name: "Review commands" }));
  fireEvent.click(await main().findByRole("button", { name: "Start reading: Parsing" }));
  // The lockfile opens like any other file, and marking a file viewed leaves it open.
  await waitFor(() => expect(page.getAllByTestId("filediff")).toHaveLength(2));
  fireEvent.click(page.getByRole("checkbox", { name: "Viewed src/a.ts" }));
  await waitFor(() => expect((page.getByRole("checkbox", { name: "Viewed src/a.ts" }) as HTMLInputElement).checked).toBe(true));
  expect(page.getAllByTestId("filediff")).toHaveLength(2);
  fireEvent.click(page.getByRole("checkbox", { name: "Viewed src/a.ts" }));
  await waitFor(() => expect((page.getByRole("checkbox", { name: "Viewed src/a.ts" }) as HTMLInputElement).checked).toBe(false));
  expect(page.queryByText(/Owned by/)).toBeNull();
  expect(page.inspection.rpcCalls.some((call) => call.method === "getCodeOwners")).toBe(false);
  // No key does anything, and none is named.
  for (const key of ["j", "n", "c", "?"]) fireEvent.keyDown(document.body, { key });
  expect(page.queryByRole("complementary", { name: "Comments and agent" })).toBeNull();
  expect(page.queryByRole("dialog", { name: "Keyboard shortcuts" })).toBeNull();
  expect(Array.from(page.baseElement.querySelectorAll("kbd")).filter((key) => key.textContent === "/")).toHaveLength(0);
  fireEvent.click(commands.getByRole("button", { name: "Comments" }));
  const panel = within(await page.findByRole("complementary", { name: "Comments and agent" }));
  await panel.findByText("Upper case reads as a constant.");
  fireEvent.click(await commands.findByRole("button", { name: /^Finish review:/ }));
  await page.findByRole("heading", { name: "Finish review" });
  // Approving with the high-risk chapter's src/a.ts not viewed: no guard row, but the blocking comment's still.
  fireEvent.click(within(page.getByRole("group", { name: "Review verdict" })).getByRole("button", { name: /^Approve/ }));
  await page.findByText("Approving with 1 blocking comment.");
  expect(page.queryByText(/not viewed/)).toBeNull();
  page.lifecycle.unmount(); bar.lifecycle.unmount();
  const inbox = await renderInbox(allKnobsOff);
  expect(inbox.getByText("Parse rows")).toBeTruthy();
  fireEvent.keyDown(document.body, { key: "/" });
  expect(document.activeElement).toBe(document.body);
  expect(Array.from(inbox.container.querySelectorAll("kbd")).filter((key) => key.textContent === "/")).toHaveLength(0);
  inbox.lifecycle.unmount();
});

test("with every knob off, a comment on code the PR didn't change shows no Pre-existing badge, mark or count, and holds Approve", async () => {
  restores.push(desktopWindow());
  const comments = [{ file: "src/a.ts", line: 2, side: "RIGHT", author: "agent", severity: "blocking", body: "Upper case was always read this way.", introduced: false }];
  const getDraft = () => ({ draft: { targetKey: "pr-42", verdict: "APPROVE", verdictChosen: true, body: "", comments: structuredClone(comments) }, stale: [] });
  const { page, bar } = await renderReview(allKnobsOff, { getDraft });
  const commands = within(await bar.findByRole("group", { name: "Review commands" }));
  fireEvent.click(await commands.findByRole("button", { name: "Comments" }));
  const panel = within(await page.findByRole("complementary", { name: "Comments and agent" }));
  fireEvent.click(await panel.findByRole("button", { name: "Agent draft · not submitted · src/a.ts:2 · Blocking" }));
  fireEvent.click(panel.getByRole("button", { name: /^Expand Draft comment on src\/a\.ts:2/ }));
  await panel.findByRole("button", { name: "Remove comment on src/a.ts:2" });
  expect(panel.queryByRole("button", { name: /Mark as/ })).toBeNull();
  expect(page.queryByText(/pre-existing/i)).toBeNull();
  fireEvent.click(await commands.findByRole("button", { name: /^Finish review:/ }));
  await page.findByText("Approving with 1 blocking comment.");
  page.lifecycle.unmount(); bar.lifecycle.unmount();
});

test("with every knob off, Finish review shows nothing of what the agent read or didn't check", async () => {
  restores.push(desktopWindow());
  const draft = { targetKey: "pr-42", verdict: "COMMENT", body: "", suggestedVerdict: "APPROVE", unchecked: ["Didn't run the tests"], comments: [] };
  const getReviewBundle = () => ({ ...settingsOffRpc(allKnobsOff).getReviewBundle(), review: { ...settingsOffRpc(allKnobsOff).getReviewBundle().review, agentReads: { head: "new", files: [] } } });
  const { page, bar } = await renderReview(allKnobsOff, { getDraft: () => ({ draft, stale: [] }), getReviewBundle });
  fireEvent.click(await within(await bar.findByRole("group", { name: "Review commands" })).findByRole("button", { name: /^Finish review:/ }));
  const suggestion = within(await page.findByRole("region", { name: "Agent’s suggestion" }));
  expect(suggestion.getByText("Agent suggests Approve")).toBeTruthy();
  expect(page.queryByText(/^Read \d+ of/)).toBeNull();
  expect(page.queryByRole("button", { name: "What it didn’t check" })).toBeNull();
  expect(page.queryByText(/The agent suggests Approve but read/)).toBeNull();
  page.lifecycle.unmount(); bar.lifecycle.unmount();
});

test("with every knob off, a weakened test and a changed lockfile show no chips", async () => {
  restores.push(desktopWindow());
  const patch = "diff --git a/src/a.test.ts b/src/a.test.ts\n--- a/src/a.test.ts\n+++ b/src/a.test.ts\n@@ -1,2 +1 @@\n-  expect(a).toBe(1);\n+it.skip(\"a\", () => {\n"
    + "diff --git a/package-lock.json b/package-lock.json\n--- a/package-lock.json\n+++ b/package-lock.json\n@@ -1 +1,2 @@\n-    \"node_modules/a\": {\n+    \"node_modules/b\": {\n+      \"resolved\": \"https://evil.example.com/b.tgz\",\n";
  const bundle = settingsOffRpc(allKnobsOff).getReviewBundle();
  const guide = { ...bundle.guide, requirements: [], sections: [{ ...bundle.guide.sections[0], diffs: [{ file: "src/a.test.ts", summary: "Tests a." }, { file: "package-lock.json", summary: "Lockfile." }] }] };
  const { page, main } = await renderReview(allKnobsOff, { getReviewBundle: () => ({ ...bundle, guide, patch }) });
  fireEvent.click(await main().findByRole("button", { name: "Start reading: Parsing" }));
  await page.findByText("Tests a.");
  await page.findByText("Lockfile.");
  expect(page.queryByText(/assertions? removed|tests? skipped|packages|Downloads from/)).toBeNull();
  page.lifecycle.unmount();
});

test("with Comment keys off, the comment ] lands on takes none of their keys, and the shortcuts sheet doesn't list them", async () => {
  const saveDraftComment = vi.fn(); const removeDraftComment = vi.fn();
  const { page, bar } = await renderReview({ ...defaultKnobs, commentKeys: false }, { saveDraftComment, removeDraftComment });
  await page.findByRole("heading", { name: "Parse rows" });
  fireEvent.keyDown(document.body, { key: "]" });
  for (const key of ["x", "2", "0", "e"]) fireEvent.keyDown(document.body, { key });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect([saveDraftComment.mock.calls.length, removeDraftComment.mock.calls.length]).toEqual([0, 0]);
  expect(page.queryByRole("textbox", { name: "Draft comment" })).toBeNull();
  fireEvent.keyDown(document.body, { key: "?" });
  const sheet = within(await page.findByRole("dialog", { name: "Keyboard shortcuts" }));
  expect(sheet.getByRole("region", { name: "Move" })).toBeTruthy();
  expect(sheet.queryByRole("region", { name: "Comment" })).toBeNull();
  page.lifecycle.unmount(); bar.lifecycle.unmount();
});

test("with Ask why off, removing the agent's comment says Comment removed with Undo, and no Why?", async () => {
  const { toast } = await import("sonner");
  const agents = { targetKey: "pr-42", verdict: "COMMENT", body: "", comments: [{ file: "src/a.ts", line: 2, side: "RIGHT", author: "agent", body: "Upper case reads as a constant." }] };
  const removeDraftComment = vi.fn(() => ({ draft: { ...agents, comments: [] }, stale: [] }));
  const { page, bar } = await renderReview({ ...defaultKnobs, removalReasons: false }, { getDraft: () => ({ draft: agents, stale: [] }), removeDraftComment });
  await page.findByRole("heading", { name: "Parse rows" });
  fireEvent.keyDown(document.body, { key: "]" });
  fireEvent.keyDown(document.body, { key: "x" });
  await waitFor(() => expect(removeDraftComment).toHaveBeenCalled());
  await waitFor(() => expect(toast.info).toHaveBeenCalledWith("Comment removed", expect.objectContaining({ action: expect.objectContaining({ label: "Undo" }) })));
  expect(vi.mocked(toast.info).mock.calls.at(-1)![1]).not.toHaveProperty("cancel");
  page.lifecycle.unmount(); bar.lifecycle.unmount();
});

test("with Move to summary off, Finish review's row for a comment on an older diff offers to show it, and nothing more", async () => {
  restores.push(desktopWindow());
  const { page, bar } = await renderReview({ ...defaultKnobs, moveToSummary: false }, { getDraft: () => ({ draft: { targetKey: "pr-42", verdict: "COMMENT", body: "", comments: [{ file: "src/a.ts", line: 2, side: "RIGHT", body: "Upper case reads as a constant." }] }, stale: [{ file: "src/a.ts", line: 2, side: "RIGHT" }] }) });
  const commands = within(await bar.findByRole("group", { name: "Review commands" }));
  fireEvent.click(await commands.findByRole("button", { name: /^Finish review:/ }));
  await page.findByText("1 comment on an older diff: edit or remove it");
  expect(page.getByRole("button", { name: "Show the comments on an older diff" })).toBeTruthy();
  expect(page.queryByRole("button", { name: "Move to summary" })).toBeNull();
  page.lifecycle.unmount(); bar.lifecycle.unmount();
});

test("with Stop a guide while it builds off, neither the building card nor a rebuild's notice offers Stop", async () => {
  const app = await loadPluginApp(() => import("../app"));
  const state = { status: "generating", built: false };
  const base = settingsOffRpc(allKnobsOff);
  const rpc = settingsOffRpc(allKnobsOff, { getReviewBundle: () => {
    const bundle = base.getReviewBundle() as { review: object; guide: unknown };
    return { ...bundle, review: { ...bundle.review, status: state.status }, guide: state.built ? bundle.guide : null };
  } });
  const building = renderSlot(app.navPanels[0]!, { subPath: "pr-42" }, { rpc: rpc as any });
  await building.findByRole("status", { name: "Building the guide" });
  expect(building.queryByRole("button", { name: "Stop" })).toBeNull();
  building.lifecycle.unmount();
  Object.assign(state, { status: "ready", built: true });
  const workspace = renderSlot(app.navPanels[0]!, { subPath: "pr-42" }, { rpc: rpc as any });
  await workspace.findByRole("main", { name: "Review" });
  Object.assign(state, { status: "generating", built: false });
  await workspace.emitRealtime("review:pr-42", {});
  await workspace.findByText(/Updating the guide for the new commits/);
  expect(workspace.queryByRole("button", { name: "Stop" })).toBeNull();
  workspace.lifecycle.unmount();
});

test("with Dig deeper on a chapter off, a high-risk chapter's What to verify offers no Dig deeper", async () => {
  restores.push(desktopWindow());
  const base = settingsOffRpc(allKnobsOff);
  const getReviewBundle = () => {
    const bundle = base.getReviewBundle() as { guide: { sections: object[] } };
    return { ...bundle, guide: { ...bundle.guide, sections: bundle.guide.sections.map((section) => ({ ...section, focus: ["Check that upper case parses."] })) } };
  };
  for (const knobs of [defaultKnobs, { ...defaultKnobs, digDeeper: false }]) {
    const { page, bar, main } = await renderReview(knobs, { getReviewBundle });
    fireEvent.click(await main().findByRole("button", { name: "Start reading: Parsing" }));
    await page.findByRole("list", { name: "What to verify" });
    expect({ digDeeper: knobs.digDeeper, offered: !!page.queryByRole("button", { name: "Dig deeper" }) }).toEqual({ digDeeper: knobs.digDeeper, offered: knobs.digDeeper });
    page.lifecycle.unmount(); bar.lifecycle.unmount();
    cleanup(); localStorage.clear(); sessionStorage.clear();
  }
});

// In the code, check-failures.test.tsx: this file's diff draws no line annotations.
test("with Comment on or ask about a failing check off, the Overview's failing checks offer View check alone", async () => {
  restores.push(desktopWindow());
  const getChecks = () => ({ bucket: "fail", checks: [{ name: "test", bucket: "fail", state: "FAILURE", link: "https://github.com/acme/web/actions/runs/1/job/2" }] });
  const { page, bar, main } = await renderReview({ ...defaultKnobs, checkFailureActions: false }, { getChecks });
  const checks = within(await main().findByRole("list", { name: "Checks" }));
  expect(checks.getByRole("link", { name: /View check/ })).toBeTruthy();
  expect(checks.queryByRole("button")).toBeNull();
  expect(page.inspection.rpcCalls.some((call) => call.method === "getCheckLog")).toBe(false);
});

/** The review as a local one, of HEAD in /repo. */
function localBundle(review: Record<string, unknown> = {}) {
  const { review: { url: _url, repo: _repo, number: _number, ...rest }, ...bundle } = settingsOffRpc(allKnobsOff).getReviewBundle();
  return () => ({ ...bundle, review: { ...rest, kind: "ref", gitRef: "HEAD", cwd: "/repo", ...review } });
}

test("with every knob off, a local review never asks whether its code changed", async () => {
  const checkForUpdates = vi.fn(() => ({ hasNewCommits: false, localChanged: true }));
  const { page, bar } = await renderReview(allKnobsOff, { getReviewBundle: localBundle(), checkForUpdates });
  await page.findByRole("heading", { name: "Parse rows" });
  expect(checkForUpdates).not.toHaveBeenCalled();
  expect(page.queryByText("The code changed since this guide.")).toBeNull();
  page.lifecycle.unmount(); bar.lifecycle.unmount();
});

test("with every knob off, Finish review on a local review a thread started offers only Fix in a new thread, and no comment says it was sent", async () => {
  restores.push(desktopWindow());
  const getSourceThread = vi.fn(() => ({ thread: { threadId: "coder", title: "Retry uploads", state: "open" } }));
  const sent = { at: Date.now(), threadId: "coder", title: "Retry uploads", comments: [{ file: "src/a.ts", line: 2, side: "RIGHT", at: Date.now() }] };
  const { page, bar } = await renderReview(allKnobsOff, { getReviewBundle: localBundle({ sourceThreadId: "coder", sent }), getSourceThread });
  const commands = within(await bar.findByRole("group", { name: "Review commands" }));
  fireEvent.click(commands.getByRole("button", { name: "Comments" }));
  const panel = within(await page.findByRole("complementary", { name: "Comments and agent" }));
  await panel.findByText("Upper case reads as a constant.");
  fireEvent.click(panel.getByRole("button", { name: /^Expand .*src\/a\.ts:2/ }));
  expect(panel.getByRole("article", { name: "Draft comment on src/a.ts:2" }).textContent).not.toContain("Sent to");
  fireEvent.click(panel.getByRole("button", { name: "Finish review" }));
  expect(await page.findByRole("button", { name: "Fix in a new thread" })).toBeTruthy();
  expect(page.queryByRole("button", { name: /^Send/ })).toBeNull();
  expect(getSourceThread).not.toHaveBeenCalled();
  expect(page.queryByText(/Sent to/)).toBeNull();
  page.lifecycle.unmount(); bar.lifecycle.unmount();
});

test("with every knob off, a local review's files and comments offer no Open in editor, and never ask where the BB server is", async () => {
  const listMachines = vi.fn(() => ({ machines: [{ hostId: "server", name: "Server", connected: true, server: true }] }));
  const { page, bar, main } = await renderReview(allKnobsOff, { getReviewBundle: localBundle(), listMachines });
  fireEvent.click(await main().findByRole("button", { name: "Start reading: Parsing" }));
  await waitFor(() => expect(page.getAllByTestId("filediff")).toHaveLength(2));
  expect(page.queryByRole("link", { name: /in editor/ })).toBeNull();
  expect(page.queryByRole("button", { name: /^More on the comment/ })).toBeNull();
  expect(listMachines).not.toHaveBeenCalled();
  page.lifecycle.unmount(); bar.lifecycle.unmount();
});
