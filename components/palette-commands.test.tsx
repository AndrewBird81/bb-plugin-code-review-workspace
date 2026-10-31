// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginCommandRegistration } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { Turn } from "../lib/turn";
import { defaultPreferences } from "../src/preferences";
import { defaultKnobs } from "../lib/knobs";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() }, Toaster: () => null }));

afterEach(() => { cleanup(); localStorage.clear(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

const turn = (group: Turn["group"], reason: Turn["reason"], hoursAgo: number, blocking = false): Turn =>
  ({ group, reason, label: "", signal: null, at: Date.now() - hoursAgo * 3_600_000, notify: false, blocking, updated: false, eventAt: null, failed: false });
const reviews = [
  { targetKey: "pr-team", title: "Team request", repo: "acme/web", number: 3, status: "ready", turn: turn("needs", "team-requested", 30) },
  { targetKey: "pr-waiting", title: "Waiting on the author", repo: "acme/web", number: 4, status: "ready", turn: turn("waiting", "waiting", 1) },
  { targetKey: "pr-blocking", title: "Blocks merge", repo: "acme/web", number: 2, status: "ready", turn: turn("needs", "re-requested", 1, true) },
];
const context = { threadId: null, projectId: null, experimental_panel: { openTab: () => false, toggleTab: () => false, close: () => false } };

/** The plugin's palette commands, by id, and its app overlay, which handles them, mounted with these RPCs. */
async function load(rpc: Record<string, (input: any) => unknown> = {}, paletteCommands = true) {
  const app = await loadPluginApp(() => import("../app"));
  // The test runtime collects app.commands.register's commands, though its type doesn't list them yet.
  const commands = (app as unknown as { commandPaletteActions: (PluginCommandRegistration & { target: string })[] }).commandPaletteActions;
  const command = (id: string) => commands.find((entry) => entry.id === id)!;
  const mount = (pluginId?: string) => renderSlot(app.appOverlays.find((registration) => registration.id === "needs-review")!, {}, { ...pluginId ? { pluginId } : {}, rpc: {
    listReviews: () => ({ reviews }),
    startReview: () => ({ ok: true, targetKey: "pr-7" }),
    getPreferences: () => ({ preferences: { ...defaultPreferences, threadListReviews: false, knobs: { ...defaultKnobs, paletteCommands } }, revision: 0 }),
    ...rpc,
  } as any, sidebarThreads: { status: "ready", threads: [] } });
  return { commands, command, mount };
}

test("the four commands are in BB's palette with their ids and titles: Next review that needs me has ⌘⇧U, Switch ⌘⇧.", async () => {
  const { commands } = await load();
  expect(commands.map(({ target, id, title, defaultShortcut }) => ({ target, id, title, defaultShortcut }))).toEqual([
    { target: "app", id: "next-review", title: "Code Review Workspace: Next review that needs me", defaultShortcut: { key: "u", mod: true, shift: true, meta: false, control: false, alt: false } },
    { target: "app", id: "review-from-clipboard", title: "Code Review Workspace: Review PR from clipboard", defaultShortcut: null },
    { target: "app", id: "all-reviews", title: "Code Review Workspace: All reviews", defaultShortcut: null },
    { target: "app", id: "switch-review-thread", title: "Code Review Workspace: Switch between review and main thread", defaultShortcut: { key: ".", mod: true, shift: true, meta: false, control: false, alt: false } },
  ]);
});

test("the default keys are ones neither BB nor a browser takes with mod and shift", async () => {
  // BB 0.46.0's own mod+shift defaults (desktop, and 1–9 on the web off a Mac), and the keys Chrome, Safari, Firefox and
  // Electron's default menu bind with mod+shift, Force Reload's R among them: BB nulls a plugin default that collides
  // with its own, and a browser's or BB desktop's takes the key before the palette sees it.
  const bb = ["p", "o", "[", "]", "e", "x", "t", "enter", "c", "m", "n", ..."123456789"];
  const browsers = [..."abcdfghijklmnopqrstvwxyz"];
  // Shifted, "/" is macOS's Help menu, "\\" Safari's tab overview and "`" the window before.
  const punctuation = ["/", "\\", "`"];
  const { command } = await load();
  for (const id of ["next-review", "switch-review-thread"]) {
    const shortcut = command(id).defaultShortcut!;
    expect(shortcut).toMatchObject({ mod: true, shift: true, alt: false });
    expect([...bb, ...browsers, ...punctuation]).not.toContain(shortcut.key.toLowerCase());
  }
  expect(command("next-review").defaultShortcut!.key).not.toBe(command("switch-review-thread").defaultShortcut!.key);
});

test("the commands are listed while the overlay that runs them is mounted, and not with their switch off", async () => {
  const on = await load();
  // No overlay, as on a host without app overlays: nothing would run them.
  expect(on.commands.map((command) => command.isAvailable!(context))).toEqual([false, false, false, false]);
  const slot = on.mount();
  // Switch, too, once there's a review or a main thread to switch to (below).
  expect(on.commands.map((command) => command.isAvailable!(context))).toEqual([true, true, true, false]);
  slot.lifecycle.unmount();
  expect(on.command("next-review").isAvailable!(context)).toBe(false);

  const off = await load({}, false);
  const offSlot = off.mount();
  await waitFor(() => expect(off.commands.map((command) => command.isAvailable!(context))).toEqual([false, false, false, false]));
  offSlot.lifecycle.unmount();
  // Back on, they're listed again once the overlay loads its settings.
  const again = (await load()).mount();
  await waitFor(() => expect(on.command("all-reviews").isAvailable!(context)).toBe(true));
  again.lifecycle.unmount();
});

test("Next review that needs me opens the first review in Needs review's order, or says nothing needs you", async () => {
  const { command, mount } = await load();
  const slot = mount();
  await command("next-review").run(context);
  await waitFor(() => expect(slot.inspection.navigateCalls).toEqual([{ method: "toPluginPanel", path: "review", options: { subPath: "pr-blocking" } }]));
  slot.lifecycle.unmount();

  const none = await load({ listReviews: () => ({ reviews: [reviews[1]] }) });
  const empty = none.mount();
  await none.command("next-review").run(context);
  await waitFor(() => expect(toast.info).toHaveBeenCalledWith("Nothing needs you."));
  expect(empty.inspection.navigateCalls).toEqual([]);
  empty.lifecycle.unmount();
});

test("Review PR from clipboard opens a listed PR's review, starts one for another PR link, and says when the clipboard has none", async () => {
  let clipboard = "https://github.com/acme/web/pull/7/files";
  vi.stubGlobal("navigator", { ...navigator, clipboard: { readText: async () => clipboard } });
  let started = false;
  const { command, mount } = await load({
    listReviews: () => ({ reviews: started ? [...reviews, { targetKey: "pr-7", title: "Fix cache keys", repo: "acme/web", number: 7, status: "generating" }] : reviews }),
    startReview: () => { started = true; return { ok: true, targetKey: "pr-7" }; },
  });
  const slot = mount();
  const run = () => command("review-from-clipboard").run(context);
  await run();
  // It names the PR it started, from the list, and leaves opening it to Open.
  await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Started a review of acme/web#7: Fix cache keys", { action: { label: "Open", onClick: expect.any(Function) } }));
  expect(slot.inspection.rpcCalls.filter((call) => call.method === "startReview").map((call) => call.input)).toEqual([{ input: "https://github.com/acme/web/pull/7" }]);
  expect(slot.inspection.navigateCalls).toEqual([]);
  (vi.mocked(toast.success).mock.calls[0][1] as any).action.onClick();
  expect(slot.inspection.navigateCalls).toEqual([{ method: "toPluginPanel", path: "review", options: { subPath: "pr-7" } }]);

  clipboard = "acme/web#4";
  await run();
  await waitFor(() => expect(slot.inspection.navigateCalls).toHaveLength(2));
  expect(slot.inspection.navigateCalls[1]).toEqual({ method: "toPluginPanel", path: "review", options: { subPath: "pr-waiting" } });
  expect(slot.inspection.rpcCalls.filter((call) => call.method === "startReview")).toHaveLength(1);
  expect(toast.success).toHaveBeenCalledTimes(1);

  clipboard = "Fix the token refresh";
  await run();
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith("The clipboard has no PR link."));
  expect(slot.inspection.navigateCalls).toHaveLength(2);
  expect(slot.inspection.rpcCalls.filter((call) => call.method === "startReview")).toHaveLength(1);
  slot.lifecycle.unmount();
});

test("Review PR from clipboard says when the clipboard can't be read, or the review can't start", async () => {
  vi.stubGlobal("navigator", { ...navigator, clipboard: { readText: async () => { throw new DOMException("Denied", "NotAllowedError"); } } });
  const { command, mount } = await load({ startReview: () => ({ ok: false, error: "Couldn’t read acme/web#9 on GitHub." }) });
  const slot = mount();
  await command("review-from-clipboard").run(context);
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Couldn’t read the clipboard."));
  vi.stubGlobal("navigator", { ...navigator, clipboard: { readText: async () => "acme/web#9" } });
  await command("review-from-clipboard").run(context);
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Couldn’t read acme/web#9 on GitHub."));
  expect(slot.inspection.navigateCalls).toEqual([]);
  slot.lifecycle.unmount();
});

test("Review PR from clipboard names a started PR by its number when the list doesn't have its title", async () => {
  vi.stubGlobal("navigator", { ...navigator, clipboard: { readText: async () => "acme/web#7" } });
  const { command, mount } = await load();
  const slot = mount();
  await command("review-from-clipboard").run(context);
  await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Started a review of acme/web#7", { action: { label: "Open", onClick: expect.any(Function) } }));
  expect(slot.inspection.navigateCalls).toEqual([]);
  slot.lifecycle.unmount();
});

test("All reviews opens the review list", async () => {
  const { command, mount } = await load();
  const slot = mount();
  await command("all-reviews").run(context);
  expect(slot.inspection.navigateCalls).toEqual([{ method: "toPluginPanel", path: "review" }]);
  slot.lifecycle.unmount();
});

test("Switch between review and main thread goes from a thread's page to its review, and from a review's page to its main thread", async () => {
  const { command, mount } = await load();
  // Installed under another id, as a development copy is: its pages' addresses say so.
  const overlay = mount("code-review-workspace-dev");
  const switcher = command("switch-review-thread");
  // A thread's page, once its tab has read which review it's linked to: the folder's review here.
  const { useReviewTabVisible } = await import("./ThreadSurfaces");
  const page = renderSlot({ component: () => { useReviewTabVisible({ threadId: "coder", environment: { id: "env1" } }); return null; } }, {}, { rpc: {
    getPreferences: () => ({ preferences: defaultPreferences, revision: 0 }),
    threadLinks: () => ({ reviewChangesLine: true, reviews: [{ targetKey: "local-1", createdAt: 1, main: null, threads: [], folder: { environmentId: "env1", branch: "feat/x", paused: false } }], agents: ["agent-thread"] }),
  } as any });
  const onThread = { ...context, threadId: "coder" };
  await waitFor(() => expect(switcher.isAvailable!(onThread)).toBe(true));
  await switcher.run(onThread);
  expect(overlay.inspection.navigateCalls.at(-1)).toEqual({ method: "toPluginPanel", path: "review", options: { subPath: "local-1" } });
  // Not on a thread with no review, nor on the plugin's own agents' threads.
  expect(switcher.isAvailable!({ ...context, threadId: "other" })).toBe(false);
  expect(switcher.isAvailable!({ ...context, threadId: "agent-thread" })).toBe(false);
  page.lifecycle.unmount();

  // A review's page, which publishes its workspace with its main thread.
  const { publishWorkspace } = await import("../lib/workspace-store");
  const { testWorkspace } = await import("./draft-tray.test-support");
  history.pushState(null, "", "/plugins/code-review-workspace-dev/review/local-1");
  expect(switcher.isAvailable!(context)).toBe(false);
  const withdraw = publishWorkspace(testWorkspace("local-1", { mainThread: { threadId: "coder", title: "Build it", machine: null } }));
  expect(switcher.isAvailable!(context)).toBe(true);
  await switcher.run(context);
  expect(overlay.inspection.navigateCalls.at(-1)).toEqual({ method: "toThread", threadId: "coder" });
  withdraw();
  // No main thread, or All reviews: nothing to switch to.
  const none = publishWorkspace(testWorkspace("local-1"));
  expect(switcher.isAvailable!(context)).toBe(false);
  none();
  history.pushState(null, "", "/plugins/code-review-workspace-dev/review");
  expect(switcher.isAvailable!(context)).toBe(false);
  // Of two panes, the review you last worked in, whatever the address says.
  const { useReviewInUse } = await import("../lib/workspace-store");
  const { useState } = await import("react");
  const first = publishWorkspace(testWorkspace("local-1", { mainThread: { threadId: "coder", title: "Build it", machine: null } }));
  const second = publishWorkspace(testWorkspace("local-2", { mainThread: { threadId: "other", title: "Other", machine: null } }));
  history.pushState(null, "", "/plugins/code-review-workspace-dev/review/local-1");
  const pane = renderSlot({ component: () => { const [el, setEl] = useState<HTMLElement | null>(null); useReviewInUse("local-2", el); return <div ref={setEl}><button>In the other pane</button></div>; } }, {}, {});
  fireEvent.pointerDown(pane.getByRole("button", { name: "In the other pane" }));
  await switcher.run(context);
  expect(overlay.inspection.navigateCalls.at(-1)).toEqual({ method: "toThread", threadId: "other" });
  // Gone, the address decides again.
  pane.lifecycle.unmount();
  await switcher.run(context);
  expect(overlay.inspection.navigateCalls.at(-1)).toEqual({ method: "toThread", threadId: "coder" });
  first(); second();
  // Another install's page isn't this one's.
  const again = publishWorkspace(testWorkspace("local-1", { mainThread: { threadId: "coder", title: "Build it", machine: null } }));
  history.pushState(null, "", "/plugins/code-review-workspace/review/local-1");
  expect(switcher.isAvailable!(context)).toBe(false);
  again();
  overlay.lifecycle.unmount();
});
