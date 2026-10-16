// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { defaultPreferences } from "../src/preferences";
import { TITLE_BAR_WAIT_MS } from "../lib/title-bar";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
const restores: (() => void)[] = [];
afterEach(() => { cleanup(); sessionStorage.clear(); localStorage.clear(); restores.splice(0).forEach((restore) => restore()); vi.useRealTimers(); });

/** Time running as it does, but the title bar's wait passed at once. */
const fakeTime = () => vi.useFakeTimers({ shouldAdvanceTime: true });
const pastTitleBarWait = () => act(() => { vi.advanceTimersByTime(TITLE_BAR_WAIT_MS); });

/** Every ResizeObserver reports this size, as the page measures itself; `resize` reports another, as a fold does. */
function fakeSize(width: number, height: number) {
  const original = globalThis.ResizeObserver;
  const observed: Array<{ notify: ResizeObserverCallback; target: Element; observer: ResizeObserver }> = [];
  const report = ({ notify, target, observer }: (typeof observed)[number]) => notify([{ target, contentRect: { width, height } } as unknown as ResizeObserverEntry], observer);
  globalThis.ResizeObserver = class {
    constructor(private notify: ResizeObserverCallback) {}
    observe(target: Element) { const entry = { notify: this.notify, target, observer: this as unknown as ResizeObserver }; observed.push(entry); report(entry); }
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  restores.push(() => { globalThis.ResizeObserver = original; });
  return { resize(w: number, h: number) { width = w; height = h; act(() => observed.forEach(report)); } };
}

const reviews = [{ targetKey: "pr-7", kind: "pr", repo: "acme/web", number: 7, title: "Change Seven", status: "ready" }];

/** All reviews and BB's title bar, as the host renders them: the bar apart from the page, with the panel's headerContent. */
async function renderList(rpc: Record<string, (input: any) => unknown> = {}, { titleBar = true } = {}) {
  const app = await loadPluginApp(() => import("../app"));
  const handlers = {
    setReviewPresence: () => ({ ok: true }),
    getPreferences: () => ({ preferences: defaultPreferences, revision: 0 }),
    listReviews: () => ({ reviews, sync: { lastReadAt: Date.now() - 2 * 60_000, error: null } }),
    refreshReviews: () => ({ reviews, sync: { lastReadAt: Date.now(), error: null } }),
    ...rpc,
  } as any;
  const bar = titleBar ? renderSlot({ component: app.navPanels[0]!.headerContent! }, { subPath: "" }, { rpc: handlers }) : null;
  const page = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: handlers });
  await page.findByText("Change Seven");
  return { bar, page };
}

