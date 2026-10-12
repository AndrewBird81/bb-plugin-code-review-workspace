// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { defaultPreferences } from "../src/preferences";
import type { Turn } from "../lib/turn";
// The list keeps its filter for the session, and its sections' state in this browser.
afterEach(() => { cleanup(); sessionStorage.clear(); localStorage.clear(); });

const DAY = 86_400_000;
const now = Date.now();
const turn = (group: Turn["group"], reason: Turn["reason"], label: string, extra: Partial<Turn> = {}): Turn =>
  ({ group, reason, label, action: "Open review", signal: null, at: null, notify: false, blocking: false, updated: false, eventAt: null, failed: false, ...extra });

async function list(reviews: any[], overrides: Record<string, (input: any) => unknown> = {}) {
  const app = await loadPluginApp(() => import("../app"));
  const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: {
    setReviewPresence: () => ({ ok: true }),
    getGhAccounts: () => ({ active: "me", accounts: [] }),
    getSetupStatus: () => ({ account: "me", githubCli: true, agentAvailable: true, projectAvailable: true }),
    listReviews: () => ({ reviews }),
    ...overrides,
  } });
  /** A section's header, which opens or closes it, and says how many are in it. */
  const header = (name: RegExp) => within(slot.getByRole("heading", { name })).getByRole("button");
  const open = async (name: RegExp) => { await slot.findByRole("heading", { name }); if (header(name).getAttribute("aria-expanded") === "false") fireEvent.click(header(name)); };
  const titles = () => slot.getAllByText(/^Change \w+$/).map((title) => title.textContent);
  const calls = (method: string) => slot.inspection.rpcCalls.filter((call) => call.method === method).map((call) => call.input);
  return { slot, header, open, titles, calls };
}

test("sections group reviews by the server's turn, or a computed one, and count each", async () => {
  const { slot, header, open, titles } = await list([
    { targetKey: "a", title: "Change A", status: "ready", turn: turn("needs", "question", "Question for you") },
    { targetKey: "b", title: "Change B", status: "ready", turn: turn("waiting", "waiting", "Changes requested") },
    { targetKey: "c", title: "Change C", status: "ready", submittedVerdict: "REQUEST_CHANGES", submittedAt: now - DAY },
    { targetKey: "d", title: "Change D", status: "ready", turn: turn("reviewed", "approved", "Approved") },
    { targetKey: "e", title: "Change E", status: "ready", turn: turn("archive", "merged", "Merged") },
    { targetKey: "f", title: "Change F", status: "tracked", signals: { requestPending: true, requestedVia: "user" } },
  ]);
  await slot.findByText("Change A");
  const count = (name: RegExp) => header(name).textContent?.match(/\d+$/)?.[0];
  expect([count(/^Needs review/), count(/^Waiting on author/), count(/^Reviewed/), count(/^Archive/)]).toEqual(["2", "2", "1", "1"]);
  expect(titles().sort()).toEqual(["Change A", "Change F"]);
  expect(slot.getByText("Review requested")).toBeTruthy();
  await open(/^Waiting on author/);
  expect(titles()).toEqual(expect.arrayContaining(["Change B", "Change C"]));
  await open(/^Reviewed/);
  await slot.findByText("Change D");
  await open(/^Archive/);
  await slot.findByText("Change E");
  slot.lifecycle.unmount();
});

