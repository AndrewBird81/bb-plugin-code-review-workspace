// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { Turn } from "../lib/turn";

afterEach(() => { cleanup(); document.body.innerHTML = ""; localStorage.clear(); vi.useRealTimers(); });

/** BB's thread list as it draws its groups: wrappers in a container, each holding a group under its label. */
function threadList() {
  document.body.insertAdjacentHTML("beforeend", `<div data-bb-plugin-root data-bb-plugin="thread-list"><div data-testid="groups">
    <div><div data-sidebar-sticky-group><div data-sidebar="group-label">Pinned</div></div></div>
    <div data-sidebar-visibility-group="threads"><div data-sidebar-sticky-group><div data-sidebar="group-label">Threads</div></div></div>
  </div></div>`);
  return document.querySelector<HTMLElement>('[data-testid="groups"]')!;
}

const hour = 3_600_000;
const turn = (group: Turn["group"], reason: Turn["reason"], hoursAgo: number, blocking = false): Turn =>
  ({ group, reason, label: "", action: "", signal: null, at: Date.now() - hoursAgo * hour, notify: false, blocking, updated: false, eventAt: null, failed: false });
const reviews = [
  { targetKey: "pr-team", title: "Team request", repo: "acme/web", number: 3, status: "ready", turn: turn("needs", "team-requested", 30) },
  { targetKey: "pr-waiting", title: "Waiting on the author", status: "ready", turn: turn("waiting", "waiting", 1) },
  { targetKey: "pr-direct", title: "Direct request", repo: "acme/web", number: 1, status: "ready", turn: turn("needs", "requested", 2) },
  { targetKey: "pr-blocking", title: "Blocks merge", repo: "acme/web", number: 2, status: "ready", turn: turn("needs", "re-requested", 1, true) },
];

async function renderSidebar(list: unknown[] = reviews) {
  const app = await loadPluginApp(() => import("../app"));
  const overlay = app.appOverlays.find((registration) => registration.id === "needs-review")!;
  return renderSlot(overlay, {}, { rpc: { listReviews: () => ({ reviews: list }) } });
}

test("Needs review goes first in BB's thread list, with only the reviews waiting on you, in the tab's order", async () => {
  const groups = threadList();
  const slot = await renderSidebar();
  const section = await within(document.body).findByRole("region", { name: "Needs review" });
  expect(groups.firstElementChild!.contains(section)).toBe(true);
  expect(groups.children).toHaveLength(3);
  const rows = within(section).getAllByRole("link");
  expect(rows.map((row) => row.textContent)).toEqual(["Blocks merge1h", "Direct request2h", "Team request1d"]);
  expect(within(section).getByRole("button", { name: /Needs review/ }).textContent).toContain("3");
  slot.lifecycle.unmount();
  expect(groups.children).toHaveLength(2);
});

test("a row opens its review and closes the phone sidebar; a modified click is left to the link", async () => {
  threadList();
  document.body.insertAdjacentHTML("beforeend", `<div data-sidebar="panel" role="dialog" data-state="open"><button data-sidebar="trigger">Toggle Sidebar</button></div>`);
  let toggled = 0;
  document.querySelector('[data-sidebar="trigger"]')!.addEventListener("click", () => { toggled++; });
  const slot = await renderSidebar();
  const row = await within(document.body).findByRole("link", { name: /Direct request/ });
  expect(row.getAttribute("href")).toBe("/plugins/test-plugin/review/pr-direct");
  // What the row left to the link, before jsdom, which can't follow links, is stopped.
  const leftToLink: boolean[] = [];
  document.addEventListener("click", (event) => { if (event.target !== row) return; leftToLink.push(!event.defaultPrevented); event.preventDefault(); });
  fireEvent.click(row, { metaKey: true });
  expect(leftToLink).toEqual([true]);
  expect(slot.inspection.navigateCalls).toHaveLength(0);
  fireEvent.click(row);
  expect(slot.inspection.navigateCalls).toEqual([{ method: "toPluginPanel", path: "review", options: { subPath: "pr-direct" } }]);
  expect(leftToLink).toEqual([true, false]);
  expect(toggled).toBe(1);
  slot.lifecycle.unmount();
});

test("it collapses like Pinned and Threads, and stays collapsed", async () => {
  threadList();
  const slot = await renderSidebar();
  const header = await within(document.body).findByRole("button", { name: /Needs review/ });
  expect(header.getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(header);
  expect(header.getAttribute("aria-expanded")).toBe("false");
  expect(within(document.body).queryByRole("link")).toBeNull();
  slot.lifecycle.unmount();
  const again = await renderSidebar();
  expect((await within(document.body).findByRole("button", { name: /Needs review/ })).getAttribute("aria-expanded")).toBe("false");
  again.lifecycle.unmount();
});

test("it goes back in when the thread list redraws its groups", async () => {
  const groups = threadList();
  const slot = await renderSidebar();
  await within(document.body).findByRole("region", { name: "Needs review" });
  // The list replaces its container, as when it reloads.
  const fresh = groups.cloneNode(true) as HTMLElement;
  fresh.firstElementChild!.remove();
  groups.replaceWith(fresh);
  await waitFor(() => expect(within(fresh).getByRole("region", { name: "Needs review" })).toBeTruthy());
  expect(fresh.firstElementChild!.querySelector('[aria-label="Needs review"]')).toBeTruthy();
  slot.lifecycle.unmount();
});

test("with nothing waiting on you there's no group, and it appears when a review needs you", async () => {
  const groups = threadList();
  let list: unknown[] = [reviews[1]];
  const app = await loadPluginApp(() => import("../app"));
  const overlay = app.appOverlays.find((registration) => registration.id === "needs-review")!;
  const slot = renderSlot(overlay, {}, { rpc: { listReviews: () => ({ reviews: list }) } });
  await waitFor(() => expect(slot.inspection.rpcCalls.some((call) => call.method === "listReviews")).toBe(true));
  // Out of BB's list altogether while empty.
  expect(groups.children).toHaveLength(2);
  expect(within(document.body).queryByRole("region", { name: "Needs review" })).toBeNull();
  list = reviews;
  await slot.emitRealtime("reviews", {});
  const section = await within(document.body).findByRole("region", { name: "Needs review" }, { timeout: 2000 });
  expect(groups.firstElementChild!.contains(section)).toBe(true);
  list = [reviews[1]];
  await slot.emitRealtime("reviews", {});
  await waitFor(() => expect(groups.children).toHaveLength(2), { timeout: 2000 });
  slot.lifecycle.unmount();
});

test("without BB's thread list it shows nowhere", async () => {
  const slot = await renderSidebar();
  await waitFor(() => expect(slot.inspection.rpcCalls.some((call) => call.method === "listReviews")).toBe(true));
  expect(within(document.body).queryByRole("region", { name: "Needs review" })).toBeNull();
  slot.lifecycle.unmount();
});

test("how long each has waited keeps up while the page stays open", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  threadList();
  const slot = await renderSidebar([reviews[2]]);
  const row = await within(document.body).findByRole("link", { name: /Direct request/ });
  expect(row.textContent).toBe("Direct request2h");
  await vi.advanceTimersByTimeAsync(3_600_000);
  expect(row.textContent).toBe("Direct request3h");
  slot.lifecycle.unmount();
});
