// @vitest-environment jsdom
// Needs review's Ready to approve: what your other threads asked to approve, merge or close, waiting for your click.
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { defaultPreferences } from "../src/preferences";
import type { Turn } from "../lib/turn";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
afterEach(() => { cleanup(); sessionStorage.clear(); localStorage.clear(); vi.clearAllMocks(); });

const ready: Turn = { group: "needs", reason: "ready-to-approve", label: "Ready to approve", signal: null, at: Date.now() - 60_000, notify: false, blocking: false, updated: false, eventAt: null, failed: false };
/** acme/api#n, with a relayed approval (or `action`) asked on sha<n>; `moved`, the sync has seen a newer head. */
const row = (number: number, body: string, { action = "approve", moved = false }: { action?: "approve" | "merge" | "close"; moved?: boolean } = {}) => ({
  targetKey: `pr-${number}`, kind: "pr", repo: "acme/api", number, title: `Change ${number}`, url: `https://github.com/acme/api/pull/${number}`, status: "ready", headSha: `sha${number}`, latestHeadSha: moved ? `new${number}` : `sha${number}`, turn: ready,
  // You reviewed it on the sha it was asked on: the sync counts 2 commits since, once it's moved.
  signals: { lastReviewSha: `sha${number}`, commitsSince: moved ? 2 : 0 },
  readyToApprove: { action, verdict: action === "approve" ? "APPROVE" : null, body, comments: [], headSha: `sha${number}`, token: `t${number}`, from: "thr_orchestrator", fromTitle: "Release orchestrator", at: Date.now() - 60_000,
    ...action === "merge" ? { merge: { method: "squash", auto: false, deleteBranch: false } } : {} },
});

/** A review once its row has gone: approved, so Reviewed. */
const done = (review: any) => ({ ...review, readyToApprove: null, turn: { ...ready, group: "reviewed", reason: "approved", label: "Approved" } });

async function page(reviews: any[], approveReady: (input: any) => unknown = () => ({ results: [] })) {
  let listed = reviews;
  const app = await loadPluginApp(() => import("../app"));
  const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: {
    setReviewPresence: () => ({ ok: true }),
    getGhAccounts: () => ({ active: "me", accounts: [] }),
    getPreferences: () => ({ preferences: defaultPreferences, revision: 0 }),
    getSetupStatus: () => ({ account: "me", githubCli: true, agentAvailable: true, projectAvailable: true }),
    listReviews: () => ({ reviews: listed }),
    refreshReviews: () => ({ reviews: listed }),
    listFilterViews: () => ({ views: [] }),
    approveReady: async (input: any) => {
      const result = await approveReady(input) as { results: Array<{ targetKey: string; outcome: string }> };
      // What posted leaves the part, as the server clears its row: the review stays, reviewed.
      const posted = new Set(result.results.filter((r) => r.outcome === "posted").map((r) => r.targetKey));
      listed = listed.map((review) => posted.has(review.targetKey) ? done(review) : review);
      return result;
    },
    dismissReady: ({ targetKey }: { targetKey: string }) => { listed = listed.map((review) => review.targetKey === targetKey ? done(review) : review); return { ok: true }; },
  } as any });
  const part = async () => slot.findByRole("group", { name: "Ready to approve" });
  const calls = (method: string) => slot.inspection.rpcCalls.filter((call) => call.method === method).map((call) => call.input);
  const rowOf = (group: HTMLElement, id: string) => within(group).getAllByRole("listitem").find((item) => item.querySelector(`button[aria-label="Open ${id}"]`))!;
  return { slot, part, calls, rowOf };
}

