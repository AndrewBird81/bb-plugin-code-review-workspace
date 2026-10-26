// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { toast } from "sonner";
import { defaultPreferences } from "../src/preferences";
import { defaultKnobs } from "../lib/knobs";
import type { Turn } from "../lib/turn";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
afterEach(() => { cleanup(); sessionStorage.clear(); localStorage.clear(); vi.clearAllMocks(); });

const DAY = 86_400_000;
const now = Date.now();
const turn = (group: Turn["group"], reason: Turn["reason"], label: string, extra: Partial<Turn> = {}): Turn =>
  ({ group, reason, label, signal: null, at: null, notify: false, blocking: false, updated: false, eventAt: null, failed: false, ...extra });

/** All reviews over these reviews, with the RPCs the page calls. */
async function inbox(reviews: unknown[], rpc: Record<string, (input: any) => unknown> = {}) {
  const app = await loadPluginApp(() => import("../app"));
  const listReviews = rpc.listReviews ?? (() => ({ reviews }));
  const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: {
    setReviewPresence: () => ({ ok: true }),
    getGhAccounts: () => ({ active: "me", accounts: [] }),
    getPreferences: () => ({ preferences: defaultPreferences, revision: 0 }),
    getSetupStatus: () => ({ account: "me", githubCli: true, agentAvailable: true, projectAvailable: true }),
    listReviews,
    // A pass that finds nothing new, as the first run makes.
    refreshReviews: listReviews,
    ...rpc,
  } as any });
  const calls = (method: string) => slot.inspection.rpcCalls.filter((call) => call.method === method).map((call) => call.input);
  /** A section's header, which opens or closes it. */
  const header = (name: string) => within(slot.getByRole("heading", { name: new RegExp(`^${name}`) })).getByRole("button");
  const titles = () => slot.queryAllByText(/^Change \w+$/).map((title) => title.textContent);
  return { slot, calls, header, titles };
}

test("listing the reviews forgets what was kept of a deleted one", async () => {
  const { patchReviewState, getReviewState } = await import("../lib/panel-state");
  patchReviewState("pr-7", { compare: { head: "h7", from: null, narrowed: false } });
  patchReviewState("pr-gone", { activeId: "c1", compare: { head: "h1", from: null, narrowed: true } });
  const { slot } = await inbox([{ targetKey: "pr-7", kind: "pr", number: 7, repo: "acme/app", title: "Fix", status: "ready" }]);
  await slot.findByText("Fix");
  expect(getReviewState("pr-gone")).toEqual({});
  expect(getReviewState("pr-7").compare).toEqual({ head: "h7", from: null, narrowed: false });
  slot.lifecycle.unmount();
});

test("a row shows its title, where the PR is, how long it's been your turn, and why it's yours", async () => {
  const { slot } = await inbox([{ targetKey: "pr-7", kind: "pr", number: 7, repo: "acme/app", title: "Fix", author: "alice", status: "ready",
    signals: { requestedBy: "alice" }, turn: turn("needs", "requested", "Review requested", { at: now - 3 * 3_600_000 }) }]);
  const row = (await slot.findByText("Fix")).closest("button")!;
  expect(within(row).getAllByText("acme/app #7")).toHaveLength(2);
  expect(within(row).getByText("3h")).toBeTruthy();
  expect(within(row).getByText("Requested by @alice")).toBeTruthy();
  // The row is one button, named by everything on it.
  expect(row.textContent).toContain("Requested by @alice");
  slot.lifecycle.unmount();
});

test("reviews are in sections, not tabs: Needs review shows, the rest start closed with their counts", async () => {
  const { slot, header } = await inbox([
    { targetKey: "a", title: "Pending change", status: "ready" },
    { targetKey: "b", title: "Accepted change", status: "ready", submittedVerdict: "APPROVE", submittedAt: now - DAY },
    { targetKey: "c", title: "Finished change", status: "ready", prState: "MERGED", archivedAt: 10 },
  ]);
  await slot.findByText("Pending change");
  expect(slot.queryByRole("group", { name: "Filter reviews" })).toBeNull();
  expect(slot.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual(["Needs review, 1", "Reviewed, 1", "Archive, 1"]);
  // What needs you is counted as the title bar's needs-you badge is; the rest quietly.
  expect(within(slot.getByRole("heading", { name: /^Needs review/ })).getByText("1").className).toContain("bg-primary");
  expect(within(slot.getByRole("heading", { name: /^Reviewed/ })).getByText("1").className).toContain("bg-muted");
  expect(header("Reviewed").getAttribute("aria-expanded")).toBe("false");
  expect(slot.queryByText("Accepted change")).toBeNull();
  expect(slot.queryByText("Finished change")).toBeNull();
  fireEvent.click(header("Reviewed"));
  await slot.findByText("Accepted change");
  expect(slot.getByText(/^You approved/)).toBeTruthy();
  fireEvent.click(header("Archive"));
  await slot.findByText("Finished change");
  expect(slot.getByText("Merged")).toBeTruthy();
  fireEvent.click(header("Needs review"));
  expect(slot.queryByText("Pending change")).toBeNull();
  slot.lifecycle.unmount();
});

test("the sections you open or close stay so in this browser, and the tab 0.5 left the list on opens its section once", async () => {
  const reviews = [
    { targetKey: "a", title: "Change Pending", status: "ready" },
    { targetKey: "b", title: "Change Waiting", status: "ready", turn: turn("waiting", "waiting", "Changes requested") },
    { targetKey: "c", title: "Change Accepted", status: "ready", turn: turn("reviewed", "approved", "Approved") },
  ];
  sessionStorage.setItem("gr:review-list", JSON.stringify({ tab: "reviewed", query: "" }));
  let { slot, header, titles } = await inbox(reviews);
  await slot.findByText("Change Accepted");
  expect(titles()).toEqual(["Change Pending", "Change Accepted"]);
  expect(JSON.parse(sessionStorage.getItem("gr:review-list")!)).toEqual({ query: "" });
  fireEvent.click(header("Waiting on author"));
  fireEvent.click(header("Needs review"));
  expect(JSON.parse(localStorage.getItem("gr:inbox-sections")!)).toEqual({ reviewed: false, waiting: false, needs: true });
  slot.lifecycle.unmount();
  ({ slot, header, titles } = await inbox(reviews));
  await slot.findByText("Change Waiting");
  expect(titles()).toEqual(["Change Waiting", "Change Accepted"]);
  slot.lifecycle.unmount();
});

test("Needs review is in parts, Back to you, New and Team requests, with Blocks merge first", async () => {
  const { slot, titles } = await inbox([
    { targetKey: "a", title: "Change Recent", status: "ready", turn: turn("needs", "requested", "Review requested", { at: now - DAY }) },
    { targetKey: "b", title: "Change Team", status: "ready", turn: turn("needs", "team-requested", "Team review requested", { at: now - 9 * DAY }) },
    { targetKey: "c", title: "Change Old", status: "ready", turn: turn("needs", "re-requested", "Re-requested", { at: now - 5 * DAY }) },
    { targetKey: "d", title: "Change Blocking", status: "ready", turn: turn("needs", "question", "Question for you", { at: now - 60_000, blocking: true }) },
  ]);
  await slot.findByText("Change Recent");
  expect(titles()).toEqual(["Change Blocking", "Change Old", "Change Recent", "Change Team"]);
  expect(slot.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent)).toEqual(["Back to you · 2", "New · 1", "Team requests · 1"]);
  expect(within(slot.getByRole("group", { name: "Back to you" })).getByText("Blocks merge")).toBeTruthy();
  expect(within(slot.getByRole("group", { name: "Team requests" })).getByText("Change Team")).toBeTruthy();
  slot.lifecycle.unmount();
});