test("Needs review puts blocking reviews first, then what came back to you, new requests, and team requests in their own part", async () => {
  const { slot, titles } = await list([
    { targetKey: "a", title: "Change Recent", status: "ready", turn: turn("needs", "requested", "Review requested", { at: now - DAY }) },
    { targetKey: "b", title: "Change Team", status: "ready", turn: turn("needs", "team-requested", "Team review requested", { at: now - 9 * DAY }) },
    { targetKey: "c", title: "Change Old", status: "ready", turn: turn("needs", "re-requested", "Re-requested", { at: now - 5 * DAY }) },
    { targetKey: "d", title: "Change Blocking", status: "ready", turn: turn("needs", "question", "Question for you", { at: now - 60_000, blocking: true }) },
    { targetKey: "e", title: "Change Unstamped", status: "ready", createdAt: now - 3 * DAY, turn: turn("needs", "new", "Ready") },
  ]);
  await slot.findByText("Change Recent");
  expect(titles()).toEqual(["Change Blocking", "Change Old", "Change Unstamped", "Change Recent", "Change Team"]);
  const heading = slot.getByRole("heading", { name: /^Team requests/ });
  expect(heading.compareDocumentPosition(slot.getByText("Change Team")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(heading.compareDocumentPosition(slot.getByText("Change Recent")) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
  slot.lifecycle.unmount();
});

test("Waiting on author lists the most recent activity first; with no one waiting it hides", async () => {
  const { slot, open, titles } = await list([
    { targetKey: "a", title: "Change Quiet", status: "ready", turn: turn("waiting", "waiting", "Changes requested", { at: now - 5 * DAY }) },
    { targetKey: "b", title: "Change Pushed", status: "ready", signals: { headSeenAt: now - DAY }, turn: turn("waiting", "waiting", "Changes requested", { at: now - 6 * DAY }) },
    { targetKey: "c", title: "Change Snoozed", status: "ready", turn: turn("waiting", "snoozed", "Not yet", { at: now - 2 * DAY }) },
  ]);
  await open(/^Waiting on author/);
  await slot.findByText("Change Quiet");
  expect(titles()).toEqual(["Change Pushed", "Change Snoozed", "Change Quiet"]);
  expect(slot.queryByRole("heading", { name: /^Team requests/ })).toBeNull();
  slot.lifecycle.unmount();

  const empty = await list([{ targetKey: "a", title: "Change Fresh", status: "ready" }]);
  await empty.slot.findByText("Change Fresh");
  expect(empty.slot.queryByRole("heading", { name: /^Waiting on author/ })).toBeNull();
  empty.slot.lifecycle.unmount();
});

test("a row says why it's your turn, how the feedback stands, new commits, CI, and how long it's waited", async () => {
  const { slot } = await list([
    { targetKey: "a", title: "Change A", status: "ready", signals: { requestedBy: "alice", commitsSince: 3, ci: "fail" }, progress: { done: 2, total: 5, source: "assistant" },
      turn: turn("needs", "re-requested", "Re-requested", { at: now - 2 * DAY, blocking: true }) },
    { targetKey: "b", title: "Change B", status: "generating", signals: { commitsSince: 1, ci: "pass" }, progress: { done: 1, total: 4, source: "threads" },
      turn: turn("needs", "question", "Generating", { at: now - 3 * 3_600_000 }) },
  ]);
  const row = async (title: string) => within((await slot.findByText(title)).closest("button")!);
  const a = await row("Change A");
  for (const text of ["Blocks merge", "Re-requested by @alice", "2/5 addressed", "+3 commits", "Checks failing", "2d"]) expect(a.getByText(text)).toBeTruthy();
  // The guide being built is what to know first; passing checks say nothing.
  const b = await row("Change B");
  for (const text of ["Building guide…", "1/4 handled", "+1 commit", "3h"]) expect(b.getByText(text)).toBeTruthy();
  expect(b.queryByText("Checks passing")).toBeNull();
  expect(slot.getAllByText("Blocks merge")).toHaveLength(1);
  slot.lifecycle.unmount();
});

test("a review you gave can wait until its author responds, come back to Needs review, and a tracked review can build its guide", async () => {
  const reviews = [
    { targetKey: "given", title: "Change Given", status: "ready", submittedVerdict: "REQUEST_CHANGES", submittedAt: now - DAY, turn: turn("needs", "question", "Question for you") },
    { targetKey: "fresh", title: "Change Fresh", status: "ready", turn: turn("needs", "requested", "Review requested") },
    { targetKey: "tracked", title: "Change Tracked", status: "tracked", turn: turn("needs", "requested", "Review requested") },
    { targetKey: "snoozed", title: "Change Snoozed", status: "ready", signals: { lastReviewAt: 1 }, turn: turn("waiting", "snoozed", "Not yet") },
  ];
  const { slot, open, calls } = await list(reviews, {
    snoozeReview: () => ({ ok: true }),
    startTrackedReview: () => ({ ok: true }),
  });
  const menu = async (title: string) => {
    const row = (await slot.findByText(title)).closest(".group\\/row") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "Review actions" }));
    return within(await slot.findByRole("dialog"));
  };
  let actions = await menu("Change Given");
  expect(actions.queryByRole("button", { name: "Build the guide" })).toBeNull();
  fireEvent.click(actions.getByRole("button", { name: "Snooze" }));
  fireEvent.click(await actions.findByRole("button", { name: "Until the author responds" }));
  await waitFor(() => expect(calls("snoozeReview")).toEqual([{ targetKey: "given", snoozed: true }]));
  // onChanged relists.
  await waitFor(() => expect(calls("listReviews").length).toBeGreaterThan(1));

  actions = await menu("Change Fresh");
  fireEvent.click(actions.getByRole("button", { name: "Snooze" }));
  await actions.findByRole("button", { name: /^Tomorrow/ });
  expect(actions.queryByRole("button", { name: "Until the author responds" })).toBeNull();
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
  await waitFor(() => expect(slot.queryByRole("dialog")).toBeNull());

  actions = await menu("Change Tracked");
  fireEvent.click(actions.getByRole("button", { name: "Build the guide" }));
  await waitFor(() => expect(calls("startTrackedReview")).toEqual([{ targetKey: "tracked" }]));
  await waitFor(() => expect(slot.queryByRole("dialog")).toBeNull());

  await open(/^Waiting on author/);
  actions = await menu("Change Snoozed");
  expect(actions.queryByRole("button", { name: "Snooze" })).toBeNull();
  fireEvent.click(actions.getByRole("button", { name: "Back to Needs review" }));
  await waitFor(() => expect(calls("snoozeReview")).toEqual([{ targetKey: "given", snoozed: true }, { targetKey: "snoozed", snoozed: false }]));
  slot.lifecycle.unmount();
});

