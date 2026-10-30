// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { Turn } from "../lib/turn";
import { defaultPreferences } from "../src/preferences";
import { shortNames } from "./NeedsReviewSidebar";

afterEach(() => { cleanup(); document.body.innerHTML = ""; localStorage.clear(); vi.useRealTimers(); });

/** BB's thread list as it draws its groups: wrappers in a container, each holding a group under its label; Pinned's header doesn't stick. */
function threadList(pinned: "open" | "collapsed" | "none" = "open") {
  const rows = pinned === "open" ? `<div class="mt-1"><div data-sidebar-sticky-section data-testid="pinned-rows"><div>Per's PR's</div><div>Docs PR</div></div></div>` : "";
  document.body.insertAdjacentHTML("beforeend", `<div data-bb-plugin-root data-bb-plugin="thread-list"><div data-testid="groups">
    ${pinned === "none" ? "" : `<div><div data-sidebar-sticky-group data-sidebar-sticky-header="false"><div data-sidebar="group-label">Pinned</div>${rows}</div></div>`}
    <div data-sidebar-visibility-group="threads"><div data-sidebar-sticky-group><div data-sidebar="group-label">Threads</div></div></div>
  </div></div>`);
  return document.querySelector<HTMLElement>('[data-testid="groups"]')!;
}
/** A pinned BB thread, so BB draws its Pinned group. */
const pinnedThread = { id: "thr-1", title: "Per's PR's", isPinned: true, isArchived: false, isHidden: false } as any;

const hour = 3_600_000;
const turn = (group: Turn["group"], reason: Turn["reason"], hoursAgo: number, blocking = false): Turn =>
  ({ group, reason, label: "", signal: null, at: Date.now() - hoursAgo * hour, notify: false, blocking, updated: false, eventAt: null, failed: false });
const reviews = [
  { targetKey: "pr-team", title: "Team request", repo: "acme/web", number: 3, status: "ready", turn: turn("needs", "team-requested", 30) },
  { targetKey: "pr-waiting", title: "Waiting on the author", status: "ready", turn: turn("waiting", "waiting", 1) },
  { targetKey: "pr-direct", title: "Direct request", repo: "acme/web", number: 1, status: "ready", turn: turn("needs", "requested", 2) },
  { targetKey: "pr-blocking", title: "Blocks merge", repo: "acme/web", number: 2, status: "ready", turn: turn("needs", "re-requested", 1, true) },
];

/** Settings as saved: reviews in the thread list unless a test turns them off. */
const settings = (threadListReviews = true) => ({ preferences: { ...defaultPreferences, threadListReviews }, revision: 0 });

async function renderSidebar(list: unknown[] = reviews, threads: unknown[] = [pinnedThread], status: "ready" | "loading" = "ready") {
  const app = await loadPluginApp(() => import("../app"));
  const overlay = app.appOverlays.find((registration) => registration.id === "needs-review")!;
  return renderSlot(overlay, {}, { rpc: { listReviews: () => ({ reviews: list }), pinReview: () => ({ ok: true }), getPreferences: () => settings() }, sidebarThreads: { status, threads: threads as any } });
}

