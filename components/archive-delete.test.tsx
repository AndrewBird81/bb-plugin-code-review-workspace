// @vitest-environment jsdom
import { afterEach, expect, test } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { getReviewState, patchReviewState } from "../lib/panel-state";
import { readDraftRecovery, updateDraftRecovery } from "../lib/draft-recovery";
import { defaultPreferences } from "../src/preferences";
afterEach(() => { cleanup(); localStorage.clear(); sessionStorage.clear(); });

const guide = { title: "Guide", intent: "Intent", sections: [{ id: "core", title: "Core", overview: "Overview", diffs: [{ file: "a.ts", summary: "Adds a" }] }], unplacedFiles: [] };

/** The saved-review list over an in-memory list that archive/delete RPCs update. */
async function list(initial: any[], overrides: Record<string, (input: any) => unknown> = {}) {
  let reviews = initial;
  const app = await loadPluginApp(() => import("../app"));
  const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: {
    setReviewPresence: () => ({ ok: true }),
    getGhAccounts: () => ({ active: "me", accounts: [] }),
    listReviews: () => ({ reviews }),
    archiveReview: ({ targetKey, archived }: any) => { reviews = reviews.map((r) => r.targetKey === targetKey ? { ...r, userArchivedAt: archived ? 5 : null } : r); return { ok: true }; },
    pinReview: ({ targetKey, pinned }: any) => { reviews = reviews.map((r) => r.targetKey === targetKey ? { ...r, pinnedAt: pinned ? 5 : null } : r); return { ok: true }; },
    getPreferences: () => ({ preferences: defaultPreferences, revision: 0 }),
    deleteReview: ({ targetKey }: any) => { reviews = reviews.filter((r) => r.targetKey !== targetKey); return { ok: true }; },
    ...overrides,
  } });
  /** Open a section, such as Archive, which starts closed. */
  const open = async (name: RegExp) => {
    const header = within(await slot.findByRole("heading", { name })).getByRole("button");
    if (header.getAttribute("aria-expanded") === "false") fireEvent.click(header);
  };
  /** The review's menu, open. */
  const menu = async () => {
    fireEvent.click(slot.getByRole("button", { name: "Review actions" }));
    return within(await slot.findByRole("dialog"));
  };
  return { slot, open, menu, calls: (method: string) => slot.inspection.rpcCalls.filter((call) => call.method === method).map((call) => call.input) };
}

test("archiving an unfinished review moves it to Archive until it is unarchived", async () => {
  const { slot, open, menu, calls } = await list([{ targetKey: "a", title: "Abandoned change", status: "ready", prState: "OPEN" }]);
  await slot.findByText("Abandoned change");
  expect(slot.getByRole("button", { name: "Review actions" }).getAttribute("aria-describedby")).toBe(slot.getByText("Abandoned change").id);
  fireEvent.click((await menu()).getByRole("button", { name: "Archive" }));
  await slot.findByText(/^Nothing needs you right now/);
  expect(calls("archiveReview")).toEqual([{ targetKey: "a", archived: true }]);

  await open(/^Archive/);
  await slot.findByText("Abandoned change");
  expect(slot.getByText("Archived by you")).toBeTruthy();
  fireEvent.click((await menu()).getByRole("button", { name: "Unarchive" }));
  await waitFor(() => expect(slot.queryByRole("heading", { name: /^Archive/ })).toBeNull());
  expect(calls("archiveReview")).toEqual([{ targetKey: "a", archived: true }, { targetKey: "a", archived: false }]);
  expect(within(slot.getByRole("region", { name: "Needs review" })).getByText("Abandoned change")).toBeTruthy();
  slot.lifecycle.unmount();
});

test("Pin puts a review with your pinned threads and marks it in the list; Unpin takes it out", async () => {
  const { slot, menu, calls } = await list([{ targetKey: "a", title: "Important change", status: "ready", prState: "OPEN" }]);
  await slot.findByText("Important change");
  expect(slot.queryByLabelText("Pinned")).toBeNull();
  // Settings loads after the list: Pin waits for it.
  await waitFor(() => expect(slot.getAllByRole("button", { name: "Pin" })).toHaveLength(1));
  fireEvent.click((await menu()).getByRole("button", { name: "Pin" }));
  expect(await slot.findByLabelText("Pinned")).toBeTruthy();
  fireEvent.click((await menu()).getByRole("button", { name: "Unpin" }));
  await waitFor(() => expect(slot.queryByLabelText("Pinned")).toBeNull());
  expect(calls("pinReview")).toEqual([{ targetKey: "a", pinned: true }, { targetKey: "a", pinned: false }]);
  slot.lifecycle.unmount();
});

test("with reviews kept out of the thread list in Settings, there's no Pin, and no pin in the list", async () => {
  const { slot, menu } = await list([{ targetKey: "a", title: "Important change", status: "ready", prState: "OPEN", pinnedAt: 5 }], { getPreferences: () => ({ preferences: { ...defaultPreferences, threadListReviews: false }, revision: 0 }) });
  await slot.findByText("Important change");
  await waitFor(() => expect(slot.inspection.rpcCalls.some((call) => call.method === "getPreferences")).toBe(true));
  const actions = await menu();
  actions.getByRole("button", { name: "Archive" });
  // Neither in the menu nor on the row.
  expect(slot.queryByRole("button", { name: "Pin" })).toBeNull();
  expect(slot.queryByRole("button", { name: "Unpin" })).toBeNull();
  expect(slot.queryByLabelText("Pinned")).toBeNull();
  slot.lifecycle.unmount();
});