test("with nothing for you, Needs review says so and how many wait on their authors", async () => {
  const { slot } = await inbox([
    { targetKey: "b", title: "Change Waiting", status: "ready", turn: turn("waiting", "waiting", "Changes requested") },
    { targetKey: "c", title: "Change Quiet", status: "ready", turn: turn("waiting", "waiting", "Commented") },
  ]);
  expect((await slot.findByText(/^Nothing needs you right now/)).textContent).toBe("Nothing needs you right now · 2 waiting on authors");
  expect(within(slot.getByRole("heading", { name: /^Needs review/ })).getByText("0").className).not.toContain("bg-primary");
  slot.lifecycle.unmount();
});

test("a row's status line says what changes whether to open it: checks GitHub expects, your own PR, a PR GitHub can't read", async () => {
  const { slot } = await inbox([
    { targetKey: "a", kind: "pr", title: "Expected change", status: "ready", signals: { ci: "expected" } },
    { targetKey: "b", kind: "pr", title: "My change", status: "ready", ownPr: true },
    { targetKey: "c", kind: "pr", title: "Gone change", status: "ready", unreachable: { since: 1, reason: "forbidden" } },
    { targetKey: "d", kind: "pr", title: "Sized change", status: "ready", prSize: { additions: 1200, deletions: 30, files: 8 } },
  ]);
  await slot.findByText("Expected change");
  for (const text of ["Checks expected", "Your PR", "Can’t read on GitHub", "+1,200 −30 · 8 files"]) expect(slot.getByText(text)).toBeTruthy();
  expect(slot.getByText("Can’t read on GitHub").getAttribute("title")).toBe("GitHub refused access, for example for SSO");
  slot.lifecycle.unmount();
});

// A guide waiting for its writer's machine read "Guide failed" here while its page said it restarts on its own (72-hands-on #2).
test("a row says a guide waits for its writer's machine while it does, in the status line's own truncating line, and failed after", async () => {
  const failed = turn("needs", "requested", "Failed", { failed: true });
  const { slot } = await inbox([
    { targetKey: "pr-7", kind: "pr", number: 7, repo: "acme/app", title: "Change waiting", status: "error", restartPending: { since: now }, turn: failed },
    { targetKey: "pr-8", kind: "pr", number: 8, repo: "acme/app", title: "Change failed", status: "error", restartPending: null, turn: failed },
  ]);
  const waiting = (await slot.findByText("Change waiting")).closest("button")!;
  const status = within(waiting).getByText("Waiting for the guide writer’s machine");
  expect(status.className).toContain("text-warning");
  expect(status.getAttribute("title")).toBe("The guide writer’s machine is offline. The guide restarts on its own when it reconnects.");
  expect(status.parentElement!.className).toContain("truncate");
  expect(waiting.textContent).not.toContain("Guide failed");
  const gone = slot.getByText("Change failed").closest("button")!;
  expect(within(gone).getByText("Guide failed")).toBeTruthy();
  expect(gone.textContent).not.toContain("Waiting for");
  slot.lifecycle.unmount();
});

test("an author's turn shows its last activity; a request how long it's been yours", async () => {
  const { slot, header } = await inbox([
    { targetKey: "a", title: "Old request", status: "tracked", signals: { requestedAt: now - 800 * DAY }, turn: turn("needs", "requested", "Review requested", { at: now - 800 * DAY }) },
    { targetKey: "b", title: "Quiet change", status: "ready", submittedVerdict: "REQUEST_CHANGES", turn: turn("waiting", "waiting", "Changes requested", { at: now - 9 * DAY }),
      signals: { lastReviewAt: now - 9 * DAY, headSeenAt: now - 5 * DAY, replyAt: now - 6 * DAY } },
  ]);
  const old = (await slot.findByText("Old request")).closest("button")!;
  expect(within(old).getByText("2y")).toBeTruthy();
  fireEvent.click(header("Waiting on author"));
  const quiet = (await slot.findByText("Quiet change")).closest("button")!;
  expect(within(quiet).getByText("5d")).toBeTruthy();
  expect(within(quiet).getByText("You requested changes 1w ago")).toBeTruthy();
  slot.lifecycle.unmount();
});

test("the sync's problems show above the list, saying when GitHub was last read", async () => {
  const { slot } = await inbox([], { listReviews: () => ({ reviews: [], sync: { lastReadAt: now - 14 * 60_000, error: { kind: "auth", at: now } } }) });
  expect((await slot.findByText(/^GitHub last read/)).textContent).toBe("GitHub last read 14m ago: GitHub CLI isn’t signed in. Run gh auth login on the BB server.");
  slot.lifecycle.unmount();
});

