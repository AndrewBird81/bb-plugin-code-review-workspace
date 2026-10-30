// @vitest-environment jsdom
// The review page's tabs in BB's side panel: Review agent and Main thread, which show the review the page shows.
import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { defaultPreferences } from "../src/preferences";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() }, Toaster: () => null }));

const withdraws: (() => void)[] = [];
afterEach(() => { cleanup(); localStorage.clear(); withdraws.splice(0).forEach((withdraw) => withdraw()); });

const rpc = (over: Record<string, unknown> = {}) => ({
  getPreferences: () => ({ preferences: defaultPreferences, revision: 0 }),
  getConversation: vi.fn(() => ({ threadId: null, legacy: [], defaults: null })),
  getSourceThread: () => ({ thread: null }),
  ...over,
}) as any;

/** A review's page, published as its page publishes it: `local-a`, `api:feat/a`. */
async function publish(targetKey: string, over: Record<string, unknown> = {}) {
  const { publishWorkspace } = await import("../lib/workspace-store");
  const { testWorkspace } = await import("./draft-tray.test-support");
  withdraws.push(publishWorkspace(testWorkspace(targetKey, { reviewId: `api:${targetKey}`, review: { targetKey, kind: "ref" }, ...over })));
}

test("a review's page has Review agent and Main thread in BB's side panel, flush, the agent by its own sparkle", async () => {
  const app = await loadPluginApp(() => import("../app"));
  const tabs = app.tabs.filter((tab) => tab.context.kind === "nav-panel");
  expect(tabs.map(({ id, title, icon, layout, context, availability }) => ({ id, title, icon, layout, context, availability }))).toEqual([
    { id: "agent", title: "Review agent", icon: "code-review-workspace/agent", layout: "flush", context: { kind: "nav-panel", panelId: "review" }, availability: "fixed" },
    { id: "main", title: "Main thread", icon: "Code", layout: "flush", context: { kind: "nav-panel", panelId: "review" }, availability: "fixed" },
  ]);
});

test("Review agent shows beside a review, not All reviews or Settings; Main thread beside a review with one, or with Not pushed yet, and while its page loads", async () => {
  const app = await loadPluginApp(() => import("../app"));
  const visible = (id: string, subPath: string) => {
    const tab = app.tabs.find((registration) => registration.id === id)!;
    const probe = renderSlot({ component: () => <p>{String(tab.useVisible!({ subPath } as never))}</p> }, {}, {});
    const text = probe.container.textContent;
    probe.lifecycle.unmount();
    return text;
  };
  expect(["local-a", "", "settings/local-a"].map((subPath) => visible("agent", subPath))).toEqual(["true", "false", "false"]);
  // Loading: it shows, so a tab BB remembers doesn't blink; once the page shows without a guide, it doesn't.
  expect(visible("main", "local-a")).toBe("true");
  const { publishReviewTitle } = await import("../lib/workspace-store");
  const untitle = publishReviewTitle("local-a", { id: "api:local-a", name: "A", line: "api:local-a · A" });
  expect(visible("main", "local-a")).toBe("false");
  untitle();
  await publish("local-a");
  expect(visible("main", "local-a")).toBe("false");
  await publish("local-b", { mainThread: { threadId: "coder", title: "Build it", machine: null } });
  expect(visible("main", "local-b")).toBe("true");
  // Your PR whose main thread works in a folder has Not pushed yet there, with Send to thread off too.
  await publish("pr-c", { review: { targetKey: "pr-c", kind: "pr", mainThread: { threadId: "fixer", environmentId: "env1", origin: "fresh", since: 1 } } });
  expect(visible("main", "pr-c")).toBe("true");
});

test("the agent's tab says what it waits for: the review's page, or its guide; beside no review, either tab draws nothing", async () => {
  const app = await loadPluginApp(() => import("../app"));
  const { renderPanelTab } = await import("./panel-tabs.test-support");
  const loading = renderPanelTab(app, "agent", "local-a", { rpc: rpc() });
  expect(loading.getByRole("status").textContent).toBe("Opening the review…");
  // Its page shows it without a guide, as while one is built.
  const { publishReviewTitle } = await import("../lib/workspace-store");
  act(() => { withdraws.push(publishReviewTitle("local-a", { id: "api:local-a", name: "A", line: "api:local-a · A" })); });
  expect(loading.getByRole("status").textContent).toBe("This shows once the review’s guide is ready.");
  loading.lifecycle.unmount();
  const main = renderPanelTab(app, "main", "local-a", { rpc: rpc() });
  expect(main.getByRole("status").textContent).toBe("Opening the review…");
  main.lifecycle.unmount();
  for (const id of ["agent", "main"] as const) {
    const none = renderPanelTab(app, id, "", { rpc: rpc() });
    expect(none.container.innerHTML).toBe("");
    none.lifecycle.unmount();
  }
});

test("switching reviews switches the tabs: each shows the review the page shows, never the last one", async () => {
  await publish("local-a");
  await publish("local-b");
  const app = await loadPluginApp(() => import("../app"));
  const { renderPanelTab } = await import("./panel-tabs.test-support");
  const calls = rpc();
  const tab = renderPanelTab(app, "agent", "local-a", { rpc: calls });
  const heading = () => within(tab.getByRole("region", { name: "Review agent" })).getByRole("heading", { level: 2 }).textContent;
  await waitFor(() => expect(heading()).toBe("Review agent·api:local-a"));
  const { ReviewAgentTab } = await import("./PanelTabs");
  act(() => tab.lifecycle.rerender(<ReviewAgentTab subPath="local-b" />));
  await waitFor(() => expect(heading()).toBe("Review agent·api:local-b"));
  expect(calls.getConversation.mock.calls.map(([input]: [{ targetKey: string }]) => input.targetKey)).toEqual(["local-a", "local-b"]);
});
