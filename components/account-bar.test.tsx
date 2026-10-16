// @vitest-environment jsdom
// The GitHub account menu: whose account reviews go out as, and what switching it changes.
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const SERVER_WIDE = "Switching changes gh for everything on this BB server, other agents and terminals included.";

async function openMenu(accounts: { login: string; active: boolean }[]) {
  await loadPluginApp(() => import("../app"));
  const { AccountBar } = await import("./AccountBar");
  const slot = renderSlot({ component: AccountBar }, {}, { rpc: { getGhAccounts: () => ({ active: "me", accounts }) } as any });
  fireEvent.click(await slot.findByRole("button", { name: "GitHub account: @me" }));
  await slot.findByText("Signed in as @me");
  return slot;
}

test("with another account to switch to, the menu says switching changes gh for the whole server", async () => {
  const slot = await openMenu([{ login: "me", active: true }, { login: "work", active: false }]);
  const line = slot.getByText(SERVER_WIDE);
  // Above the accounts it's about.
  expect(line.compareDocumentPosition(slot.getByRole("button", { name: "Use @work on this BB server" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  slot.lifecycle.unmount();
});

test("with only one account there's nothing to switch, and nothing about switching", async () => {
  const slot = await openMenu([{ login: "me", active: true }]);
  expect(slot.queryByText(SERVER_WIDE)).toBeNull();
  slot.lifecycle.unmount();
});