// gh missing on the BB server isn't GitHub being unreachable (bug bash PRF-4).
test("the sync says when GitHub CLI isn't on the BB server", async () => {
  const { slot } = await inbox([], { listReviews: () => ({ reviews: [], sync: { lastReadAt: null, error: { kind: "gh-missing", at: now } } }) });
  expect((await slot.findByText(/^GitHub hasn’t been read/)).textContent).toBe("GitHub hasn’t been read yet: GitHub CLI isn’t on the BB server.");
  slot.lifecycle.unmount();
});

test("focusing the window runs a normal pass; only Refresh forces a full read", async () => {
  const { slot } = await inbox([{ targetKey: "a", title: "A change", status: "ready" }], { refreshReviews: () => ({ reviews: [{ targetKey: "a", title: "A change", status: "ready" }] }) });
  const refreshes = () => slot.inspection.rpcCalls.filter((call) => call.method === "refreshReviews").map((call) => call.input);
  await slot.findByText("A change");
  fireEvent(window, new Event("focus"));
  await waitFor(() => expect(refreshes()).toEqual([{ force: false }]));
  // Without BB's title bar, the page has the list's Refresh.
  fireEvent.click(await slot.findByRole("button", { name: "Refresh" }));
  await waitFor(() => expect(refreshes()).toEqual([{ force: false }, { force: true }]));
  slot.lifecycle.unmount();
});

test("a burst of review updates re-lists once", async () => {
  const { slot, calls } = await inbox([{ targetKey: "a", title: "A change", status: "ready" }]);
  await slot.findByText("A change");
  expect(calls("listReviews")).toHaveLength(1);
  for (let i = 0; i < 3; i++) await slot.emitRealtime("reviews", { ts: i });
  await waitFor(() => expect(calls("listReviews")).toHaveLength(2));
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(calls("listReviews")).toHaveLength(2);
  slot.lifecycle.unmount();
});

test("the box finds reviews by repository, author, title, or number in every section, and the list keeps what you typed", async () => {
  const reviews = [
    { targetKey: "a", kind: "pr", repo: "acme/live-api", number: 2648, author: "alice", title: "Stream retries", status: "ready" },
    { targetKey: "b", kind: "pr", repo: "acme/web", number: 12, author: "bob", title: "Cache headers", status: "ready" },
    { targetKey: "c", kind: "pr", repo: "acme/live-api", number: 2651, author: "bob", title: "Older retries", status: "ready", submittedVerdict: "APPROVE" },
  ];
  const { slot } = await inbox(reviews);
  await slot.findByText("Stream retries");
  const find = slot.getByRole("searchbox", { name: "Find a review, or paste a PR link" });
  const titles = () => slot.queryAllByText(/retries|headers/).map((el) => el.textContent);
  fireEvent.change(find, { target: { value: "live-api" } });
  // Searching opens every section that has a match, Reviewed included.
  expect(titles()).toEqual(["Stream retries", "Older retries"]);
  fireEvent.change(find, { target: { value: "@bob" } });
  expect(titles()).toEqual(["Cache headers", "Older retries"]);
  fireEvent.change(find, { target: { value: "#2648" } });
  expect(titles()).toEqual(["Stream retries"]);
  expect(slot.queryByRole("heading", { name: /^Reviewed/ })).toBeNull();
  fireEvent.change(find, { target: { value: "nothing like it" } });
  expect(slot.getByText("No reviews match “nothing like it”")).toBeTruthy();
  fireEvent.change(find, { target: { value: "retries" } });
  expect(slot.getByRole("heading", { name: /^Reviewed/ }).textContent).toBe("Reviewed, 1");
  // Esc clears it.
  fireEvent.keyDown(find, { key: "Escape" });
  expect((find as HTMLInputElement).value).toBe("");
  fireEvent.change(find, { target: { value: "retries" } });
  slot.lifecycle.unmount();

  const again = await inbox(reviews);
  await again.slot.findByText("Older retries");
  expect((again.slot.getByRole("searchbox", { name: "Find a review, or paste a PR link" }) as HTMLInputElement).value).toBe("retries");
  again.slot.lifecycle.unmount();
});

test("filters pick a field, then its values, as chips that flip, change, and go, and stay when you come back", async () => {
  const reviews = [
    { targetKey: "a", kind: "pr", repo: "acme/live-api", number: 1, author: "alice", title: "Stream retries", status: "ready", prLabels: [{ name: "bug", color: "d73a4a" }], prTeams: ["acme/live-dev"] },
    { targetKey: "b", kind: "pr", repo: "acme/web", number: 2, author: "bob", title: "Cache headers", status: "ready", prLabels: [{ name: "ui", color: "" }] },
  ];
  const { slot } = await inbox(reviews);
  await slot.findByText("Stream retries");
  const titles = () => slot.queryAllByText(/retries|headers/).map((el) => el.textContent);
  // F opens the menu; a field's name finds it, and Enter takes it.
  fireEvent.keyDown(document.body, { key: "f" });
  fireEvent.change(await screen.findByRole("textbox", { name: "Find a filter" }), { target: { value: "label" } });
  fireEvent.click(screen.getByRole("button", { name: "GitHub labels" }));
  fireEvent.click(screen.getByRole("checkbox", { name: /bug/ }));
  expect(titles()).toEqual(["Stream retries"]);
  // The menu stays open to tick more; Esc closes it.
  fireEvent.keyDown(screen.getByRole("textbox", { name: "Find labels" }), { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("textbox", { name: "Find labels" })).toBeNull());
  const chips = within(slot.getByRole("list", { name: "Filters" }));
  expect(chips.getByText("GitHub labels")).toBeTruthy();
  // The operator flips the match.
  fireEvent.click(chips.getByRole("button", { name: "GitHub labels is; switch to is not" }));
  expect(titles()).toEqual(["Cache headers"]);
  fireEvent.click(chips.getByRole("button", { name: "Remove GitHub labels filter" }));
  expect(titles()).toEqual(["Stream retries", "Cache headers"]);

  fireEvent.click(chips.getByRole("button", { name: "Add filter" }));
  fireEvent.click(await screen.findByRole("button", { name: "GitHub team reviewers" }));
  fireEvent.click(screen.getByRole("checkbox", { name: /acme\/live-dev/ }));
  slot.lifecycle.unmount();

  const again = await inbox(reviews);
  await again.slot.findByText("Stream retries");
  expect(again.slot.queryByText("Cache headers")).toBeNull();
  fireEvent.click(within(again.slot.getByRole("list", { name: "Filters" })).getByRole("button", { name: "Remove GitHub team reviewers filter" }));
  expect(again.slot.getByText("Cache headers")).toBeTruthy();
  again.slot.lifecycle.unmount();
});

