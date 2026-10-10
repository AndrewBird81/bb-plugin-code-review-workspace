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