test("Ready to approve leads Needs review: each row reads what it does, the PR's id and its summary, shows exactly what posts once, names the thread that asked, and the account", async () => {
  const { slot, part, rowOf } = await page([row(4512, "LGTM, thanks!\nThe retry fix reads well."), row(12, ""), row(13, "Ship it.")]);
  const group = await part();
  expect(await within(group).findByText(/as @me only when you click it/)).toBeTruthy();
  const long = rowOf(group, "api#4512");
  // A summary of more than one line shows whole, once, under its row's first line.
  expect(long.textContent).toContain("Approve · api#4512");
  expect(long.textContent!.match(/LGTM, thanks!/g)).toHaveLength(1);
  expect(Array.from(long.querySelectorAll("p"), (p) => p.textContent)).toContain("Exactly what posts: LGTM, thanks!\nThe retry fix reads well.");
  // The thread that asked, by its title, opens it.
  expect(within(long).getByRole("button", { name: "Release orchestrator" })).toBeTruthy();
  // No summary: said apart from what posts.
  const bare = rowOf(group, "api#12");
  expect(within(bare).getByText("(no message, approval only)").className).toContain("italic");
  expect(rowOf(group, "api#13").textContent).toContain("Approve · api#13 · Ship it.");
  expect(within(long).getByRole("button", { name: "Approve api#4512" })).toBeTruthy();
  slot.lifecycle.unmount();
});

test("Approve N posts each approval shown but the held ones and merges or closes, each row saying how it went, then what posted, with links, until dismissed", async () => {
  const { slot, part, calls, rowOf } = await page([row(1, "Ship it."), row(2, "Ship it."), row(3, "Ship it.", { moved: true }), row(4, "Ship it."), row(5, "", { action: "merge" })],
    ({ rows }) => ({ results: rows.map((r: any) => ({ targetKey: r.targetKey, outcome: "posted", url: `https://github.com/acme/api/pull/${r.targetKey.slice(3)}#pullrequestreview-1` })) }));
  const group = await part();
  // The held one says so before anything is tried, with the commits it covers.
  expect(within(rowOf(group, "api#3")).getByText("Held: 2 new commits since you read it. Approving covers them too.")).toBeTruthy();
  expect(group.textContent).toContain("Skips 1 held, 1 merge");
  // The strip under them says the commits too.
  expect(group.textContent).toContain("1 held: 2 new commits since you read it");
  const bulk = within(group).getByRole("button", { name: "Approve 3" });
  fireEvent.click(bulk);
  await waitFor(() => expect(calls("approveReady")).toHaveLength(3));
  expect(calls("approveReady")).toEqual([{ rows: [{ targetKey: "pr-1", token: "t1" }] }, { rows: [{ targetKey: "pr-2", token: "t2" }] }, { rows: [{ targetKey: "pr-4", token: "t4" }] }]);
  // What posted left the list, and says so, with links, until dismissed.
  const notice = await slot.findByText(/^Approved 3 on GitHub:/);
  expect(Array.from(notice.querySelectorAll("a"), (a) => [a.textContent, a.getAttribute("href")])).toEqual([
    ["api#1", "https://github.com/acme/api/pull/1#pullrequestreview-1"], ["api#2", "https://github.com/acme/api/pull/2#pullrequestreview-1"], ["api#4", "https://github.com/acme/api/pull/4#pullrequestreview-1"],
  ]);
  await waitFor(() => expect(within(group).queryByRole("button", { name: "Approve api#1" })).toBeNull());
  fireEvent.click(within(group).getByRole("button", { name: "Approve it too" }));
  await waitFor(() => expect(calls("approveReady").at(-1)).toEqual({ rows: [{ targetKey: "pr-3", token: "t3" }], alsoHeld: true }));
  expect(await slot.findByText(/^Approved on GitHub:/)).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: "Dismiss what was posted" }));
  await waitFor(() => expect(slot.queryByText(/on GitHub:/)).toBeNull());
  slot.lifecycle.unmount();
});

test("while a row posts it says so, the rows waiting their turn are unavailable, and a posted one says Approved until the run ends", async () => {
  const gates: Array<() => void> = [];
  const { slot, part, rowOf } = await page([row(1, "Ship it."), row(2, "Ship it.")], ({ rows }) =>
    new Promise<void>((resolve) => { gates.push(resolve); }).then(() => ({ results: [{ targetKey: rows[0].targetKey, outcome: "posted" }] })) as any);
  const group = await part();
  fireEvent.click(within(group).getByRole("button", { name: "Approve 2" }));
  expect(await within(rowOf(group, "api#1")).findByText("Approving…")).toBeTruthy();
  expect(within(rowOf(group, "api#2")).getByRole("button", { name: "Approve api#2" }).getAttribute("aria-disabled")).toBe("true");
  gates[0]!();
  expect(await within(rowOf(group, "api#1")).findByText("Approved")).toBeTruthy();
  expect(await within(rowOf(group, "api#2")).findByText("Approving…")).toBeTruthy();
  await waitFor(() => expect(gates).toHaveLength(2));
  gates[1]!();
  expect(await slot.findByText(/^Approved 2 on GitHub:/)).toBeTruthy();
  slot.lifecycle.unmount();
});