test("with no review matching the filters, the list says so and clears them", async () => {
  sessionStorage.setItem("gr:inbox-filters", JSON.stringify([{ field: "author", values: ["nobody"] }]));
  const { slot } = await inbox([{ targetKey: "a", kind: "pr", author: "alice", title: "A change", status: "ready" }]);
  await slot.findByText("No reviews match these filters");
  expect(slot.getByText("Try fewer filters.")).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: "Clear filters" }));
  expect(slot.getByText("A change")).toBeTruthy();
  slot.lifecycle.unmount();
});

test("filters open the sections to show what they found; one you close stays closed until the filters change", async () => {
  const reviews = [
    { targetKey: "a", kind: "pr", author: "alice", title: "Change Pending", status: "ready" },
    { targetKey: "b", kind: "pr", author: "alice", title: "Change Merged", status: "ready", prState: "MERGED", prMergedAt: now - DAY, turn: turn("archive", "merged", "Merged") },
  ];
  sessionStorage.setItem("gr:inbox-filters", JSON.stringify([{ field: "merged", days: 7 }]));
  const { slot, header, titles } = await inbox(reviews);
  await slot.findByText("Change Merged");
  expect(titles()).toEqual(["Change Merged"]);
  fireEvent.click(header("Archive"));
  expect(titles()).toEqual([]);
  const chips = within(slot.getByRole("list", { name: "Filters" }));
  fireEvent.click(chips.getByRole("button", { name: "Merged date in the last; switch to more than" }));
  fireEvent.click(chips.getByRole("button", { name: "Merged date more than; switch to in the last" }));
  expect(titles()).toEqual(["Change Merged"]);
  // Without filters, the sections are as you left them, Archive closed.
  fireEvent.click(chips.getByRole("button", { name: "Remove Merged date filter" }));
  expect(titles()).toEqual(["Change Pending"]);
  expect(JSON.parse(localStorage.getItem("gr:inbox-sections") ?? "{}")).toEqual({});
  slot.lifecycle.unmount();
});

test("a value no review has now stays ticked to untick, and a date filter's span is marked", async () => {
  sessionStorage.setItem("gr:inbox-filters", JSON.stringify([{ field: "author", values: ["carol"] }, { field: "added", days: 3 }]));
  const { slot } = await inbox([{ targetKey: "a", kind: "pr", author: "alice", title: "A change", status: "ready", createdAt: now - DAY }]);
  await slot.findByText("No reviews match these filters");
  const chips = within(slot.getByRole("list", { name: "Filters" }));
  fireEvent.click(chips.getByRole("button", { name: "3 days" }));
  expect(within(await screen.findByRole("group", { name: "In the last" })).getByRole("button", { name: "3 days" }).getAttribute("aria-pressed")).toBe("true");
  expect(within(screen.getByRole("group", { name: "More than" })).getByRole("button", { name: "3 days" }).getAttribute("aria-pressed")).toBe("false");
  fireEvent.keyDown(screen.getByRole("group", { name: "Added date" }), { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("group", { name: "Added date" })).toBeNull());
  fireEvent.click(chips.getByRole("button", { name: "carol" }));
  const carol = await screen.findByRole("checkbox", { name: /carol/ });
  expect(carol.getAttribute("aria-checked")).toBe("true");
  expect(carol.textContent).toContain("0");
  fireEvent.click(carol);
  expect(slot.getByText("A change")).toBeTruthy();
  slot.lifecycle.unmount();
});

test("a date filter's span moves with the clock while the list is open", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  try {
    sessionStorage.setItem("gr:inbox-filters", JSON.stringify([{ field: "added", days: 1 }]));
    const { slot } = await inbox([{ targetKey: "a", kind: "pr", title: "A change", status: "ready", createdAt: Date.now() - DAY + 30_000 }]);
    await slot.findByText("A change");
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(slot.queryByText("A change")).toBeNull();
    slot.lifecycle.unmount();
  } finally { vi.useRealTimers(); }
});

test("F adds a filter only where the filters show: not for a pasted link", async () => {
  sessionStorage.setItem("gr:review-list", JSON.stringify({ query: "https://github.com/acme/web/pull/1" }));
  const { slot } = await inbox([{ targetKey: "a", kind: "pr", repo: "acme/web", number: 1, title: "A change", status: "ready" }]);
  await slot.findByText("A change");
  expect(slot.queryByRole("list", { name: "Filters" })).toBeNull();
  fireEvent.keyDown(document.body, { key: "f" });
  fireEvent.change(slot.getByRole("searchbox", { name: "Find a review, or paste a PR link" }), { target: { value: "" } });
  await slot.findByRole("list", { name: "Filters" });
  expect(screen.queryByRole("textbox", { name: "Find a filter" })).toBeNull();
  slot.lifecycle.unmount();
});

