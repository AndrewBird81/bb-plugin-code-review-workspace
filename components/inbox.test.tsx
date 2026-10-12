// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { toast } from "sonner";
import { defaultPreferences } from "../src/preferences";
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
  expect(slot.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual(["Needs review· 1", "Reviewed· 1", "Archive· 1"]);
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
  expect(slot.getByRole("heading", { name: /^Reviewed/ }).textContent).toBe("Reviewed· 1");
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
  expect(slot.queryByRole("heading", { name: /^Needs review/ })).toBeNull();
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

test("the page scrolls itself, since BB clips a plugin page to the window", async () => {
  const { slot } = await inbox([{ targetKey: "a", title: "A change", status: "ready" }]);
  const section = await slot.findByRole("region", { name: "Needs review" });
  const page = slot.container.firstElementChild as HTMLElement;
  expect(page.contains(section)).toBe(true);
  expect(page.className.split(" ")).toEqual(expect.arrayContaining(["h-full", "overflow-y-auto"]));
  slot.lifecycle.unmount();
});