test("a row GitHub holds says how many commits it covers, and Approve it too posts it past them; one that fails says why and stays", async () => {
  let tries = 0;
  const { slot, part, calls } = await page([row(7, "LGTM"), row(8, "LGTM")], ({ rows, alsoHeld }) => ({ results: rows.map((r: any) => r.targetKey === "pr-8"
    ? { targetKey: r.targetKey, outcome: "failed", error: "GitHub allows only a Comment review on your own PR." }
    : alsoHeld || tries++ ? { targetKey: r.targetKey, outcome: "posted" } : { targetKey: r.targetKey, outcome: "held", error: "This approval covers 1 commit you haven't seen.", commits: 1 }) }));
  const group = await part();
  fireEvent.click(within(group).getByRole("button", { name: "Approve api#7" }));
  expect(await within(group).findByText("Held: 1 new commit since you read it. Approving covers it too.")).toBeTruthy();
  fireEvent.click(within(group).getAllByRole("button", { name: /Approve it too/ })[0]!);
  await waitFor(() => expect(calls("approveReady").at(-1)).toEqual({ rows: [{ targetKey: "pr-7", token: "t7" }], alsoHeld: true }));
  fireEvent.click(await within(group).findByRole("button", { name: "Approve api#8" }));
  expect(await within(group).findByText("GitHub allows only a Comment review on your own PR.")).toBeTruthy();
  expect(within(group).getByRole("button", { name: "Approve api#8" })).toBeTruthy();
  slot.lifecycle.unmount();
});

test("a merge or close shows how it's done and takes its own click; Dismiss takes a row out, posting nothing", async () => {
  const { slot, part, calls } = await page([row(5, "", { action: "merge" }), row(6, "", { action: "close" }), row(9, "OK")]);
  const group = await part();
  expect(group.textContent).toContain("Squashed into one commit, at sha5, the commit you reviewed.");
  expect(group.textContent).toContain("Closes the PR without merging it.");
  expect(within(group).getByRole("button", { name: "Merge api#5" })).toBeTruthy();
  expect(within(group).getByRole("button", { name: "Close PR api#6" })).toBeTruthy();
  // One approval alone: its own Approve is enough.
  expect(within(group).queryByRole("button", { name: /^Approve \d/ })).toBeNull();
  fireEvent.click(within(group).getByRole("button", { name: "Dismiss api#6" }));
  await waitFor(() => expect(calls("dismissReady")).toEqual([{ targetKey: "pr-6", token: "t6" }]));
  await waitFor(() => expect(within(group).queryByRole("button", { name: "Close PR api#6" })).toBeNull());
  expect(calls("approveReady")).toEqual([]);
  slot.lifecycle.unmount();
});

test("a row says when comments on your PR came after it was asked, so you read them before you merge (3.4-fixes2 P1)", async () => {
  const asked = Date.now() - 60_000;
  const merge = row(90, "", { action: "merge" });
  const close = row(91, "", { action: "close" });
  const { part, rowOf } = await page([
    { ...merge, ownPr: true, signals: { ...merge.signals, newComments: { count: 2, at: asked + 30_000, by: "bob" } } },
    // Comments from before it was asked were there when it was.
    { ...close, ownPr: true, signals: { ...close.signals, newComments: { count: 1, at: asked - 30_000, by: "bob" } } },
  ]);
  const group = await part();
  expect(rowOf(group, "api#90").textContent).toContain("2 new comments on your PR, the latest since this was asked.");
  expect(rowOf(group, "api#91").textContent).not.toContain("since this was asked");
});