test("a pasted link to a listed PR, or its owner/repo#n, opens it", async () => {
  const { slot, calls } = await inbox([{ targetKey: "pr-42", kind: "pr", repo: "acme/web", number: 42, title: "Expire cache entries", status: "ready", signals: { requestedBy: "alice" }, turn: turn("needs", "re-requested", "Re-requested") }]);
  await slot.findByText("Expire cache entries");
  const find = slot.getByRole("searchbox", { name: "Find a review, or paste a PR link" });
  fireEvent.change(find, { target: { value: "https://github.com/acme/web/pull/42/files" } });
  const open = slot.getByRole("button", { name: /^Open acme\/web#42/ });
  expect(open.textContent).toContain("Re-requested by @alice");
  // The list shows just that PR.
  expect(slot.getByText("Expire cache entries")).toBeTruthy();
  fireEvent.change(find, { target: { value: "acme/web#42" } });
  fireEvent.submit(find);
  await waitFor(() => expect(slot.inspection.navigateCalls).toEqual([{ method: "toPluginPanel", path: "review", options: { subPath: "pr-42" } }]));
  expect(calls("startReview")).toEqual([]);
  expect((find as HTMLInputElement).value).toBe("");
  slot.lifecycle.unmount();
});

test("a pasted link to a PR that isn't listed starts its review, and says why when it can't", async () => {
  let refuse = true;
  const { slot, calls } = await inbox([{ targetKey: "a", title: "A change", status: "ready" }], {
    startReview: () => refuse ? { ok: false, error: "No coding agent is set up." } : { ok: true, targetKey: "pr-new-7" },
  });
  await slot.findByText("A change");
  const find = slot.getByRole("searchbox", { name: "Find a review, or paste a PR link" });
  fireEvent.change(find, { target: { value: "Acme/Web#7" } });
  expect(slot.getByRole("button", { name: /^Review acme\/web#7/ }).textContent).toContain("builds a guide");
  expect(slot.queryByText(/^No reviews match/)).toBeNull();
  fireEvent.submit(find);
  expect((await slot.findByRole("alert")).textContent).toBe("No coding agent is set up.");
  expect(calls("startReview")).toEqual([{ input: "https://github.com/acme/web/pull/7" }]);
  refuse = false;
  fireEvent.click(slot.getByRole("button", { name: /^Review acme\/web#7/ }));
  await waitFor(() => expect(slot.inspection.navigateCalls).toEqual([{ method: "toPluginPanel", path: "review", options: { subPath: "pr-new-7" } }]));
  slot.lifecycle.unmount();
});

test("focused and empty, the box says how to review a local branch; / focuses it", async () => {
  const { slot } = await inbox([{ targetKey: "a", title: "A change", status: "ready" }]);
  await slot.findByText("A change");
  const find = slot.getByRole("searchbox", { name: "Find a review, or paste a PR link" });
  fireEvent.keyDown(document.body, { key: "/" });
  expect(document.activeElement).toBe(find);
  fireEvent.focus(find);
  expect(slot.getByText(/For a local branch, run/).textContent).toBe("For a local branch, run bb review in a BB thread.");
  slot.lifecycle.unmount();
});

test("with single-key shortcuts off, / focuses nothing and the box shows no / key", async () => {
  const kbd = (slot: Awaited<ReturnType<typeof inbox>>["slot"]) => Array.from(slot.container.querySelectorAll("kbd")).filter((key) => key.textContent === "/");
  const { slot } = await inbox([{ targetKey: "a", title: "A change", status: "ready" }], {
    getPreferences: () => ({ preferences: { ...defaultPreferences, knobs: { ...defaultKnobs, singleKeyShortcuts: false } }, revision: 1 }),
  });
  await slot.findByText("A change");
  await waitFor(() => expect(kbd(slot)).toHaveLength(0));
  fireEvent.keyDown(document.body, { key: "/" });
  expect(document.activeElement).toBe(document.body);
  slot.lifecycle.unmount();
  // On, the key shows.
  const on = await inbox([{ targetKey: "a", title: "A change", status: "ready" }]);
  await on.slot.findByText("A change");
  expect(kbd(on.slot)).toHaveLength(1);
  on.slot.lifecycle.unmount();
});

test("a stack's reviews sit together, bottom first, each saying where it stands", async () => {
  const member = (n: number) => ({ targetKey: `pr-${n}`, number: n, title: `PR ${n}`, url: null, status: "ready", reviewed: false });
  const members = [member(2645), member(2648), member(2654)];
  const stack = (index: number) => ({ members, index, parent: members[index - 1] ?? null, children: members.slice(index + 1, index + 2) });
  const { slot } = await inbox([
    { targetKey: "pr-2654", kind: "pr", repo: "acme/live-api", number: 2654, title: "Top change", status: "ready", createdAt: now - 3, stack: stack(2) },
    { targetKey: "pr-7", kind: "pr", repo: "acme/web", number: 7, title: "Lone change", status: "ready", createdAt: now - 2 },
    { targetKey: "pr-2645", kind: "pr", repo: "acme/live-api", number: 2645, title: "Bottom change", status: "ready", createdAt: now - 4, stack: stack(0) },
    { targetKey: "pr-2648", kind: "pr", repo: "acme/live-api", number: 2648, title: "Middle change", status: "ready", createdAt: now - 1, stack: stack(1) },
  ]);
  await slot.findByText("Top change");
  const group = slot.getByRole("group", { name: "Stack of 3 in acme/live-api" });
  expect(within(group).getAllByText(/ change$/).map((el) => el.textContent)).toEqual(["Bottom change", "Middle change", "Top change"]);
  expect(within(group).getByText("Stack 2 of 3 · on #2645")).toBeTruthy();
  expect(within(group).getByText("#2645 not reviewed yet")).toBeTruthy();
  expect(slot.getAllByText(/ change$/).map((el) => el.textContent)).toEqual(["Bottom change", "Middle change", "Top change", "Lone change"]);
  slot.lifecycle.unmount();
});

test("wide, where the PR is sits beside the title; narrow, it follows the status line", async () => {
  const { slot } = await inbox([{ targetKey: "a", repo: "acme/app", number: 3, title: "A long title that needs the row's width", status: "ready" }]);
  const row = (await slot.findByText("A long title that needs the row's width")).closest("button")!;
  const [beside, after] = within(row).getAllByText("acme/app #3");
  expect(beside.className).toContain("hidden");
  expect(beside.className).toContain("@min-[720px]/inbox:inline");
  expect(after.parentElement!.className).toContain("@min-[720px]/inbox:hidden");
  slot.lifecycle.unmount();
});

test("a row's quick actions archive it, with Undo, and Review actions is always there", async () => {
  let reviews = [{ targetKey: "a", kind: "pr", title: "Change Archived", status: "ready", url: "https://github.com/acme/web/pull/3" }];
  const { slot, calls } = await inbox(reviews, {
    listReviews: () => ({ reviews }),
    archiveReview: ({ archived }: any) => { reviews = reviews.map((r) => ({ ...r, userArchivedAt: archived ? 5 : null })); return { ok: true }; },
  });
  const row = (await slot.findByText("Change Archived")).closest(".group\\/row") as HTMLElement;
  expect(within(row).getByRole("button", { name: "Review actions" })).toBeTruthy();
  expect(within(row).getByRole("button", { name: "Snooze" })).toBeTruthy();
  fireEvent.click(within(row).getByRole("button", { name: "Archive" }));
  await waitFor(() => expect(calls("archiveReview")).toEqual([{ targetKey: "a", archived: true }]));
  // It leaves Needs review for the closed Archive.
  await slot.findByText(/^Nothing needs you right now/);
  expect(vi.mocked(toast.success)).toHaveBeenCalledWith("Review archived", expect.objectContaining({ action: expect.objectContaining({ label: "Undo" }) }));
  (vi.mocked(toast.success).mock.calls[0][1] as any).action.onClick();
  await slot.findByText("Change Archived");
  expect(calls("archiveReview")).toEqual([{ targetKey: "a", archived: true }, { targetKey: "a", archived: false }]);
  slot.lifecycle.unmount();
});

/** All reviews over reviews that renameReview renames, as the server does: "" for none. */
async function renamable(initial: Array<Record<string, unknown>>, renameReview?: (input: any) => unknown) {
  let reviews = initial;
  const page = await inbox(reviews, {
    listReviews: () => ({ reviews }),
    renameReview: renameReview ?? (({ targetKey, name }: any) => { reviews = reviews.map((r) => r.targetKey === targetKey ? { ...r, name: name || null } : r); return { ok: true }; }),
  });
  /** Rename… from the review's ⋯, open. */
  const rename = async (title: string) => {
    const row = (await page.slot.findByText(title)).closest(".group\\/row") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "Review actions" }));
    fireEvent.click(await page.slot.findByRole("button", { name: "Rename…" }));
    const dialog = within(await page.slot.findByRole("dialog", { name: "Rename review" }));
    return { dialog, box: dialog.getByRole("textbox", { name: "Review name" }) as HTMLInputElement };
  };
  const closed = () => waitFor(() => expect(page.slot.queryByRole("dialog", { name: "Rename review" })).toBeNull());
  return { ...page, rename, closed };
}

test("Rename… gives a review in Needs review your name, with the PR's title on hover; the box finds it by either, and Undo puts the title back", async () => {
  const { slot, calls, rename, closed } = await renamable([
    { targetKey: "a", kind: "pr", repo: "acme/web", number: 3, title: "feat(LIVE-8335): auto-paginate GETs", status: "ready" },
    { targetKey: "b", kind: "pr", repo: "acme/web", number: 4, title: "Cache headers", status: "ready" },
  ]);
  const { dialog, box } = await rename("feat(LIVE-8335): auto-paginate GETs");
  // The name it goes by, selected, so typing replaces it; under it, the PR's title.
  await waitFor(() => expect(document.activeElement).toBe(box));
  expect(box.value).toBe("feat(LIVE-8335): auto-paginate GETs");
  expect([box.selectionStart, box.selectionEnd]).toEqual([0, box.value.length]);
  expect(dialog.getByText("PR title:").parentElement!.textContent).toBe("PR title: feat(LIVE-8335): auto-paginate GETs");
  // A screen reader hears the PR's title with the box.
  expect(dialog.getByRole("textbox", { name: "Review name", description: "PR title: feat(LIVE-8335): auto-paginate GETs" })).toBe(box);
  expect(dialog.getByText("Shown in your lists instead of the PR’s title. Nothing changes on GitHub.")).toBeTruthy();
  fireEvent.change(box, { target: { value: "  Sencha pagination " } });
  fireEvent.click(dialog.getByRole("button", { name: "Rename review" }));
  await closed();
  expect(calls("renameReview")).toEqual([{ targetKey: "a", name: "Sencha pagination" }]);
  const title = await within(slot.getByRole("region", { name: "Needs review" })).findByText("Sencha pagination");
  expect(title.getAttribute("title")).toBe("feat(LIVE-8335): auto-paginate GETs");
  expect(slot.queryByText("feat(LIVE-8335): auto-paginate GETs")).toBeNull();

  const find = slot.getByRole("searchbox", { name: "Find a review, or paste a PR link" });
  for (const query of ["sencha", "auto-paginate"]) {
    fireEvent.change(find, { target: { value: query } });
    expect(slot.getByText("Sencha pagination")).toBeTruthy();
    expect(slot.queryByText("Cache headers")).toBeNull();
  }
  fireEvent.change(find, { target: { value: "" } });

  expect(vi.mocked(toast.success)).toHaveBeenCalledWith("Renamed to “Sencha pagination”", expect.objectContaining({ action: expect.objectContaining({ label: "Undo" }) }));
  (vi.mocked(toast.success).mock.calls[0][1] as any).action.onClick();
  await slot.findByText("feat(LIVE-8335): auto-paginate GETs");
  expect(calls("renameReview")).toEqual([{ targetKey: "a", name: "Sencha pagination" }, { targetKey: "a", name: "" }]);
  slot.lifecycle.unmount();
});

test("in Rename…, Esc and an unchanged name change nothing, and Use PR title or an emptied box puts the PR's title back", async () => {
  const { slot, calls, rename, closed } = await renamable([{ targetKey: "a", kind: "pr", repo: "acme/web", number: 3, title: "Expire cache entries", name: "Cache expiry", status: "ready" }]);
  let { dialog, box } = await rename("Cache expiry");
  expect(box.value).toBe("Cache expiry");
  fireEvent.keyDown(box, { key: "Escape" });
  await closed();
  // The focus goes back to the menu's button.
  expect(document.activeElement).toBe(slot.getByRole("button", { name: "Review actions" }));
  ({ dialog } = await rename("Cache expiry"));
  fireEvent.click(dialog.getByRole("button", { name: "Rename review" }));
  await closed();
  expect(calls("renameReview")).toEqual([]);

  ({ dialog, box } = await rename("Cache expiry"));
  fireEvent.click(dialog.getByRole("button", { name: "Use PR title" }));
  expect(box.value).toBe("Expire cache entries");
  expect(document.activeElement).toBe(box);
  // It's the PR's title already.
  expect(dialog.queryByRole("button", { name: "Use PR title" })).toBeNull();
  fireEvent.click(dialog.getByRole("button", { name: "Rename review" }));
  await closed();
  await slot.findByText("Expire cache entries");
  expect(vi.mocked(toast.success)).toHaveBeenCalledWith("Back to the PR’s title", expect.anything());

  ({ dialog, box } = await rename("Expire cache entries"));
  fireEvent.change(box, { target: { value: "Cache expiry" } });
  fireEvent.click(dialog.getByRole("button", { name: "Rename review" }));
  await closed();
  ({ dialog, box } = await rename("Cache expiry"));
  fireEvent.change(box, { target: { value: "   " } });
  fireEvent.click(dialog.getByRole("button", { name: "Rename review" }));
  await closed();
  await slot.findByText("Expire cache entries");
  expect(calls("renameReview")).toEqual([{ targetKey: "a", name: "" }, { targetKey: "a", name: "Cache expiry" }, { targetKey: "a", name: "" }]);
  slot.lifecycle.unmount();
});

test("a rename that fails says why and keeps the dialog, with what you typed", async () => {
  const { slot, rename } = await renamable([{ targetKey: "a", kind: "pr", title: "Expire cache entries", status: "ready" }], () => ({ ok: false, error: "This review no longer exists." }));
  const { dialog, box } = await rename("Expire cache entries");
  fireEvent.change(box, { target: { value: "Cache expiry" } });
  fireEvent.click(dialog.getByRole("button", { name: "Rename review" }));
  await waitFor(() => expect(vi.mocked(toast.error)).toHaveBeenCalledWith("This review no longer exists."));
  expect(slot.getByRole("dialog", { name: "Rename review" })).toBeTruthy();
  expect(box.value).toBe("Cache expiry");
  slot.lifecycle.unmount();
});

test("a renamed local review shows your name, with its ref where a PR's repository goes", async () => {
  const { slot, rename } = await renamable([{ targetKey: "ref-1", kind: "ref", gitRef: "main...search", name: "Search revamp", status: "ready" }]);
  const row = (await slot.findByText("Search revamp")).closest("button")!;
  expect(within(row).getAllByText("main...search").length).toBeGreaterThan(0);
  const { dialog } = await rename("Search revamp");
  expect(dialog.getByText("Ref:").parentElement!.textContent).toBe("Ref: main...search");
  expect(dialog.getByRole("button", { name: "Use ref" })).toBeTruthy();
  slot.lifecycle.unmount();
});

test("with no reviews yet, a first-run panel says what a review needs and how to start one", async () => {
  const { slot } = await inbox([], { getSetupStatus: () => ({ account: null, githubCli: true, agentAvailable: true, projectAvailable: true }) });
  const panel = await slot.findByRole("region", { name: "Review your first pull request" });
  const needs = within(await within(panel).findByRole("list", { name: "What a review needs" }));
  expect(await needs.findByText("GitHub CLI on the BB server")).toBeTruthy();
  expect(needs.getByText("Sign in to GitHub on the BB server")).toBeTruthy();
  expect(needs.getByText("gh auth login --hostname github.com")).toBeTruthy();
  expect(needs.getByText("A BB agent to write guides")).toBeTruthy();
  expect(slot.getByRole("searchbox", { name: "Find a review, or paste a PR link" }).getAttribute("placeholder")).toBe("Paste a GitHub PR link to review it");
  expect(within(panel).getByText(/in any BB thread/).textContent).toBe("Paste a PR link above, or run bb review <pr> in any BB thread.");
  // A reply and a resolve post at once, too.
  expect(within(panel).getByText(/^Guides use/).textContent).toBe("Guides use your BB agent’s usual allowance. Nothing reaches GitHub until you submit, send a reply, or resolve a thread.");
  expect(slot.queryByRole("heading", { name: /^Needs review/ })).toBeNull();
  slot.lifecycle.unmount();
});

test("while the first run checks the setup, its checklist says so", async () => {
  let answer!: (setup: unknown) => void;
  const { slot } = await inbox([], { getSetupStatus: () => new Promise((resolve) => { answer = resolve; }) });
  const needs = within(await slot.findByRole("list", { name: "What a review needs" }));
  expect(needs.getByText("Checking setup…")).toBeTruthy();
  answer({ account: "me", githubCli: true, agentAvailable: true, projectAvailable: true });
  await needs.findByText("GitHub CLI on the BB server");
  expect(needs.queryByText("Checking setup…")).toBeNull();
  slot.lifecycle.unmount();
});

test("the first run looks for PRs that request your review once, and says so only while it looks", async () => {
  let finish!: () => void;
  const { slot, calls } = await inbox([], { refreshReviews: () => new Promise((resolve) => { finish = () => resolve({ reviews: [], sync: { lastReadAt: null, error: null } }); }) });
  await slot.findByText("Looking for PRs that request your review…");
  expect(calls("refreshReviews")).toEqual([{ force: false }]);
  finish();
  // Nothing found leaves GitHub's last read unset, as with no reviews to read.
  await waitFor(() => expect(slot.queryByText("Looking for PRs that request your review…")).toBeNull());
  expect(calls("refreshReviews")).toEqual([{ force: false }]);
  slot.lifecycle.unmount();
});

test("each section's rows are a list, so a screen reader says how many it holds", async () => {
  const { slot } = await inbox([{ targetKey: "a", title: "A change", status: "ready" }, { targetKey: "b", title: "B change", status: "ready" }, { targetKey: "c", title: "C change", status: "ready" }]);
  const section = await slot.findByRole("region", { name: "Needs review" });
  const list = within(section).getByRole("list");
  expect(within(list).getAllByRole("listitem").map((item) => within(item).getByRole("button", { name: /change/ }).textContent)).toEqual([
    expect.stringContaining("A change"), expect.stringContaining("B change"), expect.stringContaining("C change"),
  ]);
  slot.lifecycle.unmount();
});

test("the page scrolls itself, since BB clips a plugin page to the window", async () => {
  const { slot } = await inbox([{ targetKey: "a", title: "A change", status: "ready" }]);
  const section = await slot.findByRole("region", { name: "Needs review" });
  const page = slot.container.firstElementChild as HTMLElement;
  expect(page.contains(section)).toBe(true);
  expect(page.className.split(" ")).toEqual(expect.arrayContaining(["h-full", "overflow-y-auto"]));
  slot.lifecycle.unmount();
});

test("a row's quick actions stay focusable while one runs, rather than turning disabled under the focus, and ignore the click", async () => {
  let finish!: () => void;
  const { slot, calls } = await inbox([{ targetKey: "a", title: "Change Pinned", status: "ready", prState: "OPEN" }], {
    pinReview: () => new Promise((resolve) => { finish = () => resolve({ ok: true }); }),
    getPreferences: () => ({ preferences: { ...defaultPreferences, threadListReviews: true }, revision: 0 }),
  });
  const row = (await slot.findByText("Change Pinned")).closest(".group\\/row") as HTMLElement;
  const pin = await within(row).findByRole("button", { name: "Pin" });
  pin.focus();
  fireEvent.click(pin);
  await waitFor(() => expect(calls("pinReview")).toHaveLength(1));
  // Chrome drops the focus to the page from a focused control that turns disabled; jsdom doesn't, so this asserts the cause.
  for (const name of ["Pin", "Snooze", "Archive"]) {
    const button = within(row).getByRole("button", { name });
    expect([name, button.hasAttribute("disabled"), button.getAttribute("aria-disabled")]).toEqual([name, false, "true"]);
  }
  expect(document.activeElement).toBe(pin);
  fireEvent.click(pin);
  fireEvent.click(within(row).getByRole("button", { name: "Archive" }));
  expect(calls("pinReview")).toHaveLength(1);
  expect(calls("archiveReview")).toHaveLength(0);
  finish();
  await waitFor(() => expect(within(row).getByRole("button", { name: "Pin" }).getAttribute("aria-disabled")).toBe("false"));
  // Review actions (⋯), while what was picked from it runs.
  const menu = within(row).getByRole("button", { name: "Review actions" });
  fireEvent.click(menu);
  const menuPin = await waitFor(() => {
    const item = within(document.body).getAllByRole("button", { name: "Pin" }).find((button) => !row.contains(button));
    expect(item).toBeTruthy();
    return item!;
  });
  fireEvent.click(menuPin);
  await waitFor(() => expect(calls("pinReview")).toHaveLength(2));
  expect([menu.hasAttribute("disabled"), menu.getAttribute("aria-disabled")]).toEqual([false, "true"]);
  fireEvent.click(menu);
  expect(menu.getAttribute("aria-expanded")).toBe("false");
  finish();
  await waitFor(() => expect(menu.getAttribute("aria-disabled")).toBe("false"));
  slot.lifecycle.unmount();
});

test("archiving a row from the keyboard moves the focus to the next row, or the previous one from the last", async () => {
  let reviews = ["A", "B", "C"].map((name) => ({ targetKey: name, title: `Change ${name}`, status: "ready", prState: "OPEN", userArchivedAt: null as number | null }));
  const { slot, header } = await inbox(reviews, {
    listReviews: () => ({ reviews }),
    archiveReview: ({ targetKey, archived }: any) => { reviews = reviews.map((r) => r.targetKey === targetKey ? { ...r, userArchivedAt: archived ? 5 : null } : r); return { ok: true }; },
  });
  await slot.findByText("Change C");
  const section = header("Needs review").closest("section")!;
  const rowButtons = () => Array.from(section.querySelectorAll<HTMLElement>("[data-row]"));
  const archive = async (row: HTMLElement) => {
    const button = within(row.closest(".group\\/row") as HTMLElement).getByRole("button", { name: "Archive" });
    button.focus();
    fireEvent.click(button);
    await waitFor(() => expect(rowButtons()).not.toContain(row));
  };
  const [first, middle, last] = rowButtons();
  await archive(middle!);
  expect(document.activeElement).toBe(last);
  await archive(last!);
  expect(document.activeElement).toBe(first);
  slot.lifecycle.unmount();
});

// bug bash verification 72-2: a choice in a row's ⋯ menu or Snooze is portaled out of the row, and once the menu closed the
// focus was on the page, or still on the closing menu's choice, not in the row, so it stayed there when the row moved.
test("archiving or snoozing a row from its ⋯ menu or Snooze choices moves the focus to the next row", async () => {
  let reviews = ["A", "B", "C"].map((name) => ({ targetKey: name, kind: "pr", repo: "acme/app", number: 1, title: `Change ${name}`, status: "ready", prState: "OPEN",
    userArchivedAt: null as number | null, turn: turn("needs", "requested", "Review requested") as Turn }));
  const { slot, header } = await inbox(reviews, {
    listReviews: () => ({ reviews }),
    archiveReview: ({ targetKey, archived }: any) => { reviews = reviews.map((r) => r.targetKey === targetKey ? { ...r, userArchivedAt: archived ? 5 : null, turn: turn("archive", "archived", "Archived") } : r); return { ok: true }; },
    snoozeReview: ({ targetKey }: any) => { reviews = reviews.map((r) => r.targetKey === targetKey ? { ...r, turn: turn("waiting", "snoozed", "Snoozed") } : r); return { ok: true }; },
  });
  await slot.findByText("Change C");
  const section = header("Needs review").closest("section")!;
  const rowButtons = () => Array.from(section.querySelectorAll<HTMLElement>("[data-row]"));
  const pickFrom = async (row: HTMLElement, trigger: string, choice: RegExp) => {
    const opener = within(row.closest(".group\\/row") as HTMLElement).getByRole("button", { name: trigger });
    fireEvent.click(opener);
    const menu = await waitFor(() => document.getElementById(opener.getAttribute("aria-controls")!)!);
    const item = within(menu).getByRole("button", { name: choice });
    item.focus();
    fireEvent.click(item);
    await waitFor(() => expect(rowButtons()).not.toContain(row));
  };
  const [first, middle, last] = rowButtons();
  await pickFrom(middle!, "Review actions", /^Archive$/);
  expect(document.activeElement).toBe(last);
  await pickFrom(last!, "Snooze", /^Tomorrow/);
  expect(document.activeElement).toBe(first);
  slot.lifecycle.unmount();
});