test("on All reviews BB's title bar has Refresh and Settings, and Settings opens Settings; on Settings it has nothing", async () => {
  fakeTime();
  const { bar, page } = await renderList();
  const commands = within(await bar!.findByRole("group", { name: "Review list commands" }));
  expect(commands.getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual(["Refresh", "Settings"]);
  fireEvent.click(commands.getByRole("button", { name: "Settings" }));
  expect(bar!.inspection.navigateCalls).toEqual([{ method: "toPluginPanel", path: "review", options: { subPath: "settings" } }]);
  // The page has its own find box, and no controls of its own beside it.
  expect(page.getByRole("searchbox", { name: "Find a review, or paste a PR link" })).toBeTruthy();
  pastTitleBarWait();
  expect(within(page.container).queryByRole("group", { name: "Review list commands" })).toBeNull();
  page.lifecycle.unmount(); bar!.lifecycle.unmount();
  const app = await loadPluginApp(() => import("../app"));
  for (const subPath of ["settings", "settings/pr-7"]) {
    const slot = renderSlot({ component: app.navPanels[0]!.headerContent! }, { subPath }, { rpc: {} as any });
    expect(slot.container.innerHTML).toBe("");
    slot.lifecycle.unmount();
  }
});

test("Refresh reads all of GitHub, and says so while it does", async () => {
  let finish!: () => void;
  const { bar, page } = await renderList({
    refreshReviews: () => new Promise((resolve) => { finish = () => resolve({ reviews, sync: { lastReadAt: Date.now(), error: null } }); }),
  });
  fireEvent.click(await bar!.findByRole("button", { name: "Refresh" }));
  const busy = await bar!.findByRole("button", { name: "Refreshing…" });
  expect(busy.hasAttribute("disabled")).toBe(true);
  expect(page.inspection.rpcCalls.filter((call) => call.method === "refreshReviews").map((call) => call.input)).toEqual([{ force: true }]);
  finish();
  await bar!.findByRole("button", { name: "Refresh" });
});

test("on a phone the title bar has three buttons at most: Find a review opens the page's box with the focus in it", async () => {
  fakeSize(390, 796);
  const { bar, page } = await renderList();
  const commands = within(await bar!.findByRole("group", { name: "Review list commands" }));
  const buttons = await waitFor(() => { const all = commands.getAllByRole("button"); expect(all).toHaveLength(3); return all; });
  expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual(["Find a review", "Refresh", "Settings"]);
  // 36px on a coarse pointer, inside 44px targets: three fit BB's 150px with room to spare.
  for (const button of buttons) expect(button.className).toContain("pointer-coarse:h-9");
  expect(page.queryByRole("searchbox")).toBeNull();
  fireEvent.click(commands.getByRole("button", { name: "Find a review" }));
  const box = page.getByRole("searchbox", { name: "Find a review, or paste a PR link" });
  expect(document.activeElement).toBe(box);
  expect(box.getAttribute("placeholder")).toBe("Find or paste a PR link");
  expect(commands.getByRole("button", { name: "Find a review" }).getAttribute("aria-expanded")).toBe("true");
  fireEvent.change(box, { target: { value: "seven" } });
  fireEvent.click(page.getByRole("button", { name: "Cancel" }));
  expect(page.queryByRole("searchbox")).toBeNull();
  expect(page.getByText("Change Seven")).toBeTruthy();
});

test("without BB's title bar the page shows the list's controls itself, after a moment", async () => {
  fakeTime();
  const { page } = await renderList({}, { titleBar: false });
  expect(page.queryByRole("group", { name: "Review list commands" })).toBeNull();
  pastTitleBarWait();
  const commands = within(page.getByRole("group", { name: "Review list commands" }));
  expect(commands.getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual(["Refresh", "Settings"]);
  // Full-size targets on the page.
  for (const button of commands.getAllByRole("button")) expect(button.className).toContain("pointer-coarse:h-11");
});

test("the page's own Refresh and Settings leave a PR link typed in the find box alone", async () => {
  fakeTime();
  const { page } = await renderList({ startReview: () => ({ ok: true, targetKey: "pr-8" }) }, { titleBar: false });
  pastTitleBarWait();
  const commands = within(page.getByRole("group", { name: "Review list commands" }));
  fireEvent.change(page.getByRole("searchbox", { name: "Find a review, or paste a PR link" }), { target: { value: "acme/web#8" } });
  fireEvent.click(commands.getByRole("button", { name: "Refresh" }));
  await waitFor(() => expect(page.inspection.rpcCalls.filter((call) => call.method === "refreshReviews")).toHaveLength(1));
  fireEvent.click(await commands.findByRole("button", { name: "Settings" }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(page.inspection.rpcCalls.filter((call) => call.method === "startReview")).toEqual([]);
  expect(page.inspection.navigateCalls).toEqual([{ method: "toPluginPanel", path: "review", options: { subPath: "settings" } }]);
  expect(page.getByRole("button", { name: /Review acme\/web#8/ })).toBeTruthy();
});

test("folding and unfolding a Duo keeps the find box, what's typed in it, and its focus", async () => {
  const size = fakeSize(951, 541);
  const { bar, page } = await renderList();
  const box = page.getByRole("searchbox", { name: "Find a review, or paste a PR link" }) as HTMLInputElement;
  box.focus();
  fireEvent.change(box, { target: { value: "seven" } });
  // Folded: the box opens at the top of the page, as from the title bar's Find, the same box.
  size.resize(382, 550);
  expect(page.getByRole("searchbox", { name: "Find a review, or paste a PR link" })).toBe(box);
  expect(document.activeElement).toBe(box);
  expect(box.value).toBe("seven");
  expect(within(bar!.container).getByRole("button", { name: "Find a review" })).toBeTruthy();
  size.resize(951, 541);
  expect(page.getByRole("searchbox", { name: "Find a review, or paste a PR link" })).toBe(box);
  expect(document.activeElement).toBe(box);
  expect(within(bar!.container).queryByRole("button", { name: "Find a review" })).toBeNull();
});