test("a new request can be snoozed until a time from its row, and the row says when it wakes", async () => {
  const { snoozeTimes, snoozeLabel } = await import("../lib/turn");
  const until = now + 3 * DAY;
  const { slot, open, calls } = await list([
    { targetKey: "fresh", kind: "pr", title: "Change Fresh", status: "tracked", turn: turn("needs", "requested", "Review requested") },
    { targetKey: "later", kind: "pr", title: "Change Later", status: "tracked", snoozedUntil: until, turn: turn("waiting", "snoozed", "Snoozed") },
  ], { snoozeReview: () => ({ ok: true }) });
  const row = (await slot.findByText("Change Fresh")).closest(".group\\/row") as HTMLElement;
  // The row's own Snooze, which a fine pointer shows on hover.
  fireEvent.click(within(row).getByRole("button", { name: "Snooze" }));
  const tomorrow = snoozeTimes().tomorrow;
  fireEvent.click(await slot.findByRole("button", { name: /^Tomorrow/ }));
  await waitFor(() => expect(calls("snoozeReview")).toEqual([{ targetKey: "fresh", snoozed: true, until: tomorrow }]));
  await open(/^Waiting on author/);
  expect(await slot.findByText(snoozeLabel(until))).toBeTruthy();
  slot.lifecycle.unmount();
});

test("a date picked in the snooze menu wakes the review that morning", async () => {
  const { slot, calls } = await list([
    { targetKey: "fresh", kind: "pr", title: "Change Fresh", status: "tracked", turn: turn("needs", "requested", "Review requested") },
  ], { snoozeReview: () => ({ ok: true }) });
  const row = (await slot.findByText("Change Fresh")).closest(".group\\/row") as HTMLElement;
  fireEvent.click(within(row).getByRole("button", { name: "Review actions" }));
  const actions = within(await slot.findByRole("dialog"));
  fireEvent.click(actions.getByRole("button", { name: "Snooze" }));
  fireEvent.click(await actions.findByRole("button", { name: "Pick a date…" }));
  fireEvent.change(await actions.findByLabelText("Snooze until a date"), { target: { value: "2099-03-02" } });
  fireEvent.click(actions.getByRole("button", { name: "Snooze" }));
  await waitFor(() => expect(calls("snoozeReview")).toEqual([{ targetKey: "fresh", snoozed: true, until: new Date(2099, 2, 2, 9).getTime() }]));
  slot.lifecycle.unmount();
});