test("Needs review goes last in BB's thread list, below Threads, with only the reviews waiting on you, in the tab's order", async () => {
  const groups = threadList();
  const slot = await renderSidebar();
  const section = await within(document.body).findByRole("region", { name: "Needs review" });
  expect(groups.lastElementChild!.contains(section)).toBe(true);
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

test("a row's tooltip says where the PR is, why it's yours and for how long, as its description does; its pin hides at rest, and on touch for good", async () => {
  threadList();
  const slot = await renderSidebar([{ ...reviews[2], signals: { requestedBy: "alice" } }]);
  const row = await within(document.body).findByRole("link", { name: /Direct request/ });
  expect(row.getAttribute("title")).toBe("acme/web#1 · Requested by @alice · 2h");
  const pin = within(document.body).getByRole("button", { name: "Pin Direct request" });
  // Touch and screen readers get no tooltip, so the row says where and why in words too.
  expect(within(document.body).getByRole("link", { name: /Direct request/, description: "acme/web#1, Requested by @alice" })).toBe(row);
  // A screen that can't hover keeps its rows clear, as BB's own are; the review's menu pins it.
  expect(pin.className.split(" ")).toEqual(expect.arrayContaining(["[@media(hover:hover)]:opacity-0", "group-hover/row:opacity-100", "[@media(hover:none)]:hidden"]));
  slot.lifecycle.unmount();
});

test("a row is its name alone, the PR's repository and number in its tooltip; two of one name are told apart by number, branch or folder", async () => {
  threadList();
  const slot = await renderSidebar([reviews[2], { targetKey: "ref-1", kind: "ref", gitRef: "HEAD", title: "Local work", status: "ready", turn: turn("needs", "requested", 1) }]);
  const row = await within(document.body).findByRole("link", { name: "Direct request 2h" });
  expect(row.getAttribute("title")).toBe("acme/web#1 · Review requested · 2h");
  expect(within(document.body).getByRole("link", { name: "Local work 1h" })).toBeTruthy();
  slot.lifecycle.unmount();
  cleanup();
  // Two PRs of one name: their numbers, muted.
  threadList();
  const prs = await renderSidebar([reviews[2], { ...reviews[0], title: "Direct request" }]);
  expect(await within(document.body).findByRole("link", { name: "#1 Direct request 2h" })).toBeTruthy();
  expect(within(within(document.body).getByRole("link", { name: "#3 Direct request 1d" })).getByText("#3").className).toContain("text-muted-foreground");
  prs.lifecycle.unmount();
  cleanup();
  // Two local reviews of one name: their branches, or where they share one, the folder's end the id adds.
  threadList();
  const local = await renderSidebar([
    { targetKey: "ref-1", kind: "ref", gitRef: "HEAD", title: "Local work", status: "ready", turn: turn("needs", "new", 1) },
    { targetKey: "br-2", kind: "ref", gitRef: "feat", title: "Local work", status: "ready", turn: turn("needs", "new", 1), place: { folder: "web-wt" } },
    // A long folder end is cut in the middle, so the name keeps its room.
    { targetKey: "br-3", kind: "ref", gitRef: "feat", title: "Local work", status: "ready", turn: turn("needs", "new", 1), place: { folder: "thr_abcdef123456-1/web-frontend" } },
  ]);
  expect(await within(document.body).findByRole("link", { name: "HEAD Local work 1h" })).toBeTruthy();
  expect(within(document.body).getByRole("link", { name: "(web-wt) Local work 1h" })).toBeTruthy();
  expect(within(document.body).getByRole("link", { name: "(thr_abc…frontend) Local work 1h" })).toBeTruthy();
  local.lifecycle.unmount();
  cleanup();
  // A long branch by its last part, cut in the middle; two whose last parts match keep enough to tell them apart.
  threadList();
  const branches = await renderSidebar([
    { targetKey: "ref-2", kind: "ref", gitRef: "main...feature/snooze-flaky-checks-on-retries", title: "Fix login", status: "ready", turn: turn("needs", "new", 1) },
    ...["alice", "bob"].map((who) => ({ targetKey: `ref-${who}`, kind: "ref", gitRef: `main...${who}/fix-login`, title: "Fix login", status: "ready", turn: turn("needs", "new", 1) })),
  ]);
  expect(await within(document.body).findByRole("link", { name: "snooze-…-retries Fix login 1h" })).toBeTruthy();
  expect(within(document.body).getByRole("link", { name: "alice/fix-login Fix login 1h" })).toBeTruthy();
  expect(within(document.body).getByRole("link", { name: "bob/fix-login Fix login 1h" })).toBeTruthy();
  branches.lifecycle.unmount();
});

test("a renamed review's row says your name, with the PR's title first in its tooltip and description", async () => {
  threadList();
  const slot = await renderSidebar([{ ...reviews[2], name: "Requests rework", signals: { requestedBy: "alice" } }]);
  const row = await within(document.body).findByRole("link", { name: /Requests rework/ });
  expect(row.getAttribute("title")).toBe("Direct request · acme/web#1 · Requested by @alice · 2h");
  expect(within(document.body).getByRole("link", { name: /Requests rework/, description: "Direct request, acme/web#1, Requested by @alice" })).toBe(row);
  expect(within(document.body).getByRole("button", { name: "Pin Requests rework" })).toBeTruthy();
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
  fresh.lastElementChild!.remove();
  groups.replaceWith(fresh);
  await waitFor(() => expect(within(fresh).getByRole("region", { name: "Needs review" })).toBeTruthy());
  expect(fresh.lastElementChild!.querySelector('[aria-label="Needs review"]')).toBeTruthy();
  slot.lifecycle.unmount();
});

test("it stays last when the thread list adds a group after it", async () => {
  const groups = threadList();
  const slot = await renderSidebar();
  const section = await within(document.body).findByRole("region", { name: "Needs review" });
  // As React appends a new last group, such as a new section.
  groups.insertAdjacentHTML("beforeend", `<div data-testid="later"><div data-sidebar-sticky-group><div data-sidebar="group-label">Later</div></div></div>`);
  await waitFor(() => expect(groups.lastElementChild!.contains(section)).toBe(true));
  expect(groups.lastElementChild!.previousElementSibling!.getAttribute("data-testid")).toBe("later");
  slot.lifecycle.unmount();
});

test("with nothing waiting on you there's no group, and it appears when a review needs you", async () => {
  const groups = threadList();
  let list: unknown[] = [reviews[1]];
  const app = await loadPluginApp(() => import("../app"));
  const overlay = app.appOverlays.find((registration) => registration.id === "needs-review")!;
  const slot = renderSlot(overlay, {}, { rpc: { listReviews: () => ({ reviews: list }), getPreferences: () => settings() } });
  await waitFor(() => expect(slot.inspection.rpcCalls.some((call) => call.method === "listReviews")).toBe(true));
  // Out of BB's list altogether while empty.
  expect(groups.children).toHaveLength(2);
  expect(within(document.body).queryByRole("region", { name: "Needs review" })).toBeNull();
  list = reviews;
  await slot.emitRealtime("reviews", {});
  const section = await within(document.body).findByRole("region", { name: "Needs review" }, { timeout: 2000 });
  expect(groups.lastElementChild!.contains(section)).toBe(true);
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

const pinnedReview = { ...reviews[2], pinnedAt: Date.now() - hour };

test("a pinned review sits in BB's Pinned group after its threads, and leaves Needs review", async () => {
  threadList();
  const slot = await renderSidebar([pinnedReview, reviews[3]]);
  const pinnedRows = document.querySelector<HTMLElement>('[data-testid="pinned-rows"]')!;
  const row = await within(pinnedRows).findByRole("link", { name: /Direct request/ });
  expect(pinnedRows.lastElementChild!.contains(row)).toBe(true);
  expect(pinnedRows.children).toHaveLength(3);
  const needs = within(document.body).getByRole("region", { name: "Needs review" });
  expect(within(needs).getAllByRole("link").map((link) => link.textContent)).toEqual(["Blocks merge1h"]);
  expect(within(pinnedRows).getByRole("button", { name: "Unpin Direct request" })).toBeTruthy();
  slot.lifecycle.unmount();
  expect(pinnedRows.children).toHaveLength(2);
});

test("Pin moves a review into Pinned at once, and Unpin moves it back", async () => {
  threadList();
  const slot = await renderSidebar([reviews[2], reviews[3]]);
  fireEvent.click(await within(document.body).findByRole("button", { name: "Pin Direct request" }));
  const pinnedRows = document.querySelector<HTMLElement>('[data-testid="pinned-rows"]')!;
  expect(await within(pinnedRows).findByRole("link", { name: /Direct request/ })).toBeTruthy();
  expect(slot.inspection.rpcCalls.filter((call) => call.method === "pinReview").map((call) => call.input)).toEqual([{ targetKey: "pr-direct", pinned: true }]);
  fireEvent.click(within(pinnedRows).getByRole("button", { name: "Unpin Direct request" }));
  const needs = within(document.body).getByRole("region", { name: "Needs review" });
  expect(await within(needs).findByRole("link", { name: /Direct request/ })).toBeTruthy();
  expect(within(pinnedRows).queryByRole("link")).toBeNull();
  slot.lifecycle.unmount();
});

test("collapsing BB's Pinned hides pinned reviews with its threads", async () => {
  threadList("collapsed");
  const slot = await renderSidebar([pinnedReview, reviews[3]]);
  await within(document.body).findByRole("region", { name: "Needs review" });
  expect(within(document.body).queryByRole("link", { name: /Direct request/ })).toBeNull();
  slot.lifecycle.unmount();
});

test("with no pinned thread, BB draws no Pinned, so pinned reviews get one of their own, first", async () => {
  const groups = threadList("none");
  const slot = await renderSidebar([pinnedReview, reviews[3]], []);
  const pinned = await within(document.body).findByRole("region", { name: "Pinned" });
  expect(groups.firstElementChild!.contains(pinned)).toBe(true);
  expect(within(pinned).getByRole("link", { name: /Direct request/ })).toBeTruthy();
  expect(groups.lastElementChild!.querySelector('[aria-label="Needs review"]')).toBeTruthy();
  fireEvent.click(within(pinned).getByRole("button", { name: /^Pinned/ }));
  expect(within(pinned).queryByRole("link")).toBeNull();
  slot.lifecycle.unmount();
});

test("pinned reviews wait for BB's threads to load, so a Pinned of their own doesn't flash up", async () => {
  threadList("none");
  const slot = await renderSidebar([pinnedReview, reviews[3]], [], "loading");
  await within(document.body).findByRole("region", { name: "Needs review" });
  expect(within(document.body).queryByRole("region", { name: "Pinned" })).toBeNull();
  expect(within(document.body).queryByRole("link", { name: /Direct request/ })).toBeNull();
  slot.lifecycle.unmount();
});

test("an archived review leaves Pinned", async () => {
  threadList();
  const archived = { ...pinnedReview, turn: turn("archive", "merged", 1) };
  const slot = await renderSidebar([archived, reviews[3]]);
  await within(document.body).findByRole("region", { name: "Needs review" });
  expect(within(document.body).queryByRole("link", { name: /Direct request/ })).toBeNull();
  slot.lifecycle.unmount();
});

test("turned off in Settings, nothing goes into BB's list and no review is listed; turned back on, it comes back", async () => {
  const groups = threadList();
  let enabled = false;
  const app = await loadPluginApp(() => import("../app"));
  const overlay = app.appOverlays.find((registration) => registration.id === "needs-review")!;
  const slot = renderSlot(overlay, {}, { rpc: { listReviews: () => ({ reviews: [pinnedReview, reviews[3]] }), getPreferences: () => settings(enabled) }, sidebarThreads: { status: "ready", threads: [pinnedThread] } });
  const listed = () => slot.inspection.rpcCalls.filter((call) => call.method === "listReviews").length;
  await waitFor(() => expect(slot.inspection.rpcCalls.filter((call) => call.method === "getPreferences")).toHaveLength(1));
  // Off, neither a review changing nor a reconnect lists them.
  await slot.emitRealtime("reviews", {});
  await slot.setRealtimeConnectionState("reconnecting");
  await slot.setRealtimeConnectionState("connected");
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(listed()).toBe(0);
  expect(groups.children).toHaveLength(2);
  expect(document.querySelector('[data-testid="pinned-rows"]')!.children).toHaveLength(2);
  enabled = true;
  await slot.emitRealtime("preferences", {});
  expect(await within(document.body).findByRole("region", { name: "Needs review" })).toBeTruthy();
  expect(listed()).toBe(1);
  expect(document.querySelector('[data-testid="pinned-rows"]')!.children).toHaveLength(3);
  enabled = false;
  await slot.emitRealtime("preferences", {});
  await waitFor(() => expect(groups.children).toHaveLength(2));
  expect(document.querySelector('[data-testid="pinned-rows"]')!.children).toHaveLength(2);
  slot.lifecycle.unmount();
});

test("Settings turns reviews in the thread list off, saying why someone would", async () => {
  await loadPluginApp(() => import("../app"));
  const { ReviewSettings } = await import("./ReviewSettings");
  let record = settings();
  const save = vi.fn(async (input: any) => record = { ...input, revision: input.revision + 1 });
  const slot = renderSlot({ component: ReviewSettings }, {}, { rpc: { setReviewPresence: () => ({ ok: true }), getPreferences: () => record, savePreferences: save } });
  const toggle = await slot.findByRole("checkbox", { name: /Show reviews in the thread list/ }) as HTMLInputElement;
  expect(toggle.checked).toBe(true);
  expect(toggle.closest("label")!.textContent).toContain("If a BB update makes that list misbehave");
  fireEvent.click(toggle);
  fireEvent.click(slot.getByRole("button", { name: "Save settings" }));
  await slot.findByText("Settings saved");
  expect(save.mock.calls[0][0].preferences.threadListReviews).toBe(false);
  slot.lifecycle.unmount();
});

test("short branch names: the last part, cut in the middle when long, and more of each where two would match", () => {
  expect(shortNames(["feature/snooze-flaky-checks-on-retries", "fix-login", null])).toEqual(["snooze-…-retries", "fix-login", null]);
  expect(shortNames(["alice/fix-login", "bob/fix-login", "carol/other"])).toEqual(["alice/fix-login", "bob/fix-login", "other"]);
  // Cut in the middle, two long ones that would match show whole.
  expect(shortNames(["team/snooze-flaky-checks-a-on-retries", "team/snooze-flaky-checks-b-on-retries"])).toEqual(["snooze-flaky-checks-a-on-retries", "snooze-flaky-checks-b-on-retries"]);
  // The same branch twice is one name.
  expect(shortNames(["x/fix", "x/fix"])).toEqual(["fix", "fix"]);
});
