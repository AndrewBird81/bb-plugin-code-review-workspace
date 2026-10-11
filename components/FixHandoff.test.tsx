// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

afterEach(() => { cleanup(); sessionStorage.clear(); localStorage.clear(); vi.clearAllMocks(); });

const comments = [
  { file: "src/a.ts", line: 2, side: "RIGHT", body: "Rename this." },
  { file: "src/b.ts", line: 9, side: "LEFT", body: "Keep the check." },
];

async function renderTray(rpc: Record<string, unknown>, props: Record<string, unknown>) {
  await loadPluginApp(() => import("../app"));
  const { DraftTray } = await import("./DraftTray");
  const draft = { targetKey: "k", verdict: "COMMENT", body: "", comments };
  const component = () => <DraftTray targetKey="k" activeChapterId="c1" activeFiles={["src/a.ts"]} reviewRevision="r1" account="reviewer" {...props} />;
  const slot = renderSlot({ component }, {}, { rpc: { setReviewPresence: () => ({ ok: true }), getReviewerNotes: () => ({ body: "", revision: 0 }), getDraft: () => ({ draft, stale: [], discussions: [] }), setVerdict: () => ({ draft }), ...rpc } as any });
  await slot.findByText("Draft saved");
  return slot;
}

test("on your own PR, Fix in a new thread starts a thread with the comments you keep and links to it, leaving the draft", async () => {
  const startFixThread = vi.fn(async () => ({ threadId: "t9", title: "Fix review comments: #12 Retry" }));
  const slot = await renderTray({ startFixThread }, { ownPr: true });
  fireEvent.click(slot.getByRole("button", { name: "Fix in a new thread" }));
  const picks = within(slot.getByRole("group", { name: "Comments to fix" }));
  expect(picks.getByRole("checkbox", { name: /src\/a\.ts:2/ })).toHaveProperty("checked", true);
  fireEvent.click(picks.getByRole("checkbox", { name: /src\/b\.ts:9/ }));
  fireEvent.click(slot.getByRole("button", { name: "Start thread" }));
  await waitFor(() => expect(startFixThread).toHaveBeenCalledWith({ targetKey: "k", comments: [{ file: "src/a.ts", line: 2, side: "RIGHT" }] }));
  const started = await within(slot.getByRole("region", { name: "Fix in a new thread" })).findByRole("status");
  expect(started.textContent).toBe("Started a thread: Fix review comments: #12 Retry · Open");
  fireEvent.click(within(started).getByRole("button", { name: "Open" }));
  expect(slot.inspection.navigateCalls).toContainEqual({ method: "toThread", threadId: "t9" });
  expect(slot.getAllByRole("listitem")).toHaveLength(2);
  slot.lifecycle.unmount();
});

test("a local review offers it too, and a failed start says why in the panel", async () => {
  const startFixThread = vi.fn(async () => { throw new Error("Couldn’t start the thread: The machine is offline."); });
  const slot = await renderTray({ startFixThread }, { isLocal: true });
  fireEvent.click(slot.getByRole("button", { name: "Fix in a new thread" }));
  fireEvent.click(slot.getByRole("button", { name: "Start thread" }));
  expect((await slot.findByRole("alert")).textContent).toBe("Couldn’t start the thread: The machine is offline.");
  slot.lifecycle.unmount();
});

test("someone else's PR doesn't offer it, and with no comments chosen it can't start", async () => {
  const other = await renderTray({}, {});
  expect(other.queryByRole("button", { name: "Fix in a new thread" })).toBeNull();
  other.lifecycle.unmount();
  const own = await renderTray({}, { ownPr: true });
  fireEvent.click(own.getByRole("button", { name: "Fix in a new thread" }));
  for (const box of own.getAllByRole("checkbox")) fireEvent.click(box);
  expect(own.getByRole("button", { name: "Start thread" })).toHaveProperty("disabled", true);
  own.lifecycle.unmount();
});