test("status badges take their tone from why it's your turn", async () => {
  await loadPluginApp(() => import("../app"));
  const { statusLook } = await import("./ReviewStatus");
  const look = (t: Turn, extra = {}) => { const { tone, icon } = statusLook({ targetKey: "k", turn: t, ...extra }); return [tone, icon]; };
  expect(look(turn("needs", "re-requested", "Re-requested"))).toEqual(["primary", "Repeat"]);
  expect(look(turn("needs", "team-requested", "Team review requested"))).toEqual(["neutral", undefined]);
  expect(look(turn("needs", "question", "Question for you"))).toEqual(["warning", "MessageQuestion"]);
  expect(look(turn("needs", "handled", "Feedback handled"))).toEqual(["success", "CircleCheck"]);
  expect(look(turn("needs", "looks-ready", "Looks ready"))).toEqual(["agent", "Sparkles"]);
  expect(look(turn("waiting", "waiting", "Changes requested"))).toEqual(["warning", "FileDiff"]);
  expect(look(turn("waiting", "waiting", "Commented"))).toEqual(["neutral", "MessageSquare"]);
  expect(look(turn("waiting", "snoozed", "Not yet"))).toEqual(["neutral", "Clock"]);
  expect(look(turn("reviewed", "approved", "Approved · updated"))).toEqual(["success", "Check"]);
  expect(look(turn("needs", "new", "Tracked"))).toEqual(["primary", undefined]);
  expect(look(turn("needs", "own", "Your PR"))).toEqual(["primary", "UserRound"]);
  expect(look(turn("reviewed", "own", "Your PR · updated"))).toEqual(["neutral", "UserRound"]);
  expect(look(turn("archive", "unrequested", "No longer requested"))).toEqual(["neutral", undefined]);
  expect(look(turn("archive", "unreachable", "Can’t read on GitHub"))).toEqual(["neutral", "EyeOff"]);
  // The agent's work, in the agent's tone.
  expect(look(turn("needs", "question", "Generating"))).toEqual(["agent", "Loading"]);
  // A failed guide keeps the reason underneath; the badge shows the failure.
  expect(look(turn("needs", "re-requested", "Failed", { failed: true }))).toEqual(["danger", "AlertTriangle"]);
});

test("whose-turn settings save into preferences, with one repository pattern per line", async () => {
  await loadPluginApp(() => import("../app"));
  const { ReviewSettings } = await import("./ReviewSettings");
  let record = { preferences: { ...defaultPreferences }, revision: 0 };
  const save = vi.fn(async (input: any) => record = { ...input, revision: input.revision + 1 });
  const slot = renderSlot({ component: ReviewSettings }, {}, { rpc: { setReviewPresence: () => ({ ok: true }), getPreferences: () => record, savePreferences: save } });
  const replies = await slot.findByRole("group", { name: "When the author replies" });
  expect(within(replies).getByRole("button", { name: "Questions for you" }).getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(within(replies).getByRole("button", { name: "Any reply" }));
  fireEvent.click(within(slot.getByRole("group", { name: "After the author pushes" })).getByRole("button", { name: /bring it back when everything/ }));
  // Team requests are opt-in, and only while tracking is on.
  const teams = slot.getByRole("checkbox", { name: /Include team requests/ }) as HTMLInputElement;
  expect(teams.checked).toBe(false);
  fireEvent.click(teams);
  fireEvent.click(slot.getByRole("checkbox", { name: /Track reviews from GitHub/ }));
  expect(teams.disabled).toBe(true);
  const repos = slot.getByRole("textbox", { name: "Start guides automatically" }) as HTMLTextAreaElement;
  fireEvent.change(repos, { target: { value: "  Acme/App \n\n acme/*\n" } });
  // The typed text, blank lines included, stays while editing.
  expect(repos.value).toBe("  Acme/App \n\n acme/*\n");
  const prompt = slot.getByRole("textbox", { name: "Re-review check" }) as HTMLTextAreaElement;
  expect(prompt.value).toBe(defaultPreferences.verificationPrompt);
  fireEvent.change(prompt, { target: { value: "" } });
  fireEvent.click(slot.getByRole("button", { name: "Save settings" }));
  await slot.findByText("Settings saved");
  expect(save.mock.calls[0][0].preferences).toMatchObject({ wakeOnReplies: "any", pushChecks: "ready", trackGithubReviews: false, trackTeamRequests: true, autoStartRepos: ["acme/app", "acme/*"], verificationPrompt: "" });
  expect(repos.value).toBe("  Acme/App \n\n acme/*\n");

  // Restore defaults clears the patterns.
  fireEvent.click(slot.getByRole("button", { name: "Restore defaults" }));
  await waitFor(() => expect(repos.value).toBe(""));
  fireEvent.click(slot.getByRole("button", { name: "Discard edits" }));
  await waitFor(() => expect(repos.value).toBe("acme/app\nacme/*"));
  slot.lifecycle.unmount();
});