test("merged reviews can be deleted but not unarchived", async () => {
  const { slot, open, menu } = await list([{ targetKey: "m", title: "Shipped change", status: "ready", prState: "MERGED", archivedAt: 1, userArchivedAt: 1 }]);
  await open(/^Archive/);
  await slot.findByText("Shipped change");
  expect(slot.getByText("Merged")).toBeTruthy();
  await menu();
  await slot.findByRole("button", { name: "Delete…" });
  // Neither in the menu nor on the row.
  expect(slot.queryByRole("button", { name: "Unarchive" })).toBeNull();
  expect(slot.queryByRole("button", { name: "Archive" })).toBeNull();
  // Archive takes a review out of Pinned, so there's nothing to pin it to.
  expect(slot.queryByRole("button", { name: "Pin" })).toBeNull();
  slot.lifecycle.unmount();
});

test("deleting asks for confirmation first, then removes the review, its unsaved recovery text, its place and its agent dock", async () => {
  updateDraftRecovery("d", { composer: { file: "", line: "0", side: "RIGHT", body: "Unsaved thoughts" } });
  patchReviewState("d", { activeId: "core", scrollTop: 40 });
  localStorage.setItem("gr:agentdock:d", JSON.stringify({ mode: "widget", rect: { x: 10, y: 10, w: 300, h: 400 } }));
  const { slot, menu, calls } = await list([{ targetKey: "d", title: "Unwanted change", status: "error" }]);
  await slot.findByText("Unwanted change");
  fireEvent.click((await menu()).getByRole("button", { name: "Delete…" }));
  const dialog = await slot.findByRole("dialog", { name: "Delete this review?" });
  expect(within(dialog).getByText(/“Unwanted change” will be permanently removed/)).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(slot.queryByRole("dialog")).toBeNull());
  expect(calls("deleteReview")).toEqual([]);

  fireEvent.click((await menu()).getByRole("button", { name: "Delete…" }));
  fireEvent.click(within(await slot.findByRole("dialog", { name: "Delete this review?" })).getByRole("button", { name: "Delete review" }));
  await slot.findByRole("region", { name: "Review your first pull request" });
  expect(calls("deleteReview")).toEqual([{ targetKey: "d" }]);
  expect(readDraftRecovery("d")).toEqual({});
  expect(getReviewState("d")).toEqual({});
  expect(localStorage.getItem("gr:agentdock:d")).toBeNull();
  slot.lifecycle.unmount();
});

test("a refused delete keeps the review and the confirmation open", async () => {
  const { slot, menu } = await list([{ targetKey: "b", title: "Busy change", status: "ready" }], {
    deleteReview: () => ({ ok: false, error: "Wait for the assistant to finish answering, then delete the review." }),
  });
  await slot.findByText("Busy change");
  fireEvent.click((await menu()).getByRole("button", { name: "Delete…" }));
  fireEvent.click(within(await slot.findByRole("dialog", { name: "Delete this review?" })).getByRole("button", { name: "Delete review" }));
  await waitFor(() => expect(within(slot.getByRole("dialog")).getByRole("button", { name: "Delete review" }).hasAttribute("disabled")).toBe(false));
  expect(slot.getByText("Busy change")).toBeTruthy();
  slot.lifecycle.unmount();
});

test("a generating review can be archived but not deleted", async () => {
  const { slot, menu } = await list([{ targetKey: "g", title: "Fresh change", status: "generating" }]);
  await slot.findByText("Fresh change");
  const actions = await menu();
  expect(actions.getByRole("button", { name: "Delete…" }).hasAttribute("disabled")).toBe(true);
  expect(actions.getByText("You can delete this review once its guide finishes generating.")).toBeTruthy();
  expect(actions.getByRole("button", { name: "Archive" }).hasAttribute("disabled")).toBe(false);
  slot.lifecycle.unmount();
});

test("deleting from the open review returns to the list", async () => {
  const app = await loadPluginApp(() => import("../app"));
  patchReviewState("pr-7", { view: "threads" }); // jsdom can't render the diff web component
  const slot = renderSlot(app.navPanels[0]!, { subPath: "pr-7" }, { rpc: {
    setReviewPresence: () => ({ ok: true }),
    getReviewBundle: () => ({ review: { targetKey: "pr-7", kind: "pr", title: "Fix login", status: "ready" }, guide, patch: "", revision: "r1" }),
    getChecks: () => ({ bucket: "none", checks: [] }),
    deleteReview: () => ({ ok: true }),
  } });
  await slot.findByText("Fix login");
  // In the band, where BB's title bar didn't take the review's commands.
  fireEvent.click(await slot.findByRole("button", { name: "Review actions" }));
  fireEvent.click(await slot.findByRole("button", { name: "Delete…" }));
  fireEvent.click(within(await slot.findByRole("dialog")).getByRole("button", { name: "Delete review" }));
  await waitFor(() => expect(slot.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "review" }));
  slot.lifecycle.unmount();
});

test("an open review deleted elsewhere shows Review not found, not a regeneration", async () => {
  const app = await loadPluginApp(() => import("../app"));
  patchReviewState("pr-7", { view: "threads" });
  let deleted = false;
  const slot = renderSlot(app.navPanels[0]!, { subPath: "pr-7" }, { rpc: {
    setReviewPresence: () => ({ ok: true }),
    getReviewBundle: () => deleted ? { review: null, guide: null, patch: "", revision: "r0" } : { review: { targetKey: "pr-7", kind: "pr", title: "Fix login", status: "ready" }, guide, patch: "", revision: "r1" },
    getChecks: () => ({ bucket: "none", checks: [] }),
  } });
  await slot.findByText("Fix login");
  deleted = true;
  await slot.behavior.emitRealtime("review:pr-7", { ts: 1 });
  await slot.findByText("Review not found");
  slot.lifecycle.unmount();
});
