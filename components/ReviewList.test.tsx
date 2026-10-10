// @vitest-environment jsdom
import { test, afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
afterEach(cleanup);
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

test("review list renders a card with title and status from rpc", async () => {
  const app = await loadPluginApp(() => import("../app"));
  const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {
    rpc: {
    setReviewPresence: () => ({ ok: true }),
      listReviews: () => ({
        reviews: [{ targetKey: "pr-7", kind: "pr", number: 7, repo: "acme/app", title: "Fix", author: "alice", status: "ready", createdAt: 1 }],
      }),
    },
  });
  // Card surfaces the title and its ready-status pill once the list resolves.
  await slot.findByText("Fix");
  await slot.findByText("Ready");
});

test("approved reviews leave the active queue and merged reviews are only in Archive", async () => {
  const { fireEvent } = await import("@testing-library/react");
  const { expect } = await import("vitest");
  const app = await loadPluginApp(() => import("../app"));
  const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: {
    setReviewPresence: () => ({ ok: true }),
    getGhAccounts: () => ({ active: "me", accounts: [] }),
    listReviews: () => ({ reviews: [
      { targetKey: "a", title: "Pending change", status: "ready" },
      { targetKey: "b", title: "Accepted change", status: "ready", submittedVerdict: "APPROVE" },
      { targetKey: "c", title: "Finished change", status: "ready", prState: "MERGED", archivedAt: 10 },
    ] }),
  } });
  await slot.findByText("Pending change");
  expect(slot.queryByText("Accepted change")).toBeNull();
  expect(slot.queryByText("Finished change")).toBeNull();
  fireEvent.click(slot.getByRole("button", { name: /^Reviewed/ }));
  await slot.findByText("Accepted change");
  expect(slot.getByText("Approved")).toBeTruthy();
  expect(slot.queryByText("Ready")).toBeNull();
  expect(slot.queryByText("Resume")).toBeNull();
  fireEvent.click(slot.getByRole("button", { name: /^Archive/ }));
  await slot.findByText("Finished change");
  expect(slot.getByText("Merged")).toBeTruthy();
  slot.lifecycle.unmount();
});

test("a row labels checks GitHub expects but that never reported", async () => {
  const { expect } = await import("vitest");
  const app = await loadPluginApp(() => import("../app"));
  const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: {
    setReviewPresence: () => ({ ok: true }),
    getGhAccounts: () => ({ active: "me", accounts: [] }),
    listReviews: () => ({ reviews: [{ targetKey: "a", title: "Expected change", status: "ready", signals: { ci: "expected" } }] }),
  } });
  await slot.findByText("Expected change");
  expect(slot.getByText("Checks expected")).toBeTruthy();
  slot.lifecycle.unmount();
});

test("your own PR is labelled as yours", async () => {
  const { expect } = await import("vitest");
  const app = await loadPluginApp(() => import("../app"));
  const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: {
    setReviewPresence: () => ({ ok: true }),
    getGhAccounts: () => ({ active: "me", accounts: [] }),
    listReviews: () => ({ reviews: [{ targetKey: "a", kind: "pr", title: "My change", status: "ready", ownPr: true }] }),
  } });
  await slot.findByText("My change");
  expect(slot.getByText("Your PR")).toBeTruthy();
  slot.lifecycle.unmount();
});

test("a row says when GitHub can't read its PR", async () => {
  const { expect } = await import("vitest");
  const app = await loadPluginApp(() => import("../app"));
  const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: {
    setReviewPresence: () => ({ ok: true }),
    getGhAccounts: () => ({ active: "me", accounts: [] }),
    listReviews: () => ({ reviews: [{ targetKey: "a", kind: "pr", title: "Gone change", status: "ready", unreachable: { since: 1, reason: "forbidden" } }] }),
  } });
  await slot.findByText("Gone change");
  expect(slot.getByText("Can’t read on GitHub")).toBeTruthy();
  slot.lifecycle.unmount();
});

test("the list says when GitHub was last read, and why it can't be now", async () => {
  const { expect } = await import("vitest");
  const app = await loadPluginApp(() => import("../app"));
  const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: {
    setReviewPresence: () => ({ ok: true }),
    getGhAccounts: () => ({ active: "me", accounts: [] }),
    listReviews: () => ({ reviews: [], sync: { lastReadAt: Date.now() - 14 * 60_000, error: { kind: "auth", at: Date.now() } } }),
  } });
  expect((await slot.findByText(/^GitHub last read/)).textContent).toBe("GitHub last read 14m ago: GitHub CLI isn’t signed in. Run gh auth login on the BB server.");
  slot.lifecycle.unmount();
});

test("focusing the window runs a normal pass; only Refresh forces a full read", async () => {
  const { expect } = await import("vitest");
  const { fireEvent, waitFor } = await import("@testing-library/react");
  const app = await loadPluginApp(() => import("../app"));
  const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: {
    setReviewPresence: () => ({ ok: true }),
    getGhAccounts: () => ({ active: "me", accounts: [] }),
    listReviews: () => ({ reviews: [] }),
    refreshReviews: () => ({ reviews: [] }),
  } });
  const refreshes = () => slot.inspection.rpcCalls.filter((call) => call.method === "refreshReviews").map((call) => call.input);
  await slot.findByText("No reviews yet");
  fireEvent(window, new Event("focus"));
  await waitFor(() => expect(refreshes()).toEqual([{ force: false }]));
  fireEvent.click(slot.getByRole("button", { name: "Refresh" }));
  await waitFor(() => expect(refreshes()).toEqual([{ force: false }, { force: true }]));
  slot.lifecycle.unmount();
});

test("a burst of review updates re-lists once", async () => {
  const { expect } = await import("vitest");
  const { waitFor } = await import("@testing-library/react");
  const app = await loadPluginApp(() => import("../app"));
  const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: {
    setReviewPresence: () => ({ ok: true }),
    getGhAccounts: () => ({ active: "me", accounts: [] }),
    listReviews: () => ({ reviews: [{ targetKey: "a", title: "A change", status: "ready" }] }),
  } });
  const lists = () => slot.inspection.rpcCalls.filter((call) => call.method === "listReviews").length;
  await slot.findByText("A change");
  expect(lists()).toBe(1);
  for (let i = 0; i < 3; i++) await slot.emitRealtime("reviews", { ts: i });
  await waitFor(() => expect(lists()).toBe(2));
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(lists()).toBe(2);
  slot.lifecycle.unmount();
});
